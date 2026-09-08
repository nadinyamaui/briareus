// @ts-check
import { Router } from 'express';
import { SSH_DEFAULTS } from './ssh.js';

export function sshRoutes({ service, agentSession, getProject }) {
  const router = Router();
  // Agent tokens never authorize server registration or command approvals.
  router.use('/api/ssh', (req, res, next) => {
    if (req.headers.authorization)
      return res.status(403).json({ error: 'Use the dashboard to manage SSH permissions' });
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
  router.get('/api/ssh/requests', (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ requests: service.pending() });
  });
  router.post(
    '/api/ssh/requests/:id/decision',
    handle((req, res) => res.json({ request: service.decide(req.params.id, req.body?.decision) })),
  );
  router.get(
    '/api/agent/ssh/servers',
    handle((req, res) => {
      const job = agentSession(req, res);
      if (!job) return;
      res.json({ servers: service.list(job.repo).map(({ identityFile, ...s }) => s) });
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
