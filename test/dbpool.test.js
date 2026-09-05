import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';

// Neither a MySQL nor a Postgres server exists here: mysql2, spawn and fs are
// mocked, and what is asserted is which of them was reached and with what. The
// pool itself (activeDbServers, the config) is driven from `state` so the same
// module can be walked through an empty pool, a contended one and a healthy one.
const state = vi.hoisted(() => ({
  project: null,
  servers: [],
  config: null,
  psqlCalls: [],
  psqlResults: [], // per call: {code, stdout, stderr}
  mysqlQueries: [],
  mysqlConnectError: null,
  mysqlVersion: '8.0.36',
  mysqlDatabases: [],
  spawnError: null, // makes the child emit 'error' instead of running
  files: new Set(), // what fs.existsSync says yes to
  dumpError: null, // makes the dump read stream fail
  stdinError: null, // makes the write into mysql's stdin fail
}));

vi.mock('../lib/config.js', () => ({ getConfig: () => state.config }));

vi.mock('../lib/projects.js', () => ({ getProject: () => state.project }));

vi.mock('../lib/dbservers.js', () => ({
  activeDbServers: () => state.servers,
  getDbServer: (id) => state.servers.find((s) => s.id === Number(id)) || null,
}));

vi.mock('mysql2/promise', () => ({
  default: {
    createConnection: async (opts) => {
      if (state.mysqlConnectError) throw state.mysqlConnectError;
      return {
        query: async (sql) => {
          state.mysqlQueries.push({ opts, sql });
          if (/VERSION\(\)/.test(sql)) return [[{ version: state.mysqlVersion }]];
          if (/SHOW DATABASES/.test(sql)) return [state.mysqlDatabases];
          return [[]];
        },
        // Always rejected: the callers .catch(() => {}) it, and a close that
        // fails must not be what surfaces to the session.
        end: async () => {
          throw new Error('connection already gone');
        },
      };
    },
  },
}));

vi.mock('node:fs', () => ({
  default: {
    existsSync: (p) => state.files.has(p),
    createReadStream: () => {
      const s = new EventEmitter();
      s.pipe = () => {};
      s.destroy = () => {};
      if (state.dumpError) setTimeout(() => s.emit('error', state.dumpError), 0);
      return s;
    },
  },
}));

vi.mock('node:child_process', () => ({
  spawn: (bin, args, opts) => {
    state.psqlCalls.push({ bin, args, env: opts.env });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = new EventEmitter();
    child.kill = vi.fn();
    if (state.spawnError) {
      setTimeout(() => child.emit('error', state.spawnError), 0);
      return child;
    }
    if (state.stdinError) setTimeout(() => child.stdin.emit('error', state.stdinError), 0);
    const result = state.psqlResults.shift() || { code: 0, stdout: '' };
    // The close listener is attached after this call returns, so let the tick
    // finish before the process "exits".
    setTimeout(() => {
      if (result.stdout) child.stdout.emit('data', result.stdout);
      if (result.stderr) child.stderr.emit('data', result.stderr);
      if (!state.dumpError) child.emit('close', result.code);
    }, 0);
    return child;
  },
}));

const {
  ensureSessionDatabase,
  acquireInstance,
  releaseInstance,
  claimHolder,
  sessionCapacity,
  projectClaimsServer,
  probeDbServer,
  instanceAppPort,
  instanceEnv,
  dropSessionDatabase,
} = await import('../lib/dbpool.js');

const PG_TEMPLATE = [
  'DB_CONNECTION=pgsql',
  'DB_HOST=127.0.0.1',
  'DB_PORT=5432',
  'DB_DATABASE=casos_ia',
  'DB_USERNAME=postgres',
  'DB_PASSWORD=secret',
].join('\n');

const MYSQL_TEMPLATE = ['DB_HOST=127.0.0.1', 'DB_PORT=3306', 'DB_USERNAME=root', 'DB_PASSWORD=123456'].join(
  '\n',
);

function job(id = 'abc123') {
  return { id, kind: 'devchat' };
}

function server(over = {}) {
  return {
    id: 1,
    label: 'local',
    host: '127.0.0.1',
    port: 3306,
    username: 'root',
    password: 'pw',
    enabled: true,
    ...over,
  };
}

