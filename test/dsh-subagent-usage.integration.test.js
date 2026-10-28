import { it, expect } from 'vitest';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { BINARIES, newTurn, parserFor } from '../lib/providers.js';

// Runs one turn of the installed dsh, with the patch Briareus mounts, against the given stub and
// returns the parser's turn once dsh has exited cleanly; or, given `stopAt`, once the first line it
// matches has been followed by a Stop, which SIGKILLs the process group as lib/jobs.js does.
async function runTurn(root, server, { stopAt } = {}) {
  const cwd = join(root, 'work');
  mkdirSync(cwd);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
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
    detached: true,
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
  let stopping = null;
  lines.on('line', (line) => {
    const msg = JSON.parse(line);
    parser.feed(msg);
    if (stopAt?.(msg) && !stopping) stopping = setTimeout(() => process.kill(-child.pid, 'SIGKILL'), 300);
  });
  let stderr = '';
  child.stderr.on('data', (c) => {
    stderr += c;
  });
  const timer = setTimeout(() => process.kill(-child.pid, 'SIGKILL'), 30000);
  child.stdin.end('PARENT_TASK delegate it');
  const code = await new Promise((r, reject) => {
    child.once('error', reject);
    child.once('close', r);
  });
  clearTimeout(timer);
  if (stopAt) {
    expect(stopping, stderr).not.toBeNull();
    parser.flush({ canceled: true, code });
    return turn;
  }
  expect(code, stderr).toBe(0);
  expect(parser.flush({ code }).at(-1)).toMatchObject({ subtype: 'success' });
  return turn;
}

// The installed dsh talks only to this local Messages stub, never a paid provider. The root agent
// delegates once to a native sub-agent, which spends far more than the root does.
it('counts a native sub-agent in the turn, through the plugin the patch mounts', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh.subagent-'));
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
  try {
    const turn = await runTurn(root, server);
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

// The same stub, but the root's request after the delegation overflows the context once, so dsh
// compacts and retries. The compaction call is paid for, though no step records it.
it('counts a compaction call in the turn, through the same plugin', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh.compaction-'));
  const seen = { compactions: 0, overflowed: false, root: 0 };
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    if (req.method !== 'POST' || !req.url.endsWith('/messages')) {
      res.writeHead(404).end();
      return;
    }
    const request = JSON.parse(body);
    const history = JSON.stringify(request.messages || []);
    const kind =
      req.headers['x-deepseek-harness-compact'] === '1'
        ? 'compaction'
        : !request.tools?.length
          ? 'title'
          : history.includes('CHILD_TASK') && !history.includes('tool_use')
            ? 'child'
            : seen.compactions || history.includes('tool_result')
              ? 'answer'
              : 'delegate';
    if (kind === 'answer' && !seen.overflowed) {
      seen.overflowed = true;
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          type: 'error',
          error: { type: 'invalid_request_error', message: 'maximum context length exceeded' },
        }),
      );
      return;
    }
    if (kind === 'compaction') seen.compactions++;
    if (kind === 'delegate' || kind === 'answer') seen.root++;
    const usage = kind === 'compaction' ? [700000, 20] : kind === 'child' ? [100000, 2000] : [1000, 20];
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
      // Enough for the summary to be smaller than what it replaces.
      event('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
      event('content_block_delta', {
        index: 0,
        delta: { type: 'text_delta', text: 'planning the delegation. '.repeat(2000) },
      });
      event('content_block_stop', { index: 0 });
      event('content_block_start', {
        index: 1,
        content_block: { type: 'tool_use', id: 'tu1', name: 'subagent', input: {} },
      });
      event('content_block_delta', {
        index: 1,
        delta: {
          type: 'input_json_delta',
          partial_json: JSON.stringify({ description: 'child work', prompt: 'CHILD_TASK count it' }),
        },
      });
      event('content_block_stop', { index: 1 });
    } else {
      event('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
      event('content_block_delta', { index: 0, delta: { type: 'text_delta', text: `${kind} done` } });
      event('content_block_stop', { index: 0 });
    }
    event('message_delta', {
      delta: { stop_reason: kind === 'delegate' ? 'tool_use' : 'end_turn' },
      usage: { output_tokens: usage[1] },
    });
    event('message_stop', {});
    res.end();
  });
  try {
    const turn = await runTurn(root, server);
    expect(seen.compactions).toBeGreaterThan(0);
    expect({ ...turn.subagentUsage }).toEqual({
      'deepseek-flash': {
        inputTokens: 100000 + 700000 * seen.compactions,
        outputTokens: 2000 + 20 * seen.compactions,
        cachedInputTokens: 0,
      },
    });
    // Every root request answered on top, at 1000/20 each, the retry after the overflow included,
    // though dsh's projection leaves that step without usage; its unmeasured first attempt makes
    // the cache reads unknown.
    expect(seen.root).toBeGreaterThan(1);
    expect(turn).toMatchObject({
      inputTokens: 100000 + 700000 * seen.compactions + 1000 * seen.root,
      outputTokens: 2000 + 20 * seen.compactions + 20 * seen.root,
      cachedInputTokens: null,
      // The root's own context, never the compaction call's.
      contextTokens: 1020,
    });
  } finally {
    server.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 60000);

