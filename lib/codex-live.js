// App Server owns the active turn; jobs.js owns delivery, recovery and process lifetime.
// Translate its notifications to the same events used by the exec usage/parser path.
export function codexLiveTurn({
  send,
  prompt,
  threadId,
  cwd,
  model,
  effort,
  onActive,
  onAccepted,
  onComplete,
}) {
  let nextId = 3;
  let turnId = null;
  let completion = null;
  let usage;
  let finished = false;
  const steers = new Map();
  const textInput = (text) => [{ type: 'text', text }];
  const finish = () => {
    if (!completion || steers.size || finished) return null;
    finished = true;
    const success = completion.status === 'completed';
    onComplete(success);
    return success
      ? { type: 'turn.completed', usage }
      : { type: 'turn.failed', error: completion.error || { message: `Codex turn ${completion.status}` } };
  };
  const fail = (message) => {
    onActive(false);
    completion = { status: 'failed', error: { message } };
    steers.clear();
    return finish();
  };
  return {
    get finished() {
      return finished;
    },
    start() {
      send({ id: 0, method: 'initialize', params: { clientInfo: { name: 'briareus', version: '1.0.0' } } });
    },
    steer(entry) {
      const id = nextId++;
      steers.set(id, entry);
      send({
        id,
        method: 'turn/steer',
        params: { threadId, expectedTurnId: turnId, input: textInput(entry.prompt) },
      });
    },
    feed(msg) {
      if (finished) return null;
      if (msg.id != null && msg.method) {
        // With approvalPolicy=never, an interactive request cannot be serviced by this transport.
        send({
          id: msg.id,
          error: {
            code: -32601,
            message: 'Interactive requests are not supported; ask the user in your reply.',
          },
        });
        return null;
      }
      if (steers.has(msg.id)) {
        const entry = steers.get(msg.id);
        steers.delete(msg.id);
        if (!msg.error && msg.result?.turnId === turnId) onAccepted(entry);
        // Rejected input stays pending in jobs.js and gets its own turn after completion.
        return finish();
      }
      if ([0, 1, 2].includes(msg.id) && msg.error)
        return fail(msg.error.message || 'Codex App Server request failed');
      if (msg.id === 0) {
        send({ method: 'initialized', params: {} });
        send({
          id: 1,
          method: threadId ? 'thread/resume' : 'thread/start',
          params: {
            ...(threadId ? { threadId, excludeTurns: true } : {}),
            cwd,
            model,
            approvalPolicy: 'never',
            sandbox: 'danger-full-access',
          },
        });
        return null;
      }
      if (msg.id === 1) {
        threadId = msg.result?.thread?.id;
        if (!threadId) return fail('Codex did not return a thread id');
        send({ id: 2, method: 'turn/start', params: { threadId, model, effort, input: textInput(prompt) } });
        return { type: 'thread.started', thread_id: threadId };
      }
      if (msg.id === 2) {
        if (!msg.result?.turn?.id) return fail('Codex did not return a turn id');
        if (!completion && !turnId) {
          turnId = msg.result.turn.id;
          onActive(true);
        }
        return null;
      }
      const p = msg.params;
      if (!threadId || p?.threadId !== threadId) return null;
      if (msg.method === 'turn/started' && !turnId) {
        turnId = p.turn.id;
        onActive(true);
      }
      if (msg.method === 'thread/tokenUsage/updated') {
        const u = p.tokenUsage.total;
        usage = {
          input_tokens: u.inputTokens,
          cached_input_tokens: u.cachedInputTokens,
          output_tokens: u.outputTokens,
        };
      }
      if (msg.method === 'turn/completed' && p.turn.id === turnId) {
        onActive(false);
        completion = p.turn;
        return finish();
      }
      if (p.turnId !== turnId) return null;
      if (msg.method === 'error') return { type: 'error', message: p.error?.message };
      if (msg.method !== 'item/started' && msg.method !== 'item/completed') return null;
      const item = p.item;
      const types = {
        agentMessage: 'agent_message',
        commandExecution: 'command_execution',
        fileChange: 'file_change',
        mcpToolCall: 'mcp_tool_call',
        webSearch: 'web_search',
      };
      return {
        type: msg.method.replace('/', '.'),
        item: {
          ...item,
          type: types[item.type] || item.type,
          exit_code: item.exitCode,
          aggregated_output: item.aggregatedOutput,
        },
      };
    },
  };
}
