import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import { EventEmitter } from 'node:events';
import mysql from 'mysql2/promise';
import * as config from '../lib/config.js';
import { putObject } from '../lib/r2.js';
import { up as migrateBackups } from '../migrations/2026_10_25_120000_add_database_backup_to_projects.js';
import {
  databaseSource,
  dumpDatabase,
  decryptDatabaseBackup,
  createDatabaseBackups,
  withDatabaseBackupLock,
} from '../lib/database-backups.js';

const secret = 'backup-test-key-which-is-long-enough';
let dir;
let project;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'briareus-backup-test-'));
  project = { id: 1, repo: 'o/p', localDir: dir, databaseBackupEnabled: true };
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await fs.rm(dir, { recursive: true, force: true });
});

async function env(text) {
  await fs.writeFile(path.join(dir, '.env'), text);
}

it('uses the main checkout, never the session database settings', async () => {
  await env('DB_CONNECTION=central\nDB_DATABASE=main\nDB_USERNAME=user\nDB_PASSWORD="secret # kept"');
  expect(await databaseSource({ ...project, envTemplate: 'DB_DATABASE=session' })).toMatchObject({
    type: 'mysql',
    database: 'main',
    user: 'user',
    password: 'secret # kept',
    port: '3306',
  });
});

it('supports PostgreSQL URLs and reports missing databases without leaking URLs', async () => {
  await env('DATABASE_URL=postgresql://u:pass%23word@localhost:5433/my_db');
  expect(await databaseSource(project)).toMatchObject({
    type: 'pgsql',
    database: 'my_db',
    port: '5433',
    password: 'pass#word',
  });
  await env('DATABASE_URL=secret-password');
  await expect(databaseSource(project)).rejects.toThrow(/^Invalid database URL$/);
  expect(await databaseSource({ ...project, localDir: '' })).toBeNull();
  await env('APP_NAME=NoDatabase');
  expect(await databaseSource(project)).toBeNull();
});

it('preserves omitted URL fields and distinguishes explicitly empty credentials', async () => {
  const fields = 'DB_DATABASE=fallback\nDB_USERNAME=actual_user\nDB_PASSWORD=actual_password\nDB_PORT=3307\n';
  await env(fields + 'DB_URL=mysql://localhost');
  expect(await databaseSource(project)).toMatchObject({
    database: 'fallback',
    user: 'actual_user',
    password: 'actual_password',
    port: '3307',
  });
  await env(fields + 'DB_URL=mysql://localhost/');
  expect(await databaseSource(project)).toMatchObject({
    database: 'fallback',
    user: 'actual_user',
    password: 'actual_password',
    port: '3307',
  });
  await env(fields + 'DB_URL=mysql://localhost/main');
  expect(await databaseSource(project)).toMatchObject({
    database: 'main',
    user: 'actual_user',
    password: 'actual_password',
    port: '3307',
  });
  await env(fields + 'DB_URL=mysql://user@localhost/main');
  expect(await databaseSource(project)).toMatchObject({ user: 'user', password: 'actual_password' });
  await env(fields + 'DB_URL=mysql://:@localhost/main');
  expect(await databaseSource(project)).toMatchObject({ user: '', password: '' });
});

it.each(['mysql', 'postgresql'])('normalizes IPv6 hosts in %s URLs', async (type) => {
  await env(`DATABASE_URL=${type}://u:p@[::1]:5433/main`);
  expect(await databaseSource(project)).toMatchObject({ host: '::1', port: '5433' });
});

it('uses the self-project env convention and TCP while preserving Laravel conventions', async () => {
  await env('DB_DATABASE=main\nDB_HOST=localhost\nDB_PORT=3307\nDB_PASSWORD=secret #suffix');
  expect(await databaseSource({ ...project, isSelf: true })).toMatchObject({
    password: 'secret #suffix',
    tcp: true,
  });
  expect(await databaseSource(project)).toMatchObject({ password: 'secret' });
  expect((await databaseSource(project)).tcp).toBeFalsy();
  await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ dependencies: { mysql2: '^3' } }));
  expect(await databaseSource(project)).toMatchObject({ tcp: true, port: '3307' });
});

