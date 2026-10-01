import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { createMobileAuth } from '../lib/mobile-auth.js';
import { createRemoteMcpAuth } from '../lib/remote-mcp-auth.js';
import { apiV1Routes } from '../lib/api-v1.js';
import { API_V1_ROUTES, FIELDS, NOT_IN_API, OBJECTS } from '../lib/api-v1-catalog.js';
import { apiV1OpenApi, apiV1Reference, schemaOf } from '../lib/api-v1-docs.js';

const repo = 'owner/project';
const secret = 'owner-secret';
const prefix = '/api/v1';
const jobs = {
  mine: { id: 'mine', repo, kind: 'devchat' },
  foreign: { id: 'foreign', repo: 'other/project', kind: 'devchat' },
  review: { id: 'review', repo, kind: 'review' },
};

let auth, mcpAuth, server, url, clock, loginOn, bus, sessions, project, handler, tokens;
beforeEach(async () => {
  let saved = [];
  clock = Date.now();
  loginOn = true;
  auth = createMobileAuth({
    load: async () => structuredClone(saved),
    save: async (_name, value) => {
      saved = structuredClone(value);
    },
    now: () => clock,
  });
  await auth.init();
  let mcpSaved = { enabled: false, baseUrl: '', clients: [], grants: [] };
  mcpAuth = createRemoteMcpAuth({
    load: async () => structuredClone(mcpSaved),
    save: async (_name, value) => {
      mcpSaved = structuredClone(value);
    },
  });
  await mcpAuth.init();
  const create = async (permission) =>
    (await auth.create({ label: `${permission} client`, repos: [repo], permission, days: 30 }, secret)).token;
  tokens = { read: await create('read'), manage: await create('manage'), admin: await create('admin') };
  bus = new EventEmitter();
  sessions = [
    { id: 'mine', repo, kind: 'devchat', status: 'idle' },
    { id: 'foreign', repo: 'other/project', kind: 'devchat', status: 'idle' },
  ];
  project = {
    repo,
    label: 'Project',
    reviewProviderId: 2,
    reviewModel: 'configured-model',
    reviewEffort: 'high',
  };
  // Stands in for every dashboard handler: it answers with what reached it.
  handler = vi.fn((req, res) =>
    res.json({
      method: req.method,
      path: req.path,
      query: req.query,
      body: Buffer.isBuffer(req.body) ? { bytes: req.body.length } : req.body,
      authorization: req.headers.authorization ?? null,
      repos: res.locals.apiRepos,
      actor: req.mcpActor,
    }),
  );
  const handlers = express.Router();
  handlers.get('/api/dev/sessions/:id/events', (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('data: {"seq":1}\n\n');
  });
  handlers.get('/api/boom', () => {
    throw Object.assign(new Error('Slot is claimed'), { status: 409 });
  });
  handlers.use(handler);
  const app = express();
  app.use(
    apiV1Routes({
      auth,
      mcpAuth,
      listProjects: () => [project, { repo: 'other/project', label: 'Other' }],
      loginEnabled: () => loginOn,
      ownerSecret: () => secret,
      handlers,
      getJob: (id) => jobs[id] || null,
      getProject: (name) => (name === repo ? project : null),
      listSessions: () => sessions,
      bus,
      reviewerRuntime: (p) =>
        p.reviewProviderId
          ? { providerId: p.reviewProviderId, model: p.reviewModel, effort: p.reviewEffort }
          : null,
      stepRuntime: (p, step) => (p.stepRuntimes && p.stepRuntimes[step]) || null,
      transcribeAvailable: () => true,
      recheckMs: 20,
    }),
  );
  // What sits behind the client API in the real app: the cookie login.
  app.use((_req, res) => res.status(401).json({ error: 'Not signed in' }));
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  url = `http://127.0.0.1:${server.address().port}`;
});
afterEach(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

function request(route, { token = tokens.manage, method = 'GET', body, headers = {} } = {}) {
  return fetch(`${url}${prefix}${route}`, {
    method,
    headers: {
      ...(body === undefined || Buffer.isBuffer(body) ? {} : { 'Content-Type': 'application/json' }),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body),
  });
}
const json = async (route, options) => (await request(route, options)).json();

// Reads a stream until `count` events have arrived, then hangs up.
async function readEvents(route, count, options = {}) {
  const response = await request(route, options);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  const parse = () =>
    text
      .split('\n\n')
      .slice(0, -1)
      .filter((block) => !block.startsWith(':'))
      .map((block) => ({
        event: block.match(/^event: (.*)$/m)?.[1] || 'message',
        data: JSON.parse(block.match(/^data: (.*)$/m)[1]),
      }));
  while (parse().length < count) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
    options.onChunk?.(parse());
  }
  await reader.cancel().catch(() => {});
  return parse();
}

