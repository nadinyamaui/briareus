// @ts-check
// Gmail and Outlook (Microsoft Graph) for the mail sync (lib/mail.js). Each
// provider is the same five things: the address its sign-in starts at, the
// exchange of the code that sign-in ends with for tokens, the refresh of
// those tokens, which mailbox they open, and one sync pass over it.
//
// A sync pass never holds a mailbox in memory: it hands what it reads to a
// sink as it goes (upsert, remove, flags, prune), which the service writes
// through to the database, and resolves to the state the next pass starts
// from (Gmail's historyId, a Graph deltaLink per folder).
//
// Sign-ins allow reading and moving a selected message to trash.

import {
  clip,
  decodeCharset,
  decodeEntities,
  decodeWords,
  htmlToText,
  parseAddressList,
} from './mail-parse.js';

export const MAIL_PROVIDERS = ['gmail', 'outlook'];

/** @param {string} message @param {number} status @param {Record<string, unknown>} [extra] */
function httpError(message, status, extra = {}) {
  return Object.assign(new Error(message), { status, ...extra });
}

const defaultSleep = (/** @type {number} */ ms) => new Promise((resolve) => setTimeout(resolve, ms));

// The token endpoint, form-encoded, as both providers take it. `invalid_grant`
// on a refresh means the grant itself is gone (revoked, expired, a password
// change), and Microsoft's `interaction_required` and `consent_required` send
// the user back to /authorize: no retry brings any of them back, only signing
// in again, which `reauth` tells the service.
/**
 * @param {{ request: typeof fetch, url: string, params: Record<string, string>, name: string }} opts
 * @returns {Promise<{ accessToken: string, refreshToken: string | null, expiresIn: number, scope: string | null }>}
 */
async function tokenRequest({ request, url, params, name }) {
  let res;
  try {
    res = await request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams(params).toString(),
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw httpError(`${name} did not answer`, 502);
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) {
    // Microsoft's descriptions carry trace and correlation ids on later lines.
    const detail = String(body.error_description || body.error || `HTTP ${res.status}`).split(/\r?\n/)[0];
    throw httpError(`${name} refused the sign-in: ${detail.slice(0, 300)}`, res.status >= 500 ? 502 : 400, {
      reauth: ['invalid_grant', 'interaction_required', 'consent_required'].includes(body.error),
    });
  }
  return {
    accessToken: String(body.access_token),
    refreshToken: body.refresh_token ? String(body.refresh_token) : null,
    expiresIn: Number(body.expires_in) || 3600,
    // Null when left out, which Microsoft documents as meaning the scopes
    // that were asked for.
    scope: body.scope == null ? null : String(body.scope),
  };
}

// How many times one call is tried again after a failure both providers
// call passing: a request to slow down (429, Gmail's 403 rateLimitExceeded /
// userRateLimitExceeded), a server error (500 backendError, 502, 503, 504) or
// no answer at all.
const MAX_RETRIES = 5;
const MAX_BACKOFF_MS = 64_000;

// A JSON call to a provider's API as the account. A 401 refreshes the token
// once (`token(true)`) and tries again: an access token can be revoked before
// it expires. A transient failure waits as long as the provider's Retry-After
// says, or else backs off exponentially with jitter, as both providers ask
// (truncated at 64 seconds), up to MAX_RETRIES times before the pass gives up
// until the next one. `pace` runs before every attempt, for a provider that
// meters calls by quota.
//
// A failure keeps the provider's status in `upstream`, since a 404 on Gmail's
// history or a 410 on a Graph delta is a cursor gone stale, not an error.
/**
 * @param {{ request: typeof fetch, token: (force: boolean) => Promise<string>, name: string,
 *   sleep: (ms: number) => Promise<unknown>, headers?: Record<string, string>,
 *   pace?: (url: string) => Promise<void> }} opts
 * @returns {(url: string, options?: { method?: string, body?: string }) => Promise<any>}
 */
