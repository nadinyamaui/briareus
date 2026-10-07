import { describe, it, expect, vi } from 'vitest';
import { gmailMessage, gmailProvider, outlookMessage, outlookProvider } from '../lib/mail-providers.js';

// Nothing here reaches Google or Microsoft: `request` is a fake that answers
// from a list of routes and records every call.
function fakeFetch(routes) {
  const calls = [];
  const request = vi.fn(async (url, init = {}) => {
    calls.push({ url: String(url), init });
    for (const [match, answer] of routes) {
      if (typeof match === 'string' ? String(url).startsWith(match) : match.test(String(url))) {
        const { status = 200, body = {}, headers = {} } = await answer(String(url), init);
        return new Response(JSON.stringify(body), { status, headers });
      }
    }
    return new Response(JSON.stringify({ error: { message: `no route for ${url}` } }), { status: 404 });
  });
  return { request, calls };
}

function fakeSink() {
  const sink = {
    upserted: [],
    removed: [],
    flagged: [],
    pruned: [],
    kept: null,
    stored: new Set(),
    upsert: vi.fn(async (rows) => {
      for (const r of rows) sink.stored.add(r.id);
      sink.upserted.push(...rows);
    }),
    remove: vi.fn(async (ids, folderId = null) => {
      if (ids.length) sink.removed.push({ ids, folderId });
    }),
    flags: vi.fn(async (id, flags) => {
      sink.flagged.push({ id, flags });
      return sink.stored.has(id) ? 1 : 0;
    }),
    pruneUnseen: vi.fn(async (folderId = null) => sink.pruned.push(folderId)),
    keepFolders: vi.fn(async (ids) => (sink.kept = ids)),
  };
  return sink;
}

const b64 = (text) => Buffer.from(text).toString('base64url');
const NOW = Date.parse('2026-10-07T12:00:00Z');
const SINCE = NOW - 30 * 24 * 3600_000;

const GOOGLE = { clientId: 'gid', clientSecret: 'gsecret', redirectUri: 'http://127.0.0.1' };
const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';

function gmailFull(id, { labels = ['INBOX', 'UNREAD'], at = NOW - 3600_000, subject = 'Hi' } = {}) {
  return {
    id,
    threadId: `t-${id}`,
    labelIds: labels,
    snippet: 'Tom &amp; Jerry',
    internalDate: String(at),
    payload: {
      mimeType: 'multipart/mixed',
      headers: [
        { name: 'From', value: '"Doe, Jane" <jane@x.com>' },
        { name: 'To', value: 'me@gmail.com' },
        { name: 'Subject', value: subject },
        { name: 'Message-ID', value: `<${id}@x.com>` },
      ],
      parts: [
        {
          mimeType: 'multipart/alternative',
          parts: [
            {
              mimeType: 'text/plain',
              headers: [{ name: 'Content-Type', value: 'text/plain; charset="windows-1252"' }],
              body: { data: Buffer.from([0x63, 0x61, 0x66, 0xe9]).toString('base64url') },
            },
            { mimeType: 'text/html', body: { data: b64('<p>café</p>') } },
          ],
        },
        {
          mimeType: 'application/pdf',
          filename: 'invoice.pdf',
          headers: [{ name: 'Content-Disposition', value: 'attachment; filename="invoice.pdf"' }],
          body: { attachmentId: 'att-1', size: 1234 },
        },
      ],
    },
  };
}

const token = vi.fn(async () => 'access');