// The first stub, but the child's first request gets an HTTP 429 that reports no usage, and dsh
// retries it. The retry's measured tokens still reach the turn.
it('counts a sub-agent step retried after an unmeasured attempt, as what was measured', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh.retry-'));
  const seen = { root: 0, limited: false };
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    if (req.method !== 'POST' || !req.url.endsWith('/messages')) {
      res.writeHead(404).end();
      return;
    }
    const request = JSON.parse(body);
    const history = JSON.stringify(request.messages || []);
    const kind = !request.tools?.length
      ? 'title'
      : history.includes('CHILD_TASK') && !history.includes('tool_use')
        ? 'child'
        : history.includes('tool_result')
          ? 'answer'
          : 'delegate';
    if (kind === 'child' && !seen.limited) {
      seen.limited = true;
      res.writeHead(429, { 'Content-Type': 'application/json', 'retry-after': '0' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } }));
      return;
    }
    if (kind === 'delegate' || kind === 'answer') seen.root++;
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
  try {
    const turn = await runTurn(root, server);
    expect(seen.limited).toBe(true);
    expect(seen.root).toBeGreaterThan(0);
    // The measured retry, with its cache reads unknown since the 429 reported none.
    expect({ ...turn.subagentUsage }).toEqual({
      'deepseek-flash': { inputTokens: 100000, outputTokens: 2000, cachedInputTokens: null },
    });
    expect(turn).toMatchObject({
      inputTokens: 100000 + 1000 * seen.root,
      outputTokens: 2000 + 20 * seen.root,
      cachedInputTokens: null,
      rootCachedInputTokens: 0,
      contextTokens: 1020,
    });
  } finally {
    server.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 60000);

// The root's first request is answered with a long shell command, and Stop kills dsh while it runs:
// the request was billed when its message committed, before the step's end that never comes.
it('counts a step whose tool a Stop interrupted', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh.stop-'));
  const seen = { root: 0 };
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    if (req.method !== 'POST' || !req.url.endsWith('/messages')) {
      res.writeHead(404).end();
      return;
    }
    const request = JSON.parse(body);
    // Session titles ask without tools.
    if (!request.tools?.length) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'no title' } }),
      );
      return;
    }
    seen.root++;
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
        usage: { input_tokens: 1000, cache_read_input_tokens: 0, output_tokens: 0 },
      },
    });
    event('content_block_start', {
      index: 0,
      content_block: { type: 'tool_use', id: 'tu1', name: 'bash', input: {} },
    });
    event('content_block_delta', {
      index: 0,
      delta: {
        type: 'input_json_delta',
        partial_json: JSON.stringify({ description: 'Wait', command: 'sleep 20' }),
      },
    });
    event('content_block_stop', { index: 0 });
    event('message_delta', { delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 20 } });
    event('message_stop', {});
    res.end();
  });
  try {
    const turn = await runTurn(root, server, { stopAt: (msg) => msg.type === 'tool_call' });
    expect(seen.root).toBe(1);
    expect(turn).toMatchObject({
      inputTokens: 1000,
      outputTokens: 20,
      cachedInputTokens: 0,
      contextTokens: 1020,
    });
  } finally {
    server.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 60000);