it('honors a Laravel MySQL socket while preserving the self/mysql2 TCP convention', async () => {
  await env('DB_DATABASE=main\nDB_HOST=localhost\nDB_SOCKET=/run/mysql-project.sock');
  expect(await databaseSource(project)).toMatchObject({ tcp: false, socket: '/run/mysql-project.sock' });
  expect((await databaseSource({ ...project, isSelf: true })).socket).toBeFalsy();
  await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ dependencies: { mysql2: '^3' } }));
  expect(await databaseSource(project)).toMatchObject({ tcp: true });
  expect((await databaseSource(project)).socket).toBeFalsy();
});

it('cancels the online SQLite copy at a progress boundary and removes its temporary copy', async () => {
  const dbFile = path.join(dir, 'large.sqlite');
  const db = new DatabaseSync(dbFile);
  db.exec('CREATE TABLE example (value BLOB); INSERT INTO example VALUES (zeroblob(16 * 1024 * 1024))');
  db.close();
  const controller = new AbortController();
  const check = vi.spyOn(controller.signal, 'throwIfAborted').mockImplementation(() => {
    controller.abort(new Error('copy deadline reached'));
    throw controller.signal.reason;
  });
  vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal);
  const file = path.join(dir, 'timeout.enc');
  await expect(dumpDatabase({ type: 'sqlite', file: dbFile }, file, secret)).rejects.toThrow(
    'copy deadline reached',
  );
  expect(check).toHaveBeenCalled();
  await expect(fs.stat(`${file}.sqlite`)).rejects.toThrow(/ENOENT/);
});

it('retries the project backfill after ALTER succeeds but UPDATE fails', async () => {
  let column = false;
  const query = vi.fn(async (sql) => {
    if (sql.includes('information_schema')) return [column ? [{}] : []];
    if (sql.startsWith('ALTER')) {
      column = true;
      return [];
    }
    if (query.mock.calls.filter(([text]) => text.startsWith('UPDATE')).length === 1)
      throw new Error('connection lost');
    return [];
  });
  await expect(migrateBackups({ context: { query } })).rejects.toThrow('connection lost');
  await migrateBackups({ context: { query } });
  expect(query.mock.calls.filter(([sql]) => sql.startsWith('ALTER'))).toHaveLength(1);
  expect(query.mock.calls.filter(([sql]) => sql.startsWith('UPDATE'))).toHaveLength(2);
});

it('backs up a live SQLite database and authenticates it before releasing the output', async () => {
  const dbFile = path.join(dir, 'main.sqlite');
  const db = new DatabaseSync(dbFile);
  db.exec(
    "PRAGMA journal_mode=WAL; CREATE TABLE example (value TEXT); INSERT INTO example VALUES ('precious data')",
  );
  const file = path.join(dir, 'backup.enc');
  try {
    await dumpDatabase({ type: 'sqlite', file: dbFile }, file, secret);
  } finally {
    db.close();
  }
  const encrypted = await fs.readFile(file);
  expect(encrypted.includes(Buffer.from('precious data'))).toBe(false);
  const output = path.join(dir, 'database.gz');
  await decryptDatabaseBackup(file, output, secret);
  const restored = path.join(dir, 'restored.sqlite');
  await fs.writeFile(restored, gunzipSync(await fs.readFile(output)));
  const copy = new DatabaseSync(restored, { readOnly: true });
  expect(copy.prepare('SELECT value FROM example').get().value).toBe('precious data');
  copy.close();
  await expect(decryptDatabaseBackup(file, output, secret)).rejects.toThrow(/EEXIST/);
  const rejected = path.join(dir, 'wrong-key.gz');
  await expect(decryptDatabaseBackup(file, rejected, secret + 'wrong')).rejects.toThrow();
  await expect(fs.stat(rejected)).rejects.toThrow(/ENOENT/);
  encrypted[22] ^= 1;
  await fs.writeFile(file, encrypted);
  await expect(decryptDatabaseBackup(file, rejected, secret)).rejects.toThrow();
  await expect(fs.stat(rejected)).rejects.toThrow(/ENOENT/);
});

