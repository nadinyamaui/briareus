import express from 'express';
import { expect, it, vi } from 'vitest';
import { requireAuth } from '../lib/auth.js';
import { sameOriginWrites } from '../lib/security.js';
import { operationsRoutes } from '../lib/operations-routes.js';
import { deploymentRoutes } from '../lib/deployment-routes.js';
import { notificationRoutes } from '../lib/notification-routes.js';
vi.mock('../lib/config.js', () => ({
  getConfig: () => ({ auth: { username: 'admin', passwordHash: 'configured', secret: 'secret' } }),
}));
it('protects all operator extensions with browser authentication and same-origin writes', async () => {
  const deploy = vi.fn(),
    configure = vi.fn();
  const app = express();
  app.use(express.json());
  app.use(sameOriginWrites);
  app.use((req, res, next) => (req.headers.cookie === 'test-browser' ? next() : requireAuth(req, res, next)));
  app.use(
    operationsRoutes({
      listSessions: () => [],
      ssh: { pending: () => [], runningCount: () => 0 },
      getJob: () => null,
      sendMessage: vi.fn(),
    }),
  );
  app.use(deploymentRoutes({ service: { deploy }, getProject: () => ({ repo: 'a/b' }) }));
  app.use(notificationRoutes({ service: { configure }, getProject: () => ({ repo: 'a/b' }) }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const path of [
      '/api/operations/attention',
      '/api/operations/deployments?repo=a/b',
      '/api/operations/notifications',
    ])
      expect((await fetch(base + path)).status).toBe(401);
    const request = (headers) =>
      fetch(base + '/api/operations/deployments/dispatch?repo=a/b', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: '{"planId":"test"}',
      });
    expect((await request({ cookie: 'test-browser', origin: 'https://foreign.example' })).status).toBe(403);
    expect((await request({ cookie: 'test-browser', authorization: 'Bearer internal' })).status).toBe(403);
    expect(deploy).not.toHaveBeenCalled();
    expect(configure).not.toHaveBeenCalled();
  } finally {
    await new Promise((r) => server.close(r));
  }
});
