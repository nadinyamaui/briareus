import { describe, expect, it } from 'vitest';
import { normalizeCodexLedgerRows } from '../lib/codex-ledger.js';

describe('normalizeCodexLedgerRows', () => {
  it('repairs old lifetime rows, including a date range that starts mid-session', () => {
    const history = [
      { id: 1, jobId: 's', accountId: 5, inputTokens: 100, outputTokens: 10 },
      { id: 2, jobId: 's', accountId: 5, inputTokens: 150, outputTokens: 12 },
      { id: 3, jobId: 's', accountId: 5, inputTokens: 180, outputTokens: 17 },
    ];
    const rows = [
      { ...history[2], provider: 'codex', usageIsDelta: false },
      {
        id: 4,
        jobId: 's',
        provider: 'codex',
        usageIsDelta: true,
        inputTokens: 20,
        cachedInputTokens: 18,
        outputTokens: 2,
      },
    ];
    expect(normalizeCodexLedgerRows(rows, history, new Map([['s', 0.9]]))).toEqual([
      { ...rows[0], inputTokens: 30, cachedInputTokens: 27, outputTokens: 5 },
      rows[1],
    ]);
  });

  it('starts again when a thread counter resets and leaves unknown cache shares estimated', () => {
    const history = [
      { id: 1, jobId: 's', accountId: 5, inputTokens: 100, outputTokens: 10 },
      { id: 2, jobId: 's', accountId: 5, inputTokens: 20, outputTokens: 2 },
    ];
    expect(
      normalizeCodexLedgerRows([{ ...history[1], provider: 'codex', usageIsDelta: false }], history)[0],
    ).toMatchObject({ inputTokens: 20, outputTokens: 2, cachedInputTokens: null });
  });
});
