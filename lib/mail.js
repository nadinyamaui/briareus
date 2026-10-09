// @ts-check
// Mail, synced from Gmail and Outlook so a client can read it through
// /api/v1: the operator connects a mailbox with the provider's own sign-in,
// and the server keeps a rolling window of its messages (the last `syncDays`
// days) in its database, brought up to date every few minutes, so reading,
// searching and paging never wait on Google or Microsoft.
//
// The sign-in is OAuth with PKCE. `connectStart` hands out the address to
// sign in at, and the provider sends the browser on to the redirect URI
// registered with it, with a `code` and the `state` in the query. Two ways
// finish it, both through `connectFinish`:
// - the redirect is this server's own MAIL_CALLBACK_PATH on PUBLIC_BASE_URL,
//   the providers' documented web-server flow: the browser brings the code
//   here and the exchange happens at once (lib/mail-routes.js);
// - or a client receives the redirect itself (a loopback listener of its own,
//   or a web view it embeds) and sends the address on through the API.
// The state is single-use and lives in memory for fifteen minutes, so a
// restart in between asks for a new start. The code itself lasts less:
// Microsoft's "typically" about a minute.
//
// Tokens are stored sealed under CREDENTIALS_KEY (lib/secretbox.js) and never
// leave the server. Connections default to read-only; access: manage opts
// into sending and filing. Operator settings are admin-only; interactive
// session tools use the guarded routes in mail-agent.js.

import crypto from 'node:crypto';
import { mailAction } from './mail-actions.js';
import { getConfig } from './config.js';
import { seal, open } from './secretbox.js';
import {
  countMailMessages,
  deleteMailAccount,
  deleteMailMessages,
  deleteMailMessagesOutsideFolders,
  deleteMailMessagesReceivedBefore,
  deleteMailMessagesSyncedBefore,
  getMailMessage,
  insertMailAccount,
  listMailMessages,
  loadMailAccountRows,
  renameMailFolder,
  renameMailLabels,
  updateMailAccount,
  updateMailMessageFlags,
  upsertMailMessages,
} from './db.js';
import { MAIL_PROVIDERS, gmailProvider, outlookProvider } from './mail-providers.js';

export const MAIL_ACCOUNT_DEFAULTS = { label: '', enabled: true, syncDays: 30 };
// Where a sign-in may end on this server, under PUBLIC_BASE_URL. Outside
// /api: the browser that signed in brings it here with no token, and the
// single-use `state` is what it is judged by.
export const MAIL_CALLBACK_PATH = '/oauth/mail/callback';

const DAY = 24 * 3600_000;
const MAX_SYNC_DAYS = 365;
// Long enough to sign in with a second factor, short enough that a link left
// in a chat is dead by the time anybody finds it.
const CONNECT_TTL = 15 * 60_000;
const MAX_PENDING = 20;
const PAGE = 50;
const MAX_PAGE = 100;
// The first periodic pass after boot waits this long, so it does not compete
// with the server's own start.
const FIRST_PASS_DELAY = 15_000;

const DB_STORE = {
  loadAccounts: loadMailAccountRows,
  insertAccount: insertMailAccount,
  updateAccount: updateMailAccount,
  deleteAccount: deleteMailAccount,
  upsert: upsertMailMessages,
  flags: updateMailMessageFlags,
  remove: deleteMailMessages,
  pruneOlder: deleteMailMessagesReceivedBefore,
  pruneUnseen: deleteMailMessagesSyncedBefore,
  keepFolders: deleteMailMessagesOutsideFolders,
  renameLabels: renameMailLabels,
  renameFolder: renameMailFolder,
  list: listMailMessages,
  get: getMailMessage,
  counts: countMailMessages,
};

/** @param {string} message @param {number} status */
function httpError(message, status) {
  return Object.assign(new Error(message), { status });
}

// What a body may change, checked against what it would change: a label, the
// switch, and the window.
/** @param {Record<string, any>} input @param {{ label: string, enabled: boolean, syncDays: number }} existing */
function normalizeSettings(input, existing) {
  const s = { label: existing.label, enabled: existing.enabled, syncDays: existing.syncDays };
  if (Object.hasOwn(input, 'label')) s.label = String(input.label ?? '').trim();
  if (s.label.length > 200) throw httpError('Label too long', 400);
  if (Object.hasOwn(input, 'enabled')) {
    if (typeof input.enabled !== 'boolean') throw httpError('`enabled` is true or false', 400);
    s.enabled = input.enabled;
  }
  if (Object.hasOwn(input, 'syncDays')) {
    const days = Number(input.syncDays);
    if (!Number.isInteger(days) || days < 1 || days > MAX_SYNC_DAYS)
      throw httpError(`\`syncDays\` is a whole number of days, 1–${MAX_SYNC_DAYS}`, 400);
    s.syncDays = days;
  }
  return s;
}

