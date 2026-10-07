// @ts-check
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';

// A fetch advertises every local ref as a "have", even ones unrelated to the refspec, so
// one truncated remote-tracking ref can break every later checkout in a pooled clone.
// Only this exact failure is eligible for automatic repair.
export function brokenRemoteTrackingRefs(error) {
  const text = String(error && error.message ? error.message : error || '');
  return [
    ...new Set([...text.matchAll(/fatal:\s+bad object (refs\/remotes\/origin\/\S+)/g)].map((m) => m[1])),
  ];
}

// An interrupted write in a partial clone can leave an empty loose-object file; git takes
// it as proof it has the object, and index-pack then fails instead of replacing it.
// Recovery is limited to git's exact diagnostic for that.
export function isEmptyLooseObjectFailure(error) {
  const text = String(error && error.message ? error.message : error || '');
  return /object file .*\.git[\\/]objects[\\/][0-9a-f]{2}[\\/](?:[0-9a-f]{38}|[0-9a-f]{62}) is empty/i.test(
    text,
  );
}

// A zero-byte loose object can never hold git data. Move all of them out together so the
// next fetch replaces them in one pass; they stay under .git for diagnosis, and nothing
// else is touched.
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

// Remove one ref only after git proves its name valid and that it resolves to no object.
// Local branches, the index and worktree are never candidates. `update-ref` cannot remove
// a zero-byte loose ref, so that file is unlinked first; a valid packed ref it shadowed
// is deliberately kept.
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

  // A broken loose ref may have hidden a good packed ref; deleting that too would discard
  // healthy remote-tracking state.
  if (gitStatus(dir, ['rev-parse', '--verify', '--quiet', `${ref}^{object}`]) === 0) return removedLoose;

  // Missing-object packed refs are still readable, so git's locked ref transaction can
  // delete them safely.
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
