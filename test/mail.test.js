import crypto from 'node:crypto';
import express from 'express';
import { mailAgentRoutes } from '../lib/mail-agent.js';
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';

const cfg = vi.hoisted(() => ({ credentialsKey: 'k'.repeat(32) }));
vi.mock('../lib/config.js', () => ({ getConfig: () => cfg }));
// The service is handed a store of its own below; the database's is never reached.
vi.mock('../lib/db.js', () => ({
  countMailMessages: vi.fn(),
  deleteMailAccount: vi.fn(),
  deleteMailMessages: vi.fn(),
  deleteMailMessagesOutsideFolders: vi.fn(),
  deleteMailMessagesReceivedBefore: vi.fn(),
  deleteMailMessagesSyncedBefore: vi.fn(),
  getMailMessage: vi.fn(),
  insertMailAccount: vi.fn(),
  listMailMessages: vi.fn(),
  loadMailAccountRows: vi.fn(),
  renameMailFolder: vi.fn(),
  renameMailLabels: vi.fn(),
  updateMailAccount: vi.fn(),
  updateMailMessageFlags: vi.fn(),
  upsertMailMessages: vi.fn(),
}));

const { createMailService } = await import('../lib/mail.js');
const { open, seal } = await import('../lib/secretbox.js');

const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';
const GOOGLE = { clientId: 'gid', clientSecret: 'gsecret', redirectUri: 'http://127.0.0.1' };
const DAY = 24 * 3600_000;

// The store's contract, in memory: what lib/db.js does in MySQL.
function memoryStore() {
  const accounts = new Map();
  const messages = new Map();
  let nextId = 1;
  const key = (accountId, id) => `${accountId}:${id}`;
  const ofAccount = (accountId) => [...messages.values()].filter((m) => m.accountId === accountId);
  const drop = (pred) => {
    for (const [k, m] of messages) if (pred(m)) messages.delete(k);
  };
  return {
    accounts,
    messages,
    loadAccounts: async () => [...accounts.values()].map((a) => ({ ...a })),
    insertAccount: async (a) => {
      if ([...accounts.values()].some((b) => b.provider === a.provider && b.email === a.email))
        throw Object.assign(new Error('Duplicate entry'), { code: 'ER_DUP_ENTRY' });
      const row = {
        ...a,
        id: nextId++,
        syncState: null,
        lastSyncAt: null,
        lastSyncError: null,
        createdAt: 1,
        updatedAt: 1,
      };
      accounts.set(row.id, row);
      return { ...row };
    },
    updateAccount: async (id, changes) => {
      Object.assign(accounts.get(id), changes);
      return 1;
    },
    deleteAccount: async (id) => {
      accounts.delete(id);
      drop((m) => m.accountId === id);
      return 1;
    },
    upsert: async (accountId, rows, syncedAt) => {
      for (const r of rows) messages.set(key(accountId, r.id), { ...r, accountId, syncedAt });
    },
    flags: async (accountId, id, flags, syncedAt) => {
      const m = messages.get(key(accountId, id));
      if (!m) return 0;
      Object.assign(m, flags, { syncedAt });
      return 1;
    },
    remove: async (accountId, ids, folderId) =>
      drop(
        (m) =>
          m.accountId === accountId && ids.includes(m.id) && (folderId == null || m.folderId === folderId),
      ),
    pruneOlder: async (accountId, before) => drop((m) => m.accountId === accountId && m.receivedAt < before),
    pruneUnseen: async (accountId, syncedAt, folderId) =>
      drop(
        (m) =>
          m.accountId === accountId && m.syncedAt < syncedAt && (folderId == null || m.folderId === folderId),
      ),
    keepFolders: async (accountId, folderIds) =>
      drop((m) => m.accountId === accountId && !folderIds.includes(m.folderId)),
    renameLabels: async (accountId, renames, changes) => {
      const names = new Map(renames);
      for (const m of ofAccount(accountId)) m.labels = m.labels.map((l) => (names.has(l) ? names.get(l) : l));
      Object.assign(accounts.get(accountId), changes);
    },
    renameFolder: async (accountId, folderId, name) => {
      for (const m of ofAccount(accountId)) if (m.folderId === folderId) m.labels[0] = name;
    },
    list: vi.fn(async ({ accountIds, cursor, limit, unread }) =>
      [...messages.values()]
        .filter((m) => accountIds.includes(m.accountId))
        .filter((m) => unread == null || m.isRead === !unread)
        .sort((a, b) => b.receivedAt - a.receivedAt || b.accountId - a.accountId || (a.id < b.id ? 1 : -1))
        .filter(
          (m) =>
            !cursor ||
            m.receivedAt < cursor[0] ||
            (m.receivedAt === cursor[0] &&
              (m.accountId < cursor[1] || (m.accountId === cursor[1] && m.id < cursor[2]))),
        )
        .slice(0, limit)
        .map(({ bodyText, bodyHtml, syncedAt, ...m }) => m),
    ),
    get: async (accountId, id) => {
      const m = messages.get(key(accountId, id));
      if (!m) return null;
      const { bodyText, bodyHtml, bodyTruncated, syncedAt, ...rest } = m;
      return {
        ...rest,
        body: { text: bodyText ?? null, html: bodyHtml ?? null, truncated: !!bodyTruncated },
      };
    },
    counts: async () => {
      const out = new Map();
      for (const a of accounts.keys())
        out.set(a, {
          messages: ofAccount(a).length,
          unread: ofAccount(a).filter((m) => !m.isRead && m.inInbox).length,
        });
      return out;
    },
    ofAccount,
  };
}

