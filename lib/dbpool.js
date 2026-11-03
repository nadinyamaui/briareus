import { spawn } from 'node:child_process';
import mysql from 'mysql2/promise';
import { childEnv } from './childenv.js';
import { getProject, listProjects } from './projects.js';

// Each session gets a database of its own (project name plus session id) on the
// server the project's .env template names, so one session's truncates and
// migrations cannot break another's. Closing the session drops it.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const databaseProcesses = new Set();
let stoppingDatabaseWork = false;
const databaseShutdownWait = new Promise(() => {});

// Seed imports and PostgreSQL DDL mutate servers before workspace preparation.
export async function stopDatabaseProcesses() {
  stoppingDatabaseWork = true;
  await Promise.all(
    [...databaseProcesses].map(
      (child) =>
        new Promise((resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error(`Database process ${child.pid} did not exit during shutdown`)),
            3000,
          );
          child.once('close', () => {
            clearTimeout(timer);
            resolve();
          });
          child.kill('SIGKILL');
        }),
    ),
  );
}

// A server at max_connections refuses with 1040 (1203 per user). That passes
// once other clients disconnect, as after a restart reopens every session at
// once, so wait it out rather than fail the session. About a minute in all.
const FULL_SERVER_ERRNOS = new Set([1040, 1203]);
const FULL_SERVER_RETRY_MS = [2000, 5000, 10000, 20000, 30000];

async function connectMysql(server, { canceled = () => false } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await mysql.createConnection({
        host: server.host,
        port: server.port,
        user: server.username,
        password: server.password,
        connectTimeout: 10000,
      });
    } catch (e) {
      const delay = FULL_SERVER_RETRY_MS[attempt];
      if (!FULL_SERVER_ERRNOS.has(e?.errno) || delay == null || stoppingDatabaseWork || canceled()) throw e;
      await sleep(delay);
      // Shutdown or a close may have come during the wait: connect for neither.
      if (stoppingDatabaseWork) return await databaseShutdownWait;
      if (canceled()) throw e;
    }
  }
}