function apiClient({ request, token, name, sleep, headers = {}, pace = async () => {} }) {
  /** @param {number} retry @param {Response} [res] */
  const backoff = (retry, res) => {
    const after = Number(res?.headers.get('retry-after'));
    return sleep(
      after > 0
        ? Math.min(after * 1000, 2 * MAX_BACKOFF_MS)
        : Math.min(2 ** retry * 1000 + Math.random() * 1000, MAX_BACKOFF_MS),
    );
  };
  return async function api(url, options = {}) {
    const writing = options.method != null && options.method !== 'GET';
    let force = false;
    let refreshed = false;
    for (let retries = 0; ;) {
      await pace(url);
      const bearer = await token(force);
      force = false;
      let res;
      try {
        res = await request(url, {
          ...options,
          headers: {
            Accept: 'application/json',
            ...(options.body ? { 'Content-Type': 'application/json' } : {}),
            ...headers,
            Authorization: `Bearer ${bearer}`,
          },
          signal: AbortSignal.timeout(30_000),
        });
      } catch {
        if (!writing && retries < MAX_RETRIES) {
          await backoff(++retries);
          continue;
        }
        throw httpError(`${name} did not answer`, 502);
      }
      if (res.ok) return res.json();
      const body = await res.json().catch(() => ({}));
      if (res.status === 401 && !refreshed) {
        refreshed = force = true;
        continue;
      }
      const reason = body.error?.errors?.[0]?.reason || '';
      const throttled = res.status === 429 || (res.status === 403 && /rateLimitExceeded/i.test(reason));
      if ((throttled || [500, 502, 503, 504].includes(res.status)) && !writing && retries < MAX_RETRIES) {
        await backoff(++retries, res);
        continue;
      }
      const detail = body.error?.message || body.error_description || `HTTP ${res.status}`;
      const status = res.status === 404 ? 404 : throttled ? 429 : writing && res.status === 403 ? 409 : 502;
      throw httpError(`${name} answered ${res.status}: ${String(detail).slice(0, 300)}`, status, {
        upstream: res.status,
        reason,
        code: body.error?.code ?? null,
      });
    }
  };
}

// Spends a per-minute quota no faster than it refills: a call waits while
// what the last minute spent plus its own cost would pass the limit. One is
// made per sync pass, so it counts only what that pass spends.
/**
 * @param {{ perMinute: number, cost: (url: string) => number, now: () => number,
 *   sleep: (ms: number) => Promise<unknown> }} opts
 */
function quotaPacer({ perMinute, cost, now, sleep }) {
  /** @type {{ at: number, units: number }[]} */
  const spent = [];
  return async (/** @type {string} */ url) => {
    const units = cost(url);
    for (;;) {
      const t = now();
      while (spent.length && spent[0].at <= t - 60_000) spent.shift();
      const used = spent.reduce((n, s) => n + s.units, 0);
      if (!spent.length || used + units <= perMinute) {
        spent.push({ at: t, units });
        return;
      }
      await sleep(spent[0].at + 60_000 - t);
    }
  };
}

// Calls in groups of `size` at once, in order: a provider's per-user quota
// is the limit here, not this machine.
/**
 * @template T, R
 * @param {T[]} items @param {number} size @param {(item: T) => Promise<R>} fn
 * @returns {Promise<R[]>}
 */
async function inGroups(items, size, fn) {
  const out = [];
  for (let i = 0; i < items.length; i += size)
    out.push(...(await Promise.all(items.slice(i, i + size).map(fn))));
  return out;
}

// ---------------------------------------------------------------------------
// Gmail
// ---------------------------------------------------------------------------

const GOOGLE_AUTHORIZE = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token';
const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';
const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.modify';
// A first pass (and one after Gmail forgot the cursor) takes the newest this
// many messages in the window, one request each: a mailbox with years of mail
// inside the window would otherwise keep the pass going for hours.
export const GMAIL_FIRST_PASS_MAX = 2000;
const GMAIL_GROUP = 5;
// Gmail meters each user of a project in quota units: 6,000 a minute, of
// which reading a message or an attachment costs 20, listing messages 5, a
// page of history 2, the profile and the labels 1
// (developers.google.com/workspace/gmail/api/reference/quota). A first pass
// of 2,000 messages is 40,000 units, so calls are paced to stay under the
// limit rather than bursting into it; the margin is for anything else this
// project does as the same user meanwhile.
const GMAIL_UNITS_PER_MINUTE = 5000;
/** @param {string} url */
function gmailUnits(url) {
  const path = new URL(url).pathname.replace(/^\/gmail\/v1\/users\/me/, '');
  if (path === '/profile' || path === '/labels') return 1;
  if (path === '/history') return 2;
  if (path === '/messages') return 5;
  return 20;
}
// Labels that put a message outside what the sync keeps, as the folders of
// the same names are on Outlook.
const GMAIL_OUTSIDE = ['TRASH', 'SPAM', 'DRAFT'];

/** @param {any[]} headers @param {string} name */
const header = (headers, name) =>
  (headers || []).find((h) => String(h.name).toLowerCase() === name)?.value || '';

// A part with a file name or an attachment disposition is an attachment, a
// multipart one too: what is inside it is the attached file's, not the body.
/** @param {any} part */
const isAttachment = (part) =>
  !!part.filename || header(part.headers, 'content-disposition').toLowerCase().startsWith('attachment');

// The text parts Gmail sent as separate attachments. A part's `data` "may be
// empty" when "the body data is sent as a separate attachment", with an
// `attachmentId` to fetch it by, so these are fetched before the message is
// read.
/** @param {any} part @param {any[]} [out] */
function detachedBodies(part, out = []) {
  if (isAttachment(part)) return out;
  if (Array.isArray(part.parts) && part.parts.length) for (const p of part.parts) detachedBodies(p, out);
  else if (
    /^text\/(plain|html)$/i.test(String(part.mimeType || '')) &&
    !part.body?.data &&
    part.body?.attachmentId
  )
    out.push(part);
  return out;
}

