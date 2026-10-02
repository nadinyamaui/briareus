// @ts-check
import { Router } from 'express';
import { ENVOYER_DEFAULTS } from './envoyer.js';

// The Envoyer accounts' handlers (lib/envoyer.js), reached only through
// /api/v1. Editing the list takes an admin token; reading an account's
// Envoyer projects or deploying names the Briareus project in `repo`, which
// the gateway holds a project-scoped token to and the service checks the
// account against.
export function envoyerRoutes({ service, getProject }) {
  const router = Router();
  // Agent tokens never reach Envoyer; the gateway strips the header it judged.
  router.use('/api/envoyer', (req, res, next) => {
    if (req.headers.authorization)
      return res.status(403).json({ error: 'Envoyer is reached through /api/v1' });
    next();
  });
  const handle =
    (fn, status = 200) =>
    async (req, res) => {
      try {
        res.status(status).json(await fn(req));
      } catch (e) {
        res.status(e.status || 400).json({ error: e.message });
      }
    };
  const checkProject = (input) => {
    if (Object.hasOwn(input, 'repo') && !getProject(input.repo))
      throw new Error('Choose an existing project');
    return input;
  };

  router.get('/api/envoyer/accounts', (_req, res) =>
    res.json({ accounts: service.list(), defaults: ENVOYER_DEFAULTS }),
  );
  router.post(
    '/api/envoyer/accounts',
    handle(async (req) => ({ account: await service.create(checkProject(req.body || {})) }), 201),
  );
  router.put(
    '/api/envoyer/accounts/:id',
    handle(async (req) => ({
      account: await service.update(Number(req.params.id), checkProject(req.body || {})),
    })),
  );
  router.delete(
    '/api/envoyer/accounts/:id',
    handle(async (req) => {
      await service.remove(Number(req.params.id));
      return { ok: true };
    }),
  );

  router.get(
    '/api/envoyer/available',
    handle(async (req) => {
      if (typeof req.query.repo !== 'string' || !req.query.repo) throw new Error('Name a project in `repo`');
      return { accounts: service.list(req.query.repo) };
    }),
  );
  router.get(
    '/api/envoyer/accounts/:id/projects',
    handle((req) => service.projects(req.params.id, req.query.repo)),
  );
  router.get(
    '/api/envoyer/accounts/:id/projects/:project',
    handle((req) => service.project(req.params.id, req.query.repo, req.params.project)),
  );
  router.get(
    '/api/envoyer/accounts/:id/projects/:project/servers',
    handle((req) => service.servers(req.params.id, req.query.repo, req.params.project)),
  );
  router.get(
    '/api/envoyer/accounts/:id/projects/:project/deployments',
    handle((req) => service.deployments(req.params.id, req.query.repo, req.params.project)),
  );
  router.get(
    '/api/envoyer/accounts/:id/projects/:project/deployments/:deployment',
    handle((req) =>
      service.deployment(req.params.id, req.query.repo, req.params.project, req.params.deployment),
    ),
  );
  router.post(
    '/api/envoyer/accounts/:id/projects/:project/deployments',
    handle((req) => service.deploy(req.params.id, req.body || {}, req.params.project)),
  );
  return router;
}
