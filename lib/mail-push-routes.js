// @ts-check
import express, { Router } from 'express';
import { MAIL_PUSH_PATH } from './mail.js';

// Mounted before API authentication: each provider proves its own delivery secret.
export function mailPushRoutes({ service }) {
  const router = Router();
  router.post(`${MAIL_PUSH_PATH}/outlook`, express.text({ type: '*/*', limit: '256kb' }), (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (typeof req.query.validationToken === 'string')
      return res.type('text/plain').status(200).send(req.query.validationToken);
    try {
      service.outlookNotification(JSON.parse(req.body));
      res.sendStatus(202);
    } catch (e) {
      res.status(e.status || 400).json({ error: e.message });
    }
  });
  router.post(`${MAIL_PUSH_PATH}/gmail`, express.json({ limit: '256kb' }), (req, res) => {
    try {
      service.gmailNotification(req.body, String(req.query.token || ''));
      res.sendStatus(204);
    } catch (e) {
      res.status(e.status || 400).json({ error: e.message });
    }
  });
  return router;
}