/**
 * @param {any} part
 * @param {{ text: string | null, html: string | null, attachments: object[] }} out
 */
function walkGmailPart(part, out) {
  const mime = String(part.mimeType || '').toLowerCase();
  if (isAttachment(part)) {
    out.attachments.push({
      id: part.body?.attachmentId || null,
      name: decodeWords(part.filename || ''),
      mimeType: mime,
      size: Number(part.body?.size) || 0,
    });
    return;
  }
  if (Array.isArray(part.parts) && part.parts.length) {
    for (const p of part.parts) walkGmailPart(p, out);
    return;
  }
  if (!part.body?.data) return;
  const charset = /charset="?([^";\s]+)"?/i.exec(header(part.headers, 'content-type'))?.[1];
  const text = decodeCharset(Buffer.from(part.body.data, 'base64url'), charset);
  if (mime === 'text/plain' && out.text == null) out.text = text;
  else if (mime === 'text/html' && out.html == null) out.html = text;
}

/** @param {string[]} labelIds @param {Map<string, string>} names */
function gmailFlags(labelIds, names) {
  return {
    labels: labelIds.filter((l) => l !== 'UNREAD').map((l) => names.get(l) || l),
    inInbox: labelIds.includes('INBOX'),
    isRead: !labelIds.includes('UNREAD'),
    isStarred: labelIds.includes('STARRED'),
  };
}

// A Gmail message (format=full) as the row the store keeps, or null for one
// in the trash, in spam or still a draft.
/** @param {any} m @param {Map<string, string>} names @param {string} email */
export function gmailMessage(m, names, email) {
  const labelIds = m.labelIds || [];
  if (labelIds.some((l) => GMAIL_OUTSIDE.includes(l))) return null;
  const headers = m.payload?.headers || [];
  const parts = { text: null, html: null, attachments: [] };
  walkGmailPart(m.payload || {}, parts);
  const text = clip(parts.text ?? (parts.html != null ? htmlToText(parts.html) : null));
  const html = clip(parts.html);
  return {
    id: String(m.id),
    threadId: String(m.threadId || ''),
    folderId: '',
    receivedAt: Number(m.internalDate) || Date.parse(header(headers, 'date')) || 0,
    from: parseAddressList(header(headers, 'from'))[0] || { name: '', address: '' },
    to: parseAddressList(header(headers, 'to')),
    cc: parseAddressList(header(headers, 'cc')),
    replyTo: parseAddressList(header(headers, 'reply-to')),
    subject: decodeWords(header(headers, 'subject')),
    // Gmail's snippets carry HTML entities (&#39;, &amp;) in what they quote.
    snippet: decodeEntities(m.snippet || ''),
    ...gmailFlags(labelIds, names),
    attachments: parts.attachments,
    bodyText: text.text,
    bodyHtml: html.text,
    bodyTruncated: text.truncated || html.truncated,
    messageId: header(headers, 'message-id') || null,
    // Where Gmail's web app opens a message. Google does not document it: a
    // convenience for a client, not part of the contract.
    webUrl: `https://mail.google.com/mail/?authuser=${encodeURIComponent(email)}#all/${m.id}`,
  };
}

/**
 * @param {{ clientId: string, clientSecret: string, redirectUri: string }} client
 * @param {{ request?: typeof fetch, sleep?: (ms: number) => Promise<unknown>, now?: () => number }} [deps]
 */
