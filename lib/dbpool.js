import fs from 'node:fs';
import { spawn } from 'node:child_process';
import mysql from 'mysql2/promise';
import { getConfig } from './config.js';
import { getProject } from './projects.js';
import { activeDbServers, getDbServer } from './dbservers.js';

// A dedicated database server per session. Parallel sessions used to share one
// database, so a test that truncated a table or ran a migration broke whatever
// else was running. Each session now claims one of the servers configured on
// the settings page, exclusively, for as long as it stays open, and hands it
// back when the job settles.
//
// Claims live in this process and nowhere else: sessions are the only
// claimants, and a restart interrupts every session (restoreFromDb marks them
// so and clears their claim), so there is nothing on disk to reconcile at boot.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const claims = new Map(); // server id -> job id

/**
 * Does this project give each of its sessions a database server of its own?
 * The one thing sessions compete over, so it is also what decides whether a
 * project's sessions are capped at all (sessionCapacity).
 */
export function projectClaimsServer(repoFull) {
  const cfg = getConfig();
  if (!cfg.dbPool.enabled) return false;
  const project = getProject(repoFull);
  return !!(project && project.dbPoolEnabled);
}

function poolAppliesTo(job, repoFull) {
  if (job.kind !== 'devchat') return false;
  return projectClaimsServer(repoFull);
}

