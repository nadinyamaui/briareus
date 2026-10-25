import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { hash } from 'node:crypto';
import { createSshService } from '../lib/ssh.js';
import { MAX_SSH_UPLOAD_BYTES, sshUploadCommand, withSshUpload } from '../lib/ssh-upload.js';

vi.mock('../lib/config.js', () => ({ getConfig: () => ({ credentialsKey: 'k'.repeat(32) }) }));
vi.mock('../lib/db.js', () => ({ loadAppSetting: vi.fn(), saveAppSetting: vi.fn() }));
let dir, job, service, server, execute, sourcePath, destination, bytes;
const remote = { repo: 'owner/repo', host: 'fixture.example', username: 'deploy' };
const shell = (command, payload) =>
  new Promise((resolve) => {
    const child = execFile('/bin/sh', ['-c', command], { timeout: 15000 }, (error, stdout, stderr) =>
      resolve({ error: error?.message || null, exitCode: error ? 1 : 0, stdout, stderr }),
    );
    child.stdin.on('error', () => {});
    child.stdin.end(payload);
  });
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ssh-upload-test-'));
  job = { id: 'one', repo: remote.repo, status: 'running', turns: 1, local: true, workDir: dir };
  bytes = Buffer.alloc(1024 * 1024 + 17, 173);
  sourcePath = path.join(dir, 'owner.xlsx');
  destination = path.join(dir, "remote 'quoted' $(touch injected) `id`.xlsx");
  await fs.writeFile(sourcePath, bytes);
  execute = vi.fn((_server, command, _timeout, _sudo, payload) => shell(command, payload));
  service = createSshService({ load: async () => [], save: async () => {}, execute, getJob: () => job });
  await service.init();
  server = await service.create(remote);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(dir, { recursive: true, force: true });
});
const upload = (extra = {}) =>
  service.upload(job, { serverId: server.id, sourcePath, destination, ...extra });
async function finished(id) {
  await vi.waitFor(() => expect(['completed', 'failed']).toContain(service.result(job, id).status), {
    timeout: 15000,
  });
  return service.result(job, id);
}

