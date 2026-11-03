import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';

// No database server here: mysql2 and spawn are mocked, and tests assert what was reached
// with what. The project (and so its .env template) is driven from `state`.
const state = vi.hoisted(() => ({
  project: null,
  otherProjects: [], // what listProjects answers beside `project`
  psqlCalls: [],
  psqlResults: [], // per call: {code, stdout, stderr}
  mysqlQueries: [],
  mysqlConnects: 0,
  mysqlConnectError: null,
  mysqlConnectErrors: [], // one per connect attempt, ahead of mysqlConnectError
  mysqlFailOn: null, // a query matching this regex rejects
  mysqlHold: null, // { on: regex, until: promise }: a matching query waits for it
  mysqlDatabases: [],
  mysqlLowerCase: 0, // @@lower_case_table_names
  spawnError: null, // makes the child emit 'error' instead of running
  psqlSpawn: null,
}));

vi.mock('../lib/projects.js', () => ({
  getProject: () => state.project,
  listProjects: () => [state.project, ...state.otherProjects],
}));

vi.mock('mysql2/promise', () => ({
  default: {
    createConnection: async (opts) => {
      state.mysqlConnects++;
      if (state.mysqlConnectErrors.length) throw state.mysqlConnectErrors.shift();
      if (state.mysqlConnectError) throw state.mysqlConnectError;
      return {
        query: async (query, values) => {
          const sql = typeof query === 'string' ? query : query.sql;
          if (state.mysqlHold && state.mysqlHold.on.test(sql)) await state.mysqlHold.until;
          state.mysqlQueries.push({
            opts,
            sql,
            ...(typeof query === 'object' ? { timeout: query.timeout } : {}),
            ...(values ? { values } : {}),
          });
          if (state.mysqlFailOn && state.mysqlFailOn.test(sql)) throw new Error('ER_DB_DROP_EXISTS');
          if (/SHOW DATABASES/.test(sql)) return [state.mysqlDatabases];
          if (/lower_case_table_names/.test(sql)) return [[{ lowerCase: state.mysqlLowerCase }]];
          return [[]];
        },
        destroy: vi.fn(),
        // Always rejected: the callers .catch(() => {}) it, and a close that
        // fails must not be what surfaces to the session.
        end: async () => {
          throw new Error('connection already gone');
        },
      };
    },
  },
}));

vi.mock('node:child_process', () => ({
  spawn: (bin, args, opts) => {
    state.psqlCalls.push({ bin, args, env: opts.env, ...(opts.timeout ? { timeout: opts.timeout } : {}) });
    if (bin === 'psql' && state.psqlSpawn) return state.psqlSpawn(args, opts);
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = new EventEmitter();
    child.kill = vi.fn();
    if (state.spawnError) {
      setTimeout(() => child.emit('error', state.spawnError), 0);
      return child;
    }
    const result = state.psqlResults.shift() || { code: 0, stdout: '' };
    // The close listener is attached after this call returns, so let the tick
    // finish before the process "exits".
    setTimeout(() => {
      if (result.stdout) child.stdout.emit('data', result.stdout);
      if (result.stderr) child.stderr.emit('data', result.stderr);
      child.emit('close', result.code);
    }, 0);
    return child;
  },
}));

const {
  ensureSessionDatabase,
  stopDatabaseProcesses,
  sessionDbEnv,
  dropSessionDatabase,
  ensureProfileDatabase,
  profileDbElsewhere,
  sessionDatabaseName,
  _resetForTests,
} = await import('../lib/dbpool.js');

const PG_TEMPLATE = [
  'DB_CONNECTION=pgsql',
  'DB_HOST=127.0.0.1',
  'DB_PORT=5432',
  'DB_DATABASE=sample_ia',
  'DB_USERNAME=postgres',
  'DB_PASSWORD=secret',
].join('\n');

const MYSQL_TEMPLATE = ['DB_HOST=127.0.0.1', 'DB_PORT=3306', 'DB_USERNAME=root', 'DB_PASSWORD=123456'].join(
  '\n',
);

function job(id = 'abc123') {
  return { id, kind: 'devchat' };
}

afterEach(() => {
  _resetForTests();
});

beforeEach(() => {
  state.psqlCalls = [];
  state.psqlResults = [];
  state.mysqlQueries = [];
  state.mysqlConnects = 0;
  state.mysqlConnectErrors = [];
  state.mysqlLowerCase = 0;
  state.mysqlConnectError = null;
  state.mysqlFailOn = null;
  state.mysqlHold = null;
  state.mysqlDatabases = [];
  state.spawnError = null;
  state.psqlSpawn = null;
  state.otherProjects = [];
  state.project = { dbPoolDatabase: 'sample', envTemplate: PG_TEMPLATE };
});

