import express from 'express';
import http from 'node:http';
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { createMobileAuth } from '../lib/mobile-auth.js';
import { mobileApiRoutes, mobileSettingsRoutes } from '../lib/mobile-api.js';
import { dashboardRoutes } from '../lib/dashboard-routes.js';
import { dashboardTools } from '../lib/dashboard-tools.js';
import { sameOriginWrites } from '../lib/security.js';

let auth, server, url, saved, save, load, clock, loginOn, secret, dashboard, handler, device;
const repo = 'owner/project';
const input = { label: 'iPhone', repos: [repo], permission: 'manage', days: 90 };
const prefix = '/api/mobile/v1';
beforeEach(async () => {
  saved = [];
  clock = Date.now();
  loginOn = true;
  secret = 'owner-secret';
  load = vi.fn(async () => structuredClone(saved));
  save = vi.fn(async (_name, value) => {
    saved = structuredClone(value);
  });
  auth = createMobileAuth({ load, save, now: () => clock });
  await auth.init();
  device = await auth.create(input, secret);
  const app = express();
  const project = { repo, label: 'Project', reviewProviderId: 2, reviewModel: 'configured-model' };
  const getProject = (name) => (name === repo ? project : null);
  dashboard = dashboardRoutes({
    app,
    getProject,
    listActions: () => [],
    getJob: (id) =>
      ({
        mine: { id, repo, kind: 'devchat' },
        foreign: { id, repo: 'other/project', kind: 'devchat' },
        review: { id, repo, kind: 'review' },
      })[id],
  });
  const options = { auth, loginEnabled: () => loginOn, ownerSecret: () => secret };
  app.use(mobileApiRoutes({ ...options, dashboard }));
  app.use(sameOriginWrites);
  app.use(express.json());
  app.use(
    mobileSettingsRoutes({
      ...options,
      getProject,
      listProjects: () => [project],
      signedIn: (req) => req.headers.cookie === 'owner=yes',
    }),
  );
  // A browser route after the mobile mount must not accept a mobile token.
  app.use((req, res, next) =>
    req.headers.cookie === 'owner=yes' ? next() : res.status(401).json({ error: 'Not signed in' }),
  );
  handler = vi.fn((req, res) =>
    res.json({
      body: req.body,
      params: req.params,
      query: req.query,
      repo: req.mcpProject,
      actor: req.mcpActor,
    }),
  );
  for (const tool of dashboardTools([])) dashboard.register(tool.method, tool.path, handler);
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  url = `http://127.0.0.1:${server.address().port}`;
});
afterEach(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});
function request(path, { token = device.token, method = 'GET', body, headers = {} } = {}) {
  return fetch(`${url}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
function call(name, body = {}, options = {}) {
  return request(`${prefix}/operations/${name}`, { method: 'POST', body, ...options });
}

it('persists hashes only, survives restart, expires and is invalidated by owner secret rotation', async () => {
  expect(JSON.stringify(saved)).not.toContain(device.token);
  expect(JSON.stringify(saved)).not.toContain(secret);
  expect(auth.list()[0]).not.toHaveProperty('tokenHash');
  expect(auth.list()[0]).not.toHaveProperty('ownerHash');
  const restarted = createMobileAuth({ load, save, now: () => clock });
  await restarted.init();
  expect(restarted.authenticate(`Bearer ${device.token}`, secret).id).toBe(device.device.id);
  expect(() => restarted.authenticate(`Bearer ${device.token}`, 'changed')).toThrow('Invalid');
  clock = device.device.expiresAt;
  expect((await call('projects')).status).toBe(401);
});

it('fails closed until authentication state loads and when dashboard login is disabled', async () => {
  const unavailable = createMobileAuth({
    load: async () => {
      throw new Error('DB down');
    },
  });
  await expect(unavailable.init()).rejects.toThrow('DB down');
  expect(() => unavailable.authenticate(`Bearer ${device.token}`, secret)).toThrow('unavailable');
  loginOn = false;
  expect((await call('projects')).status).toBe(503);
  expect((await request('/api/mobile-devices', { token: '', headers: { Cookie: 'owner=yes' } })).status).toBe(
    403,
  );
});

it('rejects absent, malformed and other token types; browser cookies cannot authorize mobile access', async () => {
  for (const token of [
    '',
    'internal-agent-token',
    'mcp-access-token',
    `${device.token}x`,
    'brm_' + 'a'.repeat(43),
  ]) {
    const result = await call('projects', {}, { token, headers: { Cookie: 'owner=yes' } });
    expect(result.status).toBe(401);
    expect(result.headers.get('www-authenticate')).toContain('Bearer');
    expect(result.headers.get('cache-control')).toBe('no-store');
  }
  expect((await request('/api/dev/sessions')).status).toBe(401);
  expect((await request(`${prefix}/api/dev/sessions`)).status).toBe(404);
  expect(handler).not.toHaveBeenCalled();
});

it('rejects browser origins and does not grant CORS access', async () => {
  for (const origin of ['null', 'https://evil.example', url]) {
    const result = await call('projects', {}, { headers: { Origin: origin } });
    expect(result.status).toBe(403);
    expect(result.headers.get('access-control-allow-origin')).toBeNull();
  }
  expect((await request(`${prefix}/operations`, { method: 'OPTIONS', token: '' })).status).toBe(401);
});

it('lists only permitted projects and passes scoped session polling and configured models to shared handlers', async () => {
  expect(await (await call('projects')).json()).toEqual({ projects: [{ repo, label: 'Project' }] });
  expect(await (await call('sessions', { repo })).json()).toMatchObject({ repo });
  expect(await (await call('session', { sessionId: 'mine', since: 42 })).json()).toMatchObject({
    params: { id: 'mine' },
    query: { since: 42 },
    repo,
  });
  expect(await (await call('start_session', { repo, prompt: 'Make a change' })).json()).toMatchObject({
    body: { provider: 2, model: 'configured-model' },
    actor: 'Mobile device iPhone',
  });
  expect(await (await call('message', { sessionId: 'mine', text: 'Continue' })).json()).toMatchObject({
    params: { id: 'mine' },
    body: { text: 'Continue', repo },
  });
});

it('rejects foreign sessions/projects, invalid bodies and attempts to inject privileged arguments before dispatch', async () => {
  for (const [name, body, status] of [
    ['sessions', { repo: 'other/project' }, 403],
    ['session', { sessionId: 'foreign' }, 404],
    ['message', { sessionId: 'missing', text: 'hello' }, 404],
    ['session', { sessionId: 'review' }, 404],
    ['session', { sessionId: 'mine', since: -1 }, 400],
    ['session', { sessionId: 'mine', since: '1' }, 400],
    ['start_session', { repo, prompt: 'hello', provider: 100 }, 400],
    ['message', { sessionId: 'mine', text: 'hello', repo: 'other/project' }, 400],
    ['sessions', [], 400],
    ['sessions', {}, 400],
    ['unknown', {}, 404],
  ])
    expect((await call(name, body)).status).toBe(status);
  expect(handler).not.toHaveBeenCalled();
});

it('enforces read-only permissions for every mutating operation', async () => {
  const read = await auth.create({ ...input, permission: 'read' }, secret);
  expect((await call('projects', {}, { token: read.token })).status).toBe(200);
  for (const op of dashboard.tools().filter((entry) => !entry.annotations.readOnlyHint)) {
    expect((await call(op.name.replace('dashboard_', ''), {}, { token: read.token })).status).toBe(403);
  }
  expect(handler).not.toHaveBeenCalled();
});

it('offers an authenticated operation catalog, OpenAPI schemas and safe device metadata', async () => {
  const me = await (await request(`${prefix}/`)).json();
  expect(me).toMatchObject({ version: 1, device: { permission: 'manage' } });
  expect(JSON.stringify(me)).not.toContain(device.token);
  const catalog = await (await request(`${prefix}/operations`)).json();
  expect(catalog.operations.find((op) => op.name === 'message')).toMatchObject({ readOnly: false });
  const spec = await (await request(`${prefix}/openapi.json`)).json();
  expect(spec.security).toEqual([{ deviceToken: [] }]);
  expect(
    spec.paths['/operations/session'].post.requestBody.content['application/json'].schema.required,
  ).toEqual(['sessionId']);
  expect((await request(`${prefix}/openapi.json`, { token: '' })).status).toBe(401);
});

it('requires a signed-in owner to manage devices and retains the same-origin write gate', async () => {
  expect((await request('/api/mobile-devices')).status).toBe(403);
  expect((await request('/api/mobile-devices', { token: '' })).status).toBe(403);
  const owner = { token: '', headers: { Cookie: 'owner=yes' } };
  expect(
    (
      await request('/api/mobile-devices', {
        ...owner,
        method: 'POST',
        body: input,
        headers: { ...owner.headers, Origin: 'https://evil.example' },
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await request('/api/mobile-devices', {
        ...owner,
        method: 'POST',
        body: { ...input, repos: ['other/project'] },
      })
    ).status,
  ).toBe(400);
  const created = await request('/api/mobile-devices', { ...owner, method: 'POST', body: input });
  expect(created.status).toBe(201);
  const credentials = await created.json();
  const list = await (await request('/api/mobile-devices', owner)).json();
  expect(list.devices).toHaveLength(2);
  expect(JSON.stringify(list)).not.toContain(credentials.token);
  await request(`/api/mobile-devices/${credentials.device.id}`, { ...owner, method: 'DELETE' });
  expect((await call('projects', {}, { token: credentials.token })).status).toBe(401);
  expect((await call('projects')).status).toBe(200);
});

it('revokes only the current token on mobile sign-out, including read-only devices', async () => {
  const read = await auth.create({ ...input, permission: 'read' }, secret);
  expect((await request(`${prefix}/token`, { method: 'DELETE', token: read.token })).status).toBe(200);
  expect((await call('projects', {}, { token: read.token })).status).toBe(401);
  expect((await call('projects')).status).toBe(200);
});

it('serializes concurrent device changes and never reports a failed persistence as success', async () => {
  const [second, third] = await Promise.all([
    auth.create(input, secret),
    auth.create(input, secret),
    auth.revoke(device.device.id),
  ]);
  expect(auth.list().map((d) => d.id)).toEqual([second.device.id, third.device.id]);
  save.mockRejectedValueOnce(new Error('DB offline'));
  await expect(auth.revoke(second.device.id)).rejects.toThrow('DB offline');
  expect(auth.authenticate(`Bearer ${second.token}`, secret).id).toBe(second.device.id);
  await auth.revoke(second.device.id);
  expect(() => auth.authenticate(`Bearer ${second.token}`, secret)).toThrow('Invalid');
});

it('validates expiry and permissions and bounds request bodies with JSON errors', async () => {
  for (const overrides of [
    { days: 0 },
    { days: 366 },
    { days: 1.5 },
    { permission: 'admin' },
    { label: '' },
    { repos: [] },
  ]) {
    expect(() => auth.create({ ...input, ...overrides }, secret)).toThrow();
  }
  const malformed = await fetch(`${url}${prefix}/operations/message`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${device.token}`, 'Content-Type': 'application/json' },
    body: '{',
  });
  expect(malformed.status).toBe(400);
  expect((await malformed.json()).error).toBeTruthy();
  expect((await call('message', { sessionId: 'mine', text: 'x'.repeat(1024 * 1024) })).status).toBe(413);
});

