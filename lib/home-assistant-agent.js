// @ts-check
// A user's Home Assistant for their project sessions, behind its own per-project opt-in like
// mail, WhatsApp and printing. A service call switches something real in someone's home, so
// only the interactive chats the operator's inboxes reach (operatorInboxSession) get it: never
// review, QA, workers or a turn nobody is watching. A session reaches its inbox owner's home
// and no one else's: the one they connected (PUT /me/home-assistant), or for the original
// operator the server's own from .env, the same resolution /api/v1/home-assistant makes.
import { Router } from 'express';
import { operatorInboxSession } from './mail-agent.js';

const REFUSED =
  'Home Assistant requires an interactive session in a project with Home Assistant tools enabled';

export function homeAssistantSessionAllowed(job, project) {
  return project?.homeAssistantToolsEnabled === true && operatorInboxSession(job, project);
}

// A home lists hundreds of entities, each with a dozen attributes; the list keeps what a
// model needs to pick one, and ha_entity reads the attributes of the one it picked.
const brief = (/** @type {any} */ e) => ({ id: e.id, name: e.name, state: e.state });

/**
 * @typedef {ReturnType<typeof import('./home-assistant.js').createHomeAssistantService>} HomeAssistant
 * @param {{
 *   serviceFor: (job: any) => HomeAssistant,
 *   agentSession: (req: any, res: any) => any,
 *   getProject: (repo: string) => any,
 * }} deps
 */
export function homeAssistantAgentRoutes({ serviceFor, agentSession, getProject }) {
  const router = Router();
  const allowed = (job) => homeAssistantSessionAllowed(job, getProject(job.repo));
  router.use('/api/agent/home-assistant', (req, res, next) => {
    const job = agentSession(req, res);
    if (!job) return;
    if (!allowed(job)) return res.status(403).json({ error: REFUSED });
    res.set('Cache-Control', 'no-store');
    res.locals.homeAssistant = serviceFor(job);
    next();
  });
  const handle = (fn) => async (req, res) => {
    try {
      res.json(await fn(req, res.locals.homeAssistant));
    } catch (e) {
      res
        .status(e.status || 502)
        .json({ error: e.status ? e.message : 'Home Assistant returned an unexpected response' });
    }
  };
  const text = (value, name) => {
    if (value === undefined) return '';
    if (typeof value !== 'string') throw Object.assign(new Error(`${name} must be text`), { status: 400 });
    return value.trim().toLowerCase();
  };

  router.get(
    '/api/agent/home-assistant',
    handle((_req, service) => service.status()),
  );
  router.get(
    '/api/agent/home-assistant/entities',
    handle(async (req, service) => {
      const search = text(req.query.search, 'search');
      const { entities } = await service.entities({ domain: req.query.domain });
      return {
        entities: entities
          .filter((e) => !search || e.id.includes(search) || e.name.toLowerCase().includes(search))
          .map(brief),
      };
    }),
  );
  router.get(
    '/api/agent/home-assistant/entities/:id',
    handle((req, service) => service.entity(req.params.id)),
  );
  router.get(
    '/api/agent/home-assistant/services',
    handle(async (req, service) => {
      const domain = text(req.query.domain, 'domain');
      const { services } = await service.services();
      return { services: domain ? services.filter((s) => s?.domain === domain) : services };
    }),
  );
  router.post(
    '/api/agent/home-assistant/services/:domain/:service',
    handle(async (req, service) => {
      const result = await service.callService(
        req.params.domain,
        req.params.service,
        req.body ?? {},
        req.query,
      );
      return { ...result, entities: result.entities.map(brief) };
    }),
  );
  router.post(
    '/api/agent/home-assistant/events/:type',
    handle((req, service) => service.fireEvent(req.params.type, req.body ?? {})),
  );
  return router;
}
