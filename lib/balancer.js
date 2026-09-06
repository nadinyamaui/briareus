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
const usageCache = new Map(); // provider id -> { at, value } | { at, pending, value: the last one }

// A login probe is trusted for this long. The probes run from server.js
// (checkClaudeAuth at boot and on a timer, /api/dev/providers on demand), and
// an account logged back in from a terminal is only ever noticed by the next
// one, so a reading nothing has refreshed must stop ranking the account last
// rather than keep doing so for the life of the process.
export const AUTH_TTL_MS = 10 * 60_000;
const authCache = new Map(); // provider id -> { at, loggedIn: true | false | null }

// Loads within this many points of each other are treated as equal, because
// they are: the meters this reads are a minute old at worst, so a two-point
// gap says nothing about which account a burst of starts should go to. See
// pickLeastUsedProvider.
const LOAD_BUCKET = 5;

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
// cached too (as null) so a dead endpoint is not hit on every pick. The
// in-flight read is what the cache holds until it resolves, so a burst — an
// orchestrator spawning four workers, a picker poll landing on the boot
// warm-up — shares one request per account instead of each caller missing the
// cache and firing its own. The previous reading rides along with it: the pick
// that triggers a refresh reads the cache one statement later, and a refresh
// that blanked the entry would leave it with no load for every member at once.
//
// The write-back only lands while the entry it belongs to is still the one in
// the map. forgetProviderUsage dropping the row mid-read (a login finishing, an
// endpoint edited, the row deleted) must not be undone by that read resolving
// a moment later with the value it was dropped for.
export async function providerUsage(p, { read = readProviderUsage, ttlMs = USAGE_TTL_MS } = {}) {
  const hit = usageCache.get(p.id);
  if (hit && Date.now() - hit.at < ttlMs) return hit.pending || hit.value;
  const pending = read(p).catch(() => null);
  const entry = { at: Date.now(), pending, value: hit?.value };
  usageCache.set(p.id, entry);
  const value = await pending;
  if (usageCache.get(p.id) === entry) usageCache.set(p.id, { at: Date.now(), value });
  return value;
}

// What the synchronous pick reads: the last resolved value, which a refresh in
// flight keeps serving until it lands. An account never read answers
// undefined rather than a promise providerLoad cannot use.
export function cachedProviderUsage(p) {
  const hit = usageCache.get(p.id);
  return hit ? hit.value : undefined;
}

// Whether an account's last auth probe found it logged in, as the login probes
// in server.js (checkClaudeAuth, /api/dev/providers) leave it here. Load alone
// cannot stand in for this: a logged-out login reads as unknown load, and so
// does a healthy account whose meter has not been fetched yet or whose usage
// endpoint is down. `at` is when the probe ran, which is not now when a page
// re-reads a probe it did not make. Unknown (never probed, or probed longer
// ago than AUTH_TTL_MS) is null.
export function rememberProviderAuth(id, loggedIn, at = Date.now()) {
  authCache.set(Number(id), {
    at: Number.isFinite(at) ? at : Date.now(),
    loggedIn: loggedIn == null ? null : !!loggedIn,
  });
}

export function cachedProviderAuth(id) {
  const hit = authCache.get(Number(id));
  if (!hit || Date.now() - hit.at >= AUTH_TTL_MS) return null;
  return hit.loggedIn;
}

// Drops what this module knows about an account (or all of them), for the
// events that make an entry wrong rather than merely stale: a row's endpoint
// or key edited, a row deleted, an account logged back in.
export function forgetProviderUsage(id = null) {
  if (id == null) {
    usageCache.clear();
    authCache.clear();
  } else {
    usageCache.delete(Number(id));
    authCache.delete(Number(id));
  }
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
 * The member of `provider`'s group a new session should run on. In order: an
 * account the last auth probe found logged out is last, since a session
 * started on it dies on its first turn however much quota it has; then the
 * lowest load, in buckets of LOAD_BUCKET points, because comparing the raw
 * percentages would make an exact tie the only way to reach the next
 * criterion; then the fewest sessions open right now, which is what spreads a
 * burst of starts the minute-old meters cannot yet see; then picker order.
 * Accounts whose load is unknown come after every known one, which are at
 * least known to answer. A group of one is itself.
 *
 * @param {any} provider
 * @param {{ openSessions?: (p: any) => number, usageOf?: (p: any) => any, loggedInOf?: (p: any) => boolean | null, refresh?: boolean }} [opts]
 */
export function pickLeastUsedProvider(provider, opts = {}) {
  const members = providerGroup(provider);
  if (members.length <= 1) return provider;
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
      load: providerLoad(usageOf(p)),
      open: openSessions(p),
    }))
    .sort(
      (a, b) =>
        Number(a.out) - Number(b.out) ||
        Number(a.load == null) - Number(b.load == null) ||
        bucket(a.load) - bucket(b.load) ||
        a.open - b.open ||
        a.index - b.index,
    );
  return ranked[0].p;
}