it.each(['mysql', 'pgsql'])(
  'streams %s dumps, keeps passwords out of arguments, and rejects partial dumps',
  async (type) => {
    const binary = path.join(dir, type === 'mysql' ? 'mysqldump' : 'pg_dump');
    const captured = path.join(dir, 'args.json');
    await fs.writeFile(
      binary,
      `#!${process.execPath}\nrequire('fs').writeFileSync(${JSON.stringify(captured)}, JSON.stringify({args:process.argv.slice(2), hostaddr:process.env.PGHOSTADDR,password:process.env.${type === 'mysql' ? 'MYSQL_PWD' : 'PGPASSWORD'}}));process.stdout.write('CREATE TABLE saved (id INT);');\n`,
      { mode: 0o700 },
    );
    vi.stubEnv('PATH', `${dir}${path.delimiter}${process.env.PATH}`);
    vi.stubEnv('PGHOSTADDR', '192.0.2.1');
    const file = path.join(dir, 'dump.enc');
    const source = {
      type,
      tcp: true,
      host: 'localhost',
      port: 3306,
      user: 'u',
      database: 'main',
      password: 'never-in-arguments',
    };
    await dumpDatabase(source, file, secret);
    const capture = JSON.parse(await fs.readFile(captured, 'utf8'));
    expect(capture.password).toBe(source.password);
    expect(capture.args).not.toContain(source.password);
    expect(capture.args).toContain('main');
    if (type === 'pgsql') expect(capture.hostaddr).toBeUndefined();
    else {
      expect(capture.args).toContain('--loose-set-gtid-purged=OFF');
      expect(capture.args).toContain('--protocol=TCP');
      await env('DB_DATABASE=main\nDB_HOST=remote.invalid\nDB_PORT=1\nDB_SOCKET=/run/mysql-project.sock');
      await dumpDatabase(await databaseSource(project), path.join(dir, 'socket.enc'), secret);
      const socketArgs = JSON.parse(await fs.readFile(captured, 'utf8')).args;
      expect(socketArgs).toContain('--protocol=SOCKET');
      expect(socketArgs).toContain('--socket');
      expect(socketArgs[socketArgs.indexOf('--socket') + 1]).toBe('/run/mysql-project.sock');
      expect(socketArgs[socketArgs.indexOf('--host') + 1]).toBe('localhost');
      expect(socketArgs).not.toContain('--protocol=TCP');
    }
    const output = path.join(dir, 'dump.gz');
    await decryptDatabaseBackup(file, output, secret);
    expect(gunzipSync(await fs.readFile(output)).toString()).toContain('CREATE TABLE saved');
    await fs.writeFile(
      binary,
      `#!${process.execPath}\nprocess.stdout.write('partial');process.exitCode=2;\n`,
      { mode: 0o700 },
    );
    await expect(dumpDatabase(source, path.join(dir, 'failed.enc'), secret)).rejects.toThrow(/dump failed/);
  },
);

function service(options = {}) {
  const rows = new Map();
  const upload = vi.fn(async () => {});
  const dump = vi.fn(async (_source, file) => fs.writeFile(file, 'encrypted'));
  let time = 1800000000000;
  const backups = createDatabaseBackups({
    projects: () => [project],
    lock: async (_key, fn) => fn(new AbortController().signal),
    config: () => ({ r2: {}, credentialsKey: secret }),
    load: async (key) => rows.get(key) || null,
    save: async (key, value) => rows.set(key, value),
    upload,
    dump,
    now: () => time,
    ...options,
  });
  return { ...backups, upload, dump, advance: (ms) => (time += ms) };
}

describe('shared database backup lock', () => {
  function connection(acquired = 1) {
    const conn = Object.assign(new EventEmitter(), {
      query: vi.fn(async () => [[{ acquired }]]),
      end: vi.fn(async () => {}),
      destroy: vi.fn(),
    });
    vi.spyOn(mysql, 'createConnection').mockResolvedValue(conn);
    return conn;
  }

  it('closes the dedicated connection after success and failure', async () => {
    const conn = connection();
    expect(await withDatabaseBackupLock('database-backup:1', async () => 'done')).toBe('done');
    expect(conn.query.mock.calls[0][1][0]).toHaveLength(64);
    expect(conn.end).toHaveBeenCalledOnce();
    await expect(
      withDatabaseBackupLock('database-backup:1', async () => {
        throw new Error('dump failed');
      }),
    ).rejects.toThrow('dump failed');
    expect(conn.end).toHaveBeenCalledTimes(2);
  });

  it.each([0, null])('does not run without owning the lock (GET_LOCK=%s)', async (acquired) => {
    const conn = connection(acquired);
    const fn = vi.fn();
    if (acquired === 0) expect(await withDatabaseBackupLock('database-backup:1', fn)).toBeNull();
    else await expect(withDatabaseBackupLock('database-backup:1', fn)).rejects.toThrow('Could not acquire');
    expect(fn).not.toHaveBeenCalled();
    expect(conn.end).toHaveBeenCalledOnce();
  });

  it('aborts the dump when its lock connection dies', async () => {
    const conn = connection();
    await expect(
      withDatabaseBackupLock('database-backup:1', async (signal) => {
        conn.emit('error', new Error('connection lost'));
        signal.throwIfAborted();
      }),
    ).rejects.toThrow('lock connection lost');
    expect(conn.end).toHaveBeenCalledOnce();
  });
});