// The provisioning the app does itself: make sure the database the project
// points its sessions at exists on the claimed server, and, when the project
// names a dump, restore it into that database. Everything else is the
// project's setup commands' business (a migrate step there runs against this
// database on every session).
async function ensureDatabase(server, database, extensions = []) {
  if (!database) return;
  // The name goes into DDL as an identifier, where placeholders cannot be used.
  if (!/^[A-Za-z0-9_$]+$/.test(database)) {
    throw new Error(`"${database}" is not a plain database identifier`);
  }
  if (server.engine === 'pgsql') return ensurePostgresDatabase(server, database, extensions);
  const conn = await mysql.createConnection({
    host: server.host,
    port: server.port,
    user: server.username,
    password: server.password,
    connectTimeout: 10000,
  });
  try {
    await conn.query(
      `CREATE DATABASE IF NOT EXISTS \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
    );
  } finally {
    await conn.end().catch(() => {});
  }
}

// Postgres through the psql CLI rather than a driver: the app deliberately
// carries mysql2 as its only database dependency, and pointing mysql2 at 5432
// is what produced the ETIMEDOUT this path used to fail with: a Postgres
// server accepts the connection and then waits forever for a protocol it does
// not speak.
function psql(server, sql, dbname = 'postgres') {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'psql',
      [
        '--host',
        server.host,
        '--port',
        String(server.port),
        '--username',
        server.username,
        // Defaults to the always-present maintenance database: the one we are
        // about to create is, by definition, not connectable yet. The caller
        // names the new database once it exists, to set its extensions up.
        '--dbname',
        dbname,
        // Never fall back to the interactive password prompt: a wrong
        // password would otherwise hang the session on a hidden stdin read.
        '--no-password',
        '--no-psqlrc',
        '-tAc',
        sql,
      ],
      {
        // PGPASSWORD instead of a URL, so the password never sits in a
        // command line; PGCONNECT_TIMEOUT matches the MySQL side's 10s.
        env: { ...process.env, PGPASSWORD: server.password || '', PGCONNECT_TIMEOUT: '10' },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => {
      stdout += c;
    });
    child.stderr.on('data', (c) => {
      stderr += c;
    });
    child.on('error', (e) => reject(new Error(`could not start psql: ${e.message}`)));
    child.on('close', (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(stderr.trim().slice(0, 500) || `psql exited with code ${code}`));
    });
  });
}

// Postgres has no CREATE DATABASE IF NOT EXISTS, and CREATE DATABASE cannot run
// inside the transaction a DO block would need, so: look first, create second,
// and treat the loser of a race against a parallel session as a success.
async function ensurePostgresDatabase(server, database, extensions = []) {
  const found = await psql(server, `SELECT 1 FROM pg_database WHERE datname = '${database}'`);
  if (found !== '1') {
    try {
      await psql(server, `CREATE DATABASE "${database}"`);
    } catch (e) {
      if (!/already exists/i.test(e.message)) throw e;
    }
  }
  // Extensions are per-database, and a fresh database inherits only what
  // template1 happens to carry, so a project whose migrations declare a
  // `vector` column fails on "type vector does not exist" against a database
  // this app created seconds earlier. Run on every claim, not just on
  // creation: it is idempotent, and it also repairs a database that predates
  // the project naming the extension.
  for (const ext of extensions) {
    await psql(server, `CREATE EXTENSION IF NOT EXISTS "${ext}"`, database);
  }
}

/**
 * Does this server answer, with these credentials? What the settings page's
 * Test button calls, on the form's values rather than the stored row: an entry
 * can be verified before it is ever saved, and a wrong password is caught here
 * instead of half a minute into a session's setup.
 *
 * @returns {Promise<{version: string, databases: number, claimedBy: string|null}>}
 */
export async function probeDbServer({ host, port, username, password }) {
  const conn = await mysql.createConnection({
    host: String(host || '').trim(),
    port: Number(port),
    user: String(username || '').trim(),
    password: String(password ?? ''),
    // Short: a healthy local server answers in milliseconds, and the button
    // must not leave the page waiting on a host that is simply not there.
    connectTimeout: 5000,
  });
  try {
    const [[{ version }]] = await conn.query('SELECT VERSION() AS version');
    const [rows] = await conn.query('SHOW DATABASES');
    return { version, databases: rows.length };
  } finally {
    await conn.end().catch(() => {});
  }
}

// Which session holds a given pool entry right now, if any: the other half of
// "is this server healthy": it may answer perfectly and still be busy.
export function claimHolder(serverId) {
  return claims.get(Number(serverId)) || null;
}

/**
 * How many pooled sessions may be open at once. A pooled session holds a
 * database server for as long as it stays open, so the pool is what limits
 * parallelism: one session per entry. DEV_MAX_SESSIONS is the fallback for the
 * cases the pool cannot answer for: claiming switched off, or no entries yet.
 *
 * Only sessions of projects that claim a server are counted against this: a
 * project without one shares nothing exclusive with its peers, so it may open
 * as many sessions as it likes (jobs.devSessionSlots).
 */
export function sessionCapacity() {
  const cfg = getConfig();
  if (!cfg.dbPool.enabled) return cfg.dev.maxSessions;
  return activeDbServers().length || cfg.dev.maxSessions;
}

// Streams the project's dump through the mysql CLI into the claimed server's
// database, so a session starts from the known state the dump holds no matter
// what its predecessor left behind. The CLI rather than the driver: dumps run
// to gigabytes, and stdin streams where a driver call would buffer.
function restoreSql(server, database, file) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(file)) {
      return reject(new Error(`the restore dump ${file} does not exist`));
    }
    const child = spawn(
      'mysql',
      [
        '--host',
        server.host,
        '--port',
        String(server.port),
        '--user',
        server.username,
        // The dump replaces whatever a predecessor left, and leftovers can hold
        // foreign keys into the very tables (or databases) it drops first: a
        // cross-schema reference fails the whole load on line 1 otherwise.
        // mysqldump's own header does the same for its section of the file; this
        // covers the hand-written DROP DATABASE preambles merged dumps start with.
        '--init-command=SET SESSION FOREIGN_KEY_CHECKS=0',
        database,
      ],
      {
        // MYSQL_PWD instead of -p, so the password never sits in a command line.
        env: { ...process.env, MYSQL_PWD: server.password || '' },
        stdio: ['pipe', 'ignore', 'pipe'],
      },
    );
    let stderr = '';
    child.stderr.on('data', (c) => {
      stderr += c;
    });
    child.on('error', (e) => reject(new Error(`could not start mysql: ${e.message}`)));
    const dump = fs.createReadStream(file);
    // mysql aborts mid-dump on any SQL error, and the pipe then writes into a
    // closed stdin, an EPIPE that, unhandled, is an uncaught exception taking
    // the whole server down (and with it every session the last half second's
    // flush had not stored yet). Swallow it here: 'close' below reports the
    // real failure with mysql's own stderr.
    child.stdin.on('error', () => {});
    child.on('close', (code) => {
      dump.destroy();
      if (code === 0) resolve();
      else reject(new Error(`mysql exited with code ${code}: ${stderr.trim().slice(0, 500)}`));
    });
    dump.on('error', (e) => {
      child.kill();
      reject(new Error(`could not read ${file}: ${e.message}`));
    });
    dump.pipe(child.stdin);
  });
}

/**
 * Claims a database server for the session before the agent is started.
 * Blocks while every server is claimed: the session caps can exceed the pool
 * size, and queueing behind a peer is better than handing two sessions one
 * database.
 *
 * @returns {Promise<number|null>} the claimed server's id, or null when the
 *   pool does not apply to this job
 */
export async function acquireInstance(job, repoFull, onEvent) {
  if (!poolAppliesTo(job, repoFull)) return null;
  const cfg = getConfig();
  const deadline = Date.now() + cfg.dbPool.waitTimeoutMin * 60 * 1000;
  let waiting = false;

  for (;;) {
    if (job.status === 'canceled' || job.status === 'closed') throw new Error('canceled');

    const servers = activeDbServers();
    if (!servers.length) {
      throw new Error(
        "This project gives each session a database server of its own, but the pool is empty. Add a server in Settings, or turn the project's database off",
      );
    }
    const project = getProject(repoFull);
    const free = servers.find((s) => !claims.has(s.id));

    if (free) {
      claims.set(free.id, job.id);
      try {
        await ensureDatabase(free, project.dbPoolDatabase, project.dbExtensions);
        if (project.dbRestoreSql) {
          onEvent(
            `Restoring ${project.dbPoolDatabase} on ${free.host}:${free.port} from ${project.dbRestoreSql}…`,
          );
          await restoreSql(free, project.dbPoolDatabase, project.dbRestoreSql);
        }
      } catch (e) {
        // A server that cannot be reached will not come back on its own, so
        // fail the claim rather than retrying into the same wall.
        claims.delete(free.id);
        throw new Error(`Could not prepare ${free.label} (${free.host}:${free.port}): ${e.message}`, {
          cause: e,
        });
      }
      job.dbServerId = free.id;
      job.dbHost = free.host;
      job.dbPort = free.port;
      onEvent(`Claimed database server ${free.host}:${free.port}, using database ${project.dbPoolDatabase}.`);
      return free.id;
    }

    if (Date.now() > deadline) {
      throw new Error(`no database server became free within ${cfg.dbPool.waitTimeoutMin} min`);
    }
    if (!waiting) {
      waiting = true;
      onEvent('All database servers are claimed, waiting for one to free up…');
    }
    await sleep(cfg.dbPool.pollSeconds * 1000);
  }
}

// The DB_* connection the project's .env template describes: the server an
// unpooled session runs against. DB_CONNECTION comes along because it decides
// which client can speak to that server at all: a Laravel project on pgsql
// points these very variables at Postgres, and every default below (port, user)
// differs there.
function templateDb(project) {
  const vars = {};
  for (const line of String(project.envTemplate || '').split('\n')) {
    const m = line.match(/^(DB_CONNECTION|DB_HOST|DB_PORT|DB_USERNAME|DB_PASSWORD)=(.*)$/);
    if (m) vars[m[1]] = m[2].trim();
  }
  const engine = /^(pgsql|postgres|postgresql)$/i.test(vars.DB_CONNECTION || '') ? 'pgsql' : 'mysql';
  return {
    engine,
    host: vars.DB_HOST || '127.0.0.1',
    port: Number(vars.DB_PORT) || (engine === 'pgsql' ? 5432 : 3306),
    username: vars.DB_USERNAME || (engine === 'pgsql' ? 'postgres' : 'root'),
    password: vars.DB_PASSWORD || '',
  };
}

/**
 * A project outside the pool still keeps parallel sessions apart: each session
 * gets a database of its own, the project's database name plus the session id,
 * on the server the .env template points at. seedCheckoutEnv writes the name
 * into the checkout's .env; reopening the session lands on the same database.
 *
 * @returns {Promise<string|null>} the session's database name, or null when
 *   the mode does not apply (pooled project, or no database name configured)
 */
export async function ensureSessionDatabase(job, repoFull, onEvent) {
  if (job.kind !== 'devchat') return null;
  const project = getProject(repoFull);
  if (!project || project.dbPoolEnabled || !project.dbPoolDatabase) {
    // The mode no longer applies (e.g. the project moved onto the pool since
    // this session last ran), so a stale name must not reach the .env.
    job.sessionDb = null;
    return null;
  }
  const server = templateDb(project);
  // 64 bytes is MySQL's identifier limit, 63 is Postgres'. Over it, Postgres
  // silently truncates and the .env would then name a database nobody created.
  const limit = server.engine === 'pgsql' ? 63 : 64;
  const database = `${project.dbPoolDatabase}_${String(job.id).replace(/[^A-Za-z0-9_$]/g, '_')}`.slice(
    0,
    limit,
  );
  try {
    await ensureDatabase(server, database, project.dbExtensions);
  } catch (e) {
    throw new Error(
      `Could not create the session's database ${database} on ${server.host}:${server.port}: ${e.message}`,
      { cause: e },
    );
  }
  job.sessionDb = database;
  onEvent(
    `This session's database is ${database} on ${server.host}:${server.port}, written into the checkout's .env.`,
  );
  return database;
}

