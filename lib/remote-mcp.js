// @ts-check
import express from 'express';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { MCP_SCOPE } from './remote-mcp-auth.js';

// These endpoints authenticate OAuth credentials, never browser cookies or
// internal agent tokens. Mount before the browser login and Origin middleware.
export function remoteMcpRoutes({ auth, dashboard, loginEnabled }) {
  const router = express.Router();
  const publicPaths = [
    '/mcp',
    '/oauth/token',
    '/.well-known/oauth-authorization-server',
    '/.well-known/oauth-protected-resource',
    '/.well-known/oauth-protected-resource/mcp',
  ];
  router.all(publicPaths, (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (!loginEnabled())
      return res.status(503).json({ error: 'Configure dashboard login before using remote MCP' });
    try {
      auth.available();
      const origin = req.get('Origin');
      if (origin && ![auth.view().baseUrl, 'https://chatgpt.com'].includes(origin))
        return res.status(403).json({ error: 'Origin not allowed' });
      next();
    } catch (e) {
      res.status(e.status || 503).json({ error: e.message });
    }
  });
  router.use(['/mcp', '/oauth/token'], express.json({ limit: '1mb' }));
  router.get('/.well-known/oauth-authorization-server', (_req, res) => res.json(auth.metadata()));
  for (const route of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp'])
    router.get(route, (_req, res) => res.json(auth.resourceMetadata()));
  router.post('/oauth/token', express.urlencoded({ extended: false, limit: '16kb' }), async (req, res) => {
    try {
      res.json(await auth.exchange(req.body || {}, req.get('Authorization')));
    } catch (e) {
      const status = e.oauthError === 'invalid_client' ? 401 : e.status || 400;
      if (status === 401) res.set('WWW-Authenticate', 'Basic realm="Briareus OAuth"');
      res.status(status).json({ error: e.oauthError || 'invalid_request', error_description: e.message });
    }
  });
  router.all('/mcp', async (req, res) => {
    const principal = auth.authenticate(req.get('Authorization'));
    if (!principal) {
      res.set(
        'WWW-Authenticate',
        `Bearer resource_metadata="${auth.view().baseUrl}/.well-known/oauth-protected-resource", scope="${MCP_SCOPE}"`,
      );
      return res.status(401).json({ error: 'Connect Briareus using OAuth' });
    }
    // Stateless Streamable HTTP: no resident transport or server-side session
    // can outlive token revocation. The SDK handles negotiation and JSON-RPC.
    const server = new Server(
      { name: 'briareus', version: '1.0.0' },
      {
        capabilities: { tools: {} },
        instructions:
          'Manage Briareus only as requested by the user. First list permitted projects with dashboard_projects. Starts launch paid agents using each project’s configured model. Use dashboard_session to check progress. Write tools can change GitHub and delete data.',
      },
    );
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: dashboard.tools() }));
    server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
      try {
        // Recheck immediately before execution, including within a batch.
        const current = auth.authenticate(req.get('Authorization'));
        if (!current) throw new Error('Connection expired or was revoked; reconnect from ChatGPT');
        const result = await dashboard.call(current, params.name, params.arguments || {});
        return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
      } catch (e) {
        return { content: [{ type: 'text', text: e.message }], isError: true };
      }
    });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on('close', () => {
      server.close().catch(() => {});
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });
  router.use((err, _req, res, _next) => {
    if (!res.headersSent)
      res
        .status(err.status || 500)
        .json({ error: err.type === 'entity.parse.failed' ? 'Invalid JSON' : 'MCP request failed' });
  });
  return router;
}
