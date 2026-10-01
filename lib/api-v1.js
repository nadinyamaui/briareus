// @ts-check
import express from 'express';
import { API_V1_ROUTES } from './api-v1-catalog.js';
import { apiV1OpenApi } from './api-v1-docs.js';

// The client API: the one HTTP surface a client talks to (Briareus Windows
// and Briareus iOS, each in a repo of its own). It adds almost no handlers of
// its own: every route in the catalog (lib/api-v1-catalog.js) names a handler
// on the server's router, by the path the built-in dashboard used to call it
// at, and this gateway decides who may reach it. So a fix to a handler is a
// fix for every client at once.
//
// A handler the catalog does not list cannot be reached with a token at all:
// the agent's own routes (/api/agent/*) and the webhooks are deliberately
// absent.

const API_V1_PREFIX = '/api/v1';

const RANK = { read: 0, manage: 1, admin: 2 };
const fail = (status, message) => Object.assign(new Error(message), { status });

// How often an open stream asks whether its token still stands. A stream is
// the one request that outlives the check made when it was admitted, so a
// revoked or expired token would otherwise keep reading until it reconnected.
const STREAM_RECHECK_MS = 15_000;

// `handlers` is the router the server's handlers are registered on, which no
// request reaches by itself; a catalog route is answered by handing it the
// request under the handler's path. The rest is what the gateway needs to judge a request: the token
// store (lib/mobile-auth.js), the sessions and projects a scope is checked
// against, and the project runtimes a start falls back on.
export function apiV1Routes({
  auth,
  apiEnabled,
  ownerSecret,
  handlers,
  getJob,
  getProject,
  listProjects,
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

  // Throws unless the request carries a token that stands right now. Called
  // when a request arrives and again once its body has: a body can take a
  // while, and a token revoked meanwhile must not start work.
  const authenticate = (header) => {
    if (!apiEnabled()) throw fail(503, 'Set the API up first: run `npm run create-token` on the server');
    return auth.authenticate(header, ownerSecret());
  };
  // The projects a token is held to, or null for the operator's own.
  const reposOf = (client) => (client.permission === 'admin' ? null : client.repos);

  router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    // A browser page is never a client of this API: a token in page script is
    // a token any injected script can read, so CORS stays off and the web app
    // calls from its server. A request that names an Origin is a browser's.
    if (req.headers.origin)
      throw fail(403, 'Call this API from a server or a native client, not a browser page');
    const header = req.headers.authorization;
    const client = authenticate(header);
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
  // Each is in the catalog with no handler path (`to: null`), which is what
  // sends it here; the loop below gives every one of them the same permission
  // check and body handling a handed-on route gets.
  const projectChoices = () => listProjects().map(({ repo, label }) => ({ repo, label }));
  const existingRepos = (repos) => {
    if (!Array.isArray(repos) || repos.some((repo) => typeof repo !== 'string' || !getProject(repo)))
      throw fail(400, 'Select existing projects');
  };
  // The stores throw plain errors for what a client got wrong. One that
  // carries a code was raised by the database driver or by Node, not by a
  // store's own check, and is the server's failure; the one exception is the
  // address a client sent that would not parse as a URL.
  const refused = (fn) => async (req, res) => {
    try {
      await fn(req, res);
    } catch (e) {
      throw e.status || (e.code && e.code !== 'ERR_INVALID_URL') ? e : fail(400, e.message);
    }
  };
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
    // Every session the token can see, on one connection: what a client that
    // relays to its own users (the web app's server) holds open instead of one
    // stream per conversation. Nothing here is replayed: a client that dropped
    // reads what it missed from /sessions and /sessions/:id?since=.
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
    // Tokens. An admin token is the operator's own, so it manages these; a
    // token it issues is one more entry in the same list, to be revoked like
    // any other.
    'settings.devices.list': (_req, res) => res.json({ devices: auth.list(), projects: projectChoices() }),
    'settings.devices.create': refused(async (req, res) => {
      existingRepos(req.body.permission === 'admin' ? [] : req.body.repos);
      res.status(201).json(await auth.create(req.body, ownerSecret()));
    }),
    'settings.devices.delete': async (req, res) => {
      await auth.revoke(req.params.id);
      res.json({ ok: true });
    },
  };

  for (const entry of API_V1_ROUTES) {
    const admit = (_req, res, next) => {
      const client = res.locals.apiClient;
      // Written so that a permission this version does not know is refused
      // rather than waved through: comparing with `<` is false for it.
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
        // Exactly one: a second `repo` in the query would reach the handler
        // as a list, and which entry it then reads is not this check's to
        // guess.
        const named = reads ? query.getAll('repo') : [req.body.repo];
        const repo = named.length === 1 ? named[0] : null;
        // The same answer for a project that does not exist and one this
        // token was not given, so a token cannot list the server's projects
        // by guessing at them.
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

      // What the handlers read instead of a credential: which projects a list
      // is cut down to, and who to name as the author of a change.
      res.locals.apiRepos = repos;
      res.locals.apiActor = `API client ${client.label}`;
      // The token has been judged and is spent here. The operator's handlers
      // refuse any request still carrying an Authorization header, which is
      // how they keep an agent's session token out; this request's authority
      // is the check above, not the header.
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
    // An error nobody gave a status is one nobody expected: its text is for
    // the log above, not for the caller.
    const message = known ? err.message || 'Server error' : 'Server error';
    res.status(status).json({ error: err.type === 'entity.parse.failed' ? 'Invalid JSON' : message });
  });

  const root = express.Router();
  root.use(API_V1_PREFIX, router);
  return root;
}
