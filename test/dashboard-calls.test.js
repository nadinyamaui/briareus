import { beforeEach, it, expect, vi } from 'vitest';
import { dashboardRoutes } from '../lib/dashboard-routes.js';
import { dashboardTools } from '../lib/dashboard-tools.js';
import { initProviders, PROVIDER_DEFAULTS, runtimeCatalog } from '../lib/providerstore.js';
import { reviewerRuntime } from '../lib/projects.js';
import { mergePullRequest, pullRequestView, pullRequestViewOptions } from '../lib/prviewer.js';

// The handlers the ChatGPT connection calls by name, run for real behind the
// registry: test/dashboard-mcp.test.js covers the registry with a stand-in
// handler, this covers what the handlers themselves answer through it.
//
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
vi.mock('../lib/providers.js', async (importOriginal) => {
  const { resolveDefaultModel } = await importOriginal();
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
    resolveDefaultModel,
  };
});

let dashboard, handler, project;
const repo = 'owner/project';
const principal = { id: 'connection', label: 'My ChatGPT', repos: [repo] };
beforeEach(async () => {
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
  project = { repo, label: 'Project', reviewProviderId: 2, reviewModel: 'configured-model' };
  dashboard = dashboardRoutes({
    app: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
    getProject: (name) => (name === repo ? project : null),
    listActions: () => [],
    getJob: () => null,
  });
  handler = vi.fn((req, res) => res.json({ body: req.body }));
  for (const tool of dashboardTools([])) dashboard.register(tool.method, tool.path, handler);
});
const call = (name, args = {}) => dashboard.call(principal, `dashboard_${name}`, args);
// The status a refused call carries, or 200.
const status = (name, args) =>
  call(name, args).then(
    () => 200,
    (e) => e.status,
  );

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
  const catalog = await call('runtimes', { repo });
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
  expect((await call('runtimes', { repo })).default).toBeNull();
  expect(await status('runtimes', { repo: 'other/project' })).toBe(403);
  expect(await status('runtimes', { repo, secret: true })).toBe(400);
  expect(handler).not.toHaveBeenCalled();
});

it('defaults to the active entry of a review login that was switched off', async () => {
  fake.providers[1].active = false;
  await initProviders();
  mountRuntimes();
  Object.assign(project, { reviewProviderId: 3, reviewModel: 'sonnet', reviewEffort: 'low' });
  const catalog = await call('runtimes', { repo });
  expect(catalog.default).toEqual({ providerId: 2, model: 'sonnet', effort: 'low' });
  // With the whole group switched off there is nothing to start on.
  fake.providers[0].active = false;
  await initProviders();
  expect((await call('runtimes', { repo })).default).toBeNull();
});

it('flags a runtime whose CLI is missing or whose logins are all signed out', async () => {
  fake.providers.push({ ...PROVIDER_DEFAULTS, id: 6, label: 'Grok', binary: 'grok', sortOrder: 5 });
  await initProviders();
  const signedOut = new Set([2]);
  mountRuntimes(signedOut);
  const available = async () =>
    Object.fromEntries((await call('runtimes', { repo })).providers.map((p) => [p.label, p.available]));
  // One login of two signed out keeps the entry usable; an unprobed one counts.
  expect(await available()).toEqual({ 'claude label': true, Gateway: true, Grok: false });
  signedOut.add(3);
  expect(await available()).toEqual({ 'claude label': false, Gateway: true, Grok: false });
});

it('passes a picked runtime on for the session start to resolve', async () => {
  const start = async (runtime) =>
    (await call('start_session', { repo, prompt: 'Make a change', ...runtime })).body;
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
    expect(await status(name, body)).toBe(400);
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
  const first = await call('pull_files', { repo, pr: 7 });
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
  const second = await call('pull_files', { ...pinned, page: 2 });
  expect(second.nextPage).toBeNull();
  expect(second.files.map((f) => f.filename)).toContain('src/f149.js');
  expect(paths).toContain('/repos/owner/project/pulls/7/files?per_page=100&page=2');
  // A push between pages is a conflict, not a silently mixed file list.
  head = 'head-2';
  await expect(call('pull_files', { ...pinned, page: 2 })).rejects.toMatchObject({
    status: 409,
    message: expect.stringContaining('changed'),
  });
  const reads = fake.github.mock.calls.length;
  for (const [body, refused] of [
    [{ repo: 'other/project', pr: 7 }, 403],
    [{ repo, pr: 7, page: 0 }, 400],
    [{ repo, pr: 7, page: '2' }, 400],
    [{ repo, pr: 7, section: 'checks' }, 400],
    [{ repo, pr: 7, page: 31 }, 400],
  ])
    expect(await status('pull_files', body)).toBe(refused);
  // The cap is in the schema clients generate from, not only in the handler.
  const files = dashboardTools([]).find((t) => t.name === 'dashboard_pull_files');
  expect(files.inputSchema.properties.page).toEqual({ type: 'integer', minimum: 1, maximum: 30 });
  expect(fake.github.mock.calls.length).toBe(reads);
});

it('merges a pull request pinned to the commit it read', async () => {
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
  expect(merged).toEqual({ merged: true, sha: 'merge-sha', message: 'Merged' });
  expect(sent.at(-1)).toEqual([
    'PUT',
    '/repos/owner/project/pulls/7/merge',
    { merge_method: 'rebase', sha: headSha },
  ]);
  // Squash unless a method is named; a retargeted pull request is a conflict.
  await call('merge_pull', { repo, pr: 7, headSha, baseRef: 'main' });
  expect(sent.at(-1)[2].merge_method).toBe('squash');
  expect(await status('merge_pull', { repo, pr: 7, headSha, baseRef: 'release' })).toBe(409);
  const writes = sent.filter(([method]) => method === 'PUT').length;
  for (const [body, refused] of [
    [{ repo: 'other/project', pr: 7, headSha, baseRef: 'main' }, 403],
    [{ repo, pr: 7, baseRef: 'main' }, 400],
    [{ repo, pr: 7, headSha }, 400],
    [{ repo, pr: 7, headSha: 'short', baseRef: 'main' }, 400],
    [{ repo, pr: 7, headSha, baseRef: 'main', method: 'fast-forward' }, 400],
  ])
    expect(await status('merge_pull', body)).toBe(refused);
  expect(sent.filter(([method]) => method === 'PUT').length).toBe(writes);
  const tool = dashboardTools([]).find((t) => t.name === 'dashboard_merge_pull');
  expect(tool.annotations.readOnlyHint).toBe(false);
});
