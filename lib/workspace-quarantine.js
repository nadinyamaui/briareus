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
// stash, and no commit on a local branch missing from every remote-tracking
// ref. A branch the remote deleted after a squash merge still counts as work.
// Any git failure (no .git, a corrupt repo) counts as work too.
/** @param {string} checkout */
function holdsNoLocalWork(checkout) {
  try {
    if (!fs.lstatSync(path.join(checkout, '.git')).isDirectory()) return false;
  } catch {
    return false;
  }
  const git = (/** @type {string[]} */ ...args) => {
    const r = spawnSync('git', ['-C', checkout, ...args], { encoding: 'utf8' });
    return r.status === 0 ? r.stdout.trim() : null;
  };
  return (
    git('status', '--porcelain') === '' &&
    git('stash', 'list') === '' &&
    git('log', '--branches', '--not', '--remotes', '--format=%H') === ''
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
    if (!holdsNoLocalWork(checkout)) continue;
    try {
      for (const name of fs.readdirSync(checkout))
        if (name !== '.git') fs.rmSync(path.join(checkout, name), { recursive: true, force: true });
      fs.rmSync(container, { recursive: true, force: true });
      expired.push(container);
    } catch (e) {
      errors.push({ path: container, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return { expired, errors };
}