// Creates the project's database on the server if missing. Anything beyond
// that (migrations etc.) is the project's setup commands' business.
async function ensureDatabase(server, database, extensions = [], { canceled } = {}) {
  if (!database) return;
  // The name goes into DDL as an identifier, where placeholders cannot be used.
  if (!/^[A-Za-z0-9_$]+$/.test(database)) {
    throw new Error(`"${database}" is not a plain database identifier`);
  }
  if (server.engine === 'pgsql') return ensurePostgresDatabase(server, database, extensions);
  const conn = await connectMysql(server, { canceled });
  try {
    await conn.query(
      `CREATE DATABASE IF NOT EXISTS \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
    );
  } finally {
    await conn.end().catch(() => {});
  }
}

// Postgres through the psql CLI: mysql2 is deliberately the only database
// dependency, and mysql2 against a Postgres port just hangs until ETIMEDOUT.
function psql(server, sql, dbname = 'postgres', timeout = 0) {
  if (stoppingDatabaseWork) return databaseShutdownWait;
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
        // Defaults to the maintenance database, since the one being created is
        // not connectable yet.
        '--dbname',
        dbname,
        // A wrong password would otherwise hang on an interactive prompt.
        '--no-password',
        '--no-psqlrc',
        '-tAc',
        sql,
      ],
      {
        // PGPASSWORD keeps the password off the command line; the timeout
        // matches the MySQL side's 10s.
        env: childEnv({ PGPASSWORD: server.password || '', PGCONNECT_TIMEOUT: '10' }),
        ...(timeout ? { timeout, killSignal: 'SIGKILL' } : {}),
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    databaseProcesses.add(child);
    child.once('close', () => databaseProcesses.delete(child));
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

// Postgres has no CREATE DATABASE IF NOT EXISTS and cannot create one inside a
// DO block, so check then create, treating a lost race as success.
async function ensurePostgresDatabase(server, database, extensions = []) {
  const found = await psql(server, `SELECT 1 FROM pg_database WHERE datname = '${database}'`);
  if (found !== '1') {
    try {
      await psql(server, `CREATE DATABASE "${database}"`);
    } catch (e) {
      if (!/already exists/i.test(e.message)) throw e;
    }
  }
  // Extensions are per-database and a fresh one only inherits template1's, so
  // e.g. `vector` columns would fail. Runs on every preparation (idempotent) so it
  // also repairs databases that predate the extension setting.
  for (const ext of extensions) {
    await psql(server, `CREATE EXTENSION IF NOT EXISTS "${ext}"`, database);
  }
}

// The server a session's run-profile databases are made on: the .env template's
// for a per-session database, else null.
function profileDbServer(job, project) {
  return job.sessionDb ? templateDb(project) : null;
}

// The engine a DB_CONNECTION value speaks. Custom connection names (such as
// `central`) are returned as typed.
function engineOf(connection) {
  if (/^(pgsql|postgres|postgresql)$/i.test(connection)) return 'pgsql';
  if (/^(mysql|mariadb)$/i.test(connection)) return 'mysql';
  return connection;
}

// Which of DB_CONNECTION, DB_HOST and DB_PORT a profile's env points away from
// `server`. Restating the session's own values does not count, and the .env
// template's DB_CONNECTION name (e.g. `central`) counts as the session's own.
function elsewhereKeys(env, server, project) {
  const own = templateVars(project).DB_CONNECTION;
  /** @type {Record<string, (v: string) => boolean>} */
  const differs = {
    DB_CONNECTION: (v) =>
      !(own && v.toLowerCase() === own.toLowerCase()) &&
      engineOf(v) !== (server.engine === 'pgsql' ? 'pgsql' : 'mysql'),
    DB_HOST: (v) => v.toLowerCase() !== String(server.host).toLowerCase(),
    DB_PORT: (v) => Number(v) !== Number(server.port),
  };
  return Object.keys(differs).filter((k) => k in env && differs[k](String(env[k]).trim()));
}

/**
 * The keys by which a profile's rendered env sends the app to another server
 * than the one its database would be made on. Empty when there is none.
 *
 * @param {any} job
 * @param {Record<string, string>} env
 * @returns {string[]}
 */
export function profileDbElsewhere(job, env) {
  const project = getProject(job.repo);
  const server = project ? profileDbServer(job, project) : null;
  return server ? elsewhereKeys(env, server, project) : [];
}

// The DB_* values the project's .env template sets.
function templateVars(project) {
  /** @type {Record<string, string>} */
  const vars = {};
  for (const line of String(project.envTemplate || '').split('\n')) {
    const m = line.match(/^(DB_CONNECTION|DB_HOST|DB_PORT|DB_USERNAME|DB_PASSWORD)=(.*)$/);
    if (m) vars[m[1]] = m[2].trim();
  }
  return vars;
}

// The server the .env template describes, which sessions run against.
// DB_CONNECTION picks the engine, which changes the port and user defaults.
function templateDb(project) {
  const vars = templateVars(project);
  const engine = engineOf(vars.DB_CONNECTION || '') === 'pgsql' ? 'pgsql' : 'mysql';
  return {
    engine,
    host: vars.DB_HOST || '127.0.0.1',
    port: Number(vars.DB_PORT) || (engine === 'pgsql' ? 5432 : 3306),
    username: vars.DB_USERNAME || (engine === 'pgsql' ? 'postgres' : 'root'),
    password: vars.DB_PASSWORD || '',
  };
}

// Session databases being created right now. A close waits for one before it
// drops, or a CREATE retried past a full server could land after the drop.
const creatingSessionDbs = new WeakMap();

/**
 * Each session gets its own database (project name plus session id) on the
 * .env template's server; seedCheckoutEnv writes the name.
 *
 * @returns {Promise<string|null>} the session's database name, or null when
 *   the project configures no database name
 */
export async function ensureSessionDatabase(job, repoFull, onEvent) {
  if (stoppingDatabaseWork) return await databaseShutdownWait;
  if (job.kind !== 'devchat') return null;
  const project = getProject(repoFull);
  if (!project || !project.dbPoolDatabase) {
    // A stale name must not reach the .env if the mode no longer applies.
    job.sessionDb = null;
    return null;
  }
  const server = templateDb(project);
  // Identifier limits; Postgres would silently truncate a longer name.
  const limit = server.engine === 'pgsql' ? 63 : 64;
  const database = `${project.dbPoolDatabase}_${String(job.id).replace(/[^A-Za-z0-9_$]/g, '_')}`.slice(
    0,
    limit,
  );
  const canceled = () => !!job.closing || job.status === 'closed' || job.status === 'canceled';
  if (canceled()) throw new Error('canceled');
  const creating = (async () => {
    try {
      await ensureDatabase(server, database, project.dbExtensions, { canceled });
    } catch (e) {
      if (stoppingDatabaseWork) return await databaseShutdownWait;
      if (canceled()) throw new Error('canceled', { cause: e });
      throw new Error(
        `Could not create the session's database ${database} on ${server.host}:${server.port}: ${e.message}`,
        { cause: e },
      );
    }
    if (stoppingDatabaseWork) return await databaseShutdownWait;
    // Recorded even when a close came meanwhile: that close waits for this
    // (dropSessionDatabase), so it drops what was just made.
    job.sessionDb = database;
  })();
  creatingSessionDbs.set(job, creating);
  try {
    await creating;
  } finally {
    if (creatingSessionDbs.get(job) === creating) creatingSessionDbs.delete(job);
  }
  // The close has released the checkout by now, so workspace preparation must
  // not go on into it.
  if (canceled()) throw new Error('canceled');
  onEvent(
    `This session's database is ${database} on ${server.host}:${server.port}, written into the checkout's .env.`,
  );
  return database;
}

