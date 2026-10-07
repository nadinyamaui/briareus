// @ts-check
import { Router } from 'express';
import { MAIL_ACCOUNT_DEFAULTS } from './mail.js';

// The mail service's handlers (lib/mail.js), reached only through /api/v1 and
// only with an admin token: what they read is the operator's own mail, which
// no project's token has any claim to.
/** @param {{ service: ReturnType<typeof import('./mail.js').createMailService> }} deps */
export function mailRoutes({ service }) {
  const router = Router();
  // Agent tokens never reach a mailbox; the gateway strips the header it judged.
  router.use('/api/mail', (req, res, next) => {
    if (req.headers.authorization) return res.status(403).json({ error: 'Mail is reached through /api/v1' });
    next();
  });
  /** @param {(req: import('express').Request) => any} fn @param {number} [status] */
  const handle =
    (fn, status = 200) =>
    async (/** @type {import('express').Request} */ req, /** @type {import('express').Response} */ res) => {
      try {
        res.status(status).json(await fn(req));
      } catch (e) {
        res.status(e.status || 400).json({ error: e.message });
      }
    };

  router.get(
    '/api/mail/accounts',
    handle(async () => ({
      accounts: await service.list(),
      providers: service.providers(),
      defaults: MAIL_ACCOUNT_DEFAULTS,
    })),
  );
  router.post(
    '/api/mail/connect',
    handle(async (req) => service.connectStart(req.body || {})),
  );
  router.post(
    '/api/mail/connect/finish',
    handle(async (req) => ({ account: await service.connectFinish(req.body || {}) }), 201),
  );
  router.put(
    '/api/mail/accounts/:id',
    handle(async (req) => ({ account: await service.update(Number(req.params.id), req.body || {}) })),
  );
  router.delete(
    '/api/mail/accounts/:id',
    handle(async (req) => {
      await service.remove(Number(req.params.id));
      return { ok: true };
    }),
  );
  router.post(
    '/api/mail/accounts/:id/sync',
    handle(async (req) => ({ account: await service.sync(Number(req.params.id)) }), 202),
  );
  router.get(
    '/api/mail/messages',
    handle((req) => service.messages(req.query)),
  );
  router.get(
    '/api/mail/accounts/:account/messages/:id',
    handle(async (req) => ({
      message: await service.message(Number(req.params.account), String(req.params.id)),
    })),
  );
  return router;
}
