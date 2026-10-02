// @ts-check
import { Router } from 'express';

// The Forge proxy's handlers (lib/forge.js). Each is reached only through
// /api/v1 with an admin token: a site's .env and deployment script are
// production secrets, and no project scope covers a Forge server.
export function forgeRoutes({ client }) {
  const router = Router();
  // Agent tokens never reach Forge; the gateway strips the header it judged.
  router.use('/api/forge', (req, res, next) => {
    if (req.headers.authorization) return res.status(403).json({ error: 'Forge is reached through /api/v1' });
    next();
  });
  const handle = (fn) => async (req, res) => {
    try {
      res.json(await fn(req));
    } catch (e) {
      res.status(e.status || 400).json({ error: e.message });
    }
  };
  router.get(
    '/api/forge/servers',
    handle((req) => client.servers(req.query.cursor)),
  );
  router.get(
    '/api/forge/servers/:server/sites',
    handle((req) => client.sites(req.params.server, req.query.cursor)),
  );
  router.get(
    '/api/forge/servers/:server/sites/:site',
    handle((req) => client.site(req.params.server, req.params.site)),
  );
  router.get(
    '/api/forge/servers/:server/sites/:site/deployment-script',
    handle((req) => client.deploymentScript(req.params.server, req.params.site)),
  );
  router.put(
    '/api/forge/servers/:server/sites/:site/deployment-script',
    handle((req) => client.setDeploymentScript(req.params.server, req.params.site, req.body || {})),
  );
  router.get(
    '/api/forge/servers/:server/sites/:site/env',
    handle((req) => client.environment(req.params.server, req.params.site)),
  );
  router.put(
    '/api/forge/servers/:server/sites/:site/env',
    handle((req) => client.setEnvironment(req.params.server, req.params.site, req.body || {})),
  );
  return router;
}
