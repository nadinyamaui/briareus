import express from 'express';
import http from 'node:http';
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { createMobileAuth } from '../lib/mobile-auth.js';
import { mobileApiRoutes, mobileSettingsRoutes } from '../lib/mobile-api.js';
import { dashboardRoutes } from '../lib/dashboard-routes.js';
import { dashboardTools } from '../lib/dashboard-tools.js';
import { sameOriginWrites } from '../lib/security.js';
import { initProviders, PROVIDER_DEFAULTS, runtimeCatalog } from '../lib/providerstore.js';
import { reviewerRuntime } from '../lib/projects.js';
import { mergePullRequest, pullRequestView, pullRequestViewOptions } from '../lib/prviewer.js';

// The providers the runtimes and start_session checks resolve against, and the
// GitHub the pull_files reads reach: both stand in for the database and the
// network, with credentials planted on the rows so a leak would show.
const fake = vi.hoisted(() => ({ providers: [], github: null }));
vi.mock('../lib/config.js', () => ({ getConfig: () => ({ githubToken: 'tok' }) }));
vi.mock('../lib/db.js', async (importOriginal) => ({
  ...(await importOriginal()),
  loadProviderRows: async () => fake.providers,
}));
vi.mock('../lib/github.js', async (importOriginal) => ({
  ...(await importOriginal()),
  githubRest: (...args) => fake.github(...args),
}));
vi.mock('../lib/providers.js', () => {
  const binary = (name, models, efforts, defaultModel, defaultEffort) => ({
    label: `${name} label`,
    // Every CLI is installed except grok's.
    bin: () => (name === 'grok' ? null : { source: 'path' }),
    models: () => models,
    efforts,
    // Read the config as the real claude binary does, so a caller that
    // forgets to pass one fails here too.
    defaultModel: (cfg) => cfg.defaultModel || defaultModel,
    defaultEffort: (cfg) => cfg.defaultEffort || defaultEffort,
  });
  const BINARIES = {
    claude: binary('claude', ['opus', 'sonnet'], ['low', 'high'], 'opus', 'high'),
    codex: binary('codex', ['gpt-a'], ['low', 'medium', 'high', 'max'], 'gpt-a', 'high'),
    grok: binary('grok', ['grok-1'], ['fast'], 'grok-1', 'fast'),
  };
  const home = (p) => `/home/test/.provider-${p.id}`;
  return {
    BINARIES,
    getBinary: (name) => BINARIES[name],
    ensureClaudeHome: home,
    ensureCodexHome: home,
    ensureGrokHome: home,
    ensureOpencodeHome: home,
    readClaudeAuth: () => null,
    readCodexAuth: () => null,
    readGrokAuth: () => null,
    codexWideVariants: (slugs) => slugs,
  };
});

let auth, server, url, saved, save, load, clock, loginOn, secret, dashboard, handler, device, project;
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
  // Two logins to one service (one picker entry, named after the first), a
  // keyed custom endpoint, and a switched-off row.
  const row = (over) => ({ ...PROVIDER_DEFAULTS, ...over });
  fake.providers = [
    row({ id: 2, label: 'Claude 1', authData: { accessToken: 'oauth-secret-1' }, sortOrder: 1 }),
    row({ id: 3, label: 'Claude 2', authData: { accessToken: 'oauth-secret-2' }, sortOrder: 2 }),
    row({
      id: 4,
      label: 'Gateway',
      binary: 'codex',
      baseUrl: 'https://llm.internal.example',
      apiKey: 'sk-gateway-secret',
      models: ['gpt-x', 'gpt-y'],
      sortOrder: 3,
    }),
    row({ id: 5, label: 'Old Grok', binary: 'grok', active: false, sortOrder: 4 }),
  ];
  await initProviders();
  const app = express();
  project = { repo, label: 'Project', reviewProviderId: 2, reviewModel: 'configured-model' };
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