export function gmailProvider(client, { request = fetch, sleep = defaultSleep, now = Date.now } = {}) {
  /** @param {(force: boolean) => Promise<string>} token */
  const api = (token) =>
    apiClient({
      request,
      token,
      name: 'Gmail',
      sleep,
      pace: quotaPacer({ perMinute: GMAIL_UNITS_PER_MINUTE, cost: gmailUnits, now, sleep }),
    });

  /** @param {(url: string) => Promise<any>} call */
  async function labelNames(call) {
    const doc = await call(`${GMAIL}/labels`);
    return new Map((doc.labels || []).map((l) => [String(l.id), String(l.name || l.id)]));
  }

  /**
   * @param {(url: string) => Promise<any>} call @param {string[]} ids
   * @param {{ names: Map<string, string>, since: number, sink: any, email: string }} ctx
   */
  async function fetchAndStore(call, ids, { names, since, sink, email }) {
    for (let i = 0; i < ids.length; i += GMAIL_GROUP) {
      const group = ids.slice(i, i + GMAIL_GROUP);
      const found = await Promise.all(
        group.map(async (id) => {
          const path = `${GMAIL}/messages/${encodeURIComponent(id)}`;
          try {
            const m = await call(`${path}?format=full`);
            for (const part of detachedBodies(m.payload || {})) {
              const doc = await call(`${path}/attachments/${encodeURIComponent(part.body.attachmentId)}`);
              part.body.data = doc.data || '';
            }
            return m;
          } catch (e) {
            if (/** @type {any} */ (e).upstream === 404) return null;
            throw e;
          }
        }),
      );
      const keep = [];
      const drop = [];
      found.forEach((m, k) => {
        const row = m && gmailMessage(m, names, email);
        if (row && row.receivedAt >= since) keep.push(row);
        else drop.push(group[k]);
      });
      await sink.upsert(keep);
      await sink.remove(drop);
    }
  }

  /** @param {(url: string) => Promise<any>} call @param {any} ctx */
  async function fullPass(call, ctx) {
    // The cursor is taken before the listing (the profile's historyId is the
    // mailbox's current one), so whatever changes while the pass runs is in
    // the history the next pass reads, and replaying it is harmless.
    const { historyId } = await call(`${GMAIL}/profile`);
    const ids = [];
    let pageToken = '';
    do {
      // `after:` takes seconds since the epoch. Drafts are listed too (Gmail
      // documents no operator that leaves them out) and dropped by their
      // DRAFT label once read.
      const q = new URLSearchParams({ q: `after:${Math.floor(ctx.since / 1000)}`, maxResults: '500' });
      if (pageToken) q.set('pageToken', pageToken);
      const page = await call(`${GMAIL}/messages?${q}`);
      for (const m of page.messages || []) ids.push(String(m.id));
      pageToken = page.nextPageToken || '';
    } while (pageToken && ids.length < GMAIL_FIRST_PASS_MAX);
    await fetchAndStore(call, ids.slice(0, GMAIL_FIRST_PASS_MAX), ctx);
    await ctx.sink.pruneUnseen();
    return { historyId: String(historyId) };
  }

  /** @param {(url: string) => Promise<any>} call @param {string} startHistoryId @param {any} ctx */
  async function historyPass(call, startHistoryId, ctx) {
    const added = new Set();
    const deleted = new Set();
    const relabeled = new Set();
    let latest = startHistoryId;
    let pageToken = '';
    do {
      const q = new URLSearchParams({ startHistoryId, maxResults: '500' });
      if (pageToken) q.set('pageToken', pageToken);
      const page = await call(`${GMAIL}/history?${q}`);
      for (const h of page.history || []) {
        for (const x of h.messagesAdded || []) added.add(String(x.message.id));
        for (const x of h.messagesDeleted || []) deleted.add(String(x.message.id));
        for (const x of [...(h.labelsAdded || []), ...(h.labelsRemoved || [])])
          relabeled.add(String(x.message.id));
      }
      if (page.historyId) latest = String(page.historyId);
      pageToken = page.nextPageToken || '';
    } while (pageToken);
    for (const id of deleted) {
      added.delete(id);
      relabeled.delete(id);
    }
    for (const id of added) relabeled.delete(id);
    await ctx.sink.remove([...deleted]);
    await fetchAndStore(call, [...added], ctx);

    // A label change needs the labels only: format=minimal "returns only
    // email message ID and labels". A message the store does not hold (it
    // came back from the trash, or was never in the window) is fetched whole,
    // and kept if it is inside the window now.
    const minimal = await inGroups([...relabeled], GMAIL_GROUP, (id) =>
      call(`${GMAIL}/messages/${encodeURIComponent(id)}?format=minimal`).catch((e) => {
        if (e.upstream === 404) return null;
        throw e;
      }),
    );
    const gone = [];
    const missing = [];
    const ids = [...relabeled];
    for (let k = 0; k < ids.length; k++) {
      const m = minimal[k];
      const labelIds = m?.labelIds || [];
      if (!m || labelIds.some((l) => GMAIL_OUTSIDE.includes(l))) {
        gone.push(ids[k]);
        continue;
      }
      const changed = await ctx.sink.flags(ids[k], gmailFlags(labelIds, ctx.names));
      if (!changed) missing.push(ids[k]);
    }
    await ctx.sink.remove(gone);
    await fetchAndStore(call, missing, ctx);
    return { historyId: latest };
  }

  return {
    id: 'gmail',
    name: 'Gmail',
    redirectUri: client.redirectUri,
    /** @param {{ state: string, challenge: string, loginHint?: string }} opts */
    authorizeUrl({ state, challenge, loginHint }) {
      const url = new URL(GOOGLE_AUTHORIZE);
      for (const [k, v] of Object.entries({
        client_id: client.clientId,
        redirect_uri: client.redirectUri,
        response_type: 'code',
        scope: GMAIL_SCOPE,
        // A Web client gets a refresh token only with offline access, and
        // only "on the first authorization", so the consent screen is asked
        // for every time: connecting a mailbox again must hand over a new one.
        // A Desktop client always gets one; both parameters are harmless there.
        access_type: 'offline',
        prompt: 'consent',
        state,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        ...(loginHint ? { login_hint: loginHint } : {}),
      }))
        url.searchParams.set(k, v);
      return url.toString();
    },
    /** @param {string} code @param {string} verifier */
    async exchange(code, verifier) {
      const t = await tokenRequest({
        request,
        url: GOOGLE_TOKEN,
        name: 'Google',
        params: {
          grant_type: 'authorization_code',
          code,
          client_id: client.clientId,
          client_secret: client.clientSecret,
          redirect_uri: client.redirectUri,
          code_verifier: verifier,
        },
      });
      // `scope` is what was granted, which the app is told to check.
      if (
        !String(t.scope || '')
          .split(/\s+/)
          .some((scope) =>
            [
              GMAIL_SCOPE,
              'https://www.googleapis.com/auth/gmail.readonly',
              'https://mail.google.com/',
            ].includes(scope),
          )
      )
        throw httpError(
          'Google did not grant reading mail (gmail.readonly): connect again and allow it',
          400,
        );
      if (!t.refreshToken)
        throw httpError(
          'Google sent no refresh token: remove the app at myaccount.google.com/permissions and connect again',
          400,
        );
      return t;
    },
    /** @param {string} refreshToken */
    refresh(refreshToken) {
      return tokenRequest({
        request,
        url: GOOGLE_TOKEN,
        name: 'Google',
        params: {
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
          client_id: client.clientId,
          client_secret: client.clientSecret,
        },
      });
    },
    api,
    /** @param {string | null} scope */
    canTrash(scope) {
      return String(scope || '')
        .split(/\s+/)
        .some((s) => [GMAIL_SCOPE, 'https://mail.google.com/'].includes(s));
    },
    /** @param {(url: string, options?: { method?: string, body?: string }) => Promise<any>} call @param {string} id */
    async trash(call, id) {
      await call(`${GMAIL}/messages/${encodeURIComponent(id)}/trash`, { method: 'POST' });
    },
    /** @param {(url: string) => Promise<any>} call */
    async profile(call) {
      const p = await call(`${GMAIL}/profile`);
      return { email: String(p.emailAddress || '') };
    },
    /**
     * @param {{ api: (url: string) => Promise<any>, state: any, since: number, sink: any, email: string }} opts
     */
    async sync({ api: call, state, since, sink, email }) {
      const names = await labelNames(call);
      const labels = Object.fromEntries(names);
      // The store keeps label names, and a rename leaves the messages' label
      // ids and history alone: the messages carrying a renamed label are
      // relabeled here, all names at once so two swapped ones do not collide.
      // The new names are saved with them, so a pass that fails after this
      // does not find the old ones again and map the rows a second time.
      const before = state?.labels || {};
      /** @type {[string, string][]} */
      const renamed = [];
      for (const [id, name] of names)
        if (Object.hasOwn(before, id) && before[id] !== name) renamed.push([before[id], name]);
      if (renamed.length) await sink.renameLabels(renamed, labels);
      const ctx = { names, since, sink, email };
      if (state?.historyId) {
        try {
          return { ...(await historyPass(call, String(state.historyId), ctx)), labels };
        } catch (e) {
          // A cursor is "typically valid for at least a week, but in some
          // rare circumstances may be valid for only a few hours"; a stale one
          // is a 404, and the sync guide's answer to it is a full pass.
          if (/** @type {any} */ (e).upstream !== 404) throw e;
        }
      }
      return { ...(await fullPass(call, ctx)), labels };
    },
  };
}

