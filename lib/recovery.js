// @ts-check
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { isLoopChild } from './attention.js';
const exec = promisify(execFile);
let draining = false;
export function setDraining(on) {
  draining = on === true;
}
export function assertAcceptingWork() {
  if (draining) throw new Error('Maintenance is draining active work; resume accepting work first');
}
const OPEN = ['queued', 'preparing', 'running', 'idle'];
// A slot an interrupted or failed session left its work in, which the clone
// pool must not hand out and the pruner must not delete. Only sessions someone
// can recover count: a loop child is retried from its parent with a fresh
// session, and one that never prepared a branch left nothing behind.
export function holdsRecoverableWork(s) {
  return ['interrupted', 'failed'].includes(s.status) && !!s.workDir && !!s.branch && !isLoopChild(s);
}
// Whether another session has held this one's slot since it let go of it: one
// open there now, or one that ended there later. The slot then holds that
// session's files, not this one's. Slots are exclusive, so the last to end
// there is the last to use it, and an open session is using its own right now.
export function slotTakenOver(job, sessions) {
  const settled = !OPEN.includes(job.status);
  return sessions.some(
    (s) =>
      s.id !== job.id &&
      !!s.workDir &&
      s.workDir === job.workDir &&
      (OPEN.includes(s.status) || (settled && !!s.endedAt && (!job.endedAt || s.endedAt > job.endedAt))),
  );
}
export function maintenanceState(sessions, sshRunning = 0) {
  // Raw records: `compacting` and `queued` only exist on publicJob's copy (a
  // compaction runs as status running), and a restored row can carry stale ones.
  const active = sessions.filter(
    (s) =>
      ['running', 'preparing', 'queued'].includes(s.status) ||
      s.reviewLoop?.reviewing ||
      s.reviewLoop?.fixing ||
      s.qaLoop?.running,
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
  report.fingerprint = createHash('sha256').update(JSON.stringify(report)).digest('hex');
  return report;
}