// The handler as server.js mounts it, reading login state from `signedOut`
// where server.js reads the balancer's last probes.
function mountRuntimes(signedOut = new Set()) {
  dashboard.register('get', '/api/dev/runtimes', (req, res) =>
    res.json(
      runtimeCatalog(reviewerRuntime(project), undefined, (p) => (signedOut.has(p.id) ? false : null)),
    ),
  );
}

it('lists active runtimes and the project default without any account data', async () => {
  mountRuntimes();
  Object.assign(project, { reviewProviderId: 3, reviewModel: 'retired', reviewEffort: 'low' });
  const result = await call('runtimes', { repo });
  expect(result.status).toBe(200);
  const catalog = await result.json();
  expect(catalog).toEqual({
    // The second login resolves to the entry it is offered under; a model it
    // no longer offers falls to the provider's default.
    default: { providerId: 2, model: 'opus', effort: 'low' },
    providers: [
      {
        id: 2,
        label: 'claude label',
        available: true,
        models: [
          { id: 'opus', label: 'opus', efforts: ['low', 'high'], defaultEffort: 'high' },
          { id: 'sonnet', label: 'sonnet', efforts: ['low', 'high'], defaultEffort: 'high' },
        ],
        defaultModel: 'opus',
      },
      {
        id: 4,
        label: 'Gateway',
        available: true,
        models: [
          { id: 'gpt-x', label: 'gpt-x', efforts: ['low', 'medium', 'high'], defaultEffort: 'high' },
          { id: 'gpt-y', label: 'gpt-y', efforts: ['low', 'medium', 'high'], defaultEffort: 'high' },
        ],
        defaultModel: 'gpt-x',
      },
    ],
  });
  const text = JSON.stringify(catalog);
  for (const secret of ['oauth-secret', 'sk-gateway-secret', 'llm.internal', 'Old Grok'])
    expect(text).not.toContain(secret);
  for (const key of ['auth', 'usage', 'accounts', 'apiKey', 'baseUrl', 'authData', 'binary'])
    expect(text).not.toContain(`"${key}"`);
  project.reviewProviderId = 0;
  expect((await (await call('runtimes', { repo })).json()).default).toBeNull();
  expect((await call('runtimes', { repo: 'other/project' })).status).toBe(403);
  expect((await call('runtimes', { repo, secret: true })).status).toBe(400);
  const read = await auth.create({ ...input, permission: 'read' }, secret);
  expect((await call('runtimes', { repo }, { token: read.token })).status).toBe(200);
  expect(handler).not.toHaveBeenCalled();
});

it('defaults to the active entry of a review login that was switched off', async () => {
  fake.providers[1].active = false;
  await initProviders();
  mountRuntimes();
  Object.assign(project, { reviewProviderId: 3, reviewModel: 'sonnet', reviewEffort: 'low' });
  const catalog = await (await call('runtimes', { repo })).json();
  expect(catalog.default).toEqual({ providerId: 2, model: 'sonnet', effort: 'low' });
  // With the whole group switched off there is nothing to start on.
  fake.providers[0].active = false;
  await initProviders();
  expect((await (await call('runtimes', { repo })).json()).default).toBeNull();
});

it('flags a runtime whose CLI is missing or whose logins are all signed out', async () => {
  fake.providers.push({ ...PROVIDER_DEFAULTS, id: 6, label: 'Grok', binary: 'grok', sortOrder: 5 });
  await initProviders();
  const signedOut = new Set([2]);
  mountRuntimes(signedOut);
  const available = async () =>
    Object.fromEntries(
      (await (await call('runtimes', { repo })).json()).providers.map((p) => [p.label, p.available]),
    );
  // One login of two signed out keeps the entry usable; an unprobed one counts.
  expect(await available()).toEqual({ 'claude label': true, Gateway: true, Grok: false });
  signedOut.add(3);
  expect(await available()).toEqual({ 'claude label': false, Gateway: true, Grok: false });
});

