// @ts-check
import { Router } from 'express';
import { SSH_DEFAULTS } from './ssh.js';

// `mayDecide` says whether the user a request acts as may approve or deny one command: a
// member only those of their own sessions. A project-limited token also sees only its
// projects' commands (lib/api-v1.js).
export function sshRoutes({
  service,
  agentSession,
  getProject,
  mayDecide = /** @type {(user: any, request: any) => boolean} */ (() => true),
  monitor = null,
  monitorEndpoint = /** @type {(id: number) => string} */ (() => ''),
  mayViewResources = /** @type {(user: any, server: any) => boolean} */ ((user) => user?.role === 'admin'),
}) {
  const router = Router();
  // Agent tokens never authorize server registration or command approvals.
  router.use('/api/ssh', (req, res, next) => {
    if (req.headers.authorization)
      return res
        .status(403)
        .json({ error: 'SSH permissions are managed through /api/v1 with an operator token' });
    next();
  });
  const handle = (fn) => async (req, res) => {
    try {
      await fn(req, res);
    } catch (e) {
      res.status(e.status || 400).json({ error: e.message });
    }
  };
  const checkProject = (input) => {
    if (!getProject(input.repo)) throw new Error('Choose an existing project');
    return input;
  };
  const resourceServers = (res) =>
    service
      .list()
      .filter(
        (server) =>
          (!res.locals.apiRepos || res.locals.apiRepos.includes(server.repo)) &&
          mayViewResources(res.locals.apiUser, server),
      );
  router.post(
    '/api/ssh/servers/:id/monitor-token',
    handle(async (req, res) => {
      const id = Number(req.params.id);
      const endpoint = monitorEndpoint(id);
      if (!endpoint.startsWith('https://'))
        throw new Error('Set PUBLIC_BASE_URL to the core’s public HTTPS address first');
      const token = await service.issueMonitorToken(id);
      res
        .set('Cache-Control', 'no-store')
        .json({ serverId: id, endpoint, token, intervalSeconds: 60, retentionHours: 24 });
    }),
  );
  router.delete(
    '/api/ssh/servers/:id/monitor-token',
    handle(async (req, res) => {
      await service.revokeMonitorToken(Number(req.params.id));
      res.json({ ok: true });
    }),
  );
  router.get(
    '/api/ssh/monitoring',
    handle(async (_req, res) => {
      if (!monitor) throw Object.assign(new Error('Resource monitoring unavailable'), { status: 503 });
      res.json({
        servers: await monitor.summary(resourceServers(res)),
        intervalSeconds: 60,
        retentionHours: 24,
      });
    }),
  );
  router.get(
    '/api/ssh/servers/:id/resources',
    handle(async (req, res) => {
      const server = resourceServers(res).find((row) => row.id === Number(req.params.id));
      if (!server) throw Object.assign(new Error('SSH server not found'), { status: 404 });
      if (!monitor) throw Object.assign(new Error('Resource monitoring unavailable'), { status: 503 });
      res.json(await monitor.history(server, req.query.since));
    }),
  );
  router.get('/api/ssh/servers', (_req, res) =>
    res.json({ servers: service.list(), defaults: SSH_DEFAULTS }),
  );
  router.post(
    '/api/ssh/servers',
    handle(async (req, res) =>
      res.status(201).json({ server: await service.create(checkProject(req.body || {})) }),
    ),
  );
  router.put(
    '/api/ssh/servers/:id',
    handle(async (req, res) => {
      if (Object.hasOwn(req.body || {}, 'repo')) checkProject(req.body);
      res.json({ server: await service.update(Number(req.params.id), req.body || {}) });
    }),
  );
  router.delete(
    '/api/ssh/servers/:id',
    handle(async (req, res) => {
      await service.remove(Number(req.params.id));
      res.json({ ok: true });
    }),
  );
  router.get(
    '/api/ssh/servers/:id/db-credentials',
    handle((req, res) => {
      res.set('Cache-Control', 'no-store');
      res.json({ credentials: service.dbLogin(Number(req.params.id)) });
    }),
  );
  const decidable = (res) => (r) =>
    (!res.locals.apiRepos || res.locals.apiRepos.includes(r.repo)) && mayDecide(res.locals.apiUser, r);
  router.get('/api/ssh/requests', (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ requests: service.pending().filter(decidable(res)) });
  });
  router.post(
    '/api/ssh/requests/:id/decision',
    handle((req, res) => {
      // Someone else's command answers as one no longer waiting, so it cannot be probed.
      const request = service.pending().find((r) => r.id === req.params.id);
      if (request && !decidable(res)(request)) throw new Error('SSH request is no longer awaiting approval');
      res.json({ request: service.decide(req.params.id, req.body?.decision) });
    }),
  );
  router.get(
    '/api/agent/ssh/servers',
    handle((req, res) => {
      const job = agentSession(req, res);
      if (!job) return;
      res.json({ servers: service.forSession(job).map(({ identityFile, ...s }) => s) });
    }),
  );
  router.post(
    '/api/agent/ssh/execute',
    handle((req, res) => {
      const job = agentSession(req, res);
      if (!job) return;
      res.json({ request: service.request(job, req.body || {}) });
    }),
  );
  router.post(
    '/api/agent/ssh/upload',
    handle(async (req, res) => {
      const job = agentSession(req, res);
      if (!job) return;
      res.json({ request: await service.upload(job, req.body || {}) });
    }),
  );
  router.get(
    '/api/agent/ssh/requests/:id',
    handle((req, res) => {
      const job = agentSession(req, res);
      if (!job) return;
      res.set('Cache-Control', 'no-store');
      res.json({ request: service.result(job, req.params.id) });
    }),
  );
  return router;
}
