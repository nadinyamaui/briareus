// @ts-check
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import os from 'os';

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

// What a conversation had already spent when it is next resumed. Claude Code
// keeps a `cost-state` line in the conversation's transcript and restores it
// on --resume (a fork and /compact included), so every result of the resumed
// run reports `total_cost_usd` on top of it. That is the CLI's whole
// conversation, not the run: the run's own cost is the total less this. The
// latest such line is the one the CLI restores; a transcript with none (a CLI
// that keeps no cost state, a conversation not found) restores nothing.
export function claudeCostBaseline(configDir, sessionId) {
  try {
    const file = claudeTranscript(configDir, sessionId);
    return file ? lastCostState(file) : 0;
  } catch {
    return 0;
  }
}

function claudeTranscript(configDir, sessionId) {
  const projects = path.join(configDir, 'projects');
  if (!fs.existsSync(projects)) return undefined;
  return fs
    .readdirSync(projects, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(projects, entry.name, `${sessionId}.jsonl`))
    .find((candidate) => fs.existsSync(candidate));
}

// Read from the end, a chunk at a time: a transcript can run to tens of
// megabytes, and the line wanted is usually near its end. A chunk's first line
// may be cut, so it goes onto the next read rather than being parsed.
function lastCostState(file) {
  const fd = fs.openSync(file, 'r');
  try {
    let end = fs.fstatSync(fd).size;
    let carry = Buffer.alloc(0);
    while (end > 0) {
      const start = Math.max(0, end - 262144);
      const chunk = Buffer.alloc(end - start);
      fs.readSync(fd, chunk, 0, chunk.length, start);
      const data = Buffer.concat([chunk, carry]);
      const cut = start > 0 ? data.indexOf(10) : -1;
      end = start;
      if (start > 0 && cut === -1) {
        carry = data;
        continue;
      }
      carry = data.subarray(0, Math.max(cut, 0));
      const lines = data
        .subarray(cut + 1)
        .toString('utf8')
        .split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        if (!lines[i].includes('"cost-state"')) continue;
        try {
          const entry = JSON.parse(lines[i]);
          if (entry.type === 'cost-state' && Number.isFinite(entry.totalCostUSD)) return entry.totalCostUSD;
        } catch {
          /* not a whole line: keep looking */
        }
      }
    }
    return 0;
  } finally {
    fs.closeSync(fd);
  }
}

// A resumed run's own cost from the total it reported. A total below what was
// restored means the CLI did not restore it, and the total is all the run's.
export function ownClaudeCost(total, baseline) {
  if (total == null) return null;
  return total >= baseline ? total - baseline : total;
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
  const baseline = env.CLAUDE_CONFIG_DIR ? claudeCostBaseline(env.CLAUDE_CONFIG_DIR, sessionId) : 0;
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
        costUsd: ownClaudeCost(report.total_cost_usd, baseline),
        durationMs: report.duration_ms ?? null,
        text: typeof report.result === 'string' ? report.result.trim() : '',
      });
    });
    onSpawn(child);
  });
}

// What the forked conversation is told above a side question. Claude Code's
// own /btw refuses to run headless ("isn't available in this environment"),
// so the fork stands in for it, and the model has to learn here what kind of
// message this is: the main task may be mid-tool (a fork shows that call as
// interrupted, though it is still running) and is not this answer's to resume.
const SIDE_QUESTION_NOTE =
  '<system-reminder>This is a side question from the user (/btw), asked while the main task carries on separately. ' +
  'Answer it directly and concisely from what this conversation already shows. Do not use any tools, and do not ' +
  'continue, resume or redo the main task: this answer is not added to the main conversation, and a tool call that ' +
  'looks interrupted here may still be running there.</system-reminder>';

// A /btw side question, answered from a fork of the session's conversation
// that is never written to disk: `--fork-session` leaves the session's own
// thread untouched (so this can run beside a live turn) and
// `--no-session-persistence` keeps the fork itself from being saved. Built-in
// tools are disabled, and strict MCP configuration excludes servers from the
// workspace and user settings. Hooks are disabled too, so the fork cannot
// act on the shared checkout through inherited command hooks.
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
  let snapshotDir;
  return new Promise((resolve, reject) => {
    // Resume the same private copy we measure: the main turn can append a
    // newer cost-state while the fork starts up. Claude accepts a JSONL path
    // for --resume, so credentials and settings still use the original env.
    const source = claudeTranscript(env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), sessionId);
    let baseline = 0;
    if (source) {
      snapshotDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-btw-'));
      const snapshot = path.join(snapshotDir, `${sessionId}.jsonl`);
      fs.copyFileSync(source, snapshot);
      baseline = lastCostState(snapshot);
      args[args.indexOf('--resume') + 1] = snapshot;
    }
    const child = spawnProcess(bin, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout?.on('data', (c) => {
      out += c.toString('utf8');
    });
    child.stderr?.on('data', (c) => {
      err += c.toString('utf8');
    });
    // Over stdin rather than argv: a question can be long, and one that
    // starts with a dash must not read as a flag.
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
        costUsd: ownClaudeCost(report.total_cost_usd, baseline),
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
  }).finally(() => {
    if (snapshotDir) fs.rmSync(snapshotDir, { recursive: true, force: true });
  });
}
