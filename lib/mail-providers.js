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
// Both sign-ins ask for reading only: gmail.readonly and Mail.Read. Nothing
// here sends, files, deletes or marks a message.

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
// change): no retry brings it back, only signing in again, which `reauth`
// tells the service.
/**
 * @param {{ request: typeof fetch, url: string, params: Record<string, string>, name: string }} opts
 * @returns {Promise<{ accessToken: string, refreshToken: string | null, expiresIn: number, scope: string }>}
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
      reauth: body.error === 'invalid_grant',
    });
  }
  return {
    accessToken: String(body.access_token),
    refreshToken: body.refresh_token ? String(body.refresh_token) : null,
    expiresIn: Number(body.expires_in) || 3600,
    scope: String(body.scope || ''),
  };
}

// A JSON call to a provider's API as the account. A 401 refreshes the token
// once (`token(true)`) and tries again: an access token can be revoked before
// it expires. A provider asking to slow down is waited on twice, as long as it
// says (capped), before the pass gives up until the next one.
//
// A failure keeps the provider's status in `upstream`, since a 404 on Gmail's
// history or a 410 on a Graph delta is a cursor gone stale, not an error.
/**
 * @param {{ request: typeof fetch, token: (force: boolean) => Promise<string>, name: string,
 *   sleep: (ms: number) => Promise<unknown>, headers?: Record<string, string> }} opts
 * @returns {(url: string) => Promise<any>}
 */
