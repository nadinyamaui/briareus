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

// claude's own /compact run headless: `-p /compact --resume <id>` summarizes in place and
// keeps the session id. Its JSON result has the cost but zero token counts, so only cost
// and time come back; the /context probe measures the size afterwards. Instructions ride
// as /compact's argument to steer the summary.
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
  // The turns' appended system prompt keeps this call on the conversation's prompt cache.
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

// What the fork is told above a side question. Claude Code's /btw refuses to run
// headless, so the fork stands in, and the model must learn the main task may be mid-tool
// (shown as interrupted though still running) and is not this answer's to resume.
const SIDE_QUESTION_NOTE =
  '<system-reminder>This is a side question from the user (/btw), asked while the main task carries on separately. ' +
  'Answer it directly and concisely from what this conversation already shows. Do not use any tools, and do not ' +
  'continue, resume or redo the main task: this answer is not added to the main conversation, and a tool call that ' +
  'looks interrupted here may still be running there.</system-reminder>';

// A /btw side question answered from an unsaved fork: `--fork-session` leaves the
// session's thread untouched (so it can run beside a live turn) and
// `--no-session-persistence` keeps the fork off disk. Built-in tools are off, strict MCP
// config excludes workspace and user servers, and hooks are off so inherited command
// hooks cannot act on the shared checkout.
/**
 * @param {{
 *   bin: string, cwd: string, env: NodeJS.ProcessEnv, sessionId: string, model: string, question: string,
 *   sysPromptFile?: string | null, onSpawn?: (child: import('child_process').ChildProcess) => void,
 *   spawnProcess?: typeof spawn, timeoutMs?: number,
 * }} opts
 * @returns {Promise<{ text: string, costUsd: number | null, durationMs: number | null,
 *   inputTokens: number | null, outputTokens: number | null, cachedInputTokens: number | null }>}
 */
export function askClaudeSideQuestion({
  bin,
  cwd,
  env,
  sessionId,
  model,
  question,
  sysPromptFile = null,
  onSpawn = () => {},
  spawnProcess = spawn,
  timeoutMs = 300000,
}) {
  const args = [
    '-p',
    '--resume',
    sessionId,
    '--fork-session',
    '--no-session-persistence',
    '--tools',
    '',
    '--strict-mcp-config',
    '--settings',
    '{"disableAllHooks":true}',
    '--max-turns',
    '1',
    '--output-format',
    'json',
    '--model',
    model,
  ];
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
    // Over stdin rather than argv: a question can be long, and a leading dash must not
    // read as a flag.
    child.stdin?.on('error', () => {});
    child.stdin?.end(`${SIDE_QUESTION_NOTE}\n\n${question}`);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.once('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      if (timedOut) return reject(new Error('The side question timed out'));
      let report;
      try {
        report = JSON.parse(out);
      } catch {
        const why = signal
          ? 'The side question was stopped'
          : err.trim().split('\n').pop() || `claude exited with code ${code}`;
        return reject(new Error(why));
      }
      const u = report.usage || {};
      const usage = {
        costUsd: report.total_cost_usd ?? null,
        durationMs: report.duration_ms ?? null,
        inputTokens: report.usage
          ? (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0)
          : null,
        outputTokens: report.usage ? u.output_tokens || 0 : null,
        cachedInputTokens: report.usage ? u.cache_read_input_tokens || 0 : null,
      };
      const text = typeof report.result === 'string' ? report.result.trim() : '';
      // The one step it is allowed went on a tool call instead of an answer.
      if (report.subtype === 'error_max_turns') {
        return reject(
          Object.assign(
            new Error('The side question needed tools to answer; ask it in the main chat instead'),
            {
              usage,
            },
          ),
        );
      }
      if (code !== 0 || report.is_error || report.subtype !== 'success') {
        return reject(
          Object.assign(new Error(text || `Side question ${report.subtype || 'failed'}`), { usage }),
        );
      }
      resolve({ ...usage, text });
    });
    onSpawn(child);
  });
}