describe('who gets in', () => {
  it('refuses a request with no token, a wrong one, or another kind of credential', async () => {
    for (const token of ['', 'internal-agent-token', `${tokens.manage}x`, 'brm_' + 'a'.repeat(43)]) {
      const response = await request('/sessions', { token, headers: { Cookie: 'owner=yes' } });
      expect(response.status).toBe(401);
      expect(response.headers.get('www-authenticate')).toContain('Bearer');
      expect(response.headers.get('cache-control')).toBe('no-store');
    }
    expect(handler).not.toHaveBeenCalled();
  });

  it('refuses a browser page and grants no CORS access', async () => {
    for (const origin of ['null', 'https://evil.example', url]) {
      const response = await request('/sessions', { headers: { Origin: origin } });
      expect(response.status).toBe(403);
      expect(response.headers.get('access-control-allow-origin')).toBeNull();
    }
    expect(handler).not.toHaveBeenCalled();
  });

  it('fails closed while the dashboard login is off, and once a token expires or is revoked', async () => {
    loginOn = false;
    expect((await request('/sessions')).status).toBe(503);
    loginOn = true;
    expect((await request('/sessions')).status).toBe(200);
    expect(await json('/token', { method: 'DELETE' })).toEqual({ ok: true });
    expect((await request('/sessions')).status).toBe(401);
    clock += 31 * 86400_000;
    expect((await request('/sessions', { token: tokens.admin })).status).toBe(401);
  });

  it('says who the token is and what the server can do', async () => {
    expect(await json('/')).toMatchObject({
      version: 1,
      client: { label: 'manage client', permission: 'manage', repos: [repo] },
      transcribe: true,
    });
    expect((await json('/', { token: tokens.admin })).client).toMatchObject({
      permission: 'admin',
      repos: [],
    });
  });

  it('holds each permission to its own routes', async () => {
    const attempts = [
      ['read', '/sessions', 'GET', 200],
      ['read', '/sessions/mine/messages', 'POST', 403],
      ['read', '/uploads?name=a.png', 'POST', 403],
      ['manage', '/sessions/mine/messages', 'POST', 200],
      ['manage', '/settings/providers', 'GET', 403],
      ['manage', '/sessions/mine/webhook', 'GET', 403],
      ['manage', '/attention', 'GET', 403],
      ['admin', '/settings/providers', 'GET', 200],
      ['admin', '/sessions/mine/webhook', 'GET', 200],
    ];
    for (const [permission, route, method, status] of attempts) {
      const response = await request(route, {
        token: tokens[permission],
        method,
        body: method === 'POST' ? { text: 'go' } : undefined,
      });
      expect([permission, route, response.status]).toEqual([permission, route, status]);
    }
  });

  it('reaches nothing that is not in the catalog', async () => {
    for (const route of ['/agent/memories', '/api/agent/memories', '/mobile-devices', '/mcp', '/login'])
      expect((await request(route, { token: tokens.admin })).status).toBe(404);
    expect(handler).not.toHaveBeenCalled();
  });
});

