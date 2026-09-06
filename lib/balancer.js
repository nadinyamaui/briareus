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
const usageCache = new Map(); // provider id -> { at, value } | { at, pending }
const authCache = new Map(); // provider id -> loggedIn: true | false | null

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
// cache and firing its own.
export async function providerUsage(p, { read = readProviderUsage, ttlMs = USAGE_TTL_MS } = {}) {
  const hit = usageCache.get(p.id);
  if (hit && Date.now() - hit.at < ttlMs) return hit.pending || hit.value;
  const pending = read(p).catch(() => null);
  usageCache.set(p.id, { at: Date.now(), pending });
  const value = await pending;
  usageCache.set(p.id, { at: Date.now(), value });
  return value;
}

// What the synchronous pick reads: the last resolved value. A read still in
// flight has none yet and answers undefined, the same as never read, rather
// than handing back a promise providerLoad cannot use.
export function cachedProviderUsage(p) {
  const hit = usageCache.get(p.id);
  return hit ? hit.value : undefined;
}

// Whether an account's last auth probe found it logged in, as the boot's
// login probe (server.js checkClaudeAuth) and /api/dev/providers leave it here. Load alone cannot
// stand in for this: a logged-out login reads as unknown load, and so does a
// healthy account whose meter has not been fetched yet or whose usage endpoint
// is down. Unknown (never probed) is null.
export function rememberProviderAuth(id, loggedIn) {
  authCache.set(Number(id), loggedIn == null ? null : !!loggedIn);
}

export function cachedProviderAuth(id) {
  const hit = authCache.get(Number(id));
  return hit === undefined ? null : hit;
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
