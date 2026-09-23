import { spawn } from 'child_process';
import readline from 'readline';

// Both the rollout and app-server describe the latest model request separately
// from lifetime consumption. Cached and reasoning tokens are subsets, not extras.
export function codexUsage(info, at = new Date().toISOString()) {
  const total = info.total_token_usage || {};
  const last = info.last_token_usage || {};
  return {
    tokens: last.total_tokens ?? null,
    window: info.model_context_window ?? null,
    inputTokens: total.input_tokens ?? null,
    outputTokens: total.output_tokens ?? null,
    cachedInputTokens: total.cached_input_tokens ?? null,
    reasoningOutputTokens: total.reasoning_output_tokens ?? null,
    at,
    source: 'codex',
  };
}

// Acknowledgement only means queued. Keep the child alive until the matching
// compaction turn completes, then wait for process exit before allowing resume.
export function compactCodexThread({
  bin,
  cwd,
  env,
  threadId,
  model,
  config,
  onSpawn = () => {},
  onUsage = () => {},
  spawnProcess = spawn,
  timeoutMs = 300000,
}) {
  return new Promise((resolve, reject) => {
    const child = spawnProcess(bin, ['app-server'], {
      cwd,
      env,
      detached: true,
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    const lines = readline.createInterface({ input: child.stdout });
    let finishing = false;
    let failure;
    let completed = false;
    let compactRequested = false;
    let turnId;
    let killTimer;
    const finish = (error) => {
      if (finishing) return;
      finishing = true;
      failure = error;
      clearTimeout(timer);
      lines.close();
      child.kill();
      killTimer = setTimeout(() => child.kill('SIGKILL'), 2000);
      killTimer.unref();
    };
    const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
    const timer = setTimeout(() => finish(new Error('Codex compaction timed out')), timeoutMs);
    child.stdin.on('error', (error) => finish(error));
    child.once('error', (error) => finish(error));
    child.once('close', () => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      lines.close();
      if (completed && !failure) resolve();
      else reject(failure || new Error('Codex compaction stopped before completion'));
    });
    lines.on('line', (line) => {
      if (finishing) return;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      if (msg.error && [0, 1, 2].includes(msg.id)) {
        finish(new Error(msg.error.message || 'Codex compaction failed'));
        return;
      }
      if (msg.id === 0) {
        send({ method: 'initialized', params: {} });
        send({
          id: 1,
          method: 'thread/resume',
          params: {
            threadId,
            model,
            cwd,
            config,
            approvalPolicy: 'never',
            excludeTurns: true,
          },
        });
      } else if (msg.id === 1) {
        compactRequested = true;
        send({ id: 2, method: 'thread/compact/start', params: { threadId } });
      }
      const p = msg.params;
      if (!compactRequested || p?.threadId !== threadId) return;
      if (msg.method === 'turn/started') turnId = p.turn.id;
      if (msg.method === 'thread/tokenUsage/updated') {
        const u = p.tokenUsage;
        const convert = (v) => ({
          total_tokens: v.totalTokens,
          input_tokens: v.inputTokens,
          output_tokens: v.outputTokens,
          cached_input_tokens: v.cachedInputTokens,
          reasoning_output_tokens: v.reasoningOutputTokens,
        });
        onUsage(
          codexUsage({
            last_token_usage: convert(u.last),
            total_token_usage: convert(u.total),
            model_context_window: u.modelContextWindow,
          }),
        );
      }
      if (msg.method === 'turn/completed' && turnId && p.turn.id === turnId) {
        completed = p.turn.status === 'completed';
        finish(completed ? null : new Error(p.turn.error?.message || `Compaction ${p.turn.status}`));
      }
    });
    onSpawn(child);
    send({
      id: 0,
      method: 'initialize',
      params: {
        clientInfo: { name: 'briareus', version: '1.0.0' },
      },
    });
  });
}
