// @ts-check
import { Router } from 'express';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { isWhatsAppAccount } from './whatsapp.js';

// Each user reaches only their own WhatsApp accounts (lib/whatsapp-owners.js), whatever
// their role: an account reads and writes as the person whose phone is linked to it.
/**
 * @param {{
 *   service: ReturnType<typeof import('./whatsapp.js').createWhatsAppService>,
 *   owners?: ReturnType<typeof import('./whatsapp-owners.js').createWhatsAppOwners>,
 * }} deps
 */
export function whatsappRoutes({ service, owners = undefined }) {
  const router = Router();
  router.use('/api/whatsapp', (req, res, next) => {
    if (req.headers.authorization)
      return res.status(403).json({ error: 'WhatsApp is reached through /api/v1' });
    if (!res.locals.apiUser) return res.status(401).json({ error: 'Call this with a token' });
    res.set('Cache-Control', 'no-store');
    next();
  });
  const mine = (res, account) => !owners || owners.owns(res.locals.apiUser.id, account);
  // Starting an account the caller does not own yet claims it; every other call on one
  // they do not own answers as missing, before WAHA is asked.
  router.post('/api/whatsapp/accounts/:id/start', async (req, res, next) => {
    try {
      if (owners && isWhatsAppAccount(req.params.id))
        await owners.claim(res.locals.apiUser.id, req.params.id);
      next();
    } catch (e) {
      res
        .status(e.status || 502)
        .json({ error: e.status ? e.message : 'WhatsApp returned an unexpected response' });
    }
  });
  // A malformed name is the handler's to refuse with its 400.
  router.use('/api/whatsapp/accounts/:id', (req, res, next) =>
    !isWhatsAppAccount(req.params.id) || mine(res, req.params.id)
      ? next()
      : res.status(404).json({ error: 'WhatsApp account not found' }),
  );
  const handle =
    (fn, status = 200) =>
    async (req, res) => {
      try {
        res.status(status).json(await fn(req));
      } catch (e) {
        res
          .status(e.status || 502)
          .json({ error: e.status ? e.message : 'WhatsApp returned an unexpected response' });
      }
    };
  router.get('/api/whatsapp/accounts', async (_req, res) => {
    try {
      const { accounts, ...rest } = await service.accounts();
      res.json({ ...rest, accounts: accounts.filter((a) => mine(res, a.id)) });
    } catch (e) {
      res
        .status(e.status || 502)
        .json({ error: e.status ? e.message : 'WhatsApp returned an unexpected response' });
    }
  });
  router.get(
    '/api/whatsapp/accounts/:id',
    handle((req) => service.account(req.params.id)),
  );
  router.post(
    '/api/whatsapp/accounts/:id/start',
    handle((req) => service.start(req.params.id)),
  );
  router.get(
    '/api/whatsapp/accounts/:id/qr',
    handle((req) => service.qr(req.params.id)),
  );
  router.post(
    '/api/whatsapp/accounts/:id/logout',
    handle((req) => service.logout(req.params.id)),
  );
  router.get(
    '/api/whatsapp/accounts/:id/conversations',
    handle((req) => service.conversations(req.params.id, req.query)),
  );
  router.get(
    '/api/whatsapp/accounts/:id/conversations/:chat/messages',
    handle((req) => service.messages(req.params.id, req.params.chat, req.query)),
  );
  router.post(
    '/api/whatsapp/accounts/:id/conversations/:chat/messages',
    handle((req) => service.send(req.params.id, req.params.chat, req.body || {}), 201),
  );
  router.post(
    '/api/whatsapp/accounts/:id/conversations/:chat/read',
    handle((req) => service.markRead(req.params.id, req.params.chat)),
  );
  router.get('/api/whatsapp/accounts/:id/conversations/:chat/messages/:message/media', async (req, res) => {
    const controller = new AbortController();
    res.on('close', () => controller.abort());
    try {
      const upstream = await service.media(
        req.params.id,
        req.params.chat,
        req.params.message,
        controller.signal,
      );
      // Attachments can include HTML or SVG. Clients should download them,
      // then open them in a viewer suitable for the media type.
      res.set('Content-Type', upstream.headers.get('Content-Type') || 'application/octet-stream');
      res.set('Content-Disposition', 'attachment');
      await pipeline(Readable.fromWeb(upstream.body), res);
    } catch (e) {
      if (res.headersSent || res.destroyed) return res.destroy();
      res
        .status(e.status || 502)
        .json({ error: e.status ? e.message : 'WhatsApp media could not be downloaded' });
    }
  });
  return router;
}
