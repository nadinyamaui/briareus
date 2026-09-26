// @ts-check
import { Router } from 'express';
import { memoryHealth, memoryRevision, setMemoryPolicy } from './memory-selection.js';
export function memoryMaintenanceRoutes({ listMemories, updateMemory }) {
  const router = Router();
  router.get('/api/operations/memories', (req, res) =>
    res.json(memoryHealth(listMemories(typeof req.query.repo === 'string' ? req.query.repo : null))),
  );
  router.post('/api/operations/memories/:id', async (req, res) => {
    try {
      const m = listMemories().find((m) => m.id === Number(req.params.id));
      if (!m) return res.status(404).json({ error: 'Memory not found' });
      if (req.body?.revision !== memoryRevision(m))
        return res.status(409).json({ error: 'Memory changed; reload before deciding' });
      res.json({ policy: await setMemoryPolicy(m, req.body.action) });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });
  router.post('/api/operations/memories/merge/apply', async (req, res) => {
    try {
      const { targetId, sourceId, body, revisions } = req.body || {};
      const target = listMemories().find((m) => m.id === Number(targetId));
      const source = listMemories().find((m) => m.id === Number(sourceId));
      if (!target || !source || target.id === source.id || target.repo !== source.repo)
        throw new Error('Choose two memories from the same project');
      if (revisions?.[0] !== memoryRevision(target) || revisions?.[1] !== memoryRevision(source))
        return res.status(409).json({ error: 'Memories changed; reload before merging' });
      // Save the reviewed text first. A failed archive leaves both originals
      // readable, so a partial failure can never silently delete knowledge.
      const memory = await updateMemory(target.id, { body, jobId: null });
      await setMemoryPolicy(source, 'archive');
      res.json({ memory });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });
  return router;
}
