// @ts-check
import express, { Router } from 'express';
import { Readable } from 'node:stream';
import { MCP_SERVER_DEFAULTS, MCP_OAUTH_CALLBACK_PATH } from './mcp-servers.js';

const handle = (fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message });
  }
};

// The operator's routes, reached through /api/v1 with an admin token.
export function mcpRoutes({ service, getProject }) {
  const router = Router();
  // Agent tokens never authorize registering a server, nor read its list.
  router.use('/api/mcp', (req, res, next) => {
    if (req.headers.authorization)
      return res
        .status(403)
        .json({ error: 'MCP servers are managed through /api/v1 with an operator token' });
    next();
  });
  const checkProjects = (input) => {
    for (const repo of Array.isArray(input.repos) ? input.repos : [])
      if (!getProject(repo)) throw new Error(`${repo} is not a project`);
    return input;
  };
  router.get('/api/mcp/servers', (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ servers: service.list(), defaults: MCP_SERVER_DEFAULTS });
  });
  router.post(
    '/api/mcp/servers',
    handle(async (req, res) =>
      res.status(201).json({ server: await service.create(checkProjects(req.body || {})) }),
    ),
  );
  router.put(
    '/api/mcp/servers/:id',
    handle(async (req, res) =>
      res.json({ server: await service.update(Number(req.params.id), checkProjects(req.body || {})) }),
    ),
  );
  router.delete(
    '/api/mcp/servers/:id',
    handle(async (req, res) => {
      await service.remove(Number(req.params.id));
      res.json({ ok: true });
    }),
  );
  router.post(
    '/api/mcp/servers/:id/connect',
    handle(async (req, res) =>
      res.json({
        server: await service.connect(Number(req.params.id), { signIn: req.body?.signIn === true }),
      }),
    ),
  );
  router.post(
    '/api/mcp/servers/:id/finish-sign-in',
    handle(async (req, res) =>
      res.json({ server: await service.finishSignIn(Number(req.params.id), req.body?.url) }),
    ),
  );
  return router;
}

// What a session's request may carry on to the remote, and what of the
// answer comes back: the Streamable HTTP transport's own headers. Never the
// session's token, and never a WWW-Authenticate, which would send the CLI off
// to sign in by itself against a server it only knows through this proxy.
const REQUEST_HEADERS = ['accept', 'content-type', 'mcp-session-id', 'mcp-protocol-version', 'last-event-id'];
const RESPONSE_HEADERS = ['content-type', 'mcp-session-id', 'cache-control'];

// A session's remote MCP server, through this server: the session's token in,
// the remote's credentials (fresh) out. Ahead of the JSON body parser, so the
// body goes on as the bytes the CLI sent.
export function mcpProxyRouter({ service, agentSession, fetchImpl = fetch }) {
  const router = Router();
  router.all(
    '/api/agent/mcp/:id',
    express.raw({ type: () => true, limit: '4mb' }),
    handle(async (req, res) => {
      const job = agentSession(req, res);
      if (!job) return;
      const id = Number(req.params.id);
      const body = Buffer.isBuffer(req.body) && req.body.length ? req.body : undefined;
      const headers = {};
      for (const h of REQUEST_HEADERS) if (req.headers[h]) headers[h] = req.headers[h];
      const abort = new AbortController();
      res.on('close', () => abort.abort());
      const send = (target) =>
        fetchImpl(target.url, {
          method: req.method,
          headers: { ...headers, ...target.headers },
          body,
          signal: abort.signal,
        });
      let target = await service.upstream(id, job.repo);
      let up = await send(target);
      // A token the remote revoked before its time: one refresh, one retry.
      if (up.status === 401 && target.oauth) {
        await up.body?.cancel().catch(() => {});
        target = await service.upstream(id, job.repo, {
          force: true,
          rejectedBearer: target.headers.Authorization,
        });
        up = await send(target);
      }
      res.status(up.status);
      for (const h of RESPONSE_HEADERS) {
        const v = up.headers.get(h);
        // setHeader, not set: Express would add a charset to the content type.
        if (v) res.setHeader(h, v);
      }
      if (!up.body) return res.end();
      const stream = Readable.fromWeb(/** @type {any} */ (up.body));
      stream.on('error', () => res.destroy());
      stream.pipe(res);
    }),
  );
  return router;
}

// Where the provider sends the browser after the sign-in. Plain text, since
// what reads it is a person in a browser tab and nothing here is a page.
export function mcpOAuthCallbackRouter({ service }) {
  const router = Router();
  router.get(MCP_OAUTH_CALLBACK_PATH, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.type('text/plain; charset=utf-8');
    try {
      const server = await service.complete(req.query);
      res.send(
        server.status === 'ready'
          ? `${server.label} is connected to Briareus. Sessions get its tools from their next turn. You can close this tab.`
          : `Signed in to ${server.label}, but it is not working yet: ${server.error}`,
      );
    } catch (e) {
      res.status(e.status && e.status < 500 ? e.status : 502).send(e.message);
    }
  });
  return router;
}
