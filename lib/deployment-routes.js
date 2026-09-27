// @ts-check
import { Router } from 'express';
export function deploymentRoutes({ service, getProject, readyForSelfDeploy = () => false }) {
  const router = Router();
  const handle = (fn) => async (req, res) => {
    try {
      const repo = typeof req.query.repo === 'string' ? req.query.repo : '';
      if (!getProject(repo)) return res.status(404).json({ error: 'Project not found' });
      res.json(await fn(repo, req.body || {}));
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  };
  router.get(
    '/api/operations/deployments/config',
    handle((repo) => service.settings(repo)),
  );
  router.get(
    '/api/operations/deployments',
    handle((repo) => service.overview(repo)),
  );
  router.post(
    '/api/operations/deployments/config',
    handle((repo, body) => service.configure(repo, body)),
  );
  router.post(
    '/api/operations/deployments/plan',
    handle((repo) => service.plan(repo)),
  );
  router.post(
    '/api/operations/deployments/dispatch',
    handle((repo, body) => {
      if (getProject(repo).isSelf && !readyForSelfDeploy())
        throw new Error('Drain active work in Maintenance before updating Briareus');
      return service.deploy(repo, body.planId);
    }),
  );
  router.post(
    '/api/operations/deployments/acknowledge',
    handle((repo) => service.acknowledge(repo)),
  );
  return router;
}