// A Gmail that answers from `mailbox`: the profile, the labels, a listing of
// every message and each message in full.
function fakeGmail(mailbox) {
  const tokenCalls = [];
  const gate = { wait: null, refresh: null };
  const request = vi.fn(async (url, init = {}) => {
    const reply = (body, status = 200) => new Response(JSON.stringify(body), { status });
    url = String(url);
    if (url === 'https://oauth2.googleapis.com/token') {
      const form = Object.fromEntries(new URLSearchParams(init.body));
      tokenCalls.push(form);
      if (form.grant_type === 'refresh_token' && gate.refresh) await gate.refresh;
      if (mailbox.refreshRefused && form.grant_type === 'refresh_token')
        return reply(
          { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' },
          400,
        );
      return reply({
        access_token: `access-${tokenCalls.length}`,
        refresh_token: form.grant_type === 'authorization_code' ? `refresh-${form.code}` : undefined,
        expires_in: 3600,
        scope:
          mailbox.scope ??
          (mailbox.manage
            ? 'https://www.googleapis.com/auth/gmail.modify'
            : 'https://www.googleapis.com/auth/gmail.readonly'),
      });
    }
    if (url.endsWith('/messages/send') && init.method === 'POST')
      return reply({ id: 'sent', threadId: 'sent-thread' });
    if (gate.wait) await gate.wait;
    if (url.endsWith('/trash')) {
      if (mailbox.trashWait) await mailbox.trashWait;
      if (mailbox.trashStatus) return reply(mailbox.trashError || {}, mailbox.trashStatus);
      const id = decodeURIComponent(url.split('/').at(-2));
      delete mailbox.messages[id];
      return reply({ id });
    }
    if (url.startsWith(`${GMAIL}/profile`)) return reply({ emailAddress: mailbox.email, historyId: '10' });
    if (url.startsWith(`${GMAIL}/labels`)) return reply({ labels: mailbox.labels || [] });
    if (url.startsWith(`${GMAIL}/messages?`))
      return reply({ messages: Object.keys(mailbox.messages).map((id) => ({ id })) });
    if (url.startsWith(`${GMAIL}/history?`))
      return mailbox.historyFails
        ? reply({ error: { code: 400, message: 'Invalid startHistoryId' } }, 400)
        : reply({ historyId: '11' });
    const full = /messages\/([^?]+)\?format=full/.exec(url);
    if (full && mailbox.messages[full[1]]) {
      const id = full[1];
      const { at, unread, labels = [] } = mailbox.messages[id];
      return reply({
        id,
        threadId: `t-${id}`,
        labelIds: ['INBOX', ...labels, ...(unread ? ['UNREAD'] : [])],
        internalDate: String(at),
        snippet: id,
        payload: {
          mimeType: 'text/plain',
          headers: [{ name: 'Subject', value: `About ${id}` }],
          body: { data: Buffer.from(`Body of ${id}`).toString('base64url') },
        },
      });
    }
    return reply({ error: { message: 'Not Found' } }, 404);
  });
  return { request, tokenCalls, gate };
}

let clock, store, mailbox, gmail, service, errors;

beforeEach(async () => {
  cfg.credentialsKey = 'k'.repeat(32);
  cfg.mail = { syncMinutes: 5, google: GOOGLE, microsoft: null };
  clock = Date.parse('2026-10-07T12:00:00Z');
  store = memoryStore();
  mailbox = {
    email: 'me@gmail.com',
    messages: { a: { at: clock - DAY, unread: true }, b: { at: clock - 2 * DAY, unread: false } },
  };
  gmail = fakeGmail(mailbox);
  errors = [];
  service = createMailService({
    store,
    callbackUrl: () => 'https://briareus.test/oauth/mail/callback',
    request: gmail.request,
    sleep: async () => {},
    now: () => clock,
    log: { error: (...args) => errors.push(args.join(' ')) },
  });
  await service.init();
});

afterEach(() => {
  service.stop();
  vi.useRealTimers();
});

// Starts a sign-in and finishes it the way a client would: with the address
// the provider sent the browser to.
async function connect(input = {}, code = 'code-1') {
  const start = service.connectStart({ provider: 'gmail', ...input });
  return service.connectFinish({ url: `http://127.0.0.1/?state=${start.state}&code=${code}&scope=x` });
}

const settled = async () =>
  vi.waitFor(async () => expect((await service.list()).every((a) => !a.syncing)).toBe(true));

describe('Outlook connection validation', () => {
  it.each([false, true])(
    'does not save inaccessible guest credentials (reconnect: %s)',
    async (reconnect) => {
      cfg.mail.microsoft = {
        clientId: 'mid',
        clientSecret: '',
        tenant: 'common',
        redirectUri: 'http://127.0.0.1',
      };
      const email = 'me_outlook.com#EXT#@tenant.onmicrosoft.com';
      const credentials = seal(JSON.stringify({ accessToken: 'old', refreshToken: 'old-refresh' }));
      const existing = reconnect
        ? await store.insertAccount({
            provider: 'outlook',
            email,
            label: '',
            credentials,
            enabled: false,
            status: 'connected',
            syncDays: 30,
          })
        : null;
      const request = vi.fn(async (url) => {
        if (String(url).includes('/token'))
          return new Response(JSON.stringify({ access_token: 'new', refresh_token: 'new-refresh' }));
        if (String(url).includes('/mailFolders/')) return new Response('{}', { status: 401 });
        return new Response(JSON.stringify({ userPrincipalName: email }));
      });
      service = createMailService({ store, request, now: () => clock, sleep: async () => {} });
      await service.init();
      await expect(
        connect({ provider: 'outlook', enabled: false, ...(existing ? { accountId: existing.id } : {}) }),
      ).rejects.toMatchObject({ status: 400, message: expect.stringContaining('guest') });
      expect(store.accounts.size).toBe(reconnect ? 1 : 0);
      if (existing) expect(store.accounts.get(existing.id).credentials).toBe(credentials);
    },
  );
});

describe('Outlook expired continuations', () => {
  it.each([
    [410, false],
    [400, true],
  ])(
    'prunes abandoned writes after a %s restart (empty snapshot: %s) with a fixed clock',
    async (status, empty) => {
      const graph = 'https://graph.microsoft.com/v1.0/me';
      const delta = `${graph}/mailFolders/inbox/messages/delta`;
      const message = (id, folderId) => ({
        id,
        parentFolderId: folderId,
        receivedDateTime: new Date(clock - DAY).toISOString(),
        body: { contentType: 'text', content: id },
      });
      const account = await store.insertAccount({
        provider: 'outlook',
        email: 'me@outlook.com',
        enabled: true,
        status: 'connected',
        syncDays: 30,
        credentials: seal(JSON.stringify({ accessToken: 'a', expiresAt: clock + DAY })),
      });
      await store.updateAccount(account.id, {
        syncState: {
          known: { inbox: 'inbox', skip: [] },
          deltas: { inbox: `${delta}?old`, archive: `${graph}/archive-delta` },
        },
      });
      await store.upsert(
        account.id,
        [{ id: 'archive', folderId: 'archive', receivedAt: clock - DAY }],
        clock - 1,
      );
      const request = vi.fn(async (url) => {
        url = String(url);
        let body;
        if (url.startsWith(`${graph}/mailFolders?`))
          body = {
            value: [
              { id: 'inbox', displayName: 'Inbox' },
              { id: 'archive', displayName: 'Archive' },
            ],
          };
        else if (url === `${delta}?old`)
          body = { value: [message('ghost', 'inbox')], '@odata.nextLink': `${delta}?expired` };
        else if (url === `${delta}?expired`)
          return new Response(JSON.stringify({ error: { code: 'SyncStateNotFound' } }), { status });
        else if (url.startsWith(`${graph}/messages/`))
          body = message(url.includes('/ghost?') ? 'ghost' : 'live', 'inbox');
        else if (url === `${graph}/archive-delta`) body = { value: [], '@odata.deltaLink': url };
        else if (url === `${delta}?new`) body = { value: [], '@odata.deltaLink': url };
        else if (url.startsWith(`${delta}?`))
          body = { value: empty ? [] : [message('live', 'inbox')], '@odata.deltaLink': `${delta}?new` };
        else throw new Error(`Unexpected request: ${url}`);
        return new Response(JSON.stringify(body));
      });
      service = createMailService({
        store,
        request,
        now: () => clock,
        config: () => ({
          syncMinutes: 0,
          google: null,
          microsoft: { clientId: 'm', redirectUri: 'http://127.0.0.1' },
        }),
      });
      await service.init();
      await service.sync(account.id);
      await settled();
      expect(
        store
          .ofAccount(account.id)
          .map((m) => m.id)
          .sort(),
      ).toEqual(empty ? ['archive'] : ['archive', 'live']);
      expect(store.accounts.get(account.id).syncState.deltas.inbox).toBe(`${delta}?new`);
      expect((await service.list())[0].lastSyncError).toBeNull();
      await service.sync(account.id);
      await settled();
      expect(
        store
          .ofAccount(account.id)
          .map((m) => m.id)
          .sort(),
      ).toEqual(empty ? ['archive'] : ['archive', 'live']);
    },
  );
});

describe('connecting a mailbox', () => {
  it('lists only the providers this server has a client for', () => {
    expect(service.providers()).toEqual(['gmail']);
    expect(() => service.connectStart({ provider: 'outlook' })).toThrow(/MICROSOFT_OAUTH_\* is not set/);
    expect(() => service.connectStart({ provider: 'yahoo' })).toThrow(/Choose `gmail` or `outlook`/);
  });

  it('refuses to start before CREDENTIALS_KEY is set, rather than after the sign-in', () => {
    cfg.credentialsKey = '';
    expect(() => service.connectStart({ provider: 'gmail' })).toThrow(/CREDENTIALS_KEY/);
  });

  it('hands out a PKCE sign-in and finishes it with the matching verifier', async () => {
    const start = service.connectStart({ provider: 'gmail', label: 'Personal', syncDays: 7 });
    expect(start).toMatchObject({
      redirectUri: 'http://127.0.0.1',
      finishesOnServer: false,
      expiresAt: clock + 15 * 60_000,
    });
    const url = new URL(start.url);
    expect(url.searchParams.get('state')).toBe(start.state);

    const account = await service.connectFinish({ state: start.state, code: 'abc' });

    const exchange = gmail.tokenCalls[0];
    expect(exchange).toMatchObject({ grant_type: 'authorization_code', code: 'abc' });
    expect(crypto.createHash('sha256').update(exchange.code_verifier).digest('base64url')).toBe(
      url.searchParams.get('code_challenge'),
    );
    expect(account).toMatchObject({
      provider: 'gmail',
      email: 'me@gmail.com',
      label: 'Personal',
      syncDays: 7,
      enabled: true,
      status: 'connected',
    });
    expect(account).not.toHaveProperty('credentials');
    expect(account).not.toHaveProperty('syncState');
    // Stored sealed, never as the tokens themselves.
    const stored = store.accounts.get(account.id).credentials;
    expect(stored).not.toContain('refresh-abc');
    expect(JSON.parse(open(stored))).toEqual({
      refreshToken: 'refresh-abc',
      scope: 'https://www.googleapis.com/auth/gmail.readonly',
      accessToken: 'access-1',
      expiresAt: clock + 3600_000,
    });
  });

  it('says when the sign-in ends on this server’s own callback', () => {
    cfg.mail.google = { ...GOOGLE, redirectUri: 'https://briareus.test/oauth/mail/callback' };
    expect(service.connectStart({ provider: 'gmail' })).toMatchObject({
      redirectUri: 'https://briareus.test/oauth/mail/callback',
      finishesOnServer: true,
    });
    expect(service.callbackUrl()).toBe('https://briareus.test/oauth/mail/callback');
  });

  it('syncs a new mailbox straight away', async () => {
    const account = await connect();
    await settled();

    expect(
      store
        .ofAccount(account.id)
        .map((m) => m.id)
        .sort(),
    ).toEqual(['a', 'b']);
    const [listed] = await service.list();
    expect(listed).toMatchObject({
      messages: 2,
      unread: 1,
      lastSyncAt: clock,
      lastSyncError: null,
      syncing: false,
    });
    expect(store.accounts.get(account.id).syncState).toEqual({ historyId: '10', labels: {} });
  });

  it('finishes each sign-in once, and not after it expired', async () => {
    const start = service.connectStart({ provider: 'gmail' });
    await service.connectFinish({ state: start.state, code: 'c' });
    await expect(service.connectFinish({ state: start.state, code: 'c' })).rejects.toThrow(
      /expired or was already used/,
    );

    const late = service.connectStart({ provider: 'gmail' });
    clock += 16 * 60_000;
    await expect(service.connectFinish({ state: late.state, code: 'c' })).rejects.toThrow(/expired/);
  });

  it('passes on what the provider said when the sign-in was refused', async () => {
    const start = service.connectStart({ provider: 'gmail' });
    await expect(
      service.connectFinish({ url: `http://127.0.0.1/?error=access_denied&state=${start.state}` }),
    ).rejects.toMatchObject({ status: 400, message: 'The sign-in did not finish: access_denied' });
    await expect(service.connectFinish({ url: 'not a url' })).rejects.toThrow(/whole address/);
  });

  it('reconnects a mailbox signed in to again, keeping its messages and settings', async () => {
    const first = await connect({ label: 'Work' }, 'one');
    await settled();
    const again = await connect({}, 'two');

    expect(again.id).toBe(first.id);
    expect(again.label).toBe('Work');
    expect(JSON.parse(open(store.accounts.get(first.id).credentials)).refreshToken).toBe('refresh-two');
    expect(store.accounts.size).toBe(1);
  });

  it('refuses a reconnect that signed in to another mailbox', async () => {
    const first = await connect();
    await settled();
    mailbox.email = 'someone-else@gmail.com';
    const start = service.connectStart({ provider: 'gmail', accountId: first.id });
    expect(new URL(start.url).searchParams.get('login_hint')).toBe('me@gmail.com');

    await expect(service.connectFinish({ state: start.state, code: 'x' })).rejects.toMatchObject({
      status: 409,
    });
  });
});

describe('syncing', () => {
  it('refreshes a lapsed access token and keeps the refresh token Google does not resend', async () => {
    const account = await connect();
    await settled();
    clock += 2 * 3600_000;

    await service.sync(account.id);
    await settled();

    const refresh = gmail.tokenCalls.find((c) => c.grant_type === 'refresh_token');
    expect(refresh).toMatchObject({ refresh_token: 'refresh-code-1', client_secret: 'gsecret' });
    const creds = JSON.parse(open(store.accounts.get(account.id).credentials));
    expect(creds).toMatchObject({ refreshToken: 'refresh-code-1', expiresAt: clock + 3600_000 });
    expect(store.accounts.get(account.id).syncState).toEqual({ historyId: '11', labels: {} });
  });

  it('marks an account whose grant was revoked, and will not sync it until it is reconnected', async () => {
    const account = await connect();
    await settled();
    clock += 2 * 3600_000;
    mailbox.refreshRefused = true;

    await service.sync(account.id);
    await settled();

    const [listed] = await service.list();
    expect(listed.status).toBe('reauth');
    expect(listed.lastSyncError).toMatch(/expired or revoked/);
    expect(errors.join('\n')).toMatch(/Mail sync of me@gmail.com failed/);
    await expect(service.sync(account.id)).rejects.toMatchObject({ status: 409 });

    mailbox.refreshRefused = false;
    expect((await connect({ accountId: account.id }, 'again')).status).toBe('connected');
  });

  it('does not mark a reconnected account for its old grant’s refusal', async () => {
    const account = await connect();
    await settled();
    clock += 2 * 3600_000;
    mailbox.refreshRefused = true;
    let release;
    gmail.gate.refresh = new Promise((resolve) => (release = resolve));
    await service.sync(account.id);

    await connect({ accountId: account.id }, 'fresh');
    release();
    await settled();

    const [listed] = await service.list();
    expect(listed.status).toBe('connected');
    expect(JSON.parse(open(store.accounts.get(account.id).credentials)).refreshToken).toBe('refresh-fresh');
  });

  it('syncs a reconnected account after the pass on its old grant, keeping that pass’s failure off it', async () => {
    const account = await connect();
    await settled();
    clock += 2 * 3600_000;
    mailbox.refreshRefused = true;
    let release;
    gmail.gate.refresh = new Promise((resolve) => (release = resolve));
    await service.sync(account.id);
    const writes = vi.spyOn(store, 'updateAccount');

    await connect({ accountId: account.id }, 'fresh');
    release();

    await vi.waitFor(() =>
      expect(store.accounts.get(account.id)).toMatchObject({
        lastSyncAt: clock,
        syncState: { historyId: '11', labels: {} },
      }),
    );
    expect(store.accounts.get(account.id)).toMatchObject({ status: 'connected', lastSyncError: null });
    expect(writes.mock.calls.filter(([, changes]) => changes.lastSyncError)).toEqual([]);
  });

  it('drops what falls out of the window', async () => {
    const account = await connect();
    await settled();
    clock += 29 * DAY;

    await service.sync(account.id);
    await settled();

    expect(store.ofAccount(account.id).map((m) => m.id)).toEqual(['a']);
  });

  it('starts over with a first pass when the window changes', async () => {
    const account = await connect();
    await settled();
    expect(store.accounts.get(account.id).syncState).toEqual({ historyId: '10', labels: {} });

    gmail.gate.wait = new Promise(() => {});
    const updated = await service.update(account.id, { syncDays: 90, label: 'Renamed' });
    expect(updated).toMatchObject({ syncDays: 90, label: 'Renamed', syncing: true });
    expect(store.accounts.get(account.id).syncState).toBeNull();

    await expect(service.update(account.id, { syncDays: 0 })).rejects.toThrow(/1–365/);
    await expect(service.update(account.id, { enabled: 'yes' })).rejects.toThrow(/true or false/);
    await expect(service.update(999, {})).rejects.toMatchObject({ status: 404 });
  });

  it('follows a pass on the old window with one on the new, when the window changes during it', async () => {
    const account = await connect();
    await settled();
    mailbox.messages.old = { at: clock - 60 * DAY, unread: false };
    let release;
    gmail.gate.wait = new Promise((resolve) => (release = resolve));
    await service.sync(account.id);

    await service.update(account.id, { syncDays: 90 });
    gmail.gate.wait = null;
    release();

    // The pass that was running saves no cursor for the old window; the one
    // after it takes the new window whole.
    await vi.waitFor(() =>
      expect(store.accounts.get(account.id).syncState).toEqual({ historyId: '10', labels: {} }),
    );
    expect(
      store
        .ofAccount(account.id)
        .map((m) => m.id)
        .sort(),
    ).toEqual(['a', 'b', 'old']);
  });

  it('carries a label renamed in Gmail over to the messages synced before', async () => {
    mailbox.labels = [{ id: 'Label_1', name: 'Acme' }];
    mailbox.messages.a.labels = ['Label_1'];
    const account = await connect();
    await settled();
    expect(store.messages.get(`${account.id}:a`).labels).toEqual(['INBOX', 'Acme']);

    mailbox.labels = [{ id: 'Label_1', name: 'Clients/Acme' }];
    await service.sync(account.id);
    await settled();

    expect(store.messages.get(`${account.id}:a`).labels).toEqual(['INBOX', 'Clients/Acme']);
    expect(store.accounts.get(account.id).syncState).toEqual({
      historyId: '11',
      labels: { Label_1: 'Clients/Acme' },
    });
  });

  it('renames once, when the pass that renamed fails after it and runs again', async () => {
    mailbox.labels = [
      { id: 'Label_1', name: 'Acme' },
      { id: 'Label_2', name: 'Globex' },
    ];
    mailbox.messages.a.labels = ['Label_1'];
    mailbox.messages.b.labels = ['Label_2'];
    const account = await connect();
    await settled();

    // The two names swapped, and the history read after the rename fails.
    mailbox.labels = [
      { id: 'Label_1', name: 'Globex' },
      { id: 'Label_2', name: 'Acme' },
    ];
    mailbox.historyFails = true;
    await service.sync(account.id);
    await settled();
    expect(store.accounts.get(account.id).lastSyncError).toMatch(/Invalid startHistoryId/);
    expect(store.accounts.get(account.id).syncState).toEqual({
      historyId: '10',
      labels: { Label_1: 'Globex', Label_2: 'Acme' },
    });

    mailbox.historyFails = false;
    await service.sync(account.id);
    await settled();

    expect(store.messages.get(`${account.id}:a`).labels).toEqual(['INBOX', 'Globex']);
    expect(store.messages.get(`${account.id}:b`).labels).toEqual(['INBOX', 'Acme']);
    expect(store.accounts.get(account.id)).toMatchObject({
      lastSyncError: null,
      syncState: { historyId: '11', labels: { Label_1: 'Globex', Label_2: 'Acme' } },
    });
  });

  it('writes nothing for an account removed while its pass runs', async () => {
    let release;
    const account = await connect({ enabled: false });
    gmail.gate.wait = new Promise((resolve) => (release = resolve));
    await service.sync(account.id);
    const upsert = vi.spyOn(store, 'upsert');

    const removing = service.remove(account.id);
    release();
    await removing;

    expect(upsert).not.toHaveBeenCalled();
    expect(store.accounts.size).toBe(0);
    expect(store.messages.size).toBe(0);
    await expect(service.sync(account.id)).rejects.toMatchObject({ status: 404 });
  });

  it('sweeps the enabled, connected accounts on the timer', async () => {
    vi.useFakeTimers({ now: clock, toFake: ['setTimeout', 'setInterval', 'clearInterval'] });
    const on = await connect({}, 'on');
    mailbox.email = 'off@gmail.com';
    const off = await connect({ enabled: false }, 'off');
    await vi.waitFor(() =>
      expect(store.accounts.get(on.id).syncState).toEqual({ historyId: '10', labels: {} }),
    );

    service.start();
    await vi.advanceTimersByTimeAsync(15_000);
    await vi.waitFor(() =>
      expect(store.accounts.get(on.id).syncState).toEqual({ historyId: '11', labels: {} }),
    );
    expect(store.accounts.get(off.id).syncState).toBeNull();
    expect(store.ofAccount(off.id)).toHaveLength(0);
  });
});

// An account write the store holds back until `land()`, for the writes
// matching `which`, to see what lands after it.
function holdWrites(which) {
  const held = { holding: false, landed: false, land: () => {} };
  const gate = new Promise((resolve) => (held.land = resolve));
  const write = store.updateAccount;
  store.updateAccount = async (id, changes) => {
    if (!which(changes)) return write(id, changes);
    held.holding = true;
    await gate;
    const n = await write(id, changes);
    held.landed = true;
    return n;
  };
  return held;
}

describe('the order account writes land in', () => {
  it('keeps a window reset over the cursor of a pass whose write was still landing', async () => {
    const account = await connect();
    await settled();
    const held = holdWrites((changes) => changes.syncState?.historyId === '11');
    await service.sync(account.id);
    await vi.waitFor(() => expect(held.holding).toBe(true));

    // The first pass on the new window is kept out, to see what the reset left.
    gmail.gate.wait = new Promise(() => {});
    const updating = service.update(account.id, { syncDays: 90 });
    held.land();
    await updating;
    await vi.waitFor(() => expect(held.landed).toBe(true));

    expect(store.accounts.get(account.id)).toMatchObject({ syncDays: 90, syncState: null });
  });

  it('keeps the tokens of a reconnect over a refresh whose write was still landing', async () => {
    const account = await connect();
    await settled();
    clock += 2 * 3600_000;
    const held = holdWrites((changes) => changes.credentials && !changes.status);
    await service.sync(account.id);
    await vi.waitFor(() => expect(held.holding).toBe(true));

    const reconnecting = connect({ accountId: account.id }, 'fresh');
    // The reconnect has its tokens and has asked to store them.
    await vi.waitFor(() => expect(gmail.tokenCalls.some((c) => c.code === 'fresh')).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 20));
    held.land();
    await reconnecting;
    await settled();

    expect(held.landed).toBe(true);
    expect(JSON.parse(open(store.accounts.get(account.id).credentials)).refreshToken).toBe('refresh-fresh');
  });

  it('applies settings changes in turn, each to what the one before left', async () => {
    const account = await connect();
    await settled();
    const held = holdWrites((changes) => changes.label === 'Work');
    const labeling = service.update(account.id, { label: 'Work' });
    await vi.waitFor(() => expect(held.holding).toBe(true));

    const disabling = service.update(account.id, { enabled: false });
    held.land();
    await Promise.all([labeling, disabling]);

    expect(store.accounts.get(account.id)).toMatchObject({ label: 'Work', enabled: false });
    expect((await service.list())[0]).toMatchObject({ label: 'Work', enabled: false });
  });
});

