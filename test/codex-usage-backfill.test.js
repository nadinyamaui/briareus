import { describe, expect, it, vi } from 'vitest';

// $/M: input 1, cache read 0.1, output 10. At the default 70% cache share a
// million input tokens cost $0.37.
const CATALOG = { openai: { models: { 'gpt-5': { cost: { input: 1, output: 10, cache_read: 0.1 } } } } };
vi.mock('../lib/prices.js', async (importOriginal) => ({
  ...(await importOriginal()),
  loadCatalog: vi.fn(async () => CATALOG),
}));

const { absorbedCorrections, codexResultRewrites, codexUsageDeltas, down, up } =
  await import('../migrations/2026_09_30_000000_backfill_codex_usage_deltas.js');

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

  it('decides a thread reset once, from input, and then books every counter whole', () => {
    // No marker says a new thread began: input falling below the old total
    // does, and output and cache must not be reduced by the old thread's.
    const rows = [row(1, 10, 500000, 20000), row(2, 20, 300000, 25000), row(3, 30, 350000, 26000)];
    expect([...codexUsageDeltas(rows, []).values()]).toEqual([
      { inputTokens: 500000, outputTokens: 20000, cachedInputTokens: null },
      { inputTokens: 300000, outputTokens: 25000, cachedInputTokens: null },
      { inputTokens: 50000, outputTokens: 1000, cachedInputTokens: null },
    ]);
  });

  it('leaves a row that recorded no counts empty and its cache unknown without a share', () => {
    expect(codexUsageDeltas([row(1, 10, null, null)], [line(5, START)]).get(1)).toEqual({
      inputTokens: null,
      outputTokens: null,
      cachedInputTokens: null,
    });
  });
});

describe('codexResultRewrites', () => {
  const footer = (seq, at, inputTokens, outputTokens) => ({
    jobId: 's',
    seq,
    at,
    data: { subtype: 'success', inputTokens, outputTokens },
  });

  it('gives the footer carrying a row’s old counters the row’s new ones, each footer once', () => {
    const rows = [row(1, 10, 100, 10), row(2, 20, 150, 12), row(3, 30, 150, 12)];
    const deltas = new Map([
      [1, { inputTokens: 100, outputTokens: 10, cachedInputTokens: null }],
      [2, { inputTokens: 50, outputTokens: 2, cachedInputTokens: null }],
      [3, { inputTokens: 0, outputTokens: 0, cachedInputTokens: null }],
    ]);
    const events = [footer(1, 11, 100, 10), footer(2, 21, 150, 12), footer(3, 31, 150, 12)];
    expect(codexResultRewrites(rows, deltas, events)).toEqual([
      { jobId: 's', seq: 2, data: JSON.stringify({ subtype: 'success', inputTokens: 50, outputTokens: 2 }) },
      { jobId: 's', seq: 3, data: JSON.stringify({ subtype: 'success', inputTokens: 0, outputTokens: 0 }) },
    ]);
  });

  it('touches no footer whose counters no row held', () => {
    const deltas = new Map([[1, { inputTokens: 50, outputTokens: 2, cachedInputTokens: null }]]);
    expect(codexResultRewrites([row(1, 10, 150, 12)], deltas, [footer(1, 11, 50, 2)])).toEqual([]);
  });
});

