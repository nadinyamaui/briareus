// @ts-check
import express from 'express';

const PREFIX = '/api/mobile/v1';
const fail = (status, message) => Object.assign(new Error(message), { status });

// Mounted before browser auth, but ONLY under this dedicated prefix. The
// terminal 404 prevents a mobile request falling through to cookie auth.
// transcribe and transcribeAvailable are lib/transcribe.js's, handed in so
// the routes do not read the server's configuration themselves.
export function mobileApiRoutes({
  auth,
  dashboard,
  loginEnabled,
  ownerSecret,
  transcribe = /** @type {(audio: Buffer, opts?: object) => Promise<string>} */ (
    async () => {
      throw fail(503, 'Voice notes are off on this server');
    }
  ),
  transcribeAvailable = () => false,
  // Every project's repo, for an admin token: it carries no project list of
  // its own (lib/mobile-auth.js) and the operations are checked against one.
  allRepos = () => [],
}) {
  const router = express.Router();
  router.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });
  router.use((req, res, next) => {
    // A native client has no Origin. This API does not enable browser CORS or
    // accept dashboard cookies, even if the request also presents a token.
    if (req.headers.origin) throw fail(403, 'Use a native client without an Origin header');
    if (!loginEnabled()) throw fail(503, 'Configure dashboard login before using the mobile API');
    res.locals.device = auth.authenticate(req.headers.authorization, ownerSecret());
    next();
  });
  router.use(express.json({ limit: '1mb' }));
  const operations = () =>
    dashboard.tools().map(({ name, description, inputSchema, annotations }) => ({
      name: name.replace(/^dashboard_/, ''),
      description,
      inputSchema,
      readOnly: annotations.readOnlyHint === true,
    }));
  // transcribe tells the app whether to offer voice notes at all.
  router.get('/', (_req, res) =>
    res.json({ version: 1, device: res.locals.device, transcribe: !!transcribeAvailable() }),
  );
  router.get('/operations', (_req, res) => res.json({ operations: operations() }));
  router.get('/openapi.json', (_req, res) => {
    const responses = {
      200: {
        description: 'JSON result (see the mobile integration guide for response fields)',
        content: { 'application/json': { schema: { type: 'object' } } },
      },
      default: {
        description: 'JSON error; see the integration guide for HTTP status handling',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['error'],
              properties: { error: { type: 'string' } },
            },
          },
        },
      },
    };
    const paths = {
      '/': { get: { operationId: 'device', summary: 'Current device and API version', responses } },
      '/operations': {
        get: { operationId: 'operations', summary: 'Available operations and input schemas', responses },
      },
      '/openapi.json': { get: { operationId: 'openapi', summary: 'OpenAPI description', responses } },
      '/token': {
        delete: { operationId: 'revokeToken', summary: 'Revoke the current device token', responses },
      },
      '/transcribe': {
        post: {
          operationId: 'transcribe',
          summary: 'Turn a recorded voice note into text',
          parameters: [
            {
              name: 'lang',
              in: 'query',
              description: 'Spoken language as a BCP 47 tag; detected when absent',
              schema: { type: 'string' },
            },
          ],
          requestBody: {
            required: true,
            content: { 'audio/mp4': { schema: { type: 'string', format: 'binary' } } },
          },
          responses,
        },
      },
    };
    for (const op of operations())
      paths[`/operations/${op.name}`] = {
        post: {
          operationId: op.name,
          description: op.description,
          requestBody: { required: true, content: { 'application/json': { schema: op.inputSchema } } },
          responses,
        },
      };
    res.json({
      openapi: '3.1.0',
      info: { title: 'Briareus mobile API', version: '1.0.0' },
      servers: [{ url: PREFIX }],
      security: [{ deviceToken: [] }],
      paths,
      components: { securitySchemes: { deviceToken: { type: 'http', scheme: 'bearer' } } },
    });
  });
  router.post('/operations/:name', async (req, res) => {
    // Receiving a body can take time. Do not let a request admitted before a
    // revoke/expiry retain permission to start work after its body arrives.
    if (!loginEnabled()) throw fail(503, 'Configure dashboard login before using the mobile API');
    const device = auth.authenticate(req.headers.authorization, ownerSecret());
    const operation = operations().find((op) => op.name === req.params.name);
    if (!operation) throw fail(404, 'Unknown operation');
    if (!operation.readOnly && device.permission === 'read')
      throw fail(403, 'This device has read-only access');
    const result = await dashboard.call(
      {
        ...device,
        repos: device.permission === 'admin' ? allRepos() : device.repos,
        actor: `Mobile device ${device.label}`,
      },
      `dashboard_${operation.name}`,
      req.body,
    );
    res.json(result);
  });
  // Voice notes, as the dashboard's composer has them: the recording is the
  // raw body, typed with what the phone recorded, and the answer is its text
  // to put in the message box. The recording is not kept. A message is what
  // the text is for, so a read-only device is refused before its upload is
  // read.
  router.post(
    '/transcribe',
    (_req, res, next) => {
      if (res.locals.device.permission === 'read') throw fail(403, 'This device has read-only access');
      next();
    },
    express.raw({ type: () => true, limit: '25mb' }),
    async (req, res) => {
      // As for an operation: a token revoked while the recording was arriving
      // does not get it transcribed.
      if (!loginEnabled()) throw fail(503, 'Configure dashboard login before using the mobile API');
      auth.authenticate(req.headers.authorization, ownerSecret());
      if (!Buffer.isBuffer(req.body) || !req.body.length) throw fail(400, 'Empty recording');
      // An app that gave up on the note closes its request, and OpenAI's call
      // goes with it rather than billing for text nobody reads.
      const gone = new AbortController();
      res.on('close', () => {
        if (!res.writableEnded) gone.abort();
      });
      let text;
      try {
        text = await transcribe(req.body, {
          type: String(req.headers['content-type'] || ''),
          language: String(req.query.lang || ''),
          signal: gone.signal,
        });
      } catch (e) {
        // What transcribe reports (no key, a format it cannot take, OpenAI's
        // refusal) is what the owner needs to read, so it is not hidden as
        // other server errors are.
        if (e.status) return res.status(e.status).json({ error: e.message });
        throw e;
      }
      res.json({ text });
    },
  );
  router.delete('/token', async (_req, res) => {
    await auth.revoke(res.locals.device.id);
    res.json({ ok: true });
  });
  router.use((_req, res) => res.status(404).json({ error: 'Unknown mobile API route' }));
  router.use((err, _req, res, _next) => {
    const status = err.status || 500;
    if (status === 401) res.set('WWW-Authenticate', 'Bearer realm="briareus-mobile"');
    res.status(status).json({ error: status >= 500 ? 'Mobile API unavailable' : err.message });
  });
  const root = express.Router();
  root.use(PREFIX, router);
  return root;
}