it('preserves operation error statuses and hides internal server errors', async () => {
  handler.mockImplementationOnce((_req, res) => res.status(409).json({ error: 'Conflict' }));
  const result = await call('sessions', { repo });
  expect(result.status).toBe(409);
  expect(await result.json()).toEqual({ error: 'Conflict' });
  handler.mockImplementationOnce(() => {
    throw new Error('database password must not leak');
  });
  const failed = await call('sessions', { repo });
  expect(failed.status).toBe(500);
  expect(await failed.json()).toEqual({ error: 'Mobile API unavailable' });
});

it('rechecks a token revoked while a slow request body is arriving', async () => {
  const checked = new Promise((resolve) => {
    const original = auth.authenticate;
    vi.spyOn(auth, 'authenticate').mockImplementation((...args) => {
      const result = original(...args);
      resolve();
      return result;
    });
  });
  let req;
  const response = new Promise((resolve, reject) => {
    req = http.request(
      `${url}${prefix}/operations/message`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${device.token}`, 'Content-Type': 'application/json' },
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode));
      },
    );
    req.on('error', reject);
    req.write('{"sessionId":"mine",');
  });
  await checked;
  await auth.revoke(device.device.id);
  req.end('"text":"late message"}');
  expect(await response).toBe(401);
  expect(handler).not.toHaveBeenCalled();
});
