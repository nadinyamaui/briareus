import { describe, it, expect, vi, beforeEach } from 'vitest';

const state = vi.hoisted(() => ({ rows: [], usage: {} }));

vi.mock('../lib/providerstore.js', () => ({
  providerGroup: (p) => state.rows.filter((r) => r.binary === p.binary && !r.apiKey),
}));

vi.mock('../lib/providers.js', () => ({
  claudeHomeDir: (p) => `/claude-${p.id}`,
  codexHomeDir: (p) => `/codex-${p.id}`,
  grokHomeDir: (p) => `/grok-${p.id}`,
  claudeUsage: vi.fn(async (dir) => state.usage[dir] ?? null),
  codexUsage: vi.fn(async (dir) => state.usage[dir] ?? null),
  grokUsage: vi.fn(async (dir) => state.usage[dir] ?? null),
  zaiUsage: vi.fn(async () => state.usage.zai ?? null),
}));

import * as providers from '../lib/providers.js';
import {
  pickLeastUsedProvider,
  providerLoad,
  providerUsage,
  readProviderUsage,
  forgetProviderUsage,
  cachedProviderUsage,
  rememberProviderAuth,
  cachedProviderAuth,
  zaiHost,
  AUTH_TTL_MS,
} from '../lib/balancer.js';

const windows = (...pcts) => ({ windows: pcts.map((usedPct, i) => ({ usedPct, short: i ? 'wk' : '5h' })) });
const row = (id, over = {}) => ({ id, binary: 'claude', baseUrl: '', apiKey: '', sortOrder: id, ...over });

beforeEach(() => {
  state.rows = [row(1), row(2), row(3)];
  state.usage = {};
  forgetProviderUsage();
  vi.clearAllMocks();
});

describe('providerLoad', () => {
  it('is how spent the window a turn actually runs into is', () => {
    expect(providerLoad(windows(80, 5))).toBe(80);
    // A week at 70% is not a session window at 70%: there are hours of work
    // left before it is the limit this account runs into.
    expect(providerLoad(windows(12, 70))).toBe(40);
    expect(providerLoad(windows(12, 40))).toBe(12);
  });

  it('lets a nearly spent week outrank a busy session window', () => {
    // 15 points of a 5-hour window against 4 points of a week: the week is
    // the account that will be unusable for days, so it reads as the fuller.
    expect(providerLoad(windows(85, 30))).toBe(85);
    expect(providerLoad(windows(85, 96))).toBe(92);
    expect(providerLoad(windows(20, 100))).toBe(100);
  });

  it('takes a lone window at face value, whatever period it bills', () => {
    // grok meters one billing month, so that bar is the account's load; there
    // is no shorter window for it to be discounted against.
    expect(providerLoad({ windows: [{ usedPct: 60, short: 'mo' }] })).toBe(60);
    expect(providerLoad({ windows: [{ usedPct: 60, short: 'plan' }] })).toBe(60);
    // A window whose period the meter would not name is not ranked below one
    // that has a period either.
    expect(
      providerLoad({
        windows: [
          { usedPct: 30, short: '5h' },
          { usedPct: 60, short: 'plan' },
        ],
      }),
    ).toBe(60);
  });

  it('reads the Z.AI plan windows the same way', () => {
    expect(
      providerLoad({
        windows: [
          { usedPct: 40, short: '5h' },
          { usedPct: 70, short: '1d' },
        ],
      }),
    ).toBe(40);
    expect(
      providerLoad({
        windows: [
          { usedPct: 40, short: '5h' },
          { usedPct: 95, short: '1d' },
        ],
      }),
    ).toBe(90);
  });

  it('is unknown without a readable window', () => {
    expect(providerLoad(null)).toBe(null);
    expect(providerLoad({ windows: [] })).toBe(null);
    expect(providerLoad({ windows: [{ usedPct: null }] })).toBe(null);
  });
});

