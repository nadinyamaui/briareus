import fs from 'node:fs';
import readline from 'node:readline';

// The ledger estimates API list-price equivalents, not subscription invoices.
// https://developers.openai.com/api/docs/models/gpt-6.1-sol
export const LONG_CONTEXT_THRESHOLD = 272000;
const fields = ['input_tokens', 'cached_input_tokens', 'output_tokens'];

// Repeated token_count notifications have identical lifetime counters. Only
// advancing counters represent a new request; gaps cannot establish its tier.
export function codexPricingCounter(baseline = {}) {
  let previous = fields.map((key) => baseline[key] ?? 0);
  const total = [0, 0, 0];
  const long = [0, 0, 0];
  let valid = true;
  return {
    feed(info) {
      if (!info) return;
      const next = fields.map((key) => info.total_token_usage?.[key]);
      const last = fields.map((key) => info.last_token_usage?.[key]);
      if (next.every((n, i) => n === previous[i])) return;
      const delta = next.map((n, i) => n - previous[i]);
      if (
        !next.every((n) => Number.isSafeInteger(n) && n >= 0) ||
        !last.every((n, i) => Number.isSafeInteger(n) && n >= 0 && n === delta[i]) ||
        last[1] > last[0]
      )
        valid = false;
      if (valid) {
        delta.forEach((n, i) => {
          total[i] += n;
        });
        if (last[0] > LONG_CONTEXT_THRESHOLD)
          delta.forEach((n, i) => {
            long[i] += n;
          });
      }
      previous = next;
    },
    result(expected) {
      if (!valid || !fields.every((key, i) => total[i] === expected[key])) return null;
      return { longInputTokens: long[0], longCachedInputTokens: long[1], longOutputTokens: long[2] };
    },
  };
}

// Read only this process's appended part of the rollout, including stopped
// turns. Missing/partial recordings retain the existing estimate.
export async function codexPricingFromRollout(file, start, baseline, expected) {
  const counter = codexPricingCounter(baseline);
  const input = fs.createReadStream(file, { start });
  const lines = readline.createInterface({
    input,
    crlfDelay: Infinity,
  });
  try {
    for await (const line of lines) {
      if (!line.includes('"token_count"')) continue;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        return null;
      }
      const info = event.payload?.info;
      if (event.payload?.type !== 'token_count' || !info) continue;
      // If the path was not cached at spawn, discard the already-booked
      // prefix while still verifying every advancing request of this turn.
      if (!start && fields.every((key) => info.total_token_usage?.[key] <= (baseline[key] ?? 0))) continue;
      counter.feed(info);
    }
    return counter.result(expected);
  } finally {
    lines.close();
    input.destroy();
  }
}
