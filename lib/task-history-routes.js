// @ts-check
import { Router } from 'express';
import { taskFamily, taskReport } from './task-history.js';
import { taskSnapshot } from './task-snapshot.js';
import { seesSession } from './ownership.js';

// A task's history, kept after its sessions are deleted. A member reads only the tasks of
// sessions they may see (lib/ownership.js), held to the token's projects like the rest;
// another's answers as missing.
export function taskHistoryRoutes({ loadSnapshots, listSessions, loadUsage, estimateCosts }) {
  const router = Router();
  router.get('/api/operations/tasks/:id', async (req, res) => {
    try {
      const stored = await loadSnapshots(req.params.id);
      const live = listSessions();
      const snapshots = new Map(stored.map((s) => [s.id, s]));
      for (const s of live) snapshots.set(s.id, taskSnapshot(s));
      const repos = res.locals.apiRepos;
      const visible = [...snapshots.values()].filter(
        (s) => (!repos || repos.includes(s.repo)) && seesSession(res.locals.apiUser, s),
      );
      const family = taskFamily(req.params.id, visible);
      const rows = await estimateCosts(await loadUsage(family.sessions.map((s) => s.id)));
      res.json(
        taskReport(
          family,
          rows,
          live.map((s) => s.id),
        ),
      );
    } catch (e) {
      res.status(e.message === 'Task not found' ? 404 : 503).json({ error: e.message });
    }
  });
  return router;
}
