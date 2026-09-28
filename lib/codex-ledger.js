// Older Codex rows contain the CLI's lifetime thread counters. Convert them
// on read so historical usage is repaired without rewriting the ledger. The
// new rows are explicitly marked as deltas and pass through untouched.
export function normalizeCodexLedgerRows(rows, history, cacheShares = new Map()) {
  const previous = new Map();
  const corrected = new Map();
  for (const row of history) {
    const key = `${row.jobId}\n${row.accountId ?? ''}`;
    const prior = previous.get(key);
    const inputTokens = delta(row.inputTokens, prior?.inputTokens);
    const outputTokens = delta(row.outputTokens, prior?.outputTokens);
    previous.set(key, row);
    const share = cacheShares.get(row.jobId);
    corrected.set(row.id, {
      inputTokens,
      outputTokens,
      cachedInputTokens:
        inputTokens != null && Number.isFinite(share)
          ? Math.round(inputTokens * Math.max(0, Math.min(1, share)))
          : null,
    });
  }
  return rows.map((row) => {
    const usage = row.provider === 'codex' && !row.usageIsDelta && corrected.get(row.id);
    return usage ? { ...row, ...usage } : row;
  });
}

function delta(current, prior) {
  if (current == null) return null;
  // A new Codex thread resets its counters; its first row is already a delta.
  return prior != null && current >= prior ? current - prior : current;
}
