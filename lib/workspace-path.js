// @ts-check
import fs from 'node:fs';
import path from 'node:path';

// Lease by physical directory, while keeping the original cwd in session records
// for providers whose conversations are scoped to that spelling. A clone not yet
// created still needs the same key through either spelling of its parent.
/** @param {string} dir @returns {string} */
export function workspaceKey(dir) {
  const absolute = path.resolve(dir);
  try {
    return fs.realpathSync(absolute);
  } catch {
    const parent = path.dirname(absolute);
    return parent === absolute ? absolute : path.join(workspaceKey(parent), path.basename(absolute));
  }
}
