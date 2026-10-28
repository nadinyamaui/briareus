import { it, expect } from 'vitest';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { BINARIES, newTurn, parserFor } from '../lib/providers.js';

// The installed dsh talks only to this local Messages stub, never a paid provider. The root agent
// delegates once to a native sub-agent, which spends far more than the root does.
it('counts a native sub-agent in the turn, through the plugin the patch mounts', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh.subagent-'));
  const cwd = join(root, 'work');
  mkdirSync(cwd);
  const spent = { root: 0 };
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    if (req.method !== 'POST' || !req.url.endsWith('/messages')) {
      res.writeHead(404).end();
      return;
    }
    const request = JSON.parse(body);
    const history = JSON.stringify(request.messages || []);
    // Session titles ask without tools; neither agent's turn does.
    const kind = !request.tools?.length
      ? 'title'
      : history.includes('CHILD_TASK') && !history.includes('tool_use')
        ? 'child'
        : history.includes('tool_result')
          ? 'answer'
          : 'delegate';
    if (kind === 'delegate' || kind === 'answer') spent.root++;
    const usage = kind === 'child' ? [100000, 2000] : [1000, 20];
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const event = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    event('message_start', {
      message: {
        id: 'msg',
        type: 'message',
        role: 'assistant',
        content: [],
        model: request.model,
        stop_reason: null,
        usage: { input_tokens: usage[0], cache_read_input_tokens: 0, output_tokens: 0 },
      },
    });
    if (kind === 'delegate') {
      event('content_block_start', {
        index: 0,
        content_block: { type: 'tool_use', id: 'tu1', name: 'subagent', input: {} },
      });
      event('content_block_delta', {
        index: 0,
        delta: {
          type: 'input_json_delta',
          partial_json: JSON.stringify({ description: 'child work', prompt: 'CHILD_TASK count it' }),
        },
      });
    } else {
      event('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
      event('content_block_delta', { index: 0, delta: { type: 'text_delta', text: `${kind} done` } });
    }
    event('content_block_stop', { index: 0 });
    event('message_delta', {
      delta: { stop_reason: kind === 'delegate' ? 'tool_use' : 'end_turn' },
      usage: { output_tokens: usage[1] },
    });
    event('message_stop', {});
    res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const { patch } = BINARIES.dsh.buildArgs({ model: 'deepseek-flash', effort: 'low', resume: false });
    const patchFile = join(root, 'patch.json');
    writeFileSync(patchFile, patch);
    const { args } = BINARIES.dsh.buildArgs({
      model: 'deepseek-flash',
      effort: 'low',
      resume: false,
      patchFile,
    });
    const child = spawn(resolve('node_modules/.bin/dsh'), args, {
      cwd,
      env: {
        ...process.env,
        DSH_HOME: join(root, 'home'),
        DEEPSEEK_API_KEY: 'sk-test',
        DEEPSEEK_BASE_URL: `http://127.0.0.1:${server.address().port}`,
        DSH_PERMISSION_MODE: 'danger-full-access',
      },
    });
    const turn = newTurn();
    const parser = parserFor('dsh', turn);
    const lines = createInterface({ input: child.stdout });
    lines.on('line', (line) => parser.feed(JSON.parse(line)));
    let stderr = '';
    child.stderr.on('data', (c) => {
      stderr += c;
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), 30000);
    child.stdin.end('PARENT_TASK delegate it');
    const code = await new Promise((r, reject) => {
      child.once('error', reject);
      child.once('close', r);
    });
    clearTimeout(timer);
    expect(code, stderr).toBe(0);
    expect(parser.flush({ code }).at(-1)).toMatchObject({ subtype: 'success' });
    expect(spent.root).toBeGreaterThan(0);
    expect(turn.subagentUsage).toEqual({
      'deepseek-flash': { inputTokens: 100000, outputTokens: 2000, cachedInputTokens: 0 },
    });
    expect(turn).toMatchObject({
      inputTokens: 100000 + 1000 * spent.root,
      outputTokens: 2000 + 20 * spent.root,
      cachedInputTokens: 0,
      // The root's own context, not the child's.
      contextTokens: 1020,
    });
  } finally {
    server.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 60000);