describe('gmailMessage', () => {
  it('maps headers, both bodies, the attachment and the flags', () => {
    const names = new Map([['Label_1', 'Clients']]);
    const row = gmailMessage(
      {
        ...gmailFull('m1', { labels: ['INBOX', 'STARRED', 'Label_1'], subject: '=?UTF-8?Q?r=C3=A9union?=' }),
      },
      names,
      'me@gmail.com',
    );
    expect(row).toMatchObject({
      id: 'm1',
      threadId: 't-m1',
      folderId: '',
      receivedAt: NOW - 3600_000,
      from: { name: 'Doe, Jane', address: 'jane@x.com' },
      to: [{ name: '', address: 'me@gmail.com' }],
      subject: 'réunion',
      snippet: 'Tom & Jerry',
      labels: ['INBOX', 'STARRED', 'Clients'],
      inInbox: true,
      isRead: true,
      isStarred: true,
      attachments: [{ id: 'att-1', name: 'invoice.pdf', mimeType: 'application/pdf', size: 1234 }],
      bodyText: 'café',
      bodyHtml: '<p>café</p>',
      bodyTruncated: false,
      messageId: '<m1@x.com>',
      webUrl: 'https://mail.google.com/mail/?authuser=me%40gmail.com#all/m1',
    });
  });

  it('renders an HTML-only body as text', () => {
    const m = {
      id: 'h',
      labelIds: [],
      payload: { mimeType: 'text/html', headers: [], body: { data: b64('<div>One<br>Two</div>') } },
    };
    expect(gmailMessage(m, new Map(), 'me@gmail.com')).toMatchObject({
      bodyText: 'One\nTwo',
      bodyHtml: '<div>One<br>Two</div>',
      isRead: true,
      inInbox: false,
    });
  });

  it('leaves out the trash, spam and drafts', () => {
    for (const label of ['TRASH', 'SPAM', 'DRAFT'])
      expect(gmailMessage(gmailFull('x', { labels: [label] }), new Map(), 'me')).toBeNull();
  });
});

