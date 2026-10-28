import { it, expect } from 'vitest';
import { createServer } from 'node:http';
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { codexLiveTurn } from '../lib/codex-live.js';
import { BINARIES } from '../lib/providers.js';

// The installed CLI talks only to this local Responses stub, never a paid provider.
async function steerCodexTurns(linked) {
  const root = mkdtempSync(join(tmpdir(), 'codex.live-'));
  const workspace = join(root, 'repo.with dots');
  mkdirSync(workspace);
  const cwd = linked ? join(root, 'workspace-link') : workspace;
  if (linked) symlinkSync(workspace, cwd, 'dir');
  const requests = [];
  let live, child, steered;
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    if (!req.url.includes('/responses')) {
      res.writeHead(404).end();
      return;
    }
    const request = JSON.parse(body);
    requests.push(request);
    if (!steered) {
      steered = true;
      live.steer({ prompt: 'Change the answer to STEERED' });
    }
    await new Promise((r) => setTimeout(r, 100));
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const item = {
      id: `msg_${requests.length}`,
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text: 'STEERED', annotations: [] }],
    };
    const event = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    event('response.created', {
      response: { id: `resp_${requests.length}`, status: 'in_progress', output: [] },
    });
    event('response.output_item.added', {
      output_index: 0,
      item: { ...item, status: 'in_progress', content: [] },
    });
    event('response.output_text.delta', {
      item_id: item.id,
      output_index: 0,
      content_index: 0,
      delta: 'STEERED',
    });
    event('response.output_item.done', { output_index: 0, item });
    event('response.completed', {
      response: {
        id: `resp_${requests.length}`,
        status: 'completed',
        output: [item],
        usage: {
          input_tokens: 20,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens: 5,
          total_tokens: 25,
        },
      },
    });
    res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    execFileSync('git', ['init', '-q', workspace]);
    mkdirSync(join(workspace, '.codex'));
    writeFileSync(
      join(workspace, '.codex/config.toml'),
      'developer_instructions="PROJECT_LOCAL_CONFIG_LOADED"\n',
    );
    writeFileSync(
      join(root, 'config.toml'),
      `model="gpt-6.1-sol"\nmodel_provider="local_test"\n[model_providers.local_test]\nname="Local test"\nbase_url="http://127.0.0.1:${server.address().port}/v1"\nwire_api="responses"\nrequires_openai_auth=false\n`,
    );
    let threadId;
    for (let run = 0; run < 2; run++) {
      steered = false;
      const events = [],
        accepted = [],
        completed = [];
      let stderr = '';
      const { args } = BINARIES.codex.buildArgs({
        model: 'gpt-6.1-sol',
        effort: 'medium',
        live: true,
        cwd,
      });
      child = spawn(resolve('node_modules/.bin/codex'), args, {
        cwd,
        env: { ...process.env, CODEX_HOME: root },
      });
      const exited = new Promise((r, reject) => {
        child.once('error', reject);
        child.once('close', r);
      });
      const timer = setTimeout(() => child.kill('SIGKILL'), 10000);
      child.stderr.on('data', (c) => {
        stderr += c;
      });
      child.stdin.on('error', () => {});
      const lines = createInterface({ input: child.stdout });
      live = codexLiveTurn({
        send: (m) => child.stdin.write(`${JSON.stringify(m)}\n`),
        prompt: 'Reply ORIGINAL.',
        threadId,
        cwd,
        model: 'gpt-6.1-sol',
        effort: 'medium',
        onActive: () => {},
        onAccepted: (entry) => accepted.push(entry.prompt),
        onComplete: (ok) => {
          completed.push(ok);
          child.stdin.end();
        },
      });
      lines.on('line', (line) => {
        const event = live.feed(JSON.parse(line));
        if (event) events.push(event);
      });
      live.start();
      try {
        expect(await exited, stderr).toBe(0);
        expect(stderr).not.toContain('Project-local config, hooks, and exec policies are disabled');
        expect(stderr).not.toContain('needs access to create user namespaces');
        expect(JSON.stringify(requests.at(-1))).toContain('PROJECT_LOCAL_CONFIG_LOADED');
        expect(completed, stderr).toEqual([true]);
        expect(accepted).toEqual(['Change the answer to STEERED']);
        const started = events.find((e) => e.type === 'thread.started');
        if (threadId) expect(started.thread_id).toBe(threadId);
        threadId = started.thread_id;
        expect(events).toContainEqual(
          expect.objectContaining({
            type: 'item.completed',
            item: expect.objectContaining({ type: 'agent_message', text: 'STEERED' }),
          }),
        );
        expect(requests.at(-1).input).toContainEqual(
          expect.objectContaining({
            role: 'user',
            content: [{ type: 'input_text', text: 'Change the answer to STEERED' }],
          }),
        );
        expect(events.at(-1)).toMatchObject({
          type: 'turn.completed',
          usage: { input_tokens: (run + 1) * 20, output_tokens: (run + 1) * 5 },
        });
      } finally {
        clearTimeout(timer);
        lines.close();
      }
    }
  } finally {
    child?.kill('SIGKILL');
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    rmSync(root, { recursive: true, force: true });
  }
}

it.each([false, true])('steers Codex turns (symlink: %s)', steerCodexTurns, 25000);
