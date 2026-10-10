// @ts-check
import { createHash } from 'node:crypto';
import { getProvider, providerGroup } from './providerstore.js';
import {
  claudeHomeDir,
  codexHomeDir,
  grokHomeDir,
  claudeUsage,
  claudeUsageAccountMatches,
  codexUsage,
  grokUsage,
  zaiUsage,
  readClaudeAuth,
  readCodexAuth,
  readGrokAuth,
} from './providers.js';

// Spreads sessions over the accounts of one provider group (see providerGroup in
// lib/providerstore.js): a session runs on the member with the most headroom, so
// several logins drain evenly. The pick is synchronous (createDevSession is), so it
// reads cached usage and refreshes stale entries in the background.

// Claude's usage endpoint allows a login very few reads, shared with its own CLI;
// polling every minute gets the account locked out for most of an hour.
const USAGE_TTL_MS = 15 * 60_000;
// A manual refresh (server.js `fresh=1`) still serves a read this recent, so repeated
// clicks or several clients asking at once cost one request per account.
export const FRESH_USAGE_TTL_MS = 5 * 60_000;
// provider id -> { at, value, retryAt? } | { at, pending, value: the last one, last: that entry }
const usageCache = new Map();
const unavailableUsage = new Set();
const claudeIdentityChecks = new Map();
// Where settled reads are kept across restarts (restoreProviderUsage); null until wired.
let updateUsage = null;
let saving = Promise.resolve();
const reading = new Set();
let stoppingUsage = false;
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
export function readProviderUsage(p, measured = (_provider) => {}) {
  return prepareUsageRead(p, measured)();
}

// Capture identity before cache lookup, then dispatch with that same snapshot.
function prepareUsageRead(p, measured) {
  if (p.apiKey) return () => (zaiHost(p.baseUrl) ? zaiUsage(p.baseUrl, p.apiKey) : Promise.resolve(null));
  // The meter and its identity must use the same snapshot, even if a CLI login
  // replaces the file while the request is in flight.
  if (p.binary === 'claude') {
    const dir = claudeHomeDir(p);
    const authData = readClaudeAuth(dir);
    measured({ ...p, authData });
    return () => claudeUsage(dir, authData);
  }
  if (p.binary === 'codex' && !p.baseUrl) {
    const dir = codexHomeDir(p);
    const authData = readCodexAuth(dir);
    measured({ ...p, authData });
    return () => codexUsage(dir, authData);
  }
  if (p.binary === 'grok') {
    const dir = grokHomeDir(p);
    const authData = readGrokAuth(dir);
    measured({ ...p, authData });
    return () => grokUsage(dir, authData);
  }
  return () => Promise.resolve(null);
}

// Hash only the configuration that identifies the metered account. Credentials stay
// out of the persisted setting; label/model changes do not invalidate quota readings.
// Known OAuth identities survive token rotation; unknown login formats still use
// the credentials so a different account cannot inherit their usage.
function usageAccount(p) {
  const auth = p.authData;
  if (p.binary === 'claude') {
    const account = auth?.settings?.oauthAccount;
    if (account?.accountUuid)
      return { accountUuid: account.accountUuid, organizationUuid: account.organizationUuid || '' };
  }
  if (p.binary === 'codex') {
    try {
      const token = auth?.auth?.tokens?.access_token;
      const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
      const identity = claims['https://api.openai.com/auth'];
      const account = identity?.chatgpt_account_id;
      const user = identity?.chatgpt_user_id || identity?.user_id;
      if (account && user) return { accountId: account, userId: user };
    } catch {
      // Missing or unrecognised tokens retain credential-based invalidation.
    }
  }
  return auth ?? null;
}

function usageFingerprint(p) {
  const canonical = (value) => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object')
      return Object.fromEntries(
        Object.keys(value)
          .sort()
          .map((key) => [key, canonical(value[key])]),
      );
    return value;
  };
  return createHash('sha256')
    .update(JSON.stringify([p.binary, p.baseUrl || '', p.apiKey || '', canonical(usageAccount(p))]))
    .digest('hex');
}