/** @param {unknown} value */
function flag(value) {
  if (value == null || value === '') return undefined;
  if (value === '1' || value === 'true') return true;
  if (value === '0' || value === 'false') return false;
  throw httpError('A filter is 1 or 0', 400);
}

/** @param {[number, number, string]} cursor */
const encodeCursor = (cursor) => Buffer.from(JSON.stringify(cursor)).toString('base64url');

/** @param {unknown} text @returns {[number, number, string]} */
function decodeCursor(text) {
  try {
    const c = JSON.parse(Buffer.from(String(text), 'base64url').toString('utf8'));
    if (
      Array.isArray(c) &&
      c.length === 3 &&
      Number.isFinite(c[0]) &&
      Number.isFinite(c[1]) &&
      typeof c[2] === 'string'
    )
      return /** @type {[number, number, string]} */ (c);
  } catch {
    /* answered below */
  }
  throw httpError('Pass back a `nextCursor` as it was given', 400);
}

/**
 * @param {{
 *   config?: () => { syncMinutes: number, google: any, microsoft: any },
 *   store?: typeof DB_STORE,
 *   request?: typeof fetch,
 *   sleep?: (ms: number) => Promise<unknown>,
 *   now?: () => number,
 *   log?: { error: (...args: any[]) => void },
 *   callbackUrl?: () => string,
 * }} [deps]
 */
