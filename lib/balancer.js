// @ts-check
import { providerGroup } from './providerstore.js';
import {
  claudeHomeDir,
  codexHomeDir,
  grokHomeDir,
  claudeUsage,
  codexUsage,
  grokUsage,
  zaiUsage,
} from './providers.js';

// Spreads sessions over the accounts of one provider group (see
// providerGroup in lib/providerstore.js). Whatever a picker or a stored
// runtime names, the session that actually starts runs on the group member
// with the most headroom, so three claude.ai logins drain evenly instead of
// the first one hitting its limit while the others idle.
//
// The pick is synchronous because createDevSession is: it reads the usage
// this module last fetched and refreshes stale entries in the background, so
// the decision is a minute old at worst. The picker's /api/dev/providers
// read shares the cache, which keeps it warm whenever the page is open.

const USAGE_TTL_MS = 60_000;
const usageCache = new Map(); // provider id -> { at, value }

// Z.AI publishes the plan's quota on the same host the sessions run against,
// so the endpoint's URL is what says whether there is anything to read, not
// the binary, which is codex for the Responses wire and claude for the
// Anthropic-shaped one.
export function zaiHost(baseUrl) {
  try {
    const host = new URL(baseUrl).hostname;
    return host === 'api.z.ai' || host.endsWith('.bigmodel.cn');
  } catch {
    return false;
  }
}

// One provider row's subscription usage, straight from its meter: the login
// dir for claude / codex / grok accounts, the key for a Z.AI plan. Anything
// else (a plain API key, opencode) has no meter to read and answers null.
export function readProviderUsage(p) {
  if (p.apiKey) return zaiHost(p.baseUrl) ? zaiUsage(p.baseUrl, p.apiKey) : Promise.resolve(null);
  if (p.binary === 'claude') return claudeUsage(claudeHomeDir(p));
  if (p.binary === 'codex' && !p.baseUrl) return codexUsage(codexHomeDir(p));
  if (p.binary === 'grok') return grokUsage(grokHomeDir(p));
  return Promise.resolve(null);
}

// The cached usage, fetched when missing or older than the TTL. Failures are
// cached too (as null) so a dead endpoint is not hit on every pick.
export async function providerUsage(p, { read = readProviderUsage, ttlMs = USAGE_TTL_MS } = {}) {
  const hit = usageCache.get(p.id);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value;
  const value = await read(p).catch(() => null);
  usageCache.set(p.id, { at: Date.now(), value });
  return value;
}

export function cachedProviderUsage(p) {
  const hit = usageCache.get(p.id);
  return hit ? hit.value : undefined;
}

export function forgetProviderUsage(id = null) {
  if (id == null) usageCache.clear();
  else usageCache.delete(id);
}

// How loaded an account is: its most spent window. Claude and codex bill a
// 5-hour and a 7-day window at once, and the one closer to its limit is the
// one that stops the account, so that is the number to keep low. Unknown
// (no usage read yet, logged out, meterless) is null.
export function providerLoad(usage) {
  const pcts = (usage?.windows || []).map((w) => w.usedPct).filter((n) => Number.isFinite(n));
  return pcts.length ? Math.max(...pcts) : null;
}

/**
 * The member of `provider`'s group a new session should run on: the lowest
 * load first; among equals the fewest sessions open right now, because the
 * meters lag and a burst of starts would otherwise all land on one account;
 * then picker order. Accounts whose load is unknown come after every known
 * one: a logged-out login reads as unknown, and the known ones are at least
 * known to work. A group of one is itself.
 *
 * @param {any} provider
 * @param {{ openSessions?: (p: any) => number, usageOf?: (p: any) => any, refresh?: boolean }} [opts]
 */
export function pickLeastUsedProvider(provider, opts = {}) {
  const members = providerGroup(provider);
  if (members.length <= 1) return provider;
  const usageOf = opts.usageOf || cachedProviderUsage;
  const openSessions = opts.openSessions || (() => 0);
  if (opts.refresh !== false && !opts.usageOf) {
    for (const m of members) providerUsage(m).catch(() => {});
  }
  const ranked = members
    .map((p, index) => ({ p, index, load: providerLoad(usageOf(p)), open: openSessions(p) }))
    .sort(
      (a, b) =>
        Number(a.load == null) - Number(b.load == null) ||
        (a.load ?? 0) - (b.load ?? 0) ||
        a.open - b.open ||
        a.index - b.index,
    );
  return ranked[0].p;
}
