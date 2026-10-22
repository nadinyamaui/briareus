import express from 'express';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

let server, base, stored, request, user, homeAssistantCheck, root, githubRest;
beforeEach(async () => {
  vi.resetModules();
  const { meRoutes } = await import('../lib/me-routes.js');
  ({ githubRest } = await import('../lib/github.js'));
  stored = new Map();
  user = { id: 2, name: 'Ana', role: 'member' };
  const credentials = {
    get: (id, kind) => stored.get(`${id}:${kind}`) ?? null,
    set: async (id, kind, value) => void stored.set(`${id}:${kind}`, value),
    remove: async (id, kind) => void stored.delete(`${id}:${kind}`),
  };
  request = vi.fn(async (_url, init) =>
    init.headers.Authorization === 'Bearer good'
      ? Response.json({ login: 'ana-gh', id: 42 })
      : new Response('', { status: 401 }),
  );
  const realFetch = globalThis.fetch;
  vi.stubGlobal('fetch', (url, init) =>
    String(url).startsWith('https://api.github.com/') ? request(url, init) : realFetch(url, init),
  );
  homeAssistantCheck = vi.fn(async (cfg) => {
    if (cfg.token !== 'ha-good')
      throw Object.assign(new Error('Home Assistant refused its token'), { status: 502 });
  });
  const app = express();
  app.use(express.json());
  app.use((_req, res, next) => {
    res.locals.apiUser = user;
    next();
  });
  app.use(meRoutes({ credentials, homeAssistantCheck }));
  server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  root = `http://127.0.0.1:${server.address().port}/api/me`;
  base = `${root}/github`;
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await new Promise((r) => server.close(r));
});

const put = (body, headers = {}) =>
  fetch(base, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

it('connects a GitHub token after GitHub names its account, and never shows it back', async () => {
  expect(await (await fetch(base)).json()).toEqual({ connected: false, login: null });
  expect((await put({ token: 'bad' })).status).toBe(400);
  expect((await put({ token: '' })).status).toBe(400);
  const saved = await put({ token: 'good' });
  expect(await saved.json()).toEqual({ connected: true, login: 'ana-gh' });
  expect(stored.get('2:github')).toEqual({ token: 'good', login: 'ana-gh', id: 42 });
  expect(JSON.stringify(await (await fetch(base)).json())).not.toContain('good');
  expect(await (await fetch(base, { method: 'DELETE' })).json()).toEqual({ connected: false, login: null });
  expect(stored.size).toBe(0);
});

it('refuses an agent token and a request with no user', async () => {
  expect((await put({ token: 'good' }, { Authorization: 'Bearer s' })).status).toBe(403);
  user = undefined;
  expect((await fetch(base)).status).toBe(401);
});

it('does not let personal-token validation exhaust the server GitHub rate bucket', async () => {
  request.mockResolvedValueOnce(new Response('', { status: 429, headers: { 'Retry-After': '60' } }));
  expect((await put({ token: 'exhausted-personal' })).status).toBe(400);
  expect(stored.size).toBe(0);
  request.mockResolvedValueOnce(new Response('{}'));
  expect((await githubRest({ githubToken: 'server-token' }, 'GET', '/repos/o/r')).status).toBe(200);
  expect(request.mock.calls.map(([, init]) => init.headers.Authorization)).toEqual([
    'Bearer exhausted-personal',
    'Bearer server-token',
  ]);
});

it('validates a healthy personal token while the server GitHub rate bucket is exhausted', async () => {
  request.mockResolvedValueOnce(new Response('', { status: 429, headers: { 'Retry-After': '60' } }));
  await expect(githubRest({ githubToken: 'server-token' }, 'GET', '/repos/o/r')).rejects.toMatchObject({
    rateLimited: true,
  });
  request.mockResolvedValueOnce(Response.json({ login: 'ana-gh', id: 42 }));
  expect(await (await put({ token: 'healthy-personal' })).json()).toEqual({
    connected: true,
    login: 'ana-gh',
  });
  expect(stored.get('2:github').token).toBe('healthy-personal');
  expect(request.mock.calls.map(([, init]) => init.headers.Authorization)).toEqual([
    'Bearer server-token',
    'Bearer healthy-personal',
  ]);
});

it('connects a Home Assistant only once it answers, and never shows the token back', async () => {
  const home = `${root}/home-assistant`;
  const put = (body) =>
    fetch(home, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  expect(await (await fetch(home)).json()).toEqual({ connected: false, url: null });
  expect((await put({ url: 'ftp://ha', token: 'ha-good' })).status).toBe(400);
  expect((await put({ url: 'http://user:pw@ha:8123', token: 'ha-good' })).status).toBe(400);
  expect((await put({ url: 'http://ha:8123', token: '' })).status).toBe(400);
  expect((await put({ url: 'http://ha:8123', token: 'wrong' })).status).toBe(502);
  expect(stored.size).toBe(0);
  const saved = await put({ url: 'http://ha:8123/', token: 'ha-good' });
  expect(await saved.json()).toEqual({ connected: true, url: 'http://ha:8123' });
  expect(stored.get('2:homeAssistant')).toEqual({ url: 'http://ha:8123', token: 'ha-good' });
  expect(JSON.stringify(await (await fetch(home)).json())).not.toContain('ha-good');
  expect(await (await fetch(home, { method: 'DELETE' })).json()).toEqual({ connected: false, url: null });
});
