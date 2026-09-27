// @ts-check
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isLoopChild } from './attention.js';
const exec = promisify(execFile);
let draining = false;
// The drain is enforced where work starts: the three calls every new turn goes
// through (createDevSession, sendDevMessage, reopenDevSession), each letting
// the automatic follow-ups of work in flight pass. The other callers check
// early only where they would otherwise do something first that a refusal
// cannot undo (a triage comment posted, a preview deleted, loop state armed),
// and the recovery page's Resume refuses before it inspects the checkout.
export function setDraining(on) {
  draining = on === true;
}
export function assertAcceptingWork() {
  if (draining) throw new Error('Maintenance is draining active work; resume accepting work first');
}
// The session status lists live here rather than in jobs.js, which imports
// this module: jobs.js, the drain gate and the slot checks all read the same
// ones. ACTIVE is a turn or its preparation under way; DEV_OPEN adds an idle
// conversation that still holds its workspace.
export const ACTIVE = ['queued', 'preparing', 'running'];
export const DEV_OPEN = [...ACTIVE, 'idle'];
// Draining refuses only a message that would start a turn on a settled
// session: an answer to a question, or a word to a turn under way, is how the
// work already in flight gets to finish. Only an open session's question
// counts: an interrupted one still flagged as asking would reopen first.
// sendDevMessage applies it to every message but an orchestrator's worker
// updates.
export function assertAcceptingMessage(job) {
  if (!job || !(ACTIVE.includes(job.status) || (job.status === 'idle' && job.awaitingAnswer)))
    assertAcceptingWork();
}
// How long a slot stays reserved for a session's recovery once it ended. Past
// that, the clone pool and the pruner may take it back; the recovery page
// still reports whether the work is there.
export const RECOVERY_HOLD_MS = 7 * 24 * 60 * 60 * 1000;
// Whether the provider has a conversation this session can resume. Jobs from
// before the chatStarted field fall back to "had any turn".
export function hasProviderChat(job) {
  return job.chatStarted !== undefined ? !!job.chatStarted : job.turns > 0;
}
// A slot an interrupted or failed session left its work in, which the clone
// pool must not hand out and the pruner must not delete. Only sessions someone
// can recover count: a loop child is retried from its parent with a fresh
// session, and one whose agent never started (its first preparation failed,
// which happens after the branch is set) left nothing behind. A restart
// interrupts idle sessions too, but only one it caught mid-turn
// (interruptedFrom, set by markInterrupted) has unfinished work to hold the
// slot for; an idle one is reopened like a closed one, and reserving it would
// grow the pool by one clone per idle session on every deploy. One interrupted
// before interruptedFrom existed counts as mid-turn, as it did then. A hold
// lasts RECOVERY_HOLD_MS from the end of the session, so failed sessions nobody
// deletes do not keep a clone each for good. A slot whose preparation for the
// session stopped before its checkout (a failed reopen into a fallback slot)
// holds nothing of it, and a reopen would reset it anyway.
export function holdsRecoverableWork(s, at = Date.now()) {
  const ended = s.endedAt ? Date.parse(s.endedAt) : NaN;
  return (
    (s.status === 'failed' ||
      (s.status === 'interrupted' &&
        (s.interruptedFrom === undefined || ACTIVE.includes(s.interruptedFrom)))) &&
    (Number.isNaN(ended) || at - ended < RECOVERY_HOLD_MS) &&
    !!s.workDir &&
    !!s.branch &&
    hasProviderChat(s) &&
    !isLoopChild(s) &&
    slotPrepared(s.workDir, s.id)
  );
}
// The session that last prepared a clone slot, written into the slot's .git
// so it outlives that session's record: a preview or a deleted session that
// used the slot leaves no record to compare against. null for a slot no
// session has claimed since the marker was introduced. A claim is written
// before the preparation touches anything and marked `preparing` until the
// checkout is done, so a slot whose preparation failed before that is known
// to hold nothing of the session that claimed it.
const OWNER_FILE = 'briareus-owner';
function readMarker(dir) {
  try {
    return fs.readFileSync(path.join(dir, '.git', OWNER_FILE), 'utf8').split('\n');
  } catch {
    return [];
  }
}
export function slotOwner(dir) {
  return (readMarker(dir)[0] || '').trim() || null;
}
export function claimSlot(dir, id, { prepared = false } = {}) {
  if (fs.existsSync(path.join(dir, '.git')))
    fs.writeFileSync(path.join(dir, '.git', OWNER_FILE), prepared ? id : `${id}\npreparing`);
}
// Whether the slot holds this session's checkout, which a reopen preserves.
// A slot without a marker predates it, and the session records decide
// (slotTakenOver).
export function slotPrepared(dir, id) {
  const [owner, state] = readMarker(dir);
  if (!owner?.trim()) return true;
  return owner.trim() === id && state?.trim() !== 'preparing';
}
// Whether another session has held this one's slot since it let go of it: the
// slot's owner marker names someone else, or (for a slot without one) another
// session is open there now or ended there later. The slot then holds that
// session's files, not this one's. Slots are exclusive, so the last to end
// there is the last to use it, and an open session is using its own right now.
export function slotTakenOver(job, sessions) {
  const owner = job.workDir ? slotOwner(job.workDir) : null;
  if (owner && owner !== job.id) return true;
  const settled = !DEV_OPEN.includes(job.status);
  return sessions.some(
    (s) =>
      s.id !== job.id &&
      !!s.workDir &&
      s.workDir === job.workDir &&
      (DEV_OPEN.includes(s.status) || (settled && !!s.endedAt && (!job.endedAt || s.endedAt > job.endedAt))),
  );
}
export function maintenanceState(sessions, sshRunning = 0) {
  // Raw records: `compacting` and `queued` only exist on publicJob's copy (a
  // compaction runs as status running), and a restored row can carry stale ones.
  // A question left open is a task stopped midway: the drain takes its answer,
  // and a restart before it comes would leave the slot unreserved.
  const asking = (s) => s.status === 'idle' && !!s.awaitingAnswer;
  const active = sessions.filter(
    (s) =>
      ACTIVE.includes(s.status) ||
      asking(s) ||
      s.reviewLoop?.reviewing ||
      s.reviewLoop?.fixing ||
      s.qaLoop?.running,
  );
  return {
    draining,
    ready: draining && active.length === 0 && sshRunning === 0,
    active: active.map((s) => ({
      id: s.id,
      title: s.title,
      status: asking(s) ? 'waiting on a question' : s.status,
    })),
    sshRunning,
  };
}
// A large dirty tree (an unignored build or vendor directory) can list far more
// paths than a page shows; its size must not make the checkout look lost, so
// the listing is capped rather than failed.
const MAX_CHANGES = 500;
async function listChanges(dir) {
  let out;
  try {
    ({ stdout: out } = await exec('git', ['-C', dir, 'status', '--short', '--untracked-files=normal'], {
      timeout: 10000,
      maxBuffer: 64 * 1024 * 1024,
    }));
  } catch {
    return '(git status could not list the changes)';
  }
  const lines = out.trimEnd().split('\n').filter(Boolean);
  if (lines.length <= MAX_CHANGES) return lines.join('\n');
  return [...lines.slice(0, MAX_CHANGES), `… and ${lines.length - MAX_CHANGES} more`].join('\n');
}
export async function inspectRecovery(job, sessions = []) {
  if (!job || job.kind !== 'devchat') throw new Error('Session not found');
  const report = {
    id: job.id,
    status: job.status,
    expectedBranch: job.branch || null,
    branch: null,
    head: null,
    changes: '',
    available: false,
    canResume: false,
    reason: '',
    phase: job.reviewLoop?.failure ? 'review' : job.qaLoop?.failure ? 'qa' : 'conversation',
    fingerprint: '',
  };
  if (!['interrupted', 'failed', 'closed', 'idle'].includes(job.status)) {
    report.reason = 'Wait for the current turn to finish';
    return report;
  }
  if (slotTakenOver(job, sessions)) {
    report.reason = 'Another session owns this workspace';
    return report;
  }
  if (job.orchestrator) {
    report.available = true;
    report.canResume = true;
    report.reason = 'Resume the orchestrator conversation';
  } else if (job.workDir && !slotPrepared(job.workDir, job.id)) {
    // Its preparation stopped before the checkout: whatever the slot holds is
    // not this session's, and a reopen resets it rather than preserving it.
    report.reason = 'This checkout was never prepared for this session; its files are not its work';
  } else if (job.workDir) {
    const git = async (...args) =>
      (
        await exec('git', ['-C', job.workDir, ...args], { timeout: 10000, maxBuffer: 512 * 1024 })
      ).stdout.trim();
    try {
      [report.branch, report.head] = await Promise.all([
        git('branch', '--show-current'),
        git('rev-parse', 'HEAD'),
      ]);
      report.changes = await listChanges(job.workDir);
      report.available = true;
      report.canResume = !!report.branch && report.branch === job.branch;
      report.reason = report.canResume
        ? 'Resume this checkout, preserving its commits and working files'
        : 'The checkout branch changed; inspect it before resuming';
    } catch {
      report.reason = 'The original checkout is missing or unreadable; recover its branch before resuming';
    }
  } else report.reason = 'The original workspace is no longer available';
  // A session whose provider conversation never started (a restart during its
  // first preparation, or a first turn that failed before the CLI ran) has
  // nothing to resume: its task lives only in the transcript, and a resume
  // prompt would reach a fresh conversation that never saw it.
  if (report.canResume && !hasProviderChat(job)) {
    report.canResume = false;
    report.reason = 'The conversation never started; send the task again from the session instead';
  }
  report.fingerprint = createHash('sha256').update(JSON.stringify(report)).digest('hex');
  return report;
}
