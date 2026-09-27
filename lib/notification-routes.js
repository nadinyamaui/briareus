// @ts-check
import { Router } from 'express';
export function notificationRoutes({ service, getProject }) {
  const router = Router();
  const handle = (fn) => async (req, res) => {
    try {
      res.json(await fn(req.body || {}));
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  };
  router.get('/api/operations/notifications', (_req, res) => res.json(service.status()));
  router.post(
    '/api/operations/notifications/config',
    handle((body) => service.configure(body.contact)),
  );
  router.post(
    '/api/operations/notifications/subscribe',
    handle((body) => {
      if (!Array.isArray(body.repos) || body.repos.some((repo) => !getProject(repo)))
        throw new Error('Choose existing projects');
      return service.subscribe(body.subscription, body.repos);
    }),
  );
  router.post(
    '/api/operations/notifications/unsubscribe',
    handle((body) => service.unsubscribe(body.endpoint)),
  );
  return router;
}
