import express from 'express';
import { createServer } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mcpRoutes, mcpProxyRouter, mcpOAuthCallbackRouter } from '../lib/mcp-routes.js';
import { agentOnly } from '../lib/auth.js';

vi.mock('../lib/config.js', () => ({ getConfig: () => ({ credentialsKey: 'k'.repeat(32) }) }));

let server, base, service, upstream, job;
beforeEach(async () => {
  job = { id: 'one', repo: 'o/r' };
  upstream = vi.fn();
  service = {
    list: vi.fn(() => []),
    create: vi.fn(async (input) => ({ id: 1, ...input })),
    connect: vi.fn(async (id, opts) => ({ id, opts })),
    finishSignIn: vi.fn(async (id, url) => ({ id, url })),
    upstream: vi.fn(async (_id, _repo, opts) => ({
      url: 'https://remote.example/mcp',
      headers: { Authorization: opts?.force ? 'Bearer fresh' : 'Bearer stale' },
      oauth: true,
    })),
    complete: vi.fn(),
  };
  const agentSession = (req, res) => {
    if (req.headers.authorization === 'Bearer session-token') return job;
    res.status(401).json({ error: 'Unknown session token' });
    return null;
  };
  const app = express();
  app.use(mcpOAuthCallbackRouter({ service }));
  app.use(mcpProxyRouter({ service, agentSession, fetchImpl: upstream }));
  app.use(express.json());
  const routes = mcpRoutes({ service, getProject: (repo) => (repo === 'o/r' ? { repo } : null) });
  // The operator reaches these through /api/v1 (a header stands in for the
  // gateway here); an agent only reaches /api/agent/*.
  app.use((req, res, next) =>
    req.headers['x-test-operator'] ? routes(req, res, next) : agentOnly(routes)(req, res, next),
  );
  app.use('/api', (req, res) => res.status(410).json({ error: 'retired' }));
  server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
afterEach(() => server.close());

const rpc = { jsonrpc: '2.0', id: 7, method: 'tools/list' };

describe('the session proxy', () => {
  it('forwards the transport’s headers and body with the remote’s token, never the session’s', async () => {
    upstream.mockResolvedValue(
      new Response('{"jsonrpc":"2.0","id":7,"result":{"tools":[]}}', {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'mcp-session-id': 'abc',
          'www-authenticate': 'Bearer x',
        },
      }),
    );
    const res = await fetch(`${base}/api/agent/mcp/5`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer session-token',
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'Mcp-Session-Id': 'abc',
        Cookie: 'nope',
      },
      body: JSON.stringify(rpc),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('mcp-session-id')).toBe('abc');
    expect(res.headers.get('www-authenticate')).toBeNull();
    expect(await res.json()).toEqual({ jsonrpc: '2.0', id: 7, result: { tools: [] } });
    expect(service.upstream).toHaveBeenCalledWith(5, 'o/r');
    const [url, init] = upstream.mock.calls[0];
    expect(url).toBe('https://remote.example/mcp');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body.toString())).toEqual(rpc);
    expect(init.headers).toEqual({
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      'mcp-session-id': 'abc',
      authorization: 'Bearer stale',
    });
  });

  it('overwrites configured transport headers case insensitively on both attempts', async () => {
    const received = [];
    const remote = createServer((req, res) => {
      received.push(req.headers);
      res.writeHead(
        received.length === 1 ? 401 : req.headers['content-type'] === 'application/json' ? 200 : 415,
      );
      res.end('{}');
    }).listen(0, '127.0.0.1');
    await new Promise((resolve) => remote.once('listening', resolve));
    try {
      service.upstream.mockImplementation(async (_id, _repo, opts) => ({
        url: `http://127.0.0.1:${remote.address().port}/mcp`,
        headers: {
          'Content-Type': 'application/json',
          Authorization: opts?.force ? 'Bearer fresh' : 'Bearer stale',
        },
        oauth: true,
      }));
      upstream.mockImplementation(fetch);
      const res = await fetch(`${base}/api/agent/mcp/5`, {
        method: 'POST',
        headers: { Authorization: 'Bearer session-token', 'content-type': 'text/plain' },
        body: JSON.stringify(rpc),
      });
      expect(res.status).toBe(200);
      expect(received).toHaveLength(2);
      expect(received.map((h) => h['content-type'])).toEqual(['application/json', 'application/json']);
      expect(received.map((h) => h.authorization)).toEqual(['Bearer stale', 'Bearer fresh']);
    } finally {
      remote.close();
    }
  });

  it('rejects redirects without forwarding custom credentials to another origin', async () => {
    const received = vi.fn((_req, res) => res.end('{}'));
    const destination = createServer(received).listen(0, '127.0.0.1');
    await new Promise((resolve) => destination.once('listening', resolve));
    const redirector = createServer((_req, res) => {
      res.writeHead(307, { Location: `http://127.0.0.1:${destination.address().port}/stolen` });
      res.end();
    }).listen(0, '127.0.0.1');
    await new Promise((resolve) => redirector.once('listening', resolve));
    try {
      service.upstream.mockResolvedValue({
        url: `http://127.0.0.1:${redirector.address().port}/mcp`,
        headers: { 'X-Api-Key': 'SECRET' },
        oauth: false,
      });
      upstream.mockImplementation(fetch);
      const res = await fetch(`${base}/api/agent/mcp/5`, {
        method: 'POST',
        headers: { Authorization: 'Bearer session-token' },
        body: JSON.stringify(rpc),
      });
      expect(res.ok).toBe(false);
      expect(await res.json()).toMatchObject({ error: expect.any(String) });
      expect(received).not.toHaveBeenCalled();
    } finally {
      redirector.close();
      destination.close();
    }
  });

  it('refreshes once and retries when the remote refuses the token', async () => {
    upstream
      .mockResolvedValueOnce(new Response('no', { status: 401 }))
      .mockResolvedValueOnce(
        new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }),
      );
    const res = await fetch(`${base}/api/agent/mcp/5`, {
      method: 'POST',
      headers: { Authorization: 'Bearer session-token', 'Content-Type': 'application/json' },
      body: JSON.stringify(rpc),
    });
    expect(res.status).toBe(200);
    expect(service.upstream).toHaveBeenLastCalledWith(5, 'o/r', {
      force: true,
      rejectedBearer: 'Bearer stale',
    });
    expect(upstream.mock.calls.every(([, init]) => init.redirect === 'error')).toBe(true);
    expect(upstream.mock.calls[1][1].headers.authorization).toBe('Bearer fresh');
    expect(upstream.mock.calls[1][1].body.toString()).toBe(JSON.stringify(rpc));
  });

  it('streams an event stream through as it comes', async () => {
    const enc = new TextEncoder();
    let push;
    const body = new ReadableStream({
      start(c) {
        push = c;
        c.enqueue(enc.encode('event: message\ndata: {"a":1}\n\n'));
      },
    });
    upstream.mockResolvedValue(
      new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    );
    const res = await fetch(`${base}/api/agent/mcp/5`, {
      headers: { Authorization: 'Bearer session-token' },
    });
    expect(res.headers.get('content-type')).toBe('text/event-stream');
    expect(upstream.mock.calls[0][1]).toMatchObject({ method: 'GET', body: undefined });
    const reader = res.body.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe('event: message\ndata: {"a":1}\n\n');
    push.close();
    await reader.cancel();
  });

  it('turns away a request without a session token, or for a server the project does not mount', async () => {
    expect((await fetch(`${base}/api/agent/mcp/5`, { method: 'POST' })).status).toBe(401);
    service.upstream.mockRejectedValueOnce(
      Object.assign(new Error('MCP server unavailable for this project'), { status: 404 }),
    );
    const res = await fetch(`${base}/api/agent/mcp/9`, {
      method: 'POST',
      headers: { Authorization: 'Bearer session-token' },
    });
    expect(res.status).toBe(404);
    expect(upstream).not.toHaveBeenCalled();
  });
});

