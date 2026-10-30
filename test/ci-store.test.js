import { describe, expect, it, vi } from 'vitest';
import { ciCheck, ciRunId, ciRunner, createCiStore } from '../lib/ci-store.js';

describe('CI normalization', () => {
  it('measures execution time and keeps absent or reversed timestamps unknown', () => {
    const raw = { id: 1, name: 'build', head_sha: 'abc', status: 'completed', conclusion: 'success' };
    const hints = { branch: 'main', observedAt: 2000 };
    expect(ciCheck(raw, hints)).toMatchObject({ branch: 'main', duration_ms: null, run_at: 2000 });
    expect(
      ciCheck({ ...raw, started_at: '2026-10-28T01:00:00Z', completed_at: '2026-10-28T01:01:30Z' }, hints),
    ).toMatchObject({ duration_ms: 90000 });
    expect(
      ciCheck({ ...raw, started_at: '2026-10-28T01:01:00Z', completed_at: '2026-10-28T01:00:00Z' }, hints)
        .duration_ms,
    ).toBeNull();
    expect(ciCheck({ ...raw, started_at: 'invalid' }, hints).started_at).toBeNull();
  });

  it('coalesces case-insensitive legacy contexts while preserving names and check-run identities', () => {
    const pending = ciCheck({ id: 1, context: 'deploy', state: 'pending' }, { sha: 'abc' });
    const success = ciCheck({ id: 2, context: 'deploy', state: 'success' }, { sha: 'abc' });
    expect(pending.external_key).toBe(success.external_key);
    expect(pending).toMatchObject({ status: 'in_progress', conclusion: null, duration_ms: null });
    expect(success).toMatchObject({ status: 'completed', conclusion: 'success' });
    expect(ciCheck({ id: 3, context: 'Deploy', state: 'success' }, { sha: 'abc' }).external_key).toBe(
      success.external_key,
    );
    expect(ciCheck({ id: 3, context: 'Deploy', state: 'success' }, { sha: 'abc' }).name).toBe('Deploy');
    expect(ciCheck({ id: 2, context: 'deploy', state: 'success' }, { sha: 'other' }).external_key).not.toBe(
      success.external_key,
    );
    expect(ciCheck({ id: 1, name: 'Deploy', head_sha: 'abc' }).external_key).toBe('1');
    expect(ciCheck({ id: 2, name: 'deploy', head_sha: 'abc' }).external_key).toBe('2');
    expect(() => ciCheck({ id: 1, name: 'build' })).toThrow('Incomplete CI check');
  });
});

describe('CI runners', () => {
  it('records a runner once assigned, and a completed job that never got one', () => {
    const job = { id: 7, run_id: 3, status: 'in_progress', runner_name: 'ubuntu-eu-1' };
    expect(ciRunner({ ...job, runner_group_name: 'Ubuntu EU', labels: ['self-hosted', 1] }, 50)).toEqual({
      job_id: '7',
      run_id: 3,
      runner_name: 'ubuntu-eu-1',
      runner_group: 'Ubuntu EU',
      runner_labels: '["self-hosted"]',
      recorded_at: 50,
    });
    expect(ciRunner({ id: 7, status: 'queued', runner_name: null })).toBeNull();
    expect(ciRunner({ id: 7, status: 'completed', runner_name: null }, 50)).toMatchObject({
      runner_name: null,
      runner_group: null,
      runner_labels: null,
    });
    expect(() => ciRunner({ status: 'completed' })).toThrow('Incomplete CI job');
  });

  it('finds the Actions run behind a check from its details URL', () => {
    expect(ciRunId('https://github.com/acme/shop/actions/runs/123/job/456')).toBe('123');
    expect(ciRunId('https://ci.example.com/build/1')).toBeNull();
    expect(ciRunId(null)).toBeNull();
  });
});

