import { describe, it, expect } from 'vitest';
import { apply, name } from '../lib/dsh-subagent-usage.js';

// The plugin against a stand-in for dsh's Cordis context: whatever it registers for
// `session/event` is driven with the events dsh's agent loop appends, and its `llm/stream`
// waterfall wraps a stand-in model stream.
function mount() {
  const lines = [];
  const listeners = {};
  const ctx = {
    on(event, fn) {
      expect(['session/event', 'llm/stream']).toContain(event);
      listeners[event] = fn;
      return () => {};
    },
  };
  apply(ctx, {}, { write: (line) => lines.push(JSON.parse(line)) });
  return {
    lines,
    emit: (s, event) => listeners['session/event'](s, event),
    stream: (options, chunks) =>
      listeners['llm/stream'](options, () =>
        (async function* () {
          for (const chunk of chunks) {
            if (chunk instanceof Error) throw chunk;
            yield chunk;
          }
        })(),
      ),
  };
}

const drain = async (stream) => {
  const seen = [];
  for await (const chunk of stream) seen.push(chunk);
  return seen;
};

const usageStream = (usage) => [
  { type: 'chunk', chunk: { type: 'text-delta', text: 'x' } },
  { type: 'chunk', chunk: { type: 'usage', usage } },
];
const message = (model, usage) => ({
  type: 'assistant/message',
  data: {
    turn: 1,
    step: 1,
    message: { content: [], source: { provider: 'deepseek-official', model } },
    usage,
    stream: [],
  },
});
const stepEnd = { type: 'step/end', data: { turn: 1, step: 1 } };

