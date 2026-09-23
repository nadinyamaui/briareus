import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import { compactCodexThread, codexUsage } from '../lib/codex-session.js';

function fixture(options = {}) {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.kill = vi.fn(() => queueMicrotask(() => child.emit('close', 0)));
  const sent = [];
  child.stdin.on('data', (data) => sent.push(JSON.parse(data.toString())));
  const spawnProcess = vi.fn(() => child);
  const onUsage = vi.fn();
  const promise = compactCodexThread({
    bin: '/codex',
    cwd: '/workspace',
    env: { CODEX_HOME: '/account' },
    threadId: 'thread-a',
    model: 'test-model',
    config: { model_context_window: 872000 },
    spawnProcess,
    onUsage,
    ...options,
  });
  const receive = (msg) => child.stdout.write(`${JSON.stringify(msg)}\n`);
  const ready = () => {
    receive({ id: 0, result: {} });
    receive({ id: 1, result: { thread: { id: 'thread-a' } } });
    receive({ id: 2, result: {} });
  };
  return { child, sent, spawnProcess, onUsage, promise, receive, ready };
}

describe('Codex compaction protocol', () => {
  it('resumes the requested account/thread/model and waits beyond acknowledgement for its completed turn', async () => {
    const f = fixture();
    f.ready();
    expect(f.spawnProcess).toHaveBeenCalledWith(
      '/codex',
      ['app-server'],
      expect.objectContaining({
        cwd: '/workspace',
        env: { CODEX_HOME: '/account' },
      }),
    );
    expect(f.sent.map((m) => m.method)).toEqual([
      'initialize',
      'initialized',
      'thread/resume',
      'thread/compact/start',
    ]);
    expect(f.sent[2].params).toMatchObject({
      threadId: 'thread-a',
      model: 'test-model',
      config: { model_context_window: 872000 },
    });
    expect(f.child.kill).not.toHaveBeenCalled();
    f.receive({ method: 'turn/started', params: { threadId: 'thread-a', turn: { id: 'compact' } } });
    f.receive({
      method: 'turn/completed',
      params: { threadId: 'other', turn: { id: 'compact', status: 'completed' } },
    });
    f.receive({
      method: 'turn/completed',
      params: { threadId: 'thread-a', turn: { id: 'other', status: 'completed' } },
    });
    expect(f.child.kill).not.toHaveBeenCalled();
    f.receive({
      method: 'turn/completed',
      params: { threadId: 'thread-a', turn: { id: 'compact', status: 'completed' } },
    });
    await expect(f.promise).resolves.toBeUndefined();
    expect(f.child.kill).toHaveBeenCalledOnce();
  });

  it.each([0, 1, 2])('reports an RPC failure at stage %s', async (id) => {
    const f = fixture();
    f.receive({ id, error: { message: 'Provider refused' } });
    await expect(f.promise).rejects.toThrow('Provider refused');
  });

  it('reports turn failure rather than a successful compact', async () => {
    const f = fixture();
    f.ready();
    f.receive({ method: 'turn/started', params: { threadId: 'thread-a', turn: { id: 'c' } } });
    f.receive({
      method: 'turn/completed',
      params: {
        threadId: 'thread-a',
        turn: { id: 'c', status: 'failed', error: { message: 'Quota exceeded' } },
      },
    });
    await expect(f.promise).rejects.toThrow('Quota exceeded');
  });

  it('rejects premature exit and timeout', async () => {
    const exited = fixture();
    exited.child.emit('close', 1);
    await expect(exited.promise).rejects.toThrow('before completion');
    const timed = fixture({ timeoutMs: 5 });
    await expect(timed.promise).rejects.toThrow('timed out');
    expect(timed.child.kill).toHaveBeenCalledOnce();
  });

  it('reports context separately from lifetime input, cached input and reasoning', async () => {
    const f = fixture();
    f.ready();
    const total = {
      totalTokens: 1200,
      inputTokens: 1000,
      cachedInputTokens: 800,
      outputTokens: 200,
      reasoningOutputTokens: 150,
    };
    f.receive({
      method: 'thread/tokenUsage/updated',
      params: {
        threadId: 'thread-a',
        tokenUsage: { total, last: { ...total, totalTokens: 0 }, modelContextWindow: 10000 },
      },
    });
    expect(f.onUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        tokens: 0,
        window: 10000,
        inputTokens: 1000,
        outputTokens: 200,
        cachedInputTokens: 800,
        reasoningOutputTokens: 150,
      }),
    );
    f.child.emit('close', 0);
    await expect(f.promise).rejects.toThrow();
  });
});

it('keeps unknown Codex counts unknown and preserves zero', () => {
  expect(codexUsage({})).toMatchObject({ tokens: null, cachedInputTokens: null });
  expect(
    codexUsage({ last_token_usage: { total_tokens: 0 }, total_token_usage: { cached_input_tokens: 0 } }),
  ).toMatchObject({ tokens: 0, cachedInputTokens: 0 });
});
