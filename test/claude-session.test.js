import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  askClaudeSideQuestion,
  claudeCostBaseline,
  compactClaudeSession,
  claudeQuotaFailure,
  transferClaudeSession,
} from '../lib/claude-session.js';

// A config dir holding one conversation transcript with these lines.
function transcript(lines, sessionId = 'sess-1') {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-cost-'));
  fs.mkdirSync(path.join(configDir, 'projects', '-tmp-work'), { recursive: true });
  fs.writeFileSync(
    path.join(configDir, 'projects', '-tmp-work', `${sessionId}.jsonl`),
    lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n',
  );
  return configDir;
}

describe('Claude cost baseline', () => {
  it('reads the latest cost state the CLI saved in the conversation', () => {
    const configDir = transcript([
      { type: 'user', message: { content: 'hi' } },
      { type: 'cost-state', sessionId: 'sess-1', totalCostUSD: 0.5 },
      { type: 'assistant', message: { content: [] } },
      { type: 'cost-state', sessionId: 'sess-1', totalCostUSD: 1.25 },
      { type: 'last-prompt', text: 'mentions "cost-state" but is not one' },
    ]);
    try {
      expect(claudeCostBaseline(configDir, 'sess-1')).toBe(1.25);
    } finally {
      fs.rmSync(configDir, { recursive: true, force: true });
    }
  });

  it('finds it far back in a long transcript, across read boundaries', () => {
    const filler = { type: 'assistant', message: { content: [{ type: 'text', text: 'é'.repeat(5000) }] } };
    const configDir = transcript([
      { type: 'cost-state', sessionId: 'sess-1', totalCostUSD: 7.5 },
      ...Array.from({ length: 200 }, () => filler),
    ]);
    try {
      expect(claudeCostBaseline(configDir, 'sess-1')).toBe(7.5);
    } finally {
      fs.rmSync(configDir, { recursive: true, force: true });
    }
  });

  it('is nothing when the conversation or its cost state cannot be found', () => {
    const configDir = transcript([{ type: 'user', message: { content: 'hi' } }]);
    try {
      expect(claudeCostBaseline(configDir, 'sess-1')).toBe(0);
      expect(claudeCostBaseline(configDir, 'sess-2')).toBe(0);
      expect(claudeCostBaseline(path.join(configDir, 'missing'), 'sess-1')).toBe(0);
    } finally {
      fs.rmSync(configDir, { recursive: true, force: true });
    }
  });
});

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

  it.each(["You've hit your limit", "You've hit your session limit", 'You’ve hit your session limit'])(
    'recognizes %s only in main-thread quota failures',
    (limit) => {
      const text = `${limit} · resets 8pm (Europe/Berlin)`;
      for (const message of [
        { type: 'assistant', error: 'rate_limit', message: { content: [{ type: 'text', text }] } },
        { type: 'assistant', error: 'rate_limit', message: { content: text } },
        { type: 'result', is_error: true, result: text },
        { type: 'result', is_error: true, errors: [text] },
      ]) {
        expect(claudeQuotaFailure(message)).toBe(true);
        expect(claudeQuotaFailure({ ...message, parent_tool_use_id: 'agent' })).toBe(false);
      }
      expect(
        claudeQuotaFailure({
          type: 'user',
          message: { content: [{ type: 'tool_result', is_error: true, content: text }] },
        }),
      ).toBe(false);
      expect(claudeQuotaFailure({ type: 'result', result: text })).toBe(false);
    },
  );

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

  it('reports only what the summary cost, not the conversation it resumed', async () => {
    const configDir = transcript([{ type: 'cost-state', sessionId: 'sess-1', totalCostUSD: 12 }]);
    try {
      const { promise, finish } = run({ env: { CLAUDE_CONFIG_DIR: configDir } });
      finish({ type: 'result', subtype: 'success', is_error: false, result: '', total_cost_usd: 12.25 });
      expect((await promise).costUsd).toBeCloseTo(0.25);
    } finally {
      fs.rmSync(configDir, { recursive: true, force: true });
    }
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

function ask(opts = {}) {
  const calls = [];
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => child.emit('close', null, 'SIGTERM');
  let stdin = '';
  child.stdin.on('data', (c) => {
    stdin += c.toString('utf8');
  });
  const promise = askClaudeSideQuestion({
    bin: '/mock/claude',
    cwd: '/tmp/work',
    env: {},
    sessionId: 'sess-1',
    model: 'claude-opus-5-5',
    question: '--what changed so far?',
    sysPromptFile: '/tmp/sys.txt',
    spawnProcess: (bin, args) => {
      calls.push({ bin, args });
      return child;
    },
    ...opts,
  });
  const finish = (report, code = 0) => {
    child.stdout.end(typeof report === 'string' ? report : JSON.stringify(report));
    setImmediate(() => child.emit('close', code, null));
  };
  return { promise, calls, child, finish, stdin: () => stdin };
}

describe('Claude side questions (/btw)', () => {
  it('pins the resumed transcript and baseline while the main turn saves a newer cost state', async () => {
    const configDir = transcript([{ type: 'cost-state', sessionId: 'sess-1', totalCostUSD: 3 }]);
    try {
      const { promise, calls, finish } = ask({ env: { CLAUDE_CONFIG_DIR: configDir } });
      const snapshot = calls[0].args[calls[0].args.indexOf('--resume') + 1];
      expect(path.isAbsolute(snapshot)).toBe(true);
      const original = path.join(configDir, 'projects', '-tmp-work', 'sess-1.jsonl');
      // Main turn exits before the child loads --resume.
      fs.appendFileSync(original, JSON.stringify({ type: 'cost-state', totalCostUSD: 3.5 }) + '\n');
      const restored = JSON.parse(fs.readFileSync(snapshot, 'utf8').trim()).totalCostUSD;
      expect(restored).toBe(3);
      finish({ type: 'result', subtype: 'success', result: 'ok', total_cost_usd: restored + 0.02 });
      expect((await promise).costUsd).toBeCloseTo(0.02);
      expect(claudeCostBaseline(configDir, 'sess-1')).toBe(3.5);
      expect(fs.existsSync(path.dirname(snapshot))).toBe(false);
    } finally {
      fs.rmSync(configDir, { recursive: true, force: true });
    }
  });

  it.each(['error', 'timeout', 'spawn failure'])(
    'removes the private transcript after %s',
    async (failure) => {
      const configDir = transcript([{ type: 'cost-state', sessionId: 'sess-1', totalCostUSD: 3 }]);
      let snapshot;
      try {
        const opts = { env: { CLAUDE_CONFIG_DIR: configDir }, timeoutMs: failure === 'timeout' ? 5 : 300000 };
        if (failure === 'spawn failure') {
          opts.spawnProcess = (_bin, args) => {
            snapshot = args[args.indexOf('--resume') + 1];
            throw new Error('spawn failed');
          };
        }
        const { promise, calls, finish } = ask(opts);
        if (failure !== 'spawn failure') snapshot = calls[0].args[calls[0].args.indexOf('--resume') + 1];
        if (failure === 'error') finish({ subtype: 'error', is_error: true, result: 'failed' }, 1);
        await expect(promise).rejects.toThrow(failure === 'timeout' ? 'timed out' : 'failed');
        expect(fs.existsSync(path.dirname(snapshot))).toBe(false);
      } finally {
        fs.rmSync(configDir, { recursive: true, force: true });
      }
    },
  );

  it('reports only what the answer cost, not the conversation it forked', async () => {
    const configDir = transcript([{ type: 'cost-state', sessionId: 'sess-1', totalCostUSD: 3 }]);
    try {
      const { promise, finish } = ask({ env: { CLAUDE_CONFIG_DIR: configDir } });
      finish({ type: 'result', subtype: 'success', is_error: false, result: 'ok', total_cost_usd: 3.02 });
      expect((await promise).costUsd).toBeCloseTo(0.02);
    } finally {
      fs.rmSync(configDir, { recursive: true, force: true });
    }
  });

  it('asks an unsaved fork with tools, MCP servers and inherited hooks disabled, over stdin', async () => {
    const { promise, calls, finish, stdin } = ask();
    finish({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: ' The login form. ',
      total_cost_usd: 0.03,
      duration_ms: 4000,
      usage: {
        input_tokens: 10,
        cache_read_input_tokens: 20000,
        cache_creation_input_tokens: 500,
        output_tokens: 40,
      },
    });
    await expect(promise).resolves.toEqual({
      text: 'The login form.',
      costUsd: 0.03,
      durationMs: 4000,
      inputTokens: 20510,
      outputTokens: 40,
      cachedInputTokens: 20000,
    });
    expect(calls[0].args).toEqual([
      '-p',
      '--resume',
      'sess-1',
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
      'claude-opus-5-5',
      '--append-system-prompt-file',
      '/tmp/sys.txt',
    ]);
    expect(calls[0].args).not.toContain('bypassPermissions');
    // The question never rides on argv, where a leading dash would read as a flag.
    expect(stdin()).toMatch(
      /^<system-reminder>[\s\S]*\/btw[\s\S]*<\/system-reminder>\n\n--what changed so far\?$/,
    );
  });

  it('says so when the one step went on a tool call, keeping what it cost', async () => {
    const { promise, finish } = ask();
    finish(
      {
        type: 'result',
        subtype: 'error_max_turns',
        is_error: true,
        total_cost_usd: 0.01,
        usage: { output_tokens: 5 },
      },
      1,
    );
    const error = await promise.catch((e) => e);
    expect(error.message).toMatch('needed tools');
    expect(error.usage.costUsd).toBe(0.01);
  });

  it('rejects an exit without a JSON report, naming stderr', async () => {
    const { promise, child, finish } = ask();
    child.stderr.write('No conversation found with session ID: sess-1\n');
    finish('', 1);
    await expect(promise).rejects.toThrow('No conversation found');
  });

  it('reports a kill as a stop', async () => {
    const { promise, child } = ask();
    child.kill();
    await expect(promise).rejects.toThrow('stopped');
  });

  it('gives up after the time limit', async () => {
    const { promise } = ask({ timeoutMs: 5 });
    await expect(promise).rejects.toThrow('timed out');
  });
});