function apiClient({ request, token, name, sleep, headers = {} }) {
  return async function api(url) {
    let force = false;
    let refreshed = false;
    for (let waits = 0; ;) {
      const bearer = await token(force);
      force = false;
      let res;
      try {
        res = await request(url, {
          headers: { Accept: 'application/json', ...headers, Authorization: `Bearer ${bearer}` },
          signal: AbortSignal.timeout(30_000),
        });
      } catch {
        throw httpError(`${name} did not answer`, 502);
      }
      if (res.ok) return res.json();
      const body = await res.json().catch(() => ({}));
      if (res.status === 401 && !refreshed) {
        refreshed = force = true;
        continue;
      }
      const reason = body.error?.errors?.[0]?.reason || '';
      const slowDown =
        res.status === 429 || res.status === 503 || (res.status === 403 && /rateLimitExceeded/i.test(reason));
      if (slowDown && waits < 2) {
        waits++;
        const after = Number(res.headers.get('retry-after'));
        await sleep(Math.min(after > 0 ? after : 2 ** waits, 30) * 1000);
        continue;
      }
      const detail = body.error?.message || body.error_description || `HTTP ${res.status}`;
      const status = res.status === 404 ? 404 : slowDown ? 429 : 502;
      throw httpError(`${name} answered ${res.status}: ${String(detail).slice(0, 300)}`, status, {
        upstream: res.status,
        code: body.error?.code ?? null,
      });
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
const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
// A first pass (and one after Gmail forgot the cursor) takes the newest this
// many messages in the window, one request each: a mailbox with years of mail
// inside the window would otherwise keep the pass going for hours.
export const GMAIL_FIRST_PASS_MAX = 2000;
const GMAIL_GROUP = 10;
// Labels that put a message outside what the sync keeps, as the folders of
// the same names are on Outlook.
const GMAIL_OUTSIDE = ['TRASH', 'SPAM', 'DRAFT'];

/** @param {any[]} headers @param {string} name */
const header = (headers, name) =>
  (headers || []).find((h) => String(h.name).toLowerCase() === name)?.value || '';

/**
 * @param {any} part
 * @param {{ text: string | null, html: string | null, attachments: object[] }} out
 */
function walkGmailPart(part, out) {
  const mime = String(part.mimeType || '').toLowerCase();
  if (Array.isArray(part.parts) && part.parts.length) {
    for (const p of part.parts) walkGmailPart(p, out);
    return;
  }
  const disposition = header(part.headers, 'content-disposition').toLowerCase();
  if (part.filename || disposition.startsWith('attachment')) {
    out.attachments.push({
      id: part.body?.attachmentId || null,
      name: decodeWords(part.filename || ''),
      mimeType: mime,
      size: Number(part.body?.size) || 0,
    });
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
    // Gmail sends the snippet HTML-escaped.
    snippet: decodeEntities(m.snippet || ''),
    ...gmailFlags(labelIds, names),
    attachments: parts.attachments,
    bodyText: text.text,
    bodyHtml: html.text,
    bodyTruncated: text.truncated || html.truncated,
    messageId: header(headers, 'message-id') || null,
    webUrl: `https://mail.google.com/mail/?authuser=${encodeURIComponent(email)}#all/${m.id}`,
  };
}

/**
 * @param {{ clientId: string, clientSecret: string, redirectUri: string }} client
 * @param {{ request?: typeof fetch, sleep?: (ms: number) => Promise<unknown> }} [deps]
 */
export function gmailProvider(client, { request = fetch, sleep = defaultSleep } = {}) {
  /** @param {(force: boolean) => Promise<string>} token */
  const api = (token) => apiClient({ request, token, name: 'Gmail', sleep });

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
        group.map((id) =>
          call(`${GMAIL}/messages/${encodeURIComponent(id)}?format=full`).catch((e) => {
            if (e.upstream === 404) return null;
            throw e;
          }),
        ),
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
    // The cursor is taken before the listing, so whatever changes while the
    // pass runs is in the history the next pass reads.
    const { historyId } = await call(`${GMAIL}/profile`);
    const ids = [];
    let pageToken = '';
    do {
      const q = new URLSearchParams({
        q: `after:${Math.floor(ctx.since / 1000)} -in:drafts`,
        maxResults: '500',
      });
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

    // A label change needs the labels only. A message the store does not hold
    // (it came back from the trash, or was never in the window) is fetched
    // whole if it is inside the window now.
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
      if (!changed && Number(m.internalDate) >= ctx.since) missing.push(ids[k]);
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
        // A refresh token is handed over only with offline access, and only
        // on a consent screen: one already granted would otherwise skip it.
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
      // Google's consent screen lets each scope be unticked.
      if (!t.scope.split(/\s+/).includes(GMAIL_SCOPE))
        throw httpError('Google did not grant reading mail: tick the Gmail box on its consent screen', 400);
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
    /** @param {(url: string) => Promise<any>} call */
    async profile(call) {
      const p = await call(`${GMAIL}/profile`);
      return { email: String(p.emailAddress || '') };
    },
    /**
     * @param {{ api: (url: string) => Promise<any>, state: any, since: number, sink: any, email: string }} opts
     */
    async sync({ api: call, state, since, sink, email }) {
      const ctx = { names: await labelNames(call), since, sink, email };
      if (state?.historyId) {
        try {
          return await historyPass(call, String(state.historyId), ctx);
        } catch (e) {
          // Gmail keeps about a week of history; an older cursor is a 404,
          // and only a full pass recovers from it.
          if (/** @type {any} */ (e).upstream !== 404) throw e;
        }
      }
      return fullPass(call, ctx);
    },
  };
}

// ---------------------------------------------------------------------------
// Outlook (Microsoft Graph)
// ---------------------------------------------------------------------------

const MS_LOGIN = 'https://login.microsoftonline.com';
const GRAPH = 'https://graph.microsoft.com/v1.0/me';
const MS_SCOPES =
  'offline_access https://graph.microsoft.com/Mail.Read https://graph.microsoft.com/User.Read';
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
];
const OUTLOOK_FIELDS = [
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
].join(',');
const FOLDER_FIELDS = '$top=100&$select=id,displayName,childFolderCount';
// Immutable ids, so a message keeps its id when it moves between folders and
// a move is an update rather than a delete and a new message.
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
    const idOf = (name) =>
      call(`${GRAPH}/mailFolders/${name}?$select=id`).then(
        (f) => String(f.id),
        (e) => {
          if (e.upstream === 404) return null;
          throw e;
        },
      );
    const inbox = await idOf('inbox');
    const skip = (await Promise.all(OUTLOOK_SKIPPED.map(idOf))).filter(Boolean);
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
          if (skip.has(id)) continue;
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
      5,
      async (row) => {
        const doc = await call(
          `${GRAPH}/messages/${encodeURIComponent(row.id)}/attachments?$select=id,name,contentType,size,isInline`,
        ).catch((e) => {
          if (e.upstream === 404) return { value: [] };
          throw e;
        });
        row.attachments = (doc.value || [])
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
      if (!/(^|[\s/])mail\.read(\s|$)/i.test(t.scope))
        throw httpError(
          'Microsoft did not grant reading mail (Mail.Read); ask an admin to consent to it',
          400,
        );
      if (!t.refreshToken) throw httpError('Microsoft sent no refresh token (offline_access)', 400);
      return t;
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
          scope: MS_SCOPES,
          ...secret,
        },
      });
    },
    api,
    /** @param {(url: string) => Promise<any>} call */
    async profile(call) {
      const me = await call(`${GRAPH}?$select=mail,userPrincipalName`);
      return { email: String(me.mail || me.userPrincipalName || '') };
    },
    /**
     * @param {{ api: (url: string) => Promise<any>, state: any, since: number, sink: any }} opts
     */
    async sync({ api: call, state, since, sink }) {
      const known = state?.known?.inbox ? state.known : await wellKnown(call);
      const followed = await folders(call, new Set(known.skip));
      const previous = state?.deltas || {};
      /** @type {Record<string, string>} */
      const deltas = {};
      const filter = `receivedDateTime ge ${new Date(since).toISOString()}`;
      for (const folder of followed) {
        const initial = `${GRAPH}/mailFolders/${encodeURIComponent(folder.id)}/messages/delta?$select=${OUTLOOK_FIELDS}&$filter=${encodeURIComponent(filter)}`;
        let url = previous[folder.id] || initial;
        let fresh = url === initial;
        for (;;) {
          let page;
          try {
            page = await call(url);
          } catch (e) {
            // A delta token Graph no longer knows (410, or SyncStateNotFound)
            // starts the folder over.
            const err = /** @type {any} */ (e);
            if (!fresh && (err.upstream === 410 || /syncstate|resync/i.test(String(err.code || '')))) {
              url = initial;
              fresh = true;
              continue;
            }
            throw e;
          }
          const rows = [];
          const removed = [];
          for (const item of page.value || []) {
            const row = item['@removed'] ? null : outlookMessage(item, folder, known.inbox);
            if (row && row.receivedAt >= since) rows.push(row);
            else removed.push(String(item.id));
          }
          await sink.upsert(await withAttachments(call, rows));
          await sink.remove(removed, folder.id);
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
      return { known, deltas };
    },
  };
}