const config = (over = {}) => ({
  dbPool: { enabled: true, waitTimeoutMin: 10, pollSeconds: 0.001, ...(over.dbPool || {}) },
  dev: { maxSessions: 3, ...(over.dev || {}) },
});

// Claims live in a module-level Map that outlives a test, and a leaked one
// makes the next test wait for a server that will never free up. Every claim
// goes through here so afterEach can hand them all back.
const claimed = [];
async function acquire(j, repo = 'r/r', onEvent = () => {}) {
  const id = await acquireInstance(j, repo, onEvent);
  if (id != null) claimed.push(j);
  return id;
}

afterEach(() => {
  for (const j of claimed.splice(0)) releaseInstance(j);
});

beforeEach(() => {
  state.psqlCalls = [];
  state.psqlResults = [];
  state.mysqlQueries = [];
  state.mysqlConnectError = null;
  state.mysqlDatabases = [];
  state.spawnError = null;
  state.dumpError = null;
  state.stdinError = null;
  state.files = new Set();
  state.servers = [];
  state.config = config();
  state.project = { dbPoolEnabled: false, dbPoolDatabase: 'casos', envTemplate: PG_TEMPLATE };
});

describe('ensureSessionDatabase', () => {
  beforeEach(() => {
    state.project = { dbPoolEnabled: false, dbPoolDatabase: 'casos', envTemplate: PG_TEMPLATE };
  });

  it('creates the session database on Postgres when the template says pgsql', async () => {
    state.psqlResults = [
      { code: 0, stdout: '' },
      { code: 0, stdout: 'CREATE DATABASE' },
    ];
    const events = [];
    const j = job();

    const name = await ensureSessionDatabase(j, 'nadinyamaui/casos-ia', (t) => events.push(t));

    expect(name).toBe('casos_abc123');
    expect(j.sessionDb).toBe('casos_abc123');
    expect(state.mysqlQueries).toHaveLength(0);
    expect(state.psqlCalls).toHaveLength(2);
    const [probe, create] = state.psqlCalls;
    expect(probe.bin).toBe('psql');
    expect(probe.args).toContain('5432');
    expect(probe.args.at(-1)).toBe("SELECT 1 FROM pg_database WHERE datname = 'casos_abc123'");
    expect(probe.env.PGPASSWORD).toBe('secret');
    expect(create.args.at(-1)).toBe('CREATE DATABASE "casos_abc123"');
    expect(events[0]).toContain('127.0.0.1:5432');
  });

  it('does not re-create a database that is already there', async () => {
    state.psqlResults = [{ code: 0, stdout: '1\n' }];

    await ensureSessionDatabase(job(), 'nadinyamaui/casos-ia', () => {});

    expect(state.psqlCalls).toHaveLength(1);
  });

  it('accepts losing the create race against a parallel session', async () => {
    state.psqlResults = [
      { code: 0, stdout: '' },
      { code: 1, stderr: 'ERROR:  database "casos_abc123" already exists' },
    ];

    await expect(ensureSessionDatabase(job(), 'nadinyamaui/casos-ia', () => {})).resolves.toBe(
      'casos_abc123',
    );
  });

  it('reports what psql said when the server refuses', async () => {
    state.psqlResults = [{ code: 2, stderr: 'psql: error: connection refused' }];

    await expect(ensureSessionDatabase(job(), 'nadinyamaui/casos-ia', () => {})).rejects.toThrow(
      /Could not create the session's database casos_abc123 on 127\.0\.0\.1:5432: psql: error: connection refused/,
    );
  });

  it('reports a create that failed for a reason other than losing the race', async () => {
    state.psqlResults = [
      { code: 0, stdout: '' },
      { code: 1, stderr: 'ERROR:  permission denied to create database' },
    ];

    await expect(ensureSessionDatabase(job(), 'nadinyamaui/casos-ia', () => {})).rejects.toThrow(
      /permission denied to create database/,
    );
  });

  it('reports a psql that will not start at all', async () => {
    state.spawnError = new Error('ENOENT');

    await expect(ensureSessionDatabase(job(), 'nadinyamaui/casos-ia', () => {})).rejects.toThrow(
      /could not start psql: ENOENT/,
    );
  });

  it('falls back to the exit code when psql said nothing on stderr', async () => {
    state.psqlResults = [{ code: 3 }];

    await expect(ensureSessionDatabase(job(), 'nadinyamaui/casos-ia', () => {})).rejects.toThrow(
      /psql exited with code 3/,
    );
  });

  it('still goes through mysql2 for a project without DB_CONNECTION', async () => {
    state.project = { dbPoolEnabled: false, dbPoolDatabase: 'casos', envTemplate: MYSQL_TEMPLATE };

    await ensureSessionDatabase(job(), 'nadinyamaui/casos-ia', () => {});

    expect(state.psqlCalls).toHaveLength(0);
    expect(state.mysqlQueries).toHaveLength(1);
    expect(state.mysqlQueries[0].opts.port).toBe(3306);
    expect(state.mysqlQueries[0].sql).toMatch(/CREATE DATABASE IF NOT EXISTS `casos_abc123`/);
  });

  it('creates the extensions the project names in the new database', async () => {
    state.project = {
      dbPoolEnabled: false,
      dbPoolDatabase: 'casos',
      dbExtensions: ['vector', 'pg_trgm'],
      envTemplate: PG_TEMPLATE,
    };
    state.psqlResults = [
      { code: 0, stdout: '' },
      { code: 0, stdout: 'CREATE DATABASE' },
      { code: 0, stdout: 'CREATE EXTENSION' },
      { code: 0, stdout: 'CREATE EXTENSION' },
    ];

    await ensureSessionDatabase(job(), 'nadinyamaui/casos-ia', () => {});

    expect(state.psqlCalls).toHaveLength(4);
    const [vector, trgm] = state.psqlCalls.slice(2);
    expect(vector.args.at(-1)).toBe('CREATE EXTENSION IF NOT EXISTS "vector"');
    // Against the session's own database, not the maintenance one: an
    // extension belongs to a database, not to the server.
    expect(vector.args[vector.args.indexOf('--dbname') + 1]).toBe('casos_abc123');
    expect(trgm.args.at(-1)).toBe('CREATE EXTENSION IF NOT EXISTS "pg_trgm"');
  });

  it('creates the extensions on a database that already existed', async () => {
    state.project = {
      dbPoolEnabled: false,
      dbPoolDatabase: 'casos',
      dbExtensions: ['vector'],
      envTemplate: PG_TEMPLATE,
    };
    state.psqlResults = [
      { code: 0, stdout: '1' },
      { code: 0, stdout: 'CREATE EXTENSION' },
    ];

    await ensureSessionDatabase(job(), 'nadinyamaui/casos-ia', () => {});

    expect(state.psqlCalls).toHaveLength(2);
    expect(state.psqlCalls[1].args.at(-1)).toBe('CREATE EXTENSION IF NOT EXISTS "vector"');
  });

  it('fails the session when an extension is missing on the server', async () => {
    state.project = {
      dbPoolEnabled: false,
      dbPoolDatabase: 'casos',
      dbExtensions: ['vector'],
      envTemplate: PG_TEMPLATE,
    };
    state.psqlResults = [
      { code: 0, stdout: '1' },
      { code: 1, stderr: 'ERROR:  extension "vector" is not available' },
    ];

    await expect(ensureSessionDatabase(job(), 'nadinyamaui/casos-ia', () => {})).rejects.toThrow(
      /extension "vector" is not available/,
    );
  });

  it('keeps a Postgres name within the 63-byte identifier limit', async () => {
    state.project = {
      dbPoolEnabled: false,
      dbPoolDatabase: 'c'.repeat(60),
      envTemplate: PG_TEMPLATE,
    };
    state.psqlResults = [{ code: 0, stdout: '1' }];

    const name = await ensureSessionDatabase(job(), 'nadinyamaui/casos-ia', () => {});

    expect(name).toHaveLength(63);
  });

  it('keeps a MySQL name within the 64-byte identifier limit', async () => {
    state.project = {
      dbPoolEnabled: false,
      dbPoolDatabase: 'c'.repeat(70),
      envTemplate: MYSQL_TEMPLATE,
    };

    const name = await ensureSessionDatabase(job(), 'nadinyamaui/casos-ia', () => {});

    expect(name).toHaveLength(64);
  });

  it('replaces anything in the session id that is not an identifier character', async () => {
    state.project = { dbPoolEnabled: false, dbPoolDatabase: 'casos', envTemplate: MYSQL_TEMPLATE };

    const name = await ensureSessionDatabase(job('a-b.c/d'), 'nadinyamaui/casos-ia', () => {});

    expect(name).toBe('casos_a_b_c_d');
  });

  it('does not apply to anything but a dev session', async () => {
    const j = { id: 'x', kind: 'review' };

    expect(await ensureSessionDatabase(j, 'nadinyamaui/casos-ia', () => {})).toBeNull();
  });

  it('clears a stale name when the project has moved onto the pool', async () => {
    state.project = { dbPoolEnabled: true, dbPoolDatabase: 'casos', envTemplate: MYSQL_TEMPLATE };
    const j = { ...job(), sessionDb: 'casos_old' };

    expect(await ensureSessionDatabase(j, 'nadinyamaui/casos-ia', () => {})).toBeNull();
    expect(j.sessionDb).toBeNull();
  });

  it('does not apply to a project with no database name', async () => {
    state.project = { dbPoolEnabled: false, dbPoolDatabase: '', envTemplate: MYSQL_TEMPLATE };

    expect(await ensureSessionDatabase(job(), 'nadinyamaui/casos-ia', () => {})).toBeNull();
  });

  it('does not apply to a repo with no project at all', async () => {
    state.project = null;

    expect(await ensureSessionDatabase(job(), 'nadinyamaui/casos-ia', () => {})).toBeNull();
  });
});

