import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  assertAcceptingMessage,
  assertAcceptingWork,
  claimSlot,
  holdsRecoverableWork,
  inspectRecovery,
  maintenanceState,
  setDraining,
  slotOwner,
  slotPrepared,
  slotTakenOver,
  RECOVERY_HOLD_MS,
} from '../lib/recovery.js';
afterEach(() => setDraining(false));
describe('recovery', () => {
  it('inspects a real dirty branch without changing files and refuses a recycled branch', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'recovery-'));
    const git = (...args) => execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe' });
    try {
      git('init', '-b', 'work');
      git(
        '-c',
        'user.name=Test',
        '-c',
        'user.email=test@example.com',
        'commit',
        '--allow-empty',
        '-m',
        'start',
      );
      await writeFile(join(dir, 'unfinished.txt'), 'preserve me');
      const job = {
        id: 's',
        kind: 'devchat',
        status: 'interrupted',
        branch: 'work',
        workDir: dir,
        chatStarted: true,
      };
      const report = await inspectRecovery(job);
      expect(report.canResume).toBe(true);
      // Interrupted during its first preparation: the checkout is there, but no
      // conversation holds the task a resume prompt would point back to.
      const unstarted = await inspectRecovery({ ...job, chatStarted: false });
      expect(unstarted.available).toBe(true);
      expect(unstarted.canResume).toBe(false);
      expect(unstarted.reason).toContain('never started');
      expect(report.changes).toContain('unfinished.txt');
      expect((await inspectRecovery(job)).fingerprint).toBe(report.fingerprint);
      expect((await inspectRecovery(job, [{ id: 'other', workDir: dir, status: 'idle' }])).canResume).toBe(
        false,
      );
      git('checkout', '-b', 'recycled');
      expect((await inspectRecovery(job)).canResume).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it('keeps a large dirty tree resumable and caps its listing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'recovery-'));
    const git = (...args) => execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe' });
    try {
      git('init', '-b', 'work');
      git(
        '-c',
        'user.name=Test',
        '-c',
        'user.email=test@example.com',
        'commit',
        '--allow-empty',
        '-m',
        'start',
      );
      // ~6000 untracked paths of ~100 bytes each: well past a 512 KB buffer.
      await Promise.all(
        Array.from({ length: 6000 }, (_, i) => writeFile(join(dir, `${'f'.repeat(90)}${i}`), '')),
      );
      const job = {
        id: 's',
        kind: 'devchat',
        status: 'interrupted',
        branch: 'work',
        workDir: dir,
        chatStarted: true,
      };
      const report = await inspectRecovery(job);
      expect(report.available).toBe(true);
      expect(report.canResume).toBe(true);
      expect(report.changes.split('\n')).toHaveLength(501);
      expect(report.changes).toContain('… and 5500 more');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it('refuses a slot another session used after this one let go of it', async () => {
    const job = {
      id: 'a',
      kind: 'devchat',
      status: 'closed',
      branch: 'x',
      workDir: '/pool/x',
      endedAt: '2026-09-01',
    };
    const later = { id: 'c', status: 'interrupted', workDir: '/pool/x', endedAt: '2026-09-02' };
    const earlier = { id: 'c', status: 'closed', workDir: '/pool/x', endedAt: '2026-08-01' };
    expect(slotTakenOver(job, [later])).toBe(true);
    expect(slotTakenOver(job, [earlier])).toBe(false);
    expect(slotTakenOver(job, [{ ...later, workDir: '/pool/y' }])).toBe(false);
    expect(slotTakenOver(job, [{ id: 'c', status: 'running', workDir: '/pool/x' }])).toBe(true);
    // An open session holds its slot now: earlier users are no concern.
    expect(slotTakenOver({ ...job, status: 'idle', endedAt: null }, [earlier])).toBe(false);
    const report = await inspectRecovery(job, [later]);
    expect(report.canResume).toBe(false);
    expect(report.reason).toBe('Another session owns this workspace');
  });
  it('refuses a slot whose owner marker names a session that is gone', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'recovery-'));
    try {
      execFileSync('git', ['-C', dir, 'init', '-b', 'x'], { stdio: 'pipe' });
      const job = { id: 'a', kind: 'devchat', status: 'closed', branch: 'x', workDir: dir };
      // A slot from before the marker falls back to the surviving records.
      expect(slotOwner(dir)).toBe(null);
      expect(slotTakenOver(job, [])).toBe(false);
      claimSlot(dir, 'a');
      expect(slotTakenOver(job, [])).toBe(false);
      // A preview took the slot and was deleted: no record, only the marker.
      claimSlot(dir, 'preview');
      expect(slotOwner(dir)).toBe('preview');
      expect(slotTakenOver(job, [])).toBe(true);
      expect((await inspectRecovery(job)).reason).toBe('Another session owns this workspace');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it('reserves only slots that hold work someone can recover', () => {
    const s = {
      status: 'interrupted',
      interruptedFrom: 'running',
      workDir: '/pool/x',
      branch: 'x',
      chatStarted: true,
    };
    expect(holdsRecoverableWork(s)).toBe(true);
    // Idle at the restart: no unfinished turn, so it reopens like a closed one.
    expect(holdsRecoverableWork({ ...s, interruptedFrom: 'idle' })).toBe(false);
    // Interrupted before the field existed: held as the mid-turn it may be.
    expect(holdsRecoverableWork({ ...s, interruptedFrom: undefined })).toBe(true);
    expect(holdsRecoverableWork({ ...s, status: 'failed', interruptedFrom: undefined })).toBe(true);
    // The branch is set before the first fetch and setup, so a first
    // preparation that failed leaves one with no agent work behind it.
    expect(holdsRecoverableWork({ ...s, chatStarted: false })).toBe(false);
    expect(holdsRecoverableWork({ ...s, chatStarted: undefined, turns: 2 })).toBe(true);
    expect(holdsRecoverableWork({ ...s, status: 'failed' })).toBe(true);
    expect(holdsRecoverableWork({ ...s, status: 'closed' })).toBe(false);
    expect(holdsRecoverableWork({ ...s, branch: null })).toBe(false);
    expect(holdsRecoverableWork({ ...s, workDir: null })).toBe(false);
    expect(holdsRecoverableWork({ ...s, loopParentId: 'p' })).toBe(false);
    expect(holdsRecoverableWork({ ...s, loopFixParentId: 'p' })).toBe(false);
    expect(holdsRecoverableWork({ ...s, qaParentId: 'p' })).toBe(false);
    expect(holdsRecoverableWork({ ...s, loopParentId: 'p', failureUnreported: true })).toBe(true);
  });
  it('lets a recovery hold lapse a while after the session ended', () => {
    const at = Date.parse('2026-09-27T12:00:00Z');
    const ago = (ms) => new Date(at - ms).toISOString();
    const s = { status: 'failed', workDir: '/pool/x', branch: 'x', chatStarted: true };
    expect(holdsRecoverableWork({ ...s, endedAt: ago(60_000) }, at)).toBe(true);
    expect(holdsRecoverableWork({ ...s, endedAt: ago(RECOVERY_HOLD_MS) }, at)).toBe(false);
    const interrupted = { ...s, status: 'interrupted', interruptedFrom: 'running' };
    expect(holdsRecoverableWork({ ...interrupted, endedAt: ago(60_000) }, at)).toBe(true);
    expect(holdsRecoverableWork({ ...interrupted, endedAt: ago(RECOVERY_HOLD_MS + 1) }, at)).toBe(false);
  });
  it('tells a slot whose preparation stopped before the checkout from a prepared one', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'recovery-'));
    try {
      execFileSync('git', ['-C', dir, 'init', '-b', 'main'], { stdio: 'pipe' });
      // No marker: older than it, and the session records decide.
      expect(slotPrepared(dir, 'a')).toBe(true);
      claimSlot(dir, 'a');
      expect(slotOwner(dir)).toBe('a');
      expect(slotPrepared(dir, 'a')).toBe(false);
      claimSlot(dir, 'a', { prepared: true });
      expect(slotOwner(dir)).toBe('a');
      expect(slotPrepared(dir, 'a')).toBe(true);
      expect(slotPrepared(dir, 'b')).toBe(false);
      // Another session's claim resets it, even before its checkout.
      claimSlot(dir, 'b');
      expect(slotPrepared(dir, 'a')).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it('neither holds nor offers to resume a slot whose reopen stopped before the checkout', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'recovery-'));
    const git = (...args) => execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe' });
    try {
      // A fallback slot already on the session's branch, with another use's
      // leftovers in it.
      git('init', '-b', 'x');
      git(
        '-c',
        'user.name=Test',
        '-c',
        'user.email=test@example.com',
        'commit',
        '--allow-empty',
        '-m',
        'start',
      );
      await writeFile(join(dir, 'leftover.txt'), 'not the session work');
      const job = {
        id: 'a',
        kind: 'devchat',
        status: 'failed',
        branch: 'x',
        workDir: dir,
        chatStarted: true,
      };
      claimSlot(dir, 'a');
      expect(holdsRecoverableWork(job)).toBe(false);
      const report = await inspectRecovery(job);
      expect(report.canResume).toBe(false);
      expect(report.available).toBe(false);
      expect(report.changes).toBe('');
      expect(report.reason).toContain('never prepared');
      claimSlot(dir, 'a', { prepared: true });
      expect(holdsRecoverableWork(job)).toBe(true);
      expect((await inspectRecovery(job)).canResume).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it('refuses only messages that would start a turn on a settled session while draining', () => {
    setDraining(true);
    expect(() => assertAcceptingMessage({ status: 'running' })).not.toThrow();
    expect(() => assertAcceptingMessage({ status: 'idle', awaitingAnswer: true })).not.toThrow();
    expect(() => assertAcceptingMessage({ status: 'idle' })).toThrow('Maintenance');
    expect(() => assertAcceptingMessage({ status: 'closed' })).toThrow('Maintenance');
    expect(() => assertAcceptingMessage({ status: 'interrupted', awaitingAnswer: true })).toThrow(
      'Maintenance',
    );
    setDraining(false);
    expect(() => assertAcceptingMessage({ status: 'closed' })).not.toThrow();
  });
  it('drains active turns, queues, loops and SSH commands', () => {
    setDraining(true);
    expect(assertAcceptingWork).toThrow('Maintenance');
    expect(maintenanceState([{ id: 's', status: 'running' }]).ready).toBe(false);
    expect(maintenanceState([{ id: 's', status: 'idle', reviewLoop: { reviewing: true } }]).ready).toBe(
      false,
    );
    // publicJob's projection fields, restored stale onto a raw record by a
    // restart, say nothing about live work.
    expect(maintenanceState([{ id: 's', status: 'idle', compacting: true, queued: [{}] }]).ready).toBe(true);
    expect(maintenanceState([], 1).ready).toBe(false);
    expect(maintenanceState([{ id: 's', status: 'idle' }]).ready).toBe(true);
    // A question still open is work a restart would cut off.
    const asking = maintenanceState([{ id: 's', status: 'idle', awaitingAnswer: true }]);
    expect(asking.ready).toBe(false);
    expect(asking.active).toEqual([{ id: 's', title: undefined, status: 'waiting on a question' }]);
    setDraining(false);
    expect(assertAcceptingWork).not.toThrow();
  });
});
