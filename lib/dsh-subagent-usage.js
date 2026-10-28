// A dsh plugin each turn's --patch overlay mounts (see dshPatchContent in providers.js). The
// headless --json projection reports only the root session's usage, while native `subagent` and
// `subagent_fork` calls run in child sessions it drops, so their spend never reached the turn.
// This writes one `subagent_usage` line per finished child step, totalled the way the projection
// totals the root's: every attempt of the step counts, and a step with an attempt that reported
// nothing carries no usage rather than a partial sum. Fork-inherited history never publishes on
// `session/event`, so only what the child itself spent is counted. Automatic compaction is a model
// call of its own, in the root or a child, that no step records, so each one is metered on the way
// through `llm/stream` and written as a `compaction_usage` line, whether or not dsh then keeps the
// summary. It reads no dsh module, so it works against whichever dsh binary runs it, and a failure
// here must never break the turn.

export const name = 'briareus-subagent-usage';

// The usage chunk an attempt's stream reported last, as dsh-llm's lastAssistantStreamChunk reads it.
function streamUsage(stream) {
  if (!Array.isArray(stream)) return undefined;
  for (let i = stream.length - 1; i >= 0; i--) {
    const record = stream[i];
    if (record?.type === 'chunk' && record.chunk?.type === 'usage') return record.chunk.usage;
  }
  return undefined;
}

// An optional bucket is summed only when every attempt reports it.
function addUsage(step, next) {
  if (next === undefined) return { ...step, complete: false };
  if (step.usage === undefined) return { ...step, usage: next };
  const sum = (a, b) => (a === undefined || b === undefined ? undefined : a + b);
  const total = step.usage;
  const usage = {
    inputTokens: (total.inputTokens || 0) + (next.inputTokens || 0),
    outputTokens: (total.outputTokens || 0) + (next.outputTokens || 0),
  };
  for (const k of ['cacheReadTokens', 'cacheWriteTokens']) {
    const v = sum(total[k], next[k]);
    if (v !== undefined) usage[k] = v;
  }
  return { ...step, usage };
}

// A compaction request's chunks passed through untouched; its last usage chunk, the one dsh's
// BlockAssembler keeps, is written once the stream ends, however it ends.
async function* meterCompaction(stream, options, sink) {
  let usage;
  try {
    for await (const chunk of stream) {
      if (chunk?.type === 'usage') usage = chunk.usage;
      yield chunk;
    }
  } finally {
    try {
      if (usage !== undefined)
        sink.write(
          `${JSON.stringify({
            type: 'compaction_usage',
            sessionId: options.sessionId ?? null,
            model: options.model || null,
            usage,
          })}\n`,
        );
    } catch {
      /* accounting must not break the run */
    }
  }
}

export function apply(ctx, _config, sink = process.stdout) {
  ctx.on(
    'llm/stream',
    (options, next) => (options?.purpose === 'compaction' ? meterCompaction(next(), options, sink) : next()),
    { global: true },
  );

  // Per child session: the step in progress and the model its messages named.
  const steps = new Map();
  ctx.on('session/event', (session, event) => {
    try {
      const parentSessionId = session?.header?.parentSession;
      if (parentSessionId === undefined) return;
      const id = session.id;
      const step = steps.get(id) || { usage: undefined, complete: true, model: null };
      switch (event?.type) {
        case 'assistant/attempt':
          steps.set(id, addUsage(step, streamUsage(event.data?.stream)));
          return;
        case 'assistant/message': {
          const next = addUsage(step, event.data?.usage ?? streamUsage(event.data?.stream));
          next.model = event.data?.message?.source?.model || step.model;
          steps.set(id, next);
          return;
        }
        case 'step/end':
          steps.delete(id);
          if (!step.complete || step.usage === undefined) return;
          sink.write(
            `${JSON.stringify({
              type: 'subagent_usage',
              sessionId: id,
              parentSessionId,
              model: step.model,
              usage: step.usage,
            })}\n`,
          );
          return;
        default:
          return;
      }
    } catch {
      /* accounting must not break the run */
    }
  });
}