describe('private SSH upload approval and transfer', { timeout: 30000 }, () => {
  it('queues metadata only, then transfers >1 MiB exactly once with quoted paths, receipt and private mode', async () => {
    const r = await upload();
    expect(r).toMatchObject({
      status: 'pending',
      upload: { sourcePath, destination, size: bytes.length, sha256: hash('sha256', bytes) },
    });
    expect(r.command).toContain(destination.replaceAll('"', '\\"'));
    expect(JSON.stringify(r).length).toBeLessThan(4096);
    expect(execute).not.toHaveBeenCalled();
    service.decide(r.id, 'approve');
    expect(() => service.decide(r.id, 'approve')).toThrow();
    expect((await finished(r.id)).status).toBe('completed');
    expect(execute).toHaveBeenCalledTimes(1);
    const received = await fs.readFile(destination);
    expect(received.length).toBe(bytes.length);
    expect(hash('sha256', received)).toBe(hash('sha256', bytes));
    expect((await fs.stat(destination)).mode & 0o777).toBe(0o600);
    expect((await fs.readdir(dir)).some((p) => p.startsWith('.briareus-upload-'))).toBe(false);
    expect(await fs.stat(path.join(dir, 'injected')).catch(() => null)).toBeNull();
  });
  it('allow mode starts once and replaces an existing destination atomically', async () => {
    await service.update(server.id, { permissionMode: 'allow' });
    await fs.writeFile(destination, 'old');
    const r = await upload();
    expect((await finished(r.id)).status).toBe('completed');
    service.result(job, r.id);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(hash('sha256', await fs.readFile(destination))).toBe(hash('sha256', bytes));
  });
  it.each(['deny', 'disable', 'remove', 'turn', 'expire', 'revoke'])(
    '%s never opens SSH or writes a remote file',
    async (action) => {
      const r = await upload();
      if (action === 'deny') service.decide(r.id, 'deny');
      if (action === 'disable') await service.update(server.id, { enabled: false });
      if (action === 'remove') await service.remove(server.id);
      if (action === 'turn') job.turns++;
      if (action === 'expire') {
        vi.spyOn(Date, 'now').mockReturnValueOnce(Date.now() + 600001);
      }
      if (action === 'revoke') job = null;
      expect(() => service.decide(r.id, 'approve')).toThrow();
      expect(execute).not.toHaveBeenCalled();
      expect(await fs.stat(destination).catch(() => null)).toBeNull();
      vi.restoreAllMocks();
    },
  );
  it.each(['ask', 'allow'].flatMap((mode) => ['turn', 'host', 'password'].map((change) => [mode, change])))(
    'rejects a %s-mode upload when %s changes during the initial read',
    async (permissionMode, change) => {
      await service.update(server.id, { permissionMode });
      let release, started;
      const paused = new Promise((resolve) => {
        started = resolve;
      });
      const resume = new Promise((resolve) => {
        release = resolve;
      });
      const realpath = fs.realpath.bind(fs);
      const read = vi.spyOn(fs, 'realpath').mockImplementationOnce(async (...args) => {
        started();
        await resume;
        return realpath(...args);
      });
      const pending = upload();
      const rejected = expect(pending).rejects.toThrow('changed');
      await paused;
      try {
        if (change === 'turn') job.turns++;
        else
          await service.update(server.id, {
            [change]: change === 'host' ? 'replacement.example' : 'new-password',
          });
      } finally {
        release();
        read.mockRestore();
      }
      await rejected;
      expect(service.pending()).toEqual([]);
      expect(execute).not.toHaveBeenCalled();
      expect(await fs.stat(destination).catch(() => null)).toBeNull();
    },
  );
  it.each(
    ['initial', 'approved'].flatMap((stage) => ['turnCanceled', 'closing'].map((flag) => [stage, flag])),
  )('rejects uploads when %s read is interrupted by %s', async (stage, flag) => {
    const request = stage === 'approved' ? await upload() : null;
    let release, started;
    const paused = new Promise((resolve) => {
      started = resolve;
    });
    const resume = new Promise((resolve) => {
      release = resolve;
    });
    const realpath = fs.realpath.bind(fs);
    vi.spyOn(fs, 'realpath').mockImplementationOnce(async (...args) => {
      started();
      await resume;
      return realpath(...args);
    });
    let rejected;
    if (request) service.decide(request.id, 'approve');
    else rejected = expect(upload()).rejects.toThrow('changed');
    await paused;
    job[flag] = true;
    release();
    if (request) expect((await finished(request.id)).status).toBe('failed');
    else await rejected;
    expect(service.pending()).toEqual([]);
    expect(execute).not.toHaveBeenCalled();
    expect(await fs.stat(destination).catch(() => null)).toBeNull();
  });
  it('rechecks disabling and session cancellation after approval while reading the source', async () => {
    const r = await upload();
    service.decide(r.id, 'approve');
    await service.update(server.id, { enabled: false });
    expect((await finished(r.id)).status).toBe('failed');
    expect(execute).not.toHaveBeenCalled();
  });
  it('rechecks owner access at approval and isolates upload results by session', async () => {
    let shared = true;
    service = createSshService({
      load: async () => [],
      save: async () => {},
      execute,
      getJob: () => job,
      mayUse: () => shared,
    });
    await service.init();
    server = await service.create(remote);
    const r = await upload();
    expect(() => service.result({ ...job, id: 'other-session' }, r.id)).toThrow('not found');
    shared = false;
    expect(() => service.decide(r.id, 'approve')).toThrow('no longer available');
    expect(service.result(job, r.id).status).toBe('cancelled');
    await expect(upload()).rejects.toThrow('unavailable');
    expect(execute).not.toHaveBeenCalled();
  });
  it('uses ask for an unattended turn even on an allow server', async () => {
    await service.update(server.id, { permissionMode: 'allow' });
    job.unattendedTurn = true;
    expect((await upload()).status).toBe('pending');
    expect(execute).not.toHaveBeenCalled();
  });
  it('fails changed sources before connecting', async () => {
    const r = await upload();
    await fs.writeFile(sourcePath, Buffer.alloc(bytes.length, 1));
    service.decide(r.id, 'approve');
    expect(await finished(r.id)).toMatchObject({
      status: 'failed',
      error: expect.stringContaining('Source changed'),
    });
    expect(execute).not.toHaveBeenCalled();
  });
  it('accepts startup output before the final receipt from the real receiver', async () => {
    execute.mockImplementation((_server, command, _timeout, _sudo, payload) =>
      shell('echo "Welcome to the server"; ' + command, payload),
    );
    const r = await upload();
    service.decide(r.id, 'approve');
    expect((await finished(r.id)).status).toBe('completed');
    expect(await fs.readFile(destination)).toEqual(bytes);
  });
  it.each(['', 'wrong receipt', 'suffix', 'extra line', 'leading space', 'trailing space'])(
    'rejects a missing or malformed final receipt: %s',
    async (kind) => {
      const receipt = `${bytes.length} ${hash('sha256', bytes)}`;
      const stdout = {
        '': 'Welcome\n',
        'wrong receipt': 'Welcome\n0 wrong\n',
        suffix: `Welcome\nx${receipt}\n`,
        'extra line': `Welcome\n${receipt}\nextra\n`,
        'leading space': `Welcome\n ${receipt}\n`,
        'trailing space': `Welcome\n${receipt} \n`,
      }[kind];
      execute.mockResolvedValueOnce({ error: null, stdout, exitCode: 0 });
      const r = await upload();
      service.decide(r.id, 'approve');
      expect((await finished(r.id)).error).toContain('receipt');
    },
  );
  it('reports remote failures and invalid receipts without retrying', async () => {
    await service.update(server.id, { permissionMode: 'allow' });
    execute.mockResolvedValueOnce({ error: 'Host key verification failed', stdout: '', exitCode: 255 });
    const r = await upload();
    expect((await finished(r.id)).result.error).toContain('Host key');
    execute.mockResolvedValueOnce({ error: null, stdout: 'wrong receipt', exitCode: 0 });
    const second = await upload();
    expect((await finished(second.id)).error).toContain('receipt');
    expect(execute).toHaveBeenCalledTimes(2);
  });
});

