// @ts-check
import { Router } from 'express';
import { assertAcceptingWork, inspectRecovery, maintenanceState, setDraining } from './recovery.js';
import { attentionItems } from './attention.js';

// Mounted behind the browser login and same-origin gates. Internal agent
// bearer tokens never gain operator controls through these endpoints.
export function operationsRoutes({ listSessions, ssh, getJob, sendMessage }) {
  const router = Router();
  router.use('/api/operations', (req, res, next) => {
    if (req.headers.authorization)
      return res.status(403).json({ error: 'Use the dashboard for operator actions' });
    res.set('Cache-Control', 'no-store');
    next();
  });
  router.get('/api/operations/attention', (_req, res) => {
    res.json({ items: attentionItems(listSessions(), ssh.pending()) });
  });
  router.get('/api/operations/maintenance', (_req, res) =>
    res.json(maintenanceState(listSessions(), ssh.runningCount())),
  );
  router.post('/api/operations/maintenance', (req, res) => {
    if (typeof req.body?.draining !== 'boolean')
      return res.status(400).json({ error: 'Choose whether to drain work' });
    setDraining(req.body.draining);
    res.json(maintenanceState(listSessions(), ssh.runningCount()));
  });
  router.get('/api/operations/recovery/:id', async (req, res) => {
    try {
      res.json(await inspectRecovery(getJob(req.params.id), listSessions()));
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });
  router.post('/api/operations/recovery/:id', async (req, res) => {
    try {
      assertAcceptingWork();
      const report = await inspectRecovery(getJob(req.params.id), listSessions());
      if (!report.canResume || report.fingerprint !== req.body?.fingerprint)
        return res
          .status(409)
          .json({ error: 'Workspace changed or is unavailable; reload the recovery report' });
      res.json({
        session: sendMessage(
          req.params.id,
          'Resume the interrupted task from the existing conversation. First inspect the working files, last commit, PR and pending ' +
            report.phase +
            ' phase. Preserve unfinished changes, verify which external actions already happened, and continue only the remaining work; do not repeat a completed push, merge or deployment.',
        ),
      });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });
  return router;
}