// ---------------------------------------------------------------------------
// Outlook (Microsoft Graph)
// ---------------------------------------------------------------------------

const MS_LOGIN = 'https://login.microsoftonline.com';
const GRAPH = 'https://graph.microsoft.com/v1.0/me';
const MS_SCOPES =
  'offline_access https://graph.microsoft.com/Mail.ReadWrite https://graph.microsoft.com/User.Read';
// The folders whose messages are not mail anybody is waiting on, by their
// well-known names; their subfolders are left out with them.
const OUTLOOK_SKIPPED = [
  'deleteditems',
  'junkemail',
  'drafts',
  'outbox',
  'conversationhistory',
  'syncissues',
  'scheduled',
  'searchfolders',
];
// Outlook serves "four concurrent requests" per app and mailbox
// (learn.microsoft.com/graph/throttling-limits).
const GRAPH_CONCURRENCY = 4;
const OUTLOOK_FIELD_LIST = [
  'id',
  'conversationId',
  'parentFolderId',
  'receivedDateTime',
  'from',
  'toRecipients',
  'ccRecipients',
  'replyTo',
  'subject',
  'bodyPreview',
  'body',
  'isRead',
  'isDraft',
  'flag',
  'hasAttachments',
  'internetMessageId',
  'webLink',
  'categories',
];
const OUTLOOK_FIELDS = OUTLOOK_FIELD_LIST.join(',');
// Hidden folders (Clutter, say) are left out of a listing unless asked for;
// they hold mail like any other, and the skipped folders are skipped by id.
const FOLDER_FIELDS = '$top=100&$select=id,displayName,childFolderCount&includeHiddenFolders=true';
// Immutable ids, so a message keeps its id when it moves between folders
// ("Immutable ID will NOT change if the item is moved to a different folder")
// and a move is an update rather than a delete and a new message. The
// preference holds for the request it is sent with only, so it goes on all.
const GRAPH_PREFER = 'IdType="ImmutableId", odata.maxpagesize=50';

