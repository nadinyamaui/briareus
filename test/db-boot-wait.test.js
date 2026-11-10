import { beforeEach, expect, it, vi } from 'vitest';

// The boot wait: a database still starting (a reboot raced MySQL) is retried
// until it answers or the bound runs out; a wrong one fails at once.
const state = vi.hoisted(() => ({ failures: [], attempts: 0, bootWaitMs: 60000 }));

vi.mock('../lib/config.js', () => ({
  getConfig: () => ({
    db: { host: 'h', port: 3306, database: 'd', user: 'u', password: 'p', bootWaitMs: state.bootWaitMs },
  }),
}));
vi.mock('../lib/migrator.js', () => ({
  ensureDatabase: async () => {
    state.attempts++;
    const failure = state.failures.shift();
    if (failure) throw Object.assign(new Error(failure), { code: failure });
  },
  runMigrations: async () => {},
}));
vi.mock('mysql2/promise', () => ({ default: { createPool: () => ({ end: async () => {} }) } }));

let waitForDb;
beforeEach(async () => {
  vi.resetModules();
  ({ waitForDb } = await import('../lib/db.js'));
  state.attempts = 0;
  state.bootWaitMs = 60000;
});

const log = { error: vi.fn() };

it('waits out a database that is still starting', async () => {
  state.failures = ['ECONNREFUSED', 'ECONNREFUSED', 'PROTOCOL_CONNECTION_LOST'];
  const sleep = vi.fn(async () => {});
  await expect(waitForDb({ sleep, log })).resolves.toBeTruthy();
  expect(state.attempts).toBe(4);
  expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([1000, 2000, 4000]);
});

it('fails at once on an error that retrying cannot fix', async () => {
  state.failures = ['ER_ACCESS_DENIED_ERROR'];
  const sleep = vi.fn(async () => {});
  await expect(waitForDb({ sleep, log })).rejects.toThrow('ER_ACCESS_DENIED_ERROR');
  expect(sleep).not.toHaveBeenCalled();
});

it('gives up once the bound runs out, so the server still comes up', async () => {
  state.bootWaitMs = 0;
  state.failures = ['ECONNREFUSED', 'ECONNREFUSED'];
  const sleep = vi.fn(async () => {});
  await expect(waitForDb({ sleep, log })).rejects.toThrow('ECONNREFUSED');
  expect(state.attempts).toBe(1);
});
