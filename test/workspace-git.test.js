import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import {
  brokenRemoteTrackingRefs,
  fetchWithRemoteRefRecovery,
  repairBrokenRemoteTrackingRef,
} from '../lib/workspace-git.js';

function git(dir, ...args) {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
}

function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'briareus-workspace-git-'));
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.name', 'Briareus test');
  git(dir, 'config', 'user.email', 'test@example.invalid');
  fs.writeFileSync(path.join(dir, 'tracked.txt'), 'kept\n');
  git(dir, 'add', 'tracked.txt');
  git(dir, 'commit', '-qm', 'initial');
  git(dir, 'branch', 'local-work');
  return dir;
}

describe('broken remote-tracking ref recovery', () => {
  it('extracts only the exact origin refs named by git', () => {
    const error = new Error(
      'git -C exited with code 1: fatal: bad object refs/remotes/origin/broken | ' +
        'fatal: bad object refs/heads/local-work | fatal: bad object refs/remotes/upstream/nope',
    );
    expect(brokenRemoteTrackingRefs(error)).toEqual(['refs/remotes/origin/broken']);
  });

  it('removes an invalid loose remote ref, preserves local work, and retries once', async () => {
    const dir = repo();
    try {
      const ref = 'refs/remotes/origin/interrupted-worker';
      const loose = path.join(dir, '.git', ...ref.split('/'));
      fs.mkdirSync(path.dirname(loose), { recursive: true });
      fs.writeFileSync(loose, '');
      fs.writeFileSync(path.join(dir, 'uncommitted.txt'), 'keep me\n');
      const localSha = git(dir, 'rev-parse', 'refs/heads/local-work');
      let fetches = 0;
      const repaired = [];

      await fetchWithRemoteRefRecovery({
        dir,
        fetchRefs: async () => {
          fetches++;
          if (fs.existsSync(loose)) throw new Error(`fatal: bad object ${ref}`);
        },
        onRepair: (refs) => repaired.push(...refs),
      });

      expect(fetches).toBe(2);
      expect(repaired).toEqual([ref]);
      expect(fs.existsSync(loose)).toBe(false);
      expect(git(dir, 'rev-parse', 'refs/heads/local-work')).toBe(localSha);
      expect(fs.readFileSync(path.join(dir, 'uncommitted.txt'), 'utf8')).toBe('keep me\n');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps a valid packed ref that was shadowed by a broken loose file', () => {
    const dir = repo();
    try {
      const ref = 'refs/remotes/origin/worker';
      const sha = git(dir, 'rev-parse', 'HEAD');
      git(dir, 'update-ref', ref, sha);
      git(dir, 'pack-refs', '--all');
      const loose = path.join(dir, '.git', ...ref.split('/'));
      fs.mkdirSync(path.dirname(loose), { recursive: true });
      fs.writeFileSync(loose, '');

      expect(repairBrokenRemoteTrackingRef(dir, ref)).toBe(true);
      expect(git(dir, 'rev-parse', ref)).toBe(sha);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not retry or remove a ref unless the reported origin ref is broken', async () => {
    const dir = repo();
    try {
      const ref = 'refs/remotes/origin/healthy';
      git(dir, 'update-ref', ref, git(dir, 'rev-parse', 'HEAD'));
      let fetches = 0;
      await expect(
        fetchWithRemoteRefRecovery({
          dir,
          fetchRefs: async () => {
            fetches++;
            throw new Error(`fatal: bad object ${ref}`);
          },
        }),
      ).rejects.toThrow(/bad object/);
      expect(fetches).toBe(1);
      expect(git(dir, 'rev-parse', ref)).toBe(git(dir, 'rev-parse', 'HEAD'));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
