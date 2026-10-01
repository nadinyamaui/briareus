import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('../lib/db.js', () => ({ loadAppSetting: vi.fn(), saveAppSetting: vi.fn() }));
vi.mock('../lib/projects.js', () => ({ getProject: vi.fn() }));
vi.mock('../lib/jobs.js', () => ({
  claimLocalCheckout: vi.fn(),
  releaseLocalCheckout: vi.fn(),
  localCheckoutBusy: vi.fn(() => false),
  gitCredentialEnv: () => ({}),
}));

import { createLocalUpdater, runCommand } from '../lib/local-update.js';

const project = (over = {}) => ({
  repo: 'acme/shop',
  enabled: true,
  localDir: '/src/shop',
  autoUpdate: true,
  phpBinDir: '',
  updateCommands: ['composer install', 'php artisan horizon:terminate'],
  ...over,
});

// A checkout on `branch`, dirty or not, whose fetch moves HEAD from a1 to b2;
// shell commands answer with whatever `commands` maps them to (exit 0 when
// unlisted).
function fakeCheckout({ branch = 'main', dirty = '', fetch = 0, merge = 0, commands = {} } = {}) {
  let head = 'a1';
  const calls = [];
  const exec = vi.fn(async (cmd, args) => {
    if (!args) {
      calls.push(cmd);
      return { code: commands[cmd] ?? 0, output: `ran ${cmd}\n` };
    }
    const git = args.slice(2);
    calls.push(`git ${git.join(' ')}`);
    if (git[0] === 'branch') return { code: 0, output: `${branch}\n` };
    if (git[0] === 'status') return { code: 0, output: dirty };
    if (git[0] === 'rev-parse') return { code: 0, output: `${head}\n` };
    if (git[0] === 'fetch') return { code: fetch, output: '' };
    if (git[0] === 'merge') {
      if (!merge) head = 'b2';
      return { code: merge, output: '' };
    }
    return { code: 0, output: '' };
  });
  return { exec, calls };
}

function updater(p, checkout, over = {}) {
  const saved = new Map();
  const claim = vi.fn(async () => {});
  const release = vi.fn();
  const u = createLocalUpdater({
    project: () => p,
    claim,
    release,
    busy: () => false,
    load: async (key) => saved.get(key) ?? null,
    save: async (key, value) => void saved.set(key, value),
    exec: checkout.exec,
    isCheckout: () => true,
    now: () => 1000,
    ...over,
  });
  return { u, saved, claim, release };
}

