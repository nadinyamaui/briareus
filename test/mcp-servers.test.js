import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMcpService, normalizeMcpServer, parseBearerChallenge } from '../lib/mcp-servers.js';

vi.mock('../lib/config.js', () => ({ getConfig: () => ({ credentialsKey: 'k'.repeat(32) }) }));

const MCP = 'https://mcp.example.com/devtools';
const CALLBACK = 'https://briareus.test/webhooks/mcp-oauth/callback';
const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

// A remote server that signs in the way Meta's does: 401 with the resource
// metadata, an authorization server under a path, dynamic registration, and
// tokens that expire. `remote.valid` is the bearer it lets in.
function fakeRemote() {
  const remote = {
    valid: null,
    calls: [],
    tokenRequests: [],
    registrations: 0,
    refreshFails: false,
  };
  remote.fetch = vi.fn(async (url, init = {}) => {
    const u = String(url);
    const headers = init.headers || {};
    remote.calls.push({ url: u, method: init.method || 'GET', headers, body: init.body });
    if (u === MCP) {
      if (init.method === 'DELETE') return new Response(null, { status: 204 });
      const auth = headers.Authorization || headers.authorization;
      if (remote.valid && auth === `Bearer ${remote.valid}`)
        return json({ jsonrpc: '2.0', id: 1, result: {} }, 200, { 'mcp-session-id': 'sess-1' });
      if (headers['X-Api-Key'] === 'right') return json({ jsonrpc: '2.0', id: 1, result: {} });
      return new Response('no', {
        status: 401,
        headers: {
          'www-authenticate':
            'Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource/devtools", scope="read manage"',
        },
      });
    }
    if (u === 'https://mcp.example.com/.well-known/oauth-protected-resource/devtools')
      return json({ resource: MCP, authorization_servers: ['https://auth.example.com/devtools'] });
    if (u === 'https://auth.example.com/.well-known/oauth-authorization-server/devtools')
      return json({
        issuer: 'https://auth.example.com/devtools',
        authorization_endpoint: 'https://auth.example.com/dialog/oauth',
        token_endpoint: 'https://auth.example.com/token',
        registration_endpoint: 'https://mcp.example.com/register',
        token_endpoint_auth_methods_supported: ['none'],
      });
    if (u === 'https://mcp.example.com/register') {
      remote.registrations++;
      return json({ client_id: `client-${remote.registrations}` }, 201);
    }
    if (u === 'https://auth.example.com/token') {
      const params = Object.fromEntries(new URLSearchParams(String(init.body)));
      remote.tokenRequests.push(params);
      if (params.grant_type === 'refresh_token' && remote.refreshFails)
        return json({ error: 'invalid_grant' }, 400);
      const n = remote.tokenRequests.length;
      remote.valid = `access-${n}`;
      return json({ access_token: `access-${n}`, refresh_token: `refresh-${n}`, expires_in: 3600 });
    }
    return new Response('not found', { status: 404 });
  });
  return remote;
}

let remote, saved, clock, service;
beforeEach(async () => {
  remote = fakeRemote();
  saved = [];
  clock = 1_000_000;
  service = createMcpService({
    load: async () => [],
    save: async (_name, value) => {
      saved = value;
    },
    fetchImpl: remote.fetch,
    callbackUrl: () => CALLBACK,
    now: () => clock,
  });
  await service.init();
});

// The sign-in a client would open, followed through the provider's redirect.
async function signIn(server) {
  const url = new URL(server.signInUrl);
  return service.complete({ state: url.searchParams.get('state'), code: 'the-code' });
}

