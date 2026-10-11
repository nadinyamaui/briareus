import express from 'express';
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHomeAssistantService } from '../lib/home-assistant.js';
import { homeAssistantRoutes } from '../lib/home-assistant-routes.js';
import { apiV1Routes } from '../lib/api-v1.js';
import { createMobileAuth } from '../lib/mobile-auth.js';

const servers = [];
const raw = {
  entity_id: 'light.kitchen',
  state: 'on',
  attributes: { friendly_name: 'Kitchen', brightness: 128 },
  last_changed: '2026-10-11T10:00:00Z',
  last_updated: '2026-10-11T10:00:01Z',
};
const expected = {
  id: 'light.kitchen',
  name: 'Kitchen',
  state: 'on',
  attributes: { friendly_name: 'Kitchen', brightness: 128 },
  lastChanged: '2026-10-11T10:00:00Z',
  lastUpdated: '2026-10-11T10:00:01Z',
};
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
async function setup() {
  const calls = [];
  let failure = 0;
  const upstream = express();
  upstream.use(express.json());
  upstream.use((req, res) => {
    calls.push({
      path: req.path,
      method: req.method,
      body: req.body,
      query: req.query,
      token: req.headers.authorization,
    });
    if (failure) return res.status(failure).json({ message: 'private-ha-token' });
    if (req.path === '/api/') return res.json({ message: 'API running.' });
    if (req.path === '/api/states') return res.json([raw, { ...raw, entity_id: 'vacuum.mova' }]);
    if (req.path === '/api/states/light.kitchen') return res.json(raw);
    if (req.path === '/api/services')
      return res.json([{ domain: 'light', services: { turn_on: { fields: {} } } }]);
    if (req.path === '/api/services/light/turn_on')
      return res.json(
        req.query.return_response !== undefined
          ? { changed_states: [raw], service_response: { result: 'done' } }
          : [raw],
      );
    if (req.path.startsWith('/api/events/')) return res.json({ message: 'Event fired.' });
    res.status(404).json({ message: 'not found' });
  });
  const base = await serve(upstream);
  const service = createHomeAssistantService({ config: () => ({ url: base, token: 'private-ha-token' }) });
  let saved = [];
  const auth = createMobileAuth({
    load: async () => saved,
    save: async (_key, value) => {
      saved = value;
    },
  });
  await auth.init();
  const tokens = {};
  for (const permission of ['read', 'manage', 'admin'])
    tokens[permission] = (
      await auth.create({ label: permission, permission, repos: ['owner/repo'], days: 30 }, 'owner')
    ).token;
  const handlers = homeAssistantRoutes({ service });
  const app = express();
  app.use(
    apiV1Routes({
      auth,
      apiEnabled: () => true,
      ownerSecret: () => 'owner',
      handlers,
      getJob: () => null,
      getProject: () => null,
      listSessions: () => [],
      bus: new EventEmitter(),
    }),
  );
  app.use(express.json(), handlers);
  const url = await serve(app);
  const call = (path = '', { method = 'GET', body, token = tokens.admin } = {}) =>
    fetch(`${url}/api/v1/home-assistant${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  return {
    call,
    calls,
    url,
    service,
    tokens,
    fail: (status) => {
      failure = status;
    },
  };
}

describe('Home Assistant bridge through the real gateway and upstream HTTP', () => {
  it('reads status, normalized entities, domain filters and available services', async () => {
    const { call, calls } = await setup();
    expect(await (await call()).json()).toEqual({ configured: true, connected: true });
    expect(await (await call('/entities?domain=light')).json()).toEqual({ entities: [expected] });
    expect(await (await call('/entities/light.kitchen')).json()).toEqual({ entity: expected });
    expect(await (await call('/services')).json()).toEqual({
      services: [{ domain: 'light', services: { turn_on: { fields: {} } } }],
    });
    expect(calls.every((c) => c.token === 'Bearer private-ha-token')).toBe(true);
  });
  it('executes actions with response data and fires automation events', async () => {
    const { call, calls } = await setup();
    const data = { entity_id: ['light.kitchen'], brightness: 128 };
    expect(await (await call('/services/light/turn_on', { method: 'POST', body: data })).json()).toEqual({
      entities: [expected],
      response: null,
    });
    expect(
      await (await call('/services/light/turn_on?returnResponse=1', { method: 'POST', body: data })).json(),
    ).toEqual({ entities: [expected], response: { result: 'done' } });
    expect(
      await (await call('/events/briareus_command', { method: 'POST', body: { source: 'ios' } })).json(),
    ).toEqual({ ok: true });
    expect(calls.map((c) => c.body)).toEqual([data, data, { source: 'ios' }]);
  });
  it('refuses non-admin and agent tokens without contacting Home Assistant', async () => {
    const { call, calls, tokens, url } = await setup();
    for (const token of [tokens.read, tokens.manage]) {
      expect((await call('/entities', { token })).status).toBe(403);
      expect((await call('/services/light/turn_on', { method: 'POST', body: {}, token })).status).toBe(403);
      expect((await call('/events/briareus_command', { method: 'POST', body: {}, token })).status).toBe(403);
    }
    expect((await call('', { token: 'invalid' })).status).toBe(401);
    expect(
      (await fetch(`${url}/api/home-assistant/entities`, { headers: { Authorization: 'Bearer agent' } }))
        .status,
    ).toBe(403);
    expect(calls).toEqual([]);
  });
  it.each([
    ['ios.shortcut_run', '/api/events/ios.shortcut_run'],
    ['Briareus-Command', '/api/events/Briareus-Command'],
    ['Briareus/Command?source=ios#run', '/api/events/Briareus%2FCommand%3Fsource%3Dios%23run'],
  ])('delivers event %s as one encoded path segment', async (type, path) => {
    const { call, calls } = await setup();
    const res = await call(`/events/${encodeURIComponent(type)}`, {
      method: 'POST',
      body: { source: 'ios' },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(calls).toEqual([
      { path, method: 'POST', body: { source: 'ios' }, query: {}, token: 'Bearer private-ha-token' },
    ]);
  });
  it('rejects empty and non-string event types before contacting Home Assistant', async () => {
    const { service, calls } = await setup();
    for (const type of ['', null, 42, ['briareus_command']])
      await expect(service.fireEvent(type)).rejects.toMatchObject({
        status: 400,
        message: 'Invalid Home Assistant event type',
      });
    expect(calls).toEqual([]);
  });
  it('validates identifiers, query and body before sending an action', async () => {
    const { call, calls } = await setup();
    expect((await call('/entities/light%2Fbad')).status).toBe(400);
    expect((await call('/entities?domain=light&domain=vacuum')).status).toBe(400);
    expect(
      (await call('/services/light/turn_on?returnResponse=yes', { method: 'POST', body: {} })).status,
    ).toBe(400);
    expect((await call('/services/light/turn_on', { method: 'POST', body: [] })).status).toBe(400);
    expect(calls).toEqual([]);
  });
  it.each([
    [401, 502],
    [403, 502],
    [404, 404],
    [400, 400],
    [429, 429],
    [500, 502],
  ])('maps upstream %i to %i and hides its error body', async (upstream, status) => {
    const { call, fail } = await setup();
    fail(upstream);
    const res = await call('/entities');
    expect(res.status).toBe(status);
    expect(await res.text()).not.toContain('private-ha-token');
  });
});

it.each(['١', '１', '𝟙'])(
  'accepts decimal digit %s in entity, domain and service identifiers',
  async (digit) => {
    const state = { ...raw, entity_id: `sensor${digit}.room_${digit}` };
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(Response.json(state))
      .mockResolvedValueOnce(Response.json([state]))
      .mockResolvedValueOnce(Response.json([state]));
    const service = createHomeAssistantService({
      config: () => ({ url: 'http://ha.test', token: 'secret' }),
      fetcher,
    });
    const normalized = { ...expected, id: state.entity_id };
    expect(await service.entity(state.entity_id)).toEqual({ entity: normalized });
    expect(await service.entities({ domain: `sensor${digit}` })).toEqual({ entities: [normalized] });
    expect(await service.callService(`sensor${digit}`, `update_${digit}`)).toEqual({
      entities: [normalized],
      response: null,
    });
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
      `http://ha.test/api/states/sensor${digit}.room_${digit}`,
      'http://ha.test/api/states',
      `http://ha.test/api/services/sensor${digit}/update_${digit}`,
    ]);
  },
);
it.each(['²', 'Ⅳ', 'A', '/', '-'])(
  'rejects invalid identifier character %s before upstream',
  async (char) => {
    const fetcher = vi.fn();
    const service = createHomeAssistantService({
      config: () => ({ url: 'http://ha.test', token: 'secret' }),
      fetcher,
    });
    await expect(service.entity(`sensor.room_${char}`)).rejects.toMatchObject({ status: 400 });
    await expect(service.entities({ domain: `sensor${char}` })).rejects.toMatchObject({ status: 400 });
    await expect(service.callService(`sensor${char}`, 'update')).rejects.toMatchObject({ status: 400 });
    await expect(service.callService('sensor', `update_${char}`)).rejects.toMatchObject({ status: 400 });
    expect(fetcher).not.toHaveBeenCalled();
  },
);

