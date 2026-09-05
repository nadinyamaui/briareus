import { describe, it, expect } from 'vitest';
import { readdir } from 'node:fs/promises';
import {
  createMigrator,
  runMigrations,
  rollbackLastBatch,
  migrationFileName,
  MIGRATIONS_DIR,
} from '../lib/migrator.js';

// A stand-in for the mysql2 pool: answers the handful of statements the
// `migrations` table storage issues, and records every other query so a test
// can see which migration bodies ran, in which order.
function fakePool() {
  const rows = [];
  const queries = [];
  let nextId = 1;
  const pool = {
    rows,
    queries,
    locks: [],
    // The advisory lock runs on a checked-out connection; it shares the
    // fake's query() so a test sees lock and DDL in one timeline.
    async getConnection() {
      return { query: pool.query, release() {} };
    },
    async query(sql, params = []) {
      if (/GET_LOCK/.test(sql)) {
        pool.locks.push('get');
        queries.push(sql);
        return [[{ ok: 1 }]];
      }
      if (/RELEASE_LOCK/.test(sql)) {
        pool.locks.push('release');
        queries.push(sql);
        return [[{}]];
      }
      if (/CREATE TABLE IF NOT EXISTS `migrations`/.test(sql)) return [[]];
      if (/SELECT `migration` FROM `migrations` WHERE `batch`/.test(sql)) {
        const max = Math.max(0, ...rows.map((r) => r.batch));
        return [rows.filter((r) => r.batch === max).sort((a, b) => b.id - a.id)];
      }
      if (/SELECT `migration` FROM `migrations`/.test(sql)) return [[...rows].sort((a, b) => a.id - b.id)];
      if (/MAX\(`batch`\)/.test(sql)) return [[{ b: Math.max(0, ...rows.map((r) => r.batch)) }]];
      if (/INSERT INTO `migrations`/.test(sql)) {
        rows.push({ id: nextId++, migration: params[0], batch: params[1] });
        return [{}];
      }
      if (/DELETE FROM `migrations`/.test(sql)) {
        const i = rows.findIndex((r) => r.migration === params[0]);
        if (i >= 0) rows.splice(i, 1);
        return [{}];
      }
      queries.push(sql);
      return [[]];
    },
  };
  return pool;
}

describe('migrator', () => {
  it('lists every file in migrations/ as pending on an empty database, in name order', async () => {
    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.js')).sort();
    const { umzug } = createMigrator(fakePool());
    const pending = (await umzug.pending()).map((m) => m.name);
    expect(pending).toEqual(files.map((f) => f.replace(/\.js$/, '')));
    expect(pending[0]).toBe('2026_08_27_000000_baseline');
  });

  it('runs the baseline once and records it in batch 1; a second run is a no-op', async () => {
    const pool = fakePool();
    const { umzug } = createMigrator(pool);
    const first = await umzug.up();
    expect(first.map((m) => m.name)).toContain('2026_08_27_000000_baseline');
    expect(pool.rows.every((r) => r.batch === 1)).toBe(true);
    expect(pool.queries.some((q) => /CREATE TABLE IF NOT EXISTS `jobs`/.test(q))).toBe(true);
    const again = await umzug.up();
    expect(again).toEqual([]);
  });

  it('refuses to roll the baseline back, and reports nothing to roll back on an empty database', async () => {
    const pool = fakePool();
    expect(await rollbackLastBatch(pool)).toEqual([]);
    await createMigrator(pool).umzug.up();
    await expect(rollbackLastBatch(pool)).rejects.toThrow(/baseline migration cannot be rolled back/);
  });

  it('holds the migration lock around the whole run and releases it even when a step fails', async () => {
    const pool = fakePool();
    await runMigrations(pool);
    expect(pool.locks).toEqual(['get', 'release']);
    const ddl = pool.queries.findIndex((q) => /CREATE TABLE IF NOT EXISTS `jobs`/.test(q));
    expect(ddl).toBeGreaterThan(pool.queries.findIndex((q) => /GET_LOCK/.test(q)));
    expect(ddl).toBeLessThan(pool.queries.findIndex((q) => /RELEASE_LOCK/.test(q)));
    // The baseline's down() throws; the lock must still come back.
    await expect(rollbackLastBatch(pool)).rejects.toThrow();
    expect(pool.locks).toEqual(['get', 'release', 'get', 'release']);
  });

  it('names new files the way Laravel does', () => {
    const at = new Date(2026, 7, 27, 9, 5, 3);
    expect(migrationFileName('Add notes to projects', at)).toBe('2026_08_27_090503_add_notes_to_projects.js');
    expect(() => migrationFileName('!!!')).toThrow(/needs a name/);
  });
});
