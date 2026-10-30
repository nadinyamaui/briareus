// @ts-check
import fs from 'node:fs';
import path from 'node:path';
import { isUtf8 } from 'node:buffer';
import { execFile } from 'node:child_process';

export const QUARANTINE_NAME = '.briareus-recovery';
export const QUARANTINE_LIMIT = 100;
// git status on a large checkout with installed dependencies takes seconds; a
// tighter bound kills it every time and the checkout is retained forever.
export const QUARANTINE_GIT_TIMEOUT_MS = 60_000;

/**
 * @param {string} name the subcommand, for messages
 * @param {string[]} args
 * @param {number} timeout
 * @returns {Promise<Buffer>}
 */
function runGit(name, args, timeout) {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      // Full index records exceed the 1 MiB default on large repos.
      { encoding: 'buffer', maxBuffer: 16 * 1024 * 1024, timeout, killSignal: 'SIGKILL' },
      (error, stdout, stderr) => {
        if (!error) return resolve(stdout);
        const code = /** @type {any} */ (error).code;
        if (code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER')
          return reject(
            new Error(`Git ${name} output exceeded the 16 MiB inspection limit; checkout retained`),
          );
        if (/** @type {any} */ (error).killed)
          return reject(
            new Error(`Git ${name} inspection failed: timed out after ${timeout} ms (ETIMEDOUT)`),
          );
        if (typeof code === 'number')
          return reject(
            new Error(`Git ${name} inspection failed (exit ${code}): ${stderr.toString('utf8').trim()}`),
          );
        reject(new Error(`Git ${name} inspection failed: ${error.message}`, { cause: error }));
      },
    );
  });
}

// Recursive removal can delete .git before failing on a Docker-owned build
// directory. Rename the entire checkout instead: subtree permissions do not
// matter, and a failed rename leaves every file at its original location.
// Only expireQuarantine() deletes them, and only once git shows no local work.
/** @param {string} dir @returns {string} */
export function quarantineWorkspace(dir) {
  const root = path.join(path.dirname(dir), QUARANTINE_NAME);
  let container;
  try {
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    // Never follow a recovery-root symlink outside the workspace pool.
    if (!fs.lstatSync(root).isDirectory()) throw new Error('Recovery directory is not a real directory');
    let occupied = 0;
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      // Operators remove the logged checkout path. Retire its empty parent
      // using non-recursive removal; never follow symlinks or remove work.
      if (entry.isDirectory()) {
        try {
          fs.rmdirSync(path.join(root, entry.name));
          continue;
        } catch {
          // Nonempty or inaccessible reservations still consume capacity.
        }
      }
      occupied++;
    }
    if (occupied >= QUARANTINE_LIMIT)
      throw new Error(`Recovery limit (${QUARANTINE_LIMIT} checkouts) reached`);
    container = fs.mkdtempSync(path.join(root, `${path.basename(dir)}-`));
    const target = path.join(container, 'checkout');
    fs.renameSync(dir, target);
    return target;
  } catch (e) {
    if (container) {
      try {
        fs.rmdirSync(container);
      } catch {
        // A parent permission change can also prevent removing the empty
        // reservation; retain the original error and never recurse into it.
      }
    }
    throw new Error(
      `Could not quarantine ${dir}; checkout contents were left in place: ${e instanceof Error ? e.message : String(e)}. Inspect permissions and recover or move preserved work in ${root} before retrying.`,
      { cause: e },
    );
  }
}

