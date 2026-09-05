// @ts-check
// The workspace pool as seen from disk: every clone slot under WORKSPACE_DIR
// (`<owner>__<repo>`, `…__2`, …), what git says about it, what a session left
// behind in it, and whether one is using it right now. Its own module so the
// health page never has to reach into jobs.js internals; the only thing it
// asks jobs.js is "which open session holds this directory".
import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { getConfig } from './config.js';
import { listDevSessions, DEV_OPEN } from './jobs.js';

const execFileP = promisify(execFile);

// Same location jobs.js writes; spelled out here rather than imported because
// the path is part of the on-disk contract: a slot written by an older build
// must still be readable and resettable.
const SETUP_FILE = path.join('.git', 'reviewer-setup.json');

// The only directories the clean action is allowed to remove. Anything else
// in a slot is the checkout itself.
const CLEANABLE = ['vendor', 'node_modules'];

// `du` over a slot with vendor/ and node_modules/ takes seconds; the page
// polls far more often than sizes change.
const DU_TTL_MS = 60_000;
/** @type {Map<string, { at: number, kb: number|null }>} */
const duCache = new Map();

// A slot name is `<owner>__<repo>` or `<owner>__<repo>__<n>`; nothing else in
// WORKSPACE_DIR is ours.
const SLOT_RE = /^([^_/][^/]*?)__([^_/][^/]*?)(?:__(\d+))?$/;

/** @param {string} name */
export function parseSlotName(name) {
  const m = SLOT_RE.exec(name);
  if (!m) return null;
  return { repo: `${m[1]}/${m[2]}`, index: m[3] ? Number(m[3]) : 1 };
}

// Resolves a slot name from the URL to a directory inside WORKSPACE_DIR, or
// null. The name must be a bare slot name (no separators, no `..`) so a
// crafted request cannot point the delete actions anywhere else.
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
    // jobs.js stores `{ [command]: fingerprint }`; the page only needs to know
    // how many installs are remembered and when the memory was last written.
    return { at: Math.round(st.mtimeMs), steps: Object.keys(state).length };
  } catch {
    return null;
  }
}

// The open session holding a directory, if any. jobs.js keeps its busy set
// private; the public job record carries the same fact as `workDir`.
/** @param {string} dir */
function claimant(dir) {
  const job = listDevSessions().find((j) => j.workDir === dir && DEV_OPEN.includes(j.status));
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
  // One broken slot (half-finished clone, corrupted .git) must not blank the
  // whole table, so git failures become a field. du runs regardless: a
  // broken clone still takes up space.
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

// Remove the dependency trees and the memory of installing them. Nothing
// else: the checkout, its .git and any build output stay as they are.
/** @param {string} name */
export function cleanWorkspace(name) {
  const dir = idleDir(name);
  for (const sub of CLEANABLE) fs.rmSync(path.join(dir, sub), { recursive: true, force: true });
  fs.rmSync(path.join(dir, SETUP_FILE), { force: true });
  duCache.delete(dir);
  return { slot: name, removed: CLEANABLE };
}
