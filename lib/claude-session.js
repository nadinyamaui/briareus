// @ts-check
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

// Only main-thread quota failures count; a tool's output, a
// subagent error or a quota warning must never move the conversation.
export function claudeQuotaFailure(message) {
  if (message.parent_tool_use_id) return false;
  let text;
  if (message.type === 'assistant' && message.error === 'rate_limit') {
    const content = message.message?.content;
    text = Array.isArray(content)
      ? content
          .filter((block) => block.type === 'text')
          .map((block) => block.text)
          .join('\n')
      : typeof content === 'string'
        ? content
        : '';
  } else if (message.type === 'result' && message.is_error) {
    text = [message.result, ...(Array.isArray(message.errors) ? message.errors : [])].join('\n');
  } else return false;
  return /(?:you(?:'|’)ve hit your (?:session )?limit|usage limit (?:reached|exceeded)|(?:5.hour|weekly|session) limit (?:reached|exceeded))/i.test(
    text,
  );
}

// Copy just this conversation, after its process exits. Account credentials
// and unrelated conversations stay in their own directories.
export function transferClaudeSession({ fromDir, toDir, sessionId }) {
  if (!/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(sessionId))
    throw new Error('Invalid Claude session ID for account switch');
  const projects = path.join(fromDir, 'projects');
  const matches = fs
    .readdirSync(projects, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(projects, entry.name))
    .filter((dir) => fs.existsSync(path.join(dir, `${sessionId}.jsonl`)));
  if (matches.length !== 1)
    throw new Error('Could not uniquely locate the Claude conversation for account switch');
  const source = matches[0];
  const destination = path.join(toDir, 'projects', path.basename(source));
  fs.mkdirSync(destination, { recursive: true });
  const temp = path.join(destination, `${sessionId}.${crypto.randomUUID()}.tmp`);
  try {
    fs.copyFileSync(path.join(source, `${sessionId}.jsonl`), temp);
    for (const [from, to] of [
      [path.join(source, sessionId), path.join(destination, sessionId)],
      [path.join(fromDir, 'file-history', sessionId), path.join(toDir, 'file-history', sessionId)],
    ]) {
      if (fs.existsSync(from)) fs.cpSync(from, to, { recursive: true });
    }
    fs.renameSync(temp, path.join(destination, `${sessionId}.jsonl`));
  } finally {
    fs.rmSync(temp, { force: true });
  }
}

// claude's own /compact, run headless against the session: `-p /compact
// --resume <id>` is a local command that summarizes the conversation in place
// and keeps the session id, so the next turn resumes the compacted thread. Its
// JSON result carries the cost of the summarizing call but zero token counts,
// which is why only cost and time come back from here; the context size is
// the /context probe's to measure afterwards. Instructions ride along as
// /compact's argument and steer what the summary keeps.
/**
 * @param {{
 *   bin: string, cwd: string, env: NodeJS.ProcessEnv, sessionId: string, model: string,
 *   instructions?: string, sysPromptFile?: string | null, onSpawn?: (child: import('child_process').ChildProcess) => void,
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
  instructions = '',
  sysPromptFile = null,
  onSpawn = () => {},
  spawnProcess = spawn,
  timeoutMs = 600000,
}) {
  // The same appended system prompt the turns run with keeps the summarizing
  // call on the prompt cache the conversation already built.
  const command = instructions ? `/compact ${instructions}` : '/compact';
  const args = ['-p', command, '--resume', sessionId, '--output-format', 'json', '--model', model];
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
