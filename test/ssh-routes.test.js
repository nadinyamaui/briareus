import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSshService } from '../lib/ssh.js';
import { sshRoutes } from '../lib/ssh-routes.js';
import { agentOnly } from '../lib/auth.js';

vi.mock('../lib/config.js', () => ({
  getConfig: () => ({ auth: { secret: 'secret' }, credentialsKey: 'k'.repeat(32) }),
}));
let server, base, service, job, execute;
const input = {
  repo: 'owner/repo',
  host: 'server.example',
  username: 'deploy',
  identityFile: '/keys/deploy',
};
beforeEach(async () => {
  job = { id: 'one', repo: input.repo, status: 'running', turns: 0 };
  execute = vi.fn(async () => ({ stdout: 'done', exitCode: 0 }));
  service = createSshService({ load: async () => [], save: async () => {}, execute, getJob: () => job });
  await service.init();
  const app = express();
  app.use(express.json());
  // The real app's shape: the operator reaches these through /api/v1 with a
  // token (a header stands in for one here), an agent's own routes are the
  // only ones answered at their own path, and the rest of /api is retired.
  const routes = sshRoutes({
    service,
    getProject: (repo) => (repo === input.repo ? { repo } : null),
    agentSession: (req, res) => {
      if (req.headers.authorization === 'Bearer session-token') return job;
      res.status(401).json({ error: 'Unknown session token' });
      return null;
    },
  });
  app.use((req, res, next) =>
    req.headers['x-test-operator'] ? routes(req, res, next) : agentOnly(routes)(req, res, next),
  );
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
      ['/api/agent/ssh/requests/fake', 'GET'],
    ]) {
      expect((await request(path, { operator: true, token: 'invalid', method })).status).toBe(401);
    }
  });
  it('registers, updates and deletes a server through settings', async () => {
    const created = await request('/api/ssh/servers', { operator: true, method: 'POST', body: input });
    expect(created.status).toBe(201);
    const { server: row } = await created.json();
    expect(row.permissionMode).toBe('ask');
    const updated = await request(`/api/ssh/servers/${row.id}`, {
      operator: true,
      method: 'PUT',
      body: { permissionMode: 'allow' },
    });
    expect((await updated.json()).server.permissionMode).toBe('allow');
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
  it('omits identity paths from the agent server list', async () => {
    await service.create(input);
    const res = await request('/api/agent/ssh/servers', { token: 'session-token' });
    const { servers } = await res.json();
    expect(servers).toHaveLength(1);
    expect(servers[0]).not.toHaveProperty('identityFile');
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
