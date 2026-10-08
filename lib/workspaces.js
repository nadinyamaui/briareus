// @ts-check
// The workspace pool as seen from disk: every clone slot under WORKSPACE_DIR, what git
// says about it, what a session left in it, and whether one holds it now. Kept apart from
// jobs.js, which it only asks "which open session holds this directory".
import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { getConfig } from './config.js';
import { listDevSessions, DEV_OPEN, sessionRegistryComplete } from './jobs.js';
import { holdsRecoverableWork, slotOwner } from './recovery.js';
import { quarantineWorkspace } from './workspace-quarantine.js';

const execFileP = promisify(execFile);

// Same path jobs.js writes, spelled out rather than imported because it is an on-disk
// contract: slots written by older builds must stay readable and resettable.
const SETUP_FILE = path.join('.git', 'reviewer-setup.json');

// The only directories the clean action may remove.
const CLEANABLE = ['vendor', 'node_modules'];

// `du` over vendor/ and node_modules/ takes seconds; the page polls far more often than
// sizes change.
const DU_TTL_MS = 60_000;
/** @type {Map<string, { at: number, kb: number|null }>} */
const duCache = new Map();

const WORKSPACE_PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;

// A slot name is `<owner>__<repo>` or `<owner>__<repo>__<n>`; nothing else here is ours.
const SLOT_RE = /^([^_/][^/]*?)__([^_/][^/]*?)(?:__(\d+))?$/;

/** @param {string} name */
export function parseSlotName(name) {
  const m = SLOT_RE.exec(name);
  if (!m || /\.recovery-backup-\d{8}T\d{6}Z$/.test(name)) return null;
  return { repo: `${m[1]}/${m[2]}`, index: m[3] ? Number(m[3]) : 1 };
}

// Resolves a URL slot name to a directory inside WORKSPACE_DIR, or null. Only a bare slot
// name is accepted so a crafted request cannot aim the delete actions elsewhere.
/** @param {string} name */
export function slotDir(name) {
  if (typeof name !== 'string' || !parseSlotName(name) || /[/\\]/.test(name)) return null;
  const root = path.resolve(getConfig().workspaceDir);
  const dir = path.join(root, name);
  return path.dirname(dir) === root ? dir : null;
}

/** @param {string} dir @param {string[]} args */
async function git(dir, args) {
  const { stdout } = await execFileP('git', ['-C', dir, ...args], { timeout: 15_000 });
  return stdout.trim();
}

/** @param {string} dir */
async function diskUsageKb(dir) {
  const hit = duCache.get(dir);
  if (hit && Date.now() - hit.at < DU_TTL_MS) return hit.kb;
  let kb = null;
  try {
    const { stdout } = await execFileP('du', ['-sk', dir], { timeout: 120_000, maxBuffer: 1 << 20 });
    kb = Number.parseInt(stdout, 10);
    if (Number.isNaN(kb)) kb = null;
  } catch {
    /* an unreadable subtree: the size is simply unknown */
  }
  duCache.set(dir, { at: Date.now(), kb });
  return kb;
}

/** @param {string} dir */
function readSetup(dir) {
  const file = path.join(dir, SETUP_FILE);
  try {
    const st = fs.statSync(file);
    const state = JSON.parse(fs.readFileSync(file, 'utf8')) || {};
    // jobs.js stores `{ [command]: fingerprint }`; the page only needs a count and mtime.
    return { at: Math.round(st.mtimeMs), steps: Object.keys(state).length };
  } catch {
    return null;
  }
}

// The session holding a directory: an open one, or an interrupted or failed one whose
// unfinished work waits there for recovery (the clone pool's rule). jobs.js keeps its busy
// set private, but the job record's `workDir` carries the same fact.
/** @param {string} dir */
function claimant(dir) {
  const job = listDevSessions().find(
    (j) => j.workDir === dir && (DEV_OPEN.includes(j.status) || holdsRecoverableWork(j)),
  );
  return job ? { id: job.id, title: job.title || '' } : null;
}

