import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createSshService, normalizeSshServer, executeSsh } from '../lib/ssh.js';
import { execFile } from 'node:child_process';

vi.mock('node:child_process', () => ({ execFile: vi.fn() }));
const input = { repo: 'owner/repo', host: 'example.com', username: 'deploy' };
let service, execute, save, job;
beforeEach(async () => {
  job = { id: 'session', repo: input.repo, status: 'running', turns: 0, title: 'Deploy' };
  execute = vi.fn(async () => ({ stdout: 'ok', stderr: '', exitCode: 0, error: null }));
  save = vi.fn(async () => {});
  service = createSshService({ load: async () => [], save, execute, getJob: () => job });
  await service.init();
});
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

async function submit(extra = {}) {
  const server = await service.create({ ...input, ...extra });
  return { server, request: service.request(job, { serverId: server.id, command: 'echo "$HOME" && pwd' }) };
}

describe('SSH registration', () => {
  it('defaults to asking and persists across service restarts', async () => {
    const server = await service.create(input);
    const restored = createSshService({ load: async () => save.mock.calls[0][1] });
    await restored.init();
    expect(restored.list()).toEqual([server]);
    expect(server.permissionMode).toBe('ask');
  });
  it.each([
    { host: '-oProxyCommand=touch /tmp/oops' },
    { host: 'host;whoami' },
    { host: 'host\nname' },
    { username: '-root' },
    { username: 'root user' },
    { port: 0 },
    { port: 65536 },
    { permissionMode: 'anything' },
    { permissionMode: '' },
    { enabled: 'false' },
    { identityFile: 'relative/key' },
    { identityFile: '/tmp/%h/key' },
    { repo: '' },
  ])('refuses invalid or option-injecting input %j', (extra) => {
    expect(() => normalizeSshServer({ ...input, ...extra })).toThrow();
  });
  it.each(['::1', '2001:db8::1', '127.0.0.1', 'server.example.com'])(
    'accepts IP addresses and hostnames: %s',
    (host) => {
      expect(normalizeSshServer({ ...input, host }).host).toBe(host);
    },
  );
  it('serializes concurrent registrations without dropping a server', async () => {
    const rows = await Promise.all([service.create(input), service.create({ ...input, host: 'other' })]);
    expect(service.list()).toHaveLength(2);
    expect(rows[0].id).not.toBe(rows[1].id);
  });
  it('does not change settings when persistence fails', async () => {
    const server = await service.create(input);
    save.mockRejectedValueOnce(new Error('Database down'));
    await expect(service.update(server.id, { permissionMode: 'allow' })).rejects.toThrow('Database down');
    expect(service.list()[0].permissionMode).toBe('ask');
  });
  it('does not let an agent change the registered target or permission mode', async () => {
    const { server } = await submit();
    const r = service.request(job, {
      serverId: server.id,
      command: 'pwd',
      host: 'evil',
      permissionMode: 'allow',
    });
    expect(r.status).toBe('pending');
    expect(r.host).toBe(input.host);
    expect(execute).not.toHaveBeenCalled();
  });
});

