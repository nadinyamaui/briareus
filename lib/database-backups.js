// @ts-check
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import mysql from 'mysql2/promise';
import { getConfig, parseEnvFile } from './config.js';
import { childEnv } from './childenv.js';
import { listProjects } from './projects.js';
import { loadAppSetting, saveAppSetting } from './db.js';
import { putObject } from './r2.js';

const DAY = 24 * 60 * 60 * 1000;
const TIMEOUT = 30 * 60 * 1000;
const MAGIC = Buffer.from('BRIADB1\n');

// Read the main checkout, never a session's envTemplate or pooled database.
export async function databaseSource(project) {
  if (!project.localDir) return null;
  let env;
  try {
    env = parseEnvFile(await fsp.readFile(path.join(project.localDir, '.env'), 'utf8'), {
      inlineComments: !project.isSelf,
    });
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
  let type = env.DB_CONNECTION || 'mysql';
  let database = env.DB_DATABASE;
  let host = env.DB_HOST || '127.0.0.1';
  let port = env.DB_PORT;
  let user = env.DB_USERNAME || '';
  let password = env.DB_PASSWORD || '';
  if (env.DB_URL || env.DATABASE_URL) {
    let url;
    try {
      url = new URL(env.DB_URL || env.DATABASE_URL);
    } catch {
      throw new Error('Invalid database URL');
    }
    type = url.protocol.slice(0, -1);
    if (url.pathname) database = decodeURIComponent(url.pathname.slice(1));
    if (url.hostname) host = url.hostname.replace(/^\[|\]$/g, '');
    if (url.port) port = url.port;
    // URL normalizes empty credentials away; inspect the authority for presence.
    const authority = (env.DB_URL || env.DATABASE_URL).match(/^[^:]+:\/\/([^/?#]*)/)?.[1] || '';
    if (authority.includes('@')) {
      const auth = authority.slice(0, authority.lastIndexOf('@'));
      user = decodeURIComponent(url.username);
      if (auth.includes(':')) password = decodeURIComponent(url.password);
    }
    if (url.search) throw new Error('Database URL query options are not supported for backups');
  }
  if (type === 'sqlite') {
    database ||= 'database/database.sqlite';
    if (database === ':memory:') throw new Error('An in-memory database cannot be backed up');
    return { type, file: path.resolve(project.localDir, database) };
  }
  if (!database) return null;
  if (['postgres', 'postgresql', 'pgsql'].includes(type)) type = 'pgsql';
  else if (['mysql', 'mariadb', 'central'].includes(type)) type = 'mysql';
  else throw new Error('Unsupported main database driver');
  if (!/^[A-Za-z0-9_$][A-Za-z0-9_$.-]*$/.test(database)) throw new Error('Invalid database name');
  let tcp = !!project.isSelf;
  if (type === 'mysql' && !tcp) {
    try {
      const pkg = JSON.parse(await fsp.readFile(path.join(project.localDir, 'package.json'), 'utf8'));
      tcp = !!(pkg.dependencies?.mysql2 || pkg.optionalDependencies?.mysql2);
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
  }
  return { type, database, host, port: port || (type === 'pgsql' ? '5432' : '3306'), user, password, tcp };
}

// Format: magic(8), random IV(12), gzip encrypted with AES-256-GCM, auth tag(16).
function cipherKey(secret) {
  if (!secret || secret.length < 32)
    throw new Error('Backups need CREDENTIALS_KEY of at least 32 characters');
  return crypto.createHash('sha256').update(secret).digest();
}

export async function dumpDatabase(source, file, secret, lockSignal = null) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', cipherKey(secret), iv);
  await fsp.writeFile(file, Buffer.concat([MAGIC, iv]), { mode: 0o600, flag: 'wx' });
  const timeout = AbortSignal.timeout(TIMEOUT);
  const signal = lockSignal ? AbortSignal.any([timeout, lockSignal]) : timeout;
  let child;
  let exited;
  let input;
  let sqliteFile;
  try {
    if (source.type === 'sqlite') {
      const { DatabaseSync, backup } = await import('node:sqlite');
      sqliteFile = `${file}.sqlite`;
      const db = new DatabaseSync(source.file, { readOnly: true });
      try {
        await backup(db, sqliteFile, { progress: () => signal.throwIfAborted() });
      } finally {
        db.close();
      }
      input = fs.createReadStream(sqliteFile);
    } else {
      const postgres = source.type === 'pgsql';
      const args = postgres
        ? [
            '--no-password',
            '--format=plain',
            '--host',
            source.host,
            '--port',
            String(source.port),
            '--username',
            source.user,
            '--dbname',
            source.database,
          ]
        : [
            '--single-transaction',
            '--quick',
            '--skip-lock-tables',
            '--no-tablespaces',
            '--loose-set-gtid-purged=OFF',
            '--hex-blob',
            '--routines',
            '--events',
            '--triggers',
            ...(source.tcp ? ['--protocol=TCP'] : []),
            '--host',
            source.host,
            '--port',
            String(source.port),
            '--user',
            source.user,
            '--',
            source.database,
          ];
      child = spawn(postgres ? 'pg_dump' : 'mysqldump', args, {
        env: childEnv(
          postgres ? { PGPASSWORD: source.password, PGHOSTADDR: undefined } : { MYSQL_PWD: source.password },
        ),
        stdio: ['ignore', 'pipe', 'ignore'],
        signal,
        killSignal: 'SIGKILL',
      });
      exited = new Promise((resolve, reject) => {
        child.once('error', () => reject(new Error('Database dump could not start or timed out')));
        child.once('close', (code) =>
          code === 0 ? resolve(undefined) : reject(new Error(`Database dump failed (exit ${code})`)),
        );
      });
      input = child.stdout;
    }
    await Promise.all([
      pipeline(input, createGzip(), cipher, fs.createWriteStream(file, { flags: 'a', mode: 0o600 }), {
        signal,
      }),
      exited,
    ]);
    await fsp.appendFile(file, cipher.getAuthTag());
  } finally {
    child?.kill('SIGKILL');
    if (sqliteFile) await fsp.rm(sqliteFile, { force: true });
  }
}

// Write to a private temporary file; never release unauthenticated plaintext.
export async function decryptDatabaseBackup(file, output, secret) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'briareus-decrypt-'));
  const tmp = path.join(dir, 'database.gz');
  let handle;
  try {
    handle = await fsp.open(file, 'r');
    const { size } = await handle.stat();
    const header = Buffer.alloc(20);
    const tag = Buffer.alloc(16);
    if (size < 37) throw new Error('Invalid database backup');
    await handle.read(header, 0, 20, 0);
    await handle.read(tag, 0, 16, size - 16);
    if (!header.subarray(0, 8).equals(MAGIC)) throw new Error('Invalid database backup');
    const decipher = crypto.createDecipheriv('aes-256-gcm', cipherKey(secret), header.subarray(8));
    decipher.setAuthTag(tag);
    await pipeline(
      fs.createReadStream(file, { start: 20, end: size - 17 }),
      decipher,
      fs.createWriteStream(tmp, { mode: 0o600 }),
    );
    await fsp.copyFile(tmp, output, fs.constants.COPYFILE_EXCL);
    await fsp.chmod(output, 0o600);
  } finally {
    await handle?.close();
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

// A dedicated connection avoids exhausting the settings pool during long dumps.
// MySQL releases the advisory lock when the connection or server process dies.
export async function withDatabaseBackupLock(key, fn) {
  const db = getConfig().db;
  const name = crypto.createHash('sha256').update(`${db.database}:${key}`).digest('hex');
  const conn = await mysql.createConnection({ ...db, connectTimeout: 10000 });
  const controller = new AbortController();
  conn.on('error', () => controller.abort(new Error('Database backup lock connection lost')));
  try {
    const [rows] = await conn.query('SELECT GET_LOCK(?, 0) AS acquired', [name]);
    const acquired = /** @type {any[]} */ (rows)[0].acquired;
    if (acquired === 0) return null;
    if (Number(acquired) !== 1) throw new Error('Could not acquire database backup lock');
    return await fn(controller.signal);
  } finally {
    await conn.end().catch(() => conn.destroy());
  }
}

export function createDatabaseBackups({
  projects = listProjects,
  config = getConfig,
  load = loadAppSetting,
  save = saveAppSetting,
  dump = dumpDatabase,
  upload = putObject,
  now = Date.now,
  lock = withDatabaseBackupLock,
} = {}) {
  const active = new Map();
  const key = (project) => `database-backup:${project.id}`;
  const status = async (project) => {
    const previous = await load(key(project), null);
    const running = active.get(key(project))?.status;
    return running ? { ...previous, ...running } : previous;
  };
  const due = (last) =>
    !(last?.lastSuccessAt && now() - last.lastSuccessAt < DAY) &&
    !(last?.finishedAt && now() - last.finishedAt < (last.state === 'failed' ? 3600000 : DAY));

  function run(project, scheduled = false) {
    if (!project.databaseBackupEnabled) return Promise.reject(new Error('Database backup is disabled'));
    const id = key(project);
    if (active.has(id)) return active.get(id).promise;
    const entry = {
      status: { state: 'running', startedAt: now() },
      promise: /** @type {Promise<any>} */ (null),
    };
    active.set(id, entry);
    entry.promise = lock(id, async (signal) => {
      const previous = await load(id, null);
      if (scheduled && !due(previous)) return previous;
      let dir;
      let result = /** @type {any} */ ({
        ...entry.status,
        lastSuccessAt: previous?.lastSuccessAt || null,
        objectKey: previous?.objectKey || null,
        size: previous?.size || null,
      });
      entry.status = result;
      signal.throwIfAborted();
      await save(id, result);
      try {
        const source = await databaseSource(project);
        if (!source)
          result = {
            ...result,
            state: 'skipped',
            reason: 'No main database configured in the local checkout',
          };
        else {
          const cfg = config();
          if (!cfg.r2) throw new Error('R2 is not configured');
          cipherKey(cfg.credentialsKey);
          dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'briareus-backup-'));
          const file = path.join(dir, 'database.gz.enc');
          await dump(source, file, cfg.credentialsKey, signal);
          const objectKey = `database-backups/${project.repo.toLowerCase()}/${new Date(now()).toISOString().replace(/:/g, '-')}-${crypto.randomUUID()}.${source.type === 'sqlite' ? 'sqlite' : 'sql'}.gz.enc`;
          const { size } = await fsp.stat(file);
          signal.throwIfAborted();
          await upload(objectKey, file, size, 'application/octet-stream', TIMEOUT);
          result = { ...result, state: 'uploaded', objectKey, size, lastSuccessAt: now() };
        }
      } catch (e) {
        result = { ...result, state: 'failed', error: e.message };
      } finally {
        if (dir) await fsp.rm(dir, { recursive: true, force: true });
      }
      result.finishedAt = now();
      signal.throwIfAborted();
      await save(id, result);
      return result;
    })
      .then(async (result) => result || { ...(await load(id, null)), state: 'running' })
      .finally(() => active.delete(id));
    return entry.promise;
  }

  let ticking = false;
  async function tick() {
    if (ticking) return;
    ticking = true;
    try {
      for (const project of projects().filter((p) => p.databaseBackupEnabled)) {
        const last = await status(project);
        if (active.has(key(project)) || !due(last)) continue;
        await run(project, true);
      }
    } finally {
      ticking = false;
    }
  }
  function start() {
    const check = () => tick().catch((e) => console.error('Database backup scheduler:', e.message));
    check();
    return setInterval(check, 3600000).unref();
  }
  return { status, run, tick, start };
}
