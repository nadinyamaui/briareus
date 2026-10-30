import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import mysql from 'mysql2/promise';
import { randomBytes } from 'node:crypto';
import { getConfig } from '../lib/config.js';
import { createGithubSync } from '../lib/github-sync.js';
import { createCiStore } from '../lib/ci-store.js';
import { up, down } from '../migrations/2026_10_28_100000_add_ci_checks.js';
import * as runnersMigration from '../migrations/2026_10_30_100000_add_ci_runners.js';

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
    await runnersMigration.up({ context: pool });
    await runnersMigration.up({ context: pool });
    store = createCiStore({ connection: () => pool.getConnection() });
  });
  afterAll(async () => {
    if (pool) {
      await runnersMigration.down({ context: pool });
      await runnersMigration.down({ context: pool });
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

  it('distinguishes trailing spaces in exact-name filters and groups without trimming display names', async () => {
    const repo = 'acme/whitespace';
    await save(
      [
        { id: 1, context: 'deploy', state: 'success' },
        { id: 2, context: 'deploy ', state: 'pending' },
      ],
      { sha: 'abc' },
      repo,
    );
    const filters = { ...query, repos: [repo], kind: 'status' };
    const result = await store.stats(filters);
    expect(result.checks.map((row) => row.name)).toEqual(['deploy', 'deploy ']);
    expect((await store.stats({ ...filters, name: 'deploy' })).totals).toMatchObject({
      total: 1,
      succeeded: 1,
      pending: 0,
    });
    expect((await store.runs({ ...filters, name: 'deploy ' })).runs).toEqual([
      expect.objectContaining({ name: 'deploy ', status: 'in_progress' }),
    ]);
    expect((await store.stats(filters)).totals.total).toBe(2);
  });

  it('retains long external names and Unicode names without rolling back healthy batch members', async () => {
    const repo = 'acme/external-names';
    const long = 'build '.repeat(300);
    const unicode = '🚀'.repeat(128);
    const app = 'provider'.repeat(50);
    const branch = 'release/'.repeat(50);
    await save(
      [
        check({ name: long, app: { slug: app } }),
        check({ name: `${long}other`, app: { slug: app } }),
        check({ name: unicode }),
        check({ name: 'healthy' }),
      ],
      { branch },
      repo,
    );
    const filters = { ...query, repos: [repo], branch };
    const stats = await store.stats(filters);
    expect(stats.totals.total).toBe(4);
    expect(stats.checks).toHaveLength(4);
    expect(stats.checks.every((row) => row.total === 1)).toBe(true);
    expect((await store.runs({ ...filters, name: long })).runs).toEqual([
      expect.objectContaining({ name: long, app, branch }),
    ]);
    expect((await store.runs({ ...filters, name: unicode })).runs).toEqual([
      expect.objectContaining({ name: unicode }),
    ]);
  });

  it('preserves full display names and distinct apps in aggregate groups', async () => {
    const repo = 'acme/aggregate-groups';
    const name = 'build'.repeat(300);
    const app = 'provider'.repeat(200);
    const rows = [
      check({ name, app: { slug: app } }),
      check({ name, app: { slug: `${app} ` } }),
      check({ name: `${name} `, app: { slug: app } }),
      check({ name, app: null }),
    ];
    await save(rows, {}, repo);
    const result = await store.stats({ ...query, repos: [repo] });
    expect(result.totals.total).toBe(4);
    expect(result.checks).toHaveLength(4);
    expect(result.checks).toEqual(
      expect.arrayContaining(
        rows.map((row) => expect.objectContaining({ name: row.name, app: row.app?.slug || null, total: 1 })),
      ),
    );
  });

  it.each([503, 429])(
    'retains a pending-only discovery after completing its check before statuses fail with %i',
    async (status) => {
      const repo = `acme/pending-source-${status}`;
      const sha = 'old-head';
      const pending = check({ head_sha: sha, status: 'queued', conclusion: null });
      const completed = { ...pending, status: 'completed', conclusion: 'success' };
      const legacy = { id: 1, context: 'deploy', state: 'success' };
      await save([pending], { branch: 'old' }, repo);
      let failing = true;
      const requests = [];
      const finishSync = vi.fn(async () => {});
      const service = createGithubSync({
        projects: () => [{ repo }],
        config: () => ({ githubToken: 'token' }),
        ci: store,
        store: {
          syncState: async () => ({}),
          syncedItems: async () => new Map(),
          saveMetadata: async () => {},
          finishSync,
        },
        board: async () => ({}),
        invalidate: () => {},
        log: () => {},
        now: () => start + 180000,
        rest: async (_cfg, _method, path) => {
          requests.push(path);
          const url = new URL(path, 'https://api.github.com');
          let body = [];
          if (url.pathname.endsWith(`/commits/${sha}/check-runs`)) body = { check_runs: [completed] };
          else if (url.pathname.endsWith(`/commits/${sha}/statuses`)) {
            if (failing) throw Object.assign(new Error('statuses unavailable'), { status, resource: 'core' });
            body = [legacy];
          }
          return { ok: true, json: async () => body };
        },
      });
      const filters = { ...query, repos: [repo], branch: 'old' };
      try {
        await service.tick();
        expect((await store.runs(filters)).runs).toEqual([
          expect.objectContaining({ headSha: sha, status: 'completed' }),
        ]);
        expect(await store.pendingCommits(repo)).toEqual([]);
        expect((await store.runs({ ...filters, kind: 'status' })).runs).toEqual([]);
        expect(finishSync).toHaveBeenCalledWith(repo, null, expect.stringContaining('statuses unavailable'));
        if (status === 429) expect(requests.at(-1)).toContain(`/commits/${sha}/statuses`);

        failing = false;
        await service.tick();
        expect((await store.runs({ ...filters, kind: 'status' })).runs).toEqual([
          expect.objectContaining({ headSha: sha, name: 'deploy', status: 'completed' }),
        ]);
        expect(finishSync).toHaveBeenLastCalledWith(repo, expect.any(Number));
        requests.length = 0;
        await service.tick();
        expect(requests.some((path) => path.includes(`/commits/${sha}/`))).toBe(false);
      } finally {
        service.stop();
      }
    },
  );

  it('admits CI recovery before repeatedly quota-limited PR downloads with the actual GitHub client', async () => {
    const repo = 'acme/pr-admission';
    const pending = check({ head_sha: 'pending', status: 'queued', conclusion: null });
    const completed = { ...pending, status: 'completed', conclusion: 'success' };
    const defaultCheck = check({ head_sha: 'default' });
    await save([pending], {}, repo);
    vi.resetModules();
    const { githubRest } = await import('../lib/github.js');
    let clock = start + 180000;
    const dateNow = vi.spyOn(Date, 'now').mockImplementation(() => clock);
    let remaining = 12;
    const requests = [];
    const pull = {
      number: 1,
      title: 'CI',
      state: 'open',
      updated_at: '2026-10-28T10:00:00Z',
      head: { sha: 'current', ref: 'feature' },
      base: { sha: 'base', ref: 'main' },
    };
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
      else if (url.pathname === `/repos/${repo}/pulls`) body = [pull];
      else if (url.pathname.endsWith('/issues/1')) body = { ...pull, pull_request: {} };
      else if (url.pathname.endsWith('/pulls/1')) body = pull;
      else if (url.pathname.endsWith('/pulls/1/files'))
        body = Array.from({ length: 100 }, (_, i) => ({ filename: `file-${i}` }));
      else if (url.pathname.endsWith('/commits/main')) body = { sha: 'default' };
      else if (url.pathname.endsWith('/check-runs'))
        body = { check_runs: url.pathname.includes('/pending/') ? [completed] : [defaultCheck] };
      return Response.json(body);
    });
    const board = vi.fn(async () => ({}));
    const saveItem = vi.fn(async () => {});
    const finishSync = vi.fn(async () => {});
    const errors = [];
    const service = createGithubSync({
      projects: () => [{ repo }],
      config: () => ({ githubToken: 'token' }),
      rest: githubRest,
      ci: store,
      graphql: async () => ({
        repository: {
          issueOrPullRequest: {
            __typename: 'PullRequest',
            closingIssuesReferences: { nodes: [], pageInfo: { hasNextPage: false } },
          },
        },
      }),
      store: {
        syncState: async () => ({}),
        syncedItems: async () => new Map([[1, pull.updated_at]]),
        saveItem,
        finishSync,
        saveMetadata: async () => {},
      },
      board,
      invalidate: () => {},
      log: (message) => errors.push(message),
    });
    try {
      for (let tick = 0; tick < 6; tick++) {
        clock += 3600000;
        remaining = 12;
        await service.tick();
      }
      const result = await store.runs({ ...query, repos: [repo] });
      expect(result.runs).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ headSha: 'pending', status: 'completed' }),
          expect.objectContaining({ headSha: 'default', status: 'completed' }),
        ]),
      );
      expect(errors).toHaveLength(6);
      expect(errors.every((error) => error.includes('core rate limit exhausted'))).toBe(true);
      expect(board).toHaveBeenCalledTimes(6);
      expect(saveItem).not.toHaveBeenCalled();
      expect(finishSync).not.toHaveBeenCalledWith(repo, expect.any(Number));
      expect(requests).toContain(`/repos/${repo}/pulls/1/files?per_page=100&page=5`);
    } finally {
      service.stop();
      dateNow.mockRestore();
      vi.unstubAllGlobals();
    }
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
        } else if (
          sha === rows[0].head_sha &&
          url.pathname.endsWith('/statuses') &&
          Number(url.searchParams.get('page')) <= 9
        ) {
          // Status history exhausts every small window before its final page.
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
      // Its check is complete, but the failed status source must keep retrying.
      expect(requested.filter((sha) => sha === rows[0].head_sha)).toHaveLength(4);
      remaining = 1000;
      await service.tick();
      expect((await store.runs({ ...query, repos: [repo], kind: 'status' })).runs).toEqual([
        expect.objectContaining({ headSha: rows[0].head_sha, name: 'deploy', status: 'completed' }),
      ]);
      requested.length = 0;
      remaining = 1000;
      await service.tick();
      expect(requested).not.toContain(rows[0].head_sha);
    } finally {
      service.stop();
    }
  });

  it('recovers pending checks and discovers default heads despite a discovery exhausting every quota window', async () => {
    const repo = 'acme/source-recovery';
    const pending = check({ head_sha: 'pending', status: 'queued', conclusion: null });
    const completed = { ...pending, status: 'completed', conclusion: 'success' };
    const defaultCheck = check({ head_sha: 'default' });
    const expensiveCheck = check({ head_sha: 'expensive' });
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
        body = {
          check_runs: url.pathname.includes('/pending/')
            ? [completed]
            : url.pathname.includes('/expensive/')
              ? [{ ...expensiveCheck, conclusion: unavailable ? 'success' : 'failure' }]
              : [defaultCheck],
        };
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
        if (tick === 0) {
          // Status pagination exhausted this window, but the complete check
          // source still updates its independently persisted observation.
          expect(errors.at(-1)).toContain('core rate limit exhausted');
          expect((await store.runs({ ...query, repos: [repo] })).runs).toContainEqual(
            expect.objectContaining({ headSha: 'expensive', conclusion: 'failure' }),
          );
        }
      }
      expect(requests).toContain(`/repos/${repo}/commits/expensive/statuses?per_page=100&page=4`);
      expect(errors.some((message) => message.includes('core rate limit exhausted'))).toBe(true);
      expect(pendingCommits).toHaveBeenCalledWith(repo);
      expect(requests.some((path) => path.startsWith(`/repos/${repo}/commits/default/check-runs?`))).toBe(
        true,
      );
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

  it('attributes runners and prices their time by group, restating history when rates change', async () => {
    const repo = 'acme/runners';
    const filters = { ...query, repos: [repo] };
    const hour = 3600000;
    const job = (id, minutes) =>
      check({
        id,
        completed_at: new Date(start + minutes * 60000).toISOString(),
        app: { slug: 'github-actions' },
      });
    await save([job(9001, 60), job(9002, 30), job(9003, 90), job(9004, 10)], {}, repo);
    // A job delivered before its check is still joined once the check arrives.
    await store.saveRunners(
      'Acme/Runners',
      [
        {
          id: 9001,
          run_id: 1,
          status: 'completed',
          runner_name: 'eu-1',
          runner_group_name: 'Ubuntu EU',
          labels: ['self-hosted'],
        },
        { id: 9002, run_id: 1, status: 'in_progress', runner_name: 'eu-2', runner_group_name: 'Ubuntu EU' },
        {
          id: 9003,
          run_id: 2,
          status: 'completed',
          runner_name: 'GitHub Actions 1',
          runner_group_name: 'GitHub Actions',
        },
        { id: 9005, run_id: 3, status: 'queued', runner_name: null },
      ],
      start,
    );
    // A later read without a runner keeps the recorded one.
    await store.saveRunners(repo, [{ id: 9002, status: 'completed', runner_name: null }], start + 1);
    expect(await store.missingRunners(repo, ['9001', '9004', '9005'])).toEqual(['9004', '9005']);

    let stats = await store.stats(filters, { 'Ubuntu EU': 0.2 });
    expect(stats.totals).toMatchObject({
      totalDurationMs: 190 * 60000,
      pricedDurationMs: 1.5 * hour,
      cost: 0.3,
    });
    expect(stats.totals.unpricedDurationMs).toBe(100 * 60000);
    expect(stats.runnerGroups).toEqual([
      expect.objectContaining({ runnerGroup: null, total: 1, cost: null, unpricedDurationMs: hour / 6 }),
      expect.objectContaining({ runnerGroup: 'GitHub Actions', total: 1, cost: null }),
      expect.objectContaining({ runnerGroup: 'Ubuntu EU', total: 2, cost: 0.3 }),
    ]);
    expect(stats.runners.map((r) => [r.runnerGroup, r.runnerName, r.cost])).toEqual([
      [null, null, null],
      ['GitHub Actions', 'GitHub Actions 1', null],
      ['Ubuntu EU', 'eu-1', 0.2],
      ['Ubuntu EU', 'eu-2', 0.1],
    ]);

    stats = await store.stats(filters, { 'Ubuntu EU': 0, 'GitHub Actions': 0.48 });
    expect(stats.totals).toMatchObject({ pricedDurationMs: 3 * hour, cost: 0.72 });

    const page = await store.runs({ ...filters, runnerGroup: 'Ubuntu EU' }, { rates: { 'Ubuntu EU': 0.2 } });
    expect(page.runs.map((r) => [r.id, r.runner, r.cost])).toEqual([
      ['9001', { name: 'eu-1', group: 'Ubuntu EU', labels: ['self-hosted'] }, 0.2],
      ['9002', { name: 'eu-2', group: 'Ubuntu EU', labels: [] }, 0.1],
    ]);
    expect((await store.runs({ ...filters, runner: 'GitHub Actions 1' })).runs).toEqual([
      expect.objectContaining({ id: '9003', cost: null }),
    ]);

    // A rate matches its group name exactly: a trailing space is another group,
    // though the column's collation would compare the two as equal.
    stats = await store.stats(filters, { 'Ubuntu EU ': 99, 'Ubuntu EU': 0.2 });
    expect(stats.totals).toMatchObject({ pricedDurationMs: 1.5 * hour, cost: 0.3 });
    stats = await store.stats(filters, { 'Ubuntu EU ': 99 });
    expect(stats.totals).toMatchObject({ pricedDurationMs: 0, cost: null });
    const spaced = await store.runs(
      { ...filters, runnerGroup: 'Ubuntu EU' },
      { rates: { 'Ubuntu EU ': 99 } },
    );
    expect(spaced.runs.map((r) => r.cost)).toEqual([null, null]);
  });
});
