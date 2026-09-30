import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import { compactClaudeSession } from '../lib/claude-session.js';

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
