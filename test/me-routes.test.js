import express from 'express';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { meRoutes } from '../lib/me-routes.js';

let server, base, stored, request, user, homeAssistantCheck, root;
beforeEach(async () => {
  stored = new Map();
  user = { id: 2, name: 'Ana', role: 'member' };
  const credentials = {
    get: (id, kind) => stored.get(`${id}:${kind}`) ?? null,
    set: async (id, kind, value) => void stored.set(`${id}:${kind}`, value),
    remove: async (id, kind) => void stored.delete(`${id}:${kind}`),
  };
  request = vi.fn(async (cfg) =>
    cfg.githubToken === 'good'
      ? { ok: true, status: 200, json: async () => ({ login: 'ana-gh', id: 42 }) }
      : { ok: false, status: 401 },
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
  app.use(meRoutes({ credentials, request, homeAssistantCheck }));
  server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  root = `http://127.0.0.1:${server.address().port}/api/me`;
  base = `${root}/github`;
});
afterEach(() => new Promise((r) => server.close(r)));

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
