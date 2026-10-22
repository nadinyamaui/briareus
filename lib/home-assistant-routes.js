// @ts-check
import { Router } from 'express';

// Each user's own Home Assistant (lib/users.js): `serviceFor` answers the service for the
// user /api/v1 resolved the token to, connected to their home and no one else's.
/**
 * @typedef {ReturnType<typeof import('./home-assistant.js').createHomeAssistantService>} HomeAssistant
 * @param {{ service?: HomeAssistant, serviceFor?: (user: any) => HomeAssistant }} deps
 */
export function homeAssistantRoutes({ service, serviceFor = () => /** @type {HomeAssistant} */ (service) }) {
  const router = Router();
  router.use('/api/home-assistant', (req, res, next) => {
    if (req.headers.authorization)
      return res.status(403).json({ error: 'Home Assistant is reached through /api/v1' });
    if (!res.locals.apiUser) return res.status(401).json({ error: 'Call this with a token' });
    res.set('Cache-Control', 'no-store');
    res.locals.homeAssistant = serviceFor(res.locals.apiUser);
    next();
  });
  const handle = (fn) => async (req, res) => {
    try {
      const service = res.locals.homeAssistant;
      res.json(await fn(req, service));
    } catch (e) {
      res
        .status(e.status || 502)
        .json({ error: e.status ? e.message : 'Home Assistant returned an unexpected response' });
    }
  };
  router.get(
    '/api/home-assistant',
    handle((_req, service) => service.status()),
  );
  router.get(
    '/api/home-assistant/entities',
    handle((req, service) => service.entities(req.query)),
  );
  router.get(
    '/api/home-assistant/entities/:id',
    handle((req, service) => service.entity(req.params.id)),
  );
  router.get(
    '/api/home-assistant/services',
    handle((_req, service) => service.services()),
  );
  router.post(
    '/api/home-assistant/services/:domain/:service',
    handle((req, service) => service.callService(req.params.domain, req.params.service, req.body, req.query)),
  );
  router.post(
    '/api/home-assistant/events/:type',
    handle((req, service) => service.fireEvent(req.params.type, req.body)),
  );
  return router;
}
