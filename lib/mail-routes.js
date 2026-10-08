// @ts-check
import { Router } from 'express';
import { MAIL_ACCOUNT_DEFAULTS, MAIL_CALLBACK_PATH } from './mail.js';

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
      callbackUrl: service.callbackUrl(),
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

// Where a provider's sign-in ends when its redirect URI is this server's own
// (the providers' web-server flow): the browser arrives with the `code` and
// the `state`, and the exchange happens before the page is answered, well
// inside the minute a Microsoft code lasts. It has no token, so the state
// (single-use, fifteen minutes) is all it is judged by. The answer is one
// line of plain text for whoever is looking at the browser; a client follows
// the account through the API.
/** @param {{ service: ReturnType<typeof import('./mail.js').createMailService> }} deps */
export function mailCallbackRoutes({ service }) {
  const router = Router();
  router.get(MAIL_CALLBACK_PATH, async (req, res) => {
    res.set('Cache-Control', 'no-store').type('text/plain');
    try {
      const account = await service.connectFinish({
        url: new URL(req.originalUrl, 'http://callback').toString(),
      });
      res.send(`Connected ${account.email}. You can close this window.\n`);
    } catch (e) {
      res.status(e.status || 400).send(`The mailbox was not connected: ${e.message}\n`);
    }
  });
  return router;
}
