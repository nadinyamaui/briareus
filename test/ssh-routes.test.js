import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSshService } from '../lib/ssh.js';
import { operationsRoutes } from '../lib/operations-routes.js';
import { sshRoutes } from '../lib/ssh-routes.js';
import { agentOnly } from '../lib/auth.js';

vi.mock('../lib/config.js', () => ({
  getConfig: () => ({ auth: { secret: 'secret' }, credentialsKey: 'k'.repeat(32) }),
}));
let server, base, service, job, execute, apiUser, apiRepos, monitor, sharedServers;
const input = {
  repo: 'owner/repo',
  host: 'server.example',
  username: 'deploy',
  identityFile: '/keys/deploy',
};
beforeEach(async () => {
  job = { id: 'one', repo: input.repo, status: 'running', turns: 0, ownerId: 1 };
  apiUser = { id: 1, role: 'admin' };
  apiRepos = null;
  sharedServers = [];
  monitor = {
    summary: vi.fn(async (servers) => servers.map(({ id, label, repo }) => ({ id, label, repo }))),
    history: vi.fn(async (server, since) => ({ serverId: server.id, since, samples: [] })),
  };
  execute = vi.fn(async () => ({ stdout: 'done', exitCode: 0 }));
  service = createSshService({ load: async () => [], save: async () => {}, execute, getJob: () => job });
  await service.init();
  const app = express();
  app.use(express.json());
  // The real app's shape: the operator comes through /api/v1 with a token (a header here),
  // only an agent's own routes answer at their own path, and the rest of /api is retired.
  const routes = sshRoutes({
    service,
    monitor,
    monitorEndpoint: (id) => `https://core.example/api/v1/telemetry/ssh/${id}/samples`,
    mayViewResources: (user, server) => user.role === 'admin' || sharedServers.includes(server.id),
    mayDecide: (user, request) =>
      user.role === 'admin' || (request.jobId === job.id && job.ownerId === user.id),
    getProject: (repo) => (repo === input.repo ? { repo } : null),
    agentSession: (req, res) => {
      if (req.headers.authorization === 'Bearer session-token') return job;
      res.status(401).json({ error: 'Unknown session token' });
      return null;
    },
  });
  const operations = operationsRoutes({
    listSessions: () => [job],
    ssh: service,
    getJob: () => job,
    sendMessage: vi.fn(),
    sshVisible: (user) => user.role === 'admin' || user.id === job.ownerId,
  });
  app.use((req, res, next) => {
    res.locals.apiUser = apiUser;
    res.locals.apiRepos = apiRepos;
    return req.headers['x-test-operator']
      ? operations(req, res, () => routes(req, res, next))
      : agentOnly(routes)(req, res, next);
  });
  app.use('/api', (req, res) => res.status(410).json({ error: 'This route is retired' }));
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
afterEach(async () => {
  await new Promise((resolve) => server.close(resolve));
});
const request = (path, { operator = false, token = '', method = 'GET', body } = {}) =>
  fetch(base + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(operator ? { 'x-test-operator': '1' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'manual',
  });

describe('SSH HTTP authorization and registration', () => {
  it('issues and revokes a per-host machine credential only through operator settings', async () => {
    const row = await service.create(input);
    const path = `/api/ssh/servers/${row.id}/monitor-token`;
    expect((await request(path, { operator: true, token: 'session-token', method: 'POST' })).status).toBe(
      403,
    );
    const issued = await request(path, { operator: true, method: 'POST' });
    expect(issued.status).toBe(200);
    const config = await issued.json();
    expect(config).toMatchObject({
      serverId: row.id,
      intervalSeconds: 60,
      retentionHours: 24,
      endpoint: `https://core.example/api/v1/telemetry/ssh/${row.id}/samples`,
    });
    expect(config.token).toMatch(/^brm_/);
    expect(service.authorizeMonitor(row.id, config.token)).toBeTruthy();
    expect(JSON.stringify(service.list())).not.toContain(config.token);
    expect((await request(path, { operator: true, method: 'DELETE' })).status).toBe(200);
    expect(service.authorizeMonitor(row.id, config.token)).toBeNull();
  });
  it('shows telemetry only for shared servers inside the token’s project scope', async () => {
    const mine = await service.create(input);
    const other = await service.create({ ...input, repo: 'other/repo' });
    apiUser = { id: 2, role: 'member' };
    apiRepos = [input.repo];
    sharedServers = [mine.id, other.id];
    const response = await request('/api/ssh/monitoring', { operator: true });
    expect(response.status).toBe(200);
    expect((await response.json()).servers.map((server) => server.id)).toEqual([mine.id]);
    expect((await request(`/api/ssh/servers/${other.id}/resources`, { operator: true })).status).toBe(404);
    sharedServers = [];
    expect((await request(`/api/ssh/servers/${mine.id}/resources`, { operator: true })).status).toBe(404);
    expect(monitor.history).not.toHaveBeenCalled();
    apiUser = { id: 1, role: 'admin' };
    expect((await request(`/api/ssh/servers/${other.id}/resources`, { operator: true })).status).toBe(404);
    const history = await request(`/api/ssh/servers/${mine.id}/resources?since=123`, { operator: true });
    expect(await history.json()).toMatchObject({ serverId: mine.id, since: '123' });
  });
  it('keeps resource APIs unavailable to session tokens', async () => {
    const row = await service.create(input);
    for (const path of ['/api/ssh/monitoring', `/api/ssh/servers/${row.id}/resources`]) {
      expect((await request(path, { operator: true, token: 'session-token' })).status).toBe(403);
      expect((await request(path, { token: 'session-token' })).status).toBe(410);
    }
    expect(monitor.summary).not.toHaveBeenCalled();
    expect(monitor.history).not.toHaveBeenCalled();
  });
  it('answers settings and decisions only through the API', async () => {
    expect((await request('/api/ssh/servers')).status).toBe(410);
    expect(
      (
        await request('/api/ssh/requests/fake/decision', {
          token: 'session-token',
          method: 'POST',
          body: { decision: 'approve' },
        })
      ).status,
    ).toBe(410);
  });
  it('rejects agent credentials even on the operator’s way in', async () => {
    expect(
      (
        await request('/api/ssh/servers', {
          operator: true,
          token: 'session-token',
          method: 'POST',
          body: input,
        })
      ).status,
    ).toBe(403);
    expect(service.list()).toEqual([]);
  });
  it('requires a valid session token for every agent route', async () => {
    for (const [path, method] of [
      ['/api/agent/ssh/servers', 'GET'],
      ['/api/agent/ssh/execute', 'POST'],
      ['/api/agent/ssh/upload', 'POST'],
      ['/api/agent/ssh/requests/fake', 'GET'],
    ]) {
      expect((await request(path, { operator: true, token: 'invalid', method })).status).toBe(401);
    }
  });
  it('registers, updates and deletes a server through settings', async () => {
    const created = await request('/api/ssh/servers', {
      operator: true,
      method: 'POST',
      body: { ...input, password: 'ssh-secret' },
    });
    expect(created.status).toBe(201);
    const { server: row } = await created.json();
    expect(row.permissionMode).toBe('ask');
    expect(row.hasPassword).toBe(true);
    expect(row).not.toHaveProperty('password');
    expect(row).not.toHaveProperty('passwordSealed');
    const updated = await request(`/api/ssh/servers/${row.id}`, {
      operator: true,
      method: 'PUT',
      body: { permissionMode: 'allow' },
    });
    expect((await updated.json()).server).toMatchObject({ permissionMode: 'allow', hasPassword: true });
    expect((await request(`/api/ssh/servers/${row.id}`, { operator: true, method: 'DELETE' })).status).toBe(
      200,
    );
    expect(service.list()).toEqual([]);
  });
  it('refuses nonexistent project assignments', async () => {
    expect(
      (
        await request('/api/ssh/servers', {
          operator: true,
          method: 'POST',
          body: { ...input, repo: 'wrong/repo' },
        })
      ).status,
    ).toBe(400);
  });
  it('omits identity paths and passwords from the agent server list', async () => {
    await service.create({ ...input, password: 'ssh-secret' });
    const res = await request('/api/agent/ssh/servers', { token: 'session-token' });
    const { servers } = await res.json();
    expect(servers).toHaveLength(1);
    expect(servers[0]).not.toHaveProperty('identityFile');
    expect(servers[0]).toMatchObject({ hasPassword: true });
    expect(servers[0]).not.toHaveProperty('password');
    expect(servers[0]).not.toHaveProperty('passwordSealed');
  });
  it('exposes an unattended approval in native Attention after ask-user, with the same owner and repo controls', async () => {
    const row = await service.create({ ...input, permissionMode: 'allow' });
    job.unattendedTurn = true;
    const res = await request('/api/agent/ssh/execute', {
      token: 'session-token',
      method: 'POST',
      body: { serverId: row.id, command: 'pwd' },
    });
    const { request: queued } = await res.json();
    job.status = 'idle';
    job.awaitingAnswer = true;
    const attention = async () =>
      (await (await request('/api/operations/attention', { operator: true })).json()).items;
    const pending = async () =>
      (await (await request('/api/ssh/requests', { operator: true })).json()).requests;
    const decide = () =>
      request(`/api/ssh/requests/${queued.id}/decision`, {
        operator: true,
        method: 'POST',
        body: { decision: 'approve' },
      });
    apiUser = { id: 2, role: 'member' };
    expect(await attention()).toEqual([]);
    expect(await pending()).toEqual([]);
    expect((await decide()).status).toBe(400);
    apiUser = { id: 1, role: 'member' };
    apiRepos = ['other/repo'];
    expect(await attention()).toEqual([]);
    expect((await decide()).status).toBe(400);
    apiRepos = [input.repo];
    expect(await attention()).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: 'ssh', request: queued })]),
    );
    expect(await pending()).toEqual([queued]);
    expect(execute).not.toHaveBeenCalled();
    expect((await decide()).status).toBe(200);
    expect(await pending()).toEqual([]);
    expect(execute).toHaveBeenCalledTimes(1);
    const result = await request(`/api/agent/ssh/requests/${queued.id}`, { token: 'session-token' });
    expect((await result.json()).request.status).toBe('completed');
  });
  it('executes only after an operator decision, then serves the result to the owning session', async () => {
    const row = await service.create(input);
    const res = await request('/api/agent/ssh/execute', {
      token: 'session-token',
      method: 'POST',
      body: { serverId: row.id, command: 'pwd' },
    });
    const { request: queued } = await res.json();
    expect(execute).not.toHaveBeenCalled();
    const pending = await request('/api/ssh/requests', { operator: true });
    expect(pending.headers.get('cache-control')).toBe('no-store');
    expect((await pending.json()).requests[0].id).toBe(queued.id);
    expect(
      (
        await request(`/api/ssh/requests/${queued.id}/decision`, {
          operator: true,
          method: 'POST',
          body: { decision: 'approve' },
        })
      ).status,
    ).toBe(200);
    const result = await request(`/api/agent/ssh/requests/${queued.id}`, { token: 'session-token' });
    expect((await result.json()).request).toMatchObject({ status: 'completed', result: { stdout: 'done' } });
    expect(execute).toHaveBeenCalledTimes(1);
  });
});

