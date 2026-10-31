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

// A session acts on what it reads too, and a web page, a repo file or an entity's attributes
// may be someone else's words. So a session never reaches what guards the home or runs Home
// Assistant itself, and never forges Home Assistant's own events; /api/v1 keeps them for the
// user's own clients.
const GUARDED_DOMAINS = new Set([
  'lock',
  'alarm_control_panel',
  'homeassistant',
  'hassio',
  'shell_command',
  'python_script',
  'pyscript',
]);
const CORE_EVENTS = new Set([
  'state_changed',
  'state_reported',
  'call_service',
  'service_registered',
  'service_removed',
  'component_loaded',
  'core_config_updated',
  'logbook_entry',
  'automation_triggered',
  'automation_reloaded',
  'script_started',
  'themes_updated',
  'panels_updated',
  'lovelace_updated',
  'user_added',
  'user_removed',
  'user_updated',
  'tag_scanned',
  'mobile_app_notification_action',
]);
const coreEvent = (type) =>
  type.startsWith('homeassistant_') || type.endsWith('_registry_updated') || CORE_EVENTS.has(type);
const guarded = (message) => Object.assign(new Error(message), { status: 403 });

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
    // A stopped or closing turn controls nothing, even with a request already on its way.
    if (!allowed(job) || job.closing || job.turnCanceled) return res.status(403).json({ error: REFUSED });
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
      const domain = text(req.query.domain, 'domain');
      const { entities } = await service.entities({ domain: domain || undefined });
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
      // Every field of every action is hundreds of KB on a real home: without a domain, only
      // the action names, so the model asks again for the one domain it needs.
      return {
        services: domain
          ? services.filter((s) => s?.domain === domain)
          : services.map((s) => ({ domain: s?.domain, services: Object.keys(s?.services ?? {}) })),
      };
    }),
  );
  router.post(
    '/api/agent/home-assistant/services/:domain/:service',
    handle(async (req, service) => {
      if (GUARDED_DOMAINS.has(req.params.domain))
        throw guarded(`Sessions cannot call ${req.params.domain} actions; the user runs them from a client`);
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
    handle((req, service) => {
      if (coreEvent(req.params.type.trim().toLowerCase()))
        throw guarded("Sessions cannot fire Home Assistant's own events");
      return service.fireEvent(req.params.type, req.body ?? {});
    }),
  );
  return router;
}