describe('the dsh sub-agent usage plugin', () => {
  const root = { id: 'session-root', header: { id: 'session-root' } };
  const child = { id: 'child-1', header: { id: 'child-1', parentSession: 'session-root' } };
  const grandchild = { id: 'child-2', header: { id: 'child-2', parentSession: 'child-1' } };

  it('is named for the patch row', () => {
    expect(name).toBe('briareus-subagent-usage');
  });

  it("reports each child step's usage and model, and the root's only as pending on the projection", () => {
    const { lines, emit } = mount();
    emit(root, message('deepseek-flash', { inputTokens: 1000, outputTokens: 20 }));
    emit(root, stepEnd);
    emit(child, message('deepseek-v4-pro', { inputTokens: 100000, outputTokens: 2000, cacheReadTokens: 0 }));
    emit(child, stepEnd);
    emit(grandchild, message('deepseek-flash', { inputTokens: 5, outputTokens: 1, cacheReadTokens: 3 }));
    emit(grandchild, stepEnd);
    expect(lines).toEqual([
      {
        type: 'pending_root_usage',
        sessionId: 'session-root',
        model: 'deepseek-flash',
        usage: { inputTokens: 1000, outputTokens: 20 },
      },
      {
        type: 'subagent_usage',
        sessionId: 'child-1',
        parentSessionId: 'session-root',
        model: 'deepseek-v4-pro',
        usage: { inputTokens: 100000, outputTokens: 2000, cacheReadTokens: 0 },
      },
      {
        type: 'subagent_usage',
        sessionId: 'child-2',
        parentSessionId: 'child-1',
        model: 'deepseek-flash',
        usage: { inputTokens: 5, outputTokens: 1, cacheReadTokens: 3 },
      },
    ]);
  });

  it('sums retried attempts into the step, as the projection does for the root', () => {
    const { lines, emit } = mount();
    emit(child, {
      type: 'assistant/attempt',
      data: { stream: usageStream({ inputTokens: 40, outputTokens: 4, cacheReadTokens: 10 }) },
    });
    emit(child, {
      type: 'assistant/message',
      data: {
        message: { content: [], source: { model: 'deepseek-flash' } },
        stream: usageStream({ inputTokens: 60, outputTokens: 6, cacheReadTokens: 20 }),
      },
    });
    emit(child, stepEnd);
    expect(lines.map((l) => l.usage)).toEqual([{ inputTokens: 100, outputTokens: 10, cacheReadTokens: 30 }]);
  });

  it('drops a cache bucket one attempt left out', () => {
    const { lines, emit } = mount();
    emit(child, {
      type: 'assistant/attempt',
      data: { stream: usageStream({ inputTokens: 1, outputTokens: 1 }) },
    });
    emit(child, message('deepseek-flash', { inputTokens: 2, outputTokens: 2, cacheReadTokens: 2 }));
    emit(child, stepEnd);
    expect(lines.map((l) => l.usage)).toEqual([{ inputTokens: 3, outputTokens: 3 }]);
  });

  it('keeps what a retried child step measured, as partial, when an attempt reported nothing', () => {
    const { lines, emit } = mount();
    // An HTTP 429 attempt, then its retry.
    emit(child, { type: 'assistant/attempt', data: { stream: [] } });
    emit(child, message('deepseek-flash', { inputTokens: 100000, outputTokens: 2000, cacheReadTokens: 0 }));
    emit(child, stepEnd);
    // A step where nothing was measured writes nothing.
    emit(child, { type: 'assistant/attempt', data: { stream: [] } });
    emit(child, message('deepseek-flash', undefined));
    emit(child, stepEnd);
    expect(lines).toEqual([
      {
        type: 'subagent_usage',
        sessionId: 'child-1',
        parentSessionId: 'session-root',
        model: 'deepseek-flash',
        usage: { inputTokens: 100000, outputTokens: 2000, cacheReadTokens: 0 },
        partial: true,
      },
    ]);
  });

  it('writes a root step as booked only when the projection drops its usage for an unmeasured attempt', () => {
    const { lines, emit } = mount();
    emit(root, message('deepseek-flash', { inputTokens: 1000, outputTokens: 20 }));
    emit(root, stepEnd);
    emit(root, { type: 'assistant/attempt', data: { stream: [] } });
    emit(root, message('deepseek-flash', { inputTokens: 802000, outputTokens: 2060, cacheReadTokens: 0 }));
    emit(root, stepEnd);
    // A step that ended without a message, every attempt measured, is the projection's alone.
    emit(root, {
      type: 'assistant/attempt',
      data: { stream: usageStream({ inputTokens: 7, outputTokens: 0 }) },
    });
    emit(root, stepEnd);
    expect(lines.map((l) => l.type)).toEqual(['pending_root_usage', 'root_usage']);
    expect(lines.slice(1)).toEqual([
      {
        type: 'root_usage',
        sessionId: 'session-root',
        model: 'deepseek-flash',
        usage: { inputTokens: 802000, outputTokens: 2060, cacheReadTokens: 0 },
        partial: true,
      },
    ]);
  });

  it('writes a step when its message commits, before its tools run, so a Stop during one loses nothing', () => {
    const { lines, emit } = mount();
    emit(root, message('deepseek-flash', { inputTokens: 1000, outputTokens: 20, cacheReadTokens: 0 }));
    emit(child, { type: 'assistant/attempt', data: { stream: [] } });
    emit(child, message('deepseek-v4-pro', { inputTokens: 300, outputTokens: 3 }));
    // No step/end: dsh was killed while both steps' tools ran.
    expect(lines).toEqual([
      {
        type: 'pending_root_usage',
        sessionId: 'session-root',
        model: 'deepseek-flash',
        usage: { inputTokens: 1000, outputTokens: 20, cacheReadTokens: 0 },
      },
      {
        type: 'subagent_usage',
        sessionId: 'child-1',
        parentSessionId: 'session-root',
        model: 'deepseek-v4-pro',
        usage: { inputTokens: 300, outputTokens: 3 },
        partial: true,
      },
    ]);
    // The step's end, when it does come, writes nothing more.
    emit(root, stepEnd);
    emit(child, stepEnd);
    expect(lines).toHaveLength(2);
  });

  it("reports every compaction call's usage and model, the root's included", async () => {
    const { lines, stream } = mount();
    const chunks = [
      { type: 'text-delta', text: 'summary' },
      { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } },
      { type: 'usage', usage: { inputTokens: 700000, outputTokens: 20, cacheReadTokens: 0 } },
      { type: 'finish', reason: { kind: 'completed' } },
    ];
    const compaction = { purpose: 'compaction', sessionId: 'session-root', model: 'deepseek-flash' };
    // Passed through untouched, so dsh still assembles its summary.
    expect(await drain(stream(compaction, chunks))).toEqual(chunks);
    expect(
      await drain(stream({ ...compaction, sessionId: 'child-1', model: 'deepseek-v4-pro' }, chunks)),
    ).toEqual(chunks);
    expect(lines).toEqual([
      {
        type: 'compaction_usage',
        sessionId: 'session-root',
        model: 'deepseek-flash',
        usage: { inputTokens: 700000, outputTokens: 20, cacheReadTokens: 0 },
      },
      {
        type: 'compaction_usage',
        sessionId: 'child-1',
        model: 'deepseek-v4-pro',
        usage: { inputTokens: 700000, outputTokens: 20, cacheReadTokens: 0 },
      },
    ]);
  });

  it('counts a compaction call that failed after reporting usage, and leaves other calls to the steps', async () => {
    const { lines, stream } = mount();
    const usage = { type: 'usage', usage: { inputTokens: 500, outputTokens: 5 } };
    await expect(
      drain(stream({ purpose: 'compaction', sessionId: 's', model: 'm' }, [usage, new Error('cut')])),
    ).rejects.toThrow('cut');
    // An agent-loop request, a title and a compaction that reported nothing write no line.
    await drain(stream({ sessionId: 's', model: 'm' }, [usage]));
    await drain(stream({ purpose: 'session-title', sessionId: 's', model: 'm' }, [usage]));
    await drain(stream({ purpose: 'compaction', sessionId: 's', model: 'm' }, [{ type: 'finish' }]));
    expect(lines).toEqual([
      { type: 'compaction_usage', sessionId: 's', model: 'm', usage: { inputTokens: 500, outputTokens: 5 } },
    ]);
  });

  it('never throws into dsh on an event it cannot read', () => {
    const { lines, emit } = mount();
    expect(() => emit(child, null)).not.toThrow();
    expect(() =>
      emit(
        {
          get header() {
            throw new Error('gone');
          },
        },
        stepEnd,
      ),
    ).not.toThrow();
    expect(lines).toEqual([]);
  });
});