describe('absorbedCorrections', () => {
  const legacy = (id, jobId, inputTokens, outputTokens) => ({
    id,
    jobId,
    accountId: null,
    at: id,
    model: 'gpt-5',
    costUsd: null,
    inputTokens,
    outputTokens,
  });

  it('takes the old rows’ estimate less the new rows’ off the session each deleted one folded into', () => {
    const rows = [legacy(1, 'w', 1e6, 0), legacy(2, 'w', 3e6, 1e5), legacy(3, 'kept', 5e6, 0)];
    const deltas = new Map([
      [1, { inputTokens: 1e6, outputTokens: 0, cachedInputTokens: null }],
      [2, { inputTokens: 2e6, outputTokens: 1e5, cachedInputTokens: null }],
      [3, { inputTokens: 4e6, outputTokens: 0, cachedInputTokens: null }],
    ]);
    const out = absorbedCorrections(rows, deltas, new Map([['w', 'orch']]), CATALOG);
    expect([...out.keys()]).toEqual(['orch']);
    expect(out.get('orch')).toBeCloseTo(0.37);
  });

  it('corrects nothing the catalog cannot price', () => {
    const rows = [{ ...legacy(1, 'w', 3e6, 0), model: 'private-model' }];
    const deltas = new Map([[1, { inputTokens: 1e6, outputTokens: 0, cachedInputTokens: null }]]);
    expect(absorbedCorrections(rows, deltas, new Map([['w', 'orch']]), CATALOG).size).toBe(0);
  });
});

describe('backfill migration', () => {
  // Answers the reads and records what the transaction wrote.
  function fakePool({ rows = [], events = [], results = [], jobs = [], present, tasks = [] } = {}) {
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
        updates.push({ sql, params });
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
      async query(sql, params) {
        queries.push(sql);
        if (/FROM `turn_usage`/.test(sql)) return [rows];
        if (/FROM `job_events`/.test(sql)) return [/'result'/.test(sql) ? results : events];
        if (/^SELECT `id` FROM `jobs`/.test(sql)) {
          const alive = present ?? jobs.map((j) => j.id);
          return [params[0].filter((id) => alive.includes(id)).map((id) => ({ id }))];
        }
        if (/FROM `jobs`/.test(sql)) return [jobs];
        if (/FROM `task_sessions`/.test(sql))
          return [
            tasks
              .filter((t) => params[0].includes(t.id))
              .map((t) => ({ ...t, meta: JSON.stringify(t.meta) })),
          ];
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
    // Both rows in one statement, not a round trip each.
    expect(pool.updates).toHaveLength(1);
    expect(pool.updates[0].sql).toMatch(/UPDATE `turn_usage`/);
    expect(pool.updates[0].params).toEqual([1, 100, 2, 50, 1, 10, 2, 2, 1, 80, 2, 40, [1, 2]]);
  });

  it('rewrites the old footers, and takes the inflated estimate off the parent of a deleted worker', async () => {
    const pool = fakePool({
      rows: [
        {
          id: '1',
          job_id: 'w',
          account_id: null,
          model: 'gpt-5',
          at: '10',
          input_tokens: '1000000',
          output_tokens: '0',
        },
        {
          id: '2',
          job_id: 'w',
          account_id: null,
          model: 'gpt-5',
          at: '20',
          input_tokens: '3000000',
          output_tokens: '0',
        },
      ],
      events: [],
      results: [
        { job_id: 'w', seq: '7', at: '21', data: JSON.stringify({ inputTokens: 3000000, outputTokens: 0 }) },
      ],
      jobs: [{ id: 'orch' }],
      // The worker's parent is gone too; its estimate went on up to the orchestrator.
      tasks: [
        { id: 'w', meta: { id: 'w', parentId: 'fix' } },
        { id: 'fix', meta: { id: 'fix', parentId: 'orch' } },
      ],
    });
    await up({ context: pool });
    const [ledger, footers, parent] = pool.updates;
    expect(ledger.params.slice(0, 4)).toEqual([1, 1000000, 2, 2000000]);
    expect(footers.sql).toMatch(/UPDATE `job_events`/);
    expect(footers.params).toEqual([
      'w',
      7,
      JSON.stringify({ inputTokens: 2000000, outputTokens: 0 }),
      [['w', 7]],
    ]);
    expect(parent.sql).toMatch(/absorbedEstimatedCostUsd/);
    expect(parent.params[0]).toBeCloseTo(0.37);
    expect(parent.params[1]).toBe('orch');
    expect(pool.updates).toHaveLength(3);
  });

  it('refuses to roll back, so a re-run cannot subtract from rows that are already deltas', async () => {
    await expect(down()).rejects.toThrow(/cannot be rolled back/);
  });
});
