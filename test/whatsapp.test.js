import express from 'express';
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWhatsAppService } from '../lib/whatsapp.js';
import { whatsappRoutes } from '../lib/whatsapp-routes.js';
import { apiV1Routes } from '../lib/api-v1.js';
import { createMobileAuth } from '../lib/mobile-auth.js';

const KEY = 'private-waha-key';
const CHAT = '49123456789@c.us';
const MID = `false_${CHAT}_ABC123`;
const RAW_MESSAGE = {
  id: MID,
  timestamp: 1700000000,
  from: CHAT,
  to: '49999999999@c.us',
  fromMe: false,
  body: 'Hello',
  hasMedia: false,
  ack: 3,
  _data: { private: 'engine internals' },
};
const servers = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

async function serve(app) {
  const server = app.listen(0, '127.0.0.1');
  servers.push(server);
  await new Promise((resolve) => server.once('listening', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

async function mediaService(fileHandler, timeoutMs = 150) {
  const upstream = express();
  upstream.get('/api/default/chats/:chat/messages/:message', (_req, res) =>
    res.json({ hasMedia: true, media: { url: '/api/files/default/test' } }),
  );
  upstream.get('/api/files/default/test', fileHandler);
  const url = await serve(upstream);
  return createWhatsAppService({ config: () => ({ url, apiKey: KEY }), timeoutMs });
}

async function setup() {
  const calls = [];
  let current = null;
  let failure = 0;
  let mediaUrl = '';
  const upstream = express();
  upstream.use(express.json());
  upstream.use((req, res) => {
    const path = decodeURIComponent(req.path);
    expect(req.headers['x-api-key']).toBe(KEY);
    calls.push({ path, query: req.query, method: req.method, body: req.body });
    if (failure) return res.status(failure).json({ apiKey: KEY, message: 'private upstream error' });
    if (path === '/api/sessions' && req.method === 'GET') return res.json(current ? [current] : []);
    if (path === '/api/sessions' && req.method === 'POST') {
      current = {
        name: req.body.name,
        status: 'STARTING',
        config: { webhooks: [{ hmac: { key: KEY } }] },
        me: null,
      };
      return res.status(201).json(current);
    }
    if (path === '/api/sessions/default') return current ? res.json(current) : res.sendStatus(404);
    if (/\/api\/sessions\/default\/(start|restart)$/.test(path)) {
      current.status = 'STARTING';
      return res.json(current);
    }
    if (path === '/api/sessions/default/logout') {
      current.me = null;
      return res.json({});
    }
    if (path === '/api/default/auth/qr') return res.json({ mimetype: 'image/png', data: 'cXJjb2Rl' });
    if (path === '/api/default/chats/overview')
      return res.json([
        { id: CHAT, name: 'Customer', _chat: { unreadCount: 2, private: KEY }, lastMessage: RAW_MESSAGE },
      ]);
    if (path.endsWith('/messages/read')) return res.json({ ids: [MID] });
    if (path.endsWith(`/messages/${MID}`))
      return res.json({ ...RAW_MESSAGE, hasMedia: true, media: { url: mediaUrl } });
    if (path.endsWith('/messages')) return res.json([RAW_MESSAGE]);
    if (path === '/api/sendText')
      return res.status(201).json({ ...RAW_MESSAGE, body: req.body.text, fromMe: true });
    if (path === '/api/files/default/attachment.ogg')
      return res.type('audio/ogg').send(Buffer.from('audio bytes'));
    return res.sendStatus(404);
  });
  const wahaUrl = await serve(upstream);
  mediaUrl = `${wahaUrl}/api/files/default/attachment.ogg`;
  const service = createWhatsAppService({ config: () => ({ url: wahaUrl, apiKey: KEY }) });
  let devices = [];
  const auth = createMobileAuth({
    load: async () => structuredClone(devices),
    save: async (_key, value) => {
      devices = structuredClone(value);
    },
  });
  await auth.init();
  const tokens = {};
  for (const permission of ['read', 'manage', 'admin'])
    tokens[permission] = (
      await auth.create({ label: permission, permission, repos: ['o/r'], days: 30 }, 'owner')
    ).token;
  const app = express();
  app.use(
    apiV1Routes({
      auth,
      apiEnabled: () => true,
      ownerSecret: () => 'owner',
      handlers: whatsappRoutes({ service }),
      getJob: () => null,
      getProject: () => null,
      listSessions: () => [],
      bus: new EventEmitter(),
    }),
  );
  const url = await serve(app);
  const request = (path = '', { method = 'GET', body, token = tokens.admin } = {}) =>
    fetch(`${url}/api/v1/whatsapp/accounts${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  return {
    service,
    request,
    calls,
    tokens,
    setCurrent: (value) => {
      current = value;
    },
    setFailure: (value) => {
      failure = value;
    },
    setMedia: (value) => {
      mediaUrl = value;
    },
  };
}

describe('the WhatsApp core inbox', () => {
  it('starts and pairs the default account, reads chats/history, replies and marks read without a project', async () => {
    const ctx = await setup();
    expect(await (await ctx.request()).json()).toEqual({ configured: true, accounts: [] });
    expect((await ctx.request('/default/start', { method: 'POST' })).status).toBe(200);
    expect(ctx.calls.find((c) => c.path === '/api/sessions' && c.method === 'POST').body).toEqual({
      name: 'default',
      start: true,
      config: { noweb: { store: { enabled: true, fullSync: true } } },
    });
    expect(await (await ctx.request('/default/qr')).json()).toEqual({
      mimetype: 'image/png',
      data: 'cXJjb2Rl',
    });
    ctx.setCurrent({
      name: 'default',
      status: 'WORKING',
      me: { id: '49999999999@c.us', pushName: 'Nadin' },
      config: { apiKey: KEY },
    });
    const accounts = await (await ctx.request()).json();
    expect(accounts.accounts).toEqual([
      { id: 'default', status: 'WORKING', me: { id: '49999999999@c.us', name: 'Nadin' } },
    ]);
    const chats = await (await ctx.request('/default/conversations?limit=1')).json();
    expect(chats.conversations[0]).toMatchObject({
      id: CHAT,
      name: 'Customer',
      unreadCount: 2,
      lastMessage: { text: 'Hello' },
    });
    expect(chats.nextOffset).toBe(1);
    const history = await (
      await ctx.request(`/default/conversations/${CHAT}/messages?limit=2&offset=1`)
    ).json();
    expect(history.nextOffset).toBe(3);
    expect(history.messages[0]).toMatchObject({ id: MID, text: 'Hello', ack: 3, media: null });
    expect(history.messages[0]).not.toHaveProperty('_data');
    const send = await ctx.request(`/default/conversations/${CHAT}/messages`, {
      method: 'POST',
      body: { text: ' Reply ', replyTo: MID },
    });
    expect(send.status).toBe(201);
    expect((await send.json()).message).toMatchObject({ text: 'Reply', fromMe: true });
    expect(ctx.calls.find((c) => c.path === '/api/sendText').body).toEqual({
      session: 'default',
      chatId: CHAT,
      text: 'Reply',
      reply_to: MID,
      linkPreview: false,
    });
    expect((await ctx.request(`/default/conversations/${CHAT}/read`, { method: 'POST' })).status).toBe(200);
    expect(JSON.stringify({ accounts, chats, history })).not.toContain(KEY);
    expect(await (await ctx.request('/default/logout', { method: 'POST' })).json()).toEqual({ ok: true });
  });

  it('refuses every inbox route to read/manage tokens before touching WAHA', async () => {
    const ctx = await setup();
    const routes = [
      ['', 'GET'],
      ['/default', 'GET'],
      ['/default/start', 'POST'],
      ['/default/qr', 'GET'],
      ['/default/logout', 'POST'],
      ['/default/conversations', 'GET'],
      [`/default/conversations/${CHAT}/messages`, 'GET'],
      [`/default/conversations/${CHAT}/messages`, 'POST'],
      [`/default/conversations/${CHAT}/read`, 'POST'],
      [`/default/conversations/${CHAT}/messages/${MID}/media`, 'GET'],
    ];
    for (const token of [ctx.tokens.read, ctx.tokens.manage])
      for (const [path, method] of routes)
        expect(
          (
            await ctx.request(path, {
              method,
              token,
              body: method === 'POST' ? { text: 'hello' } : undefined,
            })
          ).status,
        ).toBe(403);
    expect(ctx.calls).toEqual([]);
  });

  it('rejects malformed IDs, pagination and messages before touching WAHA', async () => {
    const ctx = await setup();
    for (const path of [
      '/default/conversations?limit=0',
      '/default/conversations?limit=101',
      '/default/conversations?offset=-1',
      '/default/conversations?limit=2&limit=3',
      '/default/conversations/not-a-chat/messages',
      '/bad%20account',
    ])
      expect((await ctx.request(path)).status).toBe(400);
    for (const body of [
      { text: '' },
      { text: ' ' },
      { text: 2 },
      { text: 'a'.repeat(8001) },
      { text: 'hi', replyTo: '../secret' },
    ])
      expect(
        (await ctx.request(`/default/conversations/${CHAT}/messages`, { method: 'POST', body })).status,
      ).toBe(400);
    expect(ctx.calls).toEqual([]);
  });

  it('does not disclose WAHA error bodies and never retries a send', async () => {
    const ctx = await setup();
    for (const [upstream, status] of [
      [401, 502],
      [429, 429],
      [422, 409],
      [501, 501],
      [500, 502],
    ]) {
      ctx.setFailure(upstream);
      const res = await ctx.request(`/default/conversations/${CHAT}/messages`, {
        method: 'POST',
        body: { text: 'Hello' },
      });
      expect(res.status).toBe(status);
      expect(await res.text()).not.toContain(KEY);
    }
    expect(ctx.calls.filter((c) => c.path === '/api/sendText')).toHaveLength(5);
  });

  it('downloads attachments through the core without sending credentials to an external media host', async () => {
    const ctx = await setup();
    ctx.setMedia('https://untrusted.invalid/api/files/default/attachment.ogg');
    const path = `/default/conversations/${CHAT}/messages/${MID}/media`;
    const res = await ctx.request(path);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('audio/ogg');
    expect(res.headers.get('content-disposition')).toBe('attachment');
    expect(await res.text()).toBe('audio bytes');
    expect(ctx.calls.at(-1).path).toBe('/api/files/default/attachment.ogg');
    for (const url of [
      'https://untrusted.invalid/private',
      'http://localhost/api/files/../sessions',
      'http://localhost/api/files/%2fsecret',
    ]) {
      ctx.setMedia(url);
      expect((await ctx.request(path)).status).toBe(502);
      expect(ctx.calls.at(-1).path).toBe(`/api/default/chats/${CHAT}/messages/${MID}`);
    }
  });

  it('advances history by raw WAHA windows even after short or empty filtered pages', async () => {
    const history = [RAW_MESSAGE, null, null, null, { ...RAW_MESSAGE, id: 'older' }];
    const fetcher = vi.fn(async (url) => {
      const query = new URL(url).searchParams;
      const offset = +query.get('offset');
      const limit = +query.get('limit');
      return Response.json(history.slice(offset, offset + limit).filter(Boolean));
    });
    const service = createWhatsAppService({
      config: () => ({ url: 'http://waha', apiKey: KEY }),
      fetcher,
    });
    const first = await service.messages('default', CHAT, { limit: '2' });
    expect(first.messages.map((m) => m.id)).toEqual([MID]);
    expect(first.nextOffset).toBe(2);
    const empty = await service.messages('default', CHAT, { limit: '2', offset: String(first.nextOffset) });
    expect(empty.messages).toEqual([]);
    expect(empty.nextOffset).toBe(4);
    const older = await service.messages('default', CHAT, { limit: '2', offset: String(empty.nextOffset) });
    expect(older.messages.map((m) => m.id)).toEqual(['older']);
    expect(older.nextOffset).toBe(6);
    expect((await service.messages('default', CHAT, { offset: '100000' })).nextOffset).toBeNull();
  });

  it('preserves quote context without treating a stanza ID as a full message ID', async () => {
    const quoted = {
      ...RAW_MESSAGE,
      id: `true_${CHAT}_REPLY`,
      fromMe: true,
      replyTo: {
        id: 'ABC123',
        participant: CHAT,
        body: 'Hello',
        hasMedia: false,
        media: { url: 'http://private/api/files/quote' },
        _data: { secret: KEY },
      },
    };
    const service = createWhatsAppService({
      config: () => ({ url: 'http://waha', apiKey: KEY }),
      fetcher: async (url) =>
        Response.json(
          String(url).includes('/overview')
            ? [{ id: CHAT, lastMessage: quoted }]
            : [quoted, RAW_MESSAGE, { ...quoted, replyTo: { body: 'Older caption', hasMedia: true } }],
        ),
    });
    const history = await service.messages('default', CHAT);
    expect(history.messages[0].replyTo).toEqual({
      id: 'ABC123',
      participant: CHAT,
      text: history.messages[1].text,
      hasMedia: false,
    });
    expect(history.messages[0].replyTo.id).not.toBe(history.messages[1].id);
    expect(history.messages[1].replyTo).toBeNull();
    expect(history.messages[2].replyTo).toEqual({
      id: null,
      participant: '',
      text: 'Older caption',
      hasMedia: true,
    });
    const chats = await service.conversations('default');
    expect(chats.conversations[0].lastMessage.replyTo).toEqual(history.messages[0].replyTo);
    expect(JSON.stringify({ history, chats })).not.toContain(KEY);
    expect(JSON.stringify({ history, chats })).not.toContain('http://private');
  });

  it.each(['/proxy/waha', '/api'])(
    'rebases attachments under %s while retaining file-path and origin protections',
    async (prefix) => {
      let location;
      const upstream = express();
      upstream.get(`${prefix}/api/default/chats/:chat/messages/:message`, (req, res) => {
        expect(req.headers['x-api-key']).toBe(KEY);
        res.json({ hasMedia: true, media: { url: location } });
      });
      upstream.get(`${prefix}/api/files/default/test`, (req, res) => {
        expect(req.headers['x-api-key']).toBe(KEY);
        res.send('attachment');
      });
      const origin = await serve(upstream);
      const service = createWhatsAppService({
        config: () => ({ url: `${origin}${prefix}`, apiKey: KEY }),
      });
      for (const url of [
        `${origin}${prefix}/api/files/default/test`,
        `${prefix}/api/files/default/test`,
        '/api/files/default/test',
        `https://untrusted.invalid${prefix}/api/files/default/test`,
      ]) {
        location = url;
        expect(await (await service.media('default', CHAT, MID)).text()).toBe('attachment');
      }
      for (const url of [
        `${prefix}-other/api/files/default/test`,
        `${prefix}/api/sessions`,
        `${prefix}/api/files/../sessions`,
        `${prefix}/api/files/%2fsecret`,
        `${prefix}/api/files/%5csecret`,
        `${prefix}/api/files/%2e%2fsecret`,
        'https://untrusted.invalid/private',
      ]) {
        location = url;
        await expect(service.media('default', CHAT, MID)).rejects.toMatchObject({ status: 502 });
      }
    },
  );

  it('streams a healthy attachment longer than the header deadline', async () => {
    const service = await mediaService((_req, res) => {
      res.type('audio/ogg').write('start');
      let chunks = 0;
      const timer = setInterval(() => {
        res.write('.');
        if (++chunks === 6) res.end('end');
      }, 60);
      res.on('close', () => clearInterval(timer));
    }, 250);
    const response = await service.media('default', CHAT, MID);
    expect(response.headers.get('content-type')).toContain('audio/ogg');
    expect(await response.text()).toBe('start......end');
  });

  it('does not count consumer backpressure as an upstream stall', async () => {
    let upstream;
    const service = await mediaService((_req, res) => {
      upstream = res;
      res.write('start');
    });
    const response = await service.media('default', CHAT, MID);
    const reader = response.body.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe('start');
    await new Promise((resolve) => setTimeout(resolve, 350));
    upstream.end('end');
    expect(new TextDecoder().decode((await reader.read()).value)).toBe('end');
    expect((await reader.read()).done).toBe(true);
  });

  it('still bounds attachment headers and stalled upstream body reads', async () => {
    const noHeaders = await mediaService(() => {});
    await expect(noHeaders.media('default', CHAT, MID)).rejects.toMatchObject({ status: 502 });
    const closed = Promise.withResolvers();
    const stalled = await mediaService((_req, res) => {
      res.write('start');
      res.on('close', () => closed.resolve());
    });
    const response = await stalled.media('default', CHAT, MID);
    await expect(response.text()).rejects.toThrow();
    await closed.promise;
  });

  it.each(['metadata', 'file'])('forwards disconnect cancellation during the %s fetch', async (phase) => {
    const reached = Promise.withResolvers();
    const closed = Promise.withResolvers();
    const upstream = express();
    upstream.use((req, res) => {
      if (phase === 'metadata' || req.path.startsWith('/api/files/')) {
        res.on('close', () => closed.resolve());
        if (phase === 'file') res.write('start');
        reached.resolve();
      } else res.json({ hasMedia: true, media: { url: '/api/files/default/test' } });
    });
    const url = await serve(upstream);
    const service = createWhatsAppService({ config: () => ({ url, apiKey: KEY }) });
    const controller = new AbortController();
    const download = service.media('default', CHAT, MID, controller.signal);
    // Attach the rejection handler before cancelling the in-flight request.
    const result = phase === 'file' ? (await download).text() : download;
    const rejected = expect(result).rejects.toThrow();
    await reached.promise;
    controller.abort();
    await rejected;
    await closed.promise;
  });

  it('reconnects a stopped account and deduplicates concurrent starts', async () => {
    const ctx = await setup();
    ctx.setCurrent({ name: 'default', status: 'STOPPED', me: null });
    await Promise.all([ctx.service.start('default'), ctx.service.start('default')]);
    expect(ctx.calls.filter((c) => c.path === '/api/sessions/default/start')).toHaveLength(1);
    ctx.calls.length = 0;
    ctx.setCurrent({ name: 'default', status: 'WORKING', me: null });
    await ctx.service.start('default');
    expect(ctx.calls).toHaveLength(1);
  });

  it('reports disabled installs without a network call', async () => {
    const fetcher = vi.fn();
    const service = createWhatsAppService({ config: () => null, fetcher });
    expect(await service.accounts()).toEqual({ configured: false, accounts: [] });
    await expect(service.start('default')).rejects.toMatchObject({ status: 503 });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('does not follow redirects carrying the WAHA API key', async () => {
    const redirect = express();
    redirect.use((_req, res) => res.redirect('http://127.0.0.1:1/stolen'));
    const url = await serve(redirect);
    const service = createWhatsAppService({ config: () => ({ url, apiKey: KEY }) });
    await expect(service.accounts()).rejects.toMatchObject({ status: 502 });
  });
});
