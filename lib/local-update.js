// @ts-check
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { loadAppSetting, saveAppSetting } from './db.js';
import { getProject } from './projects.js';
import { childEnv } from './childenv.js';
import { claimLocalCheckout, releaseLocalCheckout, localCheckoutBusy, gitCredentialEnv } from './jobs.js';

// Keeping a project's local checkout current: when a pull request merges into
// the branch the checkout sits on, the checkout fast-forwards to it and runs
// the project's update commands (composer install, migrate, restart Horizon,
// whatever the app needs to pick the new code up). "Update now" in Settings
// runs the same thing by hand.
//
// The checkout is the developer's own tree, so the update is careful with it.
// It claims the tree the way a Local-mode session does and waits for one that
// holds it to close; it only ever fast-forwards, and it does nothing at all to
// a tree that is on another branch or carries uncommitted changes. Those are
// recorded as skipped, with the reason, rather than forced.
//
// The last run of each project is kept in `app_settings`, so Settings can say
// what happened while nobody was looking.

const STEP_TIMEOUT_MS = 15 * 60 * 1000;
// Enough output to read why a step failed, not a whole composer install.
const OUTPUT_LINES = 200;

const settingKey = (repo) => `local-update:${String(repo).toLowerCase()}`;

function log(message) {
  console.log(`local-update: ${message}`);
}

// Runs one command in the checkout and resolves with its exit code and output;
// never rejects. With `args` it is a plain program (git), without it a shell
// line as typed in Settings. Detached so a timeout takes the whole shell tree
// down, not just the shell.
export function runCommand(command, args, { cwd, env, timeoutMs = STEP_TIMEOUT_MS }) {
  return new Promise((resolve) => {
    const child = args
      ? spawn(command, args, { cwd, env, detached: true })
      : spawn(command, { cwd, env, shell: true, detached: true });
    let output = '';
    const take = (chunk) => {
      output += chunk.toString('utf8');
      // Trimmed as it grows, so a chatty step cannot hold megabytes here.
      if (output.length > 256 * 1024) output = output.slice(-128 * 1024);
    };
    child.stdout?.on('data', take);
    child.stderr?.on('data', take);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL');
      } catch {
        /* already gone */
      }
    }, timeoutMs);
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: -1, output: `${output}${e.message}\n` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) output += `\nKilled after ${Math.round(timeoutMs / 60000)} min.\n`;
      resolve({ code: timedOut ? -1 : (code ?? -1), output });
    });
  });
}

// What the update's processes run with: the server's environment less its own
// credentials, git's GitHub credentials, no prompts, and the project's PHP
// first on PATH. NODE_ENV is dropped: the server runs as production, and an
// `npm install` inheriting that would skip the dev dependencies the checkout
// builds with.
function updateEnv(project) {
  const env = childEnv({
    ...gitCredentialEnv(),
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'never',
    CI: '1',
    NO_COLOR: '1',
    COMPOSER_NO_INTERACTION: '1',
  });
  delete env.NODE_ENV;
  if (project.phpBinDir) env.PATH = `${project.phpBinDir}${path.delimiter}${process.env.PATH || ''}`;
  return env;
}

function tail(text) {
  const lines = String(text || '')
    .split(/\r?\n|\r/)
    .filter((l) => l.trim());
  return lines.slice(-OUTPUT_LINES).join('\n');
}