describe('holding a token to its projects', () => {
  it('refuses a project the token was not given, and one that does not exist, alike', async () => {
    for (const query of [
      '',
      '?repo=other/project',
      '?repo=no/such',
      '?repo=owner/project&repo=other/project',
    ]) {
      const response = await request(`/pulls${query}`);
      expect(response.status).toBe(403);
    }
    expect(
      (await request('/sessions', { method: 'POST', body: { repo: 'other/project', prompt: 'x' } })).status,
    ).toBe(403);
    expect((await request('/sessions', { method: 'POST', body: { prompt: 'x' } })).status).toBe(403);
    expect(handler).not.toHaveBeenCalled();
    expect((await request(`/pulls?repo=${repo}`)).status).toBe(200);
  });

  it('answers 404 for another project’s session, a job that is no session, and an unknown id', async () => {
    for (const id of ['foreign', 'review', 'nope']) {
      expect((await request(`/sessions/${id}`)).status).toBe(404);
      expect(
        (await request(`/sessions/${id}/messages`, { method: 'POST', body: { text: 'x' } })).status,
      ).toBe(404);
    }
    expect(handler).not.toHaveBeenCalled();
    expect((await request('/sessions/mine')).status).toBe(200);
  });

  it('hands a list handler the projects to cut the list down to', async () => {
    expect((await json('/sessions')).repos).toEqual([repo]);
    expect((await json('/projects', { token: tokens.read })).repos).toEqual([repo]);
    expect((await json('/sessions', { token: tokens.admin })).repos).toBeNull();
  });

  it('does not hold an admin token to a project list', async () => {
    const options = { token: tokens.admin };
    expect((await json('/pulls?repo=other/project', options)).query).toEqual({ repo: 'other/project' });
    expect((await json('/sessions/foreign', options)).path).toBe('/api/dev/sessions/foreign');
    expect((await json('/memories', options)).path).toBe('/api/memories');
  });
});

describe('handing a request to the dashboard’s handler', () => {
  it('rewrites the path, carries the query over and names the pull request as the handler reads it', async () => {
    expect(await json(`/pulls/7/files?repo=${repo}&page=2&headSha=abc`)).toMatchObject({
      method: 'GET',
      path: '/api/pr/view',
      query: { repo, page: '2', headSha: 'abc', pr: '7', section: 'files' },
    });
    for (const section of ['description', 'commits', 'checks', 'comments', 'reviews', 'review-comments'])
      expect((await json(`/pulls/7/${section}?repo=${repo}`)).query).toMatchObject({ pr: '7', section });
    expect(await json(`/pulls/7?repo=${repo}`)).toMatchObject({ path: '/api/dev/pull', query: { pr: '7' } });
    expect(await json(`/commits/abc1234?repo=${repo}`)).toMatchObject({
      path: '/api/pr/commit',
      query: { repo, sha: 'abc1234' },
    });
    expect(
      await json('/pulls/7/merge', { method: 'POST', body: { repo, headSha: 'a', baseRef: 'main' } }),
    ).toMatchObject({ method: 'POST', path: '/api/pr/merge', body: { repo, pr: '7', headSha: 'a' } });
  });

  it('a client cannot override the section or the pull request a path names', async () => {
    expect((await json(`/pulls/7/files?repo=${repo}&section=checks&pr=9`)).query).toMatchObject({
      pr: '7',
      section: 'files',
    });
  });

  it('keeps path parameters intact, including ones that need encoding', async () => {
    expect((await json('/sessions/mine/queue/2', { method: 'DELETE' })).path).toBe(
      '/api/dev/sessions/mine/queue/2',
    );
    expect(
      (await json('/settings/workspaces/owner__project__2/clean', { token: tokens.admin, method: 'POST' }))
        .path,
    ).toBe('/api/workspaces/owner__project__2/clean');
    expect((await json('/videos/run%201/login.webm', { token: tokens.admin })).path).toBe(
      '/videos/run%201/login.webm',
    );
    expect(
      (await json('/settings/templates', { token: tokens.admin, method: 'PUT', body: { values: {} } })).path,
    ).toBe('/api/templates/1');
  });

  it('spends the token at the gateway and names the client as the author', async () => {
    const seen = await json('/sessions/mine/messages', { method: 'POST', body: { text: 'go' } });
    expect(seen).toMatchObject({
      path: '/api/dev/sessions/mine/message',
      body: { text: 'go' },
      authorization: null,
      actor: 'API client manage client',
    });
  });

  it('passes an upload through as bytes', async () => {
    const seen = await json('/uploads?name=shot.png', {
      method: 'POST',
      body: Buffer.from('png-bytes'),
      headers: { 'Content-Type': 'application/octet-stream' },
    });
    expect(seen).toMatchObject({ path: '/api/dev/uploads', query: { name: 'shot.png' }, body: { bytes: 9 } });
  });

  it('answers malformed JSON and a handler’s own failure as JSON errors', async () => {
    const malformed = await fetch(`${url}${prefix}/sessions/mine/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokens.manage}`, 'Content-Type': 'application/json' },
      body: '{',
    });
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toEqual({ error: 'Invalid JSON' });
    expect(handler).not.toHaveBeenCalled();
  });
});

