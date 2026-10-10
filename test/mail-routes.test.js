import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMobileAuth } from '../lib/mobile-auth.js';
import { apiV1Routes } from '../lib/api-v1.js';
import { mailRoutes, mailCallbackRoutes } from '../lib/mail-routes.js';

// lib/mail.js is only here for its defaults: the service below is a fake,
// so neither the configuration nor the database is ever read.
vi.mock('../lib/config.js', () => ({ getConfig: () => ({}) }));

const secret = 'owner-secret';
let server, url, service, tokens;

// The real path a client's request takes: the /api/v1 gateway judges the
// token, then hands the request to the mail handlers at their own path.
beforeEach(async () => {
  let saved = [];
  const auth = createMobileAuth({
    load: async () => structuredClone(saved),
    save: async (_name, value) => {
      saved = structuredClone(value);
    },
  });
  await auth.init();
  const create = async (permission) =>
    (await auth.create({ label: permission, repos: ['owner/repo'], permission, days: 30 }, secret)).token;
  tokens = { manage: await create('manage'), admin: await create('admin') };
  service = {
    list: vi.fn(async () => [{ id: 1, email: 'me@gmail.com' }]),
    providers: vi.fn(() => ['gmail']),
    callbackUrl: vi.fn(() => 'https://briareus.test/oauth/mail/callback'),
    connectStart: vi.fn((input) => ({ url: 'https://accounts.google.com/x', state: 's', input })),
    connectFinish: vi.fn(async (input) => {
      if (String(input.url).includes('state=stale'))
        throw Object.assign(new Error('This sign-in has expired or was already used; start it again'), {
          status: 400,
        });
      return { id: 1, email: 'me@gmail.com', input };
    }),
    update: vi.fn(async (id, input) => ({ id, input })),
    remove: vi.fn(async () => {}),
    trashMessage: vi.fn(async () => {}),
    sync: vi.fn(async (id) => ({ id, syncing: true })),
    messages: vi.fn(async (query) => ({ messages: [], nextCursor: null, query })),
    message: vi.fn(async (account, id) => {
      if (id === 'missing') throw Object.assign(new Error('Message not found'), { status: 404 });
      return { accountId: account, id };
    }),
  };
  const handlers = express.Router();
  handlers.use(mailRoutes({ service }));
  const app = express();
  app.use(
    apiV1Routes({
      auth,
      apiEnabled: () => true,
      ownerSecret: () => secret,
      handlers,
      getJob: () => null,
      getProject: () => null,
      listSessions: () => [],
      bus: { on() {}, off() {} },
    }),
  );
  app.use(mailCallbackRoutes({ service }));
  // An agent's session token at the handlers' own path is turned away.
  app.use(express.json(), handlers);
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  url = `http://127.0.0.1:${server.address().port}`;
});
afterEach(async () => {
  await new Promise((resolve) => server.close(resolve));
});

