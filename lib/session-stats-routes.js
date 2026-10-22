// @ts-check
import { Router } from 'express';
import { seesSession } from './ownership.js';

// The sampler of lib/session-stats.js over HTTP. A session the sampler does not hold is
// one that is not open (closed, failed, still queued before its first sample): its stats
// are null rather than a 404, since the session itself exists.
// isOpen answers from the job itself, since the sampler drops a closed session only at its
// next tick.
export function sessionStatsRoutes({ stats, getJob, isOpen = (/** @type {any} */ _job) => true }) {
  const router = Router();

  router.get('/api/dev/sessions/:id/stats', (req, res) => {
    const job = getJob(req.params.id);
    if (!job || job.kind !== 'devchat') return res.status(404).json({ error: 'Session not found' });
    const open = isOpen(job);
    res.json({
      stats: open ? stats.get(job.id) : null,
      history: open ? stats.history(job.id) : [],
      host: stats.host(),
    });
  });

  // A project-limited token sees only its projects' sessions (lib/api-v1.js), and a member
  // only the ones they may see (lib/ownership.js), in the list and in the server's session
  // totals alike.
  const inScope = (res) => {
    const repos = res.locals.apiRepos;
    return (id) => {
      const job = getJob(id);
      return (
        !!job && isOpen(job) && (!repos || repos.includes(job.repo)) && seesSession(res.locals.apiUser, job)
      );
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
