// @ts-check
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
const exec = promisify(execFile);
let draining = false;
export function setDraining(on) {
  draining = on === true;
}
export function assertAcceptingWork() {
  if (draining) throw new Error('Maintenance is draining active work; resume accepting work first');
}
export function maintenanceState(sessions, sshRunning = 0) {
  const active = sessions.filter(
    (s) =>
      ['running', 'preparing', 'queued'].includes(s.status) ||
      s.compacting ||
      s.queued?.length ||
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
  if (
    sessions.some(
      (s) =>
        s.id !== job.id &&
        s.workDir &&
        s.workDir === job.workDir &&
        ['running', 'preparing', 'queued', 'idle'].includes(s.status),
    )
  ) {
    report.reason = 'Another session owns this workspace';
    return report;
  }
  if (job.orchestrator) {
    report.available = true;
    report.canResume = true;
    report.reason = 'Resume the orchestrator conversation';
  } else if (job.workDir) {
    try {
      const git = async (...args) =>
        (
          await exec('git', ['-C', job.workDir, ...args], { timeout: 10000, maxBuffer: 512 * 1024 })
        ).stdout.trim();
      [report.branch, report.head, report.changes] = await Promise.all([
        git('branch', '--show-current'),
        git('rev-parse', 'HEAD'),
        git('status', '--short', '--untracked-files=normal'),
      ]);
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