const call = (path, { token = tokens.admin, method = 'GET', body } = {}) =>
  fetch(`${url}${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

describe('mail through /api/v1', () => {
  it('answers an admin token only', async () => {
    const res = await call('/api/v1/mail/messages', { token: tokens.manage });
    expect(res.status).toBe(403);
    expect(service.messages).not.toHaveBeenCalled();
    expect((await call('/api/v1/settings/mail/accounts', { token: tokens.manage })).status).toBe(403);
    expect((await call('/api/v1/mail/messages', { token: '' })).status).toBe(401);
  });

  it('is not reachable with a session token at the handlers’ own path', async () => {
    const res = await call('/api/mail/messages', { token: 'session-token' });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Mail is reached through /api/v1' });
  });

  it('deletes an encoded message only through the admin gateway', async () => {
    const path = `/api/v1/mail/accounts/7/messages/${encodeURIComponent('same/+=')}`;
    expect((await call(path, { method: 'DELETE', token: tokens.manage })).status).toBe(403);
    expect((await call(path, { method: 'DELETE', token: '' })).status).toBe(401);
    expect(service.trashMessage).not.toHaveBeenCalled();
    const res = await call(path, { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(service.trashMessage).toHaveBeenCalledWith(7, 'same/+=');
    expect((await call('/api/mail/accounts/7/messages/m', { method: 'DELETE', token: 'agent' })).status).toBe(
      403,
    );
  });

  it('returns a mailbox reconnect conflict to an admin client without blocking reads', async () => {
    service.trashMessage.mockRejectedValue(
      Object.assign(new Error('Reconnect this mailbox with access: manage to trash mail'), {
        status: 409,
      }),
    );
    const res = await call('/api/v1/mail/accounts/7/messages/a', { method: 'DELETE' });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: 'Reconnect this mailbox with access: manage to trash mail',
    });
    expect((await call('/api/v1/settings/mail/accounts')).status).toBe(200);
    expect((await call('/api/v1/mail/messages')).status).toBe(200);
  });

  it('lists accounts with the providers and defaults', async () => {
    expect(await (await call('/api/v1/settings/mail/accounts')).json()).toEqual({
      accounts: [{ id: 1, email: 'me@gmail.com' }],
      providers: ['gmail'],
      callbackUrl: 'https://briareus.test/oauth/mail/callback',
      defaults: { label: '', enabled: true, syncDays: 30 },
    });
  });

  it('starts and finishes a connection', async () => {
    const start = await call('/api/v1/settings/mail/accounts/connect', {
      method: 'POST',
      body: { provider: 'gmail', syncDays: 7 },
    });
    expect(start.status).toBe(200);
    expect(service.connectStart).toHaveBeenCalledWith({ provider: 'gmail', syncDays: 7 });

    const finish = await call('/api/v1/settings/mail/accounts/connect/finish', {
      method: 'POST',
      body: { url: 'http://127.0.0.1/?code=c&state=s' },
    });
    expect(finish.status).toBe(201);
    expect(await finish.json()).toEqual({
      account: { id: 1, email: 'me@gmail.com', input: { url: 'http://127.0.0.1/?code=c&state=s' } },
    });
  });

  it('changes, syncs and removes an account by id', async () => {
    const put = await call('/api/v1/settings/mail/accounts/7', { method: 'PUT', body: { label: 'Work' } });
    expect(await put.json()).toEqual({ account: { id: 7, input: { label: 'Work' } } });
    const sync = await call('/api/v1/settings/mail/accounts/7/sync', { method: 'POST' });
    expect(sync.status).toBe(202);
    expect(await sync.json()).toEqual({ account: { id: 7, syncing: true } });
    expect(await (await call('/api/v1/settings/mail/accounts/7', { method: 'DELETE' })).json()).toEqual({
      ok: true,
    });
    expect(service.remove).toHaveBeenCalledWith(7);
  });

  it('hands the filters on, and reads a message whose id holds / + and =', async () => {
    const list = await call('/api/v1/mail/messages?account=1&unread=1&q=invoice&cursor=abc');
    expect((await list.json()).query).toEqual({ account: '1', unread: '1', q: 'invoice', cursor: 'abc' });

    const id = 'AAMkAD/x+y==';
    const res = await call(`/api/v1/mail/accounts/1/messages/${encodeURIComponent(id)}`);
    expect(await res.json()).toEqual({ message: { accountId: 1, id } });
    expect(service.message).toHaveBeenCalledWith(1, id);

    const missing = await call('/api/v1/mail/accounts/1/messages/missing');
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: 'Message not found' });
  });
});

describe('the sign-in callback', () => {
  it('finishes the sign-in the browser brings back, with no token, in plain text', async () => {
    const res = await call('/oauth/mail/callback?state=s1&code=4%2F0Ab&scope=x', { token: '' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^text\/plain/);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.text()).toBe('Connected me@gmail.com. You can close this window.\n');
    const { url: finished } = service.connectFinish.mock.calls[0][0];
    expect(Object.fromEntries(new URL(finished).searchParams)).toEqual({
      state: 's1',
      code: '4/0Ab',
      scope: 'x',
    });
  });

  it('says why when the sign-in cannot be finished', async () => {
    const res = await call('/oauth/mail/callback?state=stale&code=c', { token: '' });
    expect(res.status).toBe(400);
    expect(await res.text()).toBe(
      'The mailbox was not connected: This sign-in has expired or was already used; start it again\n',
    );
  });
});
