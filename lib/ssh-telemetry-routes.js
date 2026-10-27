// @ts-check
import { Router, json } from 'express';

// A machine-to-core ingress, mounted before operator authentication under the
// existing native API Access bypass. Machine tokens cannot reach operator APIs.
export function sshTelemetryRoutes({ ssh, monitor }) {
  const router = Router();
  router.post(
    '/api/v1/telemetry/ssh/:id/samples',
    (req, res, next) => {
      const token = /^Bearer (brm_[A-Za-z0-9_-]{43})$/.exec(req.headers.authorization || '')?.[1] || '';
      const id = Number(req.params.id);
      if (!ssh.authorizeMonitor(id, token))
        return res.status(401).json({ error: 'Invalid monitor credential' });
      res.locals.monitorToken = token;
      next();
    },
    json({ limit: '1mb' }),
    async (req, res) => {
      try {
        const result = await monitor.ingest(
          Number(req.params.id),
          res.locals.monitorToken,
          req.body?.samples,
        );
        res.set('Cache-Control', 'no-store').json(result);
      } catch (error) {
        if (error.status === 429) res.set('Retry-After', '5');
        res
          .status(error.status || 503)
          .json({ error: error.status ? error.message : 'Telemetry storage unavailable' });
      }
    },
  );
  return router;
}
