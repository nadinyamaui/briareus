// @ts-check
import { Router } from 'express';

// The sampler of lib/session-stats.js over HTTP. A session the sampler does not hold is
// one that is not open (closed, failed, still queued before its first sample): its stats
// are null rather than a 404, since the session itself exists.
export function sessionStatsRoutes({ stats, getJob }) {
  const router = Router();

  router.get('/api/dev/sessions/:id/stats', (req, res) => {
    const job = getJob(req.params.id);
    if (!job || job.kind !== 'devchat') return res.status(404).json({ error: 'Session not found' });
    res.json({ stats: stats.get(job.id), history: stats.history(job.id), host: stats.host() });
  });

  // A project-limited token sees only its projects' sessions (lib/api-v1.js), in the list
  // and in the server's session totals alike.
  const inScope = (res) => {
    const repos = res.locals.apiRepos;
    return (id) => {
      const job = getJob(id);
      return !!job && (!repos || repos.includes(job.repo));
    };
  };

  router.get('/api/dev/stats/sessions', (_req, res) => {
    res.json({ host: stats.host(), sessions: stats.list(inScope(res)) });
  });

  router.get('/api/dev/stats/server', (_req, res) => {
    res.json(stats.server(inScope(res)));
  });

  return router;
}
