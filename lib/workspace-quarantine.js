// @ts-check
import fs from 'node:fs';
import path from 'node:path';

export const QUARANTINE_NAME = '.briareus-recovery';
export const QUARANTINE_LIMIT = 100;

// Recursive removal can delete .git before failing on a Docker-owned build
// directory. Rename the entire checkout instead: subtree permissions do not
// matter, and a failed rename leaves every file at its original location.
// No automatic expiry: these trees may contain the only copy of local work.
/** @param {string} dir @returns {string} */
export function quarantineWorkspace(dir) {
  const root = path.join(path.dirname(dir), QUARANTINE_NAME);
  let container;
  try {
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    // Never follow a recovery-root symlink outside the workspace pool.
    if (!fs.lstatSync(root).isDirectory()) throw new Error('Recovery directory is not a real directory');
    if (fs.readdirSync(root).length >= QUARANTINE_LIMIT)
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
