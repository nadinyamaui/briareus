import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import express from 'express';
import { beforeEach, afterEach, it, expect } from 'vitest';

let server, child, rpc, calls;
beforeEach(async () => {
  calls = [];
  const app = express();
  app.use((req, res) => {
    calls.push(req.path);
    if (req.path === '/api/agent/home-assistant/entities') return res.json({ entities: [] });
    return res.json({ entity: { id: 'vacuum.manolo' } });
  });
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  child = spawn(process.execPath, ['lib/home-assistant-mcp.js'], {
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

it('reads one entity, and refuses ha_entity without an id instead of listing the home', async () => {
  const read = await rpc('tools/call', { name: 'ha_entity', arguments: { entityId: 'vacuum.manolo' } });
  expect(JSON.parse(read.result.content[0].text)).toEqual({ entity: { id: 'vacuum.manolo' } });
  for (const args of [{}, { entityId: '' }]) {
    const missing = await rpc('tools/call', { name: 'ha_entity', arguments: args });
    expect(missing.result).toEqual({
      content: [{ type: 'text', text: 'Error: entityId is required' }],
      isError: true,
    });
  }
  expect(calls).toEqual(['/api/agent/home-assistant/entities/vacuum.manolo']);
});