describe('SSH upload source and project boundaries', () => {
  it('rejects other projects, disabled servers, idle sessions and sudo', async () => {
    job.repo = 'other/repo';
    await expect(upload()).rejects.toThrow('unavailable');
    job.repo = remote.repo;
    await expect(upload({ sudo: true })).rejects.toThrow('sudo');
    job.status = 'idle';
    await expect(upload()).rejects.toThrow('running');
    job.status = 'running';
    await service.update(server.id, { enabled: false });
    await expect(upload()).rejects.toThrow('unavailable');
    expect(execute).not.toHaveBeenCalled();
  });
  it('blocks outside paths, hidden files, symlinks and oversized/nonregular sources', async () => {
    for (const p of ['/etc/passwd', path.join(dir, '.env'), dir])
      await expect(upload({ sourcePath: p })).rejects.toThrow();
    const link = path.join(dir, 'link');
    await fs.symlink(sourcePath, link);
    await expect(upload({ sourcePath: link })).rejects.toThrow();
    await fs.truncate(sourcePath, MAX_SSH_UPLOAD_BYTES + 1);
    await expect(upload()).rejects.toThrow('25 MiB');
    expect(execute).not.toHaveBeenCalled();
  });
  it('accepts configured and canonical workspace paths while rejecting symlinks below the root', async () => {
    const alias = path.join(dir, 'alias');
    const workspace = path.join(dir, 'workspace');
    await fs.mkdir(workspace);
    await fs.symlink(workspace, alias);
    await fs.writeFile(path.join(workspace, 'file.txt'), 'workspace bytes');
    await fs.symlink(sourcePath, path.join(workspace, 'link'));
    job.workDir = alias;
    for (const root of [alias, workspace]) {
      await expect(withSshUpload(job, path.join(root, 'file.txt'), (data) => data.toString())).resolves.toBe(
        'workspace bytes',
      );
      await expect(upload({ sourcePath: path.join(root, 'link') })).rejects.toThrow();
      await expect(upload({ sourcePath: root + '/../owner.xlsx' })).rejects.toThrow('parent traversal');
    }
    await expect(upload()).rejects.toThrow();
    expect(execute).not.toHaveBeenCalled();
  });
  it('rejects parent traversal before a symlink path can be normalized to a different file', async () => {
    const workspace = path.join(dir, 'workspace');
    const outside = path.join(dir, 'outside');
    await fs.mkdir(workspace);
    await fs.mkdir(path.join(outside, 'sub'), { recursive: true });
    await fs.writeFile(path.join(workspace, 'file.txt'), 'workspace bytes');
    await fs.writeFile(path.join(outside, 'file.txt'), 'requested bytes');
    await fs.symlink(path.join(outside, 'sub'), path.join(workspace, 'link'));
    job.workDir = workspace;
    const ambiguous = workspace + '/link/../file.txt';
    expect(await fs.readFile(ambiguous, 'utf8')).toBe('requested bytes');
    await expect(upload({ sourcePath: ambiguous })).rejects.toThrow('parent traversal');
    expect(service.pending()).toEqual([]);
    expect(execute).not.toHaveBeenCalled();
  });
  it('permits only attachments delivered to this session, including orchestrators without a workspace', async () => {
    delete job.workDir;
    await expect(upload()).rejects.toThrow('belonging');
    job.sshUploadAttachments = [sourcePath];
    expect((await upload()).upload.sourcePath).toBe(sourcePath);
    await expect(upload({ sourcePath: destination })).rejects.toThrow('belonging');
  });
  it.each(['relative', '/tmp/', '/tmp/a\ncommand', '/tmp/a\0b'])(
    'rejects invalid destination %j',
    async (destination) => {
      await expect(upload({ destination })).rejects.toThrow('Destination');
      expect(execute).not.toHaveBeenCalled();
    },
  );
});

