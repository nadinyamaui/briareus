import { createHash } from 'node:crypto';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const state = vi.hoisted(() => ({ rows: [], usage: {} }));

vi.mock('../lib/providerstore.js', () => ({
  getProvider: (id) => state.rows.find((p) => p.id === id) || null,
  providerGroup: (p) => state.rows.filter((r) => r.active && r.binary === p.binary && !r.apiKey),
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
  rememberProviderExhausted,
  restoreProviderUsage,
  flushProviderUsage,
  FRESH_USAGE_TTL_MS,
} from '../lib/balancer.js';

const windows = (...pcts) => ({ windows: pcts.map((usedPct, i) => ({ usedPct, short: i ? 'wk' : '5h' })) });
const row = (id, over = {}) => ({
  id,
  binary: 'claude',
  active: true,
  baseUrl: '',
  apiKey: '',
  sortOrder: id,
  ...over,
});

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
  it('fails over to the least used eligible sibling and returns null when none remain', () => {
    const usageOf = (p) => ({ windows: [{ short: '5h', usedPct: { 1: 5, 2: 60, 3: 20 }[p.id] }] });
    rememberProviderExhausted(row(1));
    expect(pickLeastUsedProvider(row(1), { usageOf }).id).toBe(3);
    expect(pickLeastUsedProvider(row(1), { usageOf, availableOnly: true, excludeIds: new Set([3]) }).id).toBe(
      2,
    );
    expect(
      pickLeastUsedProvider(row(1), { usageOf, availableOnly: true, excludeIds: new Set([2, 3]) }),
    ).toBeNull();
    forgetProviderUsage(1);
    expect(pickLeastUsedProvider(row(1), { usageOf }).id).toBe(1);
  });

  it('allows a quota-rejected account again after its reset', () => {
    vi.useFakeTimers();
    try {
      rememberProviderExhausted(row(1), new Date(Date.now() + 3600000).toISOString());
      const usageOf = (p) => windows(p.id === 1 ? 1 : 20);
      expect(pickLeastUsedProvider(row(1), { usageOf }).id).toBe(2);
      vi.advanceTimersByTime(3600001);
      expect(pickLeastUsedProvider(row(1), { usageOf }).id).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
  it('answers the row itself when it has no siblings', () => {
    state.rows = [row(1)];
    expect(pickLeastUsedProvider(row(1))).toEqual(row(1));
  });

  it('answers the active sibling when the named row is inactive', () => {
    state.rows = [row(2)];

    expect(pickLeastUsedProvider(row(1, { active: false })).id).toBe(2);
  });

  it('refuses a group with no active rows', () => {
    state.rows = [];

    expect(() => pickLeastUsedProvider(row(1, { active: false }))).toThrow(/this provider is inactive/);
  });

  it('picks the sibling with the most headroom, whichever member was named', () => {
    const usage = { 1: windows(60, 10), 2: windows(20, 10), 3: windows(90, 10) };
    const usageOf = (p) => usage[p.id];
    expect(pickLeastUsedProvider(row(1), { usageOf }).id).toBe(2);
    expect(pickLeastUsedProvider(row(3), { usageOf }).id).toBe(2);
  });

  it('prefers the free session window to the emptier week', () => {
    // Account 1's 15 points of a 5-hour window go in one long review turn; account 2 has its
    // whole session window and days before its week runs out, so the session goes there.
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
    // A logged-out reading not re-affirmed within the probe interval is stale, and stale reads
    // as unknown, not logged out: the account may have been logged back in.
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

  it('puts accounts whose usage is unknown after known accounts with quota left', () => {
    const usage = { 1: null, 2: windows(95, 95), 3: undefined };
    expect(pickLeastUsedProvider(row(1), { usageOf: (p) => usage[p.id] }).id).toBe(2);
  });

  it.each([
    ['five-hour', windows(100, 10)],
    ['weekly', windows(10, 100)],
  ])('prefers unknown usage to an exhausted %s limit', (_window, exhausted) => {
    const usage = { 1: exhausted, 2: null, 3: undefined };
    expect(pickLeastUsedProvider(row(1), { usageOf: (p) => usage[p.id] }).id).toBe(2);
    // Even a busy account with known headroom is better than either fallback.
    usage[3] = windows(99, 99);
    expect(pickLeastUsedProvider(row(1), { usageOf: (p) => usage[p.id] }).id).toBe(3);
  });

  it('keeps logged-out accounts last even when the logged-in accounts are exhausted', () => {
    const usage = { 1: windows(100), 2: null, 3: windows(0) };
    rememberProviderAuth(1, true);
    rememberProviderAuth(2, false);
    rememberProviderAuth(3, false);
    expect(pickLeastUsedProvider(row(1), { usageOf: (p) => usage[p.id] }).id).toBe(1);
  });

  it('still breaks ties by open sessions when every account is exhausted', () => {
    expect(
      pickLeastUsedProvider(row(1), {
        usageOf: () => windows(100),
        openSessions: (p) => (p.id === 2 ? 0 : 1),
      }).id,
    ).toBe(2);
  });

  it('reads the cache by default and refreshes stale members in the background', async () => {
    state.usage['/claude-1'] = windows(50);
    state.usage['/claude-2'] = windows(5);
    // Nothing cached yet: picker order decides, and the pick kicks off the reads.
    expect(pickLeastUsedProvider(row(1)).id).toBe(1);
    await vi.waitFor(() => expect(providers.claudeUsage).toHaveBeenCalledTimes(3));
    await vi.waitFor(() => expect(pickLeastUsedProvider(row(1), { refresh: false }).id).toBe(2));
  });
});

describe('rememberProviderAuth', () => {
  it('keeps the newest probe when an older one is written back after it', () => {
    // /api/dev/providers reads claude state, awaits usage, then writes; the timer's probe can
    // land in between, and its revoked login must not be undone by the older reading.
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
  it('a manual refresh retries a cached failure and updates the balancer immediately', async () => {
    expect(await providerUsage(row(1))).toBeNull();
    state.usage['/claude-1'] = windows(100);
    expect(await providerUsage(row(1))).toBeNull();
    expect(await providerUsage(row(1), { ttlMs: 0 })).toEqual(windows(100));
    expect(cachedProviderUsage(row(1))).toEqual(windows(100));
    expect(providers.claudeUsage).toHaveBeenCalledTimes(2);
  });

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

describe('providerUsage after a rate limit', () => {
  const refused = (retryAt) => ({ windows: [], error: 'Claude rate limited the usage check.', retryAt });

  it('does not read the meter again before retryAt, not even on a manual refresh', async () => {
    state.usage['/claude-1'] = refused(new Date(Date.now() + 60 * 60_000).toISOString());
    await providerUsage(row(1));
    await providerUsage(row(1), { ttlMs: 0 });
    await providerUsage(row(1), { ttlMs: 0 });
    expect(providers.claudeUsage).toHaveBeenCalledTimes(1);
  });

  it('reads it again once retryAt has passed', async () => {
    state.usage['/claude-1'] = refused(new Date(Date.now() - 1000).toISOString());
    await providerUsage(row(1));
    state.usage['/claude-1'] = windows(20);
    expect(await providerUsage(row(1), { ttlMs: 0 })).toEqual(windows(20));
    expect(providers.claudeUsage).toHaveBeenCalledTimes(2);
  });

  it('keeps the last windows, marked stale, so the balancer still has a load', async () => {
    state.usage['/claude-1'] = windows(40, 10);
    await providerUsage(row(1));
    const retryAt = new Date(Date.now() + 60 * 60_000).toISOString();
    state.usage['/claude-1'] = refused(retryAt);
    const value = await providerUsage(row(1), { ttlMs: 0 });
    expect(value).toEqual({ ...refused(retryAt), windows: windows(40, 10).windows, stale: true });
    expect(providerLoad(cachedProviderUsage(row(1)))).toBe(providerLoad(windows(40, 10)));
  });

  it('does not keep old windows under a failure that gives no retry time', async () => {
    state.usage['/claude-1'] = windows(40);
    await providerUsage(row(1));
    state.usage['/claude-1'] = { windows: [], error: 'Claude usage check failed (HTTP 401).' };
    expect(await providerUsage(row(1), { ttlMs: 0 })).toEqual(state.usage['/claude-1']);
  });
});

describe('providerUsage across a restart', () => {
  const fingerprint = createHash('sha256')
    .update(JSON.stringify(['claude', '', '', null]))
    .digest('hex');
  const settle = () => new Promise((r) => setTimeout(r, 0));
  // Unwired again so later tests do not write into this one's store.
  const unwire = () => restoreProviderUsage({ load: () => null, update: null });
  // The stored setting, changed in place the way updateAppSetting hands it to fn.
  const store = (stored = {}) => ({ stored, update: vi.fn(async (fn) => fn(stored)) });

  const claudeAuth = (account, rotation, organization = 'org-1') => ({
    credentials: {
      claudeAiOauth: {
        accessToken: `access-${rotation}`,
        refreshToken: `refresh-${rotation}`,
        expiresAt: rotation,
      },
    },
    settings: { oauthAccount: { accountUuid: account, organizationUuid: organization } },
  });
  const codexAuth = (account, rotation) => ({
    auth: {
      tokens: {
        access_token: `x.${Buffer.from(
          JSON.stringify({ exp: rotation, 'https://api.openai.com/auth': { chatgpt_account_id: account } }),
        ).toString('base64url')}.sig-${rotation}`,
        refresh_token: `refresh-${rotation}`,
        id_token: `id-${rotation}`,
      },
      last_refresh: rotation,
    },
  });

  it.each([
    ['claude', claudeAuth],
    ['codex', codexAuth],
  ])('preserves %s lockouts through token rotation, persistence and restart', async (binary, auth) => {
    const { stored } = store();
    state.rows[0] = row(1, { binary, authData: auth('account-1', 1) });
    // The credentials rotate before the queued write validates the provider row.
    const update = async (fn) => {
      state.rows[0] = row(1, { binary, authData: auth('account-1', 2) });
      fn(stored, state.rows[0]);
    };
    await restoreProviderUsage({ load: () => ({}), update });
    const retryAt = new Date(Date.now() + 3600000).toISOString();
    const value = { windows: [], retryAt };
    const read = vi.fn(async () => value);
    await providerUsage(state.rows[0], { read });
    await flushProviderUsage();
    expect(stored[1].retryAt).toBe(retryAt);
    expect(await providerUsage(state.rows[0], { read, ttlMs: 0 })).toEqual(value);
    expect(cachedProviderUsage(state.rows[0])).toEqual(value);
    expect(read).toHaveBeenCalledTimes(1);

    vi.resetModules();
    const restarted = await import('../lib/balancer.js');
    state.rows[0] = row(1, { binary, authData: auth('account-1', 3) });
    await restarted.restoreProviderUsage({ load: () => stored, update: null });
    expect(await restarted.providerUsage(state.rows[0], { read, ttlMs: 0 })).toEqual(value);
    expect(read).toHaveBeenCalledTimes(1);
    state.rows[0] = row(1, { binary, authData: auth('account-2', 3) });
    expect(restarted.cachedProviderUsage(state.rows[0])).toBeUndefined();
    await restarted.providerUsage(state.rows[0], { read, ttlMs: 0 });
    expect(read).toHaveBeenCalledTimes(2);
    await unwire();
  });

  it('invalidates Claude usage when the same user switches organizations', async () => {
    state.rows[0] = row(1, { authData: claudeAuth('account-1', 1) });
    const read = vi.fn(async () => ({ windows: [], retryAt: new Date(Date.now() + 3600000).toISOString() }));
    await providerUsage(state.rows[0], { read });
    state.rows[0] = row(1, { authData: claudeAuth('account-1', 2, 'org-2') });
    await providerUsage(state.rows[0], { read });
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('serves a restored read inside its TTL instead of asking again', async () => {
    const saved = { 1: { at: Date.now() - 60_000, fingerprint, value: windows(30) } };
    await restoreProviderUsage({ load: async () => saved, update: async () => {} });
    expect(await providerUsage(row(1))).toEqual(windows(30));
    expect(await providerUsage(row(1), { ttlMs: FRESH_USAGE_TTL_MS })).toEqual(windows(30));
    expect(providers.claudeUsage).not.toHaveBeenCalled();
    await unwire();
  });

  it('keeps a restored rate limit until its retryAt, even for a manual refresh', async () => {
    const retryAt = new Date(Date.now() + 30 * 60_000).toISOString();
    const saved = {
      1: { at: Date.now() - 20 * 60_000, fingerprint, value: { windows: [], retryAt }, retryAt },
    };
    await restoreProviderUsage({ load: async () => saved, update: async () => {} });
    await providerUsage(row(1), { ttlMs: 0 });
    expect(providers.claudeUsage).not.toHaveBeenCalled();
    await unwire();
  });

  it('saves each settled read and each forget, so the next process starts from them', async () => {
    const { stored, update } = store();
    await restoreProviderUsage({ load: async () => ({}), update });
    state.usage['/claude-1'] = windows(12);
    await providerUsage(row(1));
    await settle();
    expect(stored).toEqual({ 1: { at: expect.any(Number), fingerprint, value: windows(12) } });
    forgetProviderUsage(1);
    await settle();
    expect(stored).toEqual({});
    await unwire();
  });

  it("leaves other accounts' stored entries alone, so another server's newer lockout survives", async () => {
    const at = Date.now() - 60_000;
    const { stored, update } = store();
    await restoreProviderUsage({
      load: async () => ({ 1: { at, fingerprint, value: windows(30) } }),
      update,
    });
    // Another server sharing the database saved a lockout for account 1 since.
    const retryAt = new Date(Date.now() + 60 * 60_000).toISOString();
    const lockout = { at: Date.now(), value: { windows: [], retryAt }, retryAt };
    stored[1] = lockout;
    state.usage['/claude-2'] = windows(7);
    await providerUsage(row(2));
    await settle();
    expect(stored).toEqual({ 1: lockout, 2: { at: expect.any(Number), fingerprint, value: windows(7) } });
    await unwire();
  });

  it('keeps a stored entry newer than the one being saved, but a forget still drops it', async () => {
    const { stored, update } = store();
    await restoreProviderUsage({ load: async () => ({}), update });
    const newer = { at: Date.now() + 60_000, fingerprint, value: windows(90) };
    stored[1] = newer;
    state.usage['/claude-1'] = windows(12);
    await providerUsage(row(1));
    await settle();
    expect(stored[1]).toBe(newer);
    forgetProviderUsage(1);
    await settle();
    expect(stored).toEqual({});
    await unwire();
  });

  it('rejects a legacy restored lockout without an account fingerprint', async () => {
    const retryAt = new Date(Date.now() + 3600000).toISOString();
    await restoreProviderUsage({
      load: () => ({ 1: { at: Date.now(), value: { windows: [], retryAt }, retryAt } }),
      update: null,
    });
    state.usage['/claude-1'] = windows(7);
    expect(cachedProviderUsage(row(1))).toBeUndefined();
    expect(await providerUsage(row(1), { ttlMs: 0 })).toEqual(windows(7));
    expect(providers.claudeUsage).toHaveBeenCalledTimes(1);
    await unwire();
  });

  it('does not restore an old account lockout when its invalidation failed', async () => {
    const { stored, update } = store();
    await restoreProviderUsage({ load: () => ({}), update });
    const retryAt = new Date(Date.now() + 3600000).toISOString();
    state.usage['/claude-1'] = { windows: [], retryAt };
    await providerUsage(row(1));
    await flushProviderUsage();
    await restoreProviderUsage({
      load: () => null,
      update: async () => {
        throw new Error('db down');
      },
    });
    state.rows[0] = row(1, { apiKey: 'NEW_KEY', baseUrl: 'https://api.z.ai' });
    forgetProviderUsage(1);
    await flushProviderUsage();
    expect(stored[1].retryAt).toBe(retryAt);
    // A fresh process loads the unchanged old setting with the new configuration.
    vi.resetModules();
    const restarted = await import('../lib/balancer.js');
    await restarted.restoreProviderUsage({ load: () => stored, update: null });
    state.usage.zai = windows(4);
    expect(await restarted.providerUsage(state.rows[0], { ttlMs: 0 })).toEqual(windows(4));
    expect(providers.zaiUsage).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(stored)).not.toContain('NEW_KEY');
    await unwire();
  });

  it('rejects another server’s old in-flight read after a successful edit and invalidation', async () => {
    const { stored } = store();
    let current = row(1);
    const update = async (fn) => fn(stored, current);
    await restoreProviderUsage({ load: () => ({}), update });
    let finish;
    const pending = providerUsage(row(1), { read: () => new Promise((r) => (finish = r)) });
    // This process still has the old provider cache; another server committed the edit.
    current = row(1, { authData: { credentials: { claudeAiOauth: { accessToken: 'NEW_LOGIN' } } } });
    delete stored[1];
    finish({ windows: [], retryAt: new Date(Date.now() + 3600000).toISOString() });
    await pending;
    await flushProviderUsage();
    expect(stored).toEqual({});
    state.rows[0] = current;
    expect(cachedProviderUsage(current)).toBeUndefined();
    state.usage['/claude-1'] = windows(6);
    expect(await providerUsage(current)).toEqual(windows(6));
    await flushProviderUsage();
    expect(stored[1].value).toEqual(windows(6));
    expect(JSON.stringify(stored)).not.toContain('NEW_LOGIN');
    await unwire();
  });

  it('does not reuse a changed account’s pending read or its previous windows', async () => {
    state.usage['/claude-1'] = windows(99);
    await providerUsage(row(1));
    let finish;
    const pending = providerUsage(row(1), { ttlMs: 0, read: () => new Promise((r) => (finish = r)) });
    state.rows[0] = row(1, { authData: { token: 'NEW_LOGIN' } });
    const retryAt = new Date(Date.now() + 3600000).toISOString();
    state.usage['/claude-1'] = { windows: [], retryAt };
    expect(await providerUsage(state.rows[0])).toEqual({ windows: [], retryAt });
    finish(windows(100));
    await pending;
    expect(cachedProviderUsage(state.rows[0])).toEqual({ windows: [], retryAt });
    // Display-only edits still describe the same account.
    expect(cachedProviderUsage({ ...state.rows[0], label: 'renamed' })).toEqual({ windows: [], retryAt });
  });

  it('lets shutdown wait for a queued write, but not past its bound', async () => {
    let release;
    const update = vi.fn(() => new Promise((r) => (release = r)));
    await restoreProviderUsage({ load: async () => ({}), update });
    await providerUsage(row(1));
    let drained = false;
    const flush = flushProviderUsage(1000).then(() => (drained = true));
    await settle();
    expect(update).toHaveBeenCalledTimes(1);
    expect(drained).toBe(false);
    release();
    await flush;
    expect(drained).toBe(true);

    forgetProviderUsage(1); // held until released below
    const started = Date.now();
    await flushProviderUsage(20);
    expect(Date.now() - started).toBeLessThan(1000);
    release(); // so the queue is free for later tests
    await flushProviderUsage();
    await unwire();
  });

  it('reads again once the restored read is past its TTL, and a failed load restores nothing', async () => {
    await restoreProviderUsage({
      load: async () => ({ 1: { at: Date.now() - 16 * 60_000, value: windows(5) } }),
      update: null,
    });
    state.usage['/claude-1'] = windows(50);
    expect(await providerUsage(row(1))).toEqual(windows(50));
    await restoreProviderUsage({
      load: async () => {
        throw new Error('db down');
      },
      update: null,
    });
    state.usage['/claude-2'] = windows(7);
    expect(await providerUsage(row(2))).toEqual(windows(7));
    expect(providers.claudeUsage).toHaveBeenCalledTimes(2);
  });
});

describe('providerUsage in flight', () => {
  it('shares an in-flight manual refresh even when callers bypass the TTL', async () => {
    await providerUsage(row(1));
    let release;
    providers.claudeUsage.mockImplementationOnce(() => new Promise((r) => (release = r)));
    const first = providerUsage(row(1), { ttlMs: 0 });
    const second = providerUsage(row(1), { ttlMs: 0 });
    expect(providers.claudeUsage).toHaveBeenCalledTimes(2);
    release(windows(80));
    expect(await Promise.all([first, second])).toEqual([windows(80), windows(80)]);
    expect(cachedProviderUsage(row(1))).toEqual(windows(80));
  });

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
