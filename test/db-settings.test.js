import { beforeEach, it, expect, vi } from 'vitest';

// No MySQL here: the pool is faked, and what is asserted is the order of the
// statements on the one connection, which is where the row lock lives.
const state = vi.hoisted(() => ({ queries: [], stored: null, released: 0 }));

vi.mock('../lib/config.js', () => ({
  getConfig: () => ({ db: { host: 'h', port: 3306, database: 'd', user: 'u', password: 'p' } }),
}));
vi.mock('../lib/migrator.js', () => ({ ensureDatabase: async () => {}, runMigrations: async () => {} }));
vi.mock('mysql2/promise', () => {
  const conn = {
    beginTransaction: async () => state.queries.push('BEGIN'),
    commit: async () => state.queries.push('COMMIT'),
    rollback: async () => state.queries.push('ROLLBACK'),
    release: () => state.released++,
    query: async (sql, params) => {
      state.queries.push(sql.split(' ').slice(0, 2).join(' '));
      if (sql.startsWith('SELECT')) return [state.stored == null ? [] : [{ value: state.stored }]];
      if (sql.startsWith('UPDATE')) state.stored = params[0];
      return [[]];
    },
  };
  return { default: { createPool: () => ({ getConnection: async () => conn, end: async () => {} }) } };
});

const { updateAppSetting } = await import('../lib/db.js');

beforeEach(() => {
  state.queries = [];
  state.stored = JSON.stringify(['a']);
  state.released = 0;
});

it('changes the setting under a row lock, in one transaction', async () => {
  const { value, result } = await updateAppSetting('list', [], (v) => v.push('b') && 'done');
  expect(value).toEqual(['a', 'b']);
  expect(result).toBe('done');
  expect(JSON.parse(state.stored)).toEqual(['a', 'b']);
  expect(state.queries).toEqual([
    'BEGIN',
    'INSERT IGNORE',
    'SELECT `value`',
    'UPDATE `app_settings`',
    'COMMIT',
  ]);
  expect(state.released).toBe(1);
});

it('writes nothing when the change throws', async () => {
  await expect(
    updateAppSetting('list', [], () => {
      throw new Error('full');
    }),
  ).rejects.toThrow('full');
  expect(state.queries).toEqual(['BEGIN', 'INSERT IGNORE', 'SELECT `value`', 'ROLLBACK']);
  expect(JSON.parse(state.stored)).toEqual(['a']);
  expect(state.released).toBe(1);
});

it('waits for async validation on the locked connection before committing', async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  let started;
  const ready = new Promise((r) => (started = r));
  const writing = updateAppSetting('list', [], async (value, conn) => {
    expect(conn.query).toBeTypeOf('function');
    started();
    await gate;
    value.push('b');
    return 'validated';
  });
  await ready;
  expect(state.queries).toEqual(['BEGIN', 'INSERT IGNORE', 'SELECT `value`']);
  expect(state.released).toBe(0);
  release();
  expect((await writing).result).toBe('validated');
  expect(JSON.parse(state.stored)).toEqual(['a', 'b']);
  expect(state.queries.slice(-2)).toEqual(['UPDATE `app_settings`', 'COMMIT']);
  expect(state.released).toBe(1);
});

it('rolls back when async validation rejects', async () => {
  await expect(
    updateAppSetting('list', [], async (value) => {
      value.push('b');
      await Promise.resolve();
      throw new Error('validation failed');
    }),
  ).rejects.toThrow('validation failed');
  expect(JSON.parse(state.stored)).toEqual(['a']);
  expect(state.queries).toEqual(['BEGIN', 'INSERT IGNORE', 'SELECT `value`', 'ROLLBACK']);
  expect(state.released).toBe(1);
});
