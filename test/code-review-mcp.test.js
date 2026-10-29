import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import express from 'express';
import { beforeEach, afterEach, it, expect } from 'vitest';

const finding = {
  id: 7,
  severity: 'high',
  shouldFix: 'fix',
  verification: 'confirmed',
  title: 'Null deref',
  filePath: 'lib/a.js',
  startLine: 4,
};

let server, child, rpc, calls, refuse;
beforeEach(async () => {
  calls = [];
  refuse = false;
  const app = express();
  app.use(express.json());
  app.use((req, res) => {
    calls.push({ path: req.path, method: req.method, body: req.body, token: req.headers.authorization });
    if (refuse)
      return res.status(403).json({ error: 'Only a code review session can register review findings' });
    if (req.method === 'GET') return res.json({ review: { id: 1 }, findings: [finding] });
    return res.json({ finding: { ...finding, ...req.body } });
  });
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  child = spawn(process.execPath, ['lib/code-review-mcp.js'], {
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

it('advertises the findings tools', async () => {
  expect((await rpc('initialize', {})).result.serverInfo.name).toBe('reviewer-code-review');
  const { tools } = (await rpc('tools/list')).result;
  expect(tools.map((t) => t.name)).toEqual([
    'review_finding_add',
    'review_finding_update',
    'review_summary_set',
    'review_findings_list',
  ]);
  // The verdict comes from the verification step, not when the finding is registered.
  expect(tools[0].inputSchema.required).toEqual(['severity', 'title']);
  expect(tools[0].inputSchema.properties.shouldFix.enum).toEqual(['fix', 'optional', 'dismiss']);
});

it('adds, updates and lists findings with the session token', async () => {
  const add = { severity: 'high', shouldFix: 'fix', title: 'Null deref' };
  const added = await rpc('tools/call', { name: 'review_finding_add', arguments: add });
  expect(added.result.content[0].text).toBe(
    'Registered finding #7 [high, fix, confirmed] lib/a.js:4 Null deref',
  );
  const updated = await rpc('tools/call', {
    name: 'review_finding_update',
    arguments: { id: 7, shouldFix: 'dismiss' },
  });
  expect(updated.result.content[0].text).toContain('[high, dismiss, confirmed]');
  const listed = await rpc('tools/call', { name: 'review_findings_list' });
  expect(listed.result.content[0].text).toBe('#7 [high, fix, confirmed] lib/a.js:4 Null deref');
  expect(calls).toEqual([
    { path: '/api/agent/code-review/findings', method: 'POST', body: add, token: 'Bearer test-token' },
    {
      path: '/api/agent/code-review/findings/7',
      method: 'PATCH',
      body: { shouldFix: 'dismiss' },
      token: 'Bearer test-token',
    },
    { path: '/api/agent/code-review', method: 'GET', body: undefined, token: 'Bearer test-token' },
  ]);
});

it('stores the posted summary comment', async () => {
  const stored = await rpc('tools/call', {
    name: 'review_summary_set',
    arguments: { summary: '# Code Review' },
  });
  expect(stored.result.content[0].text).toBe('Stored the review summary.');
  expect(calls).toEqual([
    {
      path: '/api/agent/code-review/summary',
      method: 'PUT',
      body: { summary: '# Code Review' },
      token: 'Bearer test-token',
    },
  ]);
});

it('surfaces a refusal as a tool error', async () => {
  refuse = true;
  const result = await rpc('tools/call', {
    name: 'review_finding_add',
    arguments: { severity: 'low', shouldFix: 'fix', title: 't' },
  });
  expect(result.result.isError).toBe(true);
  expect(result.result.content[0].text).toContain('Only a code review session');
});