export function createLocalUpdater({
  project: findProject = getProject,
  claim = claimLocalCheckout,
  release = releaseLocalCheckout,
  busy = localCheckoutBusy,
  load = loadAppSetting,
  save = saveAppSetting,
  exec = runCommand,
  isCheckout = (dir) => fs.existsSync(path.join(dir, '.git')),
  now = Date.now,
} = {}) {
  // Per repository: the run in progress, and whether another merge landed
  // while it ran. Merges arriving together are one update, plus at most one
  // more after it, never a queue of them.
  const active = new Map(); // repo -> { status, again }

  async function record(repo, status) {
    const entry = active.get(repo);
    if (entry) entry.status = status;
    try {
      await save(settingKey(repo), status);
    } catch (e) {
      log(`${repo}: could not save the update status: ${e.message}`);
    }
  }

  async function status(repo) {
    const entry = active.get(repo);
    if (entry) return entry.status;
    const saved = await load(settingKey(repo), null);
    // Saved as in progress but not running here: the server restarted under
    // it, which an update command restarting this very app does on purpose.
    if (saved && (saved.state === 'running' || saved.state === 'waiting')) {
      return { ...saved, state: 'interrupted', reason: 'The server restarted before the update finished.' };
    }
    return saved;
  }

  async function update(project, trigger) {
    const repo = project.repo;
    const dir = project.localDir;
    const env = updateEnv(project);
    const git = (...args) => exec('git', ['-C', dir, ...args], { cwd: dir, env, timeoutMs: 5 * 60 * 1000 });
    const status = { state: 'waiting', trigger, startedAt: now(), finishedAt: null, steps: [], output: '' };
    const finish = async (state, extra = {}) => {
      Object.assign(status, { state, finishedAt: now() }, extra);
      status.output = tail(status.output);
      await record(repo, { ...status });
      log(`${repo}: ${state}${extra.reason ? ` (${extra.reason})` : ''}`);
      return status;
    };

    if (busy(dir))
      await record(repo, { ...status, reason: 'Waiting for the session in the checkout to close.' });
    await claim(dir);
    try {
      status.state = 'running';
      status.reason = '';
      await record(repo, { ...status });

      const branch = (await git('branch', '--show-current')).output.trim();
      if (!branch) return await finish('skipped', { reason: 'The checkout is not on a branch.' });
      // A merge into another branch is not this checkout's; a manual update
      // pulls whatever branch it is on.
      if (trigger.base && trigger.base !== branch) {
        return await finish('skipped', {
          reason: `The checkout is on ${branch}, not ${trigger.base}, so it was left alone.`,
        });
      }
      const dirty = await git('status', '--porcelain', '--untracked-files=no');
      if (dirty.code !== 0)
        return await finish('failed', { reason: 'git status failed', output: dirty.output });
      if (dirty.output.trim()) {
        return await finish('skipped', {
          reason: `The checkout has uncommitted changes on ${branch}, so it was left alone.`,
        });
      }

      const from = (await git('rev-parse', 'HEAD')).output.trim();
      const fetched = await git('fetch', 'origin', branch);
      status.output += fetched.output;
      if (fetched.code !== 0) return await finish('failed', { reason: `git fetch origin ${branch} failed` });
      const merged = await git('merge', '--ff-only', 'FETCH_HEAD');
      status.output += merged.output;
      if (merged.code !== 0) {
        return await finish('failed', {
          reason: `${branch} has commits of its own that are not on origin, so it cannot fast-forward.`,
        });
      }
      const to = (await git('rev-parse', 'HEAD')).output.trim();
      Object.assign(status, { branch, from, to });

      for (const command of project.updateCommands || []) {
        const started = now();
        const ran = await exec(command, null, { cwd: dir, env });
        status.output += `$ ${command}\n${ran.output}`;
        status.steps.push({ command, ok: ran.code === 0, code: ran.code, ms: now() - started });
        if (ran.code !== 0) return await finish('failed', { reason: `"${command}" exited with ${ran.code}` });
        await record(repo, { ...status, output: tail(status.output) });
      }
      return await finish('updated');
    } catch (e) {
      return await finish('failed', { reason: e.message });
    } finally {
      release(dir);
    }
  }

  // Starts an update unless one is already going, in which case it is marked
  // to run once more after it. Resolves when this repository is done.
  async function start(project, trigger) {
    const repo = project.repo;
    const entry = active.get(repo);
    if (entry) {
      entry.again = trigger;
      return entry.status;
    }
    const mine = { status: { state: 'waiting', trigger, startedAt: now() }, again: null };
    active.set(repo, mine);
    let result;
    try {
      result = await update(project, trigger);
      while (mine.again) {
        const next = mine.again;
        mine.again = null;
        result = await update(findProject(repo) || project, next);
      }
    } finally {
      active.delete(repo);
    }
    return result;
  }

  // Webhook side: a pull request merged. Only a project that asked for it,
  // with a checkout configured, is touched.
  function onMerged(repo, { base, prNumber }) {
    const project = findProject(repo);
    if (!project || !project.enabled || !project.autoUpdate || !project.localDir) return null;
    if (!isCheckout(project.localDir)) {
      log(`${repo}: ${project.localDir} is not a git checkout; nothing updated`);
      return null;
    }
    log(`${repo}: #${prNumber} merged into ${base}, updating ${project.localDir}`);
    return start(project, { kind: 'merge', base, prNumber }).catch((e) => log(`${repo}: ${e.message}`));
  }

  // Settings' "Update now": the branch the checkout is on, whatever it is.
  // Answers once the update has started, not when it ends; the page polls
  // the status.
  async function runNow(repo) {
    const project = findProject(repo);
    if (!project) throw Object.assign(new Error('Project not found'), { status: 404 });
    if (!project.localDir) throw new Error(`${repo} has no local checkout configured`);
    if (!isCheckout(project.localDir)) throw new Error(`${project.localDir} is not a git checkout`);
    start(project, { kind: 'manual', base: null, prNumber: null }).catch((e) => log(`${repo}: ${e.message}`));
    return status(repo);
  }

  return { onMerged, runNow, status, start };
}

let shared = null;
export function localUpdater() {
  if (!shared) shared = createLocalUpdater();
  return shared;
}
