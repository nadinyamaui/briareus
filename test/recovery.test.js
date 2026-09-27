import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { assertAcceptingWork, inspectRecovery, maintenanceState, setDraining } from '../lib/recovery.js';
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
      const job = { id: 's', kind: 'devchat', status: 'interrupted', branch: 'work', workDir: dir };
      const report = await inspectRecovery(job);
      expect(report.canResume).toBe(true);
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
