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

// Interrupted writes in a partial clone can leave a loose-object pathname in
// place with no contents. Git treats the pathname as proof that it already has
// the object, then index-pack fails instead of replacing it during fetch.
// Restrict recovery to the exact diagnostic Git emits for that condition.
export function isEmptyLooseObjectFailure(error) {
  const text = String(error && error.message ? error.message : error || '');
  return /object file .*\.git[\\/]objects[\\/][0-9a-f]{2}[\\/](?:[0-9a-f]{38}|[0-9a-f]{62}) is empty/i.test(
    text,
  );
}

// A zero-byte loose object can never contain Git data. Move every such object
// out of the object database together so the next fetch can replace all of
// them in one pass. They remain under .git for diagnosis/recovery rather than
// being deleted; refs, the index, working files and non-empty objects are not
// touched.
export function quarantineEmptyLooseObjects(dir) {
  const gitDir = path.resolve(dir, '.git');
  const objectsDir = path.join(gitDir, 'objects');
  /** @type {{ source: string, hash: string }[]} */
  const empty = [];

  let fanouts;
  try {
    fanouts = fs.readdirSync(objectsDir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const fanout of fanouts) {
    if (!fanout.isDirectory() || !/^[0-9a-f]{2}$/.test(fanout.name)) continue;
    const fanoutDir = path.join(objectsDir, fanout.name);
    let entries;
    try {
      entries = fs.readdirSync(fanoutDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !/^(?:[0-9a-f]{38}|[0-9a-f]{62})$/.test(entry.name)) continue;
      const source = path.join(fanoutDir, entry.name);
      try {
        if (fs.statSync(source).size === 0) empty.push({ source, hash: `${fanout.name}${entry.name}` });
      } catch {
        /* a concurrently vanished file needs no quarantine */
      }
    }
  }
  if (!empty.length) return null;

  const quarantineDir = path.join(
    gitDir,
    'reviewer-quarantine',
    `empty-loose-objects-${Date.now()}-${process.pid}`,
  );
  for (const object of empty) {
    const destination = path.join(quarantineDir, object.hash.slice(0, 2), object.hash.slice(2));
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.renameSync(object.source, destination);
  }
  return { quarantineDir, objects: empty.map(({ hash }) => hash) };
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
 *   onQuarantine?: (result: { quarantineDir: string, objects: string[] }) => void,
 * }} options
 */
export async function fetchWithWorkspaceRecovery({
  dir,
  fetchRefs,
  onRepair = () => {},
  onQuarantine = () => {},
}) {
  let repairedRefs = false;
  let quarantinedObjects = false;
  for (;;) {
    try {
      return await fetchRefs();
    } catch (error) {
      let recovered = false;
      if (!repairedRefs) {
        const brokenRefs = brokenRemoteTrackingRefs(error);
        const repaired = brokenRefs.filter((ref) => repairBrokenRemoteTrackingRef(dir, ref));
        repairedRefs = brokenRefs.length > 0;
        if (repaired.length) {
          onRepair(repaired);
          recovered = true;
        }
      }
      if (!quarantinedObjects && isEmptyLooseObjectFailure(error)) {
        const result = quarantineEmptyLooseObjects(dir);
        quarantinedObjects = true;
        if (result) {
          onQuarantine(result);
          recovered = true;
        }
      }
      if (!recovered) throw error;
    }
  }
}
