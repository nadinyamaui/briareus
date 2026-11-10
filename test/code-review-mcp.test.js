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

it('states how a finding relates to earlier threads when it is registered, not afterwards', async () => {
  const [add, update] = (await rpc('tools/list')).result.tools;
  const stated = ['reconciliation', 'commentId', 'priorThreadId', 'priorFindingRef', 'revisitReason'];
  expect(Object.keys(add.inputSchema.properties)).toEqual(expect.arrayContaining(stated));
  expect(add.inputSchema.properties.reconciliation.enum).toEqual(['new', 'adopted', 'suppressed', 'revisit']);
  expect(add.inputSchema.required).toEqual(['severity', 'title']);
  for (const name of stated) expect(update.inputSchema.properties).not.toHaveProperty(name);
  const suppressed = {
    severity: 'low',
    title: 'Null deref',
    reconciliation: 'suppressed',
    priorThreadId: 'PRRT_a',
    priorDisposition: 'dismissed',
  };
  const added = await rpc('tools/call', { name: 'review_finding_add', arguments: suppressed });
  // The list the verification step reads marks it, with the thread that decided it.
  expect(added.result.content[0].text).toBe(
    'Registered finding #7 [low, fix, confirmed, suppressed] lib/a.js:4 Null deref (earlier dismissed: PRRT_a)',
  );
  const posted = await rpc('tools/call', {
    name: 'review_finding_add',
    arguments: {
      severity: 'high',
      title: 'Lost update',
      reconciliation: 'revisit',
      commentId: 501,
      priorUrl: 'https://github.com/acme/shop/pull/7#discussion_r101',
    },
  });
  // And the comment the verification step replies to.
  expect(posted.result.content[0].text).toBe(
    'Registered finding #7 [high, fix, confirmed, revisit] lib/a.js:4 Lost update (comment 501) (earlier thread: https://github.com/acme/shop/pull/7#discussion_r101)',
  );
  expect(calls[0]).toMatchObject({
    path: '/api/agent/code-review/findings',
    method: 'POST',
    body: suppressed,
  });
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

// A server of its own: what it offers is decided by the environment its review's turn
// starts it with (lib/jobs.js).
async function withServer(env, run) {
  const own = spawn(process.execPath, ['lib/code-review-mcp.js'], {
    env: {
      ...process.env,
      REVIEWER_MEMORY_URL: `http://127.0.0.1:${server.address().port}`,
      REVIEWER_MEMORY_TOKEN: 'test-token',
      ...env,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const lines = createInterface({ input: own.stdout });
  const pending = new Map();
  let nextId = 0;
  lines.on('line', (line) => {
    const response = JSON.parse(line);
    pending.get(response.id)?.(response);
  });
  const ask = (method, params) =>
    new Promise((resolve) => {
      const id = ++nextId;
      pending.set(id, resolve);
      own.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  try {
    return await run(ask);
  } finally {
    own.kill();
    await new Promise((resolve) => own.once('close', resolve));
  }
}

it('offers the security mark only to a review that runs a security pass', async () => {
  // A review without the pass is offered exactly the tools it always was.
  const [plainAdd, plainUpdate] = (await rpc('tools/list')).result.tools;
  expect(plainAdd.inputSchema.properties).not.toHaveProperty('security');
  expect(plainUpdate.inputSchema.properties).not.toHaveProperty('security');
  expect(JSON.stringify((await rpc('tools/list')).result.tools)).not.toMatch(/security pass/i);
  await withServer({ REVIEWER_SECURITY_PASS: '1' }, async (ask) => {
    const [add, update] = (await ask('tools/list')).result.tools;
    expect(add.inputSchema.properties.security).toMatchObject({ type: 'boolean' });
    expect(add.inputSchema.properties.security.description).toContain(
      'Refused when this review has no completed security pass',
    );
    // Stated when the finding is registered, like how it relates to earlier threads.
    expect(update.inputSchema.properties).not.toHaveProperty('security');
    expect(add.inputSchema.required).toEqual(['severity', 'title']);
    const { security: _security, ...rest } = add.inputSchema.properties;
    expect(rest).toEqual(plainAdd.inputSchema.properties);
    const marked = { severity: 'high', title: 'Null deref', security: true };
    const added = await ask('tools/call', { name: 'review_finding_add', arguments: marked });
    expect(added.result.content[0].text).toBe(
      'Registered finding #7 [high, fix, confirmed, security] lib/a.js:4 Null deref',
    );
    expect(calls.at(-1)).toMatchObject({ method: 'POST', body: marked });
  });
  for (const value of ['0', 'true', ''])
    await withServer({ REVIEWER_SECURITY_PASS: value }, async (ask) => {
      expect((await ask('tools/list')).result.tools[0].inputSchema.properties).not.toHaveProperty('security');
    });
});
