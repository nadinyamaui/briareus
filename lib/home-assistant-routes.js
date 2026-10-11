// @ts-check
import { Router } from 'express';

/** @param {{service: ReturnType<typeof import('./home-assistant.js').createHomeAssistantService>}} deps */
export function homeAssistantRoutes({ service }) {
  const router = Router();
  router.use('/api/home-assistant', (req, res, next) => {
    if (req.headers.authorization)
      return res.status(403).json({ error: 'Home Assistant is reached through /api/v1 with an admin token' });
    res.set('Cache-Control', 'no-store');
    next();
  });
  const handle = (fn) => async (req, res) => {
    try {
      res.json(await fn(req));
    } catch (e) {
      res
        .status(e.status || 502)
        .json({ error: e.status ? e.message : 'Home Assistant returned an unexpected response' });
    }
  };
  router.get(
    '/api/home-assistant',
    handle(() => service.status()),
  );
  router.get(
    '/api/home-assistant/entities',
    handle((req) => service.entities(req.query)),
  );
  router.get(
    '/api/home-assistant/entities/:id',
    handle((req) => service.entity(req.params.id)),
  );
  router.get(
    '/api/home-assistant/services',
    handle(() => service.services()),
  );
  router.post(
    '/api/home-assistant/services/:domain/:service',
    handle((req) => service.callService(req.params.domain, req.params.service, req.body, req.query)),
  );
  router.post(
    '/api/home-assistant/events/:type',
    handle((req) => service.fireEvent(req.params.type, req.body)),
  );
  return router;
}