describe('starting on the project’s configured runtime', () => {
  const start = (body, options) =>
    json('/sessions', { method: 'POST', body: { repo, prompt: 'x', ...body }, ...options });

  it('fills in the review runtime when a start names no provider', async () => {
    expect((await start({})).body).toMatchObject({ provider: 2, model: 'configured-model', effort: 'high' });
  });

  it('leaves a named provider alone', async () => {
    expect((await start({ provider: 9, model: 'm' })).body).toMatchObject({ provider: 9, model: 'm' });
    expect((await start({ provider: 9 })).body).not.toHaveProperty('effort');
  });

  it('prefers the runtime set for the errand’s own step', async () => {
    project.stepRuntimes = { testRun: { providerId: 5, model: 'qa-model', effort: 'low' } };
    const seen = await json('/actions', { method: 'POST', body: { repo, action: 'test-run', prNumber: 3 } });
    expect(seen.body).toMatchObject({ provider: 5, model: 'qa-model' });
  });

  it('refuses a model with no provider, and a project with no runtime set up', async () => {
    expect(await start({ model: 'm' })).toEqual({ error: 'A model or effort needs its provider' });
    project.reviewProviderId = null;
    expect((await start({})).error).toMatch(/Name a provider/);
    expect(handler).not.toHaveBeenCalled();
  });
});

describe('the event streams', () => {
  it('opens with the sessions in scope, then follows their records, transcripts and deletions', async () => {
    const events = await readEvents('/events?transcripts=1', 4, {
      onChunk: (seen) => {
        if (seen.length !== 1) return;
        bus.emit('job', { id: 'foreign', repo: 'other/project', kind: 'devchat', status: 'running' });
        bus.emit('job', { id: 'review', repo, kind: 'review' });
        bus.emit('job', { id: 'mine', repo, kind: 'devchat', status: 'running' });
        bus.emit('event', 'foreign', { seq: 4, kind: 'text' });
        bus.emit('event', 'mine', { seq: 9, kind: 'text' });
        bus.emit('deleted', 'foreign', 'other/project');
        bus.emit('deleted', 'mine', repo);
      },
    });
    expect(events).toEqual([
      { event: 'session', data: sessions[0] },
      { event: 'session', data: { id: 'mine', repo, kind: 'devchat', status: 'running' } },
      { event: 'transcript', data: { sessionId: 'mine', event: { seq: 9, kind: 'text' } } },
      { event: 'session.deleted', data: { id: 'mine' } },
    ]);
  });

  it('leaves transcript lines out unless asked, and shows an admin token every project', async () => {
    const events = await readEvents('/events', 3, {
      token: tokens.admin,
      onChunk: (seen) => {
        if (seen.length !== 2) return;
        bus.emit('event', 'mine', { seq: 9, kind: 'text' });
        bus.emit('job', { id: 'foreign', repo: 'other/project', kind: 'devchat', status: 'running' });
      },
    });
    expect(events.map((e) => [e.event, e.data.id])).toEqual([
      ['session', 'mine'],
      ['session', 'foreign'],
      ['session', 'foreign'],
    ]);
  });

  it('stops listening when the client hangs up', async () => {
    await readEvents('/events?transcripts=1', 1);
    await vi.waitFor(() => expect(bus.listenerCount('job') + bus.listenerCount('event')).toBe(0));
  });

  it('ends an open stream once its token is revoked', async () => {
    for (const route of ['/events', '/sessions/mine/events']) {
      const token = (await auth.create({ label: 'tv', repos: [repo], permission: 'read', days: 1 }, secret))
        .token;
      const response = await request(route, { token });
      expect(response.status).toBe(200);
      const reader = response.body.getReader();
      await reader.read();
      await auth.revoke((await auth.list()).find((d) => d.label === 'tv').id);
      // The connection is cut rather than closed politely: there is no more
      // to say to a token that no longer stands.
      await expect(
        (async () => {
          for (;;) if ((await reader.read()).done) return 'ended';
        })(),
      ).rejects.toThrow();
    }
  });
});