/** @param {string} name @param {string} dir */
async function describeSlot(name, dir) {
  const parsed = parseSlotName(name);
  /** @type {Record<string, any>} */
  const out = {
    slot: name,
    repo: parsed ? parsed.repo : '',
    index: parsed ? parsed.index : 1,
    dir,
    branch: null,
    head: null,
    dirty: null,
    sizeKb: null,
    setup: readSetup(dir),
    vendor: fs.existsSync(path.join(dir, 'vendor')),
    nodeModules: fs.existsSync(path.join(dir, 'node_modules')),
    claimedBy: claimant(dir),
    error: null,
  };
  // One broken slot must not blank the whole table, so git failures become a field. du
  // runs regardless: a broken clone still takes space.
  const [gitResult, sizeKb] = await Promise.allSettled([
    Promise.all([
      git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']),
      git(dir, ['rev-parse', '--short', 'HEAD']),
      git(dir, ['status', '--porcelain']),
    ]),
    diskUsageKb(dir),
  ]);
  if (gitResult.status === 'fulfilled') {
    const [branch, head, status] = gitResult.value;
    out.branch = branch;
    out.head = head;
    out.dirty = status.length > 0;
  } else {
    const reason = gitResult.reason;
    out.error = String((reason && (reason.stderr || reason.message)) || 'git failed').trim();
  }
  out.sizeKb = sizeKb.status === 'fulfilled' ? sizeKb.value : null;
  return out;
}

export async function listWorkspaces() {
  const root = getConfig().workspaceDir;
  /** @type {fs.Dirent[]} */
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return []; // no pool yet: the first session creates the directory
  }
  const names = entries
    .filter((e) => e.isDirectory() && parseSlotName(e.name))
    .map((e) => e.name)
    .sort((a, b) => {
      const pa = /** @type {{repo: string, index: number}} */ (parseSlotName(a));
      const pb = /** @type {{repo: string, index: number}} */ (parseSlotName(b));
      return pa.repo.localeCompare(pb.repo) || pa.index - pb.index;
    });
  return Promise.all(names.map((name) => describeSlot(name, path.join(root, name))));
}

// Quarantine whole clone slots that no session holds (claimant: an open one, or
// one whose work waits there for recovery). This runs synchronously on
// purpose: after claimant() says a slot is idle, the event loop must not get
// a chance to hand that same directory to a new session before it is moved.
// Only directory entries that satisfy the pool's naming contract are touched;
// unrelated directories and symlinks under WORKSPACE_DIR are left alone.
// While the registry is incomplete (a failed or truncated restore), a slot is
// quarantined only when its owner marker names a session the registry knows: any
// other may hold the unfinished work of a session that simply is not loaded.
export function pruneUnusedWorkspaces() {
  const root = getConfig().workspaceDir;
  /** @type {fs.Dirent[]} */
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return { removed: [], errors: [], preserved: [] };
  }

  const known = sessionRegistryComplete() ? null : new Set(listDevSessions().map((j) => j.id));
  const removed = [];
  const errors = [];
  const preserved = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !parseSlotName(entry.name)) continue;
    const dir = slotDir(entry.name);
    if (!dir || claimant(dir)) continue;
    if (known && !known.has(slotOwner(dir) || '')) continue;
    try {
      const backup = quarantineWorkspace(dir);
      preserved.push({ slot: entry.name, backup });
      duCache.delete(dir);
      removed.push(entry.name);
    } catch (e) {
      errors.push({ slot: entry.name, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return { removed, errors, preserved };
}

// Run at boot so frequent restarts cannot postpone cleanup forever, then daily.
export function startWorkspacePruner(log = console.log, intervalMs = WORKSPACE_PRUNE_INTERVAL_MS) {
  const run = () => {
    const result = pruneUnusedWorkspaces();
    for (const item of result.preserved)
      log(
        `Workspace cleanup preserved ${item.slot} at ${item.backup}; recover any local work before removing it manually.`,
      );
    for (const failure of result.errors)
      log(`Workspace cleanup could not quarantine ${failure.slot}: ${failure.error}`);
    return result;
  };
  run();
  const timer = setInterval(run, intervalMs);
  timer.unref();
  return timer;
}

// The directory an action may touch: a real slot that no open session holds.
/** @param {string} name */
function idleDir(name) {
  const dir = slotDir(name);
  if (!dir || !fs.existsSync(dir))
    throw Object.assign(new Error('Workspace slot not found'), { status: 404 });
  const held = claimant(dir);
  if (held) {
    throw Object.assign(new Error(`Slot is claimed by session ${held.id}; close it first`), { status: 409 });
  }
  return dir;
}

// Forget what was installed, so the next session runs every install step.
/** @param {string} name */
export function resetSetup(name) {
  const dir = idleDir(name);
  fs.rmSync(path.join(dir, SETUP_FILE), { force: true });
  return { slot: name };
}

// Remove the dependency trees and the install memory; the checkout, .git and build output
// stay.
/** @param {string} name */
export function cleanWorkspace(name) {
  const dir = idleDir(name);
  for (const sub of CLEANABLE) fs.rmSync(path.join(dir, sub), { recursive: true, force: true });
  fs.rmSync(path.join(dir, SETUP_FILE), { force: true });
  duCache.delete(dir);
  return { slot: name, removed: CLEANABLE };
}
