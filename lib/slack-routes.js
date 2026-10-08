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
      const creates = req.method === 'POST' && !req.path.endsWith('/decision') && !req.path.endsWith('/read');
      res.status(creates ? 201 : 200).json(await fn(req));
    } catch (e) {
      if (e.retryAfter) res.set('Retry-After', String(e.retryAfter));
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

  // First-class operator inbox. These calls need no project or session, and
  // the gateway admits only admin clients: an inbox may include private DMs
  // unrelated to any project. Human-written messages send immediately.
  router.get('/api/slack/inbox/workspaces', (_req, res) => res.json({ workspaces: service.list() }));
  const inbox = service.inbox;
  router.get(
    '/api/slack/inbox/:id/conversations',
    handle((req) => inbox.conversations(req.params.id, req.query)),
  );
  router.get(
    '/api/slack/inbox/:id/people',
    handle((req) => inbox.people(req.params.id, req.query)),
  );
  router.post(
    '/api/slack/inbox/:id/direct-messages',
    handle((req) => inbox.openDirectMessage(req.params.id, req.body || {})),
  );
  router.get(
    '/api/slack/inbox/:id/conversations/:channel',
    handle((req) => inbox.conversation(req.params.id, req.params.channel)),
  );
  router.get(
    '/api/slack/inbox/:id/conversations/:channel/messages',
    handle((req) => inbox.messages(req.params.id, req.params.channel, req.query)),
  );
  router.get(
    '/api/slack/inbox/:id/conversations/:channel/threads/:ts',
    handle((req) => inbox.messages(req.params.id, req.params.channel, req.query, req.params.ts)),
  );
  router.post(
    '/api/slack/inbox/:id/conversations/:channel/messages',
    handle((req) => inbox.send(req.params.id, req.params.channel, req.body || {})),
  );
  router.post(
    '/api/slack/inbox/:id/conversations/:channel/read',
    handle(async (req) => {
      // This updates a read position; it does not create a resource.
      await inbox.markRead(req.params.id, req.params.channel, req.body || {});
      return { ok: true };
    }),
  );
  router.get('/api/slack/inbox/:id/events', (req, res) => {
    let subscription;
    try {
      subscription = inbox.subscribe(req.params.id, (name, data) => {
        // A slow/disconnected client reloads Slack's authoritative history
        // when reconnecting, rather than accumulating an unbounded queue.
        if (res.writableLength > 1024 * 1024) return res.destroy();
        res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
        if (name === 'workspace.removed' || name === 'workspace.changed') res.end();
      });
    } catch (e) {
      return res.status(e.status || 400).json({ error: e.message });
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(`event: ready\ndata: ${JSON.stringify(subscription.ready)}\n\n`);
    const ping = setInterval(() => res.write(': ping\n\n'), 25000);
    res.on('close', () => {
      clearInterval(ping);
      subscription.close();
    });
  });

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
