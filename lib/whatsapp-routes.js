// @ts-check
import { Router } from 'express';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

/** @param {{ service: ReturnType<typeof import('./whatsapp.js').createWhatsAppService> }} deps */
export function whatsappRoutes({ service }) {
  const router = Router();
  router.use('/api/whatsapp', (req, res, next) => {
    if (req.headers.authorization)
      return res.status(403).json({ error: 'WhatsApp is reached through /api/v1 with an admin token' });
    res.set('Cache-Control', 'no-store');
    next();
  });
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
  router.get(
    '/api/whatsapp/accounts',
    handle(() => service.accounts()),
  );
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
