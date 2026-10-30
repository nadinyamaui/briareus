import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { workerTranscript } from '../lib/worker-transcript.js';

// A stdio server wired to stdin at import, driven like memory-mcp.js: mock readline to capture
// the line handler, feed it JSON-RPC frames, read replies off a stubbed stdout. BASE and TOKEN
// are read at import, so every test imports a fresh copy.
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

async function boot({ base = URL_BASE, token = TOKEN } = {}) {
  process.env.REVIEWER_MEMORY_URL = base;
  process.env.REVIEWER_MEMORY_TOKEN = token;
  rl.handlers = {};
  vi.resetModules();
  await import('../lib/orchestrator-mcp.js');
  return {
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
  };
}

function stubFetch(...replies) {
  const fn = vi.fn(async () => {
    const next = replies.shift();
    if (!next) throw new Error('unexpected extra fetch');
    return next;
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

function reply({ status = 200, body = {} } = {}) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

const callTool = (name, args) => ({
  jsonrpc: '2.0',
  id: 9,
  method: 'tools/call',
  params: { name, arguments: args },
});

const worker = (extra = {}) => ({
  id: 'w1',
  title: 'Fix the login',
  status: 'idle',
  awaitingAnswer: false,
  branch: 'dev-w1',
  provider: 'Cheap entry',
  model: 'claude-haiku-4-5',
  costUsd: 0.5,
  lastText: 'Done.',
  pr: null,
  ...extra,
});

beforeEach(() => {
  written = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((s) => {
    written.push(s);
    return true;
  });
  vi.spyOn(process, 'exit').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete process.env.REVIEWER_MEMORY_URL;
  delete process.env.REVIEWER_MEMORY_TOKEN;
});

describe('the JSON-RPC frame', () => {
  it('names itself reviewer-workers on initialize', async () => {
    const s = await boot();

    const [res] = await s.send({ jsonrpc: '2.0', id: 1, method: 'initialize' });

    expect(res.result.serverInfo).toEqual({ name: 'reviewer-workers', version: '1.0.0' });
  });
});

describe('the worker tools', () => {
  it('spawn_worker posts the brief with the snake_case fields renamed', async () => {
    const fetched = stubFetch(reply({ status: 201, body: { session: worker() } }));
    const s = await boot();

    const [res] = await s.send(
      callTool('spawn_worker', {
        title: 'Fix the login',
        prompt: 'Do it',
        provider_id: 2,
        model: 'claude-haiku-4-5',
        effort: 'low',
        branch: 'dev-x',
      }),
    );

    expect(fetched).toHaveBeenCalledWith(`${URL_BASE}/api/agent/sessions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'Fix the login',
        prompt: 'Do it',
        providerId: 2,
        model: 'claude-haiku-4-5',
        effort: 'low',
        branch: 'dev-x',
        qaLoop: false,
      }),
    });
    expect(res.result.content[0].text).toMatch(/^Started worker w1 \[idle\] Fix the login/);
  });

  it('advertises and forwards the explicit target without changing tooling targeting', async () => {
    const fetched = stubFetch(reply({ status: 201, body: { session: worker({ repo: 'acme/companion' }) } }));
    const s = await boot();
    const [listed] = await s.send({ jsonrpc: '2.0', id: 20, method: 'tools/list' });
    const spawn = listed.result.tools.find((tool) => tool.name === 'spawn_worker');
    const tooling = listed.result.tools.find((tool) => tool.name === 'fix_tooling');
    expect(spawn.inputSchema.properties.repo.type).toBe('string');
    expect(tooling.inputSchema.properties).not.toHaveProperty('repo');
    const [res] = await s.send(
      callTool('spawn_worker', {
        title: 'Companion',
        prompt: 'Do it',
        repo: 'acme/companion',
        review_loop: true,
      }),
    );
    expect(JSON.parse(fetched.mock.lastCall[1].body)).toMatchObject({
      repo: 'acme/companion',
    });
    expect(res.result.content[0].text).toContain('repo acme/companion');
  });

  it('fix_tooling posts the report flagged as tooling, and says where the fix lands', async () => {
    const fetched = stubFetch(
      reply({
        status: 201,
        body: { session: worker({ repo: 'acme/dashboard', toolingFor: 'acme/shop', branch: null }) },
      }),
    );
    const s = await boot();

    const [res] = await s.send(
      callTool('fix_tooling', {
        title: 'Fix the login',
        prompt: 'read_worker ignores tail',
        provider_id: 2,
        effort: 'low',
      }),
    );

    expect(fetched.mock.calls[0][0]).toBe(`${URL_BASE}/api/agent/sessions`);
    expect(JSON.parse(fetched.mock.calls[0][1].body)).toEqual({
      title: 'Fix the login',
      prompt: 'read_worker ignores tail',
      providerId: 2,
      effort: 'low',
      qaLoop: false,
      tooling: true,
    });
    const text = res.result.content[0].text;
    expect(text).toMatch(
      /^Started tooling-fix worker w1 \[idle\] Fix the login · tooling fix on acme\/dashboard/,
    );
    expect(text).toContain('lands on acme/dashboard');
    expect(text).toContain('until the user redeploys');
  });

  it('list_workers marks a tooling fix on its line', async () => {
    stubFetch(
      reply({
        body: { sessions: [worker(), worker({ id: 'w2', repo: 'acme/dashboard', toolingFor: 'acme/shop' })] },
      }),
    );
    const s = await boot();

    const [res] = await s.send(callTool('list_workers', {}));

    const lines = res.result.content[0].text.split('\n');
    expect(lines[0]).not.toContain('tooling fix');
    expect(lines[1]).toContain('w2 [idle] Fix the login · tooling fix on acme/dashboard');
  });

  it('list_workers distinguishes incomplete manual coverage from passed QA', async () => {
    stubFetch(
      reply({
        body: {
          sessions: [
            worker({ qaLoop: { done: true, incomplete: true, failedScenarios: 0 } }),
            worker({ id: 'passed', qaLoop: { done: true, incomplete: false, failedScenarios: 0 } }),
          ],
        },
      }),
    );
    const s = await boot();
    const [res] = await s.send(callTool('list_workers', {}));
    const lines = res.result.content[0].text.split('\n');
    expect(lines[0]).toContain('QA incomplete coverage');
    expect(lines[0]).toContain('not passed');
    expect(lines[1]).toContain('QA passed');
  });

  it('list_workers says where the armed loops stand', async () => {
    stubFetch(
      reply({
        body: {
          sessions: [
            worker({
              qaLoop: { running: false, done: false, failedScenarios: 0 },
            }),
            worker({
              id: 'w2',
              qaLoop: { running: false, done: true, failedScenarios: 2 },
            }),
            // A round whose review is over and whose findings are still being
            // read off the pull request: mid-round, not waiting for a push.
            worker({
              id: 'w3',
            }),
            worker({
              id: 'w4',
              qaLoop: {
                running: false,
                done: false,
                failure: { kind: 'failed', reason: 'Claude HQ exited with code 1' },
              },
            }),
            // Old records did not persist a failure reason. Once review has
            // converged, this cannot truthfully be "queued behind" review.
            worker({
              id: 'w5',
              qaLoop: { running: false, done: false },
            }),
          ],
        },
      }),
    );
    const s = await boot();

    const [res] = await s.send(callTool('list_workers', {}));

    const lines = res.result.content[0].text.split('\n');
    expect(lines[0]).toContain('QA waiting for the worker to settle');
    expect(lines[1]).toContain('QA failed: 2 scenario(s)');
    expect(lines[3]).toContain(
      'QA failed (Claude HQ exited with code 1); not running — send_to_worker starts a retry when the worker settles',
    );
    expect(lines[3]).not.toContain('QA queued');
    expect(lines[4]).toContain(
      'QA waiting for the worker to settle; not running — send_to_worker starts a retry when the worker settles',
    );
    expect(lines[4]).not.toContain('QA queued');
  });

  it('list_workers explains that review, fix and QA children waiting for database slots start automatically', async () => {
    stubFetch(
      reply({
        body: {
          sessions: [
            worker({}),
            worker({ id: 'w2' }),
            worker({ id: 'w3', qaLoop: { running: true, waitingForDatabase: true } }),
          ],
        },
      }),
    );
    const s = await boot();
    const [res] = await s.send(callTool('list_workers', {}));
    const lines = res.result.content[0].text.split('\n');
    expect(lines[2]).toContain('QA waiting for a database slot; starts automatically');
  });

  it('list_workers formats one line per worker, waiting state included', async () => {
    stubFetch(
      reply({
        body: {
          sessions: [
            worker({ awaitingAnswer: true, pr: { number: 7, state: 'open', checks: '✓2 ✗0 ●1' } }),
            worker({ id: 'w2', title: 'Docs', status: 'running', costUsd: null, lastText: null }),
            worker({ id: 'w3', pr: { number: 8, state: 'open', checks: '✓2 ✗2 ●0; cancelled: 2' } }),
          ],
        },
      }),
    );
    const s = await boot();

    const [res] = await s.send(callTool('list_workers', {}));

    const lines = res.result.content[0].text.split('\n');
    expect(lines[0]).toContain('w1 [waiting on a question] Fix the login');
    expect(lines[0]).toContain('PR #7 open (✓2 ✗0 ●1)');
    expect(lines[0]).toContain('$0.50');
    expect(lines[1]).toBe('w2 [running] Docs · branch dev-w1 · Cheap entry claude-haiku-4-5');
    expect(lines[2]).toContain('PR #8 open (✓2 ✗2 ●0; cancelled: 2)');
  });

  it('list_workers says so when there are none yet', async () => {
    stubFetch(reply({ body: { sessions: [] } }));
    const s = await boot();

    const [res] = await s.send(callTool('list_workers', {}));

    expect(res.result.content[0].text).toBe('No worker sessions yet.');
  });

  it('read_worker renders the transcript tail by kind', async () => {
    const fetched = stubFetch(
      reply({
        body: {
          session: worker(),
          events: [
            { kind: 'user', text: 'Fix it' },
            { kind: 'text', text: 'On it.' },
            { kind: 'ask', question: 'Which db?', options: [{ label: 'mysql' }, { label: 'sqlite' }] },
            { kind: 'status', status: 'idle' },
            { kind: 'result', isError: false, costUsd: 0.25 },
          ],
        },
      }),
    );
    const s = await boot();

    const [res] = await s.send(callTool('read_worker', { id: 'w1', tail: 5 }));

    expect(fetched.mock.calls[0][0]).toBe(`${URL_BASE}/api/agent/sessions/w1?tail=5`);
    const text = res.result.content[0].text;
    expect(text).toContain('[to worker] Fix it');
    expect(text).toContain('[worker] On it.');
    expect(text).toContain('[worker asks] Which db? — options: mysql | sqlite');
    expect(text).toContain('[status] idle');
    expect(text).toContain('[turn ended] ok, $0.25');
  });

  it('advertises full_text as an optional boolean with concise defaults', async () => {
    const s = await boot();
    const [res] = await s.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const tool = res.result.tools.find((t) => t.name === 'read_worker');
    expect(tool.inputSchema.properties.full_text.type).toBe('boolean');
    expect(tool.inputSchema.required).toEqual(['id']);
    expect(tool.description).toContain('2000');
  });

  it('renders a complete long final proposal on opt-in and offers a retry hint otherwise', async () => {
    const proposal = 'Detailed requirement\n'.repeat(250) + 'FINAL ACCEPTANCE CRITERION';
    const fetched = vi.fn(async (url) => {
      const query = Object.fromEntries(new URL(url).searchParams);
      const events = await workerTranscript({ seq: 10 }, query, async () => [
        { kind: 'text', text: proposal },
        { kind: 'result' },
      ]);
      return reply({ body: { session: worker(), events } });
    });
    vi.stubGlobal('fetch', fetched);
    const s = await boot();
    for (const args of [{}, { full_text: false }, { full_text: 'true' }]) {
      const [res] = await s.send(callTool('read_worker', { id: 'w1', ...args }));
      expect(fetched.mock.lastCall[0]).toBe(`${URL_BASE}/api/agent/sessions/w1?tail=40`);
      expect(res.result.content[0].text).toContain(proposal.slice(0, 2000) + '…');
      expect(res.result.content[0].text).not.toContain('FINAL ACCEPTANCE CRITERION');
      expect(res.result.content[0].text).toContain('Retry read_worker with full_text: true');
    }
    const [res] = await s.send(callTool('read_worker', { id: 'w1', tail: 12, full_text: true }));
    expect(fetched.mock.lastCall[0]).toBe(`${URL_BASE}/api/agent/sessions/w1?tail=12&full_text=true`);
    expect(res.result.content[0].text).toContain(`[worker] ${proposal}`);
    expect(res.result.content[0].text).not.toContain('Text clipped');
  });

  it('send_to_worker posts the message and reports the worker state', async () => {
    const fetched = stubFetch(reply({ body: { session: worker({ status: 'running' }) } }));
    const s = await boot();

    const [res] = await s.send(callTool('send_to_worker', { id: 'w1', message: 'answer: mysql' }));

    expect(fetched.mock.calls[0][0]).toBe(`${URL_BASE}/api/agent/sessions/w1/message`);
    expect(JSON.parse(fetched.mock.calls[0][1].body)).toEqual({ text: 'answer: mysql' });
    expect(res.result.content[0].text).toMatch(/^Sent\. Worker is now: w1 \[running\]/);
  });

  it('close_worker posts the close', async () => {
    const fetched = stubFetch(reply({ body: { session: worker({ status: 'closed' }) } }));
    const s = await boot();

    const [res] = await s.send(callTool('close_worker', { id: 'w1' }));

    expect(fetched.mock.calls[0][0]).toBe(`${URL_BASE}/api/agent/sessions/w1/close`);
    expect(res.result.content[0].text).toMatch(/^Closed worker w1 \[closed\]/);
  });

  it('advertises deletion as permanent and requiring an explicit user request', async () => {
    const s = await boot();
    const [res] = await s.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const tool = res.result.tools.find((t) => t.name === 'delete_worker');
    expect(tool.inputSchema.required).toEqual(['id']);
    expect(tool.description).toContain('ONLY when the user explicitly');
    expect(tool.description).toContain('close a worker does not authorize deletion');
    expect(tool.description).toContain('transcript and session history');
  });

  it('delete_worker issues one encoded DELETE with the session token', async () => {
    const fetched = stubFetch(reply({ body: { ok: true } }));
    const s = await boot();
    const [res] = await s.send(callTool('delete_worker', { id: 'worker/id' }));
    expect(fetched).toHaveBeenCalledExactlyOnceWith(`${URL_BASE}/api/agent/sessions/worker%2Fid`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: undefined,
    });
    expect(res.result.content[0].text).toContain('Permanently deleted worker worker/id');
  });

  it('refuses deletion without an id and surfaces a closed-state refusal', async () => {
    const fetched = stubFetch(reply({ status: 409, body: { error: 'Only closed sessions can be deleted' } }));
    const s = await boot();
    expect((await s.send(callTool('delete_worker', {})))[0].result.isError).toBe(true);
    expect(fetched).not.toHaveBeenCalled();
    const [res] = await s.send(callTool('delete_worker', { id: 'w1' }));
    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).toContain('Only closed sessions can be deleted');
    expect(fetched).toHaveBeenCalledTimes(1);
  });

  it('surfaces the route’s refusal as a tool error, not a crash', async () => {
    stubFetch(reply({ status: 403, body: { error: 'Only an orchestrator session can manage workers' } }));
    const s = await boot();

    const [res] = await s.send(callTool('list_workers', {}));

    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).toBe('Error: Only an orchestrator session can manage workers');
  });

  it('refuses to run unconfigured, before any fetch', async () => {
    const fetched = stubFetch();
    const s = await boot({ base: '', token: '' });

    const [res] = await s.send(callTool('list_workers', {}));

    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).toMatch(/not configured/);
    expect(fetched).not.toHaveBeenCalled();
  });
});

describe('set_worker_qa_loop', () => {
  it('requires an explicit boolean and id before making a request', async () => {
    const fetched = stubFetch();
    const s = await boot();
    for (const on of [undefined, null, 'false', 0, 1, {}]) {
      const [res] = await s.send(callTool('set_worker_qa_loop', { id: 'w1', on }));
      expect(res.result.isError).toBe(true);
      expect(res.result.content[0].text).toMatch(/boolean/);
    }
    const [res] = await s.send(callTool('set_worker_qa_loop', { on: false }));
    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).toMatch(/worker session id/);
    expect(fetched).not.toHaveBeenCalled();
  });

  it.each([true, false])('posts on: %s to the scoped route', async (on) => {
    const fetched = stubFetch(
      reply({ body: { session: worker(), qaStillRunning: false, qaSessionId: null } }),
    );
    const s = await boot();
    const [res] = await s.send(callTool('set_worker_qa_loop', { id: 'w/1', on }));
    expect(fetched.mock.calls[0][0]).toBe(`${URL_BASE}/api/agent/sessions/w%2F1/qa-loop`);
    expect(fetched.mock.calls[0][1]).toMatchObject({
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ on }),
    });
    expect(res.result.isError).toBeUndefined();
    expect(res.result.content[0].text).toContain(on ? 'QA loop armed' : 'QA loop off');
  });

  it('reports active QA as still running, not cancelled', async () => {
    stubFetch(reply({ body: { session: worker(), qaStillRunning: true, qaSessionId: 'qa-1' } }));
    const s = await boot();
    const [res] = await s.send(callTool('set_worker_qa_loop', { id: 'w1', on: false }));
    expect(res.result.content[0].text).toContain('QA session qa-1 is still running; it was not cancelled');
  });

  it('surfaces refusal from the existing state rules', async () => {
    stubFetch(reply({ status: 400, body: { error: 'turn the review loop on first' } }));
    const s = await boot();
    const [res] = await s.send(callTool('set_worker_qa_loop', { id: 'w1', on: true }));
    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).toContain('turn the review loop on first');
  });
});

it('starts an official PR action with the session bearer and no runtime overrides', async () => {
  const server = await boot();
  const fetch = stubFetch(
    reply({
      body: { session: { id: 'review-1', status: 'preparing', provider: 'codex', model: 'configured' } },
    }),
  );
  const [response] = await server.send(
    callTool('start_pr_action', { action: 'review', pr_number: 12, provider_id: 999 }),
  );
  expect(fetch).toHaveBeenCalledWith(
    `${URL_BASE}/api/agent/sessions/pr-actions`,
    expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({ Authorization: `Bearer ${TOKEN}` }),
      body: JSON.stringify({ action: 'review', prNumber: 12 }),
    }),
  );
  expect(response.result.content[0].text).toContain('review-1');
  expect(response.result.content[0].text).toContain('list_workers/read_worker');
});

it('advertises read-only project discovery and calls the orchestrator endpoint with its token', async () => {
  const projects = [{ id: 1, name: 'Shop', repo: 'acme/shop', enabled: true }];
  const fetched = stubFetch(reply({ body: { projects } }));
  const s = await boot();
  const [listed] = await s.send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  expect(listed.result.tools.find((tool) => tool.name === 'list_worker_projects')).toBeDefined();
  const [result] = await s.send(callTool('list_worker_projects', {}));
  expect(JSON.parse(result.result.content[0].text)).toEqual({ projects });
  expect(fetched).toHaveBeenCalledWith(`${URL_BASE}/api/agent/sessions/projects`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
  });
});