it('passes a picked runtime on for the session start to resolve', async () => {
  const start = async (runtime) =>
    (await (await call('start_session', { repo, prompt: 'Make a change', ...runtime })).json()).body;
  const picked = await start({ providerId: 4, model: 'gpt-y', effort: 'medium' });
  expect(picked).toMatchObject({ provider: 4, model: 'gpt-y', effort: 'medium' });
  expect(picked).not.toHaveProperty('providerId');
  // createDevSession checks the provider and resolves the model and effort
  // against the login it balances onto (test/jobs.test.js), so they go on as
  // sent, not resolved a second time here.
  expect(await start({ providerId: 2, model: 'retired', effort: 'extreme' })).toMatchObject({
    provider: 2,
    model: 'retired',
    effort: 'extreme',
  });
  const bare = await start({ providerId: 3 });
  expect(bare).toMatchObject({ provider: 3 });
  expect(bare.model).toBeUndefined();
  expect(bare.effort).toBeUndefined();
  // Nothing picked: the project's configured review runtime, as before.
  expect(await start({})).toMatchObject({ provider: 2, model: 'configured-model', effort: '' });
});

it('rejects a runtime that is incomplete or on the review and QA starts', async () => {
  for (const [name, body] of [
    ['start_session', { repo, prompt: 'x', model: 'opus' }],
    ['start_session', { repo, prompt: 'x', effort: 'high' }],
    ['start_session', { repo, prompt: 'x', providerId: '2' }],
    ['start_session', { repo, prompt: 'x', provider: 4 }],
    ['review', { repo, prNumber: 1, branch: 'feature', providerId: 4 }],
    ['qa', { repo, prNumber: 1, branch: 'feature', model: 'gpt-x' }],
  ])
    expect((await call(name, body)).status).toBe(400);
  const read = await auth.create({ ...input, permission: 'read' }, secret);
  const denied = await call('start_session', { repo, prompt: 'x', providerId: 4 }, { token: read.token });
  expect(denied.status).toBe(403);
  expect(handler).not.toHaveBeenCalled();
});

it('pages through a pull request’s files within the permitted projects', async () => {
  // The shared handler as server.js mounts it, over a PR of 150 files.
  dashboard.register('get', '/api/pr/view', async (req, res) => {
    try {
      res.json(await pullRequestView({ repo }, Number(req.query.pr), pullRequestViewOptions(req.query)));
    } catch (e) {
      res.status(e.status || 502).json({ error: e.message });
    }
  });
  let head = 'head-1';
  const paths = [];
  fake.github = vi.fn(async (_cfg, _method, path) => {
    paths.push(path);
    const page = Number(/[?&]page=(\d+)/.exec(path)?.[1]);
    const data = path.includes('/files?')
      ? Array.from({ length: page === 1 ? 100 : 50 }, (_, i) => ({
          filename: `src/f${(page - 1) * 100 + i}.js`,
          status: 'modified',
          additions: 1,
          deletions: 0,
          patch: '@@ -1 +1 @@',
          blob_url: 'https://github.com/blob',
        }))
      : {
          number: 7,
          title: 'Change',
          html_url: 'https://github.com/owner/project/pull/7',
          user: { login: 'dev' },
          state: 'open',
          head: { label: 'owner:feature', sha: head },
          base: { ref: 'main', sha: 'base-1' },
          additions: 150,
          deletions: 0,
          changed_files: 150,
        };
    return { ok: true, status: 200, json: async () => data };
  });
  const first = await (await call('pull_files', { repo, pr: 7 })).json();
  expect(first).toMatchObject({
    nextPage: 2,
    truncated: false,
    pr: { headSha: 'head-1', baseSha: 'base-1' },
  });
  expect(first.files).toHaveLength(100);
  expect(first.files[0]).toEqual({
    filename: 'src/f0.js',
    previousFilename: null,
    status: 'modified',
    additions: 1,
    deletions: 0,
    patch: '@@ -1 +1 @@',
    url: 'https://github.com/blob',
  });
  const pinned = { repo, pr: 7, headSha: 'head-1', baseSha: 'base-1' };
  const second = await (await call('pull_files', { ...pinned, page: 2 })).json();
  expect(second.nextPage).toBeNull();
  expect(second.files.map((f) => f.filename)).toContain('src/f149.js');
  expect(paths).toContain('/repos/owner/project/pulls/7/files?per_page=100&page=2');
  // A push between pages is a conflict, not a silently mixed file list.
  head = 'head-2';
  const moved = await call('pull_files', { ...pinned, page: 2 });
  expect(moved.status).toBe(409);
  expect((await moved.json()).error).toContain('changed');
  const read = await auth.create({ ...input, permission: 'read' }, secret);
  expect((await call('pull_files', { repo, pr: 7 }, { token: read.token })).status).toBe(200);
  const reads = fake.github.mock.calls.length;
  for (const [body, status] of [
    [{ repo: 'other/project', pr: 7 }, 403],
    [{ repo, pr: 7, page: 0 }, 400],
    [{ repo, pr: 7, page: '2' }, 400],
    [{ repo, pr: 7, section: 'checks' }, 400],
    [{ repo, pr: 7, page: 31 }, 400],
  ])
    expect((await call('pull_files', body)).status).toBe(status);
  // The cap is in the schema clients generate from, not only in the handler.
  const files = dashboardTools([]).find((t) => t.name === 'dashboard_pull_files');
  expect(files.inputSchema.properties.page).toEqual({ type: 'integer', minimum: 1, maximum: 30 });
  expect(fake.github.mock.calls.length).toBe(reads);
});