describe('reading', () => {
  beforeEach(async () => {
    mailbox.messages = Object.fromEntries(
      Array.from({ length: 5 }, (_, i) => [`m${i}`, { at: clock - (i + 1) * 3600_000, unread: i % 2 === 0 }]),
    );
    await connect();
    await settled();
  });

  it('pages newest first with an opaque cursor', async () => {
    const first = await service.messages({ limit: '2' });
    expect(first.messages.map((m) => m.id)).toEqual(['m0', 'm1']);
    expect(first.nextCursor).toEqual(expect.any(String));

    const second = await service.messages({ limit: '2', cursor: first.nextCursor });
    expect(second.messages.map((m) => m.id)).toEqual(['m2', 'm3']);
    const last = await service.messages({ limit: '2', cursor: second.nextCursor });
    expect(last).toMatchObject({ messages: [{ id: 'm4' }], nextCursor: null });
  });

  it('passes the filters on and checks them', async () => {
    const unread = await service.messages({ unread: '1' });
    expect(unread.messages.map((m) => m.id)).toEqual(['m0', 'm2', 'm4']);
    expect(store.list).toHaveBeenLastCalledWith(
      expect.objectContaining({ unread: true, inbox: undefined, limit: 51 }),
    );

    await expect(service.messages({ limit: '500' })).rejects.toThrow(/1–100/);
    await expect(service.messages({ unread: 'maybe' })).rejects.toThrow(/1 or 0/);
    await expect(service.messages({ cursor: 'garbage' })).rejects.toThrow(/nextCursor/);
    await expect(service.messages({ account: '42' })).rejects.toMatchObject({ status: 404 });
  });

  it('reads one message with its body', async () => {
    const [account] = await service.list();
    expect(await service.message(account.id, 'm0')).toMatchObject({
      id: 'm0',
      subject: 'About m0',
      body: { text: 'Body of m0', html: null, truncated: false },
    });
    await expect(service.message(account.id, 'nope')).rejects.toMatchObject({ status: 404 });
  });
});