describe('normalizeMcpServer', () => {
  it('takes a remote server and a stdio one', () => {
    expect(normalizeMcpServer({ name: 'meta', url: MCP })).toMatchObject({
      name: 'meta',
      label: 'meta',
      transport: 'http',
      url: MCP,
      repos: [],
      enabled: true,
    });
    expect(
      normalizeMcpServer({ name: 'local', transport: 'stdio', command: 'node', args: ['srv.js'] }),
    ).toMatchObject({ transport: 'stdio', command: 'node', args: ['srv.js'], url: '' });
  });

  it('refuses what would break a session or leak a token', () => {
    expect(() => normalizeMcpServer({ name: 'reviewer_memory', url: MCP })).toThrow(/Briareus/);
    expect(() => normalizeMcpServer({ name: 'has space', url: MCP })).toThrow(/letters/);
    expect(() => normalizeMcpServer({ name: 'x', url: 'http://mcp.example.com/' })).toThrow(/https/);
    expect(normalizeMcpServer({ name: 'x', url: 'http://127.0.0.1:9000/mcp' }).url).toBe(
      'http://127.0.0.1:9000/mcp',
    );
    expect(() => normalizeMcpServer({ name: 'x', transport: 'stdio' })).toThrow(/command/);
    expect(() => normalizeMcpServer({ name: 'x', url: MCP, repos: ['nope'] })).toThrow(/owner\/name/);
  });

  it('reads the parts of a bearer challenge', () => {
    expect(parseBearerChallenge('Bearer resource_metadata="https://a/b", scope="x y"')).toEqual({
      resource_metadata: 'https://a/b',
      scope: 'x y',
    });
    expect(parseBearerChallenge('Basic realm="x"')).toBeNull();
  });
});

describe('adding a server that signs in with OAuth', () => {
  it('discovers, registers and hands back a sign-in link at once', async () => {
    const server = await service.create({ name: 'meta', label: 'Meta', url: MCP });
    expect(server).toMatchObject({ auth: 'oauth', status: 'needs-sign-in', signedIn: false });
    const url = new URL(server.signInUrl);
    expect(url.origin + url.pathname).toBe('https://auth.example.com/dialog/oauth');
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      response_type: 'code',
      client_id: 'client-1',
      redirect_uri: CALLBACK,
      code_challenge_method: 'S256',
      resource: MCP,
      scope: 'read manage',
    });
    // Registered as a public client for that redirect.
    const reg = remote.calls.find((c) => c.url === 'https://mcp.example.com/register');
    expect(JSON.parse(reg.body)).toMatchObject({
      redirect_uris: [CALLBACK],
      token_endpoint_auth_method: 'none',
    });
    // Nothing secret is stored in the clear, and nothing is mounted yet.
    expect(JSON.stringify(saved)).not.toContain('client-1');
    expect(service.mounts('o/r')).toEqual([]);
  });

  it('finishes the setup on the redirect: tokens with the PKCE verifier, then a check', async () => {
    const server = await service.create({ name: 'meta', url: MCP });
    const done = await signIn(server);
    expect(done).toMatchObject({ status: 'ready', signedIn: true, signInUrl: null, signedInAt: clock });
    const [exchange] = remote.tokenRequests;
    expect(exchange).toMatchObject({
      grant_type: 'authorization_code',
      code: 'the-code',
      redirect_uri: CALLBACK,
      client_id: 'client-1',
      resource: MCP,
    });
    expect(exchange.code_verifier).toMatch(/^[\w-]{43}$/);
    expect(JSON.stringify(saved)).not.toContain('access-1');
    expect(service.mounts('o/r')).toEqual([{ id: done.id, name: 'meta', transport: 'http' }]);
  });

  it('takes a link only once, and not after it expires', async () => {
    const server = await service.create({ name: 'meta', url: MCP });
    const state = new URL(server.signInUrl).searchParams.get('state');
    clock += 16 * 60_000;
    await expect(service.complete({ state, code: 'c' })).rejects.toThrow(/expired/);
    const again = await service.connect(server.id);
    await signIn(again);
    await expect(signIn(again)).rejects.toThrow(/already used/);
  });

  it('keeps a refusal at the provider on the server, for the client to show', async () => {
    const server = await service.create({ name: 'meta', url: MCP });
    const state = new URL(server.signInUrl).searchParams.get('state');
    await expect(
      service.complete({ state, error: 'access_denied', error_description: 'User said no' }),
    ).rejects.toThrow('Sign-in failed: User said no');
    expect(service.list()[0]).toMatchObject({
      status: 'needs-sign-in',
      error: 'Sign-in failed: User said no',
    });
  });

  it('reuses its registration for a fresh sign-in', async () => {
    const server = await service.create({ name: 'meta', url: MCP });
    await signIn(server);
    const again = await service.connect(server.id, { signIn: true });
    expect(new URL(again.signInUrl).searchParams.get('client_id')).toBe('client-1');
    expect(remote.registrations).toBe(1);
  });
});