describe('SSH database login over HTTP', () => {
  it('hands the opened login to the operator only, uncached', async () => {
    const created = await request('/api/ssh/servers', {
      operator: true,
      method: 'POST',
      body: { ...input, dbUsername: 'app', dbPassword: 's3cret' },
    });
    const { server } = await created.json();
    expect(server.hasDbCredentials).toBe(true);
    expect(server).not.toHaveProperty('dbPassword');
    const path = `/api/ssh/servers/${server.id}/db-credentials`;
    const res = await request(path, { operator: true });
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect((await res.json()).credentials).toEqual({
      host: '127.0.0.1',
      port: 3306,
      username: 'app',
      password: 's3cret',
    });
    expect((await request(path, { operator: true, token: 'session-token' })).status).toBe(403);
    expect((await request(path)).status).toBe(410);
    const agents = await (await request('/api/agent/ssh/servers', { token: 'session-token' })).text();
    expect(agents).not.toContain('s3cret');
  });
  it('answers 404 for a server without one', async () => {
    const { server } = await (
      await request('/api/ssh/servers', { operator: true, method: 'POST', body: input })
    ).json();
    expect((await request(`/api/ssh/servers/${server.id}/db-credentials`, { operator: true })).status).toBe(
      404,
    );
  });
});

it('keeps sudo credentials private and applies elevation only through the existing approval boundary', async () => {
  const created = await request('/api/ssh/servers', {
    operator: true,
    method: 'POST',
    body: { ...input, sudoPassword: 'sudo-secret' },
  });
  const { server } = await created.json();
  expect(server.hasSudoPassword).toBe(true);
  const listed = await (await request('/api/agent/ssh/servers', { token: 'session-token' })).text();
  expect(listed).not.toMatch(/sudo-secret|sudoPasswordSealed/);
  const res = await request('/api/agent/ssh/execute', {
    token: 'session-token',
    method: 'POST',
    body: { serverId: server.id, command: 'id -u', sudo: true },
  });
  const { request: pending } = await res.json();
  expect(pending).toMatchObject({ status: 'pending', sudo: true });
  expect(pending.command).toMatch(/^sudo -S/);
  expect(execute).not.toHaveBeenCalled();
  await request(`/api/ssh/requests/${pending.id}/decision`, {
    operator: true,
    method: 'POST',
    body: { decision: 'deny' },
  });
  expect(execute).not.toHaveBeenCalled();
  const edited = await request(`/api/ssh/servers/${server.id}`, {
    operator: true,
    method: 'PUT',
    body: { sudoPassword: '' },
  });
  expect((await edited.json()).server.hasSudoPassword).toBe(false);
});