describe('the sign-in redirect', () => {
  it('says the server is connected', async () => {
    service.complete.mockResolvedValue({ label: 'Meta', status: 'ready' });
    const res = await fetch(`${base}/webhooks/mcp-oauth/callback?state=s&code=c`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^text\/plain/);
    expect(await res.text()).toMatch(/^Meta is connected to Briareus/);
    expect(service.complete).toHaveBeenCalledWith({ state: 's', code: 'c' });
  });

  it('says why it failed', async () => {
    service.complete.mockRejectedValue(
      Object.assign(new Error('This sign-in link has expired'), { status: 400 }),
    );
    const res = await fetch(`${base}/webhooks/mcp-oauth/callback?state=x`);
    expect(res.status).toBe(400);
    expect(await res.text()).toBe('This sign-in link has expired');
  });
});

describe('the operator routes', () => {
  it('are reached by the operator and checks the projects named', async () => {
    const post = (body) =>
      fetch(`${base}/api/mcp/servers`, {
        method: 'POST',
        headers: { 'x-test-operator': '1', 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    expect((await post({ name: 'm', repos: ['o/r'] })).status).toBe(201);
    const bad = await post({ name: 'm', repos: ['o/x'] });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: 'o/x is not a project' });
    const connect = await fetch(`${base}/api/mcp/servers/3/connect`, {
      method: 'POST',
      headers: { 'x-test-operator': '1', 'Content-Type': 'application/json' },
      body: JSON.stringify({ signIn: true }),
    });
    expect(await connect.json()).toEqual({ server: { id: 3, opts: { signIn: true } } });
  });

  it('take the pasted address of a loopback sign-in', async () => {
    const res = await fetch(`${base}/api/mcp/servers/3/finish-sign-in`, {
      method: 'POST',
      headers: { 'x-test-operator': '1', 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'http://127.0.0.1:1/callback?code=c&state=s' }),
    });
    expect(await res.json()).toEqual({
      server: { id: 3, url: 'http://127.0.0.1:1/callback?code=c&state=s' },
    });
  });

  it('are never reached with a session token', async () => {
    const res = await fetch(`${base}/api/mcp/servers`, {
      headers: { 'x-test-operator': '1', Authorization: 'Bearer session-token' },
    });
    expect(res.status).toBe(403);
    expect((await fetch(`${base}/api/mcp/servers`)).status).toBe(410);
  });
});
