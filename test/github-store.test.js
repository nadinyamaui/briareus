import { describe, it, expect, vi } from 'vitest';

vi.mock('../lib/db.js', () => ({ githubStoreConnection: vi.fn() }));
const { createGithubStore } = await import('../lib/github-store.js');

// A fake connection whose status update fails with the queued errors, one per transaction.
function fakeConnections(failures) {
  const log = [];
  const connection = async () => {
    const failure = failures.shift();
    return {
      beginTransaction: async () => log.push('begin'),
      commit: async () => log.push('commit'),
      rollback: async () => log.push('rollback'),
      release: () => log.push('release'),
      query: async (sql) => {
        if (/^SELECT \* FROM github_repositories/.test(sql)) return [[{ id: 7 }]];
        if (/^UPDATE github_repositories/.test(sql) && failure) throw failure;
        return [{}];
      },
    };
  };
  return { log, connection };
}

const deadlock = () => Object.assign(new Error('Deadlock found'), { errno: 1213, code: 'ER_LOCK_DEADLOCK' });

describe('GitHub store transactions', () => {
  it('runs a transaction InnoDB aborted for a deadlock again on a fresh connection', async () => {
    const { log, connection } = fakeConnections([deadlock()]);
    await createGithubStore({ connection }).finishSync('acme/app', 1000);
    expect(log).toEqual(['begin', 'rollback', 'release', 'begin', 'commit', 'release']);
  });

  it('gives up after three deadlocks', async () => {
    const { log, connection } = fakeConnections([deadlock(), deadlock(), deadlock(), deadlock()]);
    await expect(createGithubStore({ connection }).finishSync('acme/app', 1000)).rejects.toThrow(/Deadlock/);
    expect(log.filter((entry) => entry === 'begin')).toHaveLength(3);
    expect(log.filter((entry) => entry === 'release')).toHaveLength(3);
  });

  it('does not repeat a transaction that failed for any other reason', async () => {
    const { log, connection } = fakeConnections([new Error('Data too long')]);
    await expect(createGithubStore({ connection }).finishSync('acme/app', 1000)).rejects.toThrow(/too long/);
    expect(log).toEqual(['begin', 'rollback', 'release']);
  });
});