describe('SSH approvals for members', () => {
  it('shows and lets a member rule only on their own sessions’ commands', async () => {
    const created = await request('/api/ssh/servers', { operator: true, method: 'POST', body: input });
    const { server: registered } = await created.json();
    const asked = await request('/api/agent/ssh/execute', {
      token: 'session-token',
      method: 'POST',
      body: { serverId: registered.id, command: 'uptime' },
    });
    const { request: pending } = await asked.json();
    const decide = () =>
      request(`/api/ssh/requests/${pending.id}/decision`, {
        operator: true,
        method: 'POST',
        body: { decision: 'deny' },
      });
    apiUser = { id: 2, role: 'member' };
    expect((await (await request('/api/ssh/requests', { operator: true })).json()).requests).toEqual([]);
    expect((await decide()).status).toBe(400);
    apiUser = { id: 1, role: 'member' };
    apiRepos = ['other/repo'];
    expect((await (await request('/api/ssh/requests', { operator: true })).json()).requests).toEqual([]);
    apiRepos = [input.repo];
    expect((await (await request('/api/ssh/requests', { operator: true })).json()).requests).toHaveLength(1);
    expect((await (await decide()).json()).request.status).toBe('denied');
  });
});

it('authenticates and dispatches upload metadata through the existing agent route', async () => {
  const upload = vi.spyOn(service, 'upload').mockResolvedValue({ id: 'upload-id', status: 'pending' });
  const body = { serverId: 1, sourcePath: '/workspace/owner.xlsx', destination: '/tmp/import.xlsx' };
  const res = await request('/api/agent/ssh/upload', { token: 'session-token', method: 'POST', body });
  expect(res.status).toBe(200);
  expect(upload).toHaveBeenCalledExactlyOnceWith(job, body);
  expect((await res.json()).request.id).toBe('upload-id');
});