// Whether a quarantined checkout holds nothing git does not also have on a
// remote: no modified or untracked files (ignored build output aside), no
// stash, and no commit on any ref or worktree HEAD missing from every
// remote-tracking ref. Noncommit refs, submodule/embedded repositories, linked
// worktrees and indexes that suppress working-tree inspection are retained.
// Any git failure (no .git, a corrupt repo) counts as work too.
/** @param {string} checkout @param {number} gitTimeoutMs */
async function holdsNoLocalWork(checkout, gitTimeoutMs) {
  try {
    if (!fs.lstatSync(checkout).isDirectory()) return false;
    if (!fs.lstatSync(path.join(checkout, '.git')).isDirectory()) return false;
    // Deinitialized or removed submodules can still hold stashes/history here.
    if (fs.existsSync(path.join(checkout, '.git', 'modules'))) return false;
    // Linked worktrees can hold staged-only contents in their own indexes.
    if (fs.existsSync(path.join(checkout, '.git', 'worktrees'))) return false;
    // Interrupted index/ref writes can hold the only copy of unpublished work.
    if (fs.readdirSync(path.join(checkout, '.git')).some((name) => name.endsWith('.lock'))) return false;
    if (
      fs
        .readdirSync(path.join(checkout, '.git', 'refs'), { recursive: true })
        .some((name) => name.endsWith('.lock'))
    )
      return false;
    // Local ancestry grafts can make unpublished commits appear remote-reachable.
    if (fs.lstatSync(path.join(checkout, '.git', 'info', 'grafts'), { throwIfNoEntry: false })) return false;
    // Unfinished operations can retain autostashes or unpublished source commits.
    for (const state of [
      'rebase-merge',
      'rebase-apply',
      'MERGE_HEAD',
      'MERGE_AUTOSTASH',
      'CHERRY_PICK_HEAD',
      'sequencer',
      'REVERT_HEAD',
      'BISECT_START',
    ])
      if (fs.lstatSync(path.join(checkout, '.git', state), { throwIfNoEntry: false })) return false;
  } catch {
    return false;
  }
  const git = async (/** @type {string[]} */ ...args) => {
    const stdout = await runGit(
      args[0],
      // Inspect filesystem case, modes, timestamps and types regardless of checkout configuration.
      [
        '-C',
        checkout,
        '--work-tree',
        path.resolve(checkout),
        '-c',
        'core.fsmonitor=false',
        '-c',
        'core.ignoreCase=false',
        '-c',
        'core.fileMode=true',
        '-c',
        'core.trustctime=true',
        '-c',
        'core.symlinks=true',
        ...args,
      ],
      gitTimeoutMs,
    );
    // Lossy pathname decoding can make the embedded-repository check inspect a different directory.
    return isUtf8(stdout) ? stdout.toString('utf8').trim() : null;
  };
  const index = await git('ls-files', '--stage', '-v', '-z');
  // Lowercase flags mean assume-unchanged, S means skip-worktree; gitlinks
  // (160000) may have their own work even when the superproject is clean.
  if (index === null || index.split('\0').some((record) => /^(?:[a-zS] |. 160000 )/.test(record)))
    return false;
  // Tracked directories can hide independent history; avoid scanning ignored trees.
  const inspected = new Set();
  for (const record of index.split('\0').filter(Boolean)) {
    let dir = path.posix.dirname(record.slice(record.indexOf('\t') + 1));
    while (dir !== '.' && !inspected.has(dir)) {
      if (fs.lstatSync(path.join(checkout, dir, '.git'), { throwIfNoEntry: false })) return false;
      // Bare repositories keep their metadata directly in the tracked ancestor.
      if (
        ['HEAD', 'objects', 'refs'].every((name) =>
          fs.lstatSync(path.join(checkout, dir, name), { throwIfNoEntry: false }),
        )
      )
        return false;
      inspected.add(dir);
      dir = path.posix.dirname(dir);
    }
  }
  // The commit walk below omits refs that preserve blobs or trees. Peel nested
  // tags fully, while allowing annotations on published commits to expire.
  const refs = await git('for-each-ref', '--format=%(objecttype) %(*objecttype) %(refname)');
  if (refs === null) return false;
  for (const record of refs.split('\n').filter(Boolean)) {
    const [type, peeled, ref] = record.split(' ');
    if (type !== 'commit' && peeled !== 'commit' && (await git('cat-file', '-t', `${ref}^{}`)) !== 'commit')
      return false;
  }
  return (
    (await git('status', '--porcelain', '--untracked-files=normal')) === '' &&
    (await git('stash', 'list')) === '' &&
    (await git('log', '--all', '--not', '--remotes', '--format=%H')) === ''
  );
}

// Delete quarantined checkouts that hold no local work, so the recovery limit
// only ever fills with work someone may still want. Without this the area
// filled with clean slots and every later cleanup failed at the limit.
// Asynchronous because inspecting a hundred large checkouts takes minutes,
// which would freeze every request if done on the event loop. The work tree goes before .git: a
// Docker-owned build directory that refuses removal then leaves the history
// in place, and the checkout is reported for an operator to remove.
/** @param {string} workspaceRoot @param {{ gitTimeoutMs?: number }} [options] */
export async function expireQuarantine(workspaceRoot, { gitTimeoutMs = QUARANTINE_GIT_TIMEOUT_MS } = {}) {
  const root = path.join(workspaceRoot, QUARANTINE_NAME);
  /** @type {string[]} */
  const expired = [];
  /** @type {{ path: string, error: string }[]} */
  const errors = [];
  /** @type {fs.Dirent[]} */
  let entries;
  try {
    if (!fs.lstatSync(root).isDirectory()) return { expired, errors };
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return { expired, errors };
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const container = path.join(root, entry.name);
    const checkout = path.join(container, 'checkout');
    try {
      if (fs.readdirSync(container).some((name) => name !== 'checkout')) continue;
      if (!(await holdsNoLocalWork(checkout, gitTimeoutMs))) continue;
      for (const name of fs.readdirSync(checkout))
        if (name !== '.git') fs.rmSync(path.join(checkout, name), { recursive: true, force: true });
      fs.rmSync(checkout, { recursive: true, force: true });
      fs.rmdirSync(container);
      expired.push(container);
    } catch (e) {
      errors.push({ path: container, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return { expired, errors };
}
