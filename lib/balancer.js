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

// Spreads sessions over the accounts of one provider group (see providerGroup in
// lib/providerstore.js): a session runs on the member with the most headroom, so
// several logins drain evenly. The pick is synchronous (createDevSession is), so it
// reads cached usage and refreshes stale entries in the background.

// Claude's usage endpoint allows a login very few reads, shared with its own CLI;
// polling every minute gets the account locked out for most of an hour.
const USAGE_TTL_MS = 15 * 60_000;
// provider id -> { at, value, retryAt? } | { at, pending, value: the last one }
const usageCache = new Map();
const exhaustedUntil = new Map();

// A CLI rejection is newer than the cached meter. Keep it out of selection
// until its reset, or retry after the meter TTL when Claude supplied no reset.
export function rememberProviderExhausted(provider, resetsAt = null) {
  const windows = cachedProviderUsage(provider)?.windows || [];
  const resets = windows
    .filter((w) => w.usedPct >= 100)
    .map((w) => Date.parse(w.resetsAt))
    .filter((t) => t > Date.now());
  const reset = Date.parse(resetsAt);
  const knownReset = Math.max(0, ...resets, Number.isFinite(reset) ? reset : 0);
  exhaustedUntil.set(provider.id, knownReset > Date.now() ? knownReset : Date.now() + USAGE_TTL_MS);
}

function providerExhausted(provider) {
  return (exhaustedUntil.get(provider.id) || 0) > Date.now();
}

// How long a login probe (server.js checkProviderAuth, /api/dev/providers) is
// trusted, so a stale "logged out" stops ranking an account last. The probe timer
// runs well inside this, so a live row is always covered.
export const AUTH_TTL_MS = 10 * 60_000;
const authCache = new Map(); // provider id -> { at, loggedIn: true | false | null }

// Loads within this many points are treated as equal: the meters are minutes old,
// so a small gap says nothing about where a burst of starts should go.
const LOAD_BUCKET = 5;

// Z.AI serves quota on the session host, so the URL (not the binary, which may be
// codex or claude) says whether there is a meter to read.
export function zaiHost(baseUrl) {
  try {
    const host = new URL(baseUrl).hostname;
    return host === 'api.z.ai' || host.endsWith('.bigmodel.cn');
  } catch {
    return false;
  }
}

// A provider row's subscription usage from its meter, or null when it has none
// (a plain API key, opencode).
export function readProviderUsage(p) {
  if (p.apiKey) return zaiHost(p.baseUrl) ? zaiUsage(p.baseUrl, p.apiKey) : Promise.resolve(null);
  if (p.binary === 'claude') return claudeUsage(claudeHomeDir(p));
  if (p.binary === 'codex' && !p.baseUrl) return codexUsage(codexHomeDir(p));
  if (p.binary === 'grok') return grokUsage(grokHomeDir(p));
  return Promise.resolve(null);
}

// Cached usage, fetched when missing or past the TTL; failures cache as null so a
// dead endpoint is not hit on every pick. The cache holds the in-flight read so a
// burst shares one request per account, and keeps the previous value meanwhile so
// the pick that triggered the refresh still sees a load.
//
// The write-back only lands if the entry is still current, so a forgetProviderUsage
// mid-read is not undone. A retryAt (claude's 429) blocks re-reads until then, even
// a manual refresh, since early reads extend the lockout; the last windows stay,
// marked stale.
export async function providerUsage(p, { read = readProviderUsage, ttlMs = USAGE_TTL_MS } = {}) {
  const hit = usageCache.get(p.id);
  if (hit?.pending) return hit.pending;
  if (hit?.retryAt && Date.now() < Date.parse(hit.retryAt)) return hit.value;
  if (hit && Date.now() - hit.at < ttlMs) return hit.value;
  const pending = read(p)
    .catch(() => null)
    .then((value) => withLastWindows(value, hit?.value));
  const entry = { at: Date.now(), pending, value: hit?.value };
  usageCache.set(p.id, entry);
  const value = await pending;
  if (usageCache.get(p.id) === entry)
    usageCache.set(p.id, { at: Date.now(), value, ...(value?.retryAt ? { retryAt: value.retryAt } : {}) });
  return value;
}

// Only a refusal with a retryAt keeps the previous windows; any other failure is
// reported as is, so a logged-out account does not keep looking healthy.
function withLastWindows(value, last) {
  if (!value?.retryAt || !last?.windows?.length) return value;
  return { ...value, windows: last.windows, stale: true };
}

// The last resolved value (never a promise) for the synchronous pick.
export function cachedProviderUsage(p) {
  const hit = usageCache.get(p.id);
  return hit ? hit.value : undefined;
}