it.each(['short', 'long', 'hash'])(
  'cleans remote staging and preserves the destination on %s mismatch',
  async (kind) => {
    await fs.writeFile(destination, 'original');
    const metadata = { destination, size: bytes.length, sha256: hash('sha256', bytes) };
    const payload =
      kind === 'short'
        ? bytes.subarray(1)
        : kind === 'long'
          ? Buffer.concat([bytes, Buffer.from('x')])
          : Buffer.alloc(bytes.length);
    const result = await shell(sshUploadCommand(metadata), payload);
    expect(result.exitCode).not.toBe(0);
    expect(await fs.readFile(destination, 'utf8')).toBe('original');
    expect((await fs.readdir(dir)).filter((p) => p.startsWith('.briareus-upload-'))).toEqual([]);
  },
);

it('bounds concurrent payloads and releases capacity after failure', async () => {
  let release;
  const wait = new Promise((resolve) => {
    release = resolve;
  });
  const held = Array.from({ length: 4 }, () => withSshUpload(job, sourcePath, () => wait));
  await expect(withSshUpload(job, sourcePath, () => null)).rejects.toThrow('capacity');
  release();
  await Promise.all(held);
  await expect(
    withSshUpload(job, sourcePath, () => {
      throw new Error('fixture');
    }),
  ).rejects.toThrow('fixture');
  await expect(withSshUpload(job, sourcePath, (data) => data.length)).resolves.toBe(bytes.length);
});
