// @ts-check
import { Router } from 'express';

// A session's webhook as its operator sees and sets it: where a sender posts,
// the key it proves itself with, and the caps the turns it starts run under
// (lib/jobs.js holds the settings, lib/webhooks.js takes the deliveries).
//
// Mounted behind the browser login and same-origin gates, and not dashboard
// actions: neither an agent's session token nor a remote connection may read a
// key that lets it put words in a session's mouth, or arm a webhook for
// itself.
export function sessionWebhookRoutes({ state, update, rotate, url, key }) {
  const router = Router();
  router.use('/api/dev/sessions/:id/webhook', (req, res, next) => {
    if (req.headers.authorization)
      return res.status(403).json({ error: 'Use the dashboard to manage a session’s webhook' });
    res.set('Cache-Control', 'no-store');
    next();
  });
  // The key of a webhook that is off opens nothing, so it is not handed out
  // before there is a reason to hold it.
  const view = async (id, webhook) => ({
    ...webhook,
    url: url(id),
    key: webhook.armed ? await key(id, webhook.epoch) : null,
  });
  const handle = (fn) => async (req, res) => {
    try {
      res.json(await view(req.params.id, await fn(req.params.id, req.body || {})));
    } catch (e) {
      res.status(e.message === 'Session not found' ? 404 : 400).json({ error: e.message });
    }
  };
  router.get(
    '/api/dev/sessions/:id/webhook',
    handle((id) => state(id)),
  );
  router.put(
    '/api/dev/sessions/:id/webhook',
    handle((id, body) => update(id, body)),
  );
  router.post(
    '/api/dev/sessions/:id/webhook/rotate',
    handle((id) => rotate(id)),
  );
  return router;
}