describe('tokens and connections', () => {
  const admin = (route, options = {}) => request(route, { token: tokens.admin, ...options });

  it('lists the tokens issued without their secrets', async () => {
    const { devices, projects } = await (await admin('/settings/devices')).json();
    expect(devices.map((d) => d.permission).sort()).toEqual(['admin', 'manage', 'read']);
    expect(JSON.stringify(devices)).not.toMatch(/brm_|Hash/);
    expect(projects).toEqual([
      { repo, label: 'Project' },
      { repo: 'other/project', label: 'Other' },
    ]);
  });

  it('issues a token that works, and revokes it', async () => {
    const issued = await admin('/settings/devices', {
      method: 'POST',
      body: { label: 'Phone', permission: 'read', repos: [repo], days: 7 },
    });
    expect(issued.status).toBe(201);
    const { device, token } = await issued.json();
    expect(device).toMatchObject({ label: 'Phone', permission: 'read', repos: [repo] });
    expect((await request('/sessions', { token })).status).toBe(200);
    expect(await (await admin(`/settings/devices/${device.id}`, { method: 'DELETE' })).json()).toEqual({
      ok: true,
    });
    expect((await request('/sessions', { token })).status).toBe(401);
  });

  it('refuses a token for a project that does not exist, or with no project and no admin', async () => {
    for (const body of [
      { label: 'x', permission: 'read', repos: ['no/such'], days: 7 },
      { label: 'x', permission: 'manage', repos: [], days: 7 },
      { label: 'x', permission: 'owner', repos: [repo], days: 7 },
      { label: 'x', permission: 'read', repos: [repo], days: 0 },
    ]) {
      const response = await admin('/settings/devices', { method: 'POST', body });
      expect(response.status).toBe(400);
      expect((await response.json()).error).toBeTruthy();
    }
    expect(auth.list()).toHaveLength(3);
  });

  it('keeps token and connection management from anything below admin', async () => {
    for (const route of ['/settings/devices', '/settings/mcp']) {
      expect((await request(route)).status).toBe(403);
      expect(
        (await request(route, { method: route.endsWith('mcp') ? 'PUT' : 'POST', body: {} })).status,
      ).toBe(403);
    }
    expect(auth.list()).toHaveLength(3);
  });

  it('configures the ChatGPT connection, creates one and takes its consent', async () => {
    expect(await (await admin('/settings/mcp')).json()).toMatchObject({ enabled: false, clients: [] });
    const bad = await admin('/settings/mcp', { method: 'PUT', body: { enabled: true, baseUrl: 'http://x' } });
    expect(bad.status).toBe(400);
    const set = await admin('/settings/mcp', {
      method: 'PUT',
      body: { enabled: true, baseUrl: 'https://briareus.example.com' },
    });
    expect(await set.json()).toMatchObject({ enabled: true, url: 'https://briareus.example.com/mcp' });
    expect(
      (await admin('/settings/mcp/clients', { method: 'POST', body: { label: 'c', repos: ['no/such'] } }))
        .status,
    ).toBe(400);
    const created = await admin('/settings/mcp/clients', {
      method: 'POST',
      body: { label: 'GPT', repos: [repo] },
    });
    expect(created.status).toBe(201);
    const { clientId, clientSecret } = await created.json();
    expect(clientSecret).toBeTruthy();
    const view = await (await admin('/settings/mcp')).json();
    expect(view.clients).toMatchObject([{ id: clientId, label: 'GPT', repos: [repo], connected: false }]);
    expect(JSON.stringify(view)).not.toContain(clientSecret);

    const oauth = new URLSearchParams({
      client_id: clientId,
      redirect_uri: 'https://chatgpt.com/connector_platform_oauth_redirect',
      resource: 'https://briareus.example.com/mcp',
      response_type: 'code',
      code_challenge: 'a'.repeat(43),
      code_challenge_method: 'S256',
      state: 'xyz',
    });
    const consent = await (await admin(`/settings/mcp/consent?${oauth}`)).json();
    expect(consent).toMatchObject({ label: 'GPT', repos: [repo] });
    expect((await admin('/settings/mcp/consent?client_id=nope')).status).toBe(400);
    expect(
      (await admin('/settings/mcp/consent', { method: 'POST', body: { nonce: consent.nonce } })).status,
    ).toBe(400);
    const approved = await admin('/settings/mcp/consent', {
      method: 'POST',
      body: { nonce: consent.nonce, allow: true },
    });
    const { redirect } = await approved.json();
    expect(redirect).toMatch(
      /^https:\/\/chatgpt\.com\/connector_platform_oauth_redirect\?state=xyz&iss=.*&code=/,
    );
    // The answer is good once.
    expect(
      (await admin('/settings/mcp/consent', { method: 'POST', body: { nonce: consent.nonce, allow: true } }))
        .status,
    ).toBe(400);

    expect(await (await admin(`/settings/mcp/clients/${clientId}`, { method: 'DELETE' })).json()).toEqual({
      ok: true,
    });
    expect((await (await admin('/settings/mcp')).json()).clients).toEqual([]);
  });
});