it('merges a pull request for a managing device only, pinned to the commit it read', async () => {
  // The shared handler as server.js mounts it.
  dashboard.register('post', '/api/pr/merge', async (req, res) => {
    try {
      const { method, headSha, baseRef } = req.body;
      res.json(
        await mergePullRequest({ repo: req.body.repo }, Number(req.body.pr), {
          ...(method ? { method } : {}),
          headSha,
          baseRef,
        }),
      );
    } catch (e) {
      res.status(e.status || 502).json({ error: e.message });
    }
  });
  const sent = [];
  fake.github = vi.fn(async (_cfg, method, path, body) => {
    sent.push([method, path, body]);
    return method === 'GET'
      ? { ok: true, status: 200, json: async () => ({ base: { ref: 'main' } }) }
      : { ok: true, status: 200, json: async () => ({ merged: true, sha: 'merge-sha', message: 'Merged' }) };
  });
  const headSha = 'a'.repeat(40);
  const merged = await call('merge_pull', { repo, pr: 7, headSha, baseRef: 'main', method: 'rebase' });
  expect(merged.status).toBe(200);
  expect(await merged.json()).toEqual({ merged: true, sha: 'merge-sha', message: 'Merged' });
  expect(sent.at(-1)).toEqual([
    'PUT',
    '/repos/owner/project/pulls/7/merge',
    { merge_method: 'rebase', sha: headSha },
  ]);
  // Squash unless a method is named; a retargeted pull request is a conflict.
  await call('merge_pull', { repo, pr: 7, headSha, baseRef: 'main' });
  expect(sent.at(-1)[2].merge_method).toBe('squash');
  expect((await call('merge_pull', { repo, pr: 7, headSha, baseRef: 'release' })).status).toBe(409);
  const writes = sent.filter(([method]) => method === 'PUT').length;
  const read = await auth.create({ ...input, permission: 'read' }, secret);
  expect(
    (await call('merge_pull', { repo, pr: 7, headSha, baseRef: 'main' }, { token: read.token })).status,
  ).toBe(403);
  for (const [body, status] of [
    [{ repo: 'other/project', pr: 7, headSha, baseRef: 'main' }, 403],
    [{ repo, pr: 7, baseRef: 'main' }, 400],
    [{ repo, pr: 7, headSha }, 400],
    [{ repo, pr: 7, headSha: 'short', baseRef: 'main' }, 400],
    [{ repo, pr: 7, headSha, baseRef: 'main', method: 'fast-forward' }, 400],
  ])
    expect((await call('merge_pull', body)).status).toBe(status);
  expect(sent.filter(([method]) => method === 'PUT').length).toBe(writes);
  const tool = dashboardTools([]).find((t) => t.name === 'dashboard_merge_pull');
  expect(tool.annotations.readOnlyHint).toBe(false);
});
