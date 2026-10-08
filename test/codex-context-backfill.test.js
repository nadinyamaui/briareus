import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  home: '',
  rows: [],
  jobs: [],
  tasks: [],
  query: vi.fn(),
  end: vi.fn(),
  beginTransaction: vi.fn(),
  commit: vi.fn(),
  rollback: vi.fn(),
  affected: 1,
  connections: [],
}));
vi.mock('node:os', async (original) => ({
  default: { ...(await original()).default, homedir: () => mocks.home },
}));
vi.mock('mysql2/promise', () => ({
  default: {
    createConnection: async () => ({
      query: mocks.query,
      end: mocks.end,
      beginTransaction: mocks.beginTransaction,
      commit: mocks.commit,
      rollback: mocks.rollback,
    }),
  },
}));
vi.mock('../lib/prices.js', async (importOriginal) => ({
  ...(await importOriginal()),
  loadCatalog: async () => ({
    openai: { models: { 'gpt-6.1-sol': { cost: { input: 1.25, cache_read: 0.125, output: 10 } } } },
  }),
}));

const tokens = { input_tokens: 300000, cached_input_tokens: 280000, output_tokens: 1000 };
const start = Date.parse('2026-10-08T10:00:00Z');
const event = (offset, type, payload) => ({
  timestamp: new Date(start + offset).toISOString(),
  type,
  payload,
});

// Run the actual dry-run entry point against isolated rollouts and ledger rows.
async function run({
  cwd = '/work/acme__app__2',
  terminal = 'turn_aborted',
  delay = 360000,
  row = {},
  extra = [],
  otherRows = [],
  apply = false,
  reverse = false,
  serverStopped = true,
} = {}) {
  const events = [
    event(0, 'session_meta', { cwd }),
    event(0, 'event_msg', { type: 'task_started' }),
    event(0, 'turn_context', { model: 'gpt-6.1-sol' }),
    event(1000, 'event_msg', {
      type: 'token_count',
      info: { total_token_usage: tokens, last_token_usage: tokens },
    }),
    ...(terminal ? [event(1000 + delay, 'event_msg', { type: terminal })] : []),
    ...extra,
  ];
  fs.writeFileSync(
    path.join(mocks.home, '.codex/sessions/rollout-test.jsonl'),
    events.map((e) => JSON.stringify(e)).join('\n'),
  );
  mocks.rows = [
    {
      id: 1,
      job_id: 'deleted',
      provider: 'codex',
      cost_usd: null,
      repo: 'acme/app',
      model: 'gpt-6.1-sol (872k)',
      at: start + 1000 + delay,
      ...tokens,
      ...row,
    },
  ];
  mocks.rows.push(...otherRows);
  if (reverse) mocks.rows.reverse();
  if (apply) {
    process.argv.push('--apply');
    if (serverStopped) process.argv.push('--server-stopped');
  }
  await import('../scripts/backfill-codex-context.js');
  return console.log.mock.calls[0][0];
}