describe('gmailProvider', () => {
  it('asks for offline, read-only access with PKCE', () => {
    const url = new URL(
      gmailProvider(GOOGLE).authorizeUrl({ state: 'st', challenge: 'ch', loginHint: 'me@gmail.com' }),
    );
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: 'gid',
      redirect_uri: 'http://127.0.0.1',
      response_type: 'code',
      scope: 'https://www.googleapis.com/auth/gmail.readonly',
      access_type: 'offline',
      prompt: 'consent',
      state: 'st',
      code_challenge: 'ch',
      code_challenge_method: 'S256',
      login_hint: 'me@gmail.com',
    });
  });

  it('exchanges the code with the verifier and refuses a grant without the mail scope or a refresh token', async () => {
    const answers = [
      {
        access_token: 'a',
        refresh_token: 'r',
        expires_in: 3599,
        scope: 'https://www.googleapis.com/auth/gmail.readonly',
      },
      { access_token: 'a', refresh_token: 'r', scope: 'openid' },
      { access_token: 'a', scope: 'https://www.googleapis.com/auth/gmail.readonly' },
    ];
    const { request, calls } = fakeFetch([
      ['https://oauth2.googleapis.com/token', () => ({ body: answers.shift() })],
    ]);
    const gmail = gmailProvider(GOOGLE, { request });

    expect(await gmail.exchange('the-code', 'the-verifier')).toMatchObject({
      accessToken: 'a',
      refreshToken: 'r',
      expiresIn: 3599,
    });
    expect(Object.fromEntries(new URLSearchParams(calls[0].init.body))).toEqual({
      grant_type: 'authorization_code',
      code: 'the-code',
      client_id: 'gid',
      client_secret: 'gsecret',
      redirect_uri: 'http://127.0.0.1',
      code_verifier: 'the-verifier',
    });
    await expect(gmail.exchange('c', 'v')).rejects.toThrow(/tick the Gmail box/);
    await expect(gmail.exchange('c', 'v')).rejects.toThrow(/no refresh token/);
  });

  it('marks a refresh Google refuses with invalid_grant as needing a new sign-in', async () => {
    const { request } = fakeFetch([
      [
        'https://oauth2.googleapis.com/token',
        () => ({
          status: 400,
          body: { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' },
        }),
      ],
    ]);
    const err = await gmailProvider(GOOGLE, { request })
      .refresh('r')
      .catch((e) => e);
    expect(err).toMatchObject({ status: 400, reauth: true });
    expect(err.message).toMatch(/expired or revoked/);
  });

  it('retries once with a fresh token on 401, and waits out a rate limit', async () => {
    let n = 0;
    const { request } = fakeFetch([
      [
        `${GMAIL}/profile`,
        () => {
          n++;
          if (n === 1) return { status: 401, body: {} };
          if (n === 2)
            return {
              status: 403,
              body: { error: { errors: [{ reason: 'userRateLimitExceeded' }], message: 'slow' } },
              headers: { 'retry-after': '3' },
            };
          return { body: { emailAddress: 'me@gmail.com' } };
        },
      ],
    ]);
    const sleep = vi.fn(async () => {});
    const tokens = vi.fn(async (force) => (force ? 'fresh' : 'stale'));
    const gmail = gmailProvider(GOOGLE, { request, sleep });

    expect(await gmail.profile(gmail.api(tokens))).toEqual({ email: 'me@gmail.com' });
    expect(tokens.mock.calls.map(([force]) => force)).toEqual([false, true, false]);
    expect(sleep).toHaveBeenCalledWith(3000);
  });

  it('says what the provider answered when it gives up', async () => {
    const { request } = fakeFetch([
      [`${GMAIL}/profile`, () => ({ status: 500, body: { error: { message: 'Backend Error', code: 500 } } })],
    ]);
    const gmail = gmailProvider(GOOGLE, { request });
    await expect(gmail.profile(gmail.api(token))).rejects.toMatchObject({
      status: 502,
      upstream: 500,
      message: 'Gmail answered 500: Backend Error',
    });
  });

  it('takes the window on a first pass, keeps what is in it and prunes what it did not see', async () => {
    const messages = {
      a: gmailFull('a'),
      b: gmailFull('b', { labels: ['TRASH'] }),
      c: gmailFull('c', { at: SINCE - 1000 }),
    };
    const { request, calls } = fakeFetch([
      [`${GMAIL}/labels`, () => ({ body: { labels: [{ id: 'INBOX', name: 'INBOX' }] } })],
      [`${GMAIL}/profile`, () => ({ body: { emailAddress: 'me@gmail.com', historyId: '900' } })],
      [
        `${GMAIL}/messages?`,
        (url) =>
          new URL(url).searchParams.get('pageToken')
            ? { body: { messages: [{ id: 'c' }, { id: 'gone' }] } }
            : { body: { messages: [{ id: 'a' }, { id: 'b' }], nextPageToken: 'p2' } },
      ],
      [
        /\/messages\/\w+\?format=full$/,
        (url) => {
          const id = /messages\/(\w+)\?/.exec(url)[1];
          return messages[id] ? { body: messages[id] } : { status: 404, body: {} };
        },
      ],
    ]);
    const sink = fakeSink();

    const state = await gmailProvider(GOOGLE, { request }).sync({
      api: gmailProvider(GOOGLE, { request }).api(token),
      state: null,
      since: SINCE,
      sink,
      email: 'me@gmail.com',
    });

    expect(state).toEqual({ historyId: '900' });
    const list = new URL(calls.find((c) => c.url.startsWith(`${GMAIL}/messages?`)).url);
    expect(list.searchParams.get('q')).toBe(`after:${Math.floor(SINCE / 1000)} -in:drafts`);
    expect(sink.upserted.map((r) => r.id)).toEqual(['a']);
    expect(sink.removed.flatMap((r) => r.ids).sort()).toEqual(['b', 'c', 'gone']);
    expect(sink.pruned).toEqual([null]);
  });

  it('applies the history since the cursor: new, deleted and relabelled messages', async () => {
    const { request } = fakeFetch([
      [`${GMAIL}/labels`, () => ({ body: { labels: [] } })],
      [
        `${GMAIL}/history?`,
        (url) =>
          new URL(url).searchParams.get('pageToken')
            ? {
                body: {
                  historyId: '1200',
                  history: [
                    { messagesDeleted: [{ message: { id: 'old' } }] },
                    { labelsAdded: [{ message: { id: 'trashed' } }] },
                    { labelsRemoved: [{ message: { id: 'restored' } }] },
                  ],
                },
              }
            : {
                body: {
                  historyId: '1100',
                  nextPageToken: 'h2',
                  history: [
                    { messagesAdded: [{ message: { id: 'new' } }] },
                    { labelsRemoved: [{ message: { id: 'read' } }, { message: { id: 'new' } }] },
                    { messagesAdded: [{ message: { id: 'old' } }] },
                  ],
                },
              },
      ],
      [`${GMAIL}/messages/new?format=full`, () => ({ body: gmailFull('new') })],
      [`${GMAIL}/messages/restored?format=full`, () => ({ body: gmailFull('restored') })],
      [
        `${GMAIL}/messages/read?format=minimal`,
        () => ({ body: { id: 'read', labelIds: ['INBOX'], internalDate: String(NOW) } }),
      ],
      [
        `${GMAIL}/messages/trashed?format=minimal`,
        () => ({ body: { id: 'trashed', labelIds: ['TRASH'], internalDate: String(NOW) } }),
      ],
      [
        `${GMAIL}/messages/restored?format=minimal`,
        () => ({ body: { id: 'restored', labelIds: ['INBOX'], internalDate: String(NOW) } }),
      ],
    ]);
    const sink = fakeSink();
    sink.stored.add('read');
    const gmail = gmailProvider(GOOGLE, { request });

    const state = await gmail.sync({
      api: gmail.api(token),
      state: { historyId: '1000' },
      since: SINCE,
      sink,
      email: 'me@gmail.com',
    });

    expect(state).toEqual({ historyId: '1200' });
    expect(sink.removed.flatMap((r) => r.ids).sort()).toEqual(['old', 'trashed']);
    expect(sink.flagged).toEqual([
      { id: 'read', flags: { labels: ['INBOX'], inInbox: true, isRead: true, isStarred: false } },
      { id: 'restored', flags: { labels: ['INBOX'], inInbox: true, isRead: true, isStarred: false } },
    ]);
    // A relabelled message the store did not hold is fetched whole.
    expect(sink.upserted.map((r) => r.id)).toEqual(['new', 'restored']);
    expect(sink.pruned).toEqual([]);
  });

  it('falls back to a first pass when Gmail no longer has the cursor', async () => {
    const { request } = fakeFetch([
      [`${GMAIL}/labels`, () => ({ body: { labels: [] } })],
      [
        `${GMAIL}/history?`,
        () => ({ status: 404, body: { error: { message: 'Requested entity was not found.' } } }),
      ],
      [`${GMAIL}/profile`, () => ({ body: { historyId: '5000' } })],
      [`${GMAIL}/messages?`, () => ({ body: {} })],
    ]);
    const gmail = gmailProvider(GOOGLE, { request });
    const sink = fakeSink();

    const state = await gmail.sync({
      api: gmail.api(token),
      state: { historyId: '1' },
      since: SINCE,
      sink,
      email: 'me',
    });

    expect(state).toEqual({ historyId: '5000' });
    expect(sink.pruned).toEqual([null]);
  });
});

