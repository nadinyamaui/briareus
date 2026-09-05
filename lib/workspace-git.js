// @ts-check
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';

// A fetch advertises every local ref as a possible "have", including refs
// unrelated to the refspec being fetched. One truncated remote-tracking ref
// can therefore make every later checkout in a pooled clone fail with this
// message. Only this precise failure is eligible for automatic repair.
export function brokenRemoteTrackingRefs(error) {
  const text = String(error && error.message ? error.message : error || '');
  return [
    ...new Set([...text.matchAll(/fatal:\s+bad object (refs\/remotes\/origin\/\S+)/g)].map((m) => m[1])),
  ];
}

function gitStatus(dir, args) {
  return spawnSync('git', ['-C', dir, ...args], { stdio: 'ignore' }).status;
}

// Remove one ref only after git proves both that its name is valid and that it
// does not resolve to an object. Local branches, the index and the worktree are
// never candidates. A zero-byte loose ref cannot be removed by `update-ref`,
// so unlink that exact file first; if it was merely shadowing a valid packed
// ref, the packed value is deliberately kept.
export function repairBrokenRemoteTrackingRef(dir, ref) {
  if (!ref.startsWith('refs/remotes/origin/')) return false;
  if (gitStatus(dir, ['check-ref-format', ref]) !== 0) return false;
  if (gitStatus(dir, ['rev-parse', '--verify', '--quiet', `${ref}^{object}`]) === 0) return false;

  const gitDir = path.resolve(dir, '.git');
  const loose = path.resolve(gitDir, ...ref.split('/'));
  if (!loose.startsWith(`${gitDir}${path.sep}`)) return false;

  let removedLoose = false;
  try {
    const stat = fs.lstatSync(loose);
    if (!stat.isFile() && !stat.isSymbolicLink()) return false;
    fs.rmSync(loose, { force: true });
    removedLoose = true;
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ENOENT') return false;
  }

  // A broken loose ref may have hidden a good packed ref. It is usable again,
  // so deleting it too would discard healthy remote-tracking state.
  if (gitStatus(dir, ['rev-parse', '--verify', '--quiet', `${ref}^{object}`]) === 0) return removedLoose;

  // Missing-object packed refs are still structurally readable, and git can
  // safely delete them through its normal locked ref transaction.
  return gitStatus(dir, ['update-ref', '--no-deref', '-d', ref]) === 0;
}

/**
 * @param {{
 *   dir: string,
 *   fetchRefs: () => Promise<unknown>,
 *   onRepair?: (refs: string[]) => void,
 * }} options
 */
export async function fetchWithRemoteRefRecovery({ dir, fetchRefs, onRepair = () => {} }) {
  try {
    return await fetchRefs();
  } catch (error) {
    const repaired = brokenRemoteTrackingRefs(error).filter((ref) => repairBrokenRemoteTrackingRef(dir, ref));
    if (!repaired.length) throw error;
    onRepair(repaired);
    return fetchRefs();
  }
}