describe('the proxy target', () => {
  it('hands out the token while it is fresh and refreshes it near expiry', async () => {
    const server = await signIn(await service.create({ name: 'meta', url: MCP }));
    expect(await service.upstream(server.id, 'o/r')).toEqual({
      url: MCP,
      headers: { Authorization: 'Bearer access-1' },
      oauth: true,
    });
    clock += 3600_000 - 30_000;
    const [a, b] = await Promise.all([
      service.upstream(server.id, 'o/r'),
      service.upstream(server.id, 'o/r'),
    ]);
    expect(a.headers.Authorization).toBe('Bearer access-2');
    expect(b.headers.Authorization).toBe('Bearer access-2');
    expect(remote.tokenRequests.filter((t) => t.grant_type === 'refresh_token')).toEqual([
      expect.objectContaining({ refresh_token: 'refresh-1', client_id: 'client-1' }),
    ]);
  });

  it('asks for a sign-in again once the refresh is refused, and stops mounting it', async () => {
    const server = await signIn(await service.create({ name: 'meta', url: MCP }));
    remote.refreshFails = true;
    await expect(service.upstream(server.id, 'o/r', { force: true })).rejects.toMatchObject({ status: 401 });
    expect(service.list()[0]).toMatchObject({ status: 'needs-sign-in', signedIn: false });
    expect(service.mounts('o/r')).toEqual([]);
  });

  it('is only for the projects it is assigned to, and only while enabled', async () => {
    const server = await service.create({
      name: 'keyed',
      url: MCP,
      headers: { 'X-Api-Key': 'right' },
      repos: ['o/a'],
    });
    expect(server).toMatchObject({ status: 'ready', auth: 'none', headerNames: ['X-Api-Key'] });
    expect(server).not.toHaveProperty('secrets');
    await expect(service.upstream(server.id, 'o/b')).rejects.toMatchObject({ status: 404 });
    expect((await service.upstream(server.id, 'o/a')).headers).toEqual({ 'X-Api-Key': 'right' });
    expect(service.mounts('o/b')).toEqual([]);
    await service.update(server.id, { enabled: false });
    expect(service.mounts('o/a')).toEqual([]);
    await expect(service.upstream(server.id, 'o/a')).rejects.toMatchObject({ status: 404 });
  });
});

describe('servers that do not sign in', () => {
  it('says so when given headers the server refuses, rather than starting OAuth', async () => {
    const server = await service.create({ name: 'k', url: MCP, headers: { Authorization: 'Bearer wrong' } });
    expect(server).toMatchObject({ status: 'error', error: 'The server refused the headers you gave it' });
    expect(server.signInUrl).toBeNull();
  });

  it('mounts a stdio server with its env opened', async () => {
    const server = await service.create({
      name: 'local',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', 'some-mcp'],
      env: { API_KEY: 'sekrit' },
    });
    expect(server).toMatchObject({ status: 'ready', envNames: ['API_KEY'] });
    expect(JSON.stringify(saved)).not.toContain('sekrit');
    expect(service.mounts('o/r')).toEqual([
      {
        id: server.id,
        name: 'local',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', 'some-mcp'],
        env: { API_KEY: 'sekrit' },
      },
    ]);
  });

  it('keeps names unique and forgets a removed server', async () => {
    const server = await service.create({ name: 'local', transport: 'stdio', command: 'x' });
    await expect(service.create({ name: 'local', transport: 'stdio', command: 'y' })).rejects.toThrow(
      /already a server/,
    );
    await service.remove(server.id);
    expect(service.list()).toEqual([]);
    await expect(service.remove(server.id)).rejects.toMatchObject({ status: 404 });
  });

  it('drops a sign-in when the server moves to another URL', async () => {
    const server = await signIn(await service.create({ name: 'meta', url: MCP }));
    const moved = await service.update(server.id, { url: 'https://other.example.com/mcp' });
    expect(moved).toMatchObject({ signedIn: false, auth: 'none', status: 'error' });
  });
});
