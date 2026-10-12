import { describe, it, expect } from 'vitest';
import { codexLiveTurn } from '../lib/codex-live.js';
import { BINARIES, parserFor, newTurn } from '../lib/providers.js';

function fixture(threadId = null) {
  const sent = [],
    active = [],
    accepted = [],
    completed = [],
    events = [];
  const turn = newTurn();
  const parser = parserFor('codex', turn);
  const live = codexLiveTurn({
    send: (m) => sent.push(m),
    prompt: 'Build the form',
    threadId,
    cwd: '/workspace',
    model: 'gpt-6.1-sol',
    effort: 'medium',
    onActive: (v) => active.push(v),
    onAccepted: (v) => accepted.push(v),
    onComplete: (v) => completed.push(v),
  });
  const feed = (m) => {
    const event = live.feed(m);
    if (event) events.push(...parser.feed(event));
  };
  const notify = (method, params = {}) =>
    feed({ method, params: { threadId: 'thread-1', turnId: 'turn-1', ...params } });
  const ready = () => {
    live.start();
    feed({ id: 0, result: {} });
    feed({ id: 1, result: { thread: { id: 'thread-1' } } });
    notify('turn/started', { turn: { id: 'turn-1' } });
    feed({ id: 2, result: { turn: { id: 'turn-1' } } });
  };
  const finish = (status = 'completed') => notify('turn/completed', { turn: { id: 'turn-1', status } });
  return { live, feed, notify, ready, finish, sent, active, accepted, completed, events, turn };
}

describe('Codex live turns', () => {
  it.each([null, 'thread-1'])(
    'starts/resumes %s with the configured runtime and steers that same turn',
    (threadId) => {
      const f = fixture(threadId);
      f.ready();
      expect(f.sent[2]).toEqual({
        id: 1,
        method: threadId ? 'thread/resume' : 'thread/start',
        params: {
          ...(threadId ? { threadId, excludeTurns: true } : {}),
          cwd: '/workspace',
          model: 'gpt-6.1-sol',
          approvalPolicy: 'never',
          sandbox: 'danger-full-access',
        },
      });
      expect(f.sent[3]).toEqual({
        id: 2,
        method: 'turn/start',
        params: {
          threadId: 'thread-1',
          model: 'gpt-6.1-sol',
          effort: 'medium',
          input: [{ type: 'text', text: 'Build the form' }],
        },
      });
      expect(f.active).toEqual([true]);
      const entry = { prompt: 'Also require a phone number' };
      f.live.steer(entry);
      expect(f.sent.at(-1)).toEqual({
        id: 3,
        method: 'turn/steer',
        params: {
          threadId: 'thread-1',
          expectedTurnId: 'turn-1',
          input: [{ type: 'text', text: entry.prompt }],
        },
      });
      expect(f.accepted).toEqual([]);
      f.feed({ id: 3, result: { turnId: 'turn-1' } });
      expect(f.accepted).toEqual([entry]);
      f.finish();
      expect(f.completed).toEqual([true]);
      expect(f.active).toEqual([true, false]);
      expect(f.live.finished).toBe(true);
    },
  );

  it('waits for an in-flight steer reply after completion and leaves rejected input unacknowledged', () => {
    const f = fixture();
    f.ready();
    f.live.steer({ prompt: 'Too late' });
    f.finish();
    expect(f.active).toEqual([true, false]);
    expect(f.completed).toEqual([]);
    f.feed({ id: 3, error: { message: 'No active turn' } });
    expect(f.accepted).toEqual([]);
    expect(f.completed).toEqual([true]);
  });

  it('correlates simultaneous messages by request id, including out-of-order replies', () => {
    const f = fixture();
    f.ready();
    const a = { prompt: 'First' },
      b = { prompt: 'Second' };
    f.live.steer(a);
    f.live.steer(b);
    f.feed({ id: 4, result: { turnId: 'turn-1' } });
    f.feed({ id: 3, error: { message: 'rejected' } });
    f.finish();
    expect(f.accepted).toEqual([b]);
    expect(f.completed).toEqual([true]);
  });

  it.each([0, 1, 2])('reports initialization failure at request %s', (id) => {
    const f = fixture();
    f.live.start();
    f.feed({ id, error: { message: 'Connection failed' } });
    expect(f.completed).toEqual([false]);
    expect(f.events).toContainEqual(
      expect.objectContaining({ kind: 'result', isError: true, text: 'Connection failed' }),
    );
  });

  it('ignores another thread and turn, and reports failed turns', () => {
    const f = fixture();
    f.ready();
    f.notify('turn/completed', { threadId: 'worker', turn: { id: 'turn-1', status: 'completed' } });
    f.notify('turn/completed', { turn: { id: 'old', status: 'completed' } });
    expect(f.completed).toEqual([]);
    f.finish('failed');
    expect(f.completed).toEqual([false]);
    expect(f.events.at(-1)).toMatchObject({ kind: 'result', isError: true });
  });

  it('preserves text, tool errors, edits and lifetime usage for the existing parser', () => {
    const f = fixture();
    f.ready();
    f.notify('item/started', { item: { type: 'commandExecution', command: 'npm test' } });
    f.notify('item/completed', {
      item: {
        type: 'commandExecution',
        command: 'npm test',
        exitCode: 1,
        aggregatedOutput: 'Failed assertion',
      },
    });
    f.notify('item/completed', { item: { type: 'fileChange', changes: [{ path: 'form.js' }] } });
    f.notify('item/completed', { item: { type: 'agentMessage', text: 'Phone is required.' } });
    f.notify('thread/tokenUsage/updated', {
      tokenUsage: { total: { inputTokens: 500, cachedInputTokens: 300, outputTokens: 25 } },
    });
    f.finish();
    expect(f.events.slice(1)).toEqual([
      { kind: 'tool', name: 'Shell', summary: 'npm test' },
      { kind: 'tool_error', text: 'exit 1: Failed assertion' },
      { kind: 'tool', name: 'Edit', summary: 'form.js' },
      { kind: 'text', text: 'Phone is required.' },
      {
        kind: 'result',
        subtype: 'success',
        isError: false,
        tokens: null,
        inputTokens: 500,
        outputTokens: 25,
      },
    ]);
    expect(f.turn.cachedInputTokens).toBe(300);
  });

  it('uses App Server only for live runs and retains model, effort, window and MCP settings', () => {
    const built = BINARIES.codex.buildArgs({
      live: true,
      model: 'gpt-6.1-sol (872k)',
      effort: 'medium',
      mcp: [{ name: 'test', command: '/tool', args: [] }],
    });
    expect(built.promptVia).toBe('codex-rpc');
    expect(built.args[0]).toBe('app-server');
    expect(built.args).toContain('model="gpt-6.1-sol"');
    expect(built.args).toContain('model_reasoning_effort="medium"');
    expect(built.args).toContain('model_context_window=872000');
    expect(built.args.join(' ')).toContain('mcp_servers.test.command=');
    expect(built.args).not.toContain('--dangerously-bypass-approvals-and-sandbox');
    expect(BINARIES.codex.buildArgs({ model: 'gpt-6.1-sol', effort: 'medium' }).args[0]).toBe('exec');
  });
});