describe('pickLeastUsedProvider', () => {
  it('answers the row itself when it has no siblings', () => {
    state.rows = [row(1)];
    expect(pickLeastUsedProvider(row(1))).toEqual(row(1));
  });

  it('picks the sibling with the most headroom, whichever member was named', () => {
    const usage = { 1: windows(60, 10), 2: windows(20, 10), 3: windows(90, 10) };
    const usageOf = (p) => usage[p.id];
    expect(pickLeastUsedProvider(row(1), { usageOf }).id).toBe(2);
    expect(pickLeastUsedProvider(row(3), { usageOf }).id).toBe(2);
  });

  it('prefers the free session window to the emptier week', () => {
    // Account 1 has 15 points of a 5-hour window left, which one long review
    // turn spends; account 2 has its whole session window and days before its
    // week is what it runs into, so it is where the session goes.
    const usage = { 1: windows(85, 30), 2: windows(20, 90), 3: windows(95, 95) };
    expect(pickLeastUsedProvider(row(1), { usageOf: (p) => usage[p.id] }).id).toBe(2);
  });

  it('spreads a burst over accounts whose loads are only a few points apart', () => {
    // The meters are a minute old at worst, so 12% against 13% says nothing
    // about where the next four sessions should go; the open count does.
    const usage = { 1: windows(12), 2: windows(13), 3: windows(40) };
    const open = { 1: 2, 2: 0, 3: 0 };
    const picked = pickLeastUsedProvider(row(1), {
      usageOf: (p) => usage[p.id],
      openSessions: (p) => open[p.id],
    });
    expect(picked.id).toBe(2);
  });

  it('breaks a tie on the sessions already open, then on picker order', () => {
    const usageOf = () => windows(40, 40);
    const open = { 1: 2, 2: 0, 3: 2 };
    expect(pickLeastUsedProvider(row(1), { usageOf, openSessions: (p) => open[p.id] }).id).toBe(2);
    expect(pickLeastUsedProvider(row(3), { usageOf, openSessions: () => 1 }).id).toBe(1);
  });

  it('leaves an account the auth probe found logged out for last', () => {
    // The empty account is the one with the most headroom and no sessions on
    // it, and still the wrong pick: a session there dies on its first turn.
    const usage = { 1: windows(0), 2: windows(50), 3: windows(90) };
    rememberProviderAuth(1, false);
    rememberProviderAuth(2, true);
    expect(pickLeastUsedProvider(row(1), { usageOf: (p) => usage[p.id] }).id).toBe(2);
    // Logged back in, it is the obvious pick again.
    rememberProviderAuth(1, true);
    expect(pickLeastUsedProvider(row(1), { usageOf: (p) => usage[p.id] }).id).toBe(1);
  });

  it('stops trusting a probe older than the auth TTL', () => {
    // Nothing re-affirmed the logged-out reading for longer than the probes
    // run apart, so it is stale, and stale reads as unknown rather than as
    // still logged out: the account may well have been logged back in.
    const usage = { 1: windows(0), 2: windows(50), 3: windows(90) };
    rememberProviderAuth(1, false, Date.now() - AUTH_TTL_MS - 1);
    expect(cachedProviderAuth(1)).toBe(null);
    expect(pickLeastUsedProvider(row(1), { usageOf: (p) => usage[p.id] }).id).toBe(1);
    rememberProviderAuth(1, false, Date.now() - AUTH_TTL_MS + 1000);
    expect(cachedProviderAuth(1)).toBe(false);
    expect(pickLeastUsedProvider(row(1), { usageOf: (p) => usage[p.id] }).id).toBe(2);
  });

  it('treats an account nobody has probed as usable', () => {
    expect(cachedProviderAuth(1)).toBe(null);
    const usage = { 1: windows(0), 2: windows(50), 3: windows(90) };
    expect(pickLeastUsedProvider(row(1), { usageOf: (p) => usage[p.id] }).id).toBe(1);
  });

  it('puts accounts whose usage is unknown after every known one', () => {
    const usage = { 1: null, 2: windows(95, 95), 3: undefined };
    expect(pickLeastUsedProvider(row(1), { usageOf: (p) => usage[p.id] }).id).toBe(2);
  });

  it('reads the cache by default and refreshes stale members in the background', async () => {
    state.usage['/claude-1'] = windows(50);
    state.usage['/claude-2'] = windows(5);
    // Nothing cached yet: picker order decides, and the pick kicks off the reads.
    expect(pickLeastUsedProvider(row(1)).id).toBe(1);
    await vi.waitFor(() => expect(providers.claudeUsage).toHaveBeenCalledTimes(3));
    await Promise.resolve();
    expect(pickLeastUsedProvider(row(1)).id).toBe(2);
  });
});

describe('rememberProviderAuth', () => {
  it('keeps the newest probe when an older one is written back after it', () => {
    // /api/dev/providers reads the claude state, awaits the usage, and only
    // then writes: the timer's probe can land in between, and the revoked
    // login it found must not be undone by the page's older reading.
    const now = Date.now();
    rememberProviderAuth(1, false, now);
    rememberProviderAuth(1, true, now - 60_000);
    expect(cachedProviderAuth(1)).toBe(false);
    // A probe of its own, made since, is what replaces it.
    rememberProviderAuth(1, true, now + 1);
    expect(cachedProviderAuth(1)).toBe(true);
  });

  it('takes a probe with no time of its own as made now', () => {
    rememberProviderAuth(2, false, Date.now() - 1000);
    rememberProviderAuth(2, true);
    expect(cachedProviderAuth(2)).toBe(true);
    rememberProviderAuth(2, null, NaN);
    expect(cachedProviderAuth(2)).toBe(null);
  });
});