describe('backup scheduler', () => {
  beforeEach(() => env('DB_DATABASE=main'));

  it('uploads once per day, coalesces concurrent manual runs and cleans up temporary files', async () => {
    const backups = service();
    const first = backups.run(project);
    expect(backups.run(project)).toBe(first);
    const result = await first;
    expect(result).toMatchObject({ state: 'uploaded', size: 9 });
    expect(result.objectKey).toMatch(/^database-backups\/o\/p\/.*\.sql\.gz\.enc$/);
    expect(backups.upload).toHaveBeenCalledOnce();
    await expect(fs.stat(backups.upload.mock.calls[0][1])).rejects.toThrow(/ENOENT/);
    await backups.tick();
    expect(backups.upload).toHaveBeenCalledOnce();
    backups.advance(24 * 3600000);
    await backups.tick();
    expect(backups.upload).toHaveBeenCalledTimes(2);
  });

  it('bounds persisted keys and continues scheduling after a long repository name', async () => {
    const save = vi.fn(async (key) => {
      if (key.length > 64) throw new Error('ER_DATA_TOO_LONG');
    });
    project.repo = 'owner/' + 'long-repository-name'.repeat(5);
    const second = { ...project, id: 2, repo: 'o/second' };
    const backups = service({ projects: () => [project, second], save });
    await backups.tick();
    expect(backups.upload).toHaveBeenCalledTimes(2);
    expect(save.mock.calls.every(([key]) => key.length <= 64)).toBe(true);
  });

  it('logs a project lock failure, continues to later projects and retries on the next tick', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const lock = vi.fn(async (key, fn) => {
      if (key === 'database-backup:1') throw new Error('lock connection lost');
      return fn(new AbortController().signal);
    });
    const second = { ...project, id: 2, repo: 'o/second' };
    const backups = service({ projects: () => [project, second], lock });
    await backups.tick();
    expect(lock.mock.calls.map(([key]) => key)).toEqual(['database-backup:1', 'database-backup:2']);
    expect(await backups.status(second)).toMatchObject({ state: 'uploaded' });
    expect(error).toHaveBeenCalledWith('Database backup scheduler:', project.repo, 'lock connection lost');
    await backups.tick();
    expect(lock.mock.calls.map(([key]) => key)).toEqual([
      'database-backup:1',
      'database-backup:2',
      'database-backup:1',
    ]);
    await expect(backups.run(project)).rejects.toThrow('lock connection lost');
  });

  it('exposes the previous upload immediately and throughout a new run', async () => {
    const backups = service();
    const previous = await backups.run(project);
    let release;
    const blocked = new Promise((resolve) => {
      release = resolve;
    });
    backups.dump.mockImplementation(async (_source, file) => {
      await blocked;
      await fs.writeFile(file, 'encrypted');
    });
    const running = backups.run(project);
    try {
      expect(await backups.status(project)).toMatchObject({
        state: 'running',
        objectKey: previous.objectKey,
        size: previous.size,
        lastSuccessAt: previous.lastSuccessAt,
      });
    } finally {
      release();
      await running;
    }
  });

  it('coalesces server instances, rechecks due status under the lock, and recovers abandoned runs', async () => {
    const rows = new Map();
    let held = false;
    const lock = async (_key, fn) => {
      if (held) return null;
      held = true;
      try {
        return await fn(new AbortController().signal);
      } finally {
        held = false;
      }
    };
    const shared = {
      lock,
      load: async (key) => rows.get(key),
      save: async (key, value) => rows.set(key, value),
    };
    let release;
    let started;
    const entered = new Promise((resolve) => {
      started = resolve;
    });
    const blocked = new Promise((resolve) => {
      release = resolve;
    });
    const one = service({
      ...shared,
      dump: async (_source, file) => {
        started();
        await blocked;
        await fs.writeFile(file, 'encrypted');
      },
    });
    const two = service(shared);
    const running = one.run(project);
    await entered;
    try {
      expect(await two.status(project)).toMatchObject({ state: 'running' });
      expect(await two.run(project)).toMatchObject({ state: 'running' });
      await two.tick();
      expect(two.dump).not.toHaveBeenCalled();
    } finally {
      release();
      await running;
    }
    await two.tick();
    expect(two.dump).not.toHaveBeenCalled();
    const key = [...rows.keys()][0];
    rows.set(key, { state: 'running', startedAt: 1 });
    await two.tick();
    expect(two.dump).toHaveBeenCalledOnce();
    expect(held).toBe(false);
  });

  it('rechecks the schedule after another server finishes between the initial read and acquiring the lock', async () => {
    let stored = null;
    const backups = service({
      load: async () => stored,
      lock: async (_key, fn) => {
        stored = { state: 'uploaded', finishedAt: 1800000000000, lastSuccessAt: 1800000000000 };
        return fn(new AbortController().signal);
      },
    });
    await backups.tick();
    expect(backups.dump).not.toHaveBeenCalled();
  });

  it('does not upload or overwrite shared status after losing its lock', async () => {
    const controller = new AbortController();
    const save = vi.fn();
    const backups = service({
      lock: async (_key, fn) => fn(controller.signal),
      save,
      dump: async (_source, file) => {
        await fs.writeFile(file, 'encrypted');
        controller.abort(new Error('lock lost'));
      },
    });
    await expect(backups.run(project)).rejects.toThrow('lock lost');
    expect(backups.upload).not.toHaveBeenCalled();
    expect(save).toHaveBeenCalledOnce();
  });

  it('cancels an in-flight R2 upload after losing its lock without overwriting shared status', async () => {
    const controller = new AbortController();
    const save = vi.fn();
    vi.spyOn(config, 'getConfig').mockReturnValue({
      r2: {
        endpoint: 'https://r2.example.test',
        bucket: 'backups',
        accessKeyId: 'test',
        secretAccessKey: 'test',
      },
    });
    const fetch = vi.fn(async (_url, options) => {
      controller.abort(new Error('lock lost during upload'));
      options.signal.throwIfAborted();
      return { ok: true };
    });
    vi.stubGlobal('fetch', fetch);
    const backups = service({ lock: async (_key, fn) => fn(controller.signal), upload: putObject, save });
    await expect(backups.run(project)).rejects.toThrow('lock lost during upload');
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0][1].signal.aborted).toBe(true);
    expect(save).toHaveBeenCalledOnce();
    expect(save.mock.calls[0][1].state).toBe('running');
    await expect(fs.stat(backups.dump.mock.calls[0][1])).rejects.toThrow(/ENOENT/);
  });

  it('does not upload failed dumps and retries failures in an hour', async () => {
    const dump = vi.fn().mockRejectedValue(new Error('dump failed'));
    const backups = service({ dump });
    await backups.tick();
    expect(await backups.status(project)).toMatchObject({ state: 'failed', error: 'dump failed' });
    expect(backups.upload).not.toHaveBeenCalled();
    await backups.tick();
    expect(dump).toHaveBeenCalledOnce();
    backups.advance(3600000);
    await backups.tick();
    expect(dump).toHaveBeenCalledTimes(2);
  });

  it('keeps the last successful backup when a later upload fails', async () => {
    const upload = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValue(new Error('R2 down'));
    const backups = service({ upload });
    const first = await backups.run(project);
    backups.advance(24 * 3600000);
    await backups.run(project);
    expect(await backups.status(project)).toMatchObject({
      state: 'failed',
      lastSuccessAt: first.lastSuccessAt,
      objectKey: first.objectKey,
    });
  });

  it('does not run disabled projects and marks projects without a database as skipped', async () => {
    const backups = service();
    project.databaseBackupEnabled = false;
    await backups.tick();
    await expect(backups.run(project)).rejects.toThrow('disabled');
    expect(backups.dump).not.toHaveBeenCalled();
    project.databaseBackupEnabled = true;
    await env('APP_NAME=NoDatabase');
    await backups.tick();
    expect(await backups.status(project)).toMatchObject({ state: 'skipped' });
    expect(backups.upload).not.toHaveBeenCalled();
  });

  it.each([
    { r2: null, credentialsKey: secret },
    { r2: {}, credentialsKey: '' },
  ])('refuses to dump without R2 and encryption: %j', async (cfg) => {
    const backups = service({ config: () => cfg });
    await backups.tick();
    expect(await backups.status(project)).toMatchObject({ state: 'failed' });
    expect(backups.dump).not.toHaveBeenCalled();
    expect(backups.upload).not.toHaveBeenCalled();
  });
});