describe('message deletion', () => {
  beforeEach(() => {
    mailbox.manage = true;
  });
  it('reconciles an uncertain send after queued deletion with a successful fresh sync', async () => {
    const account = await connect({ access: 'manage' });
    await settled();
    let release;
    mailbox.trashWait = new Promise((resolve) => {
      release = resolve;
    });
    const deletion = service.trashMessage(account.id, 'a');
    await vi.waitFor(() =>
      expect(gmail.request.mock.calls.some(([url]) => String(url).endsWith('/trash'))).toBe(true),
    );
    const original = gmail.request.getMockImplementation();
    gmail.request.mockImplementation(async (url, opts) => {
      if (url.endsWith('/messages/send')) return Response.json({}, { status: 503 });
      return original(url, opts);
    });
    const result = service
      .action(account.id, {
        action: 'send',
        to: ['you@example.com'],
        subject: 'Hello',
        text: 'Body',
      })
      .catch((error) => error);
    await vi.waitFor(async () => expect((await service.list())[0].syncing).toBe(true));
    release();
    await deletion;
    expect(await result).toMatchObject({ uncertain: true, syncCompleted: true, syncPending: false });
    await settled();
    await expect(service.message(account.id, 'a')).rejects.toMatchObject({ status: 404 });
    expect(errors).toEqual([]);
  });

  it('trashes only the selected account and message, and removes it from the synced copy', async () => {
    const a = await connect({ access: 'manage' });
    await settled();
    await store.upsert(99, [{ id: 'a' }], clock);
    await service.trashMessage(a.id, 'a');
    expect(store.messages.has(`${a.id}:a`)).toBe(false);
    expect(store.messages.has('99:a')).toBe(true);
    expect((await service.messages({})).messages.map((m) => m.id)).toEqual(['b']);
    expect(mailbox.messages.a).toBeUndefined();
    expect(mailbox.messages.b).toBeDefined();
  });
  it('refuses a trash revoked while it waited, before asking the provider', async () => {
    const a = await connect({ access: 'manage' });
    await settled();
    const authorize = vi.fn(() => {
      throw Object.assign(new Error('revoked'), { status: 403 });
    });
    await expect(service.trashMessage(a.id, 'a', authorize)).rejects.toMatchObject({ status: 403 });
    expect(authorize).toHaveBeenCalledTimes(1);
    expect(mailbox.messages.a).toBeDefined();
    expect(store.messages.has(`${a.id}:a`)).toBe(true);
  });
  it('refuses trash on a read-only mailbox even with provider management scopes', async () => {
    const account = await connect();
    await settled();
    expect(account.access).toBe('read');
    await expect(service.trashMessage(account.id, 'a')).rejects.toMatchObject({ status: 403 });
    expect(mailbox.messages.a).toBeDefined();
    expect(store.messages.has(`${account.id}:a`)).toBe(true);
    expect(gmail.request.mock.calls.filter(([url]) => String(url).endsWith('/trash'))).toHaveLength(0);
  });

  it.each(['remove', 'read reconnect', 'manage reconnect'])(
    'refuses an obsolete trash token after %s during refresh',
    async (change) => {
      const account = await connect({ access: 'manage' });
      await settled();
      clock += 2 * 3600_000;
      let release;
      gmail.gate.refresh = new Promise((resolve) => (release = resolve));
      const deletion = service.trashMessage(account.id, 'a').catch((e) => e);
      await vi.waitFor(() =>
        expect(gmail.tokenCalls.some((c) => c.grant_type === 'refresh_token')).toBe(true),
      );
      let removal;
      if (change === 'remove') removal = service.remove(account.id);
      else {
        mailbox.manage = change === 'manage reconnect';
        await connect({ accountId: account.id, access: mailbox.manage ? 'manage' : 'read' }, 'fresh');
      }
      release();
      expect(await deletion).toMatchObject({
        status: change === 'remove' ? 404 : change === 'read reconnect' ? 403 : 409,
      });
      await removal;
      await settled();
      expect(mailbox.messages.a).toBeDefined();
      if (change !== 'remove') expect(store.messages.has(`${account.id}:a`)).toBe(true);
      expect(gmail.request.mock.calls.filter(([url]) => String(url).endsWith('/trash'))).toHaveLength(0);
    },
  );

  it.each(
    [false, true].flatMap((forced) =>
      ['opt-out', 'project disabled', 'session closed', 'unchanged'].map((change) => [forced, change]),
    ),
  )('rechecks trash session access after refresh (forced %s, %s)', async (forced, change) => {
    const account = await connect({ access: 'manage' });
    await settled();
    if (forced) {
      const original = gmail.request.getMockImplementation();
      let refused = false;
      gmail.request.mockImplementation(async (url, init) => {
        if (String(url).endsWith('/trash') && !refused) {
          refused = true;
          return Response.json({}, { status: 401 });
        }
        return original(url, init);
      });
    } else clock += 2 * 3600_000;
    let release;
    gmail.gate.refresh = new Promise((resolve) => (release = resolve));
    let project = { mailToolsEnabled: true, enabled: true };
    const job = { kind: 'devchat', repo: 'test/mail', status: 'running' };
    const app = express();
    app.use(mailAgentRoutes({ service, agentSession: () => job, getProject: () => project }));
    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    try {
      const pending = fetch(
        `http://127.0.0.1:${server.address().port}/api/agent/mail/accounts/${account.id}/messages/a/trash`,
        { method: 'POST' },
      );
      await vi.waitFor(() =>
        expect(gmail.tokenCalls.some((c) => c.grant_type === 'refresh_token')).toBe(true),
      );
      if (change === 'opt-out') project = { ...project, mailToolsEnabled: false };
      if (change === 'project disabled') project = { ...project, enabled: false };
      if (change === 'session closed') job.status = 'closed';
      release();
      const response = await pending;
      expect(response.status).toBe(change === 'unchanged' ? 200 : 403);
      expect(await response.json()).toMatchObject(
        change === 'unchanged'
          ? { ok: true, action: 'trash' }
          : { error: expect.stringMatching(/interactive session/) },
      );
      expect(gmail.request.mock.calls.filter(([url]) => String(url).endsWith('/trash'))).toHaveLength(
        (forced ? 1 : 0) + (change === 'unchanged' ? 1 : 0),
      );
      expect(!!mailbox.messages.a).toBe(change !== 'unchanged');
      expect(store.messages.has(`${account.id}:a`)).toBe(change !== 'unchanged');
    } finally {
      release();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it.each([null, 'https://www.googleapis.com/auth/gmail.readonly'])(
    'keeps old read connections working but refuses deletion (scope %s)',
    async (scope) => {
      const a = await connect({ access: 'manage' });
      await settled();
      const credentials = JSON.parse(open(store.accounts.get(a.id).credentials));
      await service.update(a.id, { enabled: false });
      store.accounts.get(a.id).credentials = seal(JSON.stringify({ ...credentials, scope }));
      await service.init();
      await expect(service.trashMessage(a.id, 'a')).rejects.toMatchObject({ status: 409 });
      expect((await service.message(a.id, 'a')).id).toBe('a');
      expect(gmail.request.mock.calls.some(([url]) => String(url).endsWith('/trash'))).toBe(false);
    },
  );
  it.each([403, 429, 500])('retains the cached message on provider refusal %s', async (status) => {
    const a = await connect({ access: 'manage' });
    await settled();
    mailbox.trashStatus = status;
    await expect(service.trashMessage(a.id, 'a')).rejects.toMatchObject({
      status: status === 403 ? 409 : status === 429 ? 429 : 502,
    });
    expect((await service.message(a.id, 'a')).id).toBe('a');
    expect(gmail.request.mock.calls.filter(([url]) => String(url).endsWith('/trash'))).toHaveLength(1);
  });
  it('marks a revoked grant for reconnecting without dropping the cached message', async () => {
    const a = await connect({ access: 'manage' });
    await settled();
    mailbox.trashStatus = 401;
    mailbox.refreshRefused = true;
    await expect(service.trashMessage(a.id, 'a')).rejects.toMatchObject({ status: 409 });
    expect((await service.list())[0].status).toBe('reauth');
    expect((await service.message(a.id, 'a')).id).toBe('a');
  });
  it('serializes duplicate deletes and removes an account safely during an in-flight delete', async () => {
    const a = await connect({ access: 'manage' });
    await settled();
    let releaseDelete;
    mailbox.trashWait = new Promise((resolve) => {
      releaseDelete = resolve;
    });
    const first = service.trashMessage(a.id, 'a');
    await vi.waitFor(() =>
      expect(gmail.request.mock.calls.some(([url]) => String(url).endsWith('/trash'))).toBe(true),
    );
    const second = service.trashMessage(a.id, 'a');
    const result = expect(second).rejects.toMatchObject({ status: 404 });
    const removal = service.remove(a.id);
    releaseDelete();
    await first;
    await result;
    await removal;
    expect(await service.list()).toEqual([]);
    expect(store.ofAccount(a.id)).toEqual([]);
    expect(gmail.request.mock.calls.filter(([url]) => String(url).endsWith('/trash'))).toHaveLength(1);
  });

  it('removes a cached message the provider already deleted and rejects unknown targets', async () => {
    const a = await connect({ access: 'manage' });
    await settled();
    mailbox.trashStatus = 404;
    mailbox.trashError = { error: { code: 404, errors: [{ reason: 'notFound' }] } };
    await service.trashMessage(a.id, 'a');
    await expect(service.message(a.id, 'a')).rejects.toMatchObject({ status: 404 });
    await expect(service.trashMessage(a.id, 'missing')).rejects.toMatchObject({ status: 404 });
    await expect(service.trashMessage(900, 'b')).rejects.toMatchObject({ status: 404 });
  });
  it.each([
    ['gmail', { code: 404, errors: [{ reason: 'notFound' }] }, true],
    ['gmail', { code: 404 }, false],
    ['gmail', { code: 404, errors: [{ reason: 'unknown' }] }, false],
    ['outlook', { code: 'ErrorItemNotFound' }, true],
    ['outlook', { code: 'MailboxNotEnabledForRESTAPI' }, false],
    ['outlook', { code: 'MailboxNotSupportedForRESTAPI' }, false],
    ['outlook', { code: 'UnknownError' }, false],
    ['outlook', {}, false],
  ])('classifies %s trash 404 %j (missing message: %s)', async (provider, error, missing) => {
    cfg.mail.microsoft = { clientId: 'mid', clientSecret: 'secret' };
    const a = await store.insertAccount({
      provider,
      email: 'me@example.com',
      enabled: false,
      status: 'connected',
      syncDays: 30,
      credentials: seal(
        JSON.stringify({
          access: 'manage',
          accessToken: 'token',
          expiresAt: clock + DAY,
          scope: provider === 'gmail' ? 'https://www.googleapis.com/auth/gmail.modify' : 'Mail.ReadWrite',
        }),
      ),
    });
    await store.upsert(a.id, [{ id: 'a', receivedAt: clock - DAY }], clock);
    const request = vi.fn(async () => new Response(JSON.stringify({ error }), { status: 404 }));
    service = createMailService({ store, request, now: () => clock, sleep: async () => {} });
    await service.init();
    if (missing) {
      await service.trashMessage(a.id, 'a');
      await expect(service.message(a.id, 'a')).rejects.toMatchObject({ status: 404 });
    } else {
      await expect(service.trashMessage(a.id, 'a')).rejects.toMatchObject({ upstream: 404 });
      expect((await service.message(a.id, 'a')).id).toBe('a');
      expect((await service.messages({ account: a.id })).messages.map((m) => m.id)).toEqual(['a']);
    }
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('removes successfully trashed mail when overlapping account removal rolls back', async () => {
    const a = await connect({ enabled: false, access: 'manage' });
    await service.sync(a.id);
    await settled();
    const failure = new Error('Account deletion failed');
    store.deleteAccount = vi.fn(async () => {
      throw failure;
    });
    let releaseDelete;
    mailbox.trashWait = new Promise((resolve) => {
      releaseDelete = resolve;
    });
    const deletion = service.trashMessage(a.id, 'a');
    await vi.waitFor(() =>
      expect(gmail.request.mock.calls.some(([url]) => String(url).endsWith('/trash'))).toBe(true),
    );
    expect(await service.sync(a.id)).toMatchObject({ syncing: true });
    const removal = expect(service.remove(a.id)).rejects.toBe(failure);
    releaseDelete();
    await deletion;
    await removal;
    await settled();
    expect((await service.list())[0]).toMatchObject({ id: a.id, enabled: false, syncing: false });
    expect(mailbox.messages.a).toBeUndefined();
    await expect(service.message(a.id, 'a')).rejects.toMatchObject({ status: 404 });
    expect((await service.messages({ account: a.id })).messages.map((m) => m.id)).toEqual(['b']);
  });

  it.each([200, 403, 401])(
    'reports queued syncs until deletion and refresh settle (trash %s)',
    async (status) => {
      const a = await connect({ access: 'manage' });
      await settled();
      const lastSyncAt = (await service.list())[0].lastSyncAt;
      clock += 1000;
      let releaseDelete;
      mailbox.trashWait = new Promise((resolve) => {
        releaseDelete = resolve;
      });
      if (status !== 200) mailbox.trashStatus = status;
      if (status === 401) mailbox.refreshRefused = true;
      const deletion = service.trashMessage(a.id, 'a');
      const result = status === 200 ? deletion : expect(deletion).rejects.toMatchObject({ status: 409 });
      await vi.waitFor(() =>
        expect(gmail.request.mock.calls.some(([url]) => String(url).endsWith('/trash'))).toBe(true),
      );
      expect((await service.list())[0].syncing).toBe(false);
      const before = gmail.request.mock.calls.length;
      expect(await service.sync(a.id)).toMatchObject({ syncing: true, lastSyncAt });
      expect(await service.sync(a.id)).toMatchObject({ syncing: true });
      expect((await service.list())[0].syncing).toBe(true);
      expect(gmail.request.mock.calls).toHaveLength(before);
      releaseDelete();
      await result;
      await settled();
      expect((await service.list())[0]).toMatchObject({
        syncing: false,
        lastSyncAt: status === 401 ? lastSyncAt : clock,
        status: status === 401 ? 'reauth' : 'connected',
      });
    },
  );

  it.each(['sync', 'trash'])(
    'expires trash queued behind a slow %s without dispatching it later',
    async (blockedBy) => {
      const a = await connect({ access: 'manage' });
      await settled();
      let release;
      const held = new Promise((resolve) => {
        release = resolve;
      });
      let blocking;
      if (blockedBy === 'sync') {
        const originalUpsert = store.upsert;
        let entered;
        const started = new Promise((resolve) => {
          entered = resolve;
        });
        store.upsert = async (...args) => {
          entered();
          await held;
          return originalUpsert(...args);
        };
        await service.update(a.id, { syncDays: 31 });
        await started;
      } else {
        mailbox.trashWait = held;
        blocking = service.trashMessage(a.id, 'a');
        await vi.waitFor(() =>
          expect(gmail.request.mock.calls.some(([url]) => String(url).endsWith('/trash'))).toBe(true),
        );
      }
      vi.useFakeTimers();
      const deletion = service.trashMessage(a.id, 'b').catch((e) => e);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(await deletion).toMatchObject({ status: 503 });
      expect((await deletion).message).toMatch(/not moved.*retry/i);
      const before = gmail.request.mock.calls.length;
      await service.sync(a.id);
      await vi.advanceTimersByTimeAsync(1);
      expect(gmail.request.mock.calls).toHaveLength(before);
      release();
      await blocking;
      vi.useRealTimers();
      await settled();
      expect(
        gmail.request.mock.calls.filter(([url]) => String(url).endsWith('/messages/b/trash')),
      ).toHaveLength(0);
      expect((await service.message(a.id, 'b')).id).toBe('b');
      await service.trashMessage(a.id, 'b');
      expect(store.messages.has(`${a.id}:b`)).toBe(false);
    },
  );

  it('waits for a running sync, and holds subsequent syncs until deletion completes', async () => {
    const a = await connect({ access: 'manage' });
    await settled();
    const originalUpsert = store.upsert;
    let releaseSync;
    const syncing = new Promise((resolve) => {
      releaseSync = resolve;
    });
    let sawUpsert;
    const entered = new Promise((resolve) => {
      sawUpsert = resolve;
    });
    store.upsert = async (...args) => {
      sawUpsert();
      await syncing;
      return originalUpsert(...args);
    };
    // Force a full pass; the original cached credentials still have write scope.
    await service.update(a.id, { syncDays: 31 });
    await entered;
    let releaseDelete;
    mailbox.trashWait = new Promise((resolve) => {
      releaseDelete = resolve;
    });
    const deletion = service.trashMessage(a.id, 'a');
    expect(gmail.request.mock.calls.some(([url]) => String(url).endsWith('/trash'))).toBe(false);
    releaseSync();
    await vi.waitFor(() =>
      expect(gmail.request.mock.calls.some(([url]) => String(url).endsWith('/trash'))).toBe(true),
    );
    const before = gmail.request.mock.calls.length;
    await service.sync(a.id);
    await new Promise((resolve) => setImmediate(resolve));
    expect(gmail.request.mock.calls).toHaveLength(before);
    releaseDelete();
    await deletion;
    await settled();
    expect(store.messages.has(`${a.id}:a`)).toBe(false);
  });
});

describe('mail management access', () => {
  it.each(
    ['refresh', 'reply metadata'].flatMap((wait) =>
      ['opt-out', 'project disabled', 'session closed', 'unchanged'].map((change) => [wait, change]),
    ),
  )('revalidates route authorization after %s with %s', async (wait, change) => {
    mailbox.manage = true;
    const account = await connect({ access: 'manage' });
    await settled();
    const job = { kind: 'devchat', repo: 'owner/repo', status: 'running' };
    let project = { mailToolsEnabled: true, enabled: true };
    let release;
    const paused = new Promise((resolve) => (release = resolve));
    if (wait === 'refresh') {
      clock += 2 * 3600_000;
      gmail.gate.refresh = paused;
    } else {
      const original = gmail.request.getMockImplementation();
      gmail.request.mockImplementation(async (url, init) => {
        if (String(url).endsWith('?format=metadata')) {
          await paused;
          return new Response(
            JSON.stringify({
              threadId: 'thread',
              payload: {
                headers: [
                  { name: 'From', value: 'you@example.com' },
                  { name: 'Subject', value: 's' },
                  { name: 'Message-ID', value: '<original@example.com>' },
                ],
              },
            }),
          );
        }
        return original(url, init);
      });
    }
    const app = express();
    app.use(express.json());
    app.use(mailAgentRoutes({ service, agentSession: () => job, getProject: () => project }));
    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    try {
      const pending = fetch(
        `http://127.0.0.1:${server.address().port}/api/agent/mail/accounts/${account.id}/action`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(
            wait === 'refresh'
              ? { action: 'send', to: ['you@example.com'], subject: 's', text: 'b' }
              : { action: 'reply', id: 'a', text: 'b' },
          ),
        },
      );
      await vi.waitFor(() =>
        expect(
          wait === 'refresh'
            ? gmail.tokenCalls.some((c) => c.grant_type === 'refresh_token')
            : gmail.request.mock.calls.some(([url]) => String(url).endsWith('?format=metadata')),
        ).toBe(true),
      );
      if (change === 'opt-out') project = { ...project, mailToolsEnabled: false };
      if (change === 'project disabled') project = { ...project, enabled: false };
      if (change === 'session closed') job.status = 'closed';
      release();
      const response = await pending;
      expect(response.status).toBe(change === 'unchanged' ? 200 : 403);
      expect(await response.json()).toMatchObject(
        change === 'unchanged'
          ? { status: 'accepted' }
          : { error: expect.stringMatching(/interactive session/) },
      );
      expect(gmail.request.mock.calls.filter(([url]) => String(url).endsWith('/messages/send'))).toHaveLength(
        change === 'unchanged' ? 1 : 0,
      );
      await settled();
    } finally {
      release();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it.each(['corrupt', 'missing-key', 'changed-key'])(
    'keeps account inspection and disabling available with %s credentials',
    async (damage) => {
      mailbox.manage = true;
      const account = await connect({ access: 'manage' });
      await settled();
      if (damage === 'corrupt') {
        store.accounts.get(account.id).credentials = 'broken';
        await service.init();
      } else cfg.credentialsKey = damage === 'missing-key' ? '' : 'z'.repeat(32);
      expect((await service.list())[0]).toMatchObject({ id: account.id, access: 'read' });
      expect(await service.update(account.id, { enabled: false })).toMatchObject({ enabled: false });
      const before = gmail.request.mock.calls.length;
      await expect(service.action(account.id, { action: 'read', id: 'a' })).rejects.toThrow();
      expect(gmail.request.mock.calls.length).toBe(before);
    },
  );

  it('marks a refused action refresh for reconnect before issuing a write', async () => {
    mailbox.manage = true;
    const account = await connect({ access: 'manage' });
    await settled();
    clock += 2 * 3600_000;
    mailbox.refreshRefused = true;
    await expect(service.action(account.id, { action: 'read', id: 'a' })).rejects.toMatchObject({
      reauth: true,
    });
    expect((await service.list())[0]).toMatchObject({
      status: 'reauth',
      lastSyncError: expect.stringMatching(/expired or revoked/),
    });
    expect(
      gmail.request.mock.calls.some(
        ([, opts]) => opts.method === 'POST' && opts.body?.includes('removeLabelIds'),
      ),
    ).toBe(false);
  });

  it('does not mark reconnected credentials for an old action refresh refusal', async () => {
    mailbox.manage = true;
    const account = await connect({ access: 'manage' });
    await settled();
    clock += 2 * 3600_000;
    let release;
    gmail.gate.refresh = new Promise((resolve) => (release = resolve));
    mailbox.refreshRefused = true;
    const action = service.action(account.id, { action: 'read', id: 'a' });
    const rejected = expect(action).rejects.toMatchObject({ status: 409 });
    await connect({ accountId: account.id, access: 'manage' }, 'fresh');
    release();
    await rejected;
    await settled();
    expect((await service.list())[0].status).toBe('connected');
    expect(JSON.parse(open(store.accounts.get(account.id).credentials)).refreshToken).toBe('refresh-fresh');
  });

  it.each(['remove', 'read reconnect', 'manage reconnect'])(
    'refuses an obsolete action token after %s during a successful refresh',
    async (change) => {
      mailbox.manage = true;
      const account = await connect({ access: 'manage' });
      await settled();
      clock += 2 * 3600_000;
      let release;
      gmail.gate.refresh = new Promise((resolve) => (release = resolve));
      const action = service
        .action(account.id, {
          action: 'send',
          to: ['you@example.com'],
          subject: 's',
          text: 'b',
        })
        .catch((e) => e);
      await vi.waitFor(() =>
        expect(gmail.tokenCalls.some((c) => c.grant_type === 'refresh_token')).toBe(true),
      );
      if (change === 'remove') await service.remove(account.id);
      else {
        mailbox.manage = change === 'manage reconnect';
        await connect({ accountId: account.id, access: mailbox.manage ? 'manage' : 'read' }, 'fresh');
      }
      release();
      const error = await action;
      expect(error).toMatchObject({
        status: change === 'remove' ? 404 : change === 'read reconnect' ? 403 : 409,
      });
      expect(error).not.toHaveProperty('uncertain');
      expect(gmail.request.mock.calls.filter(([url]) => url.endsWith('/messages/send'))).toHaveLength(0);
      await settled();
    },
  );

  it('allows an action after its own successful refresh', async () => {
    mailbox.manage = true;
    const account = await connect({ access: 'manage' });
    await settled();
    clock += 2 * 3600_000;
    expect(
      await service.action(account.id, {
        action: 'send',
        to: ['you@example.com'],
        subject: 's',
        text: 'b',
      }),
    ).toMatchObject({ status: 'accepted' });
    const sent = gmail.request.mock.calls.find(([url]) => url.endsWith('/messages/send'));
    expect(sent[1].headers.Authorization).toBe('Bearer access-2');
    await settled();
  });

  it('queues a sync after a write when the running pass holds stale state', async () => {
    mailbox.manage = true;
    const account = await connect({ access: 'manage' });
    await settled();
    let release;
    let paused = false;
    const gate = new Promise((resolve) => (release = resolve));
    const original = gmail.request.getMockImplementation();
    gmail.request.mockImplementation(async (url, opts) => {
      if (url.includes('/history?')) return Response.json({}, { status: 404 });
      if (url.endsWith('/messages/a/modify')) {
        mailbox.messages.a.unread = false;
        return Response.json({});
      }
      const response = await original(url, opts);
      if (url.includes('/messages/a?format=full') && !paused) {
        paused = true;
        await gate;
      }
      return response;
    });
    await service.sync(account.id);
    await vi.waitFor(() => expect(paused).toBe(true));
    await service.action(account.id, { action: 'read', id: 'a' });
    release();
    await settled();
    expect((await service.message(account.id, 'a')).isRead).toBe(true);
    expect(errors).toEqual([]);
  });

  it('keeps existing grants read-only and refuses actions without touching the provider', async () => {
    const account = await connect();
    await settled();
    expect((await service.list())[0].access).toBe('read');
    const before = gmail.request.mock.calls.length;
    await expect(
      service.action(account.id, { action: 'send', to: ['you@example.com'], subject: 's', text: 'body' }),
    ).rejects.toMatchObject({ status: 403 });
    expect(gmail.request.mock.calls.length).toBe(before);
  });
  it('stores management access sealed and preserves it across refresh and reconnect', async () => {
    mailbox.manage = true;
    const account = await connect({ access: 'manage' });
    await settled();
    expect(account.access).toBe('manage');
    expect(account).not.toHaveProperty('credentials');
    expect(JSON.parse(open(store.accounts.get(account.id).credentials)).access).toBe('manage');
    clock += 3600_000;
    await service.sync(account.id);
    await settled();
    expect(JSON.parse(open(store.accounts.get(account.id).credentials)).access).toBe('manage');
    mailbox.manage = false;
    const reconnected = await connect({ accountId: account.id, access: 'read' });
    await settled();
    expect(reconnected.access).toBe('read');
    await expect(service.action(account.id, { action: 'archive', id: 'a' })).rejects.toMatchObject({
      status: 403,
    });
  });
  it('sends using the sealed grant and starts an authoritative sync afterward', async () => {
    mailbox.manage = true;
    const account = await connect({ access: 'manage' });
    await settled();
    clock += 1000;
    const result = await service.action(account.id, {
      action: 'send',
      to: ['you@example.com'],
      subject: 'Hello',
      text: 'Body',
    });
    expect(result).toEqual({ status: 'accepted', action: 'send', id: 'sent', threadId: 'sent-thread' });
    const sent = gmail.request.mock.calls.find(([url]) => url.endsWith('/messages/send'));
    expect(sent[1].headers.Authorization).toBe('Bearer access-1');
    await settled();
    expect((await service.list())[0].lastSyncAt).toBe(clock);
    expect(errors).toEqual([]);
  });
  it('does not sync or reconcile Sent after a failed Gmail reply metadata read', async () => {
    cfg.mail.syncMinutes = 0;
    mailbox.manage = true;
    const account = await connect({ access: 'manage' });
    await settled();
    gmail.request.mockClear();
    gmail.request.mockRejectedValue(new TypeError('fetch failed'));
    const error = await service
      .action(account.id, { action: 'reply', id: 'a', text: 'Answer' })
      .catch((e) => e);
    await settled();
    expect(error).toMatchObject({ status: 502, message: expect.stringMatching(/no mail action was sent/) });
    expect(error).not.toHaveProperty('uncertain');
    expect(error).not.toHaveProperty('syncCompleted');
    expect(gmail.request).toHaveBeenCalledTimes(1);
    expect(gmail.request.mock.calls[0][0]).toBe(`${GMAIL}/messages/a?format=metadata`);
    expect(gmail.request.mock.calls[0][1].method).toBe('GET');
    expect(errors).toEqual([]);
  });

  it.each(['read', 'unread', 'archive'])(
    'refreshes committed %s state after a server error with periodic sync disabled',
    async (action) => {
      cfg.mail.syncMinutes = 0;
      mailbox.manage = true;
      const account = await connect({ access: 'manage' });
      await settled();
      const id = action === 'unread' ? 'b' : 'a';
      const before = await service.message(account.id, id);
      const original = gmail.request.getMockImplementation();
      gmail.request.mockImplementation(async (url, opts) => {
        if (url.endsWith(`/messages/${id}/modify`)) {
          mailbox.messages[id].unread = action === 'unread';
          return Response.json({}, { status: 503 });
        }
        if (url.includes('/history?')) return Response.json({}, { status: 404 });
        const response = await original(url, opts);
        if (action === 'archive' && url.includes(`/messages/${id}?format=full`)) {
          const data = await response.json();
          data.labelIds = data.labelIds.filter((label) => label !== 'INBOX');
          return Response.json(data);
        }
        return response;
      });
      const error = await service.action(account.id, { action, id }).catch((e) => e);
      expect(error).toMatchObject({ uncertain: true, syncCompleted: true });
      const after = await service.message(account.id, id);
      if (action === 'archive') {
        expect(before.inInbox).toBe(true);
        expect(after.inInbox).toBe(false);
      } else {
        expect(after.isRead).toBe(action === 'read');
        expect(after.isRead).not.toBe(before.isRead);
      }
      expect(gmail.request.mock.calls.filter(([url]) => url.endsWith(`/messages/${id}/modify`))).toHaveLength(
        1,
      );
      expect((await service.list())[0].syncing).toBe(false);
      expect(errors).toEqual([]);
    },
  );

  it.each(['lost response', 'server error', 'failed sync', 'running sync'])(
    'refreshes uncertain sends before returning reconciliation guidance: %s',
    async (scenario) => {
      cfg.mail.syncMinutes = 0;
      mailbox.manage = true;
      const account = await connect({ access: 'manage' });
      await settled();
      const original = gmail.request.getMockImplementation();
      let release;
      const gate = new Promise((resolve) => (release = resolve));
      let paused = false;
      let wrote = false;
      let finished = false;
      gmail.request.mockImplementation(async (url, opts) => {
        if (url.endsWith('/messages/send')) {
          wrote = true;
          mailbox.messages.sent = { at: clock, labels: ['SENT'] };
          if (scenario === 'server error') return Response.json({}, { status: 503 });
          throw new Error('response lost');
        }
        if (scenario === 'failed sync') return Response.json({}, { status: 403 });
        if (url.includes('/history?')) return Response.json({}, { status: 404 });
        const response = await original(url, opts);
        if (scenario === 'running sync' && url.includes('/messages?') && !paused) {
          paused = true;
          await gate;
        }
        return response;
      });
      if (scenario === 'running sync') {
        await service.sync(account.id);
        await vi.waitFor(() => expect(paused).toBe(true));
      }
      const action = service
        .action(account.id, { action: 'send', to: ['you@example.com'], subject: 's', text: 'b' })
        .catch((error) => {
          finished = true;
          return error;
        });
      await vi.waitFor(() => expect(wrote).toBe(true));
      if (scenario === 'running sync') {
        expect(finished).toBe(false);
        release();
      }
      const error = await action;
      expect(error).toMatchObject({ uncertain: true, syncCompleted: scenario !== 'failed sync' });
      expect(gmail.request.mock.calls.filter(([url]) => url.endsWith('/messages/send'))).toHaveLength(1);
      if (scenario === 'failed sync') {
        expect(error.message).toMatch(/cached absence from Sent cannot justify a retry/);
        expect((await service.list())[0].lastSyncError).toBeTruthy();
      } else {
        expect(error.message).toMatch(/fresh mailbox sync completed/);
        expect(
          (await service.messages({ account: account.id })).messages.some(
            (m) => m.id === 'sent' && m.labels.includes('SENT'),
          ),
        ).toBe(true);
      }
    },
  );
  it.each(['fresh sync', 'running sync', 'slow reply'])(
    'returns pending uncertainty guidance within ten seconds while retaining the %s',
    async (scenario) => {
      cfg.mail.syncMinutes = 0;
      mailbox.manage = true;
      const account = await connect({ access: 'manage' });
      await settled();
      const original = gmail.request.getMockImplementation();
      let release;
      const gate = new Promise((resolve) => (release = resolve));
      let paused = false;
      gmail.request.mockImplementation(async (url, opts) => {
        if (scenario === 'slow reply' && url.includes('?format=metadata')) {
          await new Promise((resolve) => setTimeout(resolve, 29_000));
          return Response.json({
            threadId: 'thread',
            payload: {
              headers: [
                { name: 'From', value: 'you@example.com' },
                { name: 'Subject', value: 's' },
                { name: 'Message-ID', value: '<original@example.com>' },
              ],
            },
          });
        }
        if (url.endsWith('/messages/send')) {
          mailbox.messages.sent = { at: clock, labels: ['SENT'] };
          if (scenario === 'slow reply') await new Promise((resolve) => setTimeout(resolve, 30_000));
          throw new Error('response lost');
        }
        if (url.includes('/history?')) return Response.json({}, { status: 404 });
        const response = await original(url, opts);
        if (url.includes('/messages?') && !paused) {
          paused = true;
          await gate;
        }
        return response;
      });
      if (scenario === 'running sync') {
        await service.sync(account.id);
        await vi.waitFor(() => expect(paused).toBe(true));
      }
      vi.useFakeTimers();
      const action = service
        .action(account.id, {
          action: scenario === 'slow reply' ? 'reply' : 'send',
          id: 'original',
          to: ['you@example.com'],
          subject: 's',
          text: 'b',
        })
        .catch((e) => e);
      await vi.advanceTimersByTimeAsync(scenario === 'slow reply' ? 69_000 : 10_000);
      const error = await action;
      expect(error).toMatchObject({ uncertain: true, syncCompleted: false, syncPending: true });
      expect(error.message).toMatch(/reconciliation is still pending/);
      expect(error.message).toMatch(/cached absence from Sent cannot justify a retry/);
      expect(error.message).toMatch(/absence alone does not prove non-delivery/);
      expect((await service.list())[0].syncing).toBe(true);
      expect(gmail.request.mock.calls.filter(([url]) => url.endsWith('/messages/send'))).toHaveLength(1);
      release();
      vi.useRealTimers();
      await settled();
      expect((await service.messages({ account: account.id })).messages.some((m) => m.id === 'sent')).toBe(
        true,
      );
      expect(errors).toEqual([]);
    },
  );

  it('rejects invalid or refused management consent without saving a grant', async () => {
    expect(() => service.connectStart({ provider: 'gmail', access: 'admin' })).toThrow(/Choose/);
    await expect(connect({ access: 'manage' })).rejects.toThrow(/did not grant/);
    expect(await service.list()).toEqual([]);
  });
});
