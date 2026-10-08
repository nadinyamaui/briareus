import fs from 'node:fs';
import { spawn } from 'node:child_process';
import mysql from 'mysql2/promise';
import { getConfig } from './config.js';
import { childEnv } from './childenv.js';
import { getProject, listProjects } from './projects.js';
import { activeDbServers, getDbServer } from './dbservers.js';
import { projectRunProfiles, render } from './runprofiles.js';

// A dedicated database server per session, so one session's truncates and
// migrations cannot break another's. Each session claims a configured server
// exclusively while open and hands it back when the job settles.
//
// Claims live in process memory. Boot recovery reclaims each open session's
// stored server id before any workspace preparation can acquire a new one.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const claims = new Map(); // server id -> job id

// Recover the original claim before any new session can take it. Running the
// normal acquire path would restore seed SQL and discard the session's data.
export function reclaimInstance(job, serverId) {
  if (!poolAppliesTo(job, job.repo) || serverId == null) return;
  const server = activeDbServers().find((s) => s.id === serverId);
  if (!server || (claims.has(serverId) && claims.get(serverId) !== job.id)) {
    throw new Error(`The session's previous database server (${serverId}) is unavailable`);
  }
  claims.set(serverId, job.id);
  job.dbServerId = server.id;
  job.dbHost = server.host;
  job.dbPort = server.port;
}

const restoreProcesses = new Set();
const preparingInstances = new Map();
let stoppingDatabaseWork = false;
const databaseShutdownWait = new Promise(() => {});

