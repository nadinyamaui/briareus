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
    if (req.path.endsWith('/printers'))
      return res.json({ printers: [{ name: 'Office' }], default: 'Office' });
    if (req.path === '/api/agent/print/jobs' && req.method === 'POST')
      return res.json({ jobId: 'Office-1', printer: 'Office', copies: 1 });
    if (req.path === '/api/agent/print/jobs')
      return res.json({ jobs: [{ jobId: 'Office-1', state: 'pending' }] });
    if (req.path === '/api/agent/print/jobs/Office-1') return res.json({ jobId: 'Office-1', canceled: true });
    return res.status(404).json({ error: 'Print job not found' });
  });
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  child = spawn(process.execPath, ['lib/print-mcp.js'], {
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

it('advertises print tools and initializes as a tools-only MCP server', async () => {
  expect((await rpc('initialize', { protocolVersion: '2025-06-18' })).result.serverInfo.name).toBe(
    'reviewer-print',
  );
  expect((await rpc('tools/list')).result.tools.map((t) => t.name)).toEqual([
    'print_printers',
    'print_file',
    'print_jobs',
    'print_cancel',
  ]);
});

it('sends the path, never the bytes, with the session token', async () => {
  const args = { path: '/workspace/report.pdf', copies: 2 };
  const response = await rpc('tools/call', { name: 'print_file', arguments: args });
  expect(JSON.parse(response.result.content[0].text).jobId).toBe('Office-1');
  expect(calls).toEqual([
    { path: '/api/agent/print/jobs', method: 'POST', body: args, token: 'Bearer test-token' },
  ]);
});

it('lists printers and jobs and cancels through the same bridge', async () => {
  const printers = await rpc('tools/call', { name: 'print_printers' });
  expect(JSON.parse(printers.result.content[0].text).default).toBe('Office');
  const jobs = await rpc('tools/call', { name: 'print_jobs' });
  expect(JSON.parse(jobs.result.content[0].text).jobs[0].state).toBe('pending');
  const canceled = await rpc('tools/call', { name: 'print_cancel', arguments: { jobId: 'Office-1' } });
  expect(JSON.parse(canceled.result.content[0].text).canceled).toBe(true);
  expect(calls.at(-1)).toMatchObject({ path: '/api/agent/print/jobs/Office-1', method: 'DELETE' });
});

it('surfaces refusals and unsupported tools as tool errors', async () => {
  const result = await rpc('tools/call', { name: 'print_cancel', arguments: { jobId: 'Other-2' } });
  expect(result.result.isError).toBe(true);
  expect(result.result.content[0].text).toContain('Print job not found');
  expect((await rpc('tools/call', { name: 'print_everything' })).result.isError).toBe(true);
});
