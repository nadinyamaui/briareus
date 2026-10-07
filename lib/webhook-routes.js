// @ts-check
import { Router } from 'express';

// A session's webhook as its operator sets it: URL, key and the caps its turns run under
// (settings in lib/jobs.js, deliveries in lib/webhooks.js). Reached only through /api/v1
// with an operator token: an agent's session token must not read a key that puts words in
// a session's mouth, or arm a webhook for itself.
export function sessionWebhookRoutes({ state, update, rotate, url, key }) {
  const router = Router();
  router.use('/api/dev/sessions/:id/webhook', (req, res, next) => {
    if (req.headers.authorization)
      return res
        .status(403)
        .json({ error: 'A session’s webhook is managed through /api/v1 with an operator token' });
    res.set('Cache-Control', 'no-store');
    next();
  });
  // A disabled webhook's key opens nothing, so it is not handed out until the webhook is
  // on; the same goes for the instructions webhook's own URL and key.
  const view = async (id, webhook) => {
    const instructed = webhook.armed && webhook.instructions;
    return {
      ...webhook,
      url: url(id),
      key: webhook.armed ? await key(id, webhook.epoch) : null,
      instructionsUrl: url(id, 'instructions'),
      instructionsKey: instructed ? await key(id, webhook.epoch, 'instructions') : null,
    };
  };
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