describe('SSH permission boundary', () => {
  it('executes only the exact approved command, once, even with two decision clicks', async () => {
    const { server, request } = await submit();
    expect(request.status).toBe('pending');
    expect(request).not.toHaveProperty('snapshot');
    expect(execute).not.toHaveBeenCalled();
    service.decide(request.id, 'approve');
    expect(() => service.decide(request.id, 'approve')).toThrow('no longer');
    expect(execute).toHaveBeenCalledExactlyOnceWith(server, request.command, 60);
    await Promise.resolve();
    expect(service.result(job, request.id).status).toBe('completed');
  });
  it('runs allow mode immediately without an approval card', async () => {
    const { request } = await submit({ permissionMode: 'allow' });
    expect(request.status).toBe('running');
    expect(execute).toHaveBeenCalledTimes(1);
    expect(service.pending()).toEqual([]);
  });
  it('denies commands without any execution', async () => {
    const { request } = await submit();
    service.decide(request.id, 'deny');
    expect(service.result(job, request.id).status).toBe('denied');
    expect(() => service.decide(request.id, 'approve')).toThrow();
    expect(execute).not.toHaveBeenCalled();
  });
  it.each(['update', 'remove', 'disable', 'permission'])(
    'invalidates queued approvals on %s',
    async (action) => {
      const { server, request } = await submit();
      if (action === 'remove') await service.remove(server.id);
      else
        await service.update(
          server.id,
          action === 'disable'
            ? { enabled: false }
            : action === 'permission'
              ? { permissionMode: 'allow' }
              : { host: 'other' },
        );
      expect(service.result(job, request.id).status).toBe('cancelled');
      expect(() => service.decide(request.id, 'approve')).toThrow();
      expect(execute).not.toHaveBeenCalled();
    },
  );
  it.each(['idle', 'closed', 'new-turn', 'removed'])(
    'cancels approvals after the session becomes %s',
    async (state) => {
      const { request } = await submit();
      if (state === 'new-turn') job.turns++;
      else if (state === 'removed') job = null;
      else job.status = state;
      expect(service.pending()).toEqual([]);
      expect(() => service.decide(request.id, 'approve')).toThrow();
      expect(execute).not.toHaveBeenCalled();
    },
  );
  it('expires approvals and never replays them after restart', async () => {
    vi.useFakeTimers();
    const { request } = await submit();
    vi.advanceTimersByTime(600001);
    expect(service.result(job, request.id).status).toBe('cancelled');
    const restarted = createSshService();
    expect(() => restarted.result(job, request.id)).toThrow('not found');
    expect(execute).not.toHaveBeenCalled();
  });
  it('isolates server access by project and output by session', async () => {
    const { server, request } = await submit();
    expect(service.list('other/repo')).toEqual([]);
    expect(() =>
      service.request({ ...job, repo: 'other/repo' }, { serverId: server.id, command: 'pwd' }),
    ).toThrow('unavailable');
    expect(() => service.result({ ...job, id: 'another-session' }, request.id)).toThrow('not found');
  });
  it('rejects disabled servers and requests from idle sessions', async () => {
    const { server } = await submit();
    job.status = 'idle';
    expect(() => service.request(job, { serverId: server.id, command: 'pwd' })).toThrow('running');
    job.status = 'running';
    await service.update(server.id, { enabled: false });
    expect(() => service.request(job, { serverId: server.id, command: 'pwd' })).toThrow('unavailable');
  });
  it.each([
    { command: '' },
    { command: 'a\0b' },
    { command: 'a'.repeat(32769) },
    { command: 'pwd', timeoutSeconds: 301 },
    { command: 'pwd', timeoutSeconds: 0 },
  ])('rejects invalid execution arguments', async (args) => {
    const server = await service.create(input);
    expect(() => service.request(job, { serverId: server.id, ...args })).toThrow();
    expect(execute).not.toHaveBeenCalled();
  });
  it('surfaces execution and connection errors without retrying', async () => {
    execute.mockRejectedValueOnce(new Error('SSH not installed'));
    const { request } = await submit({ permissionMode: 'allow' });
    await Promise.resolve();
    expect(service.result(job, request.id)).toMatchObject({ status: 'failed', error: 'SSH not installed' });
    expect(execute).toHaveBeenCalledTimes(1);
  });
  it('evicts old results so allow mode can execute more than 100 commands', async () => {
    const server = await service.create({ ...input, permissionMode: 'allow' });
    for (let i = 0; i < 101; i++) {
      service.request(job, { serverId: server.id, command: 'pwd' });
      await Promise.resolve();
    }
    expect(execute).toHaveBeenCalledTimes(101);
  });
  it('bounds concurrent requests without dropping pending approvals', async () => {
    const server = await service.create(input);
    for (let i = 0; i < 100; i++) service.request(job, { serverId: server.id, command: 'pwd' });
    expect(() => service.request(job, { serverId: server.id, command: 'pwd' })).toThrow('Too many');
    expect(service.pending()).toHaveLength(100);
    expect(execute).not.toHaveBeenCalled();
  });
  it('marks nonzero remote exits as failed and preserves output', async () => {
    execute.mockResolvedValueOnce({ stdout: 'partial', stderr: 'failed', exitCode: 2, error: 'exit 2' });
    const { request } = await submit({ permissionMode: 'allow' });
    await Promise.resolve();
    expect(service.result(job, request.id)).toMatchObject({
      status: 'failed',
      result: { stdout: 'partial', exitCode: 2 },
    });
  });
});

describe('OpenSSH execution', () => {
  it('passes the command as one literal argument with strict host checks and bounded execution', async () => {
    execFile.mockImplementation((_bin, _args, _options, cb) => {
      cb(null, 'ok', '');
      return { stdin: { end: vi.fn() } };
    });
    const command = "printf '%s' '$HOME'; pwd";
    expect(
      await executeSsh({ ...input, port: 2222, identityFile: '/keys/deploy' }, command, 15),
    ).toMatchObject({ exitCode: 0, stdout: 'ok' });
    const [bin, args, options] = execFile.mock.calls[0];
    expect(bin).toBe('ssh');
    expect(args.slice(-3)).toEqual(['--', input.host, command]);
    expect(args).toEqual(
      expect.arrayContaining([
        'BatchMode=yes',
        'StrictHostKeyChecking=yes',
        'ForwardAgent=no',
        '/dev/null',
        'IdentitiesOnly=yes',
        '/keys/deploy',
      ]),
    );
    expect(options).toMatchObject({ timeout: 15000, maxBuffer: 262144, killSignal: 'SIGKILL' });
    expect(options.shell).toBeUndefined();
  });
  it.each([
    { code: 255, message: 'Host key verification failed' },
    { code: 'ENOENT', message: 'spawn ssh ENOENT' },
    { killed: true, message: 'timed out' },
  ])('returns failures including transport, missing binary and timeout', async (error) => {
    execFile.mockImplementation((_bin, _args, _options, cb) => {
      cb(error, '', 'error');
      return { stdin: { end: vi.fn() } };
    });
    expect(await executeSsh({ ...input, port: 22 }, 'pwd', 1)).toMatchObject({
      error: error.message,
      stderr: 'error',
    });
  });
});
