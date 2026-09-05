import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { workerTranscript } from '../lib/worker-transcript.js';

// orchestrator-mcp.js is a stdio server like memory-mcp.js: it exports nothing
// and wires itself to stdin at import, so these tests drive it the same way
// that suite does: mock readline to capture the line handler, feed it JSON-RPC
// frames, and read the replies off a stubbed stdout. BASE and TOKEN are read
// at import time, so every test imports a fresh copy.
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

  it('lists the eight worker tools, with the two spawns requiring title and prompt', async () => {
    const s = await boot();

    const [res] = await s.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });

    expect(res.result.tools.map((t) => t.name)).toEqual([
      'spawn_worker',
      'fix_tooling',
      'list_workers',
      'read_worker',
      'send_to_worker',
      'triage_findings',
      'retry_review',
      'close_worker',
    ]);
    expect(res.result.tools[0].inputSchema.required).toEqual(['title', 'prompt']);
    expect(res.result.tools[1].inputSchema.required).toEqual(['title', 'prompt']);
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
        reviewLoop: false,
        qaLoop: false,
      }),
    });
    expect(res.result.content[0].text).toMatch(/^Started worker w1 \[idle\] Fix the login/);
  });

  it('spawn_worker passes the loops the orchestrator asked for', async () => {
    const fetched = stubFetch(reply({ status: 201, body: { session: worker() } }));
    const s = await boot();

    await s.send(
      callTool('spawn_worker', {
        title: 'Fix the login',
        prompt: 'Do it',
        review_loop: true,
        qa_loop: true,
      }),
    );

    const body = JSON.parse(fetched.mock.calls[0][1].body);
    expect(body.reviewLoop).toBe(true);
    expect(body.qaLoop).toBe(true);
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

  it('list_workers says where the armed loops stand', async () => {
    stubFetch(
      reply({
        body: {
          sessions: [
            worker({
              reviewLoop: { rounds: 2, reviewing: true, fixing: false, done: false },
              qaLoop: { running: false, done: false, failedScenarios: 0 },
            }),
            worker({
              id: 'w2',
              reviewLoop: { rounds: 3, reviewing: false, fixing: false, done: true },
              qaLoop: { running: false, done: true, failedScenarios: 2 },
            }),
            // A round whose review is over and whose findings are still being
            // read off the pull request: mid-round, not waiting for a push.
            worker({
              id: 'w3',
              reviewLoop: { rounds: 1, reviewing: false, awaitingResult: true, done: false },
            }),
            worker({
              id: 'w4',
              reviewLoop: { rounds: 1, done: true },
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
              reviewLoop: { rounds: 1, done: true },
              qaLoop: { running: false, done: false },
            }),
          ],
        },
      }),
    );
    const s = await boot();

    const [res] = await s.send(callTool('list_workers', {}));

    const lines = res.result.content[0].text.split('\n');
    expect(lines[0]).toContain('review loop round 2: reviewing');
    expect(lines[0]).toContain('QA queued behind the review loop');
    expect(lines[1]).toContain('review loop round 3: converged');
    expect(lines[1]).toContain('QA failed: 2 scenario(s)');
    expect(lines[2]).toContain("review loop round 1: reading the round's result off the pull request");
    expect(lines[3]).toContain(
      'QA failed (Claude HQ exited with code 1); not running — send_to_worker starts a retry when the worker settles',
    );
    expect(lines[3]).not.toContain('QA queued');
    expect(lines[4]).toContain(
      'QA retry pending after an incomplete run; not running — send_to_worker starts a retry when the worker settles',
    );
    expect(lines[4]).not.toContain('QA queued');
  });

  it('list_workers tells a round that could not run from a loop that converged', async () => {
    stubFetch(
      reply({
        body: {
          sessions: [
            worker({
              reviewLoop: {
                rounds: 2,
                done: false,
                failure: { round: 2, reason: 'Claude HD exited with code 1' },
              },
            }),
          ],
        },
      }),
    );
    const s = await boot();

    const [res] = await s.send(callTool('list_workers', {}));

    expect(res.result.content[0].text).toContain(
      'review loop round 2: round 2 could not run (Claude HD exited with code 1) — nothing approved, retry_review re-runs it',
    );
  });

  it('retry_review re-runs the round, on another runtime when one is named', async () => {
    const fetched = stubFetch(reply({ body: { session: worker(), started: true, round: 3 } }));
    const s = await boot();

    const [res] = await s.send(
      callTool('retry_review', { id: 'w1', provider_id: 16, model: 'claude-opus-5' }),
    );

    expect(fetched).toHaveBeenCalledWith(`${URL_BASE}/api/agent/sessions/w1/retry-review`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ providerId: 16, model: 'claude-opus-5' }),
    });
    expect(res.result.content[0].text).toMatch(/^Review round 3 is running again\./);
  });

  it('retry_review says a queued round starts when the worker is free', async () => {
    stubFetch(reply({ body: { session: worker(), started: false, round: 2 } }));
    const s = await boot();

    const [res] = await s.send(callTool('retry_review', { id: 'w1' }));

    expect(res.result.content[0].text).toMatch(/^The round is queued/);
  });

  it('list_workers exposes a transient PR discovery failure and retry state', async () => {
    stubFetch(
      reply({
        body: {
          sessions: [
            worker({
              reviewLoop: {
                rounds: 0,
                discoveryError: 'GitHub returned 503',
                discoveryRetries: 1,
                discoveryRetryPending: true,
              },
            }),
          ],
        },
      }),
    );
    const s = await boot();

    const [res] = await s.send(callTool('list_workers', {}));

    expect(res.result.content[0].text).toContain(
      'review loop round 0: PR discovery failed (GitHub returned 503); retry 1/3 pending',
    );
  });

  it('list_workers formats one line per worker, waiting state included', async () => {
    stubFetch(
      reply({
        body: {
          sessions: [
            worker({ awaitingAnswer: true, pr: { number: 7, state: 'open', checks: '✓2 ✗0 ●1' } }),
            worker({ id: 'w2', title: 'Docs', status: 'running', costUsd: null, lastText: null }),
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

  const heldRound = {
    prNumber: 7,
    round: 2,
    findings: [
      {
        key: 'abc123',
        severity: 'high',
        title: 'Race in the cache',
        file: 'lib/c.js',
        line: 9,
        parked: null,
      },
      { key: 'def456', severity: 'low', title: 'Nit', file: null, line: null, parked: 'below the floor' },
    ],
  };

  it('list_workers says a round is waiting for the orchestrator’s triage', async () => {
    stubFetch(
      reply({
        body: {
          sessions: [
            worker({ reviewLoop: { rounds: 2, reviewing: false, fixing: false, triage: heldRound } }),
          ],
        },
      }),
    );
    const s = await boot();

    const [res] = await s.send(callTool('list_workers', {}));

    expect(res.result.content[0].text).toContain('review loop round 2: 2 finding(s) awaiting your triage');
  });

  it('read_worker lists the held findings by key, with the loop’s advice', async () => {
    stubFetch(
      reply({
        body: {
          session: worker({ reviewLoop: { rounds: 2, triage: heldRound } }),
          events: [{ kind: 'text', text: 'Pushed.' }],
        },
      }),
    );
    const s = await boot();

    const [res] = await s.send(callTool('read_worker', { id: 'w1' }));

    const text = res.result.content[0].text;
    expect(text).toContain('Review round 2 of PR #7 is waiting for your triage_findings verdicts:');
    expect(text).toContain('- [abc123] HIGH: Race in the cache (lib/c.js:9)');
    expect(text).toContain('- [def456] LOW: Nit — the loop would have parked it: below the floor');
  });

  it('triage_findings posts the verdicts and says what the loop did with them', async () => {
    const fetched = stubFetch(
      reply({
        body: {
          session: worker({ reviewLoop: { rounds: 2, fixing: true, triage: null } }),
          fixing: true,
          converged: false,
        },
      }),
      reply({
        body: {
          session: worker({ reviewLoop: { rounds: 2, done: true, triage: null } }),
          fixing: false,
          converged: true,
        },
      }),
    );
    const s = await boot();

    const verdicts = [
      { key: 'abc123', decision: 'fix' },
      { key: 'def456', decision: 'dismissed', reason: 'a nit on generated code' },
    ];
    const [res] = await s.send(
      callTool('triage_findings', { id: 'w1', verdicts, note: 'Mind the lock order.' }),
    );

    expect(fetched.mock.calls[0][0]).toBe(`${URL_BASE}/api/agent/sessions/w1/triage`);
    expect(JSON.parse(fetched.mock.calls[0][1].body)).toEqual({ verdicts, note: 'Mind the lock order.' });
    expect(res.result.content[0].text).toMatch(
      /^Triaged\. A fix session is implementing what you kept.*Worker is now: w1 .*review loop round 2: fixing findings/,
    );

    const [again] = await s.send(callTool('triage_findings', { id: 'w1', verdicts }));
    expect(again.result.content[0].text).toMatch(/^Triaged\. Nothing left to fix: the loop converged/);
  });

  it('triage_findings without a worker id says which tool finds it', async () => {
    const fetched = stubFetch();
    const s = await boot();

    const [res] = await s.send(callTool('triage_findings', { verdicts: [] }));

    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).toMatch(/needs the worker session id/);
    expect(fetched).not.toHaveBeenCalled();
  });

  it('close_worker posts the close', async () => {
    const fetched = stubFetch(reply({ body: { session: worker({ status: 'closed' }) } }));
    const s = await boot();

    const [res] = await s.send(callTool('close_worker', { id: 'w1' }));

    expect(fetched.mock.calls[0][0]).toBe(`${URL_BASE}/api/agent/sessions/w1/close`);
    expect(res.result.content[0].text).toMatch(/^Closed worker w1 \[closed\]/);
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