beforeEach(() => {
  vi.resetModules();
  mocks.home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-context-test-'));
  fs.mkdirSync(path.join(mocks.home, '.codex/sessions'), { recursive: true });
  const envFile = path.join(mocks.home, '.env');
  fs.writeFileSync(envFile, 'DB_HOST=unused\n');
  vi.spyOn(process, 'argv', 'get').mockReturnValue(['node', 'backfill', `--env=${envFile}`]);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  mocks.jobs = [];
  mocks.tasks = [];
  mocks.affected = 1;
  mocks.connections = [];
  vi.clearAllMocks();
  mocks.query.mockImplementation(async (sql) => {
    if (sql.includes('information_schema.PROCESSLIST')) return [mocks.connections];
    if (sql.includes('FROM turn_usage')) return [mocks.rows];
    if (sql.includes('FROM jobs')) return [mocks.jobs];
    if (sql.includes('FROM task_sessions')) return [mocks.tasks];
    if (sql.startsWith('UPDATE jobs')) return [{ affectedRows: mocks.affected }];
    return [{ affectedRows: 1 }];
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(mocks.home, { recursive: true, force: true });
});

describe('Codex context backfill matching', () => {
  it('recovers a stopped long-context turn after a six-minute tool wait', async () => {
    expect(await run()).toMatchObject({ matched: 1, longTurns: 1, ambiguous: 0 });
  });

  it('uses the completed turn closing time too', async () => {
    expect(await run({ terminal: 'task_complete' })).toMatchObject({ matched: 1, longTurns: 1 });
  });

  it('retains the close-time window, model and all three counter guards', async () => {
    for (const row of [
      { at: start + 1000 + 360000 + 300001 },
      { at: start + 1000 + 360000 - 5001 },
      { model: 'other-model' },
      { input_tokens: 300001 },
      { cached_input_tokens: 280001 },
      { output_tokens: 1001 },
    ]) {
      vi.resetModules();
      console.log.mockClear();
      expect(await run({ row })).toMatchObject({ matched: 0 });
    }
  });

  it.each([
    '/work/acme__app-admin__2',
    '/work/other__app__2',
    '/work/prefix-acme__app__2',
    '/work/acme__app__2suffix',
  ])('rejects a different repository at %s despite identical counters and closing time', async (cwd) => {
    expect(await run({ cwd })).toMatchObject({ matched: 0 });
  });

  it.each(['/work/acme__app', '/work/ACME__APP__12/src'])(
    'accepts the full repository at %s',
    async (cwd) => {
      expect(await run({ cwd })).toMatchObject({ matched: 1 });
    },
  );

  it('does not associate an unfinished turn with a later task start', async () => {
    expect(
      await run({ terminal: null, extra: [event(700000, 'event_msg', { type: 'task_started' })] }),
    ).toMatchObject({ matched: 0 });
  });
});

const competitor = {
  id: 2,
  job_id: 'other',
  provider: 'codex',
  cost_usd: null,
  repo: 'acme/app',
  model: 'gpt-6.1-sol',
  at: start + 361001,
  ...tokens,
  long_input_tokens: 0,
  long_cached_input_tokens: 0,
  long_output_tokens: 0,
};
const parentMeta = { absorbedEstimatedCostUsd: 0.07, absorbedEstimatedTurns: 1, unrelated: 'preserved' };
function snapshot(meta = parentMeta) {
  mocks.jobs = [{ id: 'parent', meta: JSON.stringify(meta) }];
  mocks.tasks = [
    { id: 'deleted', meta: JSON.stringify({ parentId: 'middle' }) },
    { id: 'middle', meta: JSON.stringify({ parentId: 'parent' }) },
  ];
}
describe('Codex backfill ownership and absorbed snapshots', () => {
  it('refuses apply without acknowledging the stop/backfill/restart workflow', async () => {
    snapshot();
    await expect(run({ apply: true, serverStopped: false })).rejects.toThrow(
      '--apply requires --server-stopped',
    );
    expect(mocks.query).not.toHaveBeenCalled();
    expect(mocks.beginTransaction).not.toHaveBeenCalled();
  });
  it('refuses apply while another database connection remains, even with acknowledgement', async () => {
    snapshot();
    mocks.connections = [{ ID: 42 }];
    await expect(run({ apply: true })).rejects.toThrow('Other connections to this database remain');
    expect(mocks.query).toHaveBeenCalledOnce();
    expect(mocks.beginTransaction).not.toHaveBeenCalled();
    expect(mocks.commit).not.toHaveBeenCalled();
    expect(mocks.end).toHaveBeenCalledOnce();
  });
  it.each([null, 1])('rejects competing owners including reported rows (cost %s)', async (cost) => {
    expect(await run({ otherRows: [{ ...competitor, cost_usd: cost }] })).toMatchObject({
      matched: 0,
      ambiguous: cost == null ? 2 : 1,
    });
  });
  it('counts an already-correct row as a competing owner', async () => {
    expect(
      await run({
        row: { long_input_tokens: 300000, long_cached_input_tokens: 280000, long_output_tokens: 1000 },
        otherRows: [competitor],
      }),
    ).toMatchObject({ matched: 0, ambiguous: 2 });
  });
  it('updates a proven nested absorbed snapshot in the ledger transaction', async () => {
    snapshot();
    await run({ apply: true });
    const call = mocks.query.mock.calls.find(([sql]) => sql.startsWith('UPDATE jobs'));
    expect(call[1][0]).toBeCloseTo(0.1375);
    expect(call[1].slice(1)).toEqual(['parent', JSON.stringify(parentMeta)]);
    expect(mocks.beginTransaction).toHaveBeenCalledOnce();
    expect(mocks.commit).toHaveBeenCalledOnce();
    expect(mocks.rollback).not.toHaveBeenCalled();
    expect(mocks.query.mock.calls.find(([sql]) => sql.includes('FROM turn_usage'))[0]).toContain(
      'FOR UPDATE',
    );
  });
  it.each([{ absorbedEstimatedCostUsd: 0.08 }, { absorbedEstimatedTurns: 2 }, { absorbedUnpricedTurns: 1 }])(
    'leaves an unproven snapshot unchanged: %j',
    async (override) => {
      snapshot({ ...parentMeta, ...override });
      await run({ apply: true });
      expect(mocks.query.mock.calls.some(([sql]) => sql.startsWith('UPDATE jobs'))).toBe(false);
    },
  );
  it('requires complete retained history, including unchanged non-Codex estimates', async () => {
    snapshot();
    await run({
      apply: true,
      otherRows: [{ ...competitor, provider: 'other', job_id: 'deleted', model: 'unknown' }],
    });
    expect(mocks.query.mock.calls.some(([sql]) => sql.startsWith('UPDATE jobs'))).toBe(false);
  });
  it('never changes a living session snapshot', async () => {
    snapshot();
    await run({ apply: true, row: { job_id: 'parent' } });
    expect(mocks.query.mock.calls.some(([sql]) => sql.startsWith('UPDATE jobs'))).toBe(false);
  });
  it('rolls back both writes if the guarded snapshot write fails', async () => {
    snapshot();
    mocks.affected = 0;
    await expect(run({ apply: true })).rejects.toThrow('Concurrent change on absorbed snapshot parent');
    expect(mocks.query.mock.calls.some(([sql]) => sql.startsWith('UPDATE turn_usage'))).toBe(true);
    expect(mocks.commit).not.toHaveBeenCalled();
    expect(mocks.rollback).toHaveBeenCalled();
  });
  it('does not reconcile or write again after tiers were applied', async () => {
    snapshot({ ...parentMeta, absorbedEstimatedCostUsd: 0.1375 });
    expect(
      await run({
        apply: true,
        row: { long_input_tokens: 300000, long_cached_input_tokens: 280000, long_output_tokens: 1000 },
      }),
    ).toMatchObject({ matched: 0 });
    expect(mocks.query.mock.calls.some(([sql]) => sql.startsWith('UPDATE'))).toBe(false);
  });
});

describe('complete absorbed history guards', () => {
  it('rejects competing assignments independently of ledger order', async () => {
    expect(await run({ otherRows: [competitor], reverse: true })).toMatchObject({ matched: 0, ambiguous: 2 });
  });
  it('includes unchanged estimated turns in the proven snapshot', async () => {
    snapshot({ ...parentMeta, absorbedEstimatedCostUsd: 0.14, absorbedEstimatedTurns: 2 });
    await run({ apply: true, otherRows: [{ ...competitor, job_id: 'deleted', at: start + 900000 }] });
    const call = mocks.query.mock.calls.find(([sql]) => sql.startsWith('UPDATE jobs'));
    expect(call[1][0]).toBeCloseTo(0.2075);
  });
  it('preserves nullable counters while reproducing snapshots', async () => {
    snapshot({ ...parentMeta, absorbedEstimatedCostUsd: 0.087, absorbedEstimatedTurns: 2 });
    await run({
      apply: true,
      otherRows: [
        {
          ...competitor,
          job_id: 'deleted',
          at: start + 900000,
          input_tokens: 100000,
          cached_input_tokens: null,
          output_tokens: 0,
        },
      ],
    });
    const call = mocks.query.mock.calls.find(([sql]) => sql.startsWith('UPDATE jobs'));
    expect(call[1][0]).toBeCloseTo(0.1545);
  });
  it('leaves missing ancestry alone and reports the unproven snapshot', async () => {
    snapshot();
    mocks.tasks = [];
    await run({ apply: true });
    expect(mocks.query.mock.calls.some(([sql]) => sql.startsWith('UPDATE jobs'))).toBe(false);
  });
  it('makes no writes in dry-run mode', async () => {
    snapshot();
    await run();
    expect(console.log.mock.calls[2][0]).toMatchObject({ absorbedReconciled: 1 });
    expect(mocks.beginTransaction).not.toHaveBeenCalled();
    expect(mocks.query.mock.calls.some(([sql]) => sql.startsWith('UPDATE'))).toBe(false);
  });
});