// The database name a session's app runs against, and what a run profile's
// {database} stands for. Empty for a local checkout, whose .env we never set.
export function sessionDatabaseName(job) {
  if (job.local) return '';
  return job.sessionDb || '';
}

// Only a name built off the session's own ({database}_x) is the session's to drop.
function ownsProfileDb(job, database) {
  return !!job.sessionDb && database.startsWith(`${job.sessionDb}_`);
}

// Profile databases being created right now, per session. A close waits for
// them, or a late CREATE could land after the drop, unrecorded.
const creatingProfileDbs = new WeakMap();

function creatingProfileDb(job) {
  return !!creatingProfileDbs.get(job)?.size;
}

async function profileDbsCreated(job) {
  while (creatingProfileDb(job)) await Promise.allSettled([...creatingProfileDbs.get(job)]);
}

/**
 * Creates a run profile's own DB_DATABASE on the session's database server,
 * so the session's credentials apply.
 *
 * Names built off {database} are per-session and dropped with the session;
 * any other name may be shared or the developer's own, so it is created if
 * missing but never dropped.
 *
 * @returns {Promise<boolean>} whether there was a database to make; false for
 *   the session's own name, or a session whose database this app does not
 *   manage (a local checkout)
 */
export async function ensureProfileDatabase(job, database, onEvent = () => {}) {
  const project = getProject(job.repo);
  if (!project || !database || database === sessionDatabaseName(job)) return false;
  const server = profileDbServer(job, project);
  if (!server) {
    // A local checkout, or a project naming no database: we do not
    // know which server it lives on.
    onEvent(
      `${job.local ? "This checkout's databases are" : "This session's database is"} not managed here, so the run profile's database ${database} is not created: create it yourself if it does not exist yet.`,
    );
    return false;
  }
  const limit = server.engine === 'pgsql' ? 63 : 64;
  if (database.length > limit) {
    throw new Error(`The run profile's database name ${database} is longer than ${limit} characters`);
  }
  const creating = (async () => {
    try {
      await ensureDatabase(server, database, project.dbExtensions);
    } catch (e) {
      throw new Error(
        `Could not create the run profile's database ${database} on ${server.host}:${server.port}: ${e.message}`,
        { cause: e },
      );
    }
    if (ownsProfileDb(job, database) && !(job.profileDbs || []).includes(database)) {
      job.profileDbs = [...(job.profileDbs || []), database];
    }
  })();
  let pending = creatingProfileDbs.get(job);
  if (!pending) creatingProfileDbs.set(job, (pending = new Set()));
  pending.add(creating);
  try {
    await creating;
  } finally {
    pending.delete(creating);
  }
  onEvent(`The run profile's database ${database} is ready on ${server.host}:${server.port}.`);
  return true;
}

