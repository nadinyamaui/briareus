import { readFileSync } from 'node:fs';
import { beforeEach, it, expect, vi } from 'vitest';
import { dashboardRoutes } from '../lib/dashboard-routes.js';
import { listActions } from '../lib/actions.js';
import { dashboardTools } from '../lib/dashboard-tools.js';

let dashboard, handler, project;
const principal = { id: 'connection', label: 'My ChatGPT', repos: ['owner/project'] };
beforeEach(() => {
  project = {
    repo: 'owner/project',
    label: 'Project',
    reviewProviderId: 2,
    reviewModel: 'review-model',
    reviewEffort: 'high',
    stepRuntimes: { testRun: { providerId: 3, model: 'qa-model', effort: 'medium' } },
  };
  dashboard = dashboardRoutes({
    app: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
    getProject: (repo) => (repo === project.repo ? project : null),
    getJob: (id) =>
      ({ mine: { repo: project.repo, kind: 'devchat' }, foreign: { repo: 'other/repo', kind: 'devchat' } })[
        id
      ],
    listActions,
  });
  handler = vi.fn((req, res) =>
    res.json({ body: req.body, params: req.params, repo: req.mcpProject, actor: req.mcpActor }),
  );
  for (const tool of dashboardTools(listActions())) dashboard.register(tool.method, tool.path, handler);
});
const call = (name, args = {}) => dashboard.call(principal, `dashboard_${name}`, args);

it('discovers all menu actions with write annotations and OAuth requirements', () => {
  const tools = dashboard.tools();
  for (const action of listActions()) {
    const entry = tools.find((t) => t.name === `dashboard_${action.id.replaceAll('-', '_')}`);
    expect(entry.annotations.readOnlyHint).toBe(false);
    expect(entry.securitySchemes).toEqual([{ type: 'oauth2', scopes: ['briareus:manage'] }]);
  }
  expect(new Set(tools.map((t) => t.name)).size).toBe(tools.length);
  expect(tools[0]).not.toHaveProperty('path');
});

it('lists only permitted projects and never exposes their settings or credentials', async () => {
  expect(await call('projects')).toEqual({ projects: [{ repo: project.repo, label: project.label }] });
});

it('dispatches every menu action with the configured project runtime', async () => {
  for (const action of listActions()) {
    const result = await call(action.id.replaceAll('-', '_'), {
      repo: project.repo,
      prNumber: 42,
      ...(action.input ? { input: 'Fix the bug' } : {}),
    });
    expect(result.body).toMatchObject({
      action: action.id,
      repo: project.repo,
      prNumber: 42,
      provider: action.id === 'test-run' ? 3 : 2,
      model: action.id === 'test-run' ? 'qa-model' : 'review-model',
    });
  }
});

it('requires configured runtimes instead of inheriting an internal session or accepting overrides', async () => {
  project.reviewProviderId = null;
  await expect(call('review', { repo: project.repo, prNumber: 1, branch: 'feature' })).rejects.toThrow(
    'Settings',
  );
  await expect(call('test_sheet', { repo: project.repo, prNumber: 1, provider: 10 })).rejects.toThrow(
    'Unknown argument',
  );
  expect(handler).not.toHaveBeenCalled();
});

it('rejects foreign projects, foreign sessions, unknown tools and malformed schemas', async () => {
  for (const [name, args] of [
    ['missing', {}],
    ['session', { sessionId: 'foreign' }],
    ['close', { sessionId: 'missing' }],
    ['test_sheet', { prNumber: 1, repo: 'other/repo' }],
    ['test_sheet', { prNumber: 1 }],
    ['test_sheet', { prNumber: -1, repo: project.repo }],
    ['test_sheet', { prNumber: '1', repo: project.repo }],
    ['custom_feedback', { prNumber: 1, repo: project.repo }],
    ['custom_feedback', { prNumber: 1, repo: project.repo, input: ' ' }],
    ['save_findings', { sessionId: 'mine', verdicts: [{ key: 'x', decision: 'approve' }] }],
  ])
    await expect(call(name, args)).rejects.toThrow();
  expect(handler).not.toHaveBeenCalled();
});

it('infers a session’s project and attributes writes to the external connection', async () => {
  expect(await call('reply_finding', { sessionId: 'mine', key: 'finding', text: 'reply' })).toMatchObject({
    params: { id: 'mine' },
    body: { key: 'finding', text: 'reply', repo: project.repo },
    actor: 'ChatGPT connection My ChatGPT',
  });
  expect((await call('drop_message', { sessionId: 'mine', index: 0 })).params).toMatchObject({
    id: 'mine',
    index: 0,
  });
});

it('propagates existing dashboard validation failures', async () => {
  handler.mockImplementation((_req, res) => res.status(502).json({ error: 'GitHub unavailable' }));
  await expect(call('pulls', { repo: project.repo })).rejects.toThrow('GitHub unavailable');
});

it('registers shared browser handlers and removes the internal MCP mount and API', () => {
  const source = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  for (const tool of dashboardTools(listActions()).filter((t) => t.name !== 'dashboard_projects')) {
    expect(source).toContain(`dashboard.register('${tool.method.toLowerCase()}', '${tool.path}',`);
  }
  const jobs = readFileSync(new URL('../lib/jobs.js', import.meta.url), 'utf8');
  expect(jobs).not.toContain('reviewer_dashboard');
  expect(jobs).not.toContain('dashboardProtocol');
  const registry = readFileSync(new URL('../lib/dashboard-routes.js', import.meta.url), 'utf8');
  expect(registry).not.toContain('/api/agent/dashboard');
});
