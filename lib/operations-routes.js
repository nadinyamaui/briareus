// @ts-check
import { Router } from 'express';
import { attentionItems } from './attention.js';

// Mounted behind the browser login and same-origin gates. Internal agent
// bearer tokens never gain operator controls through these endpoints.
export function operationsRoutes({ listSessions, ssh }) {
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
  return router;
}
