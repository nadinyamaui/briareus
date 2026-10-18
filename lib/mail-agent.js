// @ts-check
import express, { Router } from 'express';
import { validateWakeAccounts } from './mail-wake.js';

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

// A send's attachments ride its JSON body, base64-encoded (lib/mail-actions.js caps the files at
// 18 MiB), so this path skips the app-wide 1 MB parser and is parsed once its session is judged.
const ACTION_PATH = /^\/api\/agent\/mail\/accounts\/[^/]+\/action\/?$/;
export const mailActionPath = (path) => ACTION_PATH.test(path);
const actionBody = express.json({ limit: '26mb' });

// Mail belongs to the operator. Only opted-in projects' interactive chats receive these tools.
export function mailSessionAllowed(job, project) {
  return project?.mailToolsEnabled === true && operatorInboxSession(job, project);
}

export function mailAgentRoutes({
  service,
  agentSession,
  getProject,
  wakeState = undefined,
  wakeUpdate = undefined,
}) {
  const router = Router();
  router.use('/api/agent/mail', (req, res, next) => {
    const job = agentSession(req, res);
    if (!job) return;
    if (!mailSessionAllowed(job, getProject(job.repo)))
      return res
        .status(403)
        .json({ error: 'Mail requires an interactive session in a project with email tools enabled' });
    res.set('Cache-Control', 'no-store');
    res.locals.mailJob = job;
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
  router.get(
    '/api/agent/mail/wake-rules',
    handle((req, res) => wakeState(res.locals.mailJob.id)),
  );
  router.put(
    '/api/agent/mail/wake-rules',
    handle(async (req, res) => {
      await validateWakeAccounts(service, req.body);
      res.locals.mailAuthorize();
      return wakeUpdate(res.locals.mailJob.id, req.body);
    }),
  );
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
  router.get(
    '/api/agent/mail/accounts/:account/messages/:id/attachments/:attachment',
    handle((req, res) =>
      service.attachment(
        Number(req.params.account),
        String(req.params.id),
        String(req.params.attachment),
        res.locals.mailAuthorize,
      ),
    ),
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
    actionBody,
    handle((req, res) =>
      service.action(Number(req.params.account), req.body || {}, res.locals.mailAuthorize),
    ),
  );
  return router;
}
