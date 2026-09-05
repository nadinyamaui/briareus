import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// memory-mcp.js is a stdio server, not a module: it exports nothing and wires
// itself to stdin at import. The tests drive it the way a provider CLI does:
// mock readline to capture the line handler, feed it JSON-RPC frames, and read
// the replies off a stubbed stdout. BASE and TOKEN are read at import time, so
// every test imports a fresh copy.
const rl = vi.hoisted(() => ({ handlers: {} }));

vi.mock('readline', () => ({
  default: {
    createInterface: () => ({
      on: (event, fn) => {
        rl.handlers[event] = fn;
      },
    }),
  },
}));

const URL_BASE = 'https://reviewer.test';
const TOKEN = 'session-token';

let written;
let exited;

// Boot the server with the given environment and hand back a driver.
async function boot({ base = URL_BASE, token = TOKEN } = {}) {
  process.env.REVIEWER_MEMORY_URL = base;
  process.env.REVIEWER_MEMORY_TOKEN = token;
  rl.handlers = {};
  vi.resetModules();
  await import('../lib/memory-mcp.js');
  return {
    // Feed one line in and return every frame written in response.
    async line(text) {
      written = [];
      await rl.handlers.line(text);
      // handle() is async and the line handler does not await it, so give the
      // microtask queue a turn before reading what came back.
      await new Promise((r) => setTimeout(r, 0));
      return written.map((w) => JSON.parse(w));
    },
    async send(req) {
      return this.line(JSON.stringify(req));
    },
    close: () => rl.handlers.close(),
  };
}