function matchingUsage(p) {
  const hit = usageCache.get(p.id);
  return hit?.fingerprint === usageFingerprint(p) ? hit : undefined;
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
export function providerUsage(p, options = {}) {
  if (stoppingUsage) return Promise.resolve(cachedProviderUsage(p) ?? null);
  const operation = fetchProviderUsage(p, options);
  reading.add(operation);
  operation.finally(() => reading.delete(operation)).catch(() => {});
  return operation;
}

async function fetchProviderUsage(p, { read = readProviderUsage, ttlMs = USAGE_TTL_MS } = {}) {
  const measuredAt = performance.timeOrigin + performance.now();
  const configuredFingerprint = usageFingerprint(p);
  let measuredProvider = p;
  const prepared =
    read === readProviderUsage ? prepareUsageRead(p, (snapshot) => (measuredProvider = snapshot)) : null;
  if (
    prepared &&
    measuredProvider !== p &&
    measuredProvider.binary === 'claude' &&
    measuredProvider.authData?.settings?.oauthAccount?.accountUuid
  ) {
    const auth = measuredProvider.authData;
    const key = createHash('sha256')
      .update(
        JSON.stringify([
          auth.credentials?.claudeAiOauth?.accessToken,
          auth.settings.oauthAccount.accountUuid,
          auth.settings.oauthAccount.organizationUuid || '',
        ]),
      )
      .digest('hex');
    let check = claudeIdentityChecks.get(p.id);
    if (check?.key !== key || (!check.valid && Date.now() - check.at >= FRESH_USAGE_TTL_MS)) {
      check = {
        key,
        at: Date.now(),
        valid: false,
        pending: claudeUsageAccountMatches(measuredProvider.authData),
      };
      claudeIdentityChecks.set(p.id, check);
    }
    const valid = await check.pending;
    const current = getProvider(p.id);
    if (
      claudeIdentityChecks.get(p.id) !== check ||
      !current ||
      ![configuredFingerprint, usageFingerprint(measuredProvider)].includes(usageFingerprint(current))
    )
      return null;
    if (!(check.valid = valid)) {
      unavailableUsage.add(p.id);
      return null;
    }
  }
  // An unreadable login snapshot identifies no account. Leave its previous
  // reading intact, but return unknown usage until credentials can be read again.
  if (
    prepared &&
    measuredProvider !== p &&
    !measuredProvider.authData &&
    usageCache.get(p.id)?.fingerprint &&
    usageCache.get(p.id).fingerprint !== usageFingerprint(measuredProvider)
  ) {
    unavailableUsage.add(p.id);
    return null;
  }
  unavailableUsage.delete(p.id);
  const fingerprint = usageFingerprint(measuredProvider);
  const hit = matchingUsage(measuredProvider);
  if (hit?.pending) return hit.pending;
  if (
    hit &&
    ((hit.retryAt && Date.now() < Date.parse(hit.retryAt)) || (ttlMs > 0 && Date.now() - hit.at < ttlMs))
  ) {
    persistUsage(p.id);
    return hit.value;
  }
  let measuredFingerprint = fingerprint;
  const pending = (
    prepared ? prepared() : read(p, (snapshot) => (measuredFingerprint = usageFingerprint(snapshot)))
  )
    .catch(() => null)
    .then((value) => withLastWindows(value, measuredFingerprint === fingerprint ? hit?.value : null));
  const entry = { at: Date.now(), measuredAt, fingerprint, pending, value: hit?.value, last: hit };
  usageCache.set(p.id, entry);
  const value = await pending;
  if (
    usageCache.get(p.id) === entry &&
    getProvider(p.id) &&
    [configuredFingerprint, measuredFingerprint].includes(usageFingerprint(getProvider(p.id)))
  ) {
    usageCache.set(p.id, {
      at: performance.timeOrigin + performance.now(),
      measuredAt,
      fingerprint: measuredFingerprint,
      value,
      ...(value?.retryAt ? { retryAt: value.retryAt } : {}),
    });
    persistUsage(p.id);
  } else if (usageCache.get(p.id) === entry) {
    usageCache.delete(p.id);
  }
  return value;
}

// Seeds the cache with what the last process read, and keeps every later read there, so a
// restart neither re-reads each account nor forgets a 429's retryAt (a read inside the
// lockout extends it). `load` reads the stored entries; `update(fn)` hands fn the stored
// entries to change in place and writes them back atomically (server.js: an app setting
// under a row lock), since another server sharing the database writes them too.
// update(fn, id) passes fn the current provider, locked until the write commits.
export async function restoreProviderUsage({ load, update }) {
  const saved = await Promise.resolve()
    .then(load)
    .catch(() => null);
  for (const [key, e] of Object.entries(saved || {})) {
    const id = Number(key);
    if (!Number.isFinite(id) || !e || !Number.isFinite(e.at) || usageCache.has(id)) continue;
    if ((e.measuredAt ?? e.at) <= Math.max(saved._invalidated?.[id] || 0, saved._invalidated?.all || 0))
      continue;
    usageCache.set(id, {
      at: e.at,
      measuredAt: e.measuredAt ?? e.at,
      fingerprint: e.fingerprint,
      value: e.value ?? null,
      ...(e.retryAt ? { retryAt: e.retryAt } : {}),
    });
  }
  updateUsage = update;
}

// Stores one account's settled entry, or drops it (or every entry, id null) after a
// forget, leaving the other accounts' entries as they are in storage: another server
// may have saved newer ones (a lockout) this process never read. A stored entry newer
// than ours stays too. One write at a time; a failed write only costs a read after a restart.
function persistUsage(id, forget = false) {
  if (!updateUsage) return;
  const update = updateUsage;
  // Sub-millisecond ordering also protects measurements made in the same tick.
  const forgottenAt = forget ? performance.timeOrigin + performance.now() : null;
  saving = saving
    .then(() => {
      const hit = id == null ? null : usageCache.get(id);
      const e = hit?.pending ? hit.last : hit;
      return update((stored, current = getProvider(id)) => {
        if (forget) {
          const invalidated = (stored._invalidated ||= {});
          const key = id == null ? 'all' : id;
          invalidated[key] = Math.max(invalidated[key] || 0, forgottenAt);
          for (const key of Object.keys(stored))
            if (
              key !== '_invalidated' &&
              (id == null || Number(key) === id) &&
              !((stored[key]?.measuredAt ?? stored[key]?.at) > invalidated[id == null ? 'all' : id])
            )
              delete stored[key];
        } else if (
          e &&
          !e.pending &&
          current &&
          (e.measuredAt ?? e.at) > Math.max(stored._invalidated?.[id] || 0, stored._invalidated?.all || 0) &&
          usageFingerprint(current) === e.fingerprint &&
          !(
            stored[id]?.fingerprint === e.fingerprint &&
            (stored[id]?.at > e.at ||
              ((!e.value || (e.value.error && !e.retryAt)) && Date.parse(stored[id]?.retryAt) > Date.now()))
          )
        ) {
          stored[id] = {
            at: e.at,
            measuredAt: e.measuredAt ?? e.at,
            fingerprint: e.fingerprint,
            value: e.value ?? null,
            ...(e.retryAt ? { retryAt: e.retryAt } : {}),
          };
        }
      }, id);
    })
    .catch(() => {});
}

// Drains read producers before their queued writes, within one shutdown bound.
export function flushProviderUsage(timeoutMs = 2000, { shutdown = false } = {}) {
  if (shutdown) stoppingUsage = true;
  let timer;
  const timeout = new Promise((r) => (timer = setTimeout(r, timeoutMs)));
  const drain = async () => {
    await Promise.allSettled([...reading]);
    let writes;
    do {
      writes = saving;
      await writes;
    } while (writes !== saving);
  };
  return Promise.race([drain(), timeout]).finally(() => clearTimeout(timer));
}

// Only a refusal with a retryAt keeps the previous windows; any other failure is
// reported as is, so a logged-out account does not keep looking healthy.
function withLastWindows(value, last) {
  if (!value?.retryAt || !last?.windows?.length) return value;
  return { ...value, windows: last.windows, stale: true };
}

// The last resolved value (never a promise) for the synchronous pick.
export function cachedProviderUsage(p) {
  if (unavailableUsage.has(p.id)) return undefined;
  const hit = matchingUsage(p);
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
    unavailableUsage.clear();
    claudeIdentityChecks.clear();
    authCache.clear();
    exhaustedUntil.clear();
  } else {
    usageCache.delete(Number(id));
    unavailableUsage.delete(Number(id));
    claudeIdentityChecks.delete(Number(id));
    authCache.delete(Number(id));
    exhaustedUntil.delete(Number(id));
  }
  persistUsage(id == null ? null : Number(id), true);
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
