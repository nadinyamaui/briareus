import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSshService } from '../lib/ssh.js';
import { sshRoutes } from '../lib/ssh-routes.js';
import { sameOriginWrites } from '../lib/security.js';
import { requireAuth } from '../lib/auth.js';

vi.mock('../lib/config.js', () => ({
  getConfig: () => ({ auth: { username: 'admin', passwordHash: 'configured', secret: 'secret' } }),
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
  app.use(sameOriginWrites);
  app.use((req, res, next) => {
    // A test-only stand-in for the signed-in browser; everything else uses the real auth gate.
    if (req.headers.cookie === 'test-browser') return next();
    return requireAuth(req, res, next);
  });
  app.use(
    sshRoutes({
      service,
      getProject: (repo) => (repo === input.repo ? { repo } : null),
      agentSession: (req, res) => {
        if (req.headers.authorization === 'Bearer session-token') return job;
        res.status(401).json({ error: 'Unknown session token' });
        return null;
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
const request = (path, { browser = false, token = '', method = 'GET', body, origin } = {}) =>
  fetch(base + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(browser ? { cookie: 'test-browser' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(origin ? { origin } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'manual',
  });

describe('SSH HTTP authorization and registration', () => {
  it('requires browser authentication for settings and decisions', async () => {
    expect((await request('/api/ssh/servers')).status).toBe(401);
    expect(
      (
        await request('/api/ssh/requests/fake/decision', {
          token: 'session-token',
          method: 'POST',
          body: { decision: 'approve' },
        })
      ).status,
    ).toBe(401);
  });
  it('rejects agent credentials even when the browser auth gate is open', async () => {
    expect(
      (
        await request('/api/ssh/servers', {
          browser: true,
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
      expect((await request(path, { browser: true, token: 'invalid', method })).status).toBe(401);
    }
  });
  it('registers, updates and deletes a server through settings', async () => {
    const created = await request('/api/ssh/servers', { browser: true, method: 'POST', body: input });
    expect(created.status).toBe(201);
    const { server: row } = await created.json();
    expect(row.permissionMode).toBe('ask');
    const updated = await request(`/api/ssh/servers/${row.id}`, {
      browser: true,
      method: 'PUT',
      body: { permissionMode: 'allow' },
    });
    expect((await updated.json()).server.permissionMode).toBe('allow');
    expect((await request(`/api/ssh/servers/${row.id}`, { browser: true, method: 'DELETE' })).status).toBe(
      200,
    );
    expect(service.list()).toEqual([]);
  });
  it('refuses cross-origin writes and nonexistent project assignments', async () => {
    expect(
      (
        await request('/api/ssh/servers', {
          browser: true,
          method: 'POST',
          body: input,
          origin: 'https://evil.example',
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await request('/api/ssh/servers', {
          browser: true,
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
  it('executes only after a browser decision, then serves the result to the owning session', async () => {
    const row = await service.create(input);
    const res = await request('/api/agent/ssh/execute', {
      token: 'session-token',
      method: 'POST',
      body: { serverId: row.id, command: 'pwd' },
    });
    const { request: queued } = await res.json();
    expect(execute).not.toHaveBeenCalled();
    const pending = await request('/api/ssh/requests', { browser: true });
    expect(pending.headers.get('cache-control')).toBe('no-store');
    expect((await pending.json()).requests[0].id).toBe(queued.id);
    expect(
      (
        await request(`/api/ssh/requests/${queued.id}/decision`, {
          browser: true,
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