/** @param {any} r */
const graphAddress = (r) => ({
  name: String(r?.emailAddress?.name || ''),
  address: String(r?.emailAddress?.address || ''),
});

// A Graph message as the row the store keeps, or null for a draft.
/** @param {any} m @param {{ id: string, name: string }} folder @param {string} inboxId */
export function outlookMessage(m, folder, inboxId) {
  if (m.isDraft) return null;
  const isHtml = String(m.body?.contentType || '').toLowerCase() === 'html';
  const content = m.body?.content ?? null;
  const text = clip(isHtml ? (content == null ? null : htmlToText(content)) : content);
  const html = clip(isHtml ? content : null);
  const folderId = String(m.parentFolderId || folder.id);
  return {
    id: String(m.id),
    threadId: String(m.conversationId || ''),
    folderId,
    receivedAt: Date.parse(m.receivedDateTime) || 0,
    from: graphAddress(m.from),
    to: (m.toRecipients || []).map(graphAddress),
    cc: (m.ccRecipients || []).map(graphAddress),
    replyTo: (m.replyTo || []).map(graphAddress),
    subject: String(m.subject || ''),
    snippet: String(m.bodyPreview || ''),
    labels: [folder.name, ...(m.categories || [])].filter(Boolean),
    inInbox: folderId === inboxId,
    isRead: !!m.isRead,
    isStarred: m.flag?.flagStatus === 'flagged',
    attachments: [],
    hasAttachments: !!m.hasAttachments,
    bodyText: text.text,
    bodyHtml: html.text,
    bodyTruncated: text.truncated || html.truncated,
    messageId: m.internetMessageId || null,
    webUrl: m.webLink || null,
  };
}

/**
 * @param {{ clientId: string, clientSecret: string, tenant: string, redirectUri: string }} client
 * @param {{ request?: typeof fetch, sleep?: (ms: number) => Promise<unknown> }} [deps]
 */
