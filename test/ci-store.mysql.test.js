import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import mysql from 'mysql2/promise';
import { randomBytes } from 'node:crypto';
import { getConfig } from '../lib/config.js';
import { createGithubSync } from '../lib/github-sync.js';
import { createCiStore } from '../lib/ci-store.js';
import { up, down } from '../migrations/2026_10_28_100000_add_ci_checks.js';

describe.skipIf(process.env.CI_STORE_MYSQL !== '1')('CI ledger on MySQL', () => {
  const database = `briareus_ci_test_${randomBytes(6).toString('hex')}`;
  const start = Date.parse('2026-10-28T10:00:00Z');
  const query = { repos: ['acme/shop'], kind: 'check_run', since: start - 86400000, until: start + 86400000 };
  let bootstrap, pool, store;
  let sequence = 0;
  const check = (overrides = {}) => ({
    id: ++sequence,
    head_sha: 'a'.repeat(40),
    name: 'build',
    app: { slug: 'github-actions' },
    status: 'completed',
    conclusion: 'success',
    started_at: new Date(start).toISOString(),
    completed_at: new Date(start + 60000).toISOString(),
    ...overrides,
  });
  const save = (rows, hints = {}, repo = 'acme/shop') =>
    store.save(repo, rows, { branch: 'main', observedAt: start + 120000, ...hints });

  beforeAll(async () => {
    const { database: _database, ...config } = getConfig().db;
    bootstrap = await mysql.createConnection(config);
    await bootstrap.query(`CREATE DATABASE ${database} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    pool = mysql.createPool({ ...config, database, connectionLimit: 2 });
    await up({ context: pool });
    await up({ context: pool });
    store = createCiStore({ connection: () => pool.getConnection() });
  });
  afterAll(async () => {
    if (pool) {
      await down({ context: pool });
      await down({ context: pool });
      const [tables] = await pool.query('SHOW TABLES');
      expect(tables).toHaveLength(0);
      await pool.end();
      await bootstrap.query(`DROP DATABASE ${database}`);
    }
    await bootstrap?.end();
  });

  it('returns zeros and null rates for empty or unshared scopes', async () => {
    expect(await store.stats(query)).toMatchObject({
      totals: {
        total: 0,
        pending: 0,
        failed: 0,
        succeeded: 0,
        successRate: null,
        avgDurationMs: null,
        lastObservedAt: null,
      },
      daily: [],
      repositories: [],
      checks: [],
    });
    await save([check()], {}, 'private/other');
    expect((await store.stats({ ...query, repos: [] })).totals.total).toBe(0);
    expect((await store.runs(query)).runs).toEqual([]);
  });

  it('deduplicates observations across PRs and restarts, retains old heads and retries, and prevents regressions', async () => {
    const original = check();
    await save([original, original]);
    await save([{ ...original, conclusion: 'failure' }], { observedAt: start });
    await save([{ ...original, status: 'queued', conclusion: null, started_at: null, completed_at: null }], {
      observedAt: start,
    });
    const retry = check({ head_sha: 'b'.repeat(40), conclusion: 'failure' });
    await save([retry]);
    store = createCiStore({ connection: () => pool.getConnection() });
    const result = await store.stats(query);
    expect(result.totals).toMatchObject({
      total: 2,
      succeeded: 1,
      failed: 1,
      successRate: 0.5,
      timed: 2,
      avgDurationMs: 60000,
      totalDurationMs: 120000,
    });
    expect(result.daily[0]).toMatchObject({ day: '2026-10-28', total: 2 });
    expect(result.repositories).toHaveLength(1);
    expect(result.checks[0]).toMatchObject({ name: 'build', app: 'github-actions', total: 2 });
    const page = await store.runs(query, { limit: 1 });
    expect(page.runs).toHaveLength(1);
    expect(page.nextOffset).toBe(1);
    expect((await store.runs(query, { limit: 1, offset: 1 })).nextOffset).toBeNull();
    expect((await store.runs({ ...query, branch: 'other' })).runs).toEqual([]);
    expect((await store.stats({ ...query, since: start + 1 })).totals.total).toBe(0);
  });

  it('counts all outcome categories and excludes unknown durations from timing averages', async () => {
    await save([
      check({ name: 'outcomes', conclusion: 'cancelled', started_at: null, completed_at: null }),
      check({ name: 'outcomes', conclusion: 'skipped', started_at: null, completed_at: null }),
      check({ name: 'outcomes', conclusion: null, started_at: null, completed_at: null }),
      check({ name: 'outcomes', status: 'waiting', conclusion: null, started_at: null, completed_at: null }),
      check({ name: 'outcomes', conclusion: 'timed_out' }),
    ]);
    const result = await store.stats({ ...query, name: 'outcomes' });
    expect(result.totals).toMatchObject({
      total: 5,
      pending: 1,
      succeeded: 0,
      failed: 1,
      skipped: 1,
      cancelled: 1,
      other: 1,
      timed: 1,
      avgDurationMs: 60000,
    });
    expect(await store.pendingCommits('acme/shop')).toEqual([{ sha: 'a'.repeat(40), branch: 'main' }]);
    expect((await store.stats({ ...query, name: 'outcomes', conclusion: 'cancelled' })).totals.total).toBe(1);
  });

  it('keeps one latest legacy status, accepts a new pending transition, and ignores older IDs', async () => {
    const context = { context: 'deploy', sha: 'c'.repeat(40), created_at: new Date(start).toISOString() };
    await save([
      { ...context, id: 1000, state: 'success' },
      { ...context, id: 999, state: 'pending' },
    ]);
    const statuses = { ...query, kind: 'status' };
    expect((await store.stats(statuses)).totals).toMatchObject({ total: 1, succeeded: 1, timed: 0 });
    await save([{ ...context, id: 1001, state: 'pending' }]);
    expect((await store.stats(statuses)).totals).toMatchObject({ total: 1, pending: 1, succeeded: 0 });
    await save([{ ...context, id: 1002, state: 'failure' }]);
    await save([{ ...context, id: 1000, state: 'success' }], { observedAt: start + 300000 });
    expect((await store.runs(statuses)).runs[0]).toMatchObject({
      id: '1002',
      conclusion: 'failure',
      durationMs: null,
    });
  });

  it('imports repeated case variants as one completed legacy execution without false pending recovery', async () => {
    const repo = 'acme/case-status';
    const history = [
      { id: 2, context: 'Deploy', state: 'success', created_at: new Date(start).toISOString() },
      { id: 1, context: 'deploy', state: 'pending', created_at: new Date(start - 1000).toISOString() },
    ];
    await save(history, { sha: 'abc' }, repo);
    await save(history, { sha: 'abc', observedAt: start + 180000 }, repo);
    const filters = { ...query, repos: [repo], kind: 'status' };
    expect((await store.stats(filters)).totals).toMatchObject({ total: 1, pending: 0, succeeded: 1 });
    expect((await store.stats(filters)).checks).toEqual([
      expect.objectContaining({ name: 'Deploy', total: 1 }),
    ]);
    expect((await store.runs(filters)).runs).toEqual([
      expect.objectContaining({ id: '2', name: 'Deploy', status: 'completed', runAt: start - 1000 }),
    ]);
    expect(await store.pendingCommits(repo)).toEqual([]);
  });

  it('reaches unattempted pending commits after recurring pagination rate limits', async () => {
    const repo = 'acme/quota-recovery';
    const rows = Array.from({ length: 101 }, (_, i) =>
      check({ head_sha: String(i).padStart(40, '0'), status: 'queued', conclusion: null }),
    );
    await save(rows, {}, repo);
    const requested = [];
    let remaining;
    const service = createGithubSync({
      projects: () => [{ repo }],
      config: () => ({ githubToken: 'token' }),
      ci: store,
      store: {
        syncState: async () => ({}),
        syncedItems: async () => new Map(),
        saveMetadata: async () => {},
        finishSync: async () => {},
      },
      board: async () => ({}),
      invalidate: () => {},
      log: () => {},
      rest: async (_cfg, _method, path) => {
        if (remaining-- <= 0)
          throw Object.assign(new Error('rate limited'), { status: 429, resource: 'core' });
        const url = new URL(path, 'https://api.github.com');
        const sha = /\/commits\/([^/]+)\//.exec(url.pathname)?.[1];
        let body = [];
        if (url.pathname.endsWith('/check-runs')) {
          requested.push(sha);
          const row = rows.find((r) => r.head_sha === sha);
          body = {
            check_runs: [
              { ...row, status: sha === rows[100].head_sha ? 'queued' : 'completed', conclusion: 'success' },
            ],
          };
        } else if (sha === rows[0].head_sha && url.pathname.endsWith('/statuses')) {
          // Three full status pages exhaust the allowance before page four.
          body = Array.from({ length: 100 }, (_, i) => ({
            id: Number(url.searchParams.get('page')) * 100 + i,
            context: 'deploy',
            state: 'success',
          }));
        }
        return { ok: true, json: async () => body };
      },
    });
    try {
      for (let tick = 0; tick < 6; tick++) {
        remaining = 8; // inventory + metadata cost four shared core requests.
        await service.tick();
      }
      expect(requested).toContain(rows[1].head_sha);
      const result = await store.runs({ ...query, repos: [repo], status: 'completed' });
      expect(result.runs).toContainEqual(
        expect.objectContaining({ headSha: rows[1].head_sha, status: 'completed' }),
      );
      expect(requested.filter((sha) => sha === rows[0].head_sha)).toHaveLength(1);
    } finally {
      service.stop();
    }
  });

  it('recovers pending checks and discovers default heads despite a discovery exhausting every quota window', async () => {
    const repo = 'acme/source-recovery';
    const pending = check({ head_sha: 'pending', status: 'queued', conclusion: null });
    const completed = { ...pending, status: 'completed', conclusion: 'success' };
    const defaultCheck = check({ head_sha: 'default' });
    await save([pending], {}, repo);
    vi.resetModules();
    const { githubRest } = await import('../lib/github.js');
    let clock = start + 180000;
    const dateNow = vi.spyOn(Date, 'now').mockImplementation(() => clock);
    let remaining = 100;
    let unavailable = true;
    const requests = [];
    vi.stubGlobal('fetch', async (input) => {
      const url = new URL(input);
      requests.push(url.pathname + url.search);
      if (remaining-- <= 0)
        return new Response('{}', {
          status: 403,
          headers: {
            'x-ratelimit-resource': 'core',
            'x-ratelimit-remaining': '0',
            'x-ratelimit-reset': String(Math.floor((clock + 60000) / 1000)),
          },
        });
      let body = [];
      if (url.pathname === `/repos/${repo}`) body = { default_branch: 'main' };
      else if (url.pathname.endsWith('/commits/main')) body = { sha: 'default' };
      else if (url.pathname.endsWith('/check-runs'))
        body = { check_runs: url.pathname.includes('/pending/') ? [completed] : [defaultCheck] };
      else if (url.pathname.endsWith('/commits/expensive/statuses')) {
        if (unavailable) return new Response('{}', { status: 503 });
        const page = Number(url.searchParams.get('page'));
        body =
          page > 3
            ? []
            : Array.from({ length: 100 }, (_, i) => ({
                id: page * 100 + i,
                context: 'deploy',
                state: 'success',
              }));
      }
      return Response.json(body);
    });
    const errors = [];
    const pendingCommits = vi.spyOn(store, 'pendingCommits');
    const service = createGithubSync({
      projects: () => [{ repo }],
      config: () => ({ githubToken: 'token' }),
      rest: githubRest,
      ci: store,
      store: {
        syncState: async () => ({}),
        syncedItems: async () => new Map(),
        openPullNumbers: async () => [],
        saveMetadata: async () => {},
        finishSync: async () => {},
      },
      board: async () => ({}),
      invalidate: () => {},
      log: (message) => errors.push(message),
    });
    try {
      service.onWebhook('status', { repository: { full_name: repo }, sha: 'expensive' });
      await service.flush(repo);
      unavailable = false;
      requests.length = 0;
      for (let tick = 0; tick < 6; tick++) {
        clock += 3600000;
        remaining = 8; // Four inventory/metadata calls, then one recovery source can exhaust quota.
        await service.tick();
      }
      expect(requests).toContain(`/repos/${repo}/commits/expensive/statuses?per_page=100&page=4`);
      expect(errors.some((message) => message.includes('core rate limit exhausted'))).toBe(true);
      expect(pendingCommits).toHaveBeenCalledWith(repo);
      const result = await store.runs({ ...query, repos: [repo] });
      expect(result.runs).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ headSha: 'pending', status: 'completed' }),
          expect.objectContaining({ headSha: 'default', status: 'completed' }),
        ]),
      );
    } finally {
      service.stop();
      pendingCommits.mockRestore();
      dateNow.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it('imports newest-first legacy history with the same earliest day and latest verdict as live observations', async () => {
    const early = Date.parse('2026-10-27T23:59:00Z');
    const late = Date.parse('2026-10-28T00:01:00Z');
    const pending = {
      id: 2000,
      context: 'midnight',
      sha: 'midnight',
      state: 'pending',
      created_at: new Date(early).toISOString(),
    };
    const success = { ...pending, id: 2001, state: 'success', created_at: new Date(late).toISOString() };
    await save([success, pending], {}, 'acme/import');
    await save([pending], { observedAt: start }, 'acme/live');
    await save([success, pending], {}, 'acme/live');
    const filters = { ...query, kind: 'status', name: 'midnight' };
    const imported = await store.runs({ ...filters, repos: ['acme/import'] });
    const live = await store.runs({ ...filters, repos: ['acme/live'] });
    const expected = {
      id: '2001',
      status: 'completed',
      conclusion: 'success',
      runAt: early,
      observedAt: start + 120000,
    };
    expect(imported.runs[0]).toMatchObject(expected);
    expect(live.runs[0]).toMatchObject(expected);
    expect((await store.stats({ ...filters, repos: ['acme/import'], until: late })).daily).toEqual([
      expect.objectContaining({ day: '2026-10-27', total: 1, succeeded: 1 }),
    ]);
    await save([pending], { observedAt: start - 1000 }, 'acme/import');
    expect((await store.runs({ ...filters, repos: ['acme/import'] })).runs[0]).toMatchObject(expected);
  });

  it('rotates pending recovery through 101 unchanged commits and wraps independently per repo', async () => {
    const rows = Array.from({ length: 101 }, (_, i) =>
      check({
        head_sha: String(i).padStart(40, '0'),
        status: 'queued',
        conclusion: null,
      }),
    );
    await save(rows, {}, 'acme/recovery');
    const first = await store.pendingCommits('acme/recovery');
    expect(first).toHaveLength(100);
    expect(first[0].sha).toBe(rows[0].head_sha);
    expect(await store.pendingCommits('acme/recovery')).toEqual(first);
    // Neither unreadable nor empty GitHub reads write observations back.
    for (const row of first) store.markPendingAttempt('acme/recovery', row.sha);
    expect(await store.pendingCommits('ACME/RECOVERY')).toEqual([
      { sha: rows[100].head_sha, branch: 'main' },
    ]);
    store.markPendingAttempt('acme/recovery', rows[100].head_sha);
    expect(await store.pendingCommits('acme/recovery')).toEqual(first);
    expect(await store.pendingCommits('acme/other')).toEqual([]);
    for (const row of first) store.markPendingAttempt('ACME/RECOVERY', row.sha);
    expect(await store.pendingCommits('acme/recovery')).toEqual([
      { sha: rows[100].head_sha, branch: 'main' },
    ]);
  });

  it('rolls back a batch on a SQL error and binds literal filter values', async () => {
    await expect(
      save([check({ name: 'rolled-back' }), check({ name: 'invalid', status: null })]),
    ).rejects.toThrow();
    expect((await store.stats({ ...query, name: 'rolled-back' })).totals.total).toBe(0);
    expect((await store.stats({ ...query, name: "' OR 1=1 --" })).totals.total).toBe(0);
    await save([check({ name: 'Case' }), check({ name: 'case' })]);
    expect((await store.stats({ ...query, name: 'Case' })).totals.total).toBe(1);
  });

  it('accepts an authoritative reset of a reused check ID without counting an inferred attempt', async () => {
    const raw = check({ name: 'reset' });
    await save([raw]);
    await save([{ ...raw, status: 'queued', conclusion: null, started_at: null, completed_at: null }], {
      observedAt: start + 200000,
    });
    expect((await store.stats({ ...query, name: 'reset' })).totals).toMatchObject({
      total: 1,
      pending: 1,
      succeeded: 0,
      timed: 0,
    });
  });
});