it.each([42, true, {}, [], null, undefined, ''].map((name) => [name]))(
  'uses the entity ID for friendly_name %j',
  async (name) => {
    const state = { ...raw, attributes: { friendly_name: name } };
    const service = createHomeAssistantService({
      config: () => ({ url: 'http://ha.test', token: 'secret' }),
      fetcher: vi
        .fn()
        .mockResolvedValueOnce(Response.json([state]))
        .mockResolvedValueOnce(Response.json(state))
        .mockResolvedValueOnce(Response.json([state]))
        .mockResolvedValueOnce(Response.json({ changed_states: [state] })),
    });
    expect((await service.entities()).entities[0].name).toBe('light.kitchen');
    expect((await service.entity('light.kitchen')).entity.name).toBe('light.kitchen');
    expect((await service.callService('light', 'turn_on')).entities[0].name).toBe('light.kitchen');
    expect(
      (await service.callService('light', 'turn_on', {}, { returnResponse: '1' })).entities[0].name,
    ).toBe('light.kitchen');
  },
);

it('reports unconfigured status and refuses operations', async () => {
  const service = createHomeAssistantService({ config: () => null });
  expect(await service.status()).toEqual({ configured: false, connected: false });
  await expect(service.entities()).rejects.toMatchObject({ status: 503 });
});
it('does not follow redirects with its private token', async () => {
  const destination = vi.fn((_req, res) => res.json([]));
  const target = express();
  target.use(destination);
  const targetUrl = await serve(target);
  const source = express();
  source.use((_req, res) => res.redirect(`${targetUrl}/api/states`));
  const url = await serve(source);
  const service = createHomeAssistantService({ config: () => ({ url, token: 'secret' }) });
  await expect(service.entities()).rejects.toMatchObject({ status: 502 });
  expect(destination).not.toHaveBeenCalled();
});
it('bounds slow response bodies and never retries an ambiguous action', async () => {
  const upstream = express();
  const calls = vi.fn((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.write('[');
  });
  upstream.use(calls);
  const url = await serve(upstream);
  const service = createHomeAssistantService({ config: () => ({ url, token: 'secret' }), timeoutMs: 40 });
  await expect(service.callService('light', 'turn_on', {})).rejects.toMatchObject({
    status: 502,
    message: expect.stringContaining('before retrying'),
  });
  expect(calls).toHaveBeenCalledTimes(1);
});
it('refuses malformed upstream entity lists and action receipts', async () => {
  const service = createHomeAssistantService({
    config: () => ({ url: 'http://ha.test', token: 'secret' }),
    fetcher: vi.fn(async () => Response.json({ private: 'secret' })),
  });
  await expect(service.entities()).rejects.toMatchObject({ status: 502 });
  await expect(service.callService('light', 'turn_on')).rejects.toMatchObject({ status: 502 });
});