describe('CI store boundaries', () => {
  const connection = () => ({
    beginTransaction: vi.fn(async () => {}),
    commit: vi.fn(async () => {}),
    rollback: vi.fn(async () => {}),
    release: vi.fn(),
    query: vi.fn(),
  });
  const filters = { kind: 'check_run', repos: ['acme/shop'], since: 0, until: 10000 };

  it('releases and rolls back failed writes and failed snapshot reads', async () => {
    const c = connection();
    c.query.mockRejectedValue(new Error('database offline'));
    const store = createCiStore({ connection: async () => c });
    await expect(
      store.save('acme/shop', [{ id: 1, name: 'CI', head_sha: 'abc', status: 'queued' }]),
    ).rejects.toThrow('database offline');
    expect(c.rollback).toHaveBeenCalledTimes(1);
    expect(c.release).toHaveBeenCalledTimes(1);
    await expect(store.stats(filters)).rejects.toThrow('database offline');
    expect(c.rollback).toHaveBeenCalledTimes(2);
    expect(c.release).toHaveBeenCalledTimes(2);
    await expect(store.runs(filters)).rejects.toThrow('database offline');
    expect(c.release).toHaveBeenCalledTimes(3);
    expect(c.commit).not.toHaveBeenCalled();
  });

  it('converts SQL decimal metrics to JSON numbers and dates while preserving unknown timing', async () => {
    const c = connection();
    const metrics = {
      total: 3,
      pending: '1',
      succeeded: '1',
      failed: '1',
      avgDurationMs: null,
      maxDurationMs: null,
      totalDurationMs: '0',
      lastObservedAt: '2000',
    };
    c.query
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([[metrics]])
      .mockResolvedValueOnce([[{ ...metrics, day: 0 }]])
      .mockResolvedValueOnce([[{ ...metrics, repo: 'acme/shop' }]])
      .mockResolvedValueOnce([[{ ...metrics, name: 'CI', app: null }]])
      .mockResolvedValueOnce([[{ ...metrics, runnerGroup: 'Ubuntu EU', pricedDurationMs: '0', cost: null }]])
      .mockResolvedValueOnce([
        [{ ...metrics, runnerGroup: null, runnerName: null, totalDurationMs: '9000', cost: '0.5000' }],
      ]);
    const store = createCiStore({ connection: async () => c });
    const result = await store.stats({
      ...filters,
      branch: 'main',
      name: 'CI',
      status: 'completed',
      conclusion: 'success',
    });
    expect(result).toMatchObject({
      totals: { total: 3, successRate: 0.5, avgDurationMs: null, lastObservedAt: 2000 },
      daily: [{ day: '1970-01-01', total: 3 }],
      repositories: [{ repo: 'acme/shop' }],
      checks: [{ name: 'CI', app: null }],
      runnerGroups: [{ runnerGroup: 'Ubuntu EU', cost: null, unpricedDurationMs: 0 }],
      runners: [{ runnerGroup: null, runnerName: null, cost: 0.5, unpricedDurationMs: 9000 }],
    });
    expect(c.commit).toHaveBeenCalledTimes(1);
    expect(c.release).toHaveBeenCalledTimes(1);
  });

  it('returns numeric timestamps and paginates runs without inventing a missing duration', async () => {
    const c = connection();
    c.query.mockResolvedValue([
      [
        {
          github_id: '123',
          repo: 'acme/shop',
          started_at: '1000',
          completed_at: '2000',
          duration_ms: '1800000',
          run_at: '1000',
          observed_at: '2000',
          runner_name: 'ubuntu-eu-1',
          runner_group: 'Ubuntu EU',
          runner_labels: '["self-hosted"]',
          rate: '0.2',
        },
        { github_id: '124' },
      ],
    ]);
    const store = createCiStore({ connection: async () => c });
    expect(
      await store.runs(
        { ...filters, runnerGroup: 'Ubuntu EU' },
        { limit: 1, offset: 5, rates: { 'Ubuntu EU': 0.2 } },
      ),
    ).toMatchObject({
      runs: [
        {
          id: '123',
          startedAt: 1000,
          completedAt: 2000,
          durationMs: 1800000,
          runner: { name: 'ubuntu-eu-1', group: 'Ubuntu EU', labels: ['self-hosted'] },
          cost: 0.1,
        },
      ],
      nextOffset: 6,
    });
    // Rates bind ahead of the filters, in the order they appear in the SQL.
    const [sql, values] = c.query.mock.calls[0];
    expect(sql).toContain('CASE r.runner_group WHEN ? THEN ? END');
    expect(values).toEqual(['Ubuntu EU', 0.2, 'check_run', 0, 10000, 'acme/shop', 'Ubuntu EU', 2, 5]);
    c.query.mockResolvedValue([
      [
        {
          github_id: '124',
          started_at: null,
          completed_at: null,
          duration_ms: null,
          run_at: '3000',
          observed_at: '4000',
        },
      ],
    ]);
    expect(await store.runs({ ...filters, repos: [] })).toMatchObject({
      runs: [{ id: '124', startedAt: null, completedAt: null, durationMs: null, runner: null, cost: null }],
      nextOffset: null,
    });
    c.query.mockResolvedValue([[]]);
    expect(await store.pendingCommits('acme/shop')).toEqual([]);
  });
});
