import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ home: '', rows: [], query: vi.fn(), end: vi.fn() }));
vi.mock('node:os', async (original) => ({
  default: { ...(await original()).default, homedir: () => mocks.home },
}));
vi.mock('mysql2/promise', () => ({
  default: { createConnection: async () => ({ query: mocks.query, end: mocks.end }) },
}));
vi.mock('../lib/prices.js', () => ({
  loadCatalog: async () => ({}),
  withEstimates: (rows) => rows,
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
    { repo: 'acme/app', model: 'gpt-6.1-sol (872k)', at: start + 1000 + delay, ...tokens, ...row },
  ];
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
  mocks.query.mockImplementation(async () => [mocks.rows]);
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
