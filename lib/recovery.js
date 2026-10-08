// @ts-check
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isLoopChild } from './attention.js';
const exec = promisify(execFile);
let draining = false;
// The drain is enforced where turns start (createDevSession, sendDevMessage,
// reopenDevSession), letting in-flight work's follow-ups through. Other callers
// check early only before side effects a refusal cannot undo.
export function setDraining(on) {
  draining = on === true;
}
export function assertAcceptingWork() {
  if (draining) throw new Error('Maintenance is draining active work; resume accepting work first');
}
// Here rather than in jobs.js, which imports this module. ACTIVE is a turn or its
// preparation under way; DEV_OPEN adds idle sessions that still hold a workspace.
export const ACTIVE = ['queued', 'preparing', 'running'];
export const DEV_OPEN = [...ACTIVE, 'idle'];
// Draining refuses only messages that would start a turn on a settled session;
// answers and messages to a running turn let in-flight work finish. An interrupted
// session still flagged as asking would reopen first, so it does not count.
export function assertAcceptingMessage(job) {
  if (!job || !(ACTIVE.includes(job.status) || (job.status === 'idle' && job.awaitingAnswer)))
    assertAcceptingWork();
}
// How long a slot stays reserved for recovery after a session ends.
export const RECOVERY_HOLD_MS = 7 * 24 * 60 * 60 * 1000;
// Whether the provider has a conversation to resume; old jobs without
// chatStarted fall back to "had any turn".
export function hasProviderChat(job) {
  return job.chatStarted !== undefined ? !!job.chatStarted : job.turns > 0;
}
// Whether a failed or interrupted session's slot holds recoverable work, so the
// clone pool must not hand it out nor the pruner delete it. Excluded: loop children
// (retried from the parent), sessions whose agent never started, sessions a restart
// caught idle (reserving those would grow the pool on every deploy; a missing
// interruptedFrom counts as mid-turn), holds past RECOVERY_HOLD_MS, and slots whose
// preparation stopped before the checkout.
export function holdsRecoverableWork(s, at = Date.now()) {
  // Boot recovery includes idle sessions and loop children: reserve their slots
  // until their reopen has claimed them, including while the HTTP server boots.
  if (s.restartPending && s.workDir) return true;
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
// The session that last prepared a slot, stored in its .git so it outlives the
// session's record. Written before preparation and marked `preparing` until the
// checkout is done, so a slot whose preparation failed holds nothing of the session.
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
// Whether the slot holds this session's checkout. Without a marker the session
// records decide (slotTakenOver).
export function slotPrepared(dir, id) {
  const [owner, state] = readMarker(dir);
  if (!owner?.trim()) return true;
  return owner.trim() === id && state?.trim() !== 'preparing';
}
// Whether another session has used this one's slot since: the marker names someone
// else, another session is open there, or (no marker) another ended there later. A
// marker naming this session beats the records, since endedAt can be stamped on
// close without the slot being used.
export function slotTakenOver(job, sessions) {
  const owner = job.workDir ? slotOwner(job.workDir) : null;
  if (owner && owner !== job.id) return true;
  const settled = !DEV_OPEN.includes(job.status);
  return sessions.some(
    (s) =>
      s.id !== job.id &&
      !!s.workDir &&
      s.workDir === job.workDir &&
      (DEV_OPEN.includes(s.status) ||
        (!owner && settled && !!s.endedAt && (!job.endedAt || s.endedAt > job.endedAt))),
  );
}
export function maintenanceState(sessions, sshRunning = 0) {
  // Raw records, not publicJob's copy. An open question counts as active, since a
  // restart before its answer would leave the slot unreserved. Loop flags count
  // only on an open parent; a closed one's can be stale after a restart.
  const asking = (s) => s.status === 'idle' && !!s.awaitingAnswer;
  const active = sessions.filter(
    (s) =>
      ACTIVE.includes(s.status) ||
      asking(s) ||
      s.sideQuestionsPending > 0 ||
      (DEV_OPEN.includes(s.status) && (s.reviewLoop?.reviewing || s.reviewLoop?.fixing || s.qaLoop?.running)),
  );
  return {
    draining,
    ready: draining && active.length === 0 && sshRunning === 0,
    active: active.map((s) => ({
      id: s.id,
      title: s.title,
      status: asking(s)
        ? 'waiting on a question'
        : s.status === 'idle' && s.sideQuestionsPending > 0
          ? 'answering a side question'
          : s.status,
    })),
    sshRunning,
  };
}
// Capped rather than failed, so a huge dirty tree does not make the checkout look lost.
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
  // A restart that caught the session idle cut no turn short (as in
  // holdsRecoverableWork), so there is nothing to resume.
  if (
    job.status === 'interrupted' &&
    job.interruptedFrom !== undefined &&
    !ACTIVE.includes(job.interruptedFrom)
  ) {
    report.reason =
      'Nothing was interrupted: the session was idle when the server restarted; continue it from the conversation';
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
    // Preparation stopped before the checkout, so the slot's files are not its own.
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
  // Without a provider conversation, a resume prompt would reach a fresh
  // conversation that never saw the task.
  if (report.canResume && !hasProviderChat(job)) {
    report.canResume = false;
    report.reason = 'The conversation never started; send the task again from the session instead';
  }
  report.fingerprint = createHash('sha256').update(JSON.stringify(report)).digest('hex');
  return report;
}
