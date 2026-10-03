// @ts-check
import express, { Router } from 'express';
import { SLACK_WORKSPACE_DEFAULTS } from './slack.js';

// The Slack workspaces and the approvals (lib/slack.js) for the operator, and
// the four calls a session's Slack tool makes. The first are reached only
// through /api/v1 with an admin token: a workspace holds a token that writes
// as its owner, and an approval sends a message in their name.
export function slackRoutes({ service, agentSession, getProject }) {
  const router = Router();
  router.use('/api/slack', (req, res, next) => {
    if (req.headers.authorization)
      return res.status(403).json({ error: 'Slack is managed through /api/v1 with an operator token' });
    res.set('Cache-Control', 'no-store');
    next();
  });
  const handle = (fn) => async (req, res) => {
    try {
      res.status(req.method === 'POST' && !req.path.endsWith('/decision') ? 201 : 200).json(await fn(req));
    } catch (e) {
      res.status(e.status || 400).json({ error: e.message });
    }
  };
  const checkProjects = (input) => {
    if (Array.isArray(input.projects)) {
      const unknown = input.projects.find(
        (p) => p && typeof p.repo === 'string' && p.repo.trim() && !getProject(p.repo.trim()),
      );
      if (unknown) throw new Error(`${unknown.repo} is not a project`);
    }
    return input;
  };

  router.get('/api/slack/workspaces', (req, res) => {
    const repo = typeof req.query.repo === 'string' && req.query.repo ? req.query.repo : undefined;
    res.json({ workspaces: service.list(repo), defaults: SLACK_WORKSPACE_DEFAULTS });
  });
  router.post(
    '/api/slack/workspaces',
    handle(async (req) => ({ workspace: await service.create(checkProjects(req.body || {})) })),
  );
  router.put(
    '/api/slack/workspaces/:id',
    handle(async (req) => ({
      workspace: await service.update(Number(req.params.id), checkProjects(req.body || {})),
    })),
  );
  router.delete(
    '/api/slack/workspaces/:id',
    handle(async (req) => {
      await service.remove(Number(req.params.id));
      return { ok: true };
    }),
  );
  router.get('/api/slack/requests', (_req, res) => res.json({ requests: service.pending() }));
  router.post(
    '/api/slack/requests/:id/decision',
    handle(async (req) => ({ request: await service.decide(req.params.id, req.body?.decision) })),
  );

  // The session's own: its token names the session, the session its project,
  // and the project the one workspace and the channels it may use.
  const agent = (fn) => async (req, res) => {
    const job = agentSession(req, res);
    if (!job) return;
    try {
      res.set('Cache-Control', 'no-store');
      res.json(await fn(job, req));
    } catch (e) {
      res.status(e.status || 400).json({ error: e.message });
    }
  };
  router.get(
    '/api/agent/slack/destinations',
    agent((job) => service.destinations(job)),
  );
  router.get(
    '/api/agent/slack/people',
    agent(async (job, req) => ({ people: await service.findPeople(job, req.query.q) })),
  );
  router.post(
    '/api/agent/slack/send',
    agent(async (job, req) => ({ request: await service.request(job, req.body || {}) })),
  );
  router.get(
    '/api/agent/slack/requests/:id',
    agent((job, req) => ({ request: service.result(job, req.params.id) })),
  );
  return router;
}

// Slack's Events API, ahead of the JSON body parser: the signature covers the
// raw bytes. Answered at once (Slack retries anything slower than three
// seconds); routing a reply into a session happens after.
export function slackEventsRouter({ service, log = (m) => console.log(`slack: ${m}`) }) {
  const router = Router();
  router.post('/:id', express.raw({ type: () => true, limit: '1mb' }), (req, res) => {
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');
    const outcome = service.receive(req.params.id, raw, {
      timestamp: req.get('X-Slack-Request-Timestamp'),
      signature: req.get('X-Slack-Signature'),
    });
    if (outcome.status === 401)
      log(`rejected an event for workspace ${req.params.id.slice(0, 20)}: bad signature (${req.ip})`);
    res.status(outcome.status).json(outcome.body);
    outcome.then?.().catch((e) => log(`an event could not be handled: ${e.message}`));
  });
  return router;
}