// Records an auth probe's result; load cannot stand in for it, since logged-out and
// unread meters both read as unknown load. `at` is when the probe ran. Only a probe
// at least as new as the remembered one lands, because writers arrive out of order
// and a stale "logged in" would keep a revoked account pickable.
export function rememberProviderAuth(id, loggedIn, at = Date.now()) {
  const when = Number.isFinite(at) ? at : Date.now();
  const hit = authCache.get(Number(id));
  if (hit && hit.at > when) return;
  authCache.set(Number(id), { at: when, loggedIn: loggedIn == null ? null : !!loggedIn });
}

export function cachedProviderAuth(id) {
  const hit = authCache.get(Number(id));
  if (!hit || Date.now() - hit.at >= AUTH_TTL_MS) return null;
  return hit.loggedIn;
}

// Drops cached state for an account (or all), for events that make it wrong rather
// than stale: endpoint or key edited, row deleted, account logged back in.
export function forgetProviderUsage(id = null) {
  if (id == null) {
    usageCache.clear();
    authCache.clear();
    exhaustedUntil.clear();
  } else {
    usageCache.delete(Number(id));
    authCache.delete(Number(id));
    exhaustedUntil.delete(Number(id));
  }
}

// A window's length in hours from the label lib/providers.js normalizes it to;
// an unnamed period ('plan') is null.
const WINDOW_HOURS = { wk: 168, mo: 720, d: 24 };
function windowHours(w) {
  const short = String(w.short || '');
  if (WINDOW_HOURS[short]) return WINDOW_HOURS[short];
  const m = /^(\d+)([hd])$/.exec(short);
  return m ? Number(m[1]) * (m[2] === 'd' ? 24 : 1) : null;
}

// How loaded an account is. Percentages of a 5-hour and a weekly window are not
// comparable (90% of a week leaves more room than 85% of a session), so the
// shortest window counts at face value and longer ones only from halfway up. A
// nearly spent long window still outranks everything. Unknown is null.
export function providerLoad(usage) {
  const list = (usage?.windows || []).filter((w) => Number.isFinite(w.usedPct));
  if (!list.length) return null;
  const hours = list.map(windowHours).filter((h) => h != null);
  const shortest = hours.length ? Math.min(...hours) : null;
  const weigh = (w) => {
    const h = windowHours(w);
    if (shortest == null || h == null || h <= shortest) return w.usedPct;
    return Math.max(0, w.usedPct * 2 - 100);
  };
  return Math.max(...list.map(weigh));
}

/**
 * The member of `provider`'s group a new session should run on. Ranked: logged-out
 * accounts last (a session there dies on its first turn), then exhausted ones, then
 * unknown load (a failed read is not unusable), then bucketed load, then fewest open
 * sessions (spreads bursts the meters cannot see yet), then picker order.
 *
 * @param {any} provider
 * @param {{ openSessions?: (p: any) => number, usageOf?: (p: any) => any, loggedInOf?: (p: any) => boolean | null, refresh?: boolean, excludeIds?: Set<number>, availableOnly?: boolean }} [opts]
 */
export function pickLeastUsedProvider(provider, opts = {}) {
  const members = providerGroup(provider);
  if (!members.length) throw new Error(`${provider.label}: this provider is inactive`);
  if (members.length === 1 && !opts.availableOnly) return members[0];
  const usageOf = opts.usageOf || cachedProviderUsage;
  const loggedInOf = opts.loggedInOf || ((p) => cachedProviderAuth(p.id));
  const openSessions = opts.openSessions || (() => 0);
  if (opts.refresh !== false && !opts.usageOf) {
    for (const m of members) providerUsage(m).catch(() => {});
  }
  const bucket = (load) => Math.floor((load ?? 0) / LOAD_BUCKET);
  const ranked = members
    .map((p, index) => ({
      p,
      index,
      out: loggedInOf(p) === false,
      load: providerExhausted(p) ? 100 : providerLoad(usageOf(p)),
      open: openSessions(p),
    }))
    .filter((m) => !opts.excludeIds?.has(m.p.id) && (!opts.availableOnly || (!m.out && !(m.load >= 100))))
    .sort(
      (a, b) =>
        Number(a.out) - Number(b.out) ||
        Number(a.load >= 100) - Number(b.load >= 100) ||
        Number(a.load == null) - Number(b.load == null) ||
        bucket(a.load) - bucket(b.load) ||
        a.open - b.open ||
        a.index - b.index,
    );
  return ranked[0]?.p || null;
}
