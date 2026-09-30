import { describe, expect, it } from 'vitest';
import { codexUsageDeltas, up } from '../migrations/2026_09_30_000000_backfill_codex_usage_deltas.js';

// A legacy row: the thread's lifetime counters when the turn ended.
const row = (id, at, inputTokens, outputTokens = 0, accountId = 5) => ({
  id,
  jobId: 's',
  accountId,
  at,
  inputTokens,
  outputTokens,
});
const line = (at, text) => ({ jobId: 's', at, text });
const START = 'Starting Codex (gpt-5 (872k), effort high), no time limit (no database server claimed)';
const RESUME =
  'Starting Codex (gpt-5 (872k), effort high), resuming session, no time limit (no database server claimed)';
const REVIEW = 'Starting Codex code review (gpt-5, effort high): feature against main, no time limit';
const inputs = (deltas) => [...deltas.values()].map((u) => u.inputTokens);

describe('codexUsageDeltas', () => {
  it('turns a resumed thread’s lifetime counters into what each turn added, with the session’s cache share', () => {
    const rows = [row(1, 10, 100, 10), row(2, 20, 150, 12), row(3, 30, 180, 17)];
    const log = [line(5, START), line(15, RESUME), line(25, RESUME)];
    expect([...codexUsageDeltas(rows, log, new Map([['s', 0.9]])).entries()]).toEqual([
      [1, { inputTokens: 100, outputTokens: 10, cachedInputTokens: 90 }],
      [2, { inputTokens: 50, outputTokens: 2, cachedInputTokens: 45 }],
      [3, { inputTokens: 30, outputTokens: 5, cachedInputTokens: 27 }],
    ]);
  });

  it('takes a native review’s first total whole, even above the dev thread’s, and resumes from it', () => {
    const rows = [row(1, 10, 300000), row(2, 20, 450000), row(3, 30, 500000)];
    const log = [line(5, START), line(15, REVIEW), line(25, RESUME)];
    expect(inputs(codexUsageDeltas(rows, log))).toEqual([300000, 450000, 50000]);
  });

  it('keeps a compaction row, already a delta, and counts it into the thread the next turn resumes', () => {
    const rows = [row(1, 10, 100000), row(2, 20, 40000), row(3, 30, 190000)];
    const log = [line(5, START), line(15, 'Compacting Codex context…'), line(25, RESUME)];
    expect(inputs(codexUsageDeltas(rows, log))).toEqual([100000, 40000, 50000]);
  });

  it('follows the thread the CLI named when a session goes back to an earlier one', () => {
    const rows = [row(1, 10, 100), row(2, 20, 300), row(3, 30, 160)];
    const log = [
      line(5, START),
      line(6, 'Codex session started: thread A'),
      line(15, REVIEW),
      line(16, 'Codex session started: thread B'),
      line(25, RESUME),
      line(26, 'Codex session started: thread A'),
    ];
    expect(inputs(codexUsageDeltas(rows, log))).toEqual([100, 300, 60]);
  });

  it('falls back to the counters alone for rows logged before the markers, per account', () => {
    const rows = [row(1, 10, 100), row(2, 20, 150), row(3, 25, 70, 0, 6), row(4, 30, 20)];
    expect(inputs(codexUsageDeltas(rows, []))).toEqual([100, 50, 70, 20]);
  });

  it('leaves a row that recorded no counts empty and its cache unknown without a share', () => {
    expect(codexUsageDeltas([row(1, 10, null, null)], [line(5, START)]).get(1)).toEqual({
      inputTokens: null,
      outputTokens: null,
      cachedInputTokens: null,
    });
  });
});

describe('backfill migration', () => {
  // Answers the three reads and records what the transaction wrote.
  function fakePool({ rows = [], events = [], jobs = [] } = {}) {
    const queries = [];
    const updates = [];
    const tx = [];
    const conn = {
      async beginTransaction() {
        tx.push('begin');
      },
      async commit() {
        tx.push('commit');
      },
      async rollback() {
        tx.push('rollback');
      },
      release() {
        tx.push('release');
      },
      async query(sql, params) {
        updates.push(params);
        return [{}];
      },
    };
    return {
      queries,
      updates,
      tx,
      async getConnection() {
        return conn;
      },
      async query(sql) {
        queries.push(sql);
        if (/FROM `turn_usage`/.test(sql)) return [rows];
        if (/FROM `job_events`/.test(sql)) return [events];
        if (/FROM `jobs`/.test(sql)) return [jobs];
        return [[]];
      },
    };
  }

  it('does nothing past the first read when no legacy row is left', async () => {
    const pool = fakePool();
    await up({ context: pool });
    expect(pool.queries).toHaveLength(1);
    expect(pool.tx).toEqual([]);
  });

  it('rewrites each legacy row once, in one transaction, reading only the session’s context numbers', async () => {
    const pool = fakePool({
      rows: [
        { id: '1', job_id: 's', account_id: '5', at: '10', input_tokens: '100', output_tokens: '10' },
        { id: '2', job_id: 's', account_id: '5', at: '20', input_tokens: '150', output_tokens: '12' },
      ],
      events: [
        { job_id: 's', at: '5', data: JSON.stringify({ text: START }) },
        { job_id: 's', at: '15', data: JSON.stringify({ text: RESUME }) },
        { job_id: 's', at: '16', data: 'not json' },
      ],
      jobs: [{ id: 's', source: 'codex', input_tokens: '1000', cached_input_tokens: '800' }],
    });
    await up({ context: pool });
    expect(pool.queries.find((q) => /FROM `jobs`/.test(q))).toMatch(
      /JSON_EXTRACT\(`meta`, '\$\.contextUsage\./,
    );
    expect(pool.tx).toEqual(['begin', 'commit', 'release']);
    expect(pool.updates).toEqual([
      [100, 10, 80, 1],
      [50, 2, 40, 2],
    ]);
  });
});
