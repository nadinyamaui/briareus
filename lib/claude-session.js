// @ts-check
import { spawn } from 'child_process';

// claude's own /compact, run headless against the session: `-p /compact
// --resume <id>` is a local command that summarizes the conversation in place
// and keeps the session id, so the next turn resumes the compacted thread. Its
// JSON result carries the cost of the summarizing call but zero token counts,
// which is why only cost and time come back from here; the context size is
// the /context probe's to measure afterwards.
/**
 * @param {{
 *   bin: string, cwd: string, env: NodeJS.ProcessEnv, sessionId: string, model: string,
 *   sysPromptFile?: string | null, onSpawn?: (child: import('child_process').ChildProcess) => void,
 *   spawnProcess?: typeof spawn, timeoutMs?: number,
 * }} opts
 * @returns {Promise<{ costUsd: number | null, durationMs: number | null, text: string }>}
 */
export function compactClaudeSession({
  bin,
  cwd,
  env,
  sessionId,
  model,
  sysPromptFile = null,
  onSpawn = () => {},
  spawnProcess = spawn,
  timeoutMs = 600000,
}) {
  // The same appended system prompt the turns run with keeps the summarizing
  // call on the prompt cache the conversation already built.
  const args = ['-p', '/compact', '--resume', sessionId, '--output-format', 'json', '--model', model];
  if (sysPromptFile) args.push('--append-system-prompt-file', sysPromptFile);
  return new Promise((resolve, reject) => {
    const child = spawnProcess(bin, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout?.on('data', (c) => {
      out += c.toString('utf8');
    });
    child.stderr?.on('data', (c) => {
      err += c.toString('utf8');
    });
    child.stdin?.on('error', () => {});
    child.stdin?.end();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.once('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (timedOut) return reject(new Error('Claude compaction timed out'));
      let report;
      try {
        report = JSON.parse(out);
      } catch {
        const why = err.trim().split('\n').pop() || `claude exited with code ${code}`;
        return reject(new Error(why));
      }
      if (code !== 0 || report.is_error || report.subtype !== 'success') {
        return reject(new Error(report.result || `Claude compaction ${report.subtype || 'failed'}`));
      }
      resolve({
        costUsd: report.total_cost_usd ?? null,
        durationMs: report.duration_ms ?? null,
        text: typeof report.result === 'string' ? report.result.trim() : '',
      });
    });
    onSpawn(child);
  });
}
