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

// Mail belongs to a user (lib/users.js). Only opted-in projects' interactive chats receive these
// tools, and they reach the mailboxes of the session's inbox owner: whoever owns it, or for a
// session nobody owns (one from before users) the earliest user, its original operator.
export function mailSessionAllowed(job, project) {
  return project?.mailToolsEnabled === true && operatorInboxSession(job, project);
}

export function mailAgentRoutes({
  service,
  agentSession,
  getProject,
  wakeState = undefined,
  wakeUpdate = undefined,
  inboxOwner = (/** @type {any} */ job) => /** @type {number | null} */ (job.ownerId ?? null),
}) {
  const router = Router();
  router.use('/api/agent/mail', (req, res, next) => {
    const job = agentSession(req, res);
    if (!job) return;
    if (!mailSessionAllowed(job, getProject(job.repo)))
      return res
        .status(403)
        .json({ error: 'Mail requires an interactive session in a project with email tools enabled' });
    const owner = inboxOwner(job);
    if (owner == null)
      return res.status(403).json({ error: 'This session has no user whose mail it could reach' });
    res.set('Cache-Control', 'no-store');
    res.locals.mailJob = job;
    res.locals.mail = service.forUser(owner);
    res.locals.mailAuthorize = () => {
      if (inboxOwner(job) !== owner)
        throw Object.assign(new Error('This session no longer has access to these mailboxes'), {
          status: 403,
        });
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
      await validateWakeAccounts(res.locals.mail, req.body);
      res.locals.mailAuthorize();
      return wakeUpdate(res.locals.mailJob.id, req.body);
    }),
  );
  router.post(
    '/api/agent/mail/connect',
    handle((req, res) => res.locals.mail.connectStart(req.body || {})),
  );
  router.post(
    '/api/agent/mail/connect/finish',
    handle(async (req, res) => ({ account: await res.locals.mail.connectFinish(req.body || {}) })),
  );
  router.get(
    '/api/agent/mail/accounts',
    handle(async (_req, res) => ({ accounts: await res.locals.mail.list() })),
  );
  router.get(
    '/api/agent/mail/messages',
    handle((req, res) => res.locals.mail.messages(req.query)),
  );
  router.get(
    '/api/agent/mail/accounts/:account/messages/:id',
    handle(async (req, res) => ({
      message: await res.locals.mail.message(Number(req.params.account), String(req.params.id)),
    })),
  );
  router.get(
    '/api/agent/mail/accounts/:account/messages/:id/attachments/:attachment',
    handle((req, res) =>
      res.locals.mail.attachment(
        Number(req.params.account),
        String(req.params.id),
        String(req.params.attachment),
        res.locals.mailAuthorize,
      ),
    ),
  );
  router.post(
    '/api/agent/mail/accounts/:account/sync',
    handle(async (req, res) => ({
      account: await res.locals.mail.sync(Number(req.params.account)),
    })),
  );
  router.post(
    '/api/agent/mail/accounts/:account/messages/:id/trash',
    handle(async (req, res) => {
      await res.locals.mail.trashMessage(
        Number(req.params.account),
        String(req.params.id),
        res.locals.mailAuthorize,
      );
      return { ok: true, action: 'trash' };
    }),
  );
  router.post(
    '/api/agent/mail/accounts/:account/action',
    actionBody,
    handle((req, res) =>
      res.locals.mail.action(Number(req.params.account), req.body || {}, res.locals.mailAuthorize),
    ),
  );
  return router;
}