// The other half of ensureSessionDatabase. Nothing here is retried and nothing
// is reported upwards: the caller is a close or a delete, both of which have
// already handed back everything else the session held.
async function dropDatabase(server, database) {
  if (!/^[A-Za-z0-9_$]+$/.test(database)) {
    throw new Error(`"${database}" is not a plain database identifier`);
  }
  if (server.engine === 'pgsql') {
    // FORCE (15+) rather than a bare DROP: Postgres refuses to drop a database
    // anything is still connected to, and a session's app can outlive the kill
    // by a moment. MySQL simply drops it out from under the connection.
    await psql(server, `DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
    return;
  }
  const conn = await mysql.createConnection({
    host: server.host,
    port: server.port,
    user: server.username,
    password: server.password,
    connectTimeout: 10000,
  });
  try {
    await conn.query(`DROP DATABASE IF EXISTS \`${database}\``);
  } finally {
    await conn.end().catch(() => {});
  }
}

/**
 * Drops the database ensureSessionDatabase made for this session. Called when
 * the session is closed or deleted, and only then: a failed or interrupted
 * session is reopenable, and reopening it means running the project's setup
 * commands against the database again, so it has to still be there.
 *
 * Kept out of the reopen path's way by nulling `sessionDb`: a reopen creates it
 * again from scratch, which is what the setup commands expect anyway.
 *
 * Failure is swallowed on purpose. A server that has gone away, or a project
 * whose .env template now points somewhere else, must not be what makes closing
 * a session fail; the cost of not dropping is a leftover database, and the
 * caller has already given back everything that another session was waiting on.
 *
 * @returns {Promise<boolean>} whether the database was dropped
 */
