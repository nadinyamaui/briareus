import { open } from '../lib/secretbox.js';
import { createServer } from 'node:http';
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
      const auth = new Headers(headers).get('authorization');
      if (remote.valid && auth === `Bearer ${remote.valid}`)
        return json({ jsonrpc: '2.0', id: 1, result: {} }, 200, { 'mcp-session-id': 'sess-1' });
      if (new Headers(headers).get('X-Api-Key') === 'right')
        return json({ jsonrpc: '2.0', id: 1, result: {} });
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
      const reg = JSON.parse(init.body);
      remote.lastRegistration = reg;
      // Like Meta: only known clients, and only to their own loopback,
      // which it hands back rewritten.
      if (remote.knownClientsOnly) {
        if (
          !reg.client_name.startsWith('Claude Code') ||
          !/^http:\/\/127\.0\.0\.1:\d+\/callback$/.test(reg.redirect_uris[0])
        )
          return json(
            { error: 'invalid_client_metadata', error_description: 'Not available for this client.' },
            400,
          );
        return json(
          { client_id: 'known', redirect_uris: [reg.redirect_uris[0].replace('127.0.0.1', 'localhost')] },
          201,
        );
      }
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

  it.each(['expiry', 'rejection'])('keeps a short-lived nonrefreshable token until %s', async (end) => {
    const original = remote.fetch.getMockImplementation();
    remote.fetch.mockImplementation(async (url, init) => {
      const response = await original(url, init);
      if (String(url).endsWith('/token')) {
        const token = await response.json();
        return json({ access_token: token.access_token, expires_in: 30 });
      }
      return response;
    });
    const server = await signIn(await service.create({ name: 'meta', url: MCP }));
    expect(server).toMatchObject({ status: 'ready', signedIn: true });
    expect(service.mounts('o/r')).toHaveLength(1);
    clock += 29_999;
    expect((await service.upstream(server.id, 'o/r')).headers.Authorization).toBe('Bearer access-1');
    expect(remote.tokenRequests).toHaveLength(1);
    if (end === 'expiry') clock++;
    await expect(service.upstream(server.id, 'o/r', { force: end === 'rejection' })).rejects.toMatchObject({
      status: 401,
    });
    expect(service.list()[0].signedIn).toBe(false);
    expect(service.mounts('o/r')).toEqual([]);
    expect(remote.tokenRequests).toHaveLength(1);
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

describe('a server that only lets clients it knows sign in', () => {
  beforeEach(() => {
    remote.knownClientsOnly = true;
  });

  it('says what to set when it refuses Briareus', async () => {
    const server = await service.create({ name: 'meta', url: MCP });
    expect(server.status).toBe('error');
    expect(server.error).toMatch(/refused to register Briareus.*oauthClientName.*loopback/);
  });

  it('registers under the given name to a loopback, and finishes with the pasted address', async () => {
    const server = await service.create({
      name: 'meta',
      url: MCP,
      oauthClientName: 'Claude Code (Briareus)',
      oauthRedirect: 'loopback',
    });
    expect(server).toMatchObject({ status: 'needs-sign-in', signInNeedsPaste: true });
    expect(remote.lastRegistration).toMatchObject({
      client_name: 'Claude Code (Briareus)',
      redirect_uris: [expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/callback$/)],
    });
    const url = new URL(server.signInUrl);
    // The redirect the registration answered with, not the one asked for.
    const redirect = url.searchParams.get('redirect_uri');
    expect(redirect).toMatch(/^http:\/\/localhost:\d+\/callback$/);
    const landed = `${redirect}?code=the-code&state=${url.searchParams.get('state')}`;
    await expect(service.finishSignIn(server.id, 'http://127.0.0.1:1/callback')).rejects.toThrow(
      /code and state/,
    );
    const done = await service.finishSignIn(server.id, landed);
    expect(done).toMatchObject({ status: 'ready', signedIn: true, signInNeedsPaste: false });
    expect(remote.tokenRequests[0]).toMatchObject({ redirect_uri: redirect, client_id: 'known' });
    // The registration is kept for the next sign-in.
    await service.connect(server.id, { signIn: true });
    expect(remote.registrations).toBe(1);
  });

  it('refuses an address from another server’s sign-in', async () => {
    const opts = { url: MCP, oauthClientName: 'Claude Code (B)', oauthRedirect: 'loopback' };
    const a = await service.create({ name: 'a', ...opts });
    const b = await service.create({ name: 'b', ...opts });
    const state = new URL(a.signInUrl).searchParams.get('state');
    await expect(
      service.finishSignIn(b.id, `http://127.0.0.1:1/callback?code=c&state=${state}`),
    ).rejects.toThrow(/another server/);
  });
});

describe('review regressions', () => {
  it('reads only the Bearer parameters regardless of challenge order', () => {
    expect(
      parseBearerChallenge(
        'Basic realm="legacy, Bearer fake", Bearer resource_metadata="https://mcp.test/custom", scope="read,write", Digest realm="other", scope="wrong"',
      ),
    ).toEqual({
      resource_metadata: 'https://mcp.test/custom',
      scope: 'read,write',
    });
    expect(parseBearerChallenge('Basic realm="escaped \\" quote", Bearer scope=read')).toEqual({
      scope: 'read',
    });
    expect(parseBearerChallenge('Basic realm="Bearer scope=wrong"')).toBeNull();
  });

  it.each([undefined, 'https://legit.test/mcp', 'https://mcp.example.com/other', `${MCP}/`])(
    'rejects resource metadata identifying %s before registration or authorization',
    async (resource) => {
      const original = remote.fetch.getMockImplementation();
      remote.fetch.mockImplementation((url, init) =>
        String(url).includes('oauth-protected-resource')
          ? json({ resource, authorization_servers: ['https://auth.example.com/devtools'] })
          : original(url, init),
      );
      const server = await service.create({ name: 'meta', url: MCP });
      expect(server).toMatchObject({ status: 'error', signedIn: false, signInUrl: null });
      expect(server.error).toMatch(/resource metadata does not match/);
      expect(remote.registrations).toBe(0);
      expect(remote.tokenRequests).toEqual([]);
      expect(remote.calls.some((call) => call.url.includes('oauth-authorization-server'))).toBe(false);
    },
  );

  it.each([404, 503, 'malformed', 'network'])(
    'fails closed when advertised authorization metadata is unavailable: %s',
    async (failure) => {
      const original = remote.fetch.getMockImplementation();
      remote.fetch.mockImplementation((url, init) => {
        if (String(url).startsWith('https://auth.example.com/')) {
          if (failure === 'network') throw new Error('unavailable');
          if (failure === 'malformed') return new Response('not json');
          return json({}, failure);
        }
        return original(url, init);
      });
      const server = await service.create({
        name: 'meta',
        url: MCP,
        oauthClientId: 'client',
        oauthClientSecret: 'SECRET',
      });
      expect(server).toMatchObject({ status: 'error', signInUrl: null, signedIn: false });
      expect(server.error).toMatch(/advertised authorization server.*metadata/);
      expect(remote.registrations).toBe(0);
      expect(remote.tokenRequests).toEqual([]);
      remote.fetch.mockImplementation(original);
      expect(await service.connect(server.id)).toMatchObject({ status: 'needs-sign-in' });
    },
  );

  it('retains legacy resource-origin endpoints when no authorization server is advertised', async () => {
    const original = remote.fetch.getMockImplementation();
    remote.fetch.mockImplementation((url, init) =>
      String(url).includes('/.well-known/') ? json({}, 404) : original(url, init),
    );
    const server = await service.create({ name: 'legacy', url: MCP, oauthClientId: 'client' });
    expect(server.status).toBe('needs-sign-in');
    expect(new URL(server.signInUrl).origin).toBe('https://mcp.example.com');
    expect(new URL(server.signInUrl).pathname).toBe('/authorize');
  });

  it.each([
    [401, 'invalid_client'],
    [400, 'invalid_request'],
    [400, 'invalid_scope'],
    [401, undefined],
  ])(
    'preserves refresh grants after HTTP %s %s and recovers after secret correction',
    async (status, error) => {
      const server = await signIn(
        await service.create({
          name: 'meta',
          url: MCP,
          oauthClientId: 'client',
          oauthClientSecret: 'old',
        }),
      );
      await service.update(server.id, { oauthClientSecret: 'mistake' });
      const original = remote.fetch.getMockImplementation();
      remote.fetch.mockImplementation((url, init) => {
        if (
          String(url).endsWith('/token') &&
          new URLSearchParams(String(init.body)).get('client_secret') === 'mistake'
        )
          return json({ error, error_description: 'client configuration failed' }, status);
        return original(url, init);
      });
      await expect(service.upstream(server.id, 'o/r', { force: true })).rejects.toMatchObject({
        status: 502,
      });
      expect(service.list()[0].signedIn).toBe(true);
      clock += 3_550_000;
      expect(await service.connect(server.id)).toMatchObject({
        status: 'error',
        signedIn: true,
        signInUrl: null,
      });
      expect(service.mounts('o/r')).toHaveLength(1);
      await service.update(server.id, { oauthClientSecret: 'old' });
      expect((await service.upstream(server.id, 'o/r')).headers.Authorization).toBe('Bearer access-2');
      expect(remote.tokenRequests.at(-1).refresh_token).toBe('refresh-1');
    },
  );

  it.each([503, 'network'])(
    'retains a recoverable grant after refresh failure %s during connect',
    async (failure) => {
      const server = await signIn(await service.create({ name: 'meta', url: MCP }));
      clock += 3_600_000;
      const original = remote.fetch.getMockImplementation();
      remote.fetch.mockImplementation((url, init) => {
        if (String(url).endsWith('/token')) {
          if (failure === 'network') throw new Error('network unavailable');
          return json({ error: 'temporarily_unavailable' }, failure);
        }
        return original(url, init);
      });
      remote.calls.length = 0;
      const checked = await service.connect(server.id);
      expect(checked).toMatchObject({ status: 'error', signedIn: true, signInUrl: null });
      expect(checked.error).toMatch(/temporarily_unavailable|network unavailable/);
      expect(remote.calls).toEqual([]);
      expect(service.mounts('o/r')).toHaveLength(1);
      remote.fetch.mockImplementation(original);
      expect((await service.upstream(server.id, 'o/r')).headers.Authorization).toBe('Bearer access-2');
      expect(remote.tokenRequests.at(-1).refresh_token).toBe('refresh-1');
    },
  );

  it.each([503, 'network'])(
    'uses a still-valid bearer during temporary early-refresh failure %s',
    async (failure) => {
      const server = await signIn(await service.create({ name: 'meta', url: MCP }));
      clock += 3_550_000;
      const original = remote.fetch.getMockImplementation();
      remote.fetch.mockImplementation((url, init) => {
        if (String(url).endsWith('/token')) {
          if (failure === 'network') throw new Error('network unavailable');
          return json({ error: 'temporarily_unavailable' }, failure);
        }
        return original(url, init);
      });
      const [first, second] = await Promise.all([
        service.upstream(server.id, 'o/r'),
        service.upstream(server.id, 'o/r'),
      ]);
      expect(first.headers.Authorization).toBe('Bearer access-1');
      expect(second.headers.Authorization).toBe('Bearer access-1');
      expect(await service.connect(server.id)).toMatchObject({ status: 'ready', signedIn: true });
      await expect(service.upstream(server.id, 'o/r', { force: true })).rejects.toMatchObject({
        status: 502,
      });
      clock += 50_000;
      await expect(service.upstream(server.id, 'o/r')).rejects.toMatchObject({ status: 502 });
      remote.fetch.mockImplementation(original);
      expect((await service.upstream(server.id, 'o/r')).headers.Authorization).toBe('Bearer access-2');
      expect(remote.tokenRequests.at(-1).refresh_token).toBe('refresh-1');
    },
  );

  it.each(['invalid_grant', 'invalid_client'])(
    'does not fall back to a valid bearer after %s',
    async (error) => {
      const server = await signIn(await service.create({ name: 'meta', url: MCP }));
      clock += 3_550_000;
      const original = remote.fetch.getMockImplementation();
      remote.fetch.mockImplementation((url, init) =>
        String(url).endsWith('/token') ? json({ error }, 400) : original(url, init),
      );
      await expect(service.upstream(server.id, 'o/r')).rejects.toMatchObject({
        status: error === 'invalid_grant' ? 401 : 502,
      });
      expect(service.list()[0].signedIn).toBe(error !== 'invalid_grant');
    },
  );

  it('does not use an early-refresh fallback after the bearer expires while waiting', async () => {
    const server = await signIn(await service.create({ name: 'meta', url: MCP }));
    clock += 3_550_000;
    const delayed = delayNext((url) => url.endsWith('/token'));
    const request = expect(service.upstream(server.id, 'o/r')).rejects.toMatchObject({ status: 502 });
    await delayed.waiting;
    clock += 50_000;
    delayed.release(json({ error: 'temporarily_unavailable' }, 503));
    await request;
  });

  it.each([
    { oauthScope: 'expanded' },
    { oauthClientName: 'new' },
    { oauthRedirect: 'loopback' },
    { oauthClientSecret: 'new' },
  ])('invalidates a pending sign-in after grant-preserving maintenance %j', async (update) => {
    const server = await service.create({
      name: 'meta',
      url: MCP,
      oauthClientId: 'client',
      oauthClientSecret: 'old',
    });
    const state = new URL(server.signInUrl).searchParams.get('state');
    await service.update(server.id, update);
    await expect(service.complete({ state, code: 'old-code' })).rejects.toThrow(
      'This sign-in link has expired or was already used',
    );
    expect(remote.tokenRequests).toEqual([]);
  });

  it.each([['private_key_jwt'], ['client_secret_jwt'], ['private_key_jwt', 'client_secret_jwt']])(
    'explains unsupported token authentication methods %j before sign-in',
    async (...methods) => {
      const original = remote.fetch.getMockImplementation();
      remote.fetch.mockImplementation(async (url, init) => {
        const response = await original(url, init);
        if (String(url).includes('oauth-authorization-server'))
          return json({ ...(await response.json()), token_endpoint_auth_methods_supported: methods });
        return response;
      });
      const server = await service.create({
        name: 'meta',
        url: MCP,
        oauthClientId: 'client',
        oauthClientSecret: 'secret',
      });
      expect(server).toMatchObject({ status: 'error', signInUrl: null });
      expect(server.error).toContain('Unsupported OAuth token authentication methods: ' + methods.join(', '));
      expect(server.error).toContain('JWT authentication is not supported');
      expect(remote.tokenRequests).toEqual([]);
    },
  );

  it.each(['2025-03-26', '2025-06-18'])(
    'closes probe sessions with negotiated protocol %s',
    async (protocolVersion) => {
      const original = remote.fetch.getMockImplementation();
      remote.fetch.mockImplementation(async (url, init) => {
        const response = await original(url, init);
        if (String(url) === MCP && init.method === 'POST' && response.ok)
          return json({ jsonrpc: '2.0', id: 1, result: { protocolVersion } }, 200, {
            'mcp-session-id': 'sess-1',
          });
        return response;
      });
      await signIn(await service.create({ name: 'meta', url: MCP }));
      await Promise.resolve();
      const cleanup = remote.calls.filter((call) => call.method === 'DELETE');
      expect(cleanup).toHaveLength(1);
      const headers = new Headers(cleanup[0].headers);
      expect(headers.get('MCP-Protocol-Version')).toBe(protocolVersion);
      expect(headers.get('Mcp-Session-Id')).toBe('sess-1');
    },
  );

  // Hold one specific remote operation while a newer connection is installed.
  function delayNext(match) {
    const original = remote.fetch.getMockImplementation();
    let release, started;
    const waiting = new Promise((resolve) => {
      started = resolve;
    });
    const response = new Promise((resolve) => {
      release = resolve;
    });
    let held = false;
    remote.fetch.mockImplementation(async (url, init) => {
      if (!held && match(String(url), init)) {
        held = true;
        started();
        return response;
      }
      return original(url, init);
    });
    return { waiting, release };
  }

  it.each([200, 400, 401])(
    'rejects a stale refresh response (%s) without replacing a newer grant',
    async (status) => {
      const server = await signIn(await service.create({ name: 'meta', url: MCP }));
      const delayed = delayNext(
        (url, init) => url.endsWith('/token') && String(init.body).includes('refresh_token'),
      );
      const oldRequest = service.upstream(server.id, 'o/r', { force: true });
      const rejected = expect(oldRequest).rejects.toMatchObject({ status: 409 });
      await delayed.waiting;
      const movedUrl = 'https://other.example.com/mcp';
      const original = remote.fetch.getMockImplementation();
      remote.fetch.mockImplementation(async (url, init) => {
        const response = await original(String(url) === movedUrl ? MCP : url, init);
        if (String(url).includes('oauth-protected-resource') && response.ok)
          return json({ ...(await response.json()), resource: movedUrl });
        return response;
      });
      const moved = await service.update(server.id, { url: movedUrl });
      await signIn(moved);
      const current = await service.upstream(server.id, 'o/r');
      delayed.release(
        json(
          status === 200 ? { access_token: 'STALE', refresh_token: 'STALE' } : { error: 'invalid_grant' },
          status,
        ),
      );
      await rejected;
      expect(await service.upstream(server.id, 'o/r')).toEqual(current);
      expect(current.url).toBe(movedUrl);
      expect(service.list()[0]).toMatchObject({ signedIn: true, status: 'ready' });
    },
  );

  it.each([200, 400])('rejects stale callback results (%s) after a newer sign-in', async (status) => {
    const server = await service.create({ name: 'meta', url: MCP });
    const delayed = delayNext((url) => url.endsWith('/token'));
    const old = signIn(server);
    const rejected = expect(old).rejects.toMatchObject({ status: 409 });
    await delayed.waiting;
    await signIn(await service.connect(server.id, { signIn: true }));
    const current = await service.upstream(server.id, 'o/r');
    delayed.release(json(status === 200 ? { access_token: 'STALE' } : { error: 'invalid_grant' }, status));
    await rejected;
    expect(await service.upstream(server.id, 'o/r')).toEqual(current);
    expect(service.list()[0].status).toBe('ready');
  });

  it('discards stale discovery and its pending sign-in after an update', async () => {
    const server = await signIn(await service.create({ name: 'meta', url: MCP }));
    const delayed = delayNext((url) => url.includes('oauth-authorization-server'));
    const old = service.connect(server.id, { signIn: true });
    await delayed.waiting;
    await service.update(server.id, { transport: 'stdio', command: 'node' });
    delayed.release(
      json({
        authorization_endpoint: 'https://auth.example.com/authorize',
        token_endpoint: 'https://auth.example.com/token',
      }),
    );
    await old;
    expect(service.list()[0]).toMatchObject({
      transport: 'stdio',
      status: 'ready',
      auth: 'none',
      signInUrl: null,
    });
  });

  it('rejects pending states after the connection changes, before sending the code', async () => {
    const server = await service.create({ name: 'meta', url: MCP });
    await service.update(server.id, { transport: 'stdio', command: 'node' });
    await expect(signIn(server)).rejects.toThrow(/changed|expired/);
    expect(remote.tokenRequests).toEqual([]);
  });

  it.each([
    [{ repos: ['o/r', 'o/other'] }, true],
    [{ repos: ['o/other'] }, false],
    [{ enabled: false }, false],
    [{ enabled: true }, true],
    [{ headers: { 'X-Tenant': 'new' } }, true],
    [{ headers: {} }, true],
    [{ url: MCP }, true],
    [{ url: ' https://mcp.example.com/devtools ' }, true],
    [{ transport: 'http' }, true],
    [{ oauthClientId: '' }, true],
    [{ oauthClientSecret: '' }, true],
    [{ oauthScope: '' }, true],
    [{ oauthScope: 'expanded' }, true],
    [{ oauthClientName: 'New client' }, true],
    [{ oauthRedirect: 'loopback' }, true],
    [{ oauthClientSecret: 'new' }, true],
    [{ oauthClientName: '' }, true],
    [{ oauthRedirect: 'callback' }, true],
  ])('preserves a rotating refresh across grant-preserving update %j', async (update, allowed) => {
    const server = await signIn(
      await service.create({
        name: 'meta',
        url: MCP,
        ...(update.oauthClientSecret === 'new'
          ? { oauthClientId: 'explicit', oauthClientSecret: 'old' }
          : {}),
      }),
    );
    const original = remote.fetch.getMockImplementation();
    // The provider consumes R1 before the configuration update, then delays R2.
    const delayed = delayNext((url) => url.endsWith('/token'));
    const old = service.upstream(server.id, 'o/r', { force: true });
    const result = allowed
      ? expect(old).resolves.toMatchObject({ headers: { Authorization: 'Bearer access-2' } })
      : expect(old).rejects.toMatchObject({ status: 404 });
    await delayed.waiting;
    const rotated = await original('https://auth.example.com/token', {
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: 'refresh-1' }),
    });
    const updating = service.update(server.id, update);
    await vi.waitFor(() => {
      const stored = saved.find((s) => s.id === server.id);
      if (update.headers) expect(JSON.parse(open(stored.secrets)).headers).toEqual(update.headers);
      else if (Object.hasOwn(update, 'oauthClientSecret'))
        expect(JSON.parse(open(stored.secrets)).clientSecret).toBe(update.oauthClientSecret);
      else expect(stored).toMatchObject({ ...update, ...(update.url ? { url: MCP } : {}) });
    });
    delayed.release(rotated);
    await updating;
    await result;
    expect(service.list()[0].signedIn).toBe(true);
    if (!allowed) {
      expect(service.mounts('o/r')).toEqual([]);
      await expect(service.upstream(server.id, 'o/r')).rejects.toMatchObject({ status: 404 });
    }
    await service.update(server.id, { enabled: true, repos: ['o/r'] });
    expect((await service.upstream(server.id, 'o/r')).headers.Authorization).toBe('Bearer access-2');
    remote.fetch.mockImplementation((url, init) => {
      const params = new URLSearchParams(String(init.body));
      if (params.get('grant_type') === 'refresh_token' && params.get('refresh_token') !== 'refresh-2')
        return json({ error: 'invalid_grant' }, 400);
      return original(url, init);
    });
    expect((await service.upstream(server.id, 'o/r', { force: true })).headers.Authorization).toBe(
      'Bearer access-3',
    );
    expect(remote.tokenRequests.at(-1)).toMatchObject({ refresh_token: 'refresh-2' });
  });

  it('merges probe and cleanup headers case insensitively on the wire', async () => {
    const received = [];
    const upstream = createServer((req, res) => {
      received.push({ method: req.method, headers: req.headers });
      if (req.method === 'DELETE') return res.writeHead(204).end();
      if (req.headers['content-type'] !== 'application/json') return res.writeHead(415).end();
      res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'allocated' });
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          result: { protocolVersion: '2025-03-26' },
        }),
      );
    }).listen(0, '127.0.0.1');
    await new Promise((resolve) => upstream.once('listening', resolve));
    try {
      const realService = createMcpService({
        load: async () => [],
        save: async () => {},
        fetchImpl: fetch,
      });
      await realService.init();
      const row = await realService.create({
        name: 'strict',
        url: `http://127.0.0.1:${upstream.address().port}/mcp`,
        headers: {
          'content-type': 'text/plain',
          accept: 'text/plain',
          'mcp-protocol-version': 'old',
          'mcp-session-id': 'configured',
          'X-Api-Key': 'kept',
        },
      });
      expect(row.status).toBe('ready');
      await vi.waitFor(() => expect(received).toHaveLength(2));
      expect(received[0].headers).toMatchObject({
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': '2025-06-18',
        'x-api-key': 'kept',
      });
      expect(received[1]).toMatchObject({
        method: 'DELETE',
        headers: {
          'mcp-session-id': 'allocated',
          'mcp-protocol-version': '2025-03-26',
          'x-api-key': 'kept',
        },
      });
    } finally {
      await new Promise((resolve) => upstream.close(resolve));
    }
  });

  it('rejects setup and cleanup redirects without leaking custom credentials', async () => {
    const received = vi.fn((_req, res) => res.end('{}'));
    const destination = createServer(received).listen(0, '127.0.0.1');
    await new Promise((resolve) => destination.once('listening', resolve));
    let redirectProbe = true;
    const redirector = createServer((req, res) => {
      if (redirectProbe || req.method === 'DELETE') {
        res.writeHead(307, { Location: `http://127.0.0.1:${destination.address().port}/stolen` });
        res.end();
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Mcp-Session-Id': 'session' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }));
      }
    }).listen(0, '127.0.0.1');
    await new Promise((resolve) => redirector.once('listening', resolve));
    try {
      let cleanupFinished = false;
      const local = createMcpService({
        load: async () => [],
        save: async () => {},
        fetchImpl: async (url, init) => {
          try {
            return await fetch(url, init);
          } finally {
            if (init.method === 'DELETE') cleanupFinished = true;
          }
        },
      });
      await local.init();
      const server = await local.create({
        name: 'redirect',
        url: `http://127.0.0.1:${redirector.address().port}/mcp`,
        headers: { 'X-Api-Key': 'SECRET' },
      });
      expect(server.status).toBe('error');
      expect(received).not.toHaveBeenCalled();
      redirectProbe = false;
      expect((await local.connect(server.id)).status).toBe('ready');
      // Wait for the fire-and-forget cleanup request to finish.
      await vi.waitFor(() => expect(cleanupFinished).toBe(true));
      expect(received).not.toHaveBeenCalled();
    } finally {
      redirector.close();
      destination.close();
    }
  });

  it.each(['resource metadata', 'authorization server', 'metadata issuer'])(
    'rejects insecure %s before trusting endpoints',
    async (source) => {
      const original = remote.fetch.getMockImplementation();
      remote.fetch.mockImplementation(async (url, init) => {
        const response = await original(url, init);
        if (source === 'resource metadata' && String(url) === MCP)
          return new Response(null, {
            status: 401,
            headers: { 'WWW-Authenticate': 'Bearer resource_metadata="http://metadata.test/resource"' },
          });
        if (source === 'authorization server' && String(url).includes('oauth-protected-resource'))
          return json({ resource: MCP, authorization_servers: ['http://metadata.test/issuer'] });
        if (source === 'metadata issuer' && String(url).includes('oauth-authorization-server')) {
          const meta = await response.json();
          return json({ ...meta, issuer: 'http://metadata.test/issuer' });
        }
        return response;
      });
      const server = await service.create({
        name: 'meta',
        url: MCP,
        oauthClientId: 'client',
        oauthClientSecret: 'SECRET',
      });
      expect(server).toMatchObject({ status: 'error', signInUrl: null });
      expect(server.error).toMatch(/https/);
      expect(remote.calls.some((call) => call.url.startsWith('http://metadata.test'))).toBe(false);
      expect(remote.tokenRequests).toEqual([]);
    },
  );

  it.each(['oauth-protected-resource', 'oauth-authorization-server'])(
    'rejects redirects from %s instead of trusting substituted metadata',
    async (source) => {
      const original = remote.fetch.getMockImplementation();
      remote.fetch.mockImplementation((url, init) => {
        if (String(url).includes(source)) {
          expect(init.redirect).toBe('manual');
          return new Response(null, { status: 307, headers: { Location: 'http://metadata.test/stolen' } });
        }
        return original(url, init);
      });
      const server = await service.create({ name: 'meta', url: MCP });
      expect(server).toMatchObject({ status: 'error', signInUrl: null });
      expect(server.error).toMatch(/metadata redirects/);
      expect(remote.registrations).toBe(0);
      expect(remote.tokenRequests).toEqual([]);
    },
  );

  it('allows loopback HTTP resource and issuer metadata', async () => {
    const original = remote.fetch.getMockImplementation();
    remote.fetch.mockImplementation(async (url, init) => {
      if (String(url) === MCP)
        return new Response(null, {
          status: 401,
          headers: { 'WWW-Authenticate': 'Bearer resource_metadata="http://localhost/resource"' },
        });
      if (String(url) === 'http://localhost/resource')
        return json({ resource: MCP, authorization_servers: ['http://127.0.0.1:9000'] });
      if (String(url) === 'http://127.0.0.1:9000/.well-known/oauth-authorization-server')
        return json({
          issuer: 'http://127.0.0.1:9000',
          authorization_endpoint: 'http://localhost/authorize',
          token_endpoint: 'http://localhost/token',
        });
      return original(url, init);
    });
    const server = await service.create({ name: 'local', url: MCP, oauthClientId: 'client' });
    expect(server.status).toBe('needs-sign-in');
    expect(new URL(server.signInUrl).origin).toBe('http://localhost');
  });

  it.each([false, true])('reconnects using custom resource metadata (restart: %s)', async (restart) => {
    const metadataUrl = 'https://mcp.example.com/custom/resource';
    const wellKnown = 'https://mcp.example.com/.well-known/oauth-protected-resource/devtools';
    const original = remote.fetch.getMockImplementation();
    remote.fetch.mockImplementation(async (url, init) => {
      if (String(url) === metadataUrl) return original(wellKnown, init);
      if (String(url).includes('/.well-known/oauth-protected-resource'))
        return new Response(null, { status: 404 });
      const response = await original(url, init);
      if (String(url) === MCP && response.status === 401)
        return new Response(null, {
          status: 401,
          headers: {
            'WWW-Authenticate': `Basic realm="legacy", Bearer resource_metadata="${metadataUrl}", scope="read manage"`,
          },
        });
      return response;
    });
    const server = await signIn(await service.create({ name: 'meta', url: MCP }));
    if (restart) {
      service = createMcpService({
        load: async () => saved,
        save: async (_name, value) => {
          saved = value;
        },
        fetchImpl: remote.fetch,
        callbackUrl: () => CALLBACK,
        now: () => clock,
      });
      await service.init();
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      const next = await service.connect(server.id, { signIn: true });
      expect(next).toMatchObject({ status: 'needs-sign-in', error: '' });
      const url = new URL(next.signInUrl);
      expect(url.origin + url.pathname).toBe('https://auth.example.com/dialog/oauth');
      expect(url.searchParams.get('scope')).toBe('read manage');
      expect(url.searchParams.get('client_id')).toBe('client-1');
      expect(await signIn(next)).toMatchObject({ signedIn: true, status: 'ready' });
    }
    expect(remote.registrations).toBe(1);
    expect(service.mounts('o/r')).toHaveLength(1);
  });

  it('re-registers dynamic clients for changed scopes and reuses them for the same scope', async () => {
    const scopes = new Map();
    const original = remote.fetch.getMockImplementation();
    remote.fetch.mockImplementation(async (url, init) => {
      const response = await original(url, init);
      if (String(url).endsWith('/register')) {
        const client = await response.clone().json();
        scopes.set(client.client_id, JSON.parse(init.body).scope);
      }
      if (String(url).endsWith('/token')) {
        const params = new URLSearchParams(String(init.body));
        if (scopes.get(params.get('client_id')) !== service.list()[0].oauthScope)
          return json({ error: 'invalid_scope' }, 400);
      }
      return response;
    });
    const server = await signIn(await service.create({ name: 'meta', url: MCP, oauthScope: 'read' }));
    await service.update(server.id, { oauthScope: 'read write' });
    const next = await service.connect(server.id, { signIn: true });
    expect(remote.registrations).toBe(2);
    expect(remote.lastRegistration.scope).toBe('read write');
    expect(new URL(next.signInUrl).searchParams.get('client_id')).toBe('client-2');
    expect(await signIn(next)).toMatchObject({ signedIn: true, status: 'ready' });
    expect(service.mounts('o/r')).toHaveLength(1);
    await signIn(await service.connect(server.id, { signIn: true }));
    expect(remote.registrations).toBe(2);
  });

  it.each(['token_endpoint', 'authorization_endpoint', 'registration_endpoint'])(
    'refuses insecure discovered %s before using credentials',
    async (field) => {
      const original = remote.fetch.getMockImplementation();
      remote.fetch.mockImplementation(async (url, init) => {
        const response = await original(url, init);
        if (String(url).includes('oauth-authorization-server')) {
          const metadata = await response.json();
          metadata[field] = 'http://remote.test/endpoint';
          return json(metadata);
        }
        return response;
      });
      const server = await service.create({
        name: 'meta',
        url: MCP,
        oauthClientId: 'client',
        oauthClientSecret: 'SECRET',
      });
      expect(server).toMatchObject({ status: 'error', signInUrl: null });
      expect(server.error).toMatch(/https/);
      expect(remote.calls.some((call) => call.url.startsWith('http://remote.test'))).toBe(false);
      expect(remote.tokenRequests).toEqual([]);
    },
  );

  it('allows a local development token endpoint and disables token redirects', async () => {
    const original = remote.fetch.getMockImplementation();
    remote.fetch.mockImplementation(async (url, init) => {
      if (String(url) === 'http://127.0.0.1:9000/token') {
        expect(init.redirect).toBe('error');
        return original('https://auth.example.com/token', init);
      }
      const response = await original(url, init);
      if (String(url).includes('oauth-authorization-server')) {
        const metadata = await response.json();
        metadata.token_endpoint = 'http://127.0.0.1:9000/token';
        return json(metadata);
      }
      return response;
    });
    expect(await signIn(await service.create({ name: 'meta', url: MCP }))).toMatchObject({
      signedIn: true,
      status: 'ready',
    });
  });

  it.each([false, true])('switches to a static Authorization header (signed in: %s)', async (signedIn) => {
    let server = await service.create({ name: 'meta', url: MCP });
    if (signedIn) server = await signIn(server);
    remote.valid = 'API';
    const updated = await service.update(server.id, { headers: { authorization: 'Bearer API' } });
    expect(updated).toMatchObject({ auth: 'none', signedIn: false, status: 'ready', signInUrl: null });
    expect(service.mounts('o/r')).toHaveLength(1);
    expect((await service.upstream(server.id, 'o/r')).headers).toEqual({ authorization: 'Bearer API' });
  });

  it('preserves OAuth when only unrelated headers change', async () => {
    const server = await signIn(await service.create({ name: 'meta', url: MCP }));
    expect(await service.update(server.id, { headers: { 'X-Extra': 'value' } })).toMatchObject({
      auth: 'oauth',
      signedIn: true,
    });
    expect((await service.upstream(server.id, 'o/r')).headers).toEqual({
      'X-Extra': 'value',
      Authorization: 'Bearer access-1',
    });
  });

  it.each(['client_secret_basic', 'client_secret_post', 'none'])(
    'rotates the explicit client secret with %s authentication',
    async (method) => {
      const original = remote.fetch.getMockImplementation();
      remote.fetch.mockImplementation(async (url, init) => {
        const response = await original(url, init);
        if (String(url).includes('oauth-authorization-server')) {
          const metadata = await response.json();
          metadata.token_endpoint_auth_methods_supported = [
            method === 'none' ? 'client_secret_basic' : method,
          ];
          return json(metadata);
        }
        return response;
      });
      const server = await signIn(
        await service.create({ name: 'meta', url: MCP, oauthClientId: 'client', oauthClientSecret: 'old' }),
      );
      await service.update(server.id, { oauthClientSecret: method === 'none' ? '' : 'new' });
      await service.upstream(server.id, 'o/r', { force: true });
      const request = remote.calls.filter((call) => call.url.endsWith('/token')).at(-1);
      const form = new URLSearchParams(request.body);
      if (method === 'client_secret_basic')
        expect(request.headers.Authorization).toBe(`Basic ${Buffer.from('client:new').toString('base64')}`);
      else expect(request.headers.Authorization).toBeUndefined();
      expect(form.get('client_secret')).toBe(method === 'client_secret_post' ? 'new' : null);
    },
  );

  it.each(['client_secret_basic', 'client_secret_post'])(
    'preserves the exact explicit secret for %s on sign-in and rotation',
    async (method) => {
      const original = remote.fetch.getMockImplementation();
      remote.fetch.mockImplementation(async (url, init) => {
        const response = await original(url, init);
        if (String(url).includes('oauth-authorization-server')) {
          const metadata = await response.json();
          return json({ ...metadata, token_endpoint_auth_methods_supported: [method] });
        }
        return response;
      });
      const server = await signIn(
        await service.create({
          name: 'meta',
          url: MCP,
          oauthClientId: 'client',
          oauthClientSecret: ' secret ',
        }),
      );
      for (const secret of [' secret ', ' rotated ']) {
        if (secret === ' rotated ') {
          await service.update(server.id, { oauthClientSecret: secret });
          await service.upstream(server.id, 'o/r', { force: true });
        }
        const request = remote.calls.filter((call) => call.url.endsWith('/token')).at(-1);
        if (method === 'client_secret_basic') {
          const basic = Buffer.from(request.headers.Authorization.slice(6), 'base64').toString();
          expect(decodeURIComponent(basic.split(':')[1])).toBe(secret);
        } else expect(new URLSearchParams(request.body).get('client_secret')).toBe(secret);
      }
    },
  );

  it.each(['x'.repeat(1025), 'secret\n', '\tsecret', 'secret\0'])(
    'rejects invalid client secrets without trimming them: %j',
    async (secret) => {
      await expect(
        service.create({
          name: 'meta',
          url: MCP,
          oauthClientSecret: secret,
        }),
      ).rejects.toThrow(/too long or has control characters/);
    },
  );

  it('does not replace a dynamically registered client secret with the explicit secret field', async () => {
    const server = await signIn(await service.create({ name: 'meta', url: MCP }));
    await service.update(server.id, { oauthClientSecret: 'unrelated' });
    await service.upstream(server.id, 'o/r', { force: true });
    expect(
      remote.calls.filter((call) => call.url.endsWith('/token')).at(-1).headers.Authorization,
    ).toBeUndefined();
  });

  it.each(['json', 'sse'])('reports JSON-RPC initialize errors over %s', async (format) => {
    const original = remote.fetch.getMockImplementation();
    remote.fetch.mockImplementation((url, init) => {
      if (String(url) === MCP && init.method === 'POST') {
        const message = { jsonrpc: '2.0', id: 1, error: { code: -32602, message: 'unsupported version' } };
        return format === 'json'
          ? json(message)
          : new Response(`event: message\ndata: ${JSON.stringify(message)}\n\n`, {
              headers: { 'content-type': 'text/event-stream' },
            });
      }
      return original(url, init);
    });
    const server = await service.create({ name: 'meta', url: MCP });
    expect(server).toMatchObject({ status: 'error', error: 'Initialize failed: unsupported version' });
  });

  it('reads a chunked SSE result without waiting for the stream to close', async () => {
    const cancelled = vi.fn();
    remote.fetch.mockResolvedValue(
      new Response(
        new ReadableStream({
          start(controller) {
            const encoder = new TextEncoder();
            controller.enqueue(encoder.encode(': ping\n\nevent: message\ndata: {"jsonrpc":"2.0","id":'));
            controller.enqueue(encoder.encode('1,"result":{}}\n\n'));
          },
          cancel: cancelled,
        }),
        { headers: { 'content-type': 'text/event-stream' } },
      ),
    );
    expect(await service.create({ name: 'meta', url: MCP })).toMatchObject({ status: 'ready' });
    expect(cancelled).toHaveBeenCalled();
  });

  it('bounds initialize response size and rejects malformed JSON', async () => {
    remote.fetch.mockResolvedValueOnce(json({ padding: 'x'.repeat(65536) }));
    expect((await service.create({ name: 'large', url: MCP })).error).toMatch(/too large/);
    remote.fetch.mockResolvedValueOnce(new Response('bad JSON'));
    expect((await service.create({ name: 'invalid', url: MCP })).status).toBe('error');
  });

  it('times out and cancels an initialize stream that never responds', async () => {
    vi.useFakeTimers();
    try {
      const cancelled = vi.fn();
      remote.fetch.mockResolvedValue(
        new Response(new ReadableStream({ cancel: cancelled }), {
          headers: { 'content-type': 'text/event-stream' },
        }),
      );
      const pending = service.create({ name: 'meta', url: MCP });
      await vi.advanceTimersByTimeAsync(15000);
      expect(await pending).toMatchObject({
        status: 'error',
        error: 'Initialize failed: The initialize response timed out',
      });
      expect(cancelled).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('preserves own __proto__ entries in env and header maps', async () => {
    const values = JSON.parse('{"__proto__":"value","OTHER":"kept"}');
    const local = await service.create({ name: 'local', transport: 'stdio', command: 'node', env: values });
    expect(local.envNames).toEqual(['__proto__', 'OTHER']);
    expect(service.mounts('o/r')[0].env).toEqual(values);
    remote.fetch.mockResolvedValueOnce(json({ jsonrpc: '2.0', id: 1, result: {} }));
    const server = await service.create({ name: 'meta', url: MCP, headers: values });
    expect(server.headerNames).toEqual(['__proto__', 'OTHER']);
    expect((await service.upstream(server.id, 'o/r')).headers).toMatchObject(values);
  });

  it('reuses the current bearer when a late 401 rejects the previous one', async () => {
    const server = await signIn(await service.create({ name: 'meta', url: MCP }));
    const old = await service.upstream(server.id, 'o/r');
    const fresh = await service.upstream(server.id, 'o/r', {
      force: true,
      rejectedBearer: old.headers.Authorization,
    });
    expect(
      await service.upstream(server.id, 'o/r', { force: true, rejectedBearer: old.headers.Authorization }),
    ).toEqual(fresh);
    expect(remote.tokenRequests).toHaveLength(2);
    await service.upstream(server.id, 'o/r', { force: true, rejectedBearer: fresh.headers.Authorization });
    expect(remote.tokenRequests).toHaveLength(3);
  });
});