const MICROSOFT = {
  clientId: 'mid',
  clientSecret: '',
  tenant: 'common',
  redirectUri: 'https://login.microsoftonline.com/common/oauth2/nativeclient',
};
const GRAPH = 'https://graph.microsoft.com/v1.0/me';

function graphMessage(id, folder, extra = {}) {
  return {
    id,
    conversationId: `c-${id}`,
    parentFolderId: folder,
    receivedDateTime: new Date(NOW - 3600_000).toISOString(),
    from: { emailAddress: { name: 'Ann', address: 'ann@x.com' } },
    toRecipients: [{ emailAddress: { name: 'Me', address: 'me@outlook.com' } }],
    ccRecipients: [],
    subject: `Subject ${id}`,
    bodyPreview: 'Preview',
    body: { contentType: 'html', content: '<p>Hello</p>' },
    isRead: false,
    isDraft: false,
    flag: { flagStatus: 'notFlagged' },
    hasAttachments: false,
    internetMessageId: `<${id}@x.com>`,
    webLink: `https://outlook.office365.com/owa/?ItemID=${id}`,
    categories: ['Red'],
    ...extra,
  };
}

describe('outlookMessage', () => {
  it('maps a Graph message, its folder and its flag', () => {
    expect(
      outlookMessage(
        graphMessage('m/1+', 'INBOX-ID', { flag: { flagStatus: 'flagged' } }),
        { id: 'INBOX-ID', name: 'Inbox' },
        'INBOX-ID',
      ),
    ).toMatchObject({
      id: 'm/1+',
      threadId: 'c-m/1+',
      folderId: 'INBOX-ID',
      from: { name: 'Ann', address: 'ann@x.com' },
      to: [{ name: 'Me', address: 'me@outlook.com' }],
      labels: ['Inbox', 'Red'],
      inInbox: true,
      isRead: false,
      isStarred: true,
      bodyText: 'Hello',
      bodyHtml: '<p>Hello</p>',
      messageId: '<m/1+@x.com>',
    });
  });

  it('keeps a text body as text, and leaves drafts out', () => {
    expect(
      outlookMessage(
        graphMessage('t', 'F', { body: { contentType: 'text', content: 'Plain' } }),
        { id: 'F', name: 'F' },
        'I',
      ),
    ).toMatchObject({ bodyText: 'Plain', bodyHtml: null, inInbox: false });
    expect(outlookMessage(graphMessage('d', 'F', { isDraft: true }), { id: 'F', name: 'F' }, 'I')).toBeNull();
  });
});

