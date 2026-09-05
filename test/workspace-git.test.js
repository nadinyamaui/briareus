import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import {
  brokenRemoteTrackingRefs,
  fetchWithWorkspaceRecovery,
  isEmptyLooseObjectFailure,
  quarantineEmptyLooseObjects,
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

      await fetchWithWorkspaceRecovery({
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
        fetchWithWorkspaceRecovery({
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

describe('empty loose object recovery', () => {
  it("recognizes only Git's empty loose-object fetch failure", () => {
    expect(
      isEmptyLooseObjectFailure(
        new Error(
          'error: object file .git/objects/4c/ff9a22527ca9725cf5b923776c432fba0ad820 is empty | fatal: index-pack failed',
        ),
      ),
    ).toBe(true);
    expect(isEmptyLooseObjectFailure(new Error('fatal: index-pack failed'))).toBe(false);
    expect(isEmptyLooseObjectFailure(new Error('error: object file /tmp/arbitrary is empty'))).toBe(false);
  });

  it('quarantines only zero-byte loose objects and leaves repository work intact', () => {
    const dir = repo();
    try {
      const emptyHash = '4cff9a22527ca9725cf5b923776c432fba0ad820';
      const empty = path.join(dir, '.git', 'objects', emptyHash.slice(0, 2), emptyHash.slice(2));
      const validHash = git(dir, 'hash-object', '-w', 'tracked.txt');
      const valid = path.join(dir, '.git', 'objects', validHash.slice(0, 2), validHash.slice(2));
      const promisor = path.join(dir, '.git', 'objects', 'pack', 'pack-test.promisor');
      fs.mkdirSync(path.dirname(empty), { recursive: true });
      fs.mkdirSync(path.dirname(promisor), { recursive: true });
      fs.writeFileSync(empty, '');
      fs.writeFileSync(promisor, '');
      fs.writeFileSync(path.join(dir, 'uncommitted.txt'), 'keep me\n');
      const localSha = git(dir, 'rev-parse', 'refs/heads/local-work');

      const result = quarantineEmptyLooseObjects(dir);

      expect(result?.objects).toEqual([emptyHash]);
      expect(fs.existsSync(empty)).toBe(false);
      expect(fs.existsSync(path.join(result.quarantineDir, emptyHash.slice(0, 2), emptyHash.slice(2)))).toBe(
        true,
      );
      expect(fs.existsSync(valid)).toBe(true);
      expect(fs.existsSync(promisor)).toBe(true);
      expect(git(dir, 'rev-parse', 'refs/heads/local-work')).toBe(localSha);
      expect(fs.readFileSync(path.join(dir, 'uncommitted.txt'), 'utf8')).toBe('keep me\n');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('quarantines all empty loose objects after the exact failure and retries once', async () => {
    const dir = repo();
    try {
      const hashes = ['4cff9a22527ca9725cf5b923776c432fba0ad820', '9fb87a60085f862f55a972c3efd457c8ac6139cd'];
      for (const hash of hashes) {
        const file = path.join(dir, '.git', 'objects', hash.slice(0, 2), hash.slice(2));
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, '');
      }
      let fetches = 0;
      const quarantines = [];

      await fetchWithWorkspaceRecovery({
        dir,
        fetchRefs: async () => {
          fetches++;
          if (fetches === 1) {
            throw new Error(
              `error: object file .git/objects/${hashes[0].slice(0, 2)}/${hashes[0].slice(2)} is empty`,
            );
          }
        },
        onQuarantine: (result) => quarantines.push(result),
      });

      expect(fetches).toBe(2);
      expect(quarantines).toHaveLength(1);
      expect(quarantines[0].objects.sort()).toEqual(hashes.sort());
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('can repair a broken remote ref exposed after empty objects are quarantined', async () => {
    const dir = repo();
    try {
      const hash = '4cff9a22527ca9725cf5b923776c432fba0ad820';
      const empty = path.join(dir, '.git', 'objects', hash.slice(0, 2), hash.slice(2));
      fs.mkdirSync(path.dirname(empty), { recursive: true });
      fs.writeFileSync(empty, '');
      const ref = 'refs/remotes/origin/interrupted-worker';
      const loose = path.join(dir, '.git', ...ref.split('/'));
      fs.mkdirSync(path.dirname(loose), { recursive: true });
      fs.writeFileSync(loose, '');
      let fetches = 0;
      const repaired = [];

      await fetchWithWorkspaceRecovery({
        dir,
        fetchRefs: async () => {
          fetches++;
          if (fs.existsSync(empty)) {
            throw new Error(`error: object file .git/objects/${hash.slice(0, 2)}/${hash.slice(2)} is empty`);
          }
          if (fs.existsSync(loose)) throw new Error(`fatal: bad object ${ref}`);
        },
        onRepair: (refs) => repaired.push(...refs),
      });

      expect(fetches).toBe(3);
      expect(repaired).toEqual([ref]);
      expect(fs.existsSync(empty)).toBe(false);
      expect(fs.existsSync(loose)).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not scan or retry for an unrelated fetch failure', async () => {
    const dir = repo();
    try {
      const hash = '4cff9a22527ca9725cf5b923776c432fba0ad820';
      const empty = path.join(dir, '.git', 'objects', hash.slice(0, 2), hash.slice(2));
      fs.mkdirSync(path.dirname(empty), { recursive: true });
      fs.writeFileSync(empty, '');
      let fetches = 0;

      await expect(
        fetchWithWorkspaceRecovery({
          dir,
          fetchRefs: async () => {
            fetches++;
            throw new Error('fatal: authentication failed');
          },
        }),
      ).rejects.toThrow(/authentication failed/);
      expect(fetches).toBe(1);
      expect(fs.existsSync(empty)).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
