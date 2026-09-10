import express from 'express';
import { createHash } from 'node:crypto';
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createRemoteMcpAuth, MCP_SCOPE, CHATGPT_REDIRECT } from '../lib/remote-mcp-auth.js';
import { remoteMcpRoutes } from '../lib/remote-mcp.js';
import { remoteMcpSettingsRoutes } from '../lib/remote-mcp-settings.js';
import { sameOriginWrites } from '../lib/security.js';

const publicUrl = 'https://briareus.example.com';
const verifier = 'a'.repeat(43);
const challenge = createHash('sha256').update(verifier).digest('base64url');
let auth, client, server, url, saved, load, save, dashboard, clock, loginOn;
beforeEach(async () => {
  saved = null;
  clock = Date.now();
  loginOn = true;
  load = vi.fn(async (_key, fallback) => structuredClone(saved || fallback));
  save = vi.fn(async (_key, value) => {
    saved = structuredClone(value);
  });
  auth = createRemoteMcpAuth({ load, save, now: () => clock });
  await auth.init();
  await auth.configure({ enabled: true, baseUrl: publicUrl });
  client = await auth.createClient({ label: 'Personal ChatGPT', repos: ['owner/project'] });
  dashboard = {
    tools: () => [
      {
        name: 'dashboard_projects',
        description: 'List permitted projects',
        inputSchema: { type: 'object', properties: {} },
        annotations: { readOnlyHint: true },
      },
    ],
    call: vi.fn(async (principal) => ({ projects: principal.repos })),
  };
  const app = express();
  app.use(remoteMcpRoutes({ auth, dashboard, loginEnabled: () => loginOn }));
  app.use(sameOriginWrites);
  app.use(express.json());
  app.use(
    remoteMcpSettingsRoutes({
      auth,
      loginEnabled: () => loginOn,
      signedIn: (req) => req.headers.cookie === 'owner=yes',
      getProject: (repo) => (repo === 'owner/project' ? { repo } : null),
      listProjects: () => [{ repo: 'owner/project', label: 'Project' }],
    }),
  );
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  url = `http://127.0.0.1:${server.address().port}`;
});
afterEach(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});
function query(overrides = {}) {
  return {
    client_id: client.clientId,
    redirect_uri: CHATGPT_REDIRECT,
    resource: `${publicUrl}/mcp`,
    response_type: 'code',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: 'client-state',
    scope: MCP_SCOPE,
    ...overrides,
  };
}
function code() {
  const { nonce } = auth.consent(query());
  return new URL(auth.approve(nonce, true)).searchParams.get('code');
}
function tokenBody(overrides = {}) {
  return {
    client_id: client.clientId,
    client_secret: client.clientSecret,
    resource: `${publicUrl}/mcp`,
    grant_type: 'authorization_code',
    redirect_uri: CHATGPT_REDIRECT,
    code_verifier: verifier,
    code: code(),
    ...overrides,
  };
}
async function token(overrides = {}) {
  return auth.exchange(tokenBody(overrides));
}
async function request(path, { method = 'GET', body, cookie = 'owner=yes', headers = {}, ...other } = {}) {
  return fetch(`${url}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
    ...other,
  });
}

it('advertises OAuth discovery and challenges requests with no valid remote bearer token', async () => {
  const response = await request('/mcp', {
    method: 'POST',
    body: {},
    headers: { Authorization: 'Bearer internal-session-token' },
  });
  expect(response.status).toBe(401);
  expect(response.headers.get('www-authenticate')).toContain('/.well-known/oauth-protected-resource');
  const metadata = await (await request('/.well-known/oauth-authorization-server')).json();
  expect(metadata).toMatchObject({
    issuer: publicUrl,
    code_challenge_methods_supported: ['S256'],
    authorization_response_iss_parameter_supported: true,
  });
  expect(metadata.registration_endpoint).toBeUndefined();
  expect(await (await request('/.well-known/oauth-protected-resource/mcp')).json()).toMatchObject({
    resource: `${publicUrl}/mcp`,
    authorization_servers: [publicUrl],
  });
});

it('requires owner login and consent, preserves state/issuer, and never redirects to an unregistered URI', async () => {
  const path = `/oauth/authorize?${new URLSearchParams(query())}`;
  expect((await request(path, { cookie: '' })).status).toBe(403);
  expect((await request(path, { headers: { Authorization: 'Bearer fake' } })).status).toBe(403);
  const response = await request(path);
  const html = await response.text();
  expect(html).toContain('owner/project');
  const nonce = html.match(/name="nonce" value="([^"]+)"/)[1];
  const approved = await request('/oauth/authorize', {
    method: 'POST',
    body: { nonce, allow: 'yes' },
    redirect: 'manual',
  });
  const redirect = new URL(approved.headers.get('location'));
  expect(approved.status).toBe(303);
  expect(redirect.origin).toBe('https://chatgpt.com');
  expect(redirect.searchParams.get('state')).toBe('client-state');
  expect(redirect.searchParams.get('iss')).toBe(publicUrl);
  expect(redirect.searchParams.get('code')).toBeTruthy();
  expect((await request('/oauth/authorize', { method: 'POST', body: { nonce, allow: 'yes' } })).status).toBe(
    400,
  );
  expect(() => auth.consent(query({ redirect_uri: 'https://evil.example/' }))).toThrow();
  expect(() => auth.consent(query({ resource: 'https://other.example/mcp' }))).toThrow();
  expect(() => auth.consent(query({ code_challenge_method: 'plain' }))).toThrow();
});

it('denies consent without issuing a code and binds form writes to the origin', async () => {
  const { nonce } = auth.consent(query());
  const crossSite = await request('/oauth/authorize', {
    method: 'POST',
    body: { nonce, allow: 'yes' },
    headers: { Origin: 'https://evil.example' },
  });
  expect(crossSite.status).toBe(403);
  const redirect = new URL(auth.approve(nonce, false));
  expect(redirect.searchParams.get('error')).toBe('access_denied');
  expect(redirect.searchParams.get('iss')).toBe(publicUrl);
  expect(redirect.searchParams.has('code')).toBe(false);
});

it('exchanges a code using form-encoded static credentials and PKCE, and accepts SDK Streamable HTTP calls', async () => {
  const body = tokenBody();
  const response = await fetch(`${url}/oauth/token`, { method: 'POST', body: new URLSearchParams(body) });
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  const tokens = await response.json();
  expect(tokens.access_token).toBeTruthy();
  const sdk = new Client({ name: 'chatgpt-test', version: '1.0.0' });
  await sdk.connect(
    new StreamableHTTPClientTransport(new URL(`${url}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${tokens.access_token}` } },
    }),
  );
  try {
    const listed = await sdk.listTools();
    expect(listed.tools[0].annotations.readOnlyHint).toBe(true);
    expect((await sdk.callTool({ name: 'dashboard_projects', arguments: {} })).structuredContent).toEqual({
      projects: ['owner/project'],
    });
    expect(dashboard.call).toHaveBeenCalledWith(
      expect.objectContaining({ repos: ['owner/project'], label: 'Personal ChatGPT' }),
      'dashboard_projects',
      {},
    );
  } finally {
    await sdk.close();
  }
  await expect(auth.exchange(body)).rejects.toThrow('Invalid or expired authorization code');
});

it('rejects wrong secrets, verifiers and audiences before issuing tokens', async () => {
  const body = tokenBody();
  await expect(auth.exchange({ ...body, client_secret: 'wrong' })).rejects.toThrow('client authentication');
  await expect(auth.exchange({ ...body, code_verifier: 'b'.repeat(43) })).rejects.toThrow('PKCE');
  await expect(auth.exchange({ ...body, resource: `${publicUrl}/other` })).rejects.toThrow('resource');
  expect(saved.grants).toHaveLength(0);
  const basic = `Basic ${Buffer.from(`${client.clientId}:${client.clientSecret}`).toString('base64')}`;
  delete body.client_secret;
  expect((await auth.exchange(body, basic)).access_token).toBeTruthy();
});

it('persists only hashes, restores grants across restarts and rotates refresh tokens once', async () => {
  const tokens = await token();
  const stored = JSON.stringify(saved);
  for (const secret of [client.clientSecret, tokens.access_token, tokens.refresh_token])
    expect(stored).not.toContain(secret);
  const restored = createRemoteMcpAuth({ load, save, now: () => clock });
  await restored.init();
  expect(restored.authenticate(`Bearer ${tokens.access_token}`).repos).toEqual(['owner/project']);
  const body = {
    client_id: client.clientId,
    client_secret: client.clientSecret,
    resource: `${publicUrl}/mcp`,
    grant_type: 'refresh_token',
    refresh_token: tokens.refresh_token,
  };
  const results = await Promise.allSettled([restored.exchange(body), restored.exchange(body)]);
  expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
  expect(restored.authenticate(`Bearer ${tokens.access_token}`)).toBeNull();
});

it('expires codes, access tokens and refresh tokens and fails closed after revocation or disable', async () => {
  const expiredCode = tokenBody();
  clock += 61_000;
  await expect(auth.exchange(expiredCode)).rejects.toThrow('expired');
  const tokens = await token();
  clock += 3600_001;
  expect(auth.authenticate(`Bearer ${tokens.access_token}`)).toBeNull();
  clock += 30 * 86400_000;
  await expect(
    auth.exchange({
      client_id: client.clientId,
      client_secret: client.clientSecret,
      resource: `${publicUrl}/mcp`,
      grant_type: 'refresh_token',
      refresh_token: tokens.refresh_token,
    }),
  ).rejects.toThrow('expired');
  const fresh = await token();
  await auth.revoke(client.clientId);
  expect(auth.authenticate(`Bearer ${fresh.access_token}`)).toBeNull();
  await auth.configure({ enabled: false, baseUrl: publicUrl });
  expect((await request('/mcp')).status).toBe(404);
});

it('disables remote access if password login is turned off, and refuses arbitrary redirects and URL credentials', async () => {
  loginOn = false;
  expect((await request('/mcp')).status).toBe(503);
  expect((await request(`/oauth/authorize?${new URLSearchParams(query())}`)).status).toBe(403);
  expect(
    (await request('/api/mcp/clients', { method: 'POST', body: { label: 'x', repos: ['owner/project'] } }))
      .status,
  ).toBe(403);
  expect(() =>
    auth.createClient({ label: 'x', repos: ['owner/project'], redirectUri: 'https://evil.example/' }),
  ).toThrow();
  await expect(auth.configure({ enabled: true, baseUrl: 'http://example.com' })).rejects.toThrow();
  await expect(auth.configure({ enabled: true, baseUrl: 'https://secret@example.com' })).rejects.toThrow();
});

it('protects connection management from bearer tokens and returns secrets only on creation', async () => {
  const tokens = await token();
  const response = await request('/api/mcp', { headers: { Authorization: `Bearer ${tokens.access_token}` } });
  expect(response.status).toBe(403);
  expect((await request('/api/mcp', { cookie: '' })).status).toBe(403);
  const view = await (await request('/api/mcp')).json();
  expect(view.clients[0].connected).toBe(true);
  expect(JSON.stringify(view)).not.toContain(client.clientSecret);
  expect(view.clients[0].secretHash).toBeUndefined();
  expect(
    (await request('/api/mcp/clients', { method: 'POST', body: { label: 'wrong', repos: ['other/repo'] } }))
      .status,
  ).toBe(400);
});

it('rejects untrusted origins and malformed JSON without reaching a dashboard action', async () => {
  const tokens = await token();
  const response = await request('/mcp', {
    method: 'POST',
    body: {},
    headers: { Authorization: `Bearer ${tokens.access_token}`, Origin: 'https://evil.example' },
  });
  expect(response.status).toBe(403);
  const malformed = await fetch(`${url}/mcp`, {
    method: 'POST',
    body: '{"token":',
    headers: { 'Content-Type': 'application/json' },
  });
  expect(malformed.status).toBe(400);
  expect(await malformed.json()).toEqual({ error: 'Invalid JSON' });
  expect(dashboard.call).not.toHaveBeenCalled();
});

it('does not publish newly issued credentials when persistence fails', async () => {
  save.mockRejectedValueOnce(new Error('database down'));
  await expect(token()).rejects.toThrow('database down');
  expect(saved.grants).toHaveLength(0);
});

const gatedRoutes = [
  ['/mcp', 'POST'],
  ['/oauth/token', 'POST'],
  ['/.well-known/oauth-authorization-server', 'GET'],
  ['/.well-known/oauth-protected-resource', 'GET'],
  ['/.well-known/oauth-protected-resource/mcp', 'GET'],
].flatMap(([path, method]) =>
  [path, `${path}/`, path.toUpperCase(), `${path.toUpperCase()}/`].map((variant) => [variant, method]),
);

it.each(gatedRoutes)('gates matching route %s (%s) before dispatch', async (path, method) => {
  const tokens = await token();
  const options = {
    method,
    headers: {
      ...(path.toLowerCase().startsWith('/mcp') ? { Authorization: `Bearer ${tokens.access_token}` } : {}),
      Accept: 'application/json, text/event-stream',
    },
    ...(method === 'POST'
      ? {
          body: path.toLowerCase().startsWith('/mcp')
            ? {
                jsonrpc: '2.0',
                id: 1,
                method: 'tools/call',
                params: { name: 'dashboard_projects', arguments: {} },
              }
            : tokenBody(),
        }
      : {}),
  };
  loginOn = false;
  expect((await request(path, options)).status).toBe(503);
  loginOn = true;
  expect(
    (await request(path, { ...options, headers: { ...options.headers, Origin: 'https://evil.example' } }))
      .status,
  ).toBe(403);
  expect(dashboard.call).not.toHaveBeenCalled();
  expect(saved.grants).toHaveLength(1);
  const allowed = await request(path, {
    ...options,
    headers: { ...options.headers, Origin: 'https://chatgpt.com' },
  });
  expect(allowed.status).toBe(200);
  expect(allowed.headers.get('cache-control')).toBe('no-store');
  if (path.toLowerCase().startsWith('/mcp')) expect(dashboard.call).toHaveBeenCalledTimes(1);
  await auth.configure({ enabled: false, baseUrl: publicUrl });
  expect((await request(path, options)).status).toBe(404);
});
