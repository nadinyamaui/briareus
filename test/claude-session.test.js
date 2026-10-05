import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { compactClaudeSession, claudeQuotaFailure, transferClaudeSession } from '../lib/claude-session.js';

describe('Claude account transfer', () => {
  it('copies only the selected conversation and updates an older destination copy', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-transfer-'));
    const sessionId = '12345678-1234-1234-1234-123456789abc';
    const fromDir = path.join(root, 'a');
    const toDir = path.join(root, 'b');
    const project = path.join('projects', '-tmp-work');
    try {
      fs.mkdirSync(path.join(fromDir, project, sessionId, 'subagents'), { recursive: true });
      fs.writeFileSync(path.join(fromDir, project, `${sessionId}.jsonl`), 'latest conversation');
      fs.writeFileSync(path.join(fromDir, project, sessionId, 'subagents', 'agent.jsonl'), 'agent history');
      fs.writeFileSync(path.join(fromDir, project, 'other.jsonl'), 'unrelated');
      fs.writeFileSync(path.join(fromDir, '.credentials.json'), 'source credential');
      fs.mkdirSync(path.join(toDir, project), { recursive: true });
      fs.writeFileSync(path.join(toDir, '.credentials.json'), 'destination credential');
      fs.writeFileSync(path.join(toDir, project, `${sessionId}.jsonl`), 'old');
      transferClaudeSession({ fromDir, toDir, sessionId });
      expect(fs.readFileSync(path.join(toDir, project, `${sessionId}.jsonl`), 'utf8')).toBe(
        'latest conversation',
      );
      expect(fs.readFileSync(path.join(toDir, project, sessionId, 'subagents', 'agent.jsonl'), 'utf8')).toBe(
        'agent history',
      );
      expect(fs.readFileSync(path.join(toDir, '.credentials.json'), 'utf8')).toBe('destination credential');
      expect(fs.existsSync(path.join(toDir, project, 'other.jsonl'))).toBe(false);
      expect(() => transferClaudeSession({ fromDir, toDir, sessionId: '../bad' })).toThrow('Invalid');
      fs.mkdirSync(path.join(fromDir, 'projects', '-other'), { recursive: true });
      fs.writeFileSync(path.join(fromDir, 'projects', '-other', `${sessionId}.jsonl`), 'ambiguous');
      expect(() => transferClaudeSession({ fromDir, toDir, sessionId })).toThrow('uniquely');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('recognizes terminal quota failures without treating tool errors or warnings as account exhaustion', () => {
    expect(
      claudeQuotaFailure({
        type: 'assistant',
        error: 'rate_limit',
        message: { content: [{ type: 'text', text: "You've hit your limit · resets 3am" }] },
      }),
    ).toBe(true);
    expect(
      claudeQuotaFailure({
        type: 'assistant',
        error: 'rate_limit',
        message: { content: 'Usage limit reached' },
      }),
    ).toBe(true);
    expect(
      claudeQuotaFailure({ type: 'result', is_error: true, result: "You've hit your limit · resets 3am" }),
    ).toBe(true);
    expect(claudeQuotaFailure({ type: 'result', is_error: true, errors: ['Weekly limit exceeded'] })).toBe(
      true,
    );
    for (const message of [
      { type: 'rate_limit_event', rate_limit_info: { status: 'allowed_warning' } },
      { type: 'assistant', error: 'rate_limit', parent_tool_use_id: 'agent' },
      { type: 'assistant', error: 'rate_limit' },
      {
        type: 'assistant',
        error: 'rate_limit',
        message: { content: [{ type: 'text', text: 'API Error: 429 temporary rate limit' }] },
      },
      {
        type: 'assistant',
        error: 'rate_limit',
        parent_tool_use_id: 'agent',
        message: { content: [{ type: 'text', text: "You've hit your limit" }] },
      },
      {
        type: 'user',
        message: { content: [{ type: 'tool_result', is_error: true, content: "You've hit your limit" }] },
      },
      { type: 'result', is_error: true, result: 'API Error: 429 temporary rate limit' },
      { type: 'result', is_error: true, result: 'Invalid API key' },
      { type: 'result', result: "You've hit your limit" },
    ])
      expect(claudeQuotaFailure(message)).toBe(false);
  });
});

function run(opts = {}) {
  const calls = [];
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => child.emit('close', null);
  const promise = compactClaudeSession({
    bin: '/mock/claude',
    cwd: '/tmp/work',
    env: {},
    sessionId: 'sess-1',
    model: 'claude-opus-5-5',
    sysPromptFile: '/tmp/sys.txt',
    spawnProcess: (bin, args) => {
      calls.push({ bin, args });
      return child;
    },
    ...opts,
  });
  const finish = (report, code = 0) => {
    child.stdout.end(typeof report === 'string' ? report : JSON.stringify(report));
    setImmediate(() => child.emit('close', code));
  };
  return { promise, calls, child, finish };
}

describe('Claude headless compaction', () => {
  it('resumes the session with /compact and reports what the summary cost', async () => {
    const { promise, calls, finish } = run();
    finish({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: '',
      total_cost_usd: 0.04,
      duration_ms: 9000,
    });
    await expect(promise).resolves.toEqual({ costUsd: 0.04, durationMs: 9000, text: '' });
    expect(calls[0].args).toEqual([
      '-p',
      '/compact',
      '--resume',
      'sess-1',
      '--output-format',
      'json',
      '--model',
      'claude-opus-5-5',
      '--append-system-prompt-file',
      '/tmp/sys.txt',
    ]);
  });

  it('passes instructions as the argument of /compact', async () => {
    const { promise, calls, finish } = run({ instructions: 'Keep the review findings' });
    finish({ type: 'result', subtype: 'success', is_error: false, result: '' });
    await promise;
    expect(calls[0].args.slice(0, 2)).toEqual(['-p', '/compact Keep the review findings']);
  });

  it('rejects a result the CLI marked as an error', async () => {
    const { promise, finish } = run();
    finish({ type: 'result', subtype: 'success', is_error: true, result: 'Not enough messages to compact.' });
    await expect(promise).rejects.toThrow('Not enough messages to compact.');
  });

  it('rejects an exit without a JSON report, naming stderr', async () => {
    const { promise, child, finish } = run();
    child.stderr.write('No conversation found with session ID: sess-1\n');
    finish('', 1);
    await expect(promise).rejects.toThrow('No conversation found');
  });

  it('gives up after the time limit', async () => {
    const { promise } = run({ timeoutMs: 5 });
    await expect(promise).rejects.toThrow('timed out');
  });
});
