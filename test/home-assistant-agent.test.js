import express from 'express';
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { homeAssistantAgentRoutes, homeAssistantSessionAllowed } from '../lib/home-assistant-agent.js';
import { createHomeAssistantService } from '../lib/home-assistant.js';

const ROUTES = [
  ['', 'GET'],
  ['/entities', 'GET'],
  ['/entities/vacuum.manolo', 'GET'],
  ['/services', 'GET'],
  ['/services/vacuum/start', 'POST'],
  ['/events/briareus_command', 'POST'],
];

const STATES = [
  {
    entity_id: 'vacuum.manolo',
    state: 'docked',
    attributes: { friendly_name: 'Manolo', battery_level: 100 },
    last_changed: 'a',
    last_updated: 'b',
  },
  { entity_id: 'vacuum.pelusa', state: 'cleaning', attributes: { friendly_name: 'Pelusa' } },
  { entity_id: 'sensor.manolo_error', state: 'no_error', attributes: {} },
  { entity_id: 'light.kitchen', state: 'off', attributes: { friendly_name: 'Kitchen' } },
];

let server, base, job, project, fetcher, homes, serviceFor;
beforeEach(async () => {
  job = { id: 'chat', kind: 'devchat', repo: 'owner/repo', status: 'running', ownerId: 1 };
  project = { repo: job.repo, enabled: true, homeAssistantToolsEnabled: true };
  homes = { 1: { url: 'http://ha.test:8123', token: 'ha-token' } };
  fetcher = vi.fn(async (url, init) => {
    const path = new URL(url).pathname;
    if (path === '/api/') return Response.json({ message: 'API running.' });
    if (path === '/api/states') return Response.json(STATES);
    if (path.startsWith('/api/states/'))
      return Response.json(STATES.find((s) => `/api/states/${s.entity_id}` === path));
    if (path === '/api/services')
      return Response.json([
        { domain: 'vacuum', services: { start: {} } },
        { domain: 'light', services: { turn_on: {} } },
      ]);
    if (path === '/api/services/vacuum/start') return Response.json([{ ...STATES[0], state: 'cleaning' }]);
    if (path.startsWith('/api/events/')) return Response.json({ message: 'Event fired.' });
    throw new Error(`unexpected ${init?.method} ${url}`);
  });
  serviceFor = vi.fn((session) =>
    createHomeAssistantService({
      config: () => homes[session.ownerId] ?? null,
      fetcher,
      unconfigured: 'none',
    }),
  );
  const app = express();
  app.use(express.json());
  app.use(
    homeAssistantAgentRoutes({
      serviceFor,
      getProject: (repo) => (project?.repo === repo ? project : null),
      agentSession: (req, res) => {
        if (req.headers.authorization !== 'Bearer session-token') {
          res.status(401).json({ error: 'Unknown session token' });
          return null;
        }
        return job;
      },
    }),
  );
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
afterEach(async () => {
  await new Promise((resolve) => server.close(resolve));
});

const request = (path, method = 'GET', body = undefined, token = 'session-token') =>
  fetch(`${base}/api/agent/home-assistant${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

describe('session Home Assistant authorization', () => {
  it.each([
    null,
    {},
    { homeAssistantToolsEnabled: false },
    { homeAssistantToolsEnabled: 'true' },
    { mailToolsEnabled: true, whatsappToolsEnabled: true, printToolsEnabled: true },
    { homeAssistantToolsEnabled: true, enabled: false },
  ])('refuses projects without their own explicit opt-in: %j', async (settings) => {
    project = settings == null ? null : { repo: job.repo, ...settings };
    for (const [path, method] of ROUTES)
      expect((await request(path, method, method === 'POST' ? {} : undefined)).status).toBe(403);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('rejects unknown tokens', async () => {
    expect((await request('/entities', 'GET', undefined, 'bad')).status).toBe(401);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each(['parentId', 'qaParentId', 'autoClose', 'qaBranch', 'readOnly', 'preview', 'unattendedTurn'])(
    'refuses %s sessions',
    async (key) => {
      job[key] = true;
      expect(homeAssistantSessionAllowed(job, project)).toBe(false);
      for (const [path, method] of ROUTES)
        expect((await request(path, method, method === 'POST' ? {} : undefined)).status).toBe(403);
      expect(fetcher).not.toHaveBeenCalled();
    },
  );

  it("reaches only the session owner's home, and says so when they have none", async () => {
    await request('/entities');
    expect(fetcher.mock.calls[0][0]).toBe('http://ha.test:8123/api/states');
    expect(fetcher.mock.calls[0][1].headers.Authorization).toBe('Bearer ha-token');
    job = { ...job, ownerId: 2 };
    expect(await (await request('')).json()).toEqual({ configured: false, connected: false });
    const res = await request('/services/vacuum/start', 'POST', { entity_id: 'vacuum.manolo' });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'none' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

describe('session Home Assistant tools', () => {
  it('reports the connection', async () => {
    expect(await (await request('')).json()).toEqual({ configured: true, connected: true });
  });

  it('lists entities briefly, filtered by domain and by a search on id or name', async () => {
    expect(await (await request('/entities?domain=vacuum')).json()).toEqual({
      entities: [
        { id: 'vacuum.manolo', name: 'Manolo', state: 'docked' },
        { id: 'vacuum.pelusa', name: 'Pelusa', state: 'cleaning' },
      ],
    });
    expect((await (await request('/entities?search=MANOLO')).json()).entities.map((e) => e.id)).toEqual([
      'vacuum.manolo',
      'sensor.manolo_error',
    ]);
    expect((await (await request('/entities?search=kitch')).json()).entities.map((e) => e.id)).toEqual([
      'light.kitchen',
    ]);
    expect((await request('/entities?domain=Not-A-Domain')).status).toBe(400);
    expect((await request('/entities?search=a&search=b')).status).toBe(400);
  });

  it('reads one entity with its attributes', async () => {
    expect(await (await request('/entities/vacuum.manolo')).json()).toEqual({
      entity: {
        id: 'vacuum.manolo',
        name: 'Manolo',
        state: 'docked',
        attributes: { friendly_name: 'Manolo', battery_level: 100 },
        lastChanged: 'a',
        lastUpdated: 'b',
      },
    });
  });

  it('lists services, optionally for one domain', async () => {
    expect((await (await request('/services')).json()).services).toHaveLength(2);
    expect(await (await request('/services?domain=vacuum')).json()).toEqual({
      services: [{ domain: 'vacuum', services: { start: {} } }],
    });
  });

  it('calls a service with its data and answers the changed entities briefly', async () => {
    const res = await request('/services/vacuum/start', 'POST', { entity_id: 'vacuum.manolo' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      entities: [{ id: 'vacuum.manolo', name: 'Manolo', state: 'cleaning' }],
      response: null,
    });
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe('http://ha.test:8123/api/services/vacuum/start');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ entity_id: 'vacuum.manolo' });
  });

  it('fires an event', async () => {
    const res = await request('/events/briareus_command', 'POST', { command: 'arriving_home' });
    expect(await res.json()).toEqual({ ok: true });
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({ command: 'arriving_home' });
  });

  it('withdraws the tools as soon as the project opts out', async () => {
    expect((await request('/entities')).status).toBe(200);
    project.homeAssistantToolsEnabled = false;
    expect((await request('/services/vacuum/start', 'POST', { entity_id: 'vacuum.manolo' })).status).toBe(
      403,
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
