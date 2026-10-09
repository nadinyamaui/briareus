// @ts-check
import { Router } from 'express';

// Mail belongs to the operator. Only interactive chats receive these tools;
// review, QA, workers and unattended deliveries have no mailbox access.
export function mailSessionAllowed(job) {
  return (
    !!job &&
    job.kind === 'devchat' &&
    !!job.repo &&
    !job.parentId &&
    !job.loopParentId &&
    !job.qaParentId &&
    !job.loopFixParentId &&
    !job.autoClose &&
    !job.reviewBranch &&
    !job.qaBranch &&
    !job.readOnly &&
    !job.preview &&
    !job.unattendedTurn &&
    !['closed', 'failed'].includes(job.status)
  );
}

export function mailAgentRoutes({ service, agentSession }) {
  const router = Router();
  router.use('/api/agent/mail', (req, res, next) => {
    const job = agentSession(req, res);
    if (!job) return;
    if (!mailSessionAllowed(job))
      return res.status(403).json({ error: 'Mail requires an interactive session' });
    res.set('Cache-Control', 'no-store');
    next();
  });
  const handle = (fn) => async (req, res) => {
    try {
      res.json(await fn(req));
    } catch (e) {
      res.status(e.status || 400).json({ error: e.message });
    }
  };
  router.post(
    '/api/agent/mail/connect',
    handle((req) => service.connectStart(req.body || {})),
  );
  router.post(
    '/api/agent/mail/connect/finish',
    handle(async (req) => ({ account: await service.connectFinish(req.body || {}) })),
  );
  router.get(
    '/api/agent/mail/accounts',
    handle(async () => ({ accounts: await service.list() })),
  );
  router.get(
    '/api/agent/mail/messages',
    handle((req) => service.messages(req.query)),
  );
  router.get(
    '/api/agent/mail/accounts/:account/messages/:id',
    handle(async (req) => ({
      message: await service.message(Number(req.params.account), String(req.params.id)),
    })),
  );
  router.post(
    '/api/agent/mail/accounts/:account/sync',
    handle(async (req) => ({
      account: await service.sync(Number(req.params.account)),
    })),
  );
  router.post(
    '/api/agent/mail/accounts/:account/action',
    handle((req) => service.action(Number(req.params.account), req.body || {})),
  );
  return router;
}
