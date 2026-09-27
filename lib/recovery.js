// @ts-check
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isLoopChild } from './attention.js';
const exec = promisify(execFile);
let draining = false;
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
// counts: an interrupted one still flagged as asking would reopen first. The
// dashboard's message route and an orchestrator's send_to_worker share it.
export function assertAcceptingMessage(job) {
  if (!job || !(ACTIVE.includes(job.status) || (job.status === 'idle' && job.awaitingAnswer)))
    assertAcceptingWork();
}
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
// grow the pool by one clone per idle session on every deploy.
export function holdsRecoverableWork(s) {
  return (
    (s.status === 'failed' || (s.status === 'interrupted' && ACTIVE.includes(s.interruptedFrom))) &&
    !!s.workDir &&
    !!s.branch &&
    hasProviderChat(s) &&
    !isLoopChild(s)
  );
}
// The session that last prepared a clone slot, written into the slot's .git
// so it outlives that session's record: a preview or a deleted session that
// used the slot leaves no record to compare against. null for a slot no
// session has claimed since the marker was introduced.
const OWNER_FILE = 'briareus-owner';
export function slotOwner(dir) {
  try {
    return fs.readFileSync(path.join(dir, '.git', OWNER_FILE), 'utf8').trim() || null;
  } catch {
    return null;
  }
}
export function claimSlot(dir, id) {
  if (fs.existsSync(path.join(dir, '.git'))) fs.writeFileSync(path.join(dir, '.git', OWNER_FILE), id);
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
  const active = sessions.filter(
    (s) => ACTIVE.includes(s.status) || s.reviewLoop?.reviewing || s.reviewLoop?.fixing || s.qaLoop?.running,
  );
  return {
    draining,
    ready: draining && active.length === 0 && sshRunning === 0,
    active: active.map(({ id, title, status }) => ({ id, title, status })),
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