// The other half of ensureDatabase. A name the app chose itself (appNamed) is
// quoted rather than refused for not being a plain identifier.
async function dropDatabase(server, database, { appNamed = false } = {}) {
  if (appNamed ? /[`"\0]/.test(database) : !/^[A-Za-z0-9_$]+$/.test(database)) {
    throw new Error(`"${database}" is not a plain database identifier`);
  }
  if (server.engine === 'pgsql') {
    // FORCE (15+): Postgres refuses to drop a database with live connections,
    // and a session's app can briefly outlive the kill.
    await psql(server, `DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
    return;
  }
  const conn = await connectMysql(server);
  try {
    await conn.query(`DROP DATABASE IF EXISTS \`${database}\``);
  } finally {
    await conn.end().catch(() => {});
  }
}

// The databases on the server named `${prefix}_…`. Apps make these on their own
// (a multi-tenant app's TENANT_DB_PREFIX, parallel test runners), so their names
// need not be plain identifiers: tenant ids are often UUIDs.
//
// Matched here rather than with LIKE, whose escaping depends on the server's
// sql_mode (NO_BACKSLASH_ESCAPES). Postgres sends JSON so a name holding a
// newline or trailing space survives the trip through psql's output.
async function databasesUnder(server, prefix) {
  let names;
  let fold = (name) => name;
  if (server.engine === 'pgsql') {
    const json = await psql(
      server,
      `SELECT coalesce(json_agg(datname::text), '[]') FROM pg_database WHERE left(datname, ${prefix.length + 1}) = '${prefix}_'`,
    );
    names = JSON.parse(json || '[]');
  } else {
    const conn = await connectMysql(server);
    try {
      // With lower_case_table_names set, `Sample_abc` and `sample_abc_x` are
      // the same namespace; on a case-sensitive server they are not.
      const [[setting]] = await conn.query('SELECT @@lower_case_table_names AS lowerCase');
      if (Number(setting?.lowerCase)) fold = (name) => name.toLowerCase();
      const [rows] = await conn.query('SHOW DATABASES');
      names = rows.map((row) => String(Object.values(row)[0]));
    } finally {
      await conn.end().catch(() => {});
    }
  }
  const own = fold(`${prefix}_`);
  // Another project's database can itself sit under this prefix (base
  // `sample_abc12345` beside this session's `sample_abc12345`), and what is
  // under that base is the other project's, however the names line up.
  const others = listProjects()
    .map((p) => p?.dbPoolDatabase && fold(p.dbPoolDatabase))
    .filter((base) => base && (base === fold(prefix) || base.startsWith(own)));
  return names.filter((name) => {
    const folded = fold(name);
    return folded.startsWith(own) && !others.some((base) => folded === base || folded.startsWith(`${base}_`));
  });
}

/**
 * Drops the database ensureSessionDatabase made, only on close or delete: a
 * failed or interrupted session is reopenable and still needs it.
 *
 * `sessionDb` is nulled so a reopen recreates it from scratch, unless a run
 * profile's database would not drop, in which case the name stays so the next
 * close can retry. Failures are swallowed so they never make closing fail; the
 * cost is a leftover database.
 *
 * @returns {Promise<boolean>} whether the database was dropped
 */
export async function dropSessionDatabase(job, onEvent = () => {}) {
  if (creatingSessionDbs.has(job)) await creatingSessionDbs.get(job).catch(() => {});
  if (creatingProfileDb(job)) await profileDbsCreated(job);
  const database = job.sessionDb;
  if (!database) return false;
  const project = getProject(job.repo);
  if (!project) return false;
  const server = templateDb(project);
  // Profile databases first, since only this session's name finds them. A
  // failed one keeps `sessionDb` set for a retry, but the session's own
  // database is dropped regardless so a reopen never reruns setup over old data.
  let leftover = false;
  for (const profileDb of (job.profileDbs || []).filter((d) => ownsProfileDb(job, d))) {
    try {
      await dropDatabase(server, profileDb);
      job.profileDbs = job.profileDbs.filter((d) => d !== profileDb);
      onEvent(`Dropped the run profile's database ${profileDb} on ${server.host}:${server.port}.`);
    } catch (e) {
      leftover = true;
      onEvent(
        `Could not drop the run profile's database ${profileDb} on ${server.host}:${server.port}: ${e.message}`,
      );
    }
  }
  // Then whatever the app built off the session's name itself (tenant or test
  // databases), which nothing here recorded. Names under {sessionDb}_ are the
  // session's own (ownsProfileDb), less any other project's namespace nested
  // under it (databasesUnder).
  try {
    for (const appDb of await databasesUnder(server, database)) {
      try {
        await dropDatabase(server, appDb, { appNamed: true });
        onEvent(`Dropped the app's database ${appDb} on ${server.host}:${server.port}.`);
      } catch (e) {
        leftover = true;
        onEvent(`Could not drop the app's database ${appDb} on ${server.host}:${server.port}: ${e.message}`);
      }
    }
  } catch (e) {
    leftover = true;
    onEvent(
      `Could not list the app's databases under ${database} on ${server.host}:${server.port}: ${e.message}`,
    );
  }
  try {
    await dropDatabase(server, database);
    onEvent(`Dropped this session's database ${database} on ${server.host}:${server.port}.`);
    if (leftover) {
      onEvent(`Kept this session's database name ${database}, so the next close tries those again.`);
    } else {
      job.sessionDb = null;
    }
    return true;
  } catch (e) {
    onEvent(
      `Could not drop this session's database ${database} on ${server.host}:${server.port}: ${e.message}`,
    );
    return false;
  }
}

// Real environment variables, not a rewritten .env: Laravel-style dotenv is
// immutable, so these win over the checkout's .env without editing it. Test
// runners can set their own database before loading dotenv (PHPUnit's XML is one
// example), so writing the session name to .env alone is not enough.
export function sessionDbEnv(job) {
  return job.sessionDb ? { DB_DATABASE: job.sessionDb } : {};
}

export function _resetForTests() {
  stoppingDatabaseWork = false;
  databaseProcesses.clear();
}