describe('providerUsage', () => {
  it('caches a read, including a failed one, for the TTL', async () => {
    state.usage['/claude-1'] = windows(1);
    expect(await providerUsage(row(1))).toEqual(windows(1));
    state.usage['/claude-1'] = windows(99);
    expect(await providerUsage(row(1))).toEqual(windows(1));
    expect(await providerUsage(row(1), { ttlMs: 0 })).toEqual(windows(99));

    providers.claudeUsage.mockRejectedValueOnce(new Error('down'));
    expect(await providerUsage(row(2))).toBe(null);
    expect(await providerUsage(row(2))).toBe(null);
    expect(providers.claudeUsage).toHaveBeenCalledTimes(3);
  });
});

describe('providerUsage in flight', () => {
  it('collapses concurrent reads of one account into a single request', async () => {
    state.usage['/claude-1'] = windows(7);
    const reads = await Promise.all([providerUsage(row(1)), providerUsage(row(1)), providerUsage(row(1))]);
    expect(reads).toEqual([windows(7), windows(7), windows(7)]);
    expect(providers.claudeUsage).toHaveBeenCalledTimes(1);
  });

  it('does not hand the unresolved read to the synchronous pick', async () => {
    state.usage['/claude-1'] = windows(90);
    const inFlight = providerUsage(row(1));
    // Mid-read the entry holds a promise, which providerLoad could not read:
    // the pick must see it as not read yet.
    expect(cachedProviderUsage(row(1))).toBe(undefined);
    await inFlight;
    expect(cachedProviderUsage(row(1))).toEqual(windows(90));
  });

  it('keeps serving the last reading while a refresh is in flight', async () => {
    state.usage['/claude-1'] = windows(90);
    await providerUsage(row(1));
    state.usage['/claude-1'] = windows(10);
    const refresh = providerUsage(row(1), { ttlMs: 0 });
    // The pick that triggered this refresh reads one statement later; it must
    // see the minute-old number, not a blank.
    expect(cachedProviderUsage(row(1))).toEqual(windows(90));
    await refresh;
    expect(cachedProviderUsage(row(1))).toEqual(windows(10));
  });

  it('lets the pick rank on the last readings across a stale refresh', async () => {
    state.usage['/claude-1'] = windows(50);
    state.usage['/claude-2'] = windows(5);
    await Promise.all(state.rows.map((r) => providerUsage(r)));
    expect(pickLeastUsedProvider(row(1)).id).toBe(2);
    // Every entry is now stale; the pick refreshes all three and must still
    // answer from what it knew, not fall through to picker order.
    for (const r of state.rows) providerUsage(r, { ttlMs: 0 }).catch(() => {});
    expect(pickLeastUsedProvider(row(1)).id).toBe(2);
  });

  it('does not write back a reading the account was told to forget mid-read', async () => {
    let release;
    providers.claudeUsage.mockImplementationOnce(() => new Promise((r) => (release = r)));
    const read = providerUsage(row(3));
    // The login finished while the (logged-out) read was in flight.
    forgetProviderUsage(3);
    release(null);
    expect(await read).toBe(null);
    expect(cachedProviderUsage(row(3))).toBe(undefined);
    // The next caller reads afresh rather than getting the dropped null.
    state.usage['/claude-3'] = windows(2);
    expect(await providerUsage(row(3))).toEqual(windows(2));
  });
});

describe('readProviderUsage', () => {
  it('reads each meter from where the account keeps it', async () => {
    await readProviderUsage(row(1));
    expect(providers.claudeUsage).toHaveBeenCalledWith('/claude-1');
    await readProviderUsage(row(2, { binary: 'codex' }));
    expect(providers.codexUsage).toHaveBeenCalledWith('/codex-2');
    await readProviderUsage(row(3, { binary: 'grok' }));
    expect(providers.grokUsage).toHaveBeenCalledWith('/grok-3');
    await readProviderUsage(row(4, { binary: 'codex', baseUrl: 'https://api.z.ai/v1', apiKey: 'k' }));
    expect(providers.zaiUsage).toHaveBeenCalledWith('https://api.z.ai/v1', 'k');
  });

  it('has nothing to read for a plain api key, a custom codex endpoint, or opencode', async () => {
    expect(await readProviderUsage(row(1, { apiKey: 'k', baseUrl: 'https://example.com' }))).toBe(null);
    expect(await readProviderUsage(row(2, { binary: 'codex', baseUrl: 'https://example.com' }))).toBe(null);
    expect(await readProviderUsage(row(3, { binary: 'opencode' }))).toBe(null);
    expect(providers.claudeUsage).not.toHaveBeenCalled();
  });
});

describe('zaiHost', () => {
  it('recognizes the two Z.AI hosts and nothing else', () => {
    expect(zaiHost('https://api.z.ai/api/anthropic')).toBe(true);
    expect(zaiHost('https://open.bigmodel.cn/api')).toBe(true);
    expect(zaiHost('https://api.openai.com/v1')).toBe(false);
    expect(zaiHost('not a url')).toBe(false);
  });
});
