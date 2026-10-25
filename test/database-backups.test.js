import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import {
  databaseSource,
  dumpDatabase,
  decryptDatabaseBackup,
  createDatabaseBackups,
} from '../lib/database-backups.js';

const secret = 'backup-test-key-which-is-long-enough';
let dir;
let project;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'briareus-backup-test-'));
  project = { repo: 'o/p', localDir: dir, databaseBackupEnabled: true };
});
afterEach(async () => {
  vi.unstubAllEnvs();
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
      `#!${process.execPath}\nrequire('fs').writeFileSync(${JSON.stringify(captured)}, JSON.stringify({args:process.argv.slice(2), password:process.env.${type === 'mysql' ? 'MYSQL_PWD' : 'PGPASSWORD'}}));process.stdout.write('CREATE TABLE saved (id INT);');\n`,
      { mode: 0o700 },
    );
    vi.stubEnv('PATH', `${dir}${path.delimiter}${process.env.PATH}`);
    const file = path.join(dir, 'dump.enc');
    const source = {
      type,
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