describe('database preparation shutdown', () => {
  it.each(['lookup', 'database', 'extension'])(
    'suspends PostgreSQL %s preparation when shutdown kills the command',
    async (stage) => {
      state.project.dbExtensions = ['pg_trgm'];
      let active;
      state.psqlSpawn = (args) => {
        const child = new EventEmitter();
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        child.kill = vi.fn();
        const sql = args.at(-1);
        if (
          (stage === 'lookup' && sql.startsWith('SELECT')) ||
          (stage === 'database' && sql.startsWith('CREATE DATABASE')) ||
          (stage === 'extension' && sql.includes('pg_trgm'))
        )
          active = child;
        else setTimeout(() => child.emit('close', 0), 0);
        return child;
      };
      const session = { ...job(), status: 'preparing', recoveryTurn: { completed: false } };
      const events = vi.fn();
      const settled = vi.fn();
      ensureSessionDatabase(session, 'acme/app', events).then(settled, settled);
      await vi.waitFor(() => expect(active).toBeDefined());
      const calls = state.psqlCalls.length;
      const stopping = stopDatabaseProcesses();
      expect(active.kill).toHaveBeenCalledWith('SIGKILL');
      active.emit('close', null, 'SIGKILL');
      await stopping;
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(settled).not.toHaveBeenCalled();
      expect(events).not.toHaveBeenCalled();
      expect(state.psqlCalls).toHaveLength(calls);
      expect(session).toMatchObject({ status: 'preparing', recoveryTurn: { completed: false } });
      expect(session.sessionDb).toBeUndefined();
      _resetForTests();
      state.psqlSpawn = null;
      expect(await ensureSessionDatabase(session, 'acme/app', events)).toBe('sample_abc123');
    },
  );

  it('suspends preparation when its final PostgreSQL command exits successfully during shutdown', async () => {
    state.project.dbExtensions = ['pg_trgm'];
    let active;
    state.psqlSpawn = (args) => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = vi.fn();
      if (args.at(-1).includes('pg_trgm')) active = child;
      else setTimeout(() => child.emit('close', 0), 0);
      return child;
    };
    const session = job();
    const events = vi.fn();
    const settled = vi.fn();
    ensureSessionDatabase(session, 'acme/app', events).then(settled, settled);
    await vi.waitFor(() => expect(active).toBeDefined());
    const stopping = stopDatabaseProcesses();
    active.emit('close', 0);
    await stopping;
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(settled).not.toHaveBeenCalled();
    expect(events).not.toHaveBeenCalled();
    expect(session.sessionDb).toBeUndefined();
  });

  it('kills and awaits a real PostgreSQL extension process before preparation can recover', async () => {
    const { spawn: actualSpawn } = await vi.importActual('node:child_process');
    const { default: actualFs } = await vi.importActual('node:fs');
    const { default: os } = await vi.importActual('node:os');
    const { default: path } = await vi.importActual('node:path');
    const root = actualFs.mkdtempSync(path.join(os.tmpdir(), 'db-psql-shutdown-'));
    const ready = path.join(root, 'ready');
    const late = path.join(root, 'late');
    let ddl;
    state.project = { dbPoolDatabase: 'app', envTemplate: PG_TEMPLATE, dbExtensions: ['pg_trgm', 'vector'] };
    state.psqlSpawn = (args, opts) => {
      const sql = args.at(-1);
      const script = sql.includes('pg_trgm')
        ? `require('fs').writeFileSync(${JSON.stringify(ready)}, 'ready'); setTimeout(() => require('fs').writeFileSync(${JSON.stringify(late)}, 'late DDL'), 800); setInterval(() => {}, 1000);`
        : 'console.log(1)';
      const child = actualSpawn(process.execPath, ['-e', script], opts);
      if (sql.includes('pg_trgm')) ddl = child;
      return child;
    };
    const session = { ...job(), repo: 'acme/app' };
    let settled = false;
    ensureSessionDatabase(session, session.repo, vi.fn()).finally(() => {
      settled = true;
    });
    try {
      await vi.waitFor(() => expect(actualFs.existsSync(ready)).toBe(true));
      await stopDatabaseProcesses();
      expect(ddl.signalCode).toBe('SIGKILL');
      await new Promise((resolve) => setTimeout(resolve, 900));
      expect(actualFs.existsSync(late)).toBe(false);
      expect(state.psqlCalls.some((c) => c.args.at(-1).includes('vector'))).toBe(false);
      expect(session.sessionDb).toBeUndefined();
      expect(settled).toBe(false);
    } finally {
      ddl?.kill('SIGKILL');
      _resetForTests();
      actualFs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('ensureSessionDatabase', () => {
  beforeEach(() => {
    state.project = { dbPoolDatabase: 'sample', envTemplate: PG_TEMPLATE };
  });

  it('provisions, exports and cleans only the review database, including its extensions', async () => {
    state.project.dbExtensions = ['vector'];
    const review = { ...job('review123'), repo: 'acme/app', activity: 'review' };
    await ensureSessionDatabase(review, review.repo, () => {});

    // The XML test database and .env template database must not replace this
    // environment value when a runner loads its defaults before dotenv.
    expect(sessionDbEnv(review)).toEqual({ DB_DATABASE: 'sample_review123' });
    const extension = state.psqlCalls.find((c) => c.args.at(-1).includes('CREATE EXTENSION'));
    expect(extension.args.at(-1)).toBe('CREATE EXTENSION IF NOT EXISTS "vector"');
    expect(extension.args[extension.args.indexOf('--dbname') + 1]).toBe(sessionDbEnv(review).DB_DATABASE);

    await dropSessionDatabase(review, () => {});
    expect(state.psqlCalls.at(-1).args.at(-1)).toBe(
      'DROP DATABASE IF EXISTS "sample_review123" WITH (FORCE)',
    );
    expect(sessionDbEnv(review)).toEqual({});
  });

  it('creates the session database on Postgres when the template says pgsql', async () => {
    state.psqlResults = [
      { code: 0, stdout: '' },
      { code: 0, stdout: 'CREATE DATABASE' },
    ];
    const events = [];
    const j = job();

    const name = await ensureSessionDatabase(j, 'exampleco/sample-app', (t) => events.push(t));

    expect(name).toBe('sample_abc123');
    expect(j.sessionDb).toBe('sample_abc123');
    expect(state.mysqlQueries).toHaveLength(0);
    expect(state.psqlCalls).toHaveLength(2);
    const [probe, create] = state.psqlCalls;
    expect(probe.bin).toBe('psql');
    expect(probe.args).toContain('5432');
    expect(probe.args.at(-1)).toBe("SELECT 1 FROM pg_database WHERE datname = 'sample_abc123'");
    expect(probe.env.PGPASSWORD).toBe('secret');
    expect(create.args.at(-1)).toBe('CREATE DATABASE "sample_abc123"');
    expect(events[0]).toContain('127.0.0.1:5432');
  });

  it('does not re-create a database that is already there', async () => {
    state.psqlResults = [{ code: 0, stdout: '1\n' }];

    await ensureSessionDatabase(job(), 'exampleco/sample-app', () => {});

    expect(state.psqlCalls).toHaveLength(1);
  });

  it('accepts losing the create race against a parallel session', async () => {
    state.psqlResults = [
      { code: 0, stdout: '' },
      { code: 1, stderr: 'ERROR:  database "sample_abc123" already exists' },
    ];

    await expect(ensureSessionDatabase(job(), 'exampleco/sample-app', () => {})).resolves.toBe(
      'sample_abc123',
    );
  });

  it('reports what psql said when the server refuses', async () => {
    state.psqlResults = [{ code: 2, stderr: 'psql: error: connection refused' }];

    await expect(ensureSessionDatabase(job(), 'exampleco/sample-app', () => {})).rejects.toThrow(
      /Could not create the session's database sample_abc123 on 127\.0\.0\.1:5432: psql: error: connection refused/,
    );
  });

  it('reports a create that failed for a reason other than losing the race', async () => {
    state.psqlResults = [
      { code: 0, stdout: '' },
      { code: 1, stderr: 'ERROR:  permission denied to create database' },
    ];

    await expect(ensureSessionDatabase(job(), 'exampleco/sample-app', () => {})).rejects.toThrow(
      /permission denied to create database/,
    );
  });

  it('reports a psql that will not start at all', async () => {
    state.spawnError = new Error('ENOENT');

    await expect(ensureSessionDatabase(job(), 'exampleco/sample-app', () => {})).rejects.toThrow(
      /could not start psql: ENOENT/,
    );
  });

  it('falls back to the exit code when psql said nothing on stderr', async () => {
    state.psqlResults = [{ code: 3 }];

    await expect(ensureSessionDatabase(job(), 'exampleco/sample-app', () => {})).rejects.toThrow(
      /psql exited with code 3/,
    );
  });

  it('still goes through mysql2 for a project without DB_CONNECTION', async () => {
    state.project = { dbPoolDatabase: 'sample', envTemplate: MYSQL_TEMPLATE };

    await ensureSessionDatabase(job(), 'exampleco/sample-app', () => {});

    expect(state.psqlCalls).toHaveLength(0);
    expect(state.mysqlQueries).toHaveLength(1);
    expect(state.mysqlQueries[0].opts.port).toBe(3306);
    expect(state.mysqlQueries[0].sql).toMatch(/CREATE DATABASE IF NOT EXISTS `sample_abc123`/);
  });

  it('creates the extensions the project names in the new database', async () => {
    state.project = {
      dbPoolDatabase: 'sample',
      dbExtensions: ['vector', 'pg_trgm'],
      envTemplate: PG_TEMPLATE,
    };
    state.psqlResults = [
      { code: 0, stdout: '' },
      { code: 0, stdout: 'CREATE DATABASE' },
      { code: 0, stdout: 'CREATE EXTENSION' },
      { code: 0, stdout: 'CREATE EXTENSION' },
    ];

    await ensureSessionDatabase(job(), 'exampleco/sample-app', () => {});

    expect(state.psqlCalls).toHaveLength(4);
    const [vector, trgm] = state.psqlCalls.slice(2);
    expect(vector.args.at(-1)).toBe('CREATE EXTENSION IF NOT EXISTS "vector"');
    // Against the session's own database, not the maintenance one: an
    // extension belongs to a database, not to the server.
    expect(vector.args[vector.args.indexOf('--dbname') + 1]).toBe('sample_abc123');
    expect(trgm.args.at(-1)).toBe('CREATE EXTENSION IF NOT EXISTS "pg_trgm"');
  });

  it('creates the extensions on a database that already existed', async () => {
    state.project = {
      dbPoolDatabase: 'sample',
      dbExtensions: ['vector'],
      envTemplate: PG_TEMPLATE,
    };
    state.psqlResults = [
      { code: 0, stdout: '1' },
      { code: 0, stdout: 'CREATE EXTENSION' },
    ];

    await ensureSessionDatabase(job(), 'exampleco/sample-app', () => {});

    expect(state.psqlCalls).toHaveLength(2);
    expect(state.psqlCalls[1].args.at(-1)).toBe('CREATE EXTENSION IF NOT EXISTS "vector"');
  });

  it('fails the session when an extension is missing on the server', async () => {
    state.project = {
      dbPoolDatabase: 'sample',
      dbExtensions: ['vector'],
      envTemplate: PG_TEMPLATE,
    };
    state.psqlResults = [
      { code: 0, stdout: '1' },
      { code: 1, stderr: 'ERROR:  extension "vector" is not available' },
    ];

    await expect(ensureSessionDatabase(job(), 'exampleco/sample-app', () => {})).rejects.toThrow(
      /extension "vector" is not available/,
    );
  });

  it('keeps a Postgres name within the 63-byte identifier limit', async () => {
    state.project = {
      dbPoolDatabase: 'c'.repeat(60),
      envTemplate: PG_TEMPLATE,
    };
    state.psqlResults = [{ code: 0, stdout: '1' }];

    const name = await ensureSessionDatabase(job(), 'exampleco/sample-app', () => {});

    expect(name).toHaveLength(63);
  });

  it('keeps a MySQL name within the 64-byte identifier limit', async () => {
    state.project = {
      dbPoolDatabase: 'c'.repeat(70),
      envTemplate: MYSQL_TEMPLATE,
    };

    const name = await ensureSessionDatabase(job(), 'exampleco/sample-app', () => {});

    expect(name).toHaveLength(64);
  });

  it('replaces anything in the session id that is not an identifier character', async () => {
    state.project = { dbPoolDatabase: 'sample', envTemplate: MYSQL_TEMPLATE };

    const name = await ensureSessionDatabase(job('a-b.c/d'), 'exampleco/sample-app', () => {});

    expect(name).toBe('sample_a_b_c_d');
  });

  it('does not apply to anything but a dev session', async () => {
    const j = { id: 'x', kind: 'review' };

    expect(await ensureSessionDatabase(j, 'exampleco/sample-app', () => {})).toBeNull();
  });

  it('does not apply to a project with no database name', async () => {
    state.project = { dbPoolDatabase: '', envTemplate: MYSQL_TEMPLATE };

    expect(await ensureSessionDatabase(job(), 'exampleco/sample-app', () => {})).toBeNull();
  });

  it('does not apply to a repo with no project at all', async () => {
    state.project = null;

    expect(await ensureSessionDatabase(job(), 'exampleco/sample-app', () => {})).toBeNull();
  });

  describe('on a server at max_connections', () => {
    const tooMany = () => Object.assign(new Error('Too many connections'), { errno: 1040 });
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('waits for a connection instead of failing the session', async () => {
      state.project = { dbPoolDatabase: 'sample', envTemplate: MYSQL_TEMPLATE };
      state.mysqlConnectErrors = [tooMany(), tooMany()];
      const j = job();

      const ensuring = ensureSessionDatabase(j, 'exampleco/sample-app', () => {});
      await vi.advanceTimersByTimeAsync(7000);

      expect(await ensuring).toBe('sample_abc123');
      expect(state.mysqlConnects).toBe(3);
      expect(state.mysqlQueries.map((q) => q.sql)).toEqual([
        'CREATE DATABASE IF NOT EXISTS `sample_abc123` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci',
      ]);
    });

    it('gives up after about a minute', async () => {
      state.project = { dbPoolDatabase: 'sample', envTemplate: MYSQL_TEMPLATE };
      state.mysqlConnectError = tooMany();

      const ensuring = ensureSessionDatabase(job(), 'exampleco/sample-app', () => {});
      const outcome = expect(ensuring).rejects.toThrow(
        /sample_abc123 on 127.0.0.1:3306: Too many connections/,
      );
      await vi.advanceTimersByTimeAsync(67000);

      await outcome;
      expect(state.mysqlConnects).toBe(6);
    });

    it('stops retrying a creation once the session is closing, before anything is made', async () => {
      state.project = { dbPoolDatabase: 'sample', envTemplate: MYSQL_TEMPLATE };
      state.mysqlConnectErrors = [tooMany()];
      const j = { ...job(), repo: 'r/r' };

      const ensuring = ensureSessionDatabase(j, 'exampleco/sample-app', () => {});
      const outcome = expect(ensuring).rejects.toThrow('canceled');
      await vi.advanceTimersByTimeAsync(0);
      // Close arrives during the backoff, before the database exists.
      j.closing = true;
      const closing = dropSessionDatabase(j, () => {});
      await vi.advanceTimersByTimeAsync(2000);

      await outcome;
      expect(await closing).toBe(false);
      // The retry gives up instead of connecting for a closed session.
      expect(state.mysqlConnects).toBe(1);
      expect(state.mysqlQueries).toEqual([]);
    });

    it('drops a database whose CREATE was already running when the close came', async () => {
      state.project = { dbPoolDatabase: 'sample', envTemplate: MYSQL_TEMPLATE };
      let finishCreate;
      state.mysqlHold = { on: /^CREATE DATABASE/, until: new Promise((r) => (finishCreate = r)) };
      const j = { ...job(), repo: 'r/r' };

      const ensuring = ensureSessionDatabase(j, 'exampleco/sample-app', () => {});
      const outcome = expect(ensuring).rejects.toThrow('canceled');
      await vi.advanceTimersByTimeAsync(0);
      j.closing = true;
      const closing = dropSessionDatabase(j, () => {});
      finishCreate();

      await outcome;
      expect(await closing).toBe(true);
      expect(state.mysqlQueries.map((q) => q.sql)).toEqual([
        expect.stringMatching(/^CREATE DATABASE IF NOT EXISTS `sample_abc123`/),
        'SELECT @@lower_case_table_names AS lowerCase',
        'SHOW DATABASES',
        'DROP DATABASE IF EXISTS `sample_abc123`',
      ]);
      expect(j.sessionDb).toBeNull();
    });

    it('does not reconnect once shutdown began during the backoff', async () => {
      state.project = { dbPoolDatabase: 'sample', envTemplate: MYSQL_TEMPLATE };
      state.mysqlConnectErrors = [tooMany()];
      let settled = false;
      ensureSessionDatabase(job(), 'exampleco/sample-app', () => {}).finally(() => (settled = true));
      await vi.advanceTimersByTimeAsync(0);
      await stopDatabaseProcesses();
      await vi.advanceTimersByTimeAsync(5000);

      expect(state.mysqlConnects).toBe(1);
      expect(state.mysqlQueries).toEqual([]);
      expect(settled).toBe(false);
    });

    it('does not retry other connection errors', async () => {
      state.project = { dbPoolDatabase: 'sample', envTemplate: MYSQL_TEMPLATE };
      state.mysqlConnectError = Object.assign(new Error('Access denied'), { errno: 1045 });

      await expect(ensureSessionDatabase(job(), 'exampleco/sample-app', () => {})).rejects.toThrow(
        /Access denied/,
      );
      expect(state.mysqlConnects).toBe(1);
    });
  });
});

describe('dropSessionDatabase', () => {
  it('drops the session database on MySQL', async () => {
    state.project = { dbPoolDatabase: 'sample', envTemplate: MYSQL_TEMPLATE };
    const events = [];
    const j = { ...job(), repo: 'exampleco/sample-app', sessionDb: 'sample_abc123' };

    expect(await dropSessionDatabase(j, (t) => events.push(t))).toBe(true);

    expect(state.mysqlQueries.map((q) => q.sql)).toEqual([
      'SELECT @@lower_case_table_names AS lowerCase',
      'SHOW DATABASES',
      'DROP DATABASE IF EXISTS `sample_abc123`',
    ]);
    expect(state.mysqlQueries[2].opts.port).toBe(3306);
    expect(j.sessionDb).toBeNull();
    expect(events[0]).toContain('sample_abc123');
  });

  it('drops the session database on Postgres, forcing connections off it', async () => {
    state.project = { dbPoolDatabase: 'sample', envTemplate: PG_TEMPLATE };
    const j = { ...job(), repo: 'exampleco/sample-app', sessionDb: 'sample_abc123' };

    expect(await dropSessionDatabase(j, () => {})).toBe(true);

    expect(state.mysqlQueries).toHaveLength(0);
    expect(state.psqlCalls.map((c) => c.args.at(-1))).toEqual([
      "SELECT coalesce(json_agg(datname::text), '[]') FROM pg_database WHERE left(datname, 14) = 'sample_abc123_'",
      'DROP DATABASE IF EXISTS "sample_abc123" WITH (FORCE)',
    ]);
  });

  it('does nothing for a session that never had a database of its own', async () => {
    state.project = { dbPoolDatabase: 'sample', envTemplate: MYSQL_TEMPLATE };

    expect(await dropSessionDatabase(job(), () => {})).toBe(false);
    expect(state.mysqlQueries).toHaveLength(0);
  });

  it('does not drop anything when the repo has no project left', async () => {
    state.project = null;
    const j = { ...job(), repo: 'exampleco/sample-app', sessionDb: 'sample_abc123' };

    expect(await dropSessionDatabase(j, () => {})).toBe(false);
    expect(state.mysqlQueries).toHaveLength(0);
  });

  it('reports a server it cannot reach instead of failing the close', async () => {
    state.project = { dbPoolDatabase: 'sample', envTemplate: MYSQL_TEMPLATE };
    state.mysqlConnectError = new Error('ECONNREFUSED');
    const events = [];
    const j = { ...job(), repo: 'exampleco/sample-app', sessionDb: 'sample_abc123' };

    expect(await dropSessionDatabase(j, (t) => events.push(t))).toBe(false);

    // The name stays: the database is still out there, and nothing should be
    // able to read this record as "there was never one".
    expect(j.sessionDb).toBe('sample_abc123');
    expect(events.at(-1)).toMatch(/Could not drop this session's database sample_abc123 .*ECONNREFUSED/);
  });
});

describe('ensureProfileDatabase', () => {
  it("creates it next to a session's own database, remembered for the close", async () => {
    state.project = { dbPoolDatabase: 'sample', envTemplate: MYSQL_TEMPLATE };
    const j = { ...job(), repo: 'r/r', sessionDb: 'sample_abc123' };

    await ensureProfileDatabase(j, 'sample_abc123_projects');
    await ensureProfileDatabase(j, 'sample_abc123_projects');

    expect(state.mysqlQueries[0].opts.port).toBe(3306);
    expect(j.profileDbs).toEqual(['sample_abc123_projects']);
  });

  it('creates a name not built off the session database, but never remembers it for the close', async () => {
    state.project = { dbPoolDatabase: 'sample', envTemplate: MYSQL_TEMPLATE };
    const j = { ...job(), repo: 'r/r', sessionDb: 'sample_abc123' };

    // The developer's own base database, and one every session's profile shares.
    expect(await ensureProfileDatabase(j, 'sample')).toBe(true);
    expect(await ensureProfileDatabase(j, 'sample_projects')).toBe(true);

    expect(state.mysqlQueries).toHaveLength(2);
    expect(j.profileDbs).toBeUndefined();
  });

  it("does nothing for the session's own database, or one this app does not manage", async () => {
    state.project = { dbPoolDatabase: 'sample', envTemplate: MYSQL_TEMPLATE };
    const own = { ...job(), repo: 'r/r', sessionDb: 'sample_abc123' };
    const local = { ...job(), repo: 'r/r' };

    expect(await ensureProfileDatabase(own, 'sample_abc123')).toBe(false);
    expect(await ensureProfileDatabase(local, 'sample_projects')).toBe(false);
    expect(await ensureProfileDatabase(own, '')).toBe(false);
    expect(state.mysqlQueries).toHaveLength(0);
  });

  it('tells a local checkout its profile database is its own to create', async () => {
    const events = [];
    const local = { ...job(), repo: 'r/r', local: true };

    expect(await ensureProfileDatabase(local, 'mydb_projects', (t) => events.push(t))).toBe(false);

    expect(state.mysqlQueries).toHaveLength(0);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatch(/mydb_projects is not created: create it yourself/);
  });

  it('tells a session without a database of its own the same', async () => {
    // No database name in Settings: every session shares the template's.
    state.project = { dbPoolDatabase: '', envTemplate: MYSQL_TEMPLATE };
    const events = [];
    const j = { ...job(), repo: 'r/r' };

    expect(await ensureProfileDatabase(j, 'myapp_projects', (t) => events.push(t))).toBe(false);

    expect(state.mysqlQueries).toHaveLength(0);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatch(/myapp_projects is not created: create it yourself/);
  });

  it('refuses a name that is not an identifier, or too long for the engine', async () => {
    state.project = { dbPoolDatabase: 'sample', envTemplate: PG_TEMPLATE };
    const j = { ...job(), repo: 'r/r', sessionDb: 'sample_abc123' };

    await expect(ensureProfileDatabase(j, 'sample; DROP')).rejects.toThrow(/not a plain database identifier/);
    await expect(ensureProfileDatabase(j, 'x'.repeat(64))).rejects.toThrow(/longer than 63/);
    expect(state.psqlCalls).toHaveLength(0);
  });

  it('names the session database {database} stands for', () => {
    state.project = { dbPoolDatabase: 'demoapp' };
    // Not the project's base name before the session has a database of its own.
    expect(sessionDatabaseName({ ...job(), repo: 'r/r' })).toBe('');
    expect(sessionDatabaseName({ ...job(), repo: 'r/r', sessionDb: 'demoapp_abc' })).toBe('demoapp_abc');
    // A local checkout runs against its own .env.
    expect(sessionDatabaseName({ ...job(), repo: 'r/r', local: true })).toBe('');
  });
});

describe('profileDbElsewhere', () => {
  it('compares a session against the server its .env template points at', () => {
    state.project = { dbPoolDatabase: 'sample', envTemplate: PG_TEMPLATE };
    const j = { ...job(), repo: 'r/r', sessionDb: 'sample_abc123' };

    expect(profileDbElsewhere(j, { DB_CONNECTION: 'postgres', DB_PORT: '5432' })).toEqual([]);
    expect(profileDbElsewhere(j, { DB_CONNECTION: 'mysql' })).toEqual(['DB_CONNECTION']);
  });

  it("takes the connection name the .env template gives the session as the session's own", () => {
    // A multi-tenant app names its central connection in config/database.php.
    state.project = {
      dbPoolDatabase: 'demoapp',
      envTemplate: 'DB_CONNECTION=central\nDB_HOST=10.0.0.4\nDB_PORT=3307',
    };
    const j = { ...job(), repo: 'r/r', sessionDb: 'demoapp_abc123' };

    expect(profileDbElsewhere(j, { DB_CONNECTION: 'central', DB_HOST: '10.0.0.4' })).toEqual([]);
    // A block copied from a .env restates the session's own server.
    expect(profileDbElsewhere(j, { DB_HOST: '10.0.0.4', DB_PORT: '3307' })).toEqual([]);
    expect(profileDbElsewhere(j, { DB_HOST: 'reports-db', DB_PORT: '3306' })).toEqual(['DB_HOST', 'DB_PORT']);
    expect(profileDbElsewhere(j, { DB_CONNECTION: 'CENTRAL' })).toEqual([]);
    expect(profileDbElsewhere(j, { DB_CONNECTION: 'mariadb' })).toEqual([]);
    expect(profileDbElsewhere(j, { DB_CONNECTION: 'landlord' })).toEqual(['DB_CONNECTION']);
    expect(profileDbElsewhere(j, { DB_CONNECTION: 'pgsql' })).toEqual(['DB_CONNECTION']);
  });

  it('leaves a session with no managed server to ensureProfileDatabase', () => {
    state.project = { dbPoolDatabase: 'sample', envTemplate: MYSQL_TEMPLATE };
    expect(profileDbElsewhere({ ...job(), repo: 'r/r', local: true }, { DB_HOST: 'x' })).toEqual([]);
  });
});

describe('dropping the run profiles databases with the session', () => {
  it('drops them before the session database, keeping one that would not drop', async () => {
    state.project = { dbPoolDatabase: 'sample', envTemplate: MYSQL_TEMPLATE };
    const events = [];
    const j = {
      ...job(),
      repo: 'r/r',
      sessionDb: 'sample_abc123',
      profileDbs: ['sample_abc123_projects', 'sample_abc123_commerce'],
    };

    expect(await dropSessionDatabase(j, (t) => events.push(t))).toBe(true);

    expect(state.mysqlQueries.map((q) => q.sql)).toEqual([
      'DROP DATABASE IF EXISTS `sample_abc123_projects`',
      'DROP DATABASE IF EXISTS `sample_abc123_commerce`',
      'SELECT @@lower_case_table_names AS lowerCase',
      'SHOW DATABASES',
      'DROP DATABASE IF EXISTS `sample_abc123`',
    ]);
    expect(j.profileDbs).toEqual([]);
    expect(events).toHaveLength(3);
  });

  it('never drops a listed name that was not built off the session database', async () => {
    state.project = { dbPoolDatabase: 'sample', envTemplate: MYSQL_TEMPLATE };
    const j = {
      ...job(),
      repo: 'r/r',
      sessionDb: 'sample_abc123',
      profileDbs: ['sample', 'sample_projects'],
    };

    expect(await dropSessionDatabase(j, () => {})).toBe(true);

    expect(state.mysqlQueries.map((q) => q.sql)).toEqual([
      'SELECT @@lower_case_table_names AS lowerCase',
      'SHOW DATABASES',
      'DROP DATABASE IF EXISTS `sample_abc123`',
    ]);
  });

  it('keeps the session database name while a profile database will not drop, so the next close retries it', async () => {
    state.project = { dbPoolDatabase: 'sample', envTemplate: MYSQL_TEMPLATE };
    state.mysqlFailOn = /sample_abc123_projects/;
    const events = [];
    const j = { ...job(), repo: 'r/r', sessionDb: 'sample_abc123', profileDbs: ['sample_abc123_projects'] };

    expect(await dropSessionDatabase(j, (t) => events.push(t))).toBe(true);

    // The session's own database goes all the same: a reopen's CREATE ... IF
    // NOT EXISTS must start from scratch, not land on the old one.
    expect(state.mysqlQueries.map((q) => q.sql)).toEqual([
      'DROP DATABASE IF EXISTS `sample_abc123_projects`',
      'SELECT @@lower_case_table_names AS lowerCase',
      'SHOW DATABASES',
      'DROP DATABASE IF EXISTS `sample_abc123`',
    ]);
    expect(j.sessionDb).toBe('sample_abc123');
    expect(j.profileDbs).toEqual(['sample_abc123_projects']);
    expect(events.at(-1)).toMatch(/Kept this session's database name sample_abc123/);

    // The next close (or the delete) finds both again.
    state.mysqlFailOn = null;
    state.mysqlQueries = [];
    expect(await dropSessionDatabase(j, () => {})).toBe(true);
    expect(state.mysqlQueries.map((q) => q.sql)).toEqual([
      'DROP DATABASE IF EXISTS `sample_abc123_projects`',
      'SELECT @@lower_case_table_names AS lowerCase',
      'SHOW DATABASES',
      'DROP DATABASE IF EXISTS `sample_abc123`',
    ]);
    expect(j.sessionDb).toBeNull();
  });

  it('waits for a profile database being created, so the close finds it and drops it', async () => {
    state.project = { dbPoolDatabase: 'sample', envTemplate: MYSQL_TEMPLATE };
    let letGo;
    state.mysqlHold = { on: /^CREATE/, until: new Promise((resolve) => (letGo = resolve)) };
    const j = { ...job(), repo: 'r/r', sessionDb: 'sample_abc123' };

    const creating = ensureProfileDatabase(j, 'sample_abc123_projects');
    const dropping = dropSessionDatabase(j, () => {});
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(state.mysqlQueries).toHaveLength(0);
    letGo();

    expect(await creating).toBe(true);
    expect(await dropping).toBe(true);
    expect(state.mysqlQueries.map((q) => q.sql)).toEqual([
      expect.stringMatching(/^CREATE DATABASE IF NOT EXISTS `sample_abc123_projects`/),
      'DROP DATABASE IF EXISTS `sample_abc123_projects`',
      'SELECT @@lower_case_table_names AS lowerCase',
      'SHOW DATABASES',
      'DROP DATABASE IF EXISTS `sample_abc123`',
    ]);
    expect(j.profileDbs).toEqual([]);
    expect(j.sessionDb).toBeNull();
  });

  it("drops the databases the app built off the session's name, such as its tenants", async () => {
    state.project = { dbPoolDatabase: 'sample', envTemplate: MYSQL_TEMPLATE };
    const column = 'Database';
    state.mysqlDatabases = [
      { [column]: 'sample_abc123_tenant_4ada3fbe-9864-4075-93ac-4d3dd777048a' },
      { [column]: 'sample_abc123_tenant_okanet' },
      // A name outside the prefix is never dropped.
      { [column]: 'sample_abc1234_tenant_okanet' },
    ];
    const events = [];
    const j = { ...job(), repo: 'r/r', sessionDb: 'sample_abc123' };

    expect(await dropSessionDatabase(j, (t) => events.push(t))).toBe(true);

    expect(state.mysqlQueries.map((q) => q.sql)).toEqual([
      'SELECT @@lower_case_table_names AS lowerCase',
      'SHOW DATABASES',
      'DROP DATABASE IF EXISTS `sample_abc123_tenant_4ada3fbe-9864-4075-93ac-4d3dd777048a`',
      'DROP DATABASE IF EXISTS `sample_abc123_tenant_okanet`',
      'DROP DATABASE IF EXISTS `sample_abc123`',
    ]);
    expect(j.sessionDb).toBeNull();
    expect(events.filter((e) => e.startsWith("Dropped the app's database"))).toHaveLength(2);
  });

  it("refuses an app database name that cannot be quoted, keeping the session's name for a retry", async () => {
    state.project = { dbPoolDatabase: 'sample', envTemplate: MYSQL_TEMPLATE };
    state.mysqlDatabases = [{ Database: 'sample_abc123_x`; DROP DATABASE y' }];
    const j = { ...job(), repo: 'r/r', sessionDb: 'sample_abc123' };

    expect(await dropSessionDatabase(j, () => {})).toBe(true);

    expect(state.mysqlQueries.map((q) => q.sql)).toEqual([
      'SELECT @@lower_case_table_names AS lowerCase',
      'SHOW DATABASES',
      'DROP DATABASE IF EXISTS `sample_abc123`',
    ]);
    expect(j.sessionDb).toBe('sample_abc123');
  });

  it("leaves another project's databases nested under the session's prefix", async () => {
    state.project = { dbPoolDatabase: 'sample', envTemplate: MYSQL_TEMPLATE };
    state.otherProjects = [{ dbPoolDatabase: 'sample_abc123_other' }];
    state.mysqlDatabases = [
      { Database: 'sample_abc123_tenant_1' },
      { Database: 'sample_abc123_other' },
      { Database: 'sample_abc123_other_12345678' },
      { Database: 'sample_abc123_other_12345678_tenant_1' },
      { Database: 'sample_abc123_otherwise' },
    ];
    const j = { ...job(), repo: 'r/r', sessionDb: 'sample_abc123' };

    expect(await dropSessionDatabase(j, () => {})).toBe(true);

    expect(state.mysqlQueries.map((q) => q.sql).filter((q) => q.startsWith('DROP'))).toEqual([
      'DROP DATABASE IF EXISTS `sample_abc123_tenant_1`',
      'DROP DATABASE IF EXISTS `sample_abc123_otherwise`',
      'DROP DATABASE IF EXISTS `sample_abc123`',
    ]);
  });

  it("drops nothing under a prefix that is another project's own database name", async () => {
    state.project = { dbPoolDatabase: 'sample', envTemplate: MYSQL_TEMPLATE };
    state.otherProjects = [{ dbPoolDatabase: 'sample_abc123' }];
    state.mysqlDatabases = [{ Database: 'sample_abc123_12345678' }];
    const j = { ...job(), repo: 'r/r', sessionDb: 'sample_abc123' };

    expect(await dropSessionDatabase(j, () => {})).toBe(true);

    expect(state.mysqlQueries.map((q) => q.sql).filter((q) => q.startsWith('DROP'))).toEqual([
      'DROP DATABASE IF EXISTS `sample_abc123`',
    ]);
  });

  it('matches names case-insensitively only where MySQL folds identifier case', async () => {
    state.project = { dbPoolDatabase: 'Sample', envTemplate: MYSQL_TEMPLATE };
    state.mysqlDatabases = [{ Database: 'sample_abc123_tenant' }];
    const drops = () => state.mysqlQueries.map((q) => q.sql).filter((q) => q.startsWith('DROP'));

    // A case-sensitive server: a differently cased name is someone else's.
    await dropSessionDatabase({ ...job(), repo: 'r/r', sessionDb: 'Sample_abc123' }, () => {});
    expect(drops()).toEqual(['DROP DATABASE IF EXISTS `Sample_abc123`']);

    state.mysqlQueries = [];
    state.mysqlLowerCase = 1;
    await dropSessionDatabase({ ...job(), repo: 'r/r', sessionDb: 'Sample_abc123' }, () => {});
    expect(drops()).toEqual([
      'DROP DATABASE IF EXISTS `sample_abc123_tenant`',
      'DROP DATABASE IF EXISTS `Sample_abc123`',
    ]);
  });

  it("reads PostgreSQL's names as JSON, so odd characters in them survive", async () => {
    state.project = { dbPoolDatabase: 'sample', envTemplate: PG_TEMPLATE };
    state.psqlResults = [{ code: 0, stdout: JSON.stringify(['sample_abc123_tenant\nblue ']) }];
    const j = { ...job(), repo: 'r/r', sessionDb: 'sample_abc123' };

    expect(await dropSessionDatabase(j, () => {})).toBe(true);

    expect(state.psqlCalls.map((c) => c.args.at(-1)).slice(1)).toEqual([
      'DROP DATABASE IF EXISTS "sample_abc123_tenant\nblue " WITH (FORCE)',
      'DROP DATABASE IF EXISTS "sample_abc123" WITH (FORCE)',
    ]);
  });

  it('leaves the list in place when the server cannot be reached', async () => {
    state.project = { dbPoolDatabase: 'sample', envTemplate: MYSQL_TEMPLATE };
    state.mysqlConnectError = new Error('ECONNREFUSED');
    const j = { ...job(), repo: 'r/r', sessionDb: 'sample_abc123', profileDbs: ['sample_abc123_projects'] };

    expect(await dropSessionDatabase(j, () => {})).toBe(false);
    expect(j.profileDbs).toEqual(['sample_abc123_projects']);
  });
});

describe('reading the server out of the project .env template', () => {
  const nameOf = async (envTemplate) => {
    state.project = { dbPoolDatabase: 'sample', envTemplate };
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
    const call = await nameOf('APP_NAME=sample\nDB_HOST=db.test\n# a comment');

    expect(call.opts.host).toBe('db.test');
  });

  it('treats a missing template as an empty one', async () => {
    state.project = { dbPoolDatabase: 'sample' };

    await ensureSessionDatabase(job(), 'r/r', () => {});

    expect(state.mysqlQueries[0].opts.host).toBe('127.0.0.1');
  });
});

describe('a database name that is not an identifier', () => {
  it('is refused before it can reach the DDL', async () => {
    // It goes into CREATE DATABASE as an identifier, where a placeholder
    // cannot be used and a quote would end it.
    state.project = {
      dbPoolDatabase: 'sample`; drop database x; --',
      envTemplate: MYSQL_TEMPLATE,
    };

    await expect(ensureSessionDatabase(job(), 'r/r', () => {})).rejects.toThrow(
      /is not a plain database identifier/,
    );
    expect(state.mysqlQueries).toHaveLength(0);
  });
});