export function outlookProvider(client, { request = fetch, sleep = defaultSleep } = {}) {
  const base = `${MS_LOGIN}/${encodeURIComponent(client.tenant)}/oauth2/v2.0`;
  // A public client (a mobile or desktop app registration) has no secret and
  // must not send one; a web registration must.
  const secret = client.clientSecret ? { client_secret: client.clientSecret } : {};
  /** @param {(force: boolean) => Promise<string>} token */
  const api = (token) =>
    apiClient({ request, token, name: 'Outlook', sleep, headers: { Prefer: GRAPH_PREFER } });

  // The inbox's id and the skipped folders', resolved by well-known name once
  // and kept in the sync state: they never change for a mailbox.
  /** @param {(url: string) => Promise<any>} call */
  async function wellKnown(call) {
    // Graph does not document what a well-known folder a mailbox lacks
    // answers; any refusal of one is taken as its absence.
    const idOf = (/** @type {string} */ name) =>
      call(`${GRAPH}/mailFolders/${name}?$select=id`).then(
        (f) => String(f.id),
        (e) => {
          if ([400, 403, 404].includes(e.upstream)) return null;
          throw e;
        },
      );
    const inbox = await idOf('inbox');
    const skip = (await inGroups(OUTLOOK_SKIPPED, GRAPH_CONCURRENCY, idOf)).filter(Boolean);
    return { inbox: inbox || '', skip };
  }

  /** @param {(url: string) => Promise<any>} call @param {Set<string>} skip */
  async function folders(call, skip) {
    const out = [];
    const queue = [`${GRAPH}/mailFolders?${FOLDER_FIELDS}`];
    while (queue.length) {
      let url = queue.shift();
      while (url) {
        const page = await call(url);
        for (const f of page.value || []) {
          const id = String(f.id);
          // The listing "includes any mail search folders": virtual folders
          // of messages filed elsewhere, which have no delta of their own.
          if (skip.has(id) || f['@odata.type'] === '#microsoft.graph.mailSearchFolder') continue;
          out.push({ id, name: String(f.displayName || '') });
          if (Number(f.childFolderCount) > 0)
            queue.push(`${GRAPH}/mailFolders/${encodeURIComponent(id)}/childFolders?${FOLDER_FIELDS}`);
        }
        url = page['@odata.nextLink'];
      }
    }
    return out;
  }

  /** @param {(url: string) => Promise<any>} call @param {any[]} rows */
  async function withAttachments(call, rows) {
    await inGroups(
      rows.filter((r) => r.hasAttachments),
      GRAPH_CONCURRENCY,
      async (row) => {
        // The listing pages like any other collection; the row is stored
        // once, so it waits for the last page.
        const all = [];
        let url = `${GRAPH}/messages/${encodeURIComponent(row.id)}/attachments?$select=id,name,contentType,size,isInline`;
        while (url) {
          const page = await call(url).catch((e) => {
            if (e.upstream === 404) return { value: [] };
            throw e;
          });
          all.push(...(page.value || []));
          url = page['@odata.nextLink'];
        }
        row.attachments = all
          .filter((a) => !a.isInline)
          .map((a) => ({
            id: String(a.id),
            name: String(a.name || ''),
            mimeType: String(a.contentType || ''),
            size: Number(a.size) || 0,
          }));
      },
    );
    return rows.map(({ hasAttachments, ...row }) => row);
  }

  return {
    id: 'outlook',
    name: 'Outlook',
    redirectUri: client.redirectUri,
    /** @param {{ state: string, challenge: string, loginHint?: string }} opts */
    authorizeUrl({ state, challenge, loginHint }) {
      const url = new URL(`${base}/authorize`);
      for (const [k, v] of Object.entries({
        client_id: client.clientId,
        redirect_uri: client.redirectUri,
        response_type: 'code',
        response_mode: 'query',
        scope: MS_SCOPES,
        prompt: 'select_account',
        state,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        ...(loginHint ? { login_hint: loginHint } : {}),
      }))
        url.searchParams.set(k, v);
      return url.toString();
    },
    /** @param {string} code @param {string} verifier */
    async exchange(code, verifier) {
      const t = await tokenRequest({
        request,
        url: `${base}/token`,
        name: 'Microsoft',
        params: {
          grant_type: 'authorization_code',
          code,
          client_id: client.clientId,
          redirect_uri: client.redirectUri,
          scope: MS_SCOPES,
          code_verifier: verifier,
          ...secret,
        },
      });
      // `scope` is optional; absent, it is "the scopes requested on the
      // initial leg". Present, it may name Mail.Read bare or under its
      // resource, and the docs show it percent-encoded too.
      let granted = t.scope;
      try {
        granted = granted == null ? null : decodeURIComponent(granted);
      } catch {
        /* a literal % in it: read it as it is */
      }
      if (granted != null && !/(^|[\s/])mail\.read(?:write)?(\s|$)/i.test(granted))
        throw httpError(
          'Microsoft did not grant reading mail (Mail.Read); ask an admin to consent to it',
          400,
        );
      if (!t.refreshToken) throw httpError('Microsoft sent no refresh token (offline_access)', 400);
      return { ...t, scope: t.scope ?? MS_SCOPES };
    },
    /** @param {string} refreshToken */
    refresh(refreshToken) {
      return tokenRequest({
        request,
        url: `${base}/token`,
        name: 'Microsoft',
        params: {
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
          client_id: client.clientId,
          ...secret,
        },
      });
    },
    api,
    /** @param {string | null} scope */
    canTrash(scope) {
      let granted = String(scope || '');
      try {
        granted = decodeURIComponent(granted);
      } catch {
        /* use literal scope */
      }
      return /(^|[\s/])mail\.readwrite(\s|$)/i.test(granted);
    },
    /** @param {(url: string, options?: { method?: string, body?: string }) => Promise<any>} call @param {string} id */
    async trash(call, id) {
      await call(`${GRAPH}/messages/${encodeURIComponent(id)}/move`, {
        method: 'POST',
        body: JSON.stringify({ destinationId: 'deleteditems' }),
      });
    },
    /** @param {(url: string) => Promise<any>} call */
    async profile(call) {
      const me = await call(`${GRAPH}?$select=mail,userPrincipalName`);
      // A directory profile can be read even when the signed-in identity
      // cannot open a mailbox (for example, a personal account signed in as
      // a tenant's B2B guest). Check Mail.Read before saving a connection.
      try {
        await call(`${GRAPH}/mailFolders/inbox?$select=id`);
      } catch (e) {
        if (
          /#EXT#/i.test(String(me.userPrincipalName || '')) &&
          ([401, 403, 404].includes(e.upstream) || e.code === 'MailboxNotEnabledForRESTAPI')
        )
          throw httpError(
            'Microsoft signed you in as a guest in an organization instead of the mailbox owner. ' +
              'For personal Outlook mail, enable personal Microsoft accounts in the app registration ' +
              'and set MICROSOFT_OAUTH_TENANT=consumers (or common for personal and work accounts), ' +
              'then use Connect Outlook to sign in with your personal account.',
            400,
          );
        throw e;
      }
      return { email: String(me.mail || me.userPrincipalName || '') };
    },
    /**
     * @param {{ api: (url: string) => Promise<any>, state: any, since: number, sink: any }} opts
     */
    async sync({ api: call, state, since, sink }) {
      const known = state?.known?.inbox ? state.known : await wellKnown(call);
      const followed = await folders(call, new Set(known.skip));
      const names = new Map(followed.map((f) => [f.id, f.name]));
      // A rename sends no message through the delta, so the messages filed in
      // a renamed folder are relabeled here.
      const before = state?.folders || {};
      for (const f of followed)
        if (Object.hasOwn(before, f.id) && before[f.id] !== f.name) await sink.renameFolder(f.id, f.name);
      const previous = state?.deltas || {};
      /** @type {Record<string, string>} */
      const deltas = {};
      const filter = `receivedDateTime ge ${new Date(since).toISOString()}`;
      // The ids this pass's deltas have named, and those they have named more
      // than once. Across folders too: an id keeps its id when it moves, and
      // the folder it left can still name it present after the folder it
      // went to has, so the one whose delta is read last is no surer.
      const named = new Set();
      const repeated = new Set();
      for (const folder of followed) {
        const initial = `${GRAPH}/mailFolders/${encodeURIComponent(folder.id)}/messages/delta?$select=${OUTLOOK_FIELDS}&$filter=${encodeURIComponent(filter)}`;
        let url = previous[folder.id] || initial;
        let fresh = url === initial;
        for (;;) {
          let page;
          try {
            page = await call(url);
          } catch (e) {
            // A delta token Graph no longer knows starts the folder over: a
            // "410 Gone" means a full resync, and an expired token is "a
            // 40X-series error with error codes such as syncStateNotFound".
            const err = /** @type {any} */ (e);
            if (!fresh && (err.upstream === 410 || /syncstate|resync/i.test(String(err.code || '')))) {
              await sink.restartFolder(folder.id);
              url = initial;
              fresh = true;
              continue;
            }
            throw e;
          }
          const items = page.value || [];
          for (const item of items) {
            const id = String(item.id);
            if (named.has(id)) repeated.add(id);
            named.add(id);
          }
          const rows = [];
          const removed = [];
          const missing = [];
          /** @type {Set<string>} */
          const reading = new Set();
          for (const item of items) {
            const id = String(item.id);
            // A message named more than once (moved out and back, moved
            // between two folders, or changed twice, say) is read again to
            // learn what it is now: Graph promises no order between the
            // entries, on one page, across pages or across folders, so none
            // of them can be taken as the latest. And an
            // update is promised "at least the updated properties", not all
            // of them: one missing any the row is made of is read again
            // whole, rather than stored with the rest left blank.
            if (
              repeated.has(id) ||
              (!item['@removed'] && !OUTLOOK_FIELD_LIST.every((f) => Object.hasOwn(item, f)))
            ) {
              reading.add(id);
              continue;
            }
            const row = item['@removed'] ? null : outlookMessage(item, folder, known.inbox);
            if (row && row.receivedAt >= since) rows.push(row);
            else removed.push(id);
          }
          const partial = [...reading];
          const reread = await inGroups(partial, GRAPH_CONCURRENCY, (id) =>
            call(`${GRAPH}/messages/${encodeURIComponent(id)}?$select=${OUTLOOK_FIELDS}`).catch((e) => {
              if (e.upstream === 404) return null;
              throw e;
            }),
          );
          reread.forEach((item, k) => {
            // A 404 from the account-wide lookup means it is gone from any
            // cached folder. Raw delta tombstones still belong to the
            // folder that sent them, so they cannot undo a move.
            if (!item) {
              missing.push(partial[k]);
              return;
            }
            // Read by its id alone, it may have moved since this folder's
            // delta saw it: its label is the folder it is in now.
            const current = item && names.get(String(item.parentFolderId));
            const row =
              item && outlookMessage(item, { ...folder, name: current ?? folder.name }, known.inbox);
            if (row && row.receivedAt >= since) rows.push(row);
            else removed.push(partial[k]);
          });
          await sink.upsert(await withAttachments(call, rows));
          await sink.remove(removed, folder.id);
          if (missing.length) await sink.remove(missing);
          if (page['@odata.nextLink']) {
            url = page['@odata.nextLink'];
            continue;
          }
          if (page['@odata.deltaLink']) deltas[folder.id] = page['@odata.deltaLink'];
          break;
        }
        if (fresh) await sink.pruneUnseen(folder.id);
      }
      await sink.keepFolders(followed.map((f) => f.id));
      return { known, deltas, folders: Object.fromEntries(names) };
    },
  };
}
