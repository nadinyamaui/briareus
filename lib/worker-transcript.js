// @ts-check

// Which log lines a supervisor gets to read: the conversation and its
// verdicts, not the workspace-prep and tool-step noise that dominates a
// turn's event count and would crowd the reading agent's context for nothing.
const AGENT_EVENT_KINDS = new Set([
  'user',
  'text',
  'ask',
  'info',
  'status',
  'stderr',
  'tool_error',
  'result',
]);

// Kept separate from server startup so both read modes exercise the same
// filtering and bounded log read in tests.
export async function workerTranscript(worker, query, readEvents) {
  const tail = Math.min(500, Math.max(1, Number(query.tail) || 40));
  const fullText = query.full_text === 'true';
  // Long-lived workers can hold tens of thousands of tool steps; keep the
  // existing recent-log window even when the caller requests complete text.
  return (await readEvents(worker, Math.max(0, (worker.seq || 0) - 4000)))
    .filter((e) => AGENT_EVENT_KINDS.has(e.kind))
    .slice(-tail)
    .map((e) =>
      !fullText && typeof e.text === 'string' && e.text.length > 2000
        ? { ...e, text: `${e.text.slice(0, 2000)}…`, textTruncated: true }
        : e,
    );
}
