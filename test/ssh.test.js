import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createSshService, normalizeSshServer, executeSsh } from '../lib/ssh.js';
import { execFile } from 'node:child_process';
import { open } from '../lib/secretbox.js';

vi.mock('node:child_process', () => ({ execFile: vi.fn() }));
vi.mock('../lib/config.js', () => ({ getConfig: () => ({ credentialsKey: 'k'.repeat(32) }) }));
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
    const { hasDbCredentials, hasPassword, hasSudoPassword, ...stored } = server;
    expect(execute).toHaveBeenCalledExactlyOnceWith(stored, request.command, 60, false);
    await Promise.resolve();
    expect(service.result(job, request.id).status).toBe('completed');
  });
  it('runs allow mode immediately without an approval card', async () => {
    const { request } = await submit({ permissionMode: 'allow' });
    expect(request.status).toBe('running');
    expect(request.unattended).toBe(false);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(service.pending()).toEqual([]);
  });
  it('asks in allow mode too when a webhook delivery started the turn', async () => {
    job.unattendedTurn = true;
    job.webhook = { armed: true, sshUnattended: false };
    const { request } = await submit({ permissionMode: 'allow' });
    expect(request.status).toBe('pending');
    expect(request.unattended).toBe(true);
    expect(execute).not.toHaveBeenCalled();
    expect(service.pending().map((r) => r.id)).toEqual([request.id]);
    service.decide(request.id, 'approve');
    await Promise.resolve();
    expect(execute).toHaveBeenCalledTimes(1);
  });
  it('runs it unasked there only on a session whose operator said so', async () => {
    job.unattendedTurn = true;
    job.webhook = { armed: true, sshUnattended: true };
    const { request } = await submit({ permissionMode: 'allow' });
    expect(request.status).toBe('running');
    expect(execute).toHaveBeenCalledTimes(1);
  });
  it('an ask-mode server asks whoever started the turn', async () => {
    job.unattendedTurn = true;
    job.webhook = { armed: true, sshUnattended: true };
    const { request } = await submit();
    expect(request.status).toBe('pending');
    expect(execute).not.toHaveBeenCalled();
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
      job.status = 'idle';
      job.awaitingAnswer = true;
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
  it('keeps the original approval and TTL only while the same turn awaits its owner', async () => {
    vi.useFakeTimers();
    const { request } = await submit();
    job.status = 'idle';
    job.awaitingAnswer = true;
    vi.advanceTimersByTime(599999);
    expect(service.pending()).toEqual([request]);
    expect(execute).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(service.pending()).toEqual([]);
    expect(service.result(job, request.id)).toMatchObject({ status: 'cancelled', error: 'Approval expired' });
    expect(() => service.decide(request.id, 'approve')).toThrow();
    expect(execute).not.toHaveBeenCalled();
  });
  it.each(['answer', 'cancel', 'close', 'closing', 'new-turn', 'repo', 'owner', 'finish', 'failed'])(
    'invalidates an approval awaiting its owner on %s',
    async (change) => {
      const { request } = await submit();
      job.status = 'idle';
      job.awaitingAnswer = true;
      if (change === 'answer' || change === 'finish') job.awaitingAnswer = false;
      if (change === 'cancel') job.turnCanceled = true;
      if (change === 'close') job.status = 'closed';
      if (change === 'closing') job.closing = true;
      if (change === 'failed') job.status = 'failed';
      if (change === 'new-turn') job.turns++;
      if (change === 'repo') job.repo = 'other/repo';
      if (change === 'owner') job.ownerId = 2;
      expect(service.pending()).toEqual([]);
      expect(service.result(job, request.id).error).toBe('Session turn ended or changed');
      expect(() => service.decide(request.id, 'approve')).toThrow();
      expect(execute).not.toHaveBeenCalled();
    },
  );
  it('does not reuse an unanswered approval in a later turn even before the completed count advances', async () => {
    job.sshApprovalTurn = 'first-turn';
    const { request } = await submit();
    job.turns++;
    job.status = 'idle';
    job.awaitingAnswer = true;
    expect(service.pending()).toEqual([request]);
    job.status = 'running';
    job.sshApprovalTurn = 'next-turn';
    job.awaitingAnswer = true;
    expect(() => service.decide(request.id, 'approve')).toThrow();
    expect(service.pending()).toEqual([]);
    expect(execute).not.toHaveBeenCalled();
  });
  it('can deny an approval after the turn stops to ask', async () => {
    const { request } = await submit();
    job.status = 'idle';
    job.awaitingAnswer = true;
    expect(service.decide(request.id, 'deny').status).toBe('denied');
    expect(execute).not.toHaveBeenCalled();
  });
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
  it.each(['unshared', 'disabled owner'])('cancels approval after access is revoked: %s', async (reason) => {
    let shared = true;
    job.ownerId = 2;
    const mayUse = vi.fn((current) => shared && !current.disabled);
    service = createSshService({ load: async () => [], save, execute, getJob: () => job, mayUse });
    await service.init();
    const { request } = await submit();
    job.status = 'idle';
    job.awaitingAnswer = true;
    // The user registry may replace the owner/session object before approval.
    job = { ...job, disabled: reason === 'disabled owner' };
    if (reason === 'unshared') shared = false;
    expect(() => service.decide(request.id, 'approve')).toThrow(/no longer/);
    expect(service.result(job, request.id).status).toBe('cancelled');
    expect(service.pending()).toEqual([]);
    expect(execute).not.toHaveBeenCalled();
    expect(mayUse).toHaveBeenLastCalledWith(job, expect.objectContaining({ repo: input.repo }));
  });

  it('holds a session to the servers its owner may use', async () => {
    const mayUse = vi.fn((session, server) => session.ownerId !== 2 || server.label === 'shared');
    service = createSshService({ load: async () => [], save, execute, getJob: () => job, mayUse });
    await service.init();
    const shared = await service.create({ ...input, label: 'shared' });
    const other = await service.create({ ...input, label: 'other', host: 'other.example.com' });
    job.ownerId = 2;
    expect(service.forSession(job).map((s) => s.id)).toEqual([shared.id]);
    expect(() => service.request(job, { serverId: other.id, command: 'id' })).toThrow('unavailable');
    expect(service.request(job, { serverId: shared.id, command: 'id' }).status).toBe('pending');
    job.ownerId = 1;
    expect(service.forSession(job)).toHaveLength(2);
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

describe('SSH database login', () => {
  const login = { dbUsername: 'app', dbPassword: 's3cret' };
  it('stores it sealed and never lists it', async () => {
    const server = await service.create({ ...input, ...login });
    expect(server).toMatchObject({ hasDbCredentials: true, dbHost: '127.0.0.1', dbPort: 3306 });
    expect(JSON.stringify(server)).not.toContain('s3cret');
    expect(JSON.stringify(service.list())).not.toContain('s3cret');
    const stored = JSON.stringify(save.mock.calls.at(-1)[1]);
    expect(stored).not.toContain('s3cret');
    expect(stored).not.toContain('"app"');
    expect(service.dbLogin(server.id)).toEqual({
      host: '127.0.0.1',
      port: 3306,
      username: 'app',
      password: 's3cret',
    });
  });
  it('survives a restart', async () => {
    const server = await service.create({ ...input, ...login, dbPort: 3307 });
    const restored = createSshService({ load: async () => save.mock.calls.at(-1)[1] });
    await restored.init();
    expect(restored.dbLogin(server.id)).toMatchObject({ port: 3307, password: 's3cret' });
  });
  it('keeps the password when only the user changes, and clears on an empty user', async () => {
    const server = await service.create({ ...input, ...login });
    await service.update(server.id, { dbUsername: 'other' });
    expect(service.dbLogin(server.id)).toMatchObject({ username: 'other', password: 's3cret' });
    await service.update(server.id, { label: 'renamed' });
    expect(service.dbLogin(server.id).username).toBe('other');
    const cleared = await service.update(server.id, { dbUsername: '', dbPassword: '' });
    expect(cleared.hasDbCredentials).toBe(false);
    expect(() => service.dbLogin(server.id)).toThrow(/No database login/);
  });
  it('refuses a password without a user, and a bad database host or port', async () => {
    await expect(service.create({ ...input, dbPassword: 'x' })).rejects.toThrow(/username/);
    expect(() => normalizeSshServer({ ...input, dbHost: '-oProxy' })).toThrow();
    expect(() => normalizeSshServer({ ...input, dbPort: 70000 })).toThrow();
  });
  it('is not handed to agents with the server list', async () => {
    await service.create({ ...input, ...login });
    expect(JSON.stringify(service.list(input.repo))).not.toContain('dbCredentials');
  });
});

describe('SSH password', () => {
  it('encrypts, preserves, replaces and clears the password without exposing it', async () => {
    const server = await service.create({ ...input, password: ' secret $`" ' });
    expect(server.hasPassword).toBe(true);
    expect(JSON.stringify(server)).not.toContain('passwordSealed');
    expect(server).not.toHaveProperty('password');
    let rows = save.mock.calls.at(-1)[1];
    expect(open(rows[0].passwordSealed)).toBe(' secret $`" ');
    expect(JSON.stringify(rows)).not.toContain(' secret ');
    const restored = createSshService({ load: async () => rows });
    await restored.init();
    expect(restored.list()).toEqual([server]);
    await service.update(server.id, { label: 'Renamed' });
    expect(open(save.mock.calls.at(-1)[1][0].passwordSealed)).toBe(' secret $`" ');
    await service.update(server.id, { password: 'new' });
    expect(open(save.mock.calls.at(-1)[1][0].passwordSealed)).toBe('new');
    expect((await service.update(server.id, { password: '' })).hasPassword).toBe(false);
  });
  it.each([null, 123, 'a\nb', 'a\rb', 'a\0b', 'x'.repeat(1025), 'x'.repeat(1024), 'é'.repeat(512)])(
    'rejects invalid passwords %#',
    async (password) => {
      await expect(service.create({ ...input, password })).rejects.toThrow('SSH password');
      expect(save).not.toHaveBeenCalled();
    },
  );
  it.each(['x'.repeat(1023), 'é'.repeat(511) + 'x'])(
    'accepts passwords at the UTF-8 byte limit %#',
    async (password) => {
      const server = await service.create({ ...input, password });
      expect(open(save.mock.calls.at(-1)[1][0].passwordSealed)).toBe(password);
      await expect(service.update(server.id, { password: password + 'x' })).rejects.toThrow('SSH password');
      expect(save).toHaveBeenCalledTimes(1);
      await service.update(server.id, { password });
      expect(open(save.mock.calls.at(-1)[1][0].passwordSealed)).toBe(password);
    },
  );
  it('cancels an approval when the password changes', async () => {
    const { server, request } = await submit({ password: 'old' });
    await service.update(server.id, { password: 'new' });
    expect(service.result(job, request.id).status).toBe('cancelled');
    expect(execute).not.toHaveBeenCalled();
  });
  it('uses askpass for password authentication while keeping secrets out of arguments and errors', async () => {
    await service.create({ ...input, password: 'secret' });
    const stored = save.mock.calls.at(-1)[1][0];
    execFile.mockImplementation((_bin, _args, _options, cb) => {
      cb({ code: 255, message: 'Permission denied' }, '', 'Permission denied');
      return { stdin: { end: vi.fn() } };
    });
    const result = await executeSsh(stored, 'pwd', 10);
    const [bin, args, options] = execFile.mock.calls.at(-1);
    expect(bin).toBe('ssh');
    expect(args).toContain('BatchMode=no');
    expect(args).toContain('PreferredAuthentications=password');
    expect(args).toContain('NumberOfPasswordPrompts=1');
    expect(args).toContain('StrictHostKeyChecking=yes');
    expect(options.env).toMatchObject({ SSH_ASKPASS_REQUIRE: 'force', BRIAREUS_SSH_PASSWORD: 'secret' });
    expect(JSON.stringify(args)).not.toContain('secret');
    expect(JSON.stringify(result)).not.toContain('secret');
  });
});

describe('SSH sudo password', () => {
  it('stores sudo separately, hides it, preserves it across edits and restarts, and clears it', async () => {
    const server = await service.create({ ...input, sudoPassword: 'sudo secret', password: 'ssh secret' });
    expect(server).toMatchObject({ hasSudoPassword: true, hasPassword: true });
    expect(JSON.stringify(server)).not.toMatch(/sudo secret|sudoPasswordSealed/);
    expect(server).not.toHaveProperty('sudoPassword');
    await service.update(server.id, { label: 'Renamed' });
    const rows = save.mock.calls.at(-1)[1];
    expect(open(rows[0].sudoPasswordSealed)).toBe('sudo secret');
    expect(open(rows[0].passwordSealed)).toBe('ssh secret');
    const restored = createSshService({ load: async () => rows });
    await restored.init();
    expect(restored.list()[0].hasSudoPassword).toBe(true);
    expect(JSON.stringify(rows)).not.toContain('sudo secret');
    await service.update(server.id, { sudoPassword: 'replacement' });
    expect(open(save.mock.calls.at(-1)[1][0].sudoPasswordSealed)).toBe('replacement');
    expect((await service.update(server.id, { sudoPassword: '' })).hasSudoPassword).toBe(false);
  });
  it.each([null, 123, 'a\nb', 'a\rb', 'a\0b', 'é'.repeat(512)])(
    'rejects invalid sudo passwords %#',
    async (sudoPassword) => {
      await expect(service.create({ ...input, sudoPassword })).rejects.toThrow('Sudo password');
      expect(save).not.toHaveBeenCalled();
    },
  );
  it('requires an explicit flag and a stored sudo password', async () => {
    const server = await service.create(input);
    expect(() => service.request(job, { serverId: server.id, command: 'id', sudo: true })).toThrow(
      'No sudo password',
    );
    expect(() => service.request(job, { serverId: server.id, command: 'id', sudo: 'true' })).toThrow(
      'boolean',
    );
    expect(execute).not.toHaveBeenCalled();
  });
  it('shows the elevated command for approval, executes once, and cancels approval after a credential edit', async () => {
    const server = await service.create({ ...input, sudoPassword: 'secret' });
    const request = service.request(job, {
      serverId: server.id,
      command: 'printf \'%s\' "hello"',
      sudo: true,
    });
    expect(request.command).toMatch(/^sudo -S -u root /);
    expect(request.command).toContain('exec </dev/null');
    expect(JSON.stringify(request)).not.toContain('secret');
    expect(request.status).toBe('pending');
    expect(execute).not.toHaveBeenCalled();
    service.decide(request.id, 'approve');
    expect(execute).toHaveBeenCalledExactlyOnceWith(save.mock.calls.at(-1)[1][0], request.command, 60, true);
    const pending = service.request(job, { serverId: server.id, command: 'id', sudo: true });
    await service.update(server.id, { sudoPassword: 'new' });
    expect(service.result(job, pending.id).status).toBe('cancelled');
  });
  it('sends sudo secrets only on stdin, retains SSH key auth, and redacts echoed secrets', async () => {
    const secret = 'sudo $`secret';
    await service.create({ ...input, sudoPassword: secret });
    const stored = save.mock.calls.at(-1)[1][0];
    const stdin = { end: vi.fn(), on: vi.fn() };
    execFile.mockImplementation((_bin, _args, _options, cb) => {
      cb({ code: 1, message: secret }, secret, secret);
      return { stdin };
    });
    const result = await executeSsh(stored, "sudo -S -u root -p '' -- sh -c 'exec </dev/null; id'", 10, true);
    const [, args, options] = execFile.mock.calls.at(-1);
    expect(args).toContain('BatchMode=yes');
    expect(args).not.toContain('PreferredAuthentications=password');
    expect(JSON.stringify([args, options, result])).not.toContain(secret);
    expect(result).toMatchObject({ stdout: '[REDACTED]', stderr: '[REDACTED]', error: '[REDACTED]' });
    expect(stdin.end).toHaveBeenCalledWith(secret + '\n');
    stdin.end.mockClear();
    await executeSsh(stored, 'id', 10);
    expect(stdin.end).toHaveBeenCalledWith(undefined);
  });
});

it.each([true, false])(
  'runs the approved command without leaking stdin (sudo prompts: %s)',
  async (prompts) => {
    const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { execFile: realExecFile } = await vi.importActual('node:child_process');
    const dir = await mkdtemp(join(tmpdir(), 'sudo-command-test-'));
    try {
      await writeFile(
        join(dir, 'sudo'),
        '#!/bin/sh\nif [ "$1" != "-S" ] || [ "$2" != "-u" ] || [ "$3" != "root" ]; then exit 2; fi\nshift 6\n' +
          (prompts ? 'IFS= read -r password\n[ "$password" = "private-password" ] || exit 3\n' : '') +
          'exec "$@"\n',
        { mode: 0o700 },
      );
      const server = await service.create({ ...input, sudoPassword: 'private-password' });
      const literal = "spaces 'quotes' $HOME `id`";
      const command = "printf '%s\\n' \"spaces 'quotes' \\$HOME \\`id\\`\"; cat";
      const r = service.request(job, { serverId: server.id, command, sudo: true });
      const result = await new Promise((resolve, reject) => {
        const child = realExecFile(
          '/bin/sh',
          ['-c', r.command],
          { env: { ...process.env, PATH: dir + ':' + process.env.PATH }, timeout: 5000 },
          (err, stdout, stderr) => {
            if (err) reject(err);
            else resolve({ stdout, stderr });
          },
        );
        child.stdin.end('private-password\n');
      });
      expect(result).toEqual({ stdout: literal + '\n', stderr: '' });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);

it('sends binary uploads on stdin using the same strict SSH and private authentication path', async () => {
  const bytes = Buffer.alloc(1024 * 1024 + 1, 251);
  const stdin = { end: vi.fn(), on: vi.fn() };
  execFile.mockImplementation((_bin, _args, _options, cb) => {
    cb(null, 'receipt', '');
    return { stdin };
  });
  await executeSsh({ ...input, port: 22 }, 'receiver command', 60, false, bytes);
  const [binary, args] = execFile.mock.calls.at(-1);
  expect(binary).toBe('ssh');
  expect(args).toContain('StrictHostKeyChecking=yes');
  expect(args.at(-1)).toBe('receiver command');
  expect(JSON.stringify(args).length).toBeLessThan(1024);
  expect(stdin.end).toHaveBeenCalledTimes(1);
  expect(stdin.end.mock.calls[0][0]).toBe(bytes);
});