describe('outlookProvider', () => {
  it('signs in on the tenant with read-only scopes, and sends a secret only when there is one', async () => {
    const url = new URL(outlookProvider(MICROSOFT).authorizeUrl({ state: 's', challenge: 'c' }));
    expect(url.origin + url.pathname).toBe('https://login.microsoftonline.com/common/oauth2/v2.0/authorize');
    expect(url.searchParams.get('scope')).toBe(
      'offline_access https://graph.microsoft.com/Mail.Read https://graph.microsoft.com/User.Read',
    );
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');

    const answer = { access_token: 'a', refresh_token: 'r', expires_in: 3600, scope: 'Mail.Read User.Read' };
    const pub = fakeFetch([['https://login.microsoftonline.com/', () => ({ body: answer })]]);
    await outlookProvider(MICROSOFT, { request: pub.request }).exchange('code', 'verifier');
    expect(new URLSearchParams(pub.calls[0].init.body).has('client_secret')).toBe(false);

    const web = fakeFetch([['https://login.microsoftonline.com/contoso/', () => ({ body: answer })]]);
    await outlookProvider(
      { ...MICROSOFT, tenant: 'contoso', clientSecret: 'shh' },
      { request: web.request },
    ).exchange('code', 'verifier');
    expect(new URLSearchParams(web.calls[0].init.body).get('client_secret')).toBe('shh');
  });

  it('refuses a grant without Mail.Read', async () => {
    const { request } = fakeFetch([
      [
        'https://login.microsoftonline.com/',
        () => ({ body: { access_token: 'a', refresh_token: 'r', scope: 'User.Read' } }),
      ],
    ]);
    await expect(outlookProvider(MICROSOFT, { request }).exchange('c', 'v')).rejects.toThrow(/Mail\.Read/);
  });

  it('follows every folder but the skipped ones, through each folder’s delta', async () => {
    const folderPages = {
      [`${GRAPH}/mailFolders?`]: [
        { id: 'INBOX-ID', displayName: 'Inbox', childFolderCount: 1 },
        { id: 'TRASH-ID', displayName: 'Deleted Items', childFolderCount: 2 },
        { id: 'ARCH-ID', displayName: 'Archive', childFolderCount: 0 },
      ],
      [`${GRAPH}/mailFolders/INBOX-ID/childFolders?`]: [
        { id: 'SUB-ID', displayName: 'Clients', childFolderCount: 0 },
      ],
    };
    const { request, calls } = fakeFetch([
      [`${GRAPH}/mailFolders/inbox?`, () => ({ body: { id: 'INBOX-ID' } })],
      [`${GRAPH}/mailFolders/deleteditems?`, () => ({ body: { id: 'TRASH-ID' } })],
      [
        /\/mailFolders\/(junkemail|drafts|outbox|conversationhistory|syncissues|scheduled)\?/,
        () => ({ status: 404 }),
      ],
      [
        /\/mailFolders\/[\w-]+\/messages\/delta/,
        (url) => {
          const folder = /mailFolders\/([\w-]+)\//.exec(url)[1];
          if (folder === 'INBOX-ID' && !url.includes('page=2'))
            return {
              body: {
                value: [
                  graphMessage('a', 'INBOX-ID', { hasAttachments: true }),
                  graphMessage('draft', 'INBOX-ID', { isDraft: true }),
                ],
                '@odata.nextLink': `${GRAPH}/mailFolders/INBOX-ID/messages/delta?page=2`,
              },
            };
          if (folder === 'INBOX-ID')
            return {
              body: {
                value: [{ id: 'moved-away', '@removed': { reason: 'deleted' } }],
                '@odata.deltaLink': `${GRAPH}/mailFolders/INBOX-ID/messages/delta?token=i1`,
              },
            };
          return {
            body: { value: [], '@odata.deltaLink': `${GRAPH}/mailFolders/${folder}/messages/delta?token=x` },
          };
        },
      ],
      [
        `${GRAPH}/messages/a/attachments`,
        () => ({
          body: {
            value: [
              { id: 'f1', name: 'a.pdf', contentType: 'application/pdf', size: 10, isInline: false },
              { id: 'f2', name: 'logo.png', contentType: 'image/png', size: 5, isInline: true },
            ],
          },
        }),
      ],
      [
        /\/mailFolders(\/[\w-]+\/childFolders)?\?/,
        (url) => {
          const key = Object.keys(folderPages).find((k) => url.startsWith(k));
          return { body: { value: folderPages[key] || [] } };
        },
      ],
    ]);
    const outlook = outlookProvider(MICROSOFT, { request });
    const sink = fakeSink();

    const state = await outlook.sync({ api: outlook.api(token), state: null, since: SINCE, sink });

    expect(state.known).toEqual({ inbox: 'INBOX-ID', skip: ['TRASH-ID'] });
    expect(Object.keys(state.deltas)).toEqual(['INBOX-ID', 'ARCH-ID', 'SUB-ID']);
    expect(state.deltas['INBOX-ID']).toContain('token=i1');
    // The trash's own children are never listed.
    expect(calls.some((c) => c.url.includes('TRASH-ID'))).toBe(false);
    const delta = new URL(calls.find((c) => c.url.includes('INBOX-ID/messages/delta')).url);
    expect(delta.searchParams.get('$filter')).toBe(`receivedDateTime ge ${new Date(SINCE).toISOString()}`);
    expect(calls[0].init.headers.Prefer).toContain('IdType="ImmutableId"');

    expect(sink.upserted).toHaveLength(1);
    expect(sink.upserted[0]).toMatchObject({
      id: 'a',
      inInbox: true,
      attachments: [{ id: 'f1', name: 'a.pdf', mimeType: 'application/pdf', size: 10 }],
    });
    expect(sink.upserted[0]).not.toHaveProperty('hasAttachments');
    expect(sink.removed).toEqual([
      { ids: ['draft'], folderId: 'INBOX-ID' },
      { ids: ['moved-away'], folderId: 'INBOX-ID' },
    ]);
    expect(sink.pruned).toEqual(['INBOX-ID', 'ARCH-ID', 'SUB-ID']);
    expect(sink.kept).toEqual(['INBOX-ID', 'ARCH-ID', 'SUB-ID']);
  });

  it('resumes from the stored deltas, and starts a folder over when Graph forgot its token', async () => {
    const { request, calls } = fakeFetch([
      [`${GRAPH}/mailFolders?`, () => ({ body: { value: [{ id: 'INBOX-ID', displayName: 'Inbox' }] } })],
      [
        `${GRAPH}/mailFolders/INBOX-ID/messages/delta?token=stale`,
        () => ({ status: 410, body: { error: { code: 'SyncStateNotFound', message: 'gone' } } }),
      ],
      [
        `${GRAPH}/mailFolders/INBOX-ID/messages/delta?`,
        () => ({
          body: { value: [], '@odata.deltaLink': `${GRAPH}/mailFolders/INBOX-ID/messages/delta?token=new` },
        }),
      ],
    ]);
    const outlook = outlookProvider(MICROSOFT, { request });
    const sink = fakeSink();

    const state = await outlook.sync({
      api: outlook.api(token),
      state: {
        known: { inbox: 'INBOX-ID', skip: [] },
        deltas: { 'INBOX-ID': `${GRAPH}/mailFolders/INBOX-ID/messages/delta?token=stale` },
      },
      since: SINCE,
      sink,
    });

    expect(calls.some((c) => c.url.includes('/mailFolders/inbox'))).toBe(false);
    expect(state.deltas).toEqual({ 'INBOX-ID': `${GRAPH}/mailFolders/INBOX-ID/messages/delta?token=new` });
    expect(sink.pruned).toEqual(['INBOX-ID']);
  });
});
