import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import mysql from 'mysql2/promise';
import { randomBytes } from 'node:crypto';
import { getConfig } from '../lib/config.js';
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
