// @ts-check
import express from 'express';
import { API_V1_ROUTES } from './api-v1-catalog.js';
import { apiV1OpenApi } from './api-v1-docs.js';

// The client API: the one HTTP surface clients (Briareus Windows, Briareus iOS) talk to.
// Almost every catalog route (lib/api-v1-catalog.js) names a handler on the server's
// router, so a handler fix reaches every client; this gateway decides who may reach it. A
// handler the catalog does not list cannot be reached with a token: the agent routes
// (/api/agent/*) and webhooks are deliberately absent.

const API_V1_PREFIX = '/api/v1';

const RANK = { read: 0, manage: 1, admin: 2 };
const fail = (status, message) => Object.assign(new Error(message), { status });

// How often an open stream rechecks its token. A stream outlives its admission check, so
// a revoked or expired token would otherwise keep reading until it reconnected.
const STREAM_RECHECK_MS = 15_000;

// `handlers` is the router the server's handlers are registered on, which no request
// reaches by itself; a catalog route is answered by handing it the request under the
// handler's path. The rest is what the gateway judges with: the token store
// (lib/mobile-auth.js), the sessions and projects a scope is checked against, and the
// project runtimes a start falls back on.
export function apiV1Routes({
  auth,
  apiEnabled,
  ownerSecret,
  handlers,
  getJob,
  getProject,
  listSessions,
  bus,
  reviewerRuntime = /** @type {(project: object) => any} */ (() => null),
  stepRuntime = /** @type {(project: object, step: string) => any} */ (() => null),
  transcribeAvailable = () => false,
  previewAccess = /** @type {() => object | null} */ (() => null),
  recheckMs = STREAM_RECHECK_MS,
}) {
  const router = express.Router();
  const json = express.json({ limit: '1mb' });
  const raw = express.raw({ type: () => true, limit: '25mb' });

  // Throws unless the request carries a token that stands right now. Called on arrival
  // and again after the body arrives, so a token revoked meanwhile cannot start work.
  const authenticate = (header) => {
    if (!apiEnabled()) throw fail(503, 'Set the API up first: run `npm run create-token` on the server');
    return auth.authenticate(header, ownerSecret());
  };
  // The projects a token is held to, or null for the operator's own.
  const reposOf = (client) => (client.permission === 'admin' ? null : client.repos);

  router.use(async (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    // A browser page is never a client: a token in page script is readable by any
    // injected script, so CORS stays off. A request with an Origin is a browser's.
    if (req.headers.origin)
      throw fail(403, 'Call this API from a server or a native client, not a browser page');
    const header = req.headers.authorization;
    const client = authenticate(header);
    try {
      await auth.recordUsage(client.id);
    } catch (e) {
      // Usage reporting must not turn a valid request into an auth failure.
      console.error('Could not record token usage:', e.message);
    }
    client.lastUsedAt = auth.list().find((d) => d.id === client.id)?.lastUsedAt ?? null;
    res.locals.apiClient = client;
    res.locals.apiToken = header;
    res.locals.apiRepos = reposOf(client);
    next();
  });

  // Ends a stream whose token stopped standing while it was open.
  const guardStream = (res) => {
    const timer = setInterval(() => {
      try {
        authenticate(res.locals.apiToken);
      } catch {
        res.destroy();
      }
    }, recheckMs);
    res.on('close', () => clearInterval(timer));
  };

  // ---- the routes the gateway answers itself ----
  //
  // Catalog entries with `to: null`; the loop below gives them the same permission check
  // and body handling as a handed-on route.
  const own = {
    'client.get': (_req, res) =>
      res.json({ version: 1, client: res.locals.apiClient, transcribe: !!transcribeAvailable() }),
    'openapi.get': (_req, res) => res.json(apiV1OpenApi()),
    'preview.access': (_req, res) => {
      const access = previewAccess();
      if (!access)
        throw fail(404, 'No Cloudflare Access service token is configured for ▶ Run previews on this server');
      res.json(access);
    },
    'token.revoke': async (_req, res) => {
      await auth.revoke(res.locals.apiClient.id);
      res.json({ ok: true });
    },
    // Every session the token can see on one connection, for a client relaying to its
    // own users (the web app's server). Nothing is replayed: a client that dropped reads
    // what it missed from /sessions and /sessions/:id?since=.
    'events.stream': (req, res) => {
      const repos = res.locals.apiRepos;
      const inScope = (repo) => !repos || repos.includes(repo);
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      const send = (name, data) => res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
      for (const session of listSessions()) if (inScope(session.repo)) send('session', session);
      const onJob = (record) => {
        if (record.kind === 'devchat' && inScope(record.repo)) send('session', record);
      };
      const onDeleted = (id, repo) => {
        if (inScope(repo)) send('session.deleted', { id });
      };
      const onEvent = (id, event) => {
        const job = getJob(id);
        if (job && job.kind === 'devchat' && inScope(job.repo)) send('transcript', { sessionId: id, event });
      };
      bus.on('job', onJob);
      bus.on('deleted', onDeleted);
      if (req.query.transcripts === '1') bus.on('event', onEvent);
      const ping = setInterval(() => res.write(': ping\n\n'), 25000);
      guardStream(res);
      res.on('close', () => {
        clearInterval(ping);
        bus.off('job', onJob);
        bus.off('deleted', onDeleted);
        bus.off('event', onEvent);
      });
    },
  };

  for (const entry of API_V1_ROUTES) {
    const admit = (_req, res, next) => {
      const client = res.locals.apiClient;
      // A permission this version does not know is refused: comparing with `<` is false
      // for it.
      if (!(RANK[client.permission] >= RANK[entry.access]))
        throw fail(
          403,
          entry.access === 'admin' ? 'This needs an admin token' : 'This token has read-only access',
        );
      next();
    };
    const dispatch = (req, res, next) => {
      const client = authenticate(res.locals.apiToken);
      const repos = reposOf(client);
      const reads = entry.method === 'GET' || entry.method === 'DELETE';
      const query = new URLSearchParams(req.url.split('?')[1] || '');
      if (!reads && (!req.body || typeof req.body !== 'object' || Buffer.isBuffer(req.body)) && !entry.raw)
        req.body = {};
      if (!entry.to) return own[entry.id](req, res, next);
      for (const [param, name] of Object.entries(entry.params || {})) {
        if (reads) query.set(name, String(req.params[param]));
        else req.body[name] = req.params[param];
      }
      for (const [name, value] of Object.entries(entry.set || {})) query.set(name, String(value));

      if (repos && entry.scope === 'repo') {
        // Exactly one: a repeated `repo` would reach the handler as a list, and which
        // entry it reads is not this check's to guess.
        const named = reads ? query.getAll('repo') : [req.body.repo];
        const repo = named.length === 1 ? named[0] : null;
        // Same answer for a missing project and one not granted, so a token cannot
        // enumerate the server's projects by guessing.
        if (typeof repo !== 'string' || !repos.includes(repo))
          throw fail(403, 'Name one of this token’s projects in `repo`');
      }
      if (repos && entry.scope === 'session') {
        const job = getJob(String(req.params.id));
        if (!job || job.kind !== 'devchat' || !repos.includes(job.repo)) throw fail(404, 'Session not found');
      }
      if (entry.runtime && req.body.provider == null) {
        if (req.body.model != null || req.body.effort != null)
          throw fail(400, 'A model or effort needs its provider');
        const project = getProject(req.body.repo || '');
        const step = { 'test-sheet': 'testSheet', 'test-run': 'testRun' }[req.body.action];
        const runtime = project && ((step && stepRuntime(project, step)) || reviewerRuntime(project));
        if (project && !runtime)
          throw fail(
            400,
            'Name a provider, or choose a review provider and model in this project’s Settings',
          );
        if (runtime)
          Object.assign(req.body, {
            provider: runtime.providerId,
            model: runtime.model,
            effort: runtime.effort,
          });
      }

      // What handlers read instead of a credential: which projects a list is cut down
      // to, and who authored a change.
      res.locals.apiRepos = repos;
      res.locals.apiActor = `API client ${client.label}`;
      // The token is spent here. The operator's handlers refuse any request still
      // carrying Authorization (that keeps an agent's session token out); this request's
      // authority is the check above.
      delete req.headers.authorization;
      if (entry.stream) guardStream(res);
      const path = entry.to.replace(/[:*](\w+)/g, (_, name) =>
        [req.params[name]].flat().map(encodeURIComponent).join('/'),
      );
      const search = query.toString();
      req.url = search ? `${path}?${search}` : path;
      handlers(req, res, next);
    };
    router[entry.method.toLowerCase()](entry.path, admit, entry.raw ? raw : json, dispatch);
  }

  router.use((_req, res) => res.status(404).json({ error: 'Unknown API route' }));
  router.use((err, req, res, _next) => {
    if (res.headersSent) return res.destroy();
    const known = err.status || err.statusCode;
    const status = known || 500;
    if (status === 401) res.set('WWW-Authenticate', 'Bearer realm="briareus"');
    if (status >= 500) console.error(`${req.method} ${req.originalUrl} failed:`, err);
    // An error with no status was unexpected: its text is for the log, not the caller.
    const message = known ? err.message || 'Server error' : 'Server error';
    res.status(status).json({ error: err.type === 'entity.parse.failed' ? 'Invalid JSON' : message });
  });

  const root = express.Router();
  root.use(API_V1_PREFIX, router);
  return root;
}
