import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import express from 'express';
import { beforeEach, afterEach, it, expect } from 'vitest';

let server, child, rpc, calls;
beforeEach(async () => {
  calls = [];
  const app = express();
  app.use(express.json());
  app.use((req, res) => {
    calls.push({ path: req.path, method: req.method, body: req.body, token: req.headers.authorization });
    if (req.path.endsWith('/servers')) return res.json({ servers: [{ id: 1, permissionMode: 'ask' }] });
    if (req.path.endsWith('/execute')) return res.json({ request: { id: 'command-id', status: 'pending' } });
    if (req.path.endsWith('/command-id'))
      return res.json({ request: { id: 'command-id', status: 'completed', result: { stdout: 'done' } } });
    return res.status(404).json({ error: 'SSH request not found' });
  });
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  child = spawn(process.execPath, ['lib/ssh-mcp.js'], {
    env: {
      ...process.env,
      REVIEWER_MEMORY_URL: `http://127.0.0.1:${server.address().port}`,
      REVIEWER_MEMORY_TOKEN: 'test-token',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const lines = createInterface({ input: child.stdout });
  let nextId = 0;
  const pending = new Map();
  lines.on('line', (line) => {
    const response = JSON.parse(line);
    pending.get(response.id)?.(response);
  });
  rpc = (method, params) =>
    new Promise((resolve) => {
      const id = ++nextId;
      pending.set(id, resolve);
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
});
afterEach(async () => {
  child.kill();
  await new Promise((resolve) => child.once('close', resolve));
  await new Promise((resolve) => server.close(resolve));
});

it('advertises SSH tools and initializes as a tools-only MCP server', async () => {
  expect((await rpc('initialize', { protocolVersion: '2025-06-18' })).result.serverInfo.name).toBe(
    'reviewer-ssh',
  );
  expect((await rpc('tools/list')).result.tools.map((t) => t.name)).toEqual([
    'ssh_list_servers',
    'ssh_execute',
    'ssh_result',
  ]);
});
it('uses the session token and returns a pending command without submitting twice', async () => {
  const response = await rpc('tools/call', {
    name: 'ssh_execute',
    arguments: { serverId: 1, command: 'pwd' },
  });
  expect(JSON.parse(response.result.content[0].text).request.status).toBe('pending');
  expect(calls).toEqual([
    {
      path: '/api/agent/ssh/execute',
      method: 'POST',
      body: { serverId: 1, command: 'pwd' },
      token: 'Bearer test-token',
    },
  ]);
});
it('lists servers and retrieves results through the same bridge', async () => {
  const servers = await rpc('tools/call', { name: 'ssh_list_servers' });
  expect(JSON.parse(servers.result.content[0].text).servers[0].id).toBe(1);
  const result = await rpc('tools/call', { name: 'ssh_result', arguments: { requestId: 'command-id' } });
  expect(JSON.parse(result.result.content[0].text).request.result.stdout).toBe('done');
});
it('surfaces missing requests and unsupported tools as tool errors', async () => {
  const result = await rpc('tools/call', { name: 'ssh_result', arguments: { requestId: '../wrong' } });
  expect(result.result.isError).toBe(true);
  expect(result.result.content[0].text).toContain('SSH request not found');
  expect((await rpc('tools/call', { name: 'ssh_approve' })).result.isError).toBe(true);
});
