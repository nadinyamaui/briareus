// @ts-check
// The operator's WhatsApp for project sessions, behind the same per-project opt-in as mail.
// Pairing (start, QR, logout) stays with the admin API: a session reads, replies and marks
// chats read, but never links or unlinks the phone.
import { Router } from 'express';
import { operatorInboxSession } from './mail-agent.js';

const REFUSED = 'WhatsApp requires an interactive session in a project with WhatsApp tools enabled';

export function whatsappSessionAllowed(job, project) {
  return project?.whatsappToolsEnabled === true && operatorInboxSession(job, project);
}

/**
 * @param {{
 *   service: ReturnType<typeof import('./whatsapp.js').createWhatsAppService>,
 *   agentSession: (req: any, res: any) => any,
 *   getProject: (repo: string) => any,
 * }} deps
 */
export function whatsappAgentRoutes({ service, agentSession, getProject }) {
  const router = Router();
  router.use('/api/agent/whatsapp', (req, res, next) => {
    const job = agentSession(req, res);
    if (!job) return;
    if (!whatsappSessionAllowed(job, getProject(job.repo))) return res.status(403).json({ error: REFUSED });
    res.set('Cache-Control', 'no-store');
    // A send can wait behind a slow read; the opt-in is checked again just before it goes out.
    res.locals.whatsappAuthorize = () => {
      if (!whatsappSessionAllowed(job, getProject(job.repo)))
        throw Object.assign(new Error(REFUSED), { status: 403 });
    };
    next();
  });
  const handle =
    (fn, status = 200) =>
    async (req, res) => {
      try {
        res.status(status).json(await fn(req, res));
      } catch (e) {
        res
          .status(e.status || 502)
          .json({ error: e.status ? e.message : 'WhatsApp returned an unexpected response' });
      }
    };
  router.get(
    '/api/agent/whatsapp/accounts',
    handle(() => service.accounts()),
  );
  router.get(
    '/api/agent/whatsapp/accounts/:id/conversations',
    handle((req) => service.conversations(req.params.id, req.query)),
  );
  router.get(
    '/api/agent/whatsapp/accounts/:id/conversations/:chat/messages',
    handle((req) => service.messages(req.params.id, req.params.chat, req.query)),
  );
  router.post(
    '/api/agent/whatsapp/accounts/:id/conversations/:chat/messages',
    handle((req, res) => {
      res.locals.whatsappAuthorize();
      return service.send(req.params.id, req.params.chat, req.body || {});
    }, 201),
  );
  router.post(
    '/api/agent/whatsapp/accounts/:id/conversations/:chat/read',
    handle((req, res) => {
      res.locals.whatsappAuthorize();
      return service.markRead(req.params.id, req.params.chat);
    }),
  );
  return router;
}