export function createMailService({
  config = () => getConfig().mail,
  callbackUrl = () => `${getConfig().publicBaseUrl}${MAIL_CALLBACK_PATH}`,
  store = DB_STORE,
  request = fetch,
  sleep,
  now = Date.now,
  log = console,
} = {}) {
  /** @type {Map<number, Record<string, any>>} */
  const accounts = new Map();
  // Each account's pass, with the window generation it started on.
  /** @type {Map<number, { task: Promise<void>, generation: number }>} */
  const running = new Map();
  // The pass to start once one for an older window or grant has ended.
  /** @type {Map<number, Promise<void>>} */
  const following = new Map();
  // Bumped when an account's window changes or its grant is replaced under a
  // running pass: that pass is no longer the one asked for, so it saves no
  // cursor for the old window over the reset, and its failure is not the
  // account's; the pass that follows it answers for both.
  /** @type {Map<number, number>} */
  const generations = new Map();
  // The tail of each account's writes (persist).
  /** @type {Map<number, Promise<unknown>>} */
  const writing = new Map();
  /** @type {Map<string, { provider: string, accountId: number | null, input: Record<string, any>, verifier: string, expiresAt: number }>} */
  const pending = new Map();
  /** @type {NodeJS.Timeout | null} */
  let timer = null;
  /** @type {Promise<void> | null} */
  let sweeping = null;

  /** @param {string} id */
  function providerFor(id, manage = false) {
    const cfg = config();
    if (id === 'gmail' && cfg.google) return gmailProvider(cfg.google, { request, sleep, manage });
    if (id === 'outlook' && cfg.microsoft) return outlookProvider(cfg.microsoft, { request, sleep, manage });
    return null;
  }

  /** @param {unknown} id */
  function accountOf(id) {
    const a = accounts.get(Number(id));
    if (!a) throw httpError('Mail account not found', 404);
    return a;
  }

  // What leaves the service: the sealed tokens and the provider's cursor stay.
  /**
   * @param {Record<string, any>} a @param {Map<number, { messages: number, unread: number }>} [counts]
   * @returns {Record<string, any>}
   */
  function publicAccount(a, counts) {
    const { credentials, syncState, ...rest } = a;
    const n = counts?.get(a.id);
    return {
      ...rest,
      access: JSON.parse(open(credentials)).access || 'read',
      syncing: running.has(a.id),
      messages: n?.messages ?? 0,
      unread: n?.unread ?? 0,
    };
  }

  // An account's writes land one at a time, and each works out what to
  // write only once the one before it has landed: a pass's cursor, a
  // refreshed token or a settings change decided on what the account held
  // earlier would otherwise land over a newer write. `decide` answers the
  // changes, or null to write nothing; an account removed meanwhile gets none.
  // `write` lands them: the account's row alone, unless it is given.
  /**
   * @param {Record<string, any>} a @param {() => Record<string, any> | null} decide
   * @param {(changes: Record<string, any>) => Promise<unknown>} [write]
   * @returns {Promise<void>}
   */
  function persist(a, decide, write = (changes) => store.updateAccount(a.id, changes)) {
    const turn = (writing.get(a.id) || Promise.resolve()).then(async () => {
      const changes = accounts.get(a.id) === a ? decide() : null;
      if (!changes) return;
      await write(changes);
      Object.assign(a, changes, { updatedAt: now() });
    });
    const tail = turn.catch(() => {});
    writing.set(a.id, tail);
    void tail.then(() => {
      if (writing.get(a.id) === tail) writing.delete(a.id);
    });
    return turn;
  }

  // The access token to call with, refreshed when it is about to lapse or when
  // the provider has just refused it. A refresh the provider answers with
  // invalid_grant marks the account for reconnecting.
  /** @param {Record<string, any>} a @param {any} provider @param {boolean} force */
  async function accessToken(a, provider, force) {
    const sealed = a.credentials;
    const creds = JSON.parse(open(sealed));
    if (!force && creds.accessToken && creds.expiresAt - 60_000 > now()) return creds.accessToken;
    let t;
    try {
      t = await providerFor(a.provider, creds.access === 'manage').refresh(creds.refreshToken);
    } catch (e) {
      // The grant refused is the one this pass started with; a reconnect
      // since has replaced it and must not be marked for reconnecting.
      const err = /** @type {any} */ (e);
      if (err.reauth) {
        if (a.credentials !== sealed)
          throw httpError('The account was connected again during this sync', 409);
        err.refused = sealed;
      }
      throw e;
    }
    // Microsoft hands out a new refresh token with every refresh; Google keeps the first.
    const next = {
      ...creds,
      refreshToken: t.refreshToken || creds.refreshToken,
      accessToken: t.accessToken,
      expiresAt: now() + t.expiresIn * 1000,
    };
    // A reconnect while this refresh was out stored newer tokens: keep those.
    await persist(a, () => (a.credentials === sealed ? { credentials: seal(JSON.stringify(next)) } : null));
    return next.accessToken;
  }

  /** @param {Record<string, any>} a */
  async function runSync(a) {
    const provider = providerFor(a.provider);
    if (!provider) return;
    const id = a.id;
    const startedAt = now();
    /** @type {Map<string, number>} */
    const folderMarkers = new Map();
    const generation = generations.get(id) || 0;
    const since = startedAt - a.syncDays * DAY;
    // A removed account stops its pass at the next write, so nothing is
    // written for an account that is no longer there.
    const live = () => {
      if (accounts.get(id) !== a) throw httpError('The mail account was removed', 410);
    };
    const sink = {
      /** @param {any[]} rows */
      upsert: async (rows) => {
        live();
        // Reread messages can belong to a different folder than the delta
        // that named them. Stamp them with their current folder's marker,
        // preserving write order when a batch spans different markers.
        for (let at = 0; at < rows.length;) {
          const marker = folderMarkers.get(rows[at].folderId) ?? startedAt;
          let end = at + 1;
          while (end < rows.length && (folderMarkers.get(rows[end].folderId) ?? startedAt) === marker) end++;
          await store.upsert(id, rows.slice(at, end), marker);
          at = end;
        }
      },
      /** @param {string} messageId @param {any} flags */
      flags: async (messageId, flags) => {
        live();
        return store.flags(id, messageId, flags, startedAt);
      },
      /** @param {string[]} ids @param {string | null} [folderId] */
      remove: async (ids, folderId = null) => {
        live();
        if (ids.length) await store.remove(id, ids, folderId);
      },
      /** @param {string | null} [folderId] */
      pruneUnseen: async (folderId = null) => {
        live();
        await store.pruneUnseen(id, folderMarkers.get(folderId) ?? startedAt, folderId);
      },
      // Abandoned delta pages must not count as observations in the new
      // snapshot. Advance even if the clock has not ticked, and only for
      // this folder: other folders keep their own observations.
      /** @param {string} folderId */
      restartFolder: async (folderId) => {
        live();
        folderMarkers.set(folderId, Math.max(now(), (folderMarkers.get(folderId) ?? startedAt) + 1));
      },
      /** @param {string[]} folderIds */
      keepFolders: async (folderIds) => {
        live();
        await store.keepFolders(id, folderIds);
      },
      // The renames land with the names they lead to in the sync state, in
      // one write: a pass that fails after it finds nothing left to rename,
      // where mapping the rows again would undo a swap. A window reset
      // meanwhile writes neither, as the next pass takes every message anew.
      /** @param {[string, string][]} renames @param {Record<string, string>} labels */
      renameLabels: async (renames, labels) => {
        live();
        await persist(
          a,
          () =>
            (generations.get(id) || 0) === generation ? { syncState: { ...a.syncState, labels } } : null,
          (changes) => store.renameLabels(id, renames, changes),
        );
      },
      /** @param {string} folderId @param {string} name */
      renameFolder: async (folderId, name) => {
        live();
        await store.renameFolder(id, folderId, name);
      },
    };
    try {
      const api = provider.api((/** @type {boolean} */ force) => accessToken(a, provider, force));
      const state = await provider.sync({ api, state: a.syncState, since, sink, email: a.email });
      live();
      await store.pruneOlder(id, since);
      await persist(a, () => ({
        lastSyncAt: now(),
        lastSyncError: null,
        ...((generations.get(id) || 0) === generation ? { syncState: state } : {}),
      }));
    } catch (e) {
      if (accounts.get(id) !== a) return;
      const err = /** @type {any} */ (e);
      await persist(a, () => {
        // A refused grant that is still the account's is marked whatever
        // else changed meanwhile; it would be refused again.
        const reauth = err.reauth && a.credentials === err.refused;
        if (!reauth && (generations.get(id) || 0) !== generation) return null;
        return {
          lastSyncError: String(err.message || err).slice(0, 1000),
          ...(reauth ? { status: 'reauth' } : {}),
        };
      }).catch(() => {});
      throw e;
    }
  }

  // One pass per account at a time: a manual sync while the timer's is
  // running joins it. A pass that started on an older window or grant is not
  // the one asked for, so the request waits for it to end and starts
  // another, which any request after it joins.
  /** @param {Record<string, any>} a @returns {Promise<void>} */
  function syncNow(a) {
    const generation = generations.get(a.id) || 0;
    const current = running.get(a.id);
    if (current && current.generation === generation) return current.task;
    if (current) {
      let next = following.get(a.id);
      if (!next) {
        next = current.task.then(() => {
          following.delete(a.id);
          if (accounts.get(a.id) === a && a.status === 'connected') return syncNow(a);
        });
        following.set(a.id, next);
      }
      return next;
    }
    const task = runSync(a)
      .catch((e) => log.error(`Mail sync of ${a.email} failed:`, e.message))
      .finally(() => running.delete(a.id));
    running.set(a.id, { task, generation });
    return task;
  }

  async function syncAll() {
    for (const a of [...accounts.values()]) {
      if (!a.enabled || a.status !== 'connected' || !providerFor(a.provider)) continue;
      await syncNow(a);
    }
  }

  return {
    async init() {
      accounts.clear();
      for (const a of await store.loadAccounts()) accounts.set(a.id, a);
    },
    // Syncs every enabled account every MAIL_SYNC_MINUTES, one after another.
    start() {
      const minutes = config().syncMinutes;
      if (!minutes || timer) return;
      const sweep = () => {
        if (!sweeping) sweeping = syncAll().finally(() => (sweeping = null));
      };
      timer = setInterval(sweep, minutes * 60_000);
      timer.unref();
      setTimeout(sweep, FIRST_PASS_DELAY).unref();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
    // Which providers this server can connect: those whose OAuth client is set.
    providers() {
      return MAIL_PROVIDERS.filter((p) => providerFor(p));
    },
    // The redirect URI to register for a sign-in this server finishes itself.
    callbackUrl,
    async list() {
      const counts = await store.counts();
      return [...accounts.values()].map((a) => publicAccount(a, counts));
    },

    /** @param {Record<string, any>} input */
    connectStart(input) {
      const providerId = String(input.provider ?? '');
      if (!MAIL_PROVIDERS.includes(providerId)) throw httpError('Choose `gmail` or `outlook`', 400);
      const access = input.access ?? 'read';
      if (!['read', 'manage'].includes(access)) throw httpError('Choose `read` or `manage` access', 400);
      const provider = providerFor(providerId, access === 'manage');
      if (!provider)
        throw httpError(
          `${providerId === 'gmail' ? 'GOOGLE_OAUTH_*' : 'MICROSOFT_OAUTH_*'} is not set on this server`,
          503,
        );
      // The tokens will be sealed; finding out CREDENTIALS_KEY is missing
      // after the sign-in would waste it.
      seal('');
      let existing = null;
      if (input.accountId != null) {
        existing = accountOf(input.accountId);
        if (existing.provider !== providerId)
          throw httpError(`That account is not a ${provider.name} one`, 400);
      }
      const settings = { access };
      for (const key of ['label', 'enabled', 'syncDays'])
        if (Object.hasOwn(input, key)) settings[key] = input[key];
      normalizeSettings(settings, existing || MAIL_ACCOUNT_DEFAULTS);

      for (const [key, p] of pending) if (p.expiresAt <= now()) pending.delete(key);
      while (pending.size >= MAX_PENDING) pending.delete(/** @type {string} */ (pending.keys().next().value));
      const state = crypto.randomBytes(24).toString('base64url');
      const verifier = crypto.randomBytes(32).toString('base64url');
      const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
      const expiresAt = now() + CONNECT_TTL;
      pending.set(state, {
        provider: providerId,
        accountId: existing ? existing.id : null,
        input: settings,
        verifier,
        expiresAt,
      });
      return {
        url: provider.authorizeUrl({ state, challenge, loginHint: existing?.email }),
        state,
        redirectUri: provider.redirectUri,
        // Whether the browser brings the code to this server, so a client only
        // waits for the account to appear rather than sending it on.
        finishesOnServer: provider.redirectUri === callbackUrl(),
        expiresAt,
      };
    },

    /** @param {Record<string, any>} input */
    async connectFinish(input) {
      let state = input.state == null ? '' : String(input.state);
      let code = input.code == null ? '' : String(input.code);
      if (input.url != null) {
        let url;
        try {
          url = new URL(String(input.url));
        } catch {
          throw httpError('Send the whole address the sign-in ended on, as `url`', 400);
        }
        const params = new URLSearchParams(url.search);
        if (!params.has('code') && !params.has('error') && url.hash)
          for (const [k, v] of new URLSearchParams(url.hash.slice(1))) params.set(k, v);
        if (params.get('error'))
          throw httpError(
            `The sign-in did not finish: ${params.get('error_description') || params.get('error')}`,
            400,
          );
        state = params.get('state') || '';
        code = params.get('code') || '';
      }
      const started = pending.get(state);
      // Single use, whatever happens next: a code is good for one exchange.
      pending.delete(state);
      if (!started || started.expiresAt <= now())
        throw httpError('This sign-in has expired or was already used; start it again', 400);
      if (!code) throw httpError('The address has no `code`; send the one the sign-in ended on', 400);
      const provider = providerFor(started.provider, started.input.access === 'manage');
      if (!provider) throw httpError('This provider is no longer set up on this server', 503);

      const tokens = await provider.exchange(code, started.verifier);
      const { email } = await provider.profile(provider.api(async () => tokens.accessToken));
      if (!email) throw httpError(`${provider.name} did not say which mailbox this is`, 502);
      const credentials = seal(
        JSON.stringify({
          ...(started.input.access === 'manage' ? { access: 'manage' } : {}),
          refreshToken: tokens.refreshToken,
          accessToken: tokens.accessToken,
          expiresAt: now() + tokens.expiresIn * 1000,
        }),
      );

      const same = (/** @type {Record<string, any>} */ a) =>
        a.provider === started.provider && a.email.toLowerCase() === email.toLowerCase();
      let account =
        started.accountId != null ? accounts.get(started.accountId) : [...accounts.values()].find(same);
      if (started.accountId != null && !account) throw httpError('Mail account not found', 404);
      if (account && !same(account))
        throw httpError(
          `You signed in as ${email}, but this account is ${account.email}: sign in with that mailbox, or connect ${email} on its own`,
          409,
        );
      if (account) {
        const target = account;
        await persist(target, () => {
          const settings = normalizeSettings(started.input, /** @type {any} */ (target));
          const reset = settings.syncDays !== target.syncDays;
          // A pass still on the old grant is not a sync of this one, even
          // on the same window: the sync below follows it rather than joins.
          generations.set(target.id, (generations.get(target.id) || 0) + 1);
          return {
            ...settings,
            credentials,
            status: 'connected',
            lastSyncError: null,
            ...(reset ? { syncState: null } : {}),
          };
        });
      } else {
        const settings = normalizeSettings(started.input, MAIL_ACCOUNT_DEFAULTS);
        try {
          account = await store.insertAccount({
            provider: started.provider,
            email,
            ...settings,
            credentials,
            status: 'connected',
          });
        } catch (e) {
          if (/** @type {any} */ (e).code === 'ER_DUP_ENTRY')
            throw httpError(`${email} is being connected already`, 409);
          throw e;
        }
        accounts.set(/** @type {any} */ (account).id, /** @type {any} */ (account));
      }
      const connected = /** @type {Record<string, any>} */ (account);
      if (connected.enabled) void syncNow(connected);
      return publicAccount(connected, await store.counts());
    },

    /** @param {number} id @param {Record<string, any>} input */
    async update(id, input) {
      const a = accountOf(id);
      // Checked at once, so a bad body is refused without waiting; applied
      // to what the account holds once the writes before it have landed.
      normalizeSettings(input, /** @type {any} */ (a));
      let reset = false;
      await persist(a, () => {
        const settings = normalizeSettings(input, /** @type {any} */ (a));
        // A new window is a new first pass: the cursor was taken for the old one.
        reset = settings.syncDays !== a.syncDays;
        if (reset) generations.set(a.id, (generations.get(a.id) || 0) + 1);
        return { ...settings, ...(reset ? { syncState: null } : {}) };
      });
      if (reset && a.enabled && a.status === 'connected') void syncNow(a);
      return publicAccount(a, await store.counts());
    },

    // The account, its tokens and every message synced from it. The provider
    // still lists the app as having access until it is removed there too.
    /** @param {number} id */
    async remove(id) {
      const a = accountOf(id);
      accounts.delete(a.id);
      await running.get(a.id)?.task;
      try {
        await store.deleteAccount(a.id);
      } catch (e) {
        accounts.set(a.id, a);
        throw e;
      }
      generations.delete(a.id);
    },

    // Starts a pass now and answers before it ends; `syncing` and
    // `lastSyncAt` on the account say when it has.
    /** @param {number} id */
    async sync(id) {
      const a = accountOf(id);
      if (a.status !== 'connected') throw httpError('Connect this account again before syncing it', 409);
      if (!providerFor(a.provider)) throw httpError(`${a.provider} is no longer set up on this server`, 503);
      void syncNow(a);
      return publicAccount(a, await store.counts());
    },

    // Only explicitly requested, bounded operations; credentials stay here.
    /** @param {number} accountId @param {Record<string, any>} input */
    async action(accountId, input) {
      const a = accountOf(accountId);
      const creds = JSON.parse(open(a.credentials));
      if (creds.access !== 'manage')
        throw httpError('Reconnect this mailbox with access: manage to send or file mail', 403);
      if (a.status !== 'connected') throw httpError('Reconnect this mailbox first', 409);
      const provider = providerFor(a.provider, true);
      if (!provider) throw httpError('This mail provider is no longer configured', 503);
      const result = await mailAction({
        provider: a.provider,
        email: a.email,
        input,
        request,
        token: (force) => accessToken(a, provider, force),
      });
      // Sync the authoritative provider state after the action, including folder moves.
      void syncNow(a);
      return result;
    },

    /** @param {Record<string, any>} query */
    async messages(query) {
      let accountIds = [...accounts.keys()];
      if (query.account != null && query.account !== '') accountIds = [accountOf(query.account).id];
      const limit = query.limit == null || query.limit === '' ? PAGE : Number(query.limit);
      if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE)
        throw httpError(`\`limit\` is 1–${MAX_PAGE}`, 400);
      const q = query.q == null ? '' : String(query.q).trim();
      if (q.length > 200) throw httpError('Search for 200 characters at most', 400);
      const rows = await store.list({
        accountIds,
        q,
        unread: flag(query.unread),
        inbox: flag(query.inbox),
        starred: flag(query.starred),
        label: query.label ? String(query.label) : '',
        threadId: query.thread ? String(query.thread) : '',
        cursor: query.cursor ? decodeCursor(query.cursor) : null,
        limit: limit + 1,
      });
      const page = rows.slice(0, limit);
      const last = page.at(-1);
      return {
        messages: page,
        nextCursor:
          rows.length > limit && last ? encodeCursor([last.receivedAt, last.accountId, last.id]) : null,
      };
    },

    /** @param {number} accountId @param {string} id */
    async message(accountId, id) {
      const a = accountOf(accountId);
      const m = await store.get(a.id, String(id));
      if (!m) throw httpError('Message not found', 404);
      return m;
    },
  };
}