describe('dropSessionDatabase', () => {
  it('drops the session database on MySQL', async () => {
    state.project = { dbPoolEnabled: false, dbPoolDatabase: 'casos', envTemplate: MYSQL_TEMPLATE };
    const events = [];
    const j = { ...job(), repo: 'nadinyamaui/casos-ia', sessionDb: 'casos_abc123' };

    expect(await dropSessionDatabase(j, (t) => events.push(t))).toBe(true);

    expect(state.mysqlQueries).toHaveLength(1);
    expect(state.mysqlQueries[0].sql).toBe('DROP DATABASE IF EXISTS `casos_abc123`');
    expect(state.mysqlQueries[0].opts.port).toBe(3306);
    expect(j.sessionDb).toBeNull();
    expect(events[0]).toContain('casos_abc123');
  });

  it('drops the session database on Postgres, forcing connections off it', async () => {
    state.project = { dbPoolEnabled: false, dbPoolDatabase: 'casos', envTemplate: PG_TEMPLATE };
    const j = { ...job(), repo: 'nadinyamaui/casos-ia', sessionDb: 'casos_abc123' };

    expect(await dropSessionDatabase(j, () => {})).toBe(true);

    expect(state.mysqlQueries).toHaveLength(0);
    expect(state.psqlCalls).toHaveLength(1);
    expect(state.psqlCalls[0].args.at(-1)).toBe('DROP DATABASE IF EXISTS "casos_abc123" WITH (FORCE)');
  });

  it('does nothing for a session that never had a database of its own', async () => {
    state.project = { dbPoolEnabled: false, dbPoolDatabase: 'casos', envTemplate: MYSQL_TEMPLATE };

    expect(await dropSessionDatabase(job(), () => {})).toBe(false);
    expect(state.mysqlQueries).toHaveLength(0);
  });

  it('never drops the shared database of a pooled project', async () => {
    state.project = { dbPoolEnabled: true, dbPoolDatabase: 'casos', envTemplate: MYSQL_TEMPLATE };
    const j = { ...job(), repo: 'nadinyamaui/casos-ia', sessionDb: 'casos' };

    expect(await dropSessionDatabase(j, () => {})).toBe(false);
    expect(state.mysqlQueries).toHaveLength(0);
    expect(j.sessionDb).toBe('casos');
  });

  it('does not drop anything when the repo has no project left', async () => {
    state.project = null;
    const j = { ...job(), repo: 'nadinyamaui/casos-ia', sessionDb: 'casos_abc123' };

    expect(await dropSessionDatabase(j, () => {})).toBe(false);
    expect(state.mysqlQueries).toHaveLength(0);
  });

  it('reports a server it cannot reach instead of failing the close', async () => {
    state.project = { dbPoolEnabled: false, dbPoolDatabase: 'casos', envTemplate: MYSQL_TEMPLATE };
    state.mysqlConnectError = new Error('ECONNREFUSED');
    const events = [];
    const j = { ...job(), repo: 'nadinyamaui/casos-ia', sessionDb: 'casos_abc123' };

    expect(await dropSessionDatabase(j, (t) => events.push(t))).toBe(false);

    // The name stays: the database is still out there, and nothing should be
    // able to read this record as "there was never one".
    expect(j.sessionDb).toBe('casos_abc123');
    expect(events[0]).toMatch(/Could not drop this session's database casos_abc123 .*ECONNREFUSED/);
  });
});

describe('reading the server out of the project .env template', () => {
  const nameOf = async (envTemplate) => {
    state.project = { dbPoolEnabled: false, dbPoolDatabase: 'casos', envTemplate };
    state.psqlResults = [{ code: 0, stdout: '1' }];
    await ensureSessionDatabase(job(), 'r/r', () => {});
    return state.psqlCalls[0] || state.mysqlQueries[0];
  };

  it('defaults an empty template to MySQL on 127.0.0.1:3306 as root', async () => {
    const call = await nameOf('');

    expect(call.opts).toMatchObject({ host: '127.0.0.1', port: 3306, user: 'root', password: '' });
  });

  it('defaults a pgsql template to port 5432 as postgres', async () => {
    const call = await nameOf('DB_CONNECTION=pgsql');

    expect(call.args[call.args.indexOf('--port') + 1]).toBe('5432');
    expect(call.args[call.args.indexOf('--username') + 1]).toBe('postgres');
  });

  it.each(['pgsql', 'postgres', 'postgresql', 'POSTGRES'])('reads %s as Postgres', async (word) => {
    const call = await nameOf(`DB_CONNECTION=${word}`);

    expect(call.bin).toBe('psql');
  });

  it('reads an unparseable port as the engine default', async () => {
    const call = await nameOf('DB_HOST=db.test\nDB_PORT=notaport');

    expect(call.opts.port).toBe(3306);
  });

  it('ignores lines that are not one of the five it reads', async () => {
    const call = await nameOf('APP_NAME=casos\nDB_HOST=db.test\n# a comment');

    expect(call.opts.host).toBe('db.test');
  });

  it('treats a missing template as an empty one', async () => {
    state.project = { dbPoolEnabled: false, dbPoolDatabase: 'casos' };

    await ensureSessionDatabase(job(), 'r/r', () => {});

    expect(state.mysqlQueries[0].opts.host).toBe('127.0.0.1');
  });
});

describe('a database name that is not an identifier', () => {
  it('is refused before it can reach the DDL', async () => {
    // It goes into CREATE DATABASE as an identifier, where a placeholder
    // cannot be used and a quote would end it.
    state.project = {
      dbPoolEnabled: false,
      dbPoolDatabase: 'casos`; drop database x; --',
      envTemplate: MYSQL_TEMPLATE,
    };

    await expect(ensureSessionDatabase(job(), 'r/r', () => {})).rejects.toThrow(
      /is not a plain database identifier/,
    );
    expect(state.mysqlQueries).toHaveLength(0);
  });
});

describe('whether the pool applies at all', () => {
  it('says no when claiming is switched off install-wide', () => {
    state.config = config({ dbPool: { enabled: false } });
    state.project = { dbPoolEnabled: true };

    expect(projectClaimsServer('r/r')).toBe(false);
  });

  it('says no for a project that does not claim one', () => {
    state.project = { dbPoolEnabled: false };

    expect(projectClaimsServer('r/r')).toBe(false);
  });

  it('says no for a repo with no project', () => {
    state.project = null;

    expect(projectClaimsServer('r/r')).toBe(false);
  });

  it('says yes for a project that does', () => {
    state.project = { dbPoolEnabled: true };

    expect(projectClaimsServer('r/r')).toBe(true);
  });
});

describe('how many pooled sessions may be open', () => {
  it('is the configured fallback when claiming is off', () => {
    state.config = config({ dbPool: { enabled: false }, dev: { maxSessions: 7 } });
    state.servers = [server(), server({ id: 2 })];

    expect(sessionCapacity()).toBe(7);
  });

  it('is one per pool entry when claiming is on', () => {
    state.servers = [server(), server({ id: 2 })];

    expect(sessionCapacity()).toBe(2);
  });

  it('falls back to the configured cap while the pool is still empty', () => {
    state.servers = [];

    expect(sessionCapacity()).toBe(3);
  });
});

describe('probing a server from the settings page', () => {
  it('reports the version and how many databases it holds', async () => {
    state.mysqlVersion = '8.4.0';
    state.mysqlDatabases = [{}, {}, {}];

    await expect(
      probeDbServer({ host: ' db.test ', port: '3307', username: ' root ', password: 'pw' }),
    ).resolves.toEqual({ version: '8.4.0', databases: 3 });
  });

  it('trims the form values and connects on a short timeout', async () => {
    await probeDbServer({ host: ' db.test ', port: '3307', username: ' root ', password: 'pw' });

    expect(state.mysqlQueries[0].opts).toMatchObject({
      host: 'db.test',
      port: 3307,
      user: 'root',
      connectTimeout: 5000,
    });
  });

  it('reads a missing password as the empty one', async () => {
    await probeDbServer({ host: 'db.test', port: 3306, username: 'root' });

    expect(state.mysqlQueries[0].opts.password).toBe('');
  });

  it('reads missing host and username as blank rather than undefined', async () => {
    await probeDbServer({ port: 3306 });

    expect(state.mysqlQueries[0].opts).toMatchObject({ host: '', user: '' });
  });

  it('surfaces a server that will not answer', async () => {
    state.mysqlConnectError = new Error('ECONNREFUSED');

    await expect(probeDbServer({ host: 'db.test', port: 3306, username: 'root' })).rejects.toThrow(
      /ECONNREFUSED/,
    );
  });
});

describe('claiming a server', () => {
  beforeEach(() => {
    state.project = { dbPoolEnabled: true, dbPoolDatabase: 'casos', envTemplate: MYSQL_TEMPLATE };
    state.servers = [server({ id: 1 }), server({ id: 2, host: 'db2', port: 3307 })];
  });

  it('does not apply to anything but a dev session', async () => {
    expect(await acquire({ id: 'x', kind: 'review' }, 'r/r', () => {})).toBeNull();
  });

  it('does not apply to a project outside the pool', async () => {
    state.project = { dbPoolEnabled: false };

    expect(await acquire(job(), 'r/r', () => {})).toBeNull();
  });

  it('claims the first free entry and stamps the session with it', async () => {
    const j = job();
    const events = [];

    const id = await acquire(j, 'r/r', (t) => events.push(t));

    expect(id).toBe(1);
    expect(j).toMatchObject({ dbServerId: 1, dbHost: '127.0.0.1', dbPort: 3306 });
    expect(claimHolder(1)).toBe('abc123');
    expect(events.at(-1)).toBe('Claimed database server 127.0.0.1:3306, using database casos.');
    releaseInstance(j);
  });

  it('creates the database on the server it claimed', async () => {
    const j = job();

    await acquire(j, 'r/r', () => {});

    expect(state.mysqlQueries[0].sql).toMatch(/CREATE DATABASE IF NOT EXISTS `casos`/);
    expect(state.mysqlQueries[0].opts.host).toBe('127.0.0.1');
    releaseInstance(j);
  });

  it('gives a second session the next entry rather than the same one', async () => {
    const a = job('a');
    const b = job('b');

    await acquire(a, 'r/r', () => {});
    const id = await acquire(b, 'r/r', () => {});

    expect(id).toBe(2);
    expect(claimHolder(2)).toBe('b');
    releaseInstance(a);
    releaseInstance(b);
  });

  it('claims a server without touching the database when the project names none', async () => {
    // The project's own setup commands are then the only thing that creates it.
    state.project = { dbPoolEnabled: true, dbPoolDatabase: '', envTemplate: MYSQL_TEMPLATE };
    const j = job();

    expect(await acquire(j, 'r/r', () => {})).toBe(1);
    expect(state.mysqlQueries).toHaveLength(0);
  });

  it('refuses when the project claims a server but the pool is empty', async () => {
    state.servers = [];

    await expect(acquireInstance(job(), 'r/r', () => {})).rejects.toThrow(/the pool is empty/);
  });

  it('waits for a peer to finish and says so once, not on every poll', async () => {
    state.servers = [server({ id: 1 })];
    const a = job('a');
    await acquire(a, 'r/r', () => {});
    const events = [];

    const pending = acquire(job('b'), 'r/r', (t) => events.push(t));
    // Let it poll a few times before the server frees up.
    await new Promise((r) => setTimeout(r, 20));
    releaseInstance(a);

    await expect(pending).resolves.toBe(1);
    expect(events.filter((e) => e.includes('waiting for one to free up'))).toHaveLength(1);
  });

  it('gives up once the wait timeout has passed', async () => {
    state.servers = [server({ id: 1 })];
    state.config = config({ dbPool: { waitTimeoutMin: -1 } });
    const a = job('a');
    await acquire(a, 'r/r', () => {});

    await expect(acquireInstance(job('b'), 'r/r', () => {})).rejects.toThrow(
      /no database server became free within -1 min/,
    );
    releaseInstance(a);
  });

  it.each(['canceled', 'closed'])('stops waiting when the session is %s', async (status) => {
    state.servers = [server({ id: 1 })];
    const a = job('a');
    await acquire(a, 'r/r', () => {});
    const b = { ...job('b'), status };

    await expect(acquireInstance(b, 'r/r', () => {})).rejects.toThrow('canceled');
    releaseInstance(a);
  });

  it('hands the entry back when the server cannot be prepared', async () => {
    // A server that cannot be reached will not come back on its own; better
    // to fail the claim than retry into the same wall holding the entry.
    state.servers = [server({ id: 1 })];
    state.mysqlConnectError = new Error('ECONNREFUSED');

    await expect(acquireInstance(job(), 'r/r', () => {})).rejects.toThrow(
      /Could not prepare local \(127\.0\.0\.1:3306\): ECONNREFUSED/,
    );
    expect(claimHolder(1)).toBeNull();
  });
});

describe('restoring the project dump into the claimed database', () => {
  beforeEach(() => {
    state.servers = [server({ id: 1 })];
    state.project = {
      dbPoolEnabled: true,
      dbPoolDatabase: 'casos',
      dbRestoreSql: '/dumps/casos.sql',
      envTemplate: MYSQL_TEMPLATE,
    };
    state.files = new Set(['/dumps/casos.sql']);
  });

  it('streams the dump through the mysql CLI and says so', async () => {
    const j = job();
    const events = [];

    await acquire(j, 'r/r', (t) => events.push(t));

    const call = state.psqlCalls.at(-1);
    expect(call.bin).toBe('mysql');
    expect(call.args).toContain('casos');
    expect(call.args).toContain('--init-command=SET SESSION FOREIGN_KEY_CHECKS=0');
    // The password goes in the environment, never on a command line.
    expect(call.env.MYSQL_PWD).toBe('pw');
    expect(call.args.join(' ')).not.toContain('pw');
    expect(events[0]).toContain('Restoring casos on 127.0.0.1:3306 from /dumps/casos.sql');
    releaseInstance(j);
  });

  it('refuses a dump that is not on disk', async () => {
    state.files = new Set();

    await expect(acquireInstance(job(), 'r/r', () => {})).rejects.toThrow(
      /the restore dump \/dumps\/casos.sql does not exist/,
    );
  });

  it('reports what mysql said when the load fails', async () => {
    state.psqlResults = [{ code: 1, stderr: 'ERROR 1064 at line 3' }];

    await expect(acquireInstance(job(), 'r/r', () => {})).rejects.toThrow(
      /mysql exited with code 1: ERROR 1064 at line 3/,
    );
  });

  it('reports a mysql that will not start at all', async () => {
    state.spawnError = new Error('ENOENT');

    await expect(acquireInstance(job(), 'r/r', () => {})).rejects.toThrow(/could not start mysql: ENOENT/);
  });

  it('reports a dump it cannot read, and kills the load', async () => {
    state.dumpError = new Error('EACCES');

    await expect(acquireInstance(job(), 'r/r', () => {})).rejects.toThrow(
      /could not read \/dumps\/casos.sql: EACCES/,
    );
  });

  it('swallows the broken pipe when mysql aborts mid-dump', async () => {
    // mysql aborts on any SQL error and the pipe then writes into a closed
    // stdin. Unhandled, that EPIPE is an uncaught exception taking the whole
    // server down, and with it every session not yet flushed to the database.
    state.stdinError = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
    state.psqlResults = [{ code: 1, stderr: 'ERROR 1146: table does not exist' }];

    await expect(acquireInstance(job(), 'r/r', () => {})).rejects.toThrow(
      /mysql exited with code 1: ERROR 1146: table does not exist/,
    );
  });

  it('reads a server with no password as the empty one', async () => {
    state.servers = [server({ id: 1, password: '' })];
    const j = job();

    await acquire(j, 'r/r', () => {});

    expect(state.psqlCalls.at(-1).env.MYSQL_PWD).toBe('');
    releaseInstance(j);
  });
});

describe('releasing a server', () => {
  beforeEach(() => {
    state.project = { dbPoolEnabled: true, dbPoolDatabase: 'casos', envTemplate: MYSQL_TEMPLATE };
    state.servers = [server({ id: 1 })];
  });

  it('frees the entry and clears the session stamp', async () => {
    const j = job();
    await acquire(j, 'r/r', () => {});

    releaseInstance(j);

    expect(claimHolder(1)).toBeNull();
    expect(j).toMatchObject({ dbServerId: null, dbHost: null, dbPort: null });
  });

  it('does nothing for a session that never claimed one', () => {
    const j = { ...job(), dbServerId: null };

    expect(() => releaseInstance(j)).not.toThrow();
  });
});

describe('the environment a claimed session runs with', () => {
  it('is empty for a session without a claimed server', () => {
    expect(instanceEnv({ dbServerId: null })).toEqual({});
    expect(instanceAppPort({ dbServerId: null })).toBe(8100);
  });

  it('is empty when the claimed entry has since been deleted', () => {
    state.servers = [];

    expect(instanceEnv({ dbServerId: 9 })).toEqual({});
  });

  it('points the app at the claimed server and the project database', () => {
    state.servers = [server({ id: 1, host: 'db1', port: 3307, username: 'u', password: 'p' })];
    state.project = { dbPoolDatabase: 'casos' };

    expect(instanceEnv({ dbServerId: 1, repo: 'r/r' })).toEqual({
      DB_HOST: 'db1',
      DB_PORT: '3307',
      DB_DATABASE: 'casos',
      DB_USERNAME: 'u',
      DB_PASSWORD: 'p',
      REDIS_DB: '2',
      REDIS_DB_NUM: '2',
      REDIS_CACHE_DB: '2',
    });
  });

  it('leaves the database name blank when the project is gone', () => {
    state.servers = [server({ id: 1 })];
    state.project = null;

    expect(instanceEnv({ dbServerId: 1, repo: 'r/r' }).DB_DATABASE).toBe('');
  });

  it('gives each pool entry a Redis keyspace of its own, above the developer two', () => {
    state.servers = [server({ id: 1 }), server({ id: 2 }), server({ id: 3 })];
    state.project = { dbPoolDatabase: 'casos' };

    expect(instanceEnv({ dbServerId: 2, repo: 'r/r' }).REDIS_DB).toBe('3');
    expect(instanceEnv({ dbServerId: 3, repo: 'r/r' }).REDIS_DB).toBe('4');
  });

  it('wraps the Redis keyspace back round rather than running past 15', () => {
    // redis-server ships with 16 keyspaces and the developer keeps 0 and 1.
    state.servers = Array.from({ length: 16 }, (_, i) => server({ id: i + 1 }));
    state.project = { dbPoolDatabase: 'casos' };

    expect(instanceEnv({ dbServerId: 15, repo: 'r/r' }).REDIS_DB).toBe('2');
    expect(instanceEnv({ dbServerId: 16, repo: 'r/r' }).REDIS_DB).toBe('3');
  });

  it('gives each pool entry an app port of its own', () => {
    state.servers = [server({ id: 1 }), server({ id: 2 })];

    expect(instanceAppPort({ dbServerId: 1 })).toBe(8101);
    expect(instanceAppPort({ dbServerId: 2 })).toBe(8102);
  });

  it('falls back to the shared port when the claimed entry is gone', () => {
    state.servers = [server({ id: 1 })];

    expect(instanceAppPort({ dbServerId: 9 })).toBe(8100);
  });
});