// A fetch stub returning one canned reply per call, in order.
function stubFetch(...replies) {
  const fn = vi.fn(async () => {
    const next = replies.shift();
    if (!next) throw new Error('unexpected extra fetch');
    return next;
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

function reply({ status = 200, body = {}, jsonThrows = false } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => {
      if (jsonThrows) throw new Error('not json');
      return body;
    },
  };
}

beforeEach(() => {
  written = [];
  exited = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((s) => {
    written.push(s);
    return true;
  });
  vi.spyOn(process, 'exit').mockImplementation((c) => {
    exited.push(c);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete process.env.REVIEWER_MEMORY_URL;
  delete process.env.REVIEWER_MEMORY_TOKEN;
});

describe('the JSON-RPC frame', () => {
  it('answers initialize with the protocol version asked for', async () => {
    const s = await boot();

    const [res] = await s.send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18' },
    });

    expect(res).toEqual({
      jsonrpc: '2.0',
      id: 1,
      result: {
        protocolVersion: '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'reviewer-memory', version: '1.0.0' },
      },
    });
  });

  it('falls back to the 2024-11-05 protocol when none is named', async () => {
    const s = await boot();

    const [res] = await s.send({ jsonrpc: '2.0', id: 1, method: 'initialize' });

    expect(res.result.protocolVersion).toBe('2024-11-05');
  });

  it('answers ping with an empty result', async () => {
    const s = await boot();

    const [res] = await s.send({ jsonrpc: '2.0', id: 2, method: 'ping' });

    expect(res).toEqual({ jsonrpc: '2.0', id: 2, result: {} });
  });

  it('lists the four memory tools', async () => {
    const s = await boot();

    const [res] = await s.send({ jsonrpc: '2.0', id: 3, method: 'tools/list' });

    expect(res.result.tools.map((t) => t.name)).toEqual([
      'memory_save',
      'memory_list',
      'memory_read',
      'memory_delete',
    ]);
  });

  it('marks name and body as the required arguments of a save', async () => {
    const s = await boot();

    const [res] = await s.send({ jsonrpc: '2.0', id: 3, method: 'tools/list' });

    expect(res.result.tools[0].inputSchema.required).toEqual(['name', 'body']);
  });

  it('answers an unknown method with -32601', async () => {
    const s = await boot();

    const [res] = await s.send({ jsonrpc: '2.0', id: 4, method: 'resources/list' });

    expect(res).toEqual({
      jsonrpc: '2.0',
      id: 4,
      error: { code: -32601, message: 'Method not found: resources/list' },
    });
  });

  it('answers unparseable input with -32700 and no id', async () => {
    const s = await boot();

    const [res] = await s.line('{not json');

    expect(res).toEqual({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
  });

  it('says nothing at all to a blank line', async () => {
    const s = await boot();

    expect(await s.line('   ')).toEqual([]);
  });

  it('says nothing to a notification, which carries no id', async () => {
    const s = await boot();

    expect(await s.send({ jsonrpc: '2.0', method: 'notifications/initialized' })).toEqual([]);
  });

  it('exits cleanly when the CLI closes the pipe', async () => {
    const s = await boot();

    s.close();

    expect(exited).toEqual([0]);
  });
});

describe('the memory tools', () => {
  const callTool = (name, args) => ({
    jsonrpc: '2.0',
    id: 9,
    method: 'tools/call',
    params: { name, arguments: args },
  });

  it('saves a memory and says what it saved', async () => {
    const s = await boot();
    const fetchMock = stubFetch(
      reply({
        body: { memory: { name: 'prefers-small-prs', type: 'feedback', description: 'keep PRs small' } },
      }),
    );

    const [res] = await s.send(callTool('memory_save', { name: 'prefers-small-prs', body: 'x' }));

    expect(res.result.content[0].text).toBe('Saved memory prefers-small-prs (feedback): keep PRs small');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://reviewer.test/api/agent/memories');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer session-token');
    expect(JSON.parse(init.body)).toEqual({ name: 'prefers-small-prs', body: 'x' });
  });

  it('leaves the dash off a memory with no description', async () => {
    const s = await boot();
    stubFetch(reply({ body: { memory: { name: 'n', type: 'user' } } }));

    const [res] = await s.send(callTool('memory_save', { name: 'n', body: 'b' }));

    expect(res.result.content[0].text).toBe('Saved memory n (user)');
  });

  it('lists what is saved, one per line', async () => {
    const s = await boot();
    stubFetch(
      reply({
        body: {
          memories: [
            { name: 'a', type: 'user', description: 'one' },
            { name: 'b', type: 'project', description: 'two' },
          ],
        },
      }),
    );

    const [res] = await s.send(callTool('memory_list', {}));

    expect(res.result.content[0].text).toBe('a (user): one\nb (project): two');
  });

  it('says so plainly when nothing is saved yet', async () => {
    const s = await boot();
    stubFetch(reply({ body: { memories: [] } }));

    const [res] = await s.send(callTool('memory_list', {}));

    expect(res.result.content[0].text).toBe('No memories saved for this project yet.');
  });

  it('reads one memory in full', async () => {
    const s = await boot();
    const fetchMock = stubFetch(
      reply({ body: { memory: { name: 'a', type: 'user', description: 'one', body: 'the fact' } } }),
    );

    const [res] = await s.send(callTool('memory_read', { name: 'a' }));

    expect(res.result.content[0].text).toBe('# a (user): one\n\nthe fact');
    expect(fetchMock.mock.calls[0][0]).toBe('https://reviewer.test/api/agent/memories/a');
  });

  it('escapes a name that would otherwise change the path', async () => {
    const s = await boot();
    const fetchMock = stubFetch(reply({ body: { memory: { name: 'a/b', type: 'user', body: '' } } }));

    await s.send(callTool('memory_read', { name: 'a/b' }));

    expect(fetchMock.mock.calls[0][0]).toBe('https://reviewer.test/api/agent/memories/a%2Fb');
  });

  it('reads an unnamed memory as the empty name rather than undefined', async () => {
    const s = await boot();
    const fetchMock = stubFetch(reply({ body: { memory: { name: '', type: 'user', body: '' } } }));

    await s.send(callTool('memory_read', {}));

    expect(fetchMock.mock.calls[0][0]).toBe('https://reviewer.test/api/agent/memories/');
  });

  it('deletes a memory by name', async () => {
    const s = await boot();
    const fetchMock = stubFetch(reply({ body: {} }));

    const [res] = await s.send(callTool('memory_delete', { name: 'gone' }));

    expect(res.result.content[0].text).toBe('Deleted memory gone');
    expect(fetchMock.mock.calls[0][1].method).toBe('DELETE');
  });

  it('deletes an unnamed memory as the empty name rather than undefined', async () => {
    const s = await boot();
    const fetchMock = stubFetch(reply({ body: {} }));

    await s.send(callTool('memory_delete', {}));

    expect(fetchMock.mock.calls[0][0]).toBe('https://reviewer.test/api/agent/memories/');
  });

  it('sends no body on a read', async () => {
    const s = await boot();
    const fetchMock = stubFetch(reply({ body: { memories: [] } }));

    await s.send(callTool('memory_list', {}));

    expect(fetchMock.mock.calls[0][1].body).toBeUndefined();
  });

  it('defaults the arguments to none when the caller sends none', async () => {
    const s = await boot();
    stubFetch(reply({ body: { memories: [] } }));

    const [res] = await s.send({
      jsonrpc: '2.0',
      id: 9,
      method: 'tools/call',
      params: { name: 'memory_list' },
    });

    expect(res.result.isError).toBeUndefined();
  });
});

describe('when a tool cannot do its job', () => {
  const callTool = (name, args = {}) => ({
    jsonrpc: '2.0',
    id: 9,
    method: 'tools/call',
    params: { name, arguments: args },
  });

  it('reports an unknown tool as a tool error, not a protocol one', async () => {
    // The CLI should see this and try something else, not drop the connection.
    const s = await boot();

    const [res] = await s.send(callTool('memory_burn'));

    expect(res.result).toEqual({
      content: [{ type: 'text', text: 'Error: Unknown tool memory_burn' }],
      isError: true,
    });
  });

  it('says it is not configured when the session gave it no URL', async () => {
    const s = await boot({ base: '' });

    const [res] = await s.send(callTool('memory_list'));

    expect(res.result.content[0].text).toBe('Error: The memory tool is not configured for this session');
  });

  it('says it is not configured when the session gave it no token', async () => {
    const s = await boot({ token: '' });

    const [res] = await s.send(callTool('memory_list'));

    expect(res.result.isError).toBe(true);
  });

  it('strips trailing slashes off the dashboard URL', async () => {
    const s = await boot({ base: 'https://reviewer.test///' });
    const fetchMock = stubFetch(reply({ body: { memories: [] } }));

    await s.send(callTool('memory_list'));

    expect(fetchMock.mock.calls[0][0]).toBe('https://reviewer.test/api/agent/memories');
  });

  it('passes the dashboard error message through', async () => {
    const s = await boot();
    stubFetch(reply({ status: 404, body: { error: 'No memory called gone' } }));

    const [res] = await s.send(callTool('memory_read', { name: 'gone' }));

    expect(res.result.content[0].text).toBe('Error: No memory called gone');
  });

  it('falls back to the status when the dashboard says nothing useful', async () => {
    const s = await boot();
    stubFetch(reply({ status: 500, body: {} }));

    const [res] = await s.send(callTool('memory_list'));

    expect(res.result.content[0].text).toBe('Error: HTTP 500');
  });

  it('reports a failure to write the reply as an internal error', async () => {
    // The only way past the per-tool catch: the write of the reply itself
    // fails. The error frame is the second attempt, which succeeds.
    const s = await boot();
    let first = true;
    process.stdout.write.mockImplementation((str) => {
      if (first) {
        first = false;
        throw new Error('EPIPE');
      }
      written.push(str);
      return true;
    });

    const [res] = await s.send({ jsonrpc: '2.0', id: 7, method: 'ping' });

    expect(res).toEqual({ jsonrpc: '2.0', id: 7, error: { code: -32603, message: 'EPIPE' } });
  });

  it('survives a response that is not JSON at all', async () => {
    const s = await boot();
    stubFetch(reply({ status: 502, jsonThrows: true }));

    const [res] = await s.send(callTool('memory_list'));

    expect(res.result.content[0].text).toBe('Error: HTTP 502');
  });
});