describe('local checkout auto-update', () => {
  it('fast-forwards the checkout and runs the update commands in order', async () => {
    const checkout = fakeCheckout();
    const { u, claim, release } = updater(project(), checkout);
    const status = await u.onMerged('acme/shop', { base: 'main', prNumber: 4 });
    expect(status).toMatchObject({ state: 'updated', branch: 'main', from: 'a1', to: 'b2' });
    expect(status.trigger).toEqual({ kind: 'merge', base: 'main', prNumber: 4 });
    expect(checkout.calls).toEqual([
      'git branch --show-current',
      'git status --porcelain --untracked-files=no',
      'git rev-parse HEAD',
      'git fetch origin main',
      'git merge --ff-only FETCH_HEAD',
      'git rev-parse HEAD',
      'composer install',
      'php artisan horizon:terminate',
    ]);
    expect(claim).toHaveBeenCalledWith('/src/shop');
    expect(release).toHaveBeenCalledWith('/src/shop');
    expect((await u.status('acme/shop')).state).toBe('updated');
  });

  it('does nothing for a project that did not ask for it', async () => {
    const checkout = fakeCheckout();
    for (const p of [
      project({ autoUpdate: false }),
      project({ localDir: '' }),
      project({ enabled: false }),
    ]) {
      expect(updater(p, checkout).u.onMerged('acme/shop', { base: 'main', prNumber: 1 })).toBeNull();
    }
    expect(checkout.exec).not.toHaveBeenCalled();
  });

  it('leaves a checkout on another branch alone', async () => {
    const checkout = fakeCheckout({ branch: 'feature/x' });
    const { u, release } = updater(project(), checkout);
    const status = await u.onMerged('acme/shop', { base: 'main', prNumber: 4 });
    expect(status.state).toBe('skipped');
    expect(status.reason).toMatch(/on feature\/x, not main/);
    expect(checkout.calls).not.toContain('git fetch origin main');
    expect(release).toHaveBeenCalled();
  });

  it('leaves a checkout with uncommitted changes alone', async () => {
    const checkout = fakeCheckout({ dirty: ' M app/User.php\n' });
    const status = await updater(project(), checkout).u.onMerged('acme/shop', { base: 'main', prNumber: 4 });
    expect(status.state).toBe('skipped');
    expect(status.reason).toMatch(/uncommitted changes/);
    expect(checkout.calls.some((c) => c.startsWith('git fetch'))).toBe(false);
  });

  it('fails without running the commands when the branch cannot fast-forward', async () => {
    const checkout = fakeCheckout({ merge: 128 });
    const status = await updater(project(), checkout).u.onMerged('acme/shop', { base: 'main', prNumber: 4 });
    expect(status.state).toBe('failed');
    expect(status.reason).toMatch(/cannot fast-forward/);
    expect(checkout.calls).not.toContain('composer install');
  });

  it('stops at the first failing command and says which', async () => {
    const checkout = fakeCheckout({ commands: { 'composer install': 2 } });
    const status = await updater(project(), checkout).u.onMerged('acme/shop', { base: 'main', prNumber: 4 });
    expect(status.state).toBe('failed');
    expect(status.reason).toBe('"composer install" exited with 2');
    expect(status.steps).toEqual([{ command: 'composer install', ok: false, code: 2, ms: 0 }]);
    expect(checkout.calls).not.toContain('php artisan horizon:terminate');
  });

  it('folds merges that land during an update into one more run', async () => {
    const checkout = fakeCheckout();
    let open;
    const gate = new Promise((resolve) => (open = resolve));
    const claim = vi.fn(() => gate);
    const { u } = updater(project(), checkout, { claim });
    const first = u.onMerged('acme/shop', { base: 'main', prNumber: 1 });
    u.onMerged('acme/shop', { base: 'main', prNumber: 2 });
    u.onMerged('acme/shop', { base: 'main', prNumber: 3 });
    open();
    const status = await first;
    expect(claim).toHaveBeenCalledTimes(2);
    expect(status.trigger.prNumber).toBe(3);
  });

  it('does not let a merge into another branch displace one into the checkout’s', async () => {
    const checkout = fakeCheckout();
    let open;
    const gate = new Promise((resolve) => (open = resolve));
    const claim = vi.fn(() => gate);
    const { u } = updater(project(), checkout, { claim });
    const first = u.onMerged('acme/shop', { base: 'main', prNumber: 1 });
    u.onMerged('acme/shop', { base: 'main', prNumber: 2 });
    u.onMerged('acme/shop', { base: 'release/1.x', prNumber: 3 });
    open();
    await first;
    expect(claim).toHaveBeenCalledTimes(3);
    expect(checkout.calls.filter((c) => c === 'git fetch origin main')).toHaveLength(2);
  });

  it('reports an update the server restarted under as interrupted', async () => {
    const { u, saved } = updater(project(), fakeCheckout());
    saved.set('local-update:acme/shop', { state: 'running', startedAt: 1 });
    expect((await u.status('acme/shop')).state).toBe('interrupted');
  });

  it('updates whatever branch the checkout is on when run by hand', async () => {
    const checkout = fakeCheckout({ branch: 'develop' });
    const { u } = updater(project({ autoUpdate: false }), checkout);
    await u.runNow('acme/shop');
    await vi.waitFor(async () => expect((await u.status('acme/shop')).state).toBe('updated'));
    expect(checkout.calls).toContain('git fetch origin develop');
  });

  it('refuses to update by hand a project with no checkout', async () => {
    const { u } = updater(project({ localDir: '' }), fakeCheckout());
    await expect(u.runNow('acme/shop')).rejects.toThrow(/no local checkout/);
  });
});

describe('runCommand', () => {
  let dir;
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'local-update-'));
  });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('runs a shell line and hands back its exit code and output', async () => {
    const r = await runCommand('echo hi && exit 3', null, { cwd: process.cwd(), env: process.env });
    expect(r).toEqual({ code: 3, output: 'hi\n' });
  });

  it('finishes when the command exits, leaving a worker it backgrounded running', async () => {
    const started = Date.now();
    const r = await runCommand('echo up; sleep 30 & echo $! > pid', null, {
      cwd: dir,
      env: process.env,
      timeoutMs: 5000,
    });
    expect(r).toEqual({ code: 0, output: 'up\n' });
    expect(Date.now() - started).toBeLessThan(3000);
    const pid = Number(fs.readFileSync(path.join(dir, 'pid'), 'utf8'));
    expect(() => process.kill(pid, 0)).not.toThrow();
    process.kill(pid, 'SIGKILL');
  });

  it('kills a command that runs past its time', async () => {
    const r = await runCommand('sleep 5', null, { cwd: process.cwd(), env: process.env, timeoutMs: 100 });
    expect(r.code).toBe(-1);
    expect(r.output).toMatch(/Killed after/);
  });
});
