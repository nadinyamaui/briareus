// @ts-check
import { Router } from 'express';

// The operator's own inboxes (mail here, WhatsApp in lib/whatsapp-agent.js) reach only an
// enabled project's interactive chats: review, QA, workers and unattended deliveries never.
export function operatorInboxSession(job, project) {
  return (
    !!project &&
    project.enabled !== false &&
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

// Mail belongs to the operator. Only opted-in projects' interactive chats receive these tools.
export function mailSessionAllowed(job, project) {
  return project?.mailToolsEnabled === true && operatorInboxSession(job, project);
}

export function mailAgentRoutes({ service, agentSession, getProject }) {
  const router = Router();
  router.use('/api/agent/mail', (req, res, next) => {
    const job = agentSession(req, res);
    if (!job) return;
    if (!mailSessionAllowed(job, getProject(job.repo)))
      return res
        .status(403)
        .json({ error: 'Mail requires an interactive session in a project with email tools enabled' });
    res.set('Cache-Control', 'no-store');
    res.locals.mailAuthorize = () => {
      if (!mailSessionAllowed(job, getProject(job.repo)))
        throw Object.assign(
          new Error('Mail requires an interactive session in a project with email tools enabled'),
          { status: 403 },
        );
    };
    next();
  });
  const handle = (fn) => async (req, res) => {
    try {
      res.json(await fn(req, res));
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
    '/api/agent/mail/accounts/:account/messages/:id/trash',
    handle(async (req, res) => {
      await service.trashMessage(Number(req.params.account), String(req.params.id), res.locals.mailAuthorize);
      return { ok: true, action: 'trash' };
    }),
  );
  router.post(
    '/api/agent/mail/accounts/:account/action',
    handle((req, res) =>
      service.action(Number(req.params.account), req.body || {}, res.locals.mailAuthorize),
    ),
  );
  return router;
}
