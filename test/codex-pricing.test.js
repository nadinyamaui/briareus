import { it, expect } from 'vitest';
import { codexPricingCounter } from '../lib/codex-pricing.js';

const usage = (input, cached, output) => ({
  input_tokens: input,
  cached_input_tokens: cached,
  output_tokens: output,
});

it('counts only requests above 272k and ignores duplicate lifetime notifications', () => {
  const c = codexPricingCounter(usage(100, 80, 10));
  const short = {
    total_token_usage: usage(272100, 200080, 1010),
    last_token_usage: usage(272000, 200000, 1000),
  };
  c.feed(short);
  c.feed(short);
  c.feed({ total_token_usage: usage(572101, 480080, 3010), last_token_usage: usage(300001, 280000, 2000) });
  expect(c.result(usage(572001, 480000, 3000))).toEqual({
    longInputTokens: 300001,
    longCachedInputTokens: 280000,
    longOutputTokens: 2000,
  });
});

it('does not invent a tier for missing requests, reset counters, or mismatched ledger totals', () => {
  for (const total of [usage(400000, 350000, 200), usage(-1, 0, 1)]) {
    const c = codexPricingCounter();
    c.feed({ total_token_usage: total, last_token_usage: usage(300000, 280000, 100) });
    expect(c.result(total)).toBeNull();
  }
  const c = codexPricingCounter();
  c.feed({ total_token_usage: usage(300000, 280000, 100), last_token_usage: usage(300000, 280000, 100) });
  expect(c.result(usage(600000, 560000, 200))).toBeNull();
});