// Seed imports mutate the claimed server even before workspace preparation.
export async function stopDatabaseProcesses() {
  stoppingDatabaseWork = true;
  await Promise.all(
    [...restoreProcesses].map(
      (child) =>
        new Promise((resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error(`Database restore ${child.pid} did not exit during shutdown`)),
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

/**
 * Does this project give each session its own database server? Also decides
 * whether its sessions are capped at all (sessionCapacity).
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

// Creates the project's database on the server if missing. Anything beyond
// that (migrations etc.) is the project's setup commands' business.
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

// Postgres through the psql CLI: mysql2 is deliberately the only database
// dependency, and mysql2 against a Postgres port just hangs until ETIMEDOUT.
function psql(server, sql, dbname = 'postgres', timeout = 0) {
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
  // e.g. `vector` columns would fail. Runs on every claim (idempotent) so it
  // also repairs databases that predate the extension setting.
  for (const ext of extensions) {
    await psql(server, `CREATE EXTENSION IF NOT EXISTS "${ext}"`, database);
  }
}

/**
 * Does this server answer with these credentials? Backs the settings Test
 * button, on form values so an entry can be verified before it is saved.
 *
 * @returns {Promise<{version: string, databases: number, claimedBy: string|null}>}
 */
export async function probeDbServer({ host, port, username, password }) {
  const conn = await mysql.createConnection({
    host: String(host || '').trim(),
    port: Number(port),
    user: String(username || '').trim(),
    password: String(password ?? ''),
    // Short, so the button does not hang on a host that is not there.
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

// Which session holds a given pool entry right now, if any.
export function claimHolder(serverId) {
  return claims.get(Number(serverId)) || null;
}

/**
 * How many pooled sessions may be open at once: one per pool entry, falling
 * back to DEV_MAX_SESSIONS when pooling is off or the pool is empty. Only
 * projects that claim a server count against it (jobs.devSessionSlots).
 */
export function sessionCapacity() {
  const cfg = getConfig();
  if (!cfg.dbPool.enabled) return cfg.dev.maxSessions;
  return activeDbServers().length || cfg.dev.maxSessions;
}

// Restores the project's dump so a session starts from a known state. The CLI
// rather than the driver because multi-gigabyte dumps must stream, not buffer.
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
        // Leftover cross-schema foreign keys would fail the dump's initial
        // DROPs; mysqldump's header covers its own section but not the
        // hand-written DROP DATABASE preambles of merged dumps.
        '--init-command=SET SESSION FOREIGN_KEY_CHECKS=0',
        database,
      ],
      {
        // MYSQL_PWD keeps the password off the command line.
        env: childEnv({ MYSQL_PWD: server.password || '' }),
        stdio: ['pipe', 'ignore', 'pipe'],
      },
    );
    restoreProcesses.add(child);
    child.once('close', () => restoreProcesses.delete(child));
    let stderr = '';
    child.stderr.on('data', (c) => {
      stderr += c;
    });
    child.on('error', (e) => reject(new Error(`could not start mysql: ${e.message}`)));
    const dump = fs.createReadStream(file);
    // When mysql aborts mid-dump the pipe hits EPIPE, which unhandled would
    // crash the whole server. 'close' reports the real failure.
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
 * Claims a database server for the session before the agent starts. Blocks
 * while every server is claimed, since session caps can exceed the pool size.
 *
 * @returns {Promise<number|null>} the claimed server's id, or null when the
 *   pool does not apply to this job
 */
export async function acquireInstance(job, repoFull, onEvent, onClaim = () => {}) {
  if (stoppingDatabaseWork) return await databaseShutdownWait;
  if (!poolAppliesTo(job, repoFull)) return null;
  if (job.dbServerId != null && claims.get(job.dbServerId) === job.id) {
    const server = getDbServer(job.dbServerId);
    try {
      if (!server) throw new Error('server is no longer configured');
      if (server.engine === 'pgsql') await psql(server, 'SELECT 1', 'postgres', 5000);
      else {
        const conn = await mysql.createConnection({
          host: server.host,
          port: server.port,
          user: server.username,
          password: server.password,
          connectTimeout: 5000,
        });
        try {
          await conn.query({ sql: 'SELECT 1', timeout: 5000 });
        } finally {
          conn.destroy();
        }
      }
    } catch (e) {
      throw new Error(
        `The session's previous database server (${job.dbServerId}) is unavailable: ${e.message}`,
        { cause: e },
      );
    }
    if (stoppingDatabaseWork) return await databaseShutdownWait;
    if (!job.dbPreparing) return job.dbServerId;
  }
  const cfg = getConfig();
  const deadline = Date.now() + cfg.dbPool.waitTimeoutMin * 60 * 1000;
  let waiting = false;

  for (;;) {
    if (stoppingDatabaseWork) return await databaseShutdownWait;
    if (job.status === 'canceled' || job.status === 'closed') throw new Error('canceled');

    const servers = activeDbServers();
    if (!servers.length) {
      throw new Error(
        "This project gives each session a database server of its own, but the pool is empty. Add a server in Settings, or turn the project's database off",
      );
    }
    const project = getProject(repoFull);
    const free =
      servers.find((s) => s.id === job.dbServerId && claims.get(s.id) === job.id) ||
      servers.find((s) => !claims.has(s.id));

    if (free) {
      claims.set(free.id, job.id);
      job.dbServerId = free.id;
      job.dbHost = free.host;
      job.dbPort = free.port;
      job.dbPreparing = true;
      let finishPreparation;
      preparingInstances.set(
        job.id,
        new Promise((resolve) => {
          finishPreparation = resolve;
        }),
      );
      try {
        onClaim();
        await ensureDatabase(free, project.dbPoolDatabase, project.dbExtensions);
        if (stoppingDatabaseWork) return await databaseShutdownWait;
        if (job.status === 'closed' || job.status === 'canceled') throw new Error('canceled');
        await dropLeftProfileDatabases(free, project, onEvent);
        if (stoppingDatabaseWork) return await databaseShutdownWait;
        if (job.status === 'closed' || job.status === 'canceled') throw new Error('canceled');
        if (project.dbRestoreSql) {
          onEvent(
            `Restoring ${project.dbPoolDatabase} on ${free.host}:${free.port} from ${project.dbRestoreSql}…`,
          );
          await restoreSql(free, project.dbPoolDatabase, project.dbRestoreSql);
        }
        if (stoppingDatabaseWork) return await databaseShutdownWait;
        if (job.status === 'closed' || job.status === 'canceled') throw new Error('canceled');
        job.dbPreparing = false;
      } catch (e) {
        if (stoppingDatabaseWork) return await databaseShutdownWait;
        job.dbPreparing = false;
        job.dbServerId = null;
        job.dbHost = null;
        job.dbPort = null;
        // An unreachable server will not recover on its own, so fail, not retry.
        claims.delete(free.id);
        throw new Error(`Could not prepare ${free.label} (${free.host}:${free.port}): ${e.message}`, {
          cause: e,
        });
      } finally {
        preparingInstances.delete(job.id);
        finishPreparation();
      }
      if (stoppingDatabaseWork) return await databaseShutdownWait;
      job.dbPreparing = false;
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

// Run-profile databases a previous claimant left on a server, by server id:
// recorded at release, dropped at the next claim.
const leftProfileDbs = new Map();

export function _resetForTests() {
  stoppingDatabaseWork = false;
  restoreProcesses.clear();
  preparingInstances.clear();
  leftProfileDbs.clear();
}

// Drops a previous session's profile databases before the claim's restore: the
// names the last release recorded, plus (for dump-restoring projects) the names
// the profiles render to, since a crash or restart releases without recording.
// Another project's pooled database is never dropped. A failed drop is reported
// and retried at the next claim rather than refusing the server.
async function dropLeftProfileDatabases(server, project, onEvent) {
  const left = leftProfileDbs.get(server.id) || [];
  const pooled = new Set(listProjects().map((p) => p.dbPoolDatabase));
  const names = [
    ...new Set([...left, ...(project.dbRestoreSql ? poolProfileDatabases(project, server) : [])]),
  ].filter((name) => !pooled.has(name));
  leftProfileDbs.delete(server.id);
  if (!names.length) return;
  onEvent(
    `Dropping the run profiles' databases ${names.join(', ')} on ${server.host}:${server.port}, so they start over…`,
  );
  const failed = [];
  for (const database of names) {
    try {
      await dropDatabase(server, database);
    } catch (e) {
      if (left.includes(database)) failed.push(database);
      onEvent(
        `Could not drop the run profile's database ${database} on ${server.host}:${server.port}: ${e.message}`,
      );
    }
  }
  if (failed.length) leftProfileDbs.set(server.id, failed);
}

// The databases the run profiles build off the pooled one ({database}_x) on
// this server; profiles pointing at another server are skipped.
function poolProfileDatabases(project, server) {
  const names = new Set();
  for (const profile of projectRunProfiles(project)) {
    const vars = { database: project.dbPoolDatabase, profile: profile.name };
    const env = Object.fromEntries(profile.env.map(([k, v]) => [k, render(v, vars)]));
    if (!env.DB_DATABASE || elsewhereKeys(env, server, project).length) continue;
    const name = env.DB_DATABASE;
    if (name.startsWith(`${project.dbPoolDatabase}_`) && /^[A-Za-z0-9_$]+$/.test(name)) names.add(name);
  }
  return [...names];
}

// The server a session's run-profile databases are made on: the claimed one,
// else the .env template's for a per-session database, else null.
function profileDbServer(job, project) {
  return job.dbServerId != null ? getDbServer(job.dbServerId) : job.sessionDb ? templateDb(project) : null;
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

// The server the .env template describes, which unpooled sessions run against.
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

/**
 * Outside the pool, each session gets its own database (project name plus
 * session id) on the .env template's server; seedCheckoutEnv writes the name.
 *
 * @returns {Promise<string|null>} the session's database name, or null when
 *   the mode does not apply (pooled project, or no database name configured)
 */
export async function ensureSessionDatabase(job, repoFull, onEvent) {
  if (job.kind !== 'devchat') return null;
  const project = getProject(repoFull);
  if (!project || project.dbPoolEnabled || !project.dbPoolDatabase) {
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

// The database name a session's app runs against, and what a run profile's
// {database} stands for. Empty for a local checkout, whose .env we never set.
export function sessionDatabaseName(job) {
  if (job.local) return '';
  const project = getProject(job.repo);
  return job.sessionDb || (project ? project.dbPoolDatabase : '') || '';
}

// Only a name built off the session's own ({database}_x) is the session's to drop.
function ownsProfileDb(job, database) {
  return !!job.sessionDb && database.startsWith(`${job.sessionDb}_`);
}

// Profile databases being created right now, per session. Drops and releases
// wait for them, or a late CREATE could land unrecorded on a server that is
// already another session's.
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
 * Outside the pool, names built off {database} are per-session and dropped
 * with the session; any other name may be shared or the developer's own, so
 * it is created if missing but never dropped.
 *
 * On a claimed server with a dump, names built off the pooled database are
 * recorded at release and dropped at the next claim (dropLeftProfileDatabases),
 * so the next session starts clean like the restored pooled database.
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
    // A local checkout, or an unpooled project naming no database: we do not
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
    if (
      job.dbServerId == null &&
      ownsProfileDb(job, database) &&
      !(job.profileDbs || []).includes(database)
    ) {
      job.profileDbs = [...(job.profileDbs || []), database];
    }
    if (
      job.dbServerId != null &&
      project.dbRestoreSql &&
      database.startsWith(`${project.dbPoolDatabase}_`) &&
      !(job.poolProfileDbs || []).includes(database)
    ) {
      job.poolProfileDbs = [...(job.poolProfileDbs || []), database];
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

// The other half of ensureDatabase.
async function dropDatabase(server, database) {
  if (!/^[A-Za-z0-9_$]+$/.test(database)) {
    throw new Error(`"${database}" is not a plain database identifier`);
  }
  if (server.engine === 'pgsql') {
    // FORCE (15+): Postgres refuses to drop a database with live connections,
    // and a session's app can briefly outlive the kill.
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
  if (creatingProfileDb(job)) await profileDbsCreated(job);
  const database = job.sessionDb;
  if (!database) return false;
  // A pooled database is the next session's starting point: never drop it.
  const project = getProject(job.repo);
  if (!project || project.dbPoolEnabled) return false;
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

// Records the run profiles' databases for the next claim to drop, after any
// in-flight CREATE finishes (see creatingProfileDbs).
export async function releaseInstance(job) {
  if (preparingInstances.has(job.id)) await preparingInstances.get(job.id);
  if (job.dbServerId == null) return;
  // Only awaited when needed, so a plain release stays synchronous.
  if (creatingProfileDb(job)) {
    await profileDbsCreated(job);
    if (job.dbServerId == null) return;
  }
  const serverId = job.dbServerId;
  const profileDbs = job.poolProfileDbs || [];
  job.dbServerId = null;
  job.dbHost = null;
  job.dbPort = null;
  if (job.poolProfileDbs) job.poolProfileDbs = [];
  if (profileDbs.length) {
    leftProfileDbs.set(serverId, [...new Set([...(leftProfileDbs.get(serverId) || []), ...profileDbs])]);
  }
  claims.delete(serverId);
}

// One Redis logical database per pool entry (0/1 stay the developer's), so
// parallel sessions cannot touch each other's cache or queues. Cache and
// default share one because stock `databases 16` has no room for pairs.
function redisDbs(job) {
  const idx = activeDbServers().findIndex((s) => s.id === job.dbServerId);
  const db = String((Math.max(idx, 0) % 14) + 2);
  return { default: db, cache: db };
}

// Preferred app port per pool entry (8101, 8102, …; 8100 unpooled). Others
// can still hold it, so startDevServe probes and shifts before spawning.
export function instanceAppPort(job) {
  if (job.dbServerId == null) return 8100;
  const idx = activeDbServers().findIndex((s) => s.id === job.dbServerId);
  return idx === -1 ? 8100 : 8101 + idx;
}

// Real environment variables, not a rewritten .env: Laravel-style dotenv is
// immutable, so these win over the checkout's .env without editing it.
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
    // Some apps read REDIS_DB, others REDIS_DB_NUM.
    REDIS_DB: redis.default,
    REDIS_DB_NUM: redis.default,
    REDIS_CACHE_DB: redis.cache,
  };
}