export async function dropSessionDatabase(job, onEvent = () => {}) {
  const database = job.sessionDb;
  if (!database) return false;
  // Pooled projects share one database per server rather than one per session,
  // and it is the next session's starting point: never drop that.
  const project = getProject(job.repo);
  if (!project || project.dbPoolEnabled) return false;
  const server = templateDb(project);
  try {
    await dropDatabase(server, database);
    job.sessionDb = null;
    onEvent(`Dropped this session's database ${database} on ${server.host}:${server.port}.`);
    return true;
  } catch (e) {
    onEvent(
      `Could not drop this session's database ${database} on ${server.host}:${server.port}: ${e.message}`,
    );
    return false;
  }
}

export function releaseInstance(job) {
  if (job.dbServerId == null) return;
  claims.delete(job.dbServerId);
  job.dbServerId = null;
  job.dbHost = null;
  job.dbPort = null;
}

// One Redis logical database per pool entry (keyspace 0/1 stays the
// developer's), so parallel sessions cannot flush or read each other's cache,
// queue and rate-limiter state on a shared redis-server. Cache and default
// share the keyspace: redis-server's stock `databases 16` does not leave room
// for a pair per entry once the developer's own two are set aside.
function redisDbs(job) {
  const idx = activeDbServers().findIndex((s) => s.id === job.dbServerId);
  const db = String((Math.max(idx, 0) % 14) + 2);
  return { default: db, cache: db };
}

// One app port per pool entry (8101, 8102, …), so two pooled sessions' ▶ Run
// servers don't contend by default. A session without a claimed server falls
// back to 8100. This is only the preferred port: two unpooled projects, an
// orphaned serve surviving a reviewer restart, or an unrelated process can
// still hold it, so startDevServe probes and shifts before spawning.
export function instanceAppPort(job) {
  if (job.dbServerId == null) return 8100;
  const idx = activeDbServers().findIndex((s) => s.id === job.dbServerId);
  return idx === -1 ? 8100 : 8101 + idx;
}

// Real environment variables, not a rewritten .env: Laravel-style dotenv is
// immutable, so these win over the checkout's .env without any session having
// to edit a file that its peers are also reading.
export function instanceEnv(job) {
  if (job.dbServerId == null) return {};
  const server = getDbServer(job.dbServerId);
  if (!server) return {};
  const redis = redisDbs(job);
  const project = getProject(job.repo);
  return {
    DB_HOST: server.host,
    DB_PORT: String(server.port),
    DB_DATABASE: project ? project.dbPoolDatabase : '',
    DB_USERNAME: server.username,
    DB_PASSWORD: server.password,
    // Some apps read REDIS_DB, others REDIS_DB_NUM. Setting both keeps one
    // code path for every repo.
    REDIS_DB: redis.default,
    REDIS_DB_NUM: redis.default,
    REDIS_CACHE_DB: redis.cache,
  };
}
