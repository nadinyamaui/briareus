// @ts-check
import { Router } from 'express';
import { FORGE_ACCOUNT_DEFAULTS } from './forge-accounts.js';

// The Forge accounts (lib/forge-accounts.js) and proxy (lib/forge.js), reached only
// through /api/v1 with an admin token: an account's token covers every server in its
// organization, site .env files and deploy scripts are production secrets, and an
// account's projects say where it is offered, not who may use it.
export function forgeRoutes({ accounts, client, getProject }) {
  const router = Router();
  // Agent tokens never reach Forge; the gateway strips the header it judged.
  router.use('/api/forge', (req, res, next) => {
    if (req.headers.authorization) return res.status(403).json({ error: 'Forge is reached through /api/v1' });
    next();
  });
  const handle = (fn) => async (req, res) => {
    try {
      res.status(req.method === 'POST' ? 201 : 200).json(await fn(req));
    } catch (e) {
      res.status(e.status || 400).json({ error: e.message });
    }
  };
  const checkProjects = (input) => {
    if (Array.isArray(input.repos)) {
      const unknown = input.repos.find((r) => typeof r === 'string' && r.trim() && !getProject(r.trim()));
      if (unknown) throw new Error(`${unknown} is not a project`);
    }
    return input;
  };

  router.get('/api/forge/accounts', (req, res) => {
    const repo = typeof req.query.repo === 'string' && req.query.repo ? req.query.repo : undefined;
    res.json({ accounts: accounts.list(repo), defaults: FORGE_ACCOUNT_DEFAULTS });
  });
  router.post(
    '/api/forge/accounts',
    handle(async (req) => ({ account: await accounts.create(checkProjects(req.body || {})) })),
  );
  router.put(
    '/api/forge/accounts/:id',
    handle(async (req) => ({
      account: await accounts.update(Number(req.params.id), checkProjects(req.body || {})),
    })),
  );
  router.delete(
    '/api/forge/accounts/:id',
    handle(async (req) => {
      await accounts.remove(Number(req.params.id));
      return { ok: true };
    }),
  );

  const forge = (req) => client(req.params.account);
  router.get(
    '/api/forge/accounts/:account/servers',
    handle((req) => forge(req).servers(req.query.cursor)),
  );
  router.get(
    '/api/forge/accounts/:account/servers/:server/sites',
    handle((req) => forge(req).sites(req.params.server, req.query.cursor)),
  );
  router.get(
    '/api/forge/accounts/:account/servers/:server/sites/:site',
    handle((req) => forge(req).site(req.params.server, req.params.site)),
  );
  router.get(
    '/api/forge/accounts/:account/servers/:server/sites/:site/deployment-script',
    handle((req) => forge(req).deploymentScript(req.params.server, req.params.site)),
  );
  router.put(
    '/api/forge/accounts/:account/servers/:server/sites/:site/deployment-script',
    handle((req) => forge(req).setDeploymentScript(req.params.server, req.params.site, req.body || {})),
  );
  router.get(
    '/api/forge/accounts/:account/servers/:server/sites/:site/env',
    handle((req) => forge(req).environment(req.params.server, req.params.site)),
  );
  router.put(
    '/api/forge/accounts/:account/servers/:server/sites/:site/env',
    handle((req) => forge(req).setEnvironment(req.params.server, req.params.site, req.body || {})),
  );
  return router;
}
