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
  slotTakenOver,
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
    expect(holdsRecoverableWork({ ...s, interruptedFrom: undefined })).toBe(false);
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
    setDraining(false);
    expect(assertAcceptingWork).not.toThrow();
  });
});
