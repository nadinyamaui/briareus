import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import express from 'express';
import { beforeEach, afterEach, it, expect } from 'vitest';

let server, child, rpc, calls, forbidden;
beforeEach(async () => {
  calls = [];
  forbidden = false;
  const app = express();
  app.use(express.json());
  app.use((req, res) => {
    calls.push({ path: req.path, method: req.method, body: req.body, token: req.headers.authorization });
    if (forbidden)
      return res
        .status(403)
        .json({ error: "Only an admin's interactive session may change its project's .env template" });
    if (req.method === 'GET') return res.json({ repo: 'owner/repo', env: 'APP_KEY=secret\n' });
    return res.json({ repo: 'owner/repo', checkout: 'updated', set: ['A'], unset: ['B'] });
  });
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  child = spawn(process.execPath, ['lib/project-env-mcp.js'], {
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

it('advertises the project .env tools', async () => {
  expect((await rpc('initialize', {})).result.serverInfo.name).toBe('reviewer-project-env');
  expect((await rpc('tools/list')).result.tools.map((t) => t.name)).toEqual([
    'project_env_read',
    'project_env_set',
  ]);
});

it('reads and edits the template with the session token', async () => {
  const read = await rpc('tools/call', { name: 'project_env_read' });
  expect(read.result.content[0].text).toBe('# .env template of owner/repo\nAPP_KEY=secret\n');
  const args = { set: { A: '1' }, unset: ['B'] };
  const set = await rpc('tools/call', { name: 'project_env_set', arguments: args });
  expect(set.result.content[0].text).toBe(
    "Updated the .env template of owner/repo: set A; removed B. This checkout's .env: updated.",
  );
  expect(calls).toEqual([
    { path: '/api/agent/project-env', method: 'GET', body: undefined, token: 'Bearer test-token' },
    { path: '/api/agent/project-env', method: 'POST', body: args, token: 'Bearer test-token' },
  ]);
});

it('surfaces a refusal as a tool error', async () => {
  forbidden = true;
  const result = await rpc('tools/call', { name: 'project_env_set', arguments: { set: { A: '1' } } });
  expect(result.result.isError).toBe(true);
  expect(result.result.content[0].text).toContain('interactive session');
});
