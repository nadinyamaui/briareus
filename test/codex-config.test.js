import { it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { codexMcpShellArgs } from '../lib/codex-config.js';

function fixture(options = {}) {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.kill = vi.fn(() => queueMicrotask(() => child.emit('close', 0)));
  const sent = [];
  child.stdin.on('data', (c) => sent.push(JSON.parse(c.toString())));
  const spawnProcess = vi.fn(() => child);
  const args = [
    'exec',
    '--json',
    '-c',
    'projects={"/repo"={trust_level="trusted"}}',
    '-c',
    'shell_environment_policy.exclude=["CLI_*"]',
    '-',
  ];
  const promise = codexMcpShellArgs({
    bin: '/codex',
    cwd: '/repo',
    env: { CODEX_HOME: '/provider' },
    args,
    spawnProcess,
    ...options,
  });
  const receive = (m) => child.stdout.write(`${JSON.stringify(m)}\n`);
  return { child, sent, spawnProcess, args, promise, receive };
}

it('resolves policy using the same account, cwd and ordered CLI overrides, then adds only the MCP exclusion', async () => {
  const f = fixture();
  expect(f.spawnProcess).toHaveBeenCalledWith('/codex', ['app-server', ...f.args.slice(2, -1)], {
    cwd: '/repo',
    env: { CODEX_HOME: '/provider' },
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  f.receive({ id: 0, result: {} });
  expect(f.sent.at(-1)).toEqual({
    id: 1,
    method: 'config/read',
    params: { cwd: '/repo', includeLayers: false },
  });
  f.receive({
    id: 1,
    result: {
      config: {
        shell_environment_policy: { exclude: ['CLI_*', 'BRIAREUS_MCP_*'], include_only: ['PUBLIC_*'] },
      },
    },
  });
  await expect(f.promise).resolves.toEqual([
    ...f.args,
    '-c',
    'shell_environment_policy.exclude=["CLI_*","BRIAREUS_MCP_*"]',
  ]);
  expect(f.child.kill).toHaveBeenCalledOnce();
});

it('adds the MCP exclusion when there is no configured policy', async () => {
  const f = fixture();
  f.receive({ id: 1, result: { config: {} } });
  await expect(f.promise).resolves.toEqual([
    ...f.args,
    '-c',
    'shell_environment_policy.exclude=["BRIAREUS_MCP_*"]',
  ]);
});

it.each([0, 1])('fails closed on RPC error %s without exposing its contents', async (id) => {
  const f = fixture();
  f.receive({ id, error: { message: 'synthetic-sensitive-config' } });
  await expect(f.promise).rejects.toThrow('Codex shell policy lookup failed');
});

it.each([
  {},
  { config: { shell_environment_policy: { exclude: 'PRIVATE_*' } } },
  { config: { shell_environment_policy: { exclude: [42] } } },
])('rejects missing or malformed configuration: %j', async (result) => {
  const f = fixture();
  f.receive({ id: 1, result });
  await expect(f.promise).rejects.toThrow('invalid shell policy');
});

it('rejects premature exit, spawn failure and timeout', async () => {
  const exited = fixture();
  exited.child.emit('close', 1);
  await expect(exited.promise).rejects.toThrow('before resolving');
  const failed = fixture();
  failed.child.emit('error', new Error('synthetic-sensitive-config'));
  await expect(failed.promise).rejects.toThrow('lookup failed');
  const timed = fixture({ timeoutMs: 5 });
  await expect(timed.promise).rejects.toThrow('timed out');
});