// Remains behind Cloudflare Access, cookie login and sameOriginWrites. Bearer
// credentials never authorize device creation/listing/revocation here.
export function mobileSettingsRoutes({
  auth,
  loginEnabled,
  signedIn,
  ownerSecret,
  getProject,
  listProjects,
}) {
  const router = express.Router();
  router.use('/api/mobile-devices', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (req.headers.authorization || !loginEnabled() || !signedIn(req))
      throw fail(403, 'Configure dashboard login and sign in to manage devices');
    next();
  });
  router.get('/api/mobile-devices', (_req, res) =>
    res.json({
      devices: auth.list(),
      projects: listProjects().map(({ repo, label }) => ({ repo, label })),
    }),
  );
  router.post('/api/mobile-devices', async (req, res) => {
    const body = req.body || {};
    if (
      !Array.isArray(body.repos) ||
      body.repos.some((repo) => typeof repo !== 'string' || !getProject(repo))
    )
      throw fail(400, 'Select existing projects');
    res.status(201).json(await auth.create(body, ownerSecret()));
  });
  router.delete('/api/mobile-devices/:id', async (req, res) => {
    await auth.revoke(req.params.id);
    res.json({ ok: true });
  });
  router.use((err, _req, res, _next) =>
    res.status(err.status || 500).json({
      error: err.status && err.status < 500 ? err.message : 'Mobile device settings unavailable',
    }),
  );
  return router;
}
