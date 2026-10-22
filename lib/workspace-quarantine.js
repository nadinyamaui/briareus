// @ts-check
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const QUARANTINE_NAME = '.briareus-recovery';
export const QUARANTINE_LIMIT = 100;

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
// remote-tracking ref. Noncommit refs, submodule repositories, linked worktrees
// and indexes that suppress working-tree inspection are conservatively retained.
// Any git failure (no .git, a corrupt repo) counts as work too.
/** @param {string} checkout */
function holdsNoLocalWork(checkout) {
  try {
    if (!fs.lstatSync(checkout).isDirectory()) return false;
    if (!fs.lstatSync(path.join(checkout, '.git')).isDirectory()) return false;
    // Deinitialized or removed submodules can still hold stashes/history here.
    if (fs.existsSync(path.join(checkout, '.git', 'modules'))) return false;
    // Linked worktrees can hold staged-only contents in their own indexes.
    if (fs.existsSync(path.join(checkout, '.git', 'worktrees'))) return false;
  } catch {
    return false;
  }
  const git = (/** @type {string[]} */ ...args) => {
    const r = spawnSync(
      'git',
      ['-C', checkout, '--work-tree', path.resolve(checkout), '-c', 'core.fsmonitor=false', ...args],
      {
        encoding: 'utf8',
        // Full index records exceed spawnSync's 1 MiB default on large repos.
        maxBuffer: 16 * 1024 * 1024,
        timeout: 1000,
        killSignal: 'SIGKILL',
      },
    );
    if (r.error && 'code' in r.error && r.error.code === 'ENOBUFS')
      throw new Error(`Git ${args[0]} output exceeded the 16 MiB inspection limit; checkout retained`);
    return !r.error && r.status === 0 ? r.stdout.trim() : null;
  };
  const index = git('ls-files', '--stage', '-v', '-z');
  // Lowercase flags mean assume-unchanged, S means skip-worktree; gitlinks
  // (160000) may have their own work even when the superproject is clean.
  if (index === null || index.split('\0').some((record) => /^(?:[a-zS] |. 160000 )/.test(record)))
    return false;
  // The commit walk below omits refs that preserve blobs or trees. Peel nested
  // tags fully, while allowing annotations on published commits to expire.
  const refs = git('for-each-ref', '--format=%(objecttype) %(*objecttype) %(refname)');
  if (refs === null) return false;
  for (const record of refs.split('\n').filter(Boolean)) {
    const [type, peeled, ref] = record.split(' ');
    if (type !== 'commit' && peeled !== 'commit' && git('cat-file', '-t', `${ref}^{}`) !== 'commit')
      return false;
  }
  return (
    git('status', '--porcelain', '--untracked-files=normal') === '' &&
    git('stash', 'list') === '' &&
    git('log', '--all', '--not', '--remotes', '--format=%H') === ''
  );
}

// Delete quarantined checkouts that hold no local work, so the recovery limit
// only ever fills with work someone may still want. Without this the area
// filled with clean slots and every later cleanup failed at the limit.
// Synchronous like the pruner that runs it. The work tree goes before .git: a
// Docker-owned build directory that refuses removal then leaves the history
// in place, and the checkout is reported for an operator to remove.
/** @param {string} workspaceRoot */
export function expireQuarantine(workspaceRoot) {
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
      if (!holdsNoLocalWork(checkout)) continue;
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