describe('the contract', () => {
  const root = path.join(import.meta.dirname, '..');
  // Every route the source registers, as `METHOD /path`.
  function registeredRoutes() {
    const files = ['server.js', ...fs.readdirSync(path.join(root, 'lib')).map((f) => `lib/${f}`)];
    const registered = new Map();
    for (const file of files.filter((f) => f.endsWith('.js'))) {
      const source = fs.readFileSync(path.join(root, file), 'utf8');
      for (const [, method, route] of source.matchAll(
        /\b(?:api|app|router)\.(get|post|put|patch|delete)\(\s*['`]([^'`]+)['`]/g,
      ))
        registered.set(`${method.toUpperCase()} ${route}`, file);
      for (const [, method, route] of source.matchAll(/dashboard\.register\(\s*'(\w+)',\s*['`]([^'`]+)['`]/g))
        registered.set(`${method.toUpperCase()} ${route}`, file);
    }
    return registered;
  }

  it('describes every route once in the OpenAPI document, with typed fields and a typed answer', () => {
    const doc = apiV1OpenApi();
    const operations = Object.values(doc.paths).flatMap((methods) => Object.values(methods));
    expect(operations).toHaveLength(API_V1_ROUTES.length);
    const ids = operations.map((op) => op.operationId);
    expect(new Set(ids).size).toBe(ids.length);
    const files = doc.paths['/pulls/{number}/files'].get;
    expect(files).toMatchObject({
      operationId: 'pullsFiles',
      'x-briareus-access': 'read',
      'x-briareus-scope': 'repo',
    });
    expect(files.parameters).toContainEqual({
      name: 'repo',
      in: 'query',
      required: true,
      description: FIELDS.repo[1],
      schema: { type: 'string' },
    });
    expect(files.responses[200].content['application/json'].schema.properties).toMatchObject({
      pr: { $ref: '#/components/schemas/PullRequest' },
      files: { type: 'array', items: { $ref: '#/components/schemas/File' } },
      nextPage: { type: ['integer', 'null'] },
    });
    const start = doc.paths['/sessions'].post;
    expect(start.requestBody.content['application/json'].schema).toMatchObject({
      required: ['repo'],
      properties: { prompt: { type: 'string' }, provider: { type: 'integer' } },
    });
    expect(start.responses[201]).toBeTruthy();
    expect(doc.paths['/settings/projects'].post.requestBody.content['application/json'].schema).toEqual({
      $ref: '#/components/schemas/Project',
    });
    expect(Object.keys(doc.components.schemas)).toEqual(Object.keys(OBJECTS));
    // Every reference in the document points at a schema that is there.
    for (const [, name] of JSON.stringify(doc).matchAll(/#\/components\/schemas\/(\w+)/g))
      expect(doc.components.schemas, name).toHaveProperty(name);
  });

  it('writes catalog types as JSON Schema', () => {
    expect(schemaOf('string')).toEqual({ type: 'string' });
    expect(schemaOf('integer?')).toEqual({ type: ['integer', 'null'] });
    expect(schemaOf('string[]')).toEqual({ type: 'array', items: { type: 'string' } });
    expect(schemaOf('fix|optional')).toEqual({ type: 'string', enum: ['fix', 'optional'] });
    expect(schemaOf('Session[]')).toEqual({ type: 'array', items: { $ref: '#/components/schemas/Session' } });
    expect(schemaOf('Session?')).toEqual({
      anyOf: [{ $ref: '#/components/schemas/Session' }, { type: 'null' }],
    });
  });

  it('serves the document to any token', async () => {
    expect((await json('/openapi.json', { token: tokens.read })).openapi).toBe('3.1.0');
  });

  it('says what every route takes and answers', () => {
    for (const entry of API_V1_ROUTES) {
      expect(entry.summary, entry.id).toBeTruthy();
      if (!entry.stream && !entry.binary)
        expect(entry.returns, `${entry.id} has no answer described`).toBeTruthy();
      const takes = [...(entry.query || []), ...(entry.body || [])];
      for (const name of takes)
        expect(entry.fields?.[name] || FIELDS[name], `${entry.id}: ${name} is not described`).toBeTruthy();
      for (const name of entry.required || []) expect(takes, `${entry.id} requires ${name}`).toContain(name);
      if (entry.bodyObject) expect(OBJECTS, entry.id).toHaveProperty(entry.bodyObject);
      // A write that takes nothing is fine; a write that takes fields says which.
      if (entry.raw) expect(entry.body, entry.id).toBeUndefined();
    }
  });

  it('declares a known permission and scope on every route, and scopes nothing below admin loosely', () => {
    for (const entry of API_V1_ROUTES) {
      expect(['read', 'manage', 'admin'], entry.id).toContain(entry.access);
      expect(['repo', 'session', 'any'], entry.id).toContain(entry.scope);
      expect(entry.method === 'GET' || entry.access !== 'read' || entry.id === 'token.revoke', entry.id).toBe(
        true,
      );
      if (entry.scope === 'session') expect(entry.path, entry.id).toContain(':id');
    }
    // The routes a project-limited token may call without naming a project
    // or a session. Each is here because its handler filters by the token's
    // projects or is about no project at all; a new one has to earn its place.
    expect(
      API_V1_ROUTES.filter((e) => e.access !== 'admin' && e.scope === 'any')
        .map((e) => e.id)
        .sort(),
    ).toEqual([
      'actions.list',
      'client.get',
      'events.stream',
      'openapi.get',
      'projects.list',
      'sessions.list',
      'token.revoke',
      'transcribe.create',
      'transcribe.status',
      'uploads.create',
    ]);
  });

  // The catalog names handlers by path, so a handler that is renamed or
  // removed would leave a route that answers 404.
  it('names only handlers that exist', () => {
    const registered = registeredRoutes();
    const missing = API_V1_ROUTES.filter((e) => e.to && e.id !== 'videos.get')
      .map((e) => `${e.method} ${e.to}`)
      .filter((key) => !registered.has(key));
    expect(missing).toEqual([]);
  });

  // The other direction, and the point of the API: whatever the dashboard's
  // pages can call, a client can. A handler added for a page fails this until
  // it is given a route in the catalog, or a line in NOT_IN_API saying why it
  // has none.
  it('leaves nothing the dashboard can do without a route', () => {
    const covered = new Set(API_V1_ROUTES.filter((e) => e.to).map((e) => `${e.method} ${e.to}`));
    // Not the dashboard's: what an agent calls from inside its session, what
    // other systems deliver, the transports with their own contracts, and the
    // pages themselves.
    const elsewhere = (key, file) =>
      / \/api\/agent\//.test(key) ||
      ['lib/webhooks.js', 'lib/remote-mcp.js', 'lib/api-v1.js'].includes(file) ||
      (file === 'lib/mobile-api.js' && !key.includes('/api/mobile-devices')) ||
      !/ \/(api|oauth)\//.test(key);
    const uncovered = [...registeredRoutes()]
      .filter(([key, file]) => !covered.has(key) && !(key in NOT_IN_API) && !elsewhere(key, file))
      .map(([key]) => key);
    expect(uncovered).toEqual([]);
    // And nothing is excused that no longer exists.
    const registered = registeredRoutes();
    expect(Object.keys(NOT_IN_API).filter((key) => !registered.has(key))).toEqual([]);
  });

  it('keeps every call the dashboard’s scripts make within reach', () => {
    const reachable = [
      ...API_V1_ROUTES.filter((e) => e.to).map((e) => e.to),
      ...Object.keys(NOT_IN_API).map((key) => key.split(' ')[1]),
    ].map((route) => new RegExp(`^${route.replace(/[:*]\w+/g, '[^/]+').replace(/\//g, '\\/')}(\\/|$)`));
    const called = new Set();
    for (const file of fs.readdirSync(path.join(root, 'public')).filter((f) => f.endsWith('.js'))) {
      const source = fs.readFileSync(path.join(root, 'public', file), 'utf8');
      for (const [, route] of source.matchAll(/['`](\/api\/[A-Za-z0-9/_-]*)/g))
        called.add(route.replace(/\/$/, ''));
    }
    expect(called.size).toBeGreaterThan(40);
    const unreachable = [...called].filter(
      (route) => !reachable.some((pattern) => pattern.test(`${route}/x`) || pattern.test(route)),
    );
    expect(unreachable).toEqual([]);
  });

  it('keeps the object lists in step with the settings they describe', async () => {
    const { PROJECT_DEFAULTS } = await import('../lib/projects.js');
    const { PROVIDER_DEFAULTS } = await import('../lib/providerstore.js');
    const { DB_SERVER_DEFAULTS } = await import('../lib/dbservers.js');
    const { SSH_DEFAULTS } = await import('../lib/ssh.js');
    const { WEBHOOK_DEFAULTS } = await import('../lib/deliveries.js');
    const fields = (name) => Object.keys(OBJECTS[name].fields);
    for (const key of Object.keys(PROJECT_DEFAULTS)) expect(fields('Project'), key).toContain(key);
    // The stored login is the one provider field that never leaves the server.
    for (const key of Object.keys(PROVIDER_DEFAULTS).filter((k) => k !== 'authData'))
      expect(fields('Provider'), key).toContain(key);
    for (const key of Object.keys(DB_SERVER_DEFAULTS)) expect(fields('DbServer'), key).toContain(key);
    for (const key of Object.keys(SSH_DEFAULTS)) expect(fields('SshServer'), key).toContain(key);
    for (const key of Object.keys(WEBHOOK_DEFAULTS).filter((k) => k !== 'epoch'))
      expect(fields('Webhook'), key).toContain(key);
  });

  it('has a reference on disk that is what the catalog would write', async () => {
    const prettier = await import('prettier');
    const file = path.join(root, 'docs', 'api-v1-reference.md');
    const options = await prettier.resolveConfig(file);
    const expected = await prettier.format(apiV1Reference(), { ...options, filepath: file });
    expect(fs.readFileSync(file, 'utf8'), 'run `npm run build:api-docs`').toBe(expected);
  });

  it('gives every route a unique method and path', () => {
    const keys = API_V1_ROUTES.map((e) => `${e.method} ${e.path}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
