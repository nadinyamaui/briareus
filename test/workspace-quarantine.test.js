import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  quarantineWorkspace,
  expireQuarantine,
  QUARANTINE_NAME,
  QUARANTINE_LIMIT,
} from '../lib/workspace-quarantine.js';

const roots = [];
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-quarantine-'));
  roots.push(root);
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('workspace quarantine', () => {
  it('preserves an actual unpushed commit, modified and untracked files', () => {
    const root = fixture();
    const dir = path.join(root, 'acme__app');
    fs.mkdirSync(dir);
    const git = (...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
    git('init', '-q');
    fs.writeFileSync(path.join(dir, 'source'), 'committed');
    git('add', 'source');
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', 'commit', '-qm', 'Unpushed work');
    const head = git('rev-parse', 'HEAD');
    fs.writeFileSync(path.join(dir, 'source'), 'modified');
    fs.writeFileSync(path.join(dir, 'notes'), 'untracked');
    const backup = quarantineWorkspace(dir);
    expect(fs.existsSync(dir)).toBe(false);
    expect(execFileSync('git', ['-C', backup, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()).toBe(head);
    expect(fs.readFileSync(path.join(backup, 'source'), 'utf8')).toBe('modified');
    expect(fs.readFileSync(path.join(backup, 'notes'), 'utf8')).toBe('untracked');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'replacement'), 'another checkout');
    const second = quarantineWorkspace(dir);
    expect(second).not.toBe(backup);
    expect(fs.readFileSync(path.join(backup, 'notes'), 'utf8')).toBe('untracked');
  });

  it.skipIf(process.platform === 'win32')(
    'reproduces partial recursive deletion and avoids it under non-root permissions',
    () => {
      const root = fixture();
      fs.chmodSync(root, 0o777);
      const module = fileURLToPath(new URL('../lib/workspace-quarantine.js', import.meta.url));
      // Even root-run CI executes this harness without privileges; 0555 is the
      // same inability to unlink children as a different owner's 0755 build dir.
      const child = spawnSync(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `
      import fs from 'node:fs'; import path from 'node:path';
      import { quarantineWorkspace } from ${JSON.stringify(new URL(`file://${module}`).href)};
      const root = ${JSON.stringify(root)};
      function slot(name) {
        const dir = path.join(root,name);
        fs.mkdirSync(path.join(dir,'.git'),{recursive:true});
        fs.writeFileSync(path.join(dir,'.git','HEAD'),'unpublished');
        fs.mkdirSync(path.join(dir,'build'));
        fs.writeFileSync(path.join(dir,'build','output'),'artifact');
        fs.chmodSync(path.join(dir,'build'),0o555);
        return dir;
      }
      const native=slot('native'); let nativeError;
      try { fs.rmSync(native,{recursive:true,force:true}); } catch(e) { nativeError=e.code; }
      const old=slot('old'); let error;
      // Native remove_all visitation order differs between filesystems. Force
      // the dangerous legal order for the historical cleanup reproduction,
      // still using actual recursive removal and non-root filesystem checks.
      try {
        for (const entry of ['.git','build'])
          fs.rmSync(path.join(old,entry),{recursive:true,force:true});
      } catch(e) { error=e.code; }
      const dir=slot('acme__app'); const backup=quarantineWorkspace(dir);
      const blocked=slot('blocked'); fs.chmodSync(root,0o555); let failure;
      try { quarantineWorkspace(blocked); } catch(e) { failure=e.message; }
      fs.chmodSync(root,0o777);
      const result={uid:process.getuid(),nativeError,
        nativeArtifact:fs.existsSync(path.join(native,'build','output')),
        error,oldGit:fs.existsSync(path.join(old,'.git')),
        oldArtifact:fs.existsSync(path.join(old,'build','output')),
        head:fs.readFileSync(path.join(backup,'.git','HEAD'),'utf8'),
        artifact:fs.readFileSync(path.join(backup,'build','output'),'utf8'),
        sourceGone:!fs.existsSync(dir),failure,
        blockedHead:fs.readFileSync(path.join(blocked,'.git','HEAD'),'utf8')};
      for (const tree of [native,old,backup,blocked]) fs.chmodSync(path.join(tree,'build'),0o755);
      console.log(JSON.stringify(result));
    `,
        ],
        { encoding: 'utf8', ...(process.getuid?.() === 0 ? { uid: 65534, gid: 65534 } : {}) },
      );
      expect(child.status, child.stderr).toBe(0);
      const result = JSON.parse(child.stdout);
      expect(result.uid).not.toBe(0);
      expect(result.nativeError).toMatch(/EACCES|EPERM/);
      expect(result.nativeArtifact).toBe(true);
      expect(result.error).toMatch(/EACCES|EPERM/);
      expect(result.oldGit).toBe(false);
      expect(result.oldArtifact).toBe(true);
      expect(result).toMatchObject({
        head: 'unpublished',
        artifact: 'artifact',
        sourceGone: true,
        blockedHead: 'unpublished',
      });
      expect(result.failure).toMatch(/Could not quarantine.*left in place.*Inspect permissions/);
    },
  );

  it('restores capacity after operators remove the logged checkout paths', () => {
    const root = fixture();
    const dir = path.join(root, 'acme__app');
    for (let i = 0; i <= QUARANTINE_LIMIT; i++) {
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, 'work'), 'preserve');
      const backup = quarantineWorkspace(dir);
      expect(fs.readFileSync(path.join(backup, 'work'), 'utf8')).toBe('preserve');
      fs.rmSync(backup, { recursive: true });
    }
    expect(fs.readdirSync(path.join(root, QUARANTINE_NAME))).toHaveLength(1);
  });

  it.skipIf(process.platform === 'win32')('does not retire symlink reservations', () => {
    const root = fixture();
    const outside = fixture();
    const recovery = path.join(root, QUARANTINE_NAME);
    fs.mkdirSync(recovery);
    const link = path.join(recovery, 'symlink');
    fs.symlinkSync(outside, link);
    const dir = path.join(root, 'acme__app');
    fs.mkdirSync(dir);
    quarantineWorkspace(dir);
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.readdirSync(outside)).toEqual([]);
  });

  it('refuses at the retention bound without altering the source or old backups', () => {
    const root = fixture();
    const recovery = path.join(root, QUARANTINE_NAME);
    fs.mkdirSync(recovery);
    for (let i = 0; i < QUARANTINE_LIMIT; i++) {
      const checkout = path.join(recovery, `backup-${i}`, 'checkout');
      fs.mkdirSync(checkout, { recursive: true });
      fs.writeFileSync(path.join(checkout, 'work'), 'retained');
    }
    const dir = path.join(root, 'acme__app');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'work'), 'preserve');
    expect(() => quarantineWorkspace(dir)).toThrow(/Recovery limit.*recover or move preserved work/);
    expect(fs.readFileSync(path.join(dir, 'work'), 'utf8')).toBe('preserve');
    expect(fs.readdirSync(recovery)).toHaveLength(QUARANTINE_LIMIT);
    for (const entry of fs.readdirSync(recovery))
      expect(fs.readFileSync(path.join(recovery, entry, 'checkout', 'work'), 'utf8')).toBe('retained');
  });

  it.skipIf(process.platform === 'win32')(
    'refuses a symlink recovery directory without touching its target',
    () => {
      const root = fixture();
      const outside = fixture();
      fs.symlinkSync(outside, path.join(root, QUARANTINE_NAME));
      const dir = path.join(root, 'acme__app');
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, 'work'), 'preserve');
      expect(() => quarantineWorkspace(dir)).toThrow(/not a real directory/);
      expect(fs.readFileSync(path.join(dir, 'work'), 'utf8')).toBe('preserve');
      expect(fs.readdirSync(outside)).toEqual([]);
    },
  );

  describe('expiry', () => {
    // A slot cloned from a bare "remote", committed and pushed, then quarantined;
    // `change` leaves (or not) local work in it before it is moved.
    function quarantined(root, name, change = () => {}) {
      const remote = path.join(root, `${name}.remote.git`);
      execFileSync('git', ['init', '-q', '--bare', remote]);
      const dir = path.join(root, name);
      execFileSync('git', ['clone', '-q', remote, dir], { stdio: 'ignore' });
      const git = (...args) =>
        execFileSync('git', ['-C', dir, '-c', 'user.name=F', '-c', 'user.email=f@example.com', ...args], {
          encoding: 'utf8',
        });
      fs.writeFileSync(path.join(dir, '.gitignore'), 'build/\n');
      fs.writeFileSync(path.join(dir, 'source'), 'pushed');
      git('add', '.');
      git('commit', '-qm', 'Pushed');
      git('push', '-q', 'origin', 'HEAD');
      fs.mkdirSync(path.join(dir, 'build'));
      fs.writeFileSync(path.join(dir, 'build', 'output'), 'ignored artifact');
      change(git, dir);
      return path.dirname(quarantineWorkspace(dir));
    }

    it('deletes checkouts with no local work and keeps every kind of work', async () => {
      const root = fixture();
      const clean = quarantined(root, 'acme__clean');
      const modified = quarantined(root, 'acme__modified', (git, dir) =>
        fs.writeFileSync(path.join(dir, 'source'), 'edited'),
      );
      const untracked = quarantined(root, 'acme__untracked', (git, dir) =>
        fs.writeFileSync(path.join(dir, 'notes'), 'new file'),
      );
      const unpushed = quarantined(root, 'acme__unpushed', (git) =>
        git('commit', '-q', '--allow-empty', '-m', 'Local'),
      );
      const otherBranch = quarantined(root, 'acme__branch', (git) => {
        git('checkout', '-qb', 'side');
        git('commit', '-q', '--allow-empty', '-m', 'Local');
        git('checkout', '-q', '-');
      });
      const stashed = quarantined(root, 'acme__stash', (git, dir) => {
        fs.writeFileSync(path.join(dir, 'source'), 'stashed');
        git('stash', '-q');
      });
      const noGit = path.dirname(
        quarantineWorkspace(
          (() => {
            const dir = path.join(root, 'acme__nogit');
            fs.mkdirSync(dir);
            fs.writeFileSync(path.join(dir, 'work'), 'preserve');
            return dir;
          })(),
        ),
      );

      expect(await expireQuarantine(root)).toEqual({ expired: [clean], errors: [] });
      expect(fs.existsSync(clean)).toBe(false);
      for (const kept of [modified, untracked, unpushed, otherBranch, stashed, noGit])
        expect(fs.existsSync(path.join(kept, 'checkout')), kept).toBe(true);
    });

    it.each(['rebase-merge', 'rebase-apply', 'merge'])(
      'keeps private autostash contents held by an unfinished %s',
      async (operation) => {
        const root = fixture();
        let autostash;
        const container = quarantined(root, 'acme__autostash', (git, dir) => {
          const branch = git('symbolic-ref', '--short', 'HEAD').trim();
          git('checkout', '-qb', 'side');
          if (operation !== 'merge') fs.writeFileSync(path.join(dir, 'source'), 'side');
          git('commit', '-qam', 'Side', '--allow-empty');
          git('checkout', '-q', branch);
          if (operation !== 'merge') {
            fs.writeFileSync(path.join(dir, 'source'), 'main');
            git('commit', '-qam', 'Main');
          }
          git('push', '-q', 'origin', '--all');
          fs.writeFileSync(path.join(dir, '.gitignore'), 'build/\nprivate saved work\n');
          if (operation === 'merge') {
            git('merge', '--autostash', '--no-commit', '--no-ff', 'side');
            autostash = git('rev-parse', 'MERGE_AUTOSTASH').trim();
          } else {
            expect(() =>
              git('rebase', operation === 'rebase-apply' ? '--apply' : '--merge', '--autostash', 'side'),
            ).toThrow();
            autostash = fs.readFileSync(path.join(dir, '.git', operation, 'autostash'), 'utf8').trim();
          }
          // Clear rebase conflicts so only operation metadata preserves the private edit.
          if (operation !== 'merge') git('reset', '--hard', 'HEAD');
          expect(git('status', '--porcelain', '--untracked-files=normal').trim()).toBe('');
          expect(git('stash', 'list').trim()).toBe('');
          expect(git('log', '--all', '--not', '--remotes', '--format=%H').trim()).toBe('');
          expect(git('show', `${autostash}:.gitignore`)).toBe('build/\nprivate saved work\n');
        });
        expect(await expireQuarantine(root)).toEqual({ expired: [], errors: [] });
        expect(
          execFileSync('git', ['-C', path.join(container, 'checkout'), 'show', `${autostash}:.gitignore`], {
            encoding: 'utf8',
          }),
        ).toBe('build/\nprivate saved work\n');
      },
    );

    it('keeps the private detached starting commit of an unfinished bisect', async () => {
      const root = fixture();
      let saved;
      const container = quarantined(root, 'acme__bisect', (git, dir) => {
        const good = git('rev-parse', 'HEAD').trim();
        git('commit', '-qm', 'Published middle', '--allow-empty');
        git('commit', '-qm', 'Published bad', '--allow-empty');
        git('push', '-q', 'origin', 'HEAD');
        const bad = git('rev-parse', 'HEAD').trim();
        git('checkout', '-q', '--detach');
        fs.writeFileSync(path.join(dir, 'source'), 'private bisect starting contents');
        git('commit', '-qam', 'Private detached start');
        saved = git('rev-parse', 'HEAD').trim();
        git('bisect', 'start', bad, good);
        git('reflog', 'expire', '--expire=now', '--all');
        expect(fs.readFileSync(path.join(dir, '.git', 'BISECT_START'), 'utf8').trim()).toBe(saved);
        expect(git('status', '--porcelain', '--untracked-files=normal').trim()).toBe('');
        expect(git('stash', 'list').trim()).toBe('');
        expect(git('log', '--all', '--not', '--remotes', '--format=%H').trim()).toBe('');
        expect(git('log', '--all', '--reflog', '--format=%H')).not.toContain(saved);
        expect(() =>
          git('--git-dir', path.join(root, 'acme__bisect.remote.git'), 'cat-file', '-e', saved),
        ).toThrow();
      });
      expect(await expireQuarantine(root)).toEqual({ expired: [], errors: [] });
      const checkout = path.join(container, 'checkout');
      execFileSync('git', ['-C', checkout, 'bisect', 'reset']);
      expect(execFileSync('git', ['-C', checkout, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()).toBe(
        saved,
      );
      expect(fs.readFileSync(path.join(checkout, 'source'), 'utf8')).toBe('private bisect starting contents');
    });

    it('keeps unpublished source commits held by an unfinished cherry-pick', async () => {
      const root = fixture();
      let saved;
      const container = quarantined(root, 'acme__cherry-pick', (git, dir) => {
        const branch = git('symbolic-ref', '--short', 'HEAD').trim();
        git('checkout', '-qb', 'side');
        fs.writeFileSync(path.join(dir, 'source'), 'private cherry-pick source');
        git('commit', '-qam', 'Private side commit');
        saved = git('rev-parse', 'HEAD').trim();
        git('checkout', '-q', branch);
        fs.writeFileSync(path.join(dir, 'source'), 'published main');
        git('commit', '-qam', 'Published main');
        git('push', '-q', 'origin', 'HEAD');
        git('branch', '-D', 'side');
        expect(() => git('cherry-pick', saved)).toThrow();
        git('checkout', '--ours', 'source');
        git('add', 'source');
        expect(git('status', '--porcelain', '--untracked-files=normal').trim()).toBe('');
        expect(git('stash', 'list').trim()).toBe('');
        expect(git('log', '--all', '--not', '--remotes', '--format=%H').trim()).toBe('');
        expect(git('rev-parse', 'CHERRY_PICK_HEAD').trim()).toBe(saved);
        expect(() =>
          git('--git-dir', path.join(root, 'acme__cherry-pick.remote.git'), 'cat-file', '-e', saved),
        ).toThrow();
      });
      expect(await expireQuarantine(root)).toEqual({ expired: [], errors: [] });
      expect(
        execFileSync('git', ['-C', path.join(container, 'checkout'), 'show', 'CHERRY_PICK_HEAD:source'], {
          encoding: 'utf8',
        }),
      ).toBe('private cherry-pick source');
      expect(fs.readFileSync(path.join(container, 'checkout', 'source'), 'utf8')).toBe('published main');
    });

    it.each(['cherry-pick sequence', 'revert'])(
      'keeps unpublished source commits held by an unfinished %s',
      async (operation) => {
        const root = fixture();
        let saved;
        const container = quarantined(root, 'acme__operation', (git, dir) => {
          const branch = git('symbolic-ref', '--short', 'HEAD').trim();
          git('checkout', '-qb', 'side');
          fs.writeFileSync(path.join(dir, 'source'), 'private first source');
          git('commit', '-qam', 'Private first commit');
          const first = git('rev-parse', 'HEAD').trim();
          fs.writeFileSync(path.join(dir, 'source'), 'private second source');
          git('commit', '-qam', 'Private second commit');
          saved = git('rev-parse', 'HEAD').trim();
          git('checkout', '-q', branch);
          fs.writeFileSync(path.join(dir, 'source'), 'published main');
          git('commit', '-qam', 'Published main');
          git('push', '-q', 'origin', 'HEAD');
          git('branch', '-D', 'side');
          if (operation === 'cherry-pick sequence') {
            expect(() => git('cherry-pick', '--no-commit', first, saved)).toThrow();
            const todo = fs.readFileSync(path.join(dir, '.git', 'sequencer', 'todo'), 'utf8');
            expect(todo).toContain(git('rev-parse', '--short', saved).trim());
          } else {
            expect(() => git('revert', saved)).toThrow();
            expect(git('rev-parse', 'REVERT_HEAD').trim()).toBe(saved);
            expect(fs.existsSync(path.join(dir, '.git', 'sequencer'))).toBe(false);
          }
          expect(fs.existsSync(path.join(dir, '.git', 'CHERRY_PICK_HEAD'))).toBe(false);
          git('checkout', '--ours', 'source');
          git('add', 'source');
          expect(git('status', '--porcelain', '--untracked-files=normal').trim()).toBe('');
          expect(git('stash', 'list').trim()).toBe('');
          expect(git('log', '--all', '--not', '--remotes', '--format=%H').trim()).toBe('');
          expect(() =>
            git('--git-dir', path.join(root, 'acme__operation.remote.git'), 'cat-file', '-e', saved),
          ).toThrow();
        });
        expect(await expireQuarantine(root)).toEqual({ expired: [], errors: [] });
        const checkout = path.join(container, 'checkout');
        expect(execFileSync('git', ['-C', checkout, 'show', `${saved}:source`], { encoding: 'utf8' })).toBe(
          'private second source',
        );
        expect(fs.readFileSync(path.join(checkout, 'source'), 'utf8')).toBe('published main');
        expect(
          fs.existsSync(path.join(checkout, '.git', operation === 'revert' ? 'REVERT_HEAD' : 'sequencer')),
        ).toBe(true);
      },
    );

    it('keeps recoverable staged contents in an interrupted index write', async () => {
      const root = fixture();
      const container = quarantined(root, 'acme__pending', (git, dir) => {
        const index = path.join(dir, '.git', 'index');
        const publishedIndex = fs.readFileSync(index);
        fs.writeFileSync(path.join(dir, 'source'), 'private staged work');
        git('add', 'source');
        // Recreate a completed index write interrupted before the lock is renamed.
        fs.renameSync(index, `${index}.lock`);
        fs.writeFileSync(index, publishedIndex);
        fs.writeFileSync(path.join(dir, 'source'), 'pushed');
        expect(git('show', ':source')).toBe('pushed');
        expect(git('status', '--porcelain').trim()).toBe('');
        expect(git('log', '--all', '--not', '--remotes', '--format=%H').trim()).toBe('');
      });
      expect(await expireQuarantine(root)).toEqual({ expired: [], errors: [] });
      const checkout = path.join(container, 'checkout');
      expect(
        execFileSync('git', ['-C', checkout, 'show', ':source'], {
          encoding: 'utf8',
          env: { ...process.env, GIT_INDEX_FILE: path.join(checkout, '.git', 'index.lock') },
        }),
      ).toBe('private staged work');
      expect(fs.readFileSync(path.join(checkout, 'source'), 'utf8')).toBe('pushed');
    });

    it.each(['refs/heads/saved', 'refs/tags/deep/saved', 'HEAD', 'ORIG_HEAD', 'packed-refs'])(
      'keeps unpublished history in a pending %s update',
      async (ref) => {
        const root = fixture();
        let saved;
        const container = quarantined(root, 'acme__pending_ref', (git, dir) => {
          const publishedHead = fs.readFileSync(path.join(dir, '.git', 'HEAD'));
          fs.writeFileSync(path.join(dir, 'source'), 'private pending history');
          git('add', 'source');
          saved = git('commit-tree', git('write-tree').trim(), '-p', 'HEAD', '-m', 'Private').trim();
          git('reset', '--hard', '-q', 'HEAD');
          git('update-ref', '--no-deref', ref === 'packed-refs' ? 'refs/heads/saved' : ref, saved);
          if (ref === 'packed-refs') {
            git('pack-refs', '--all', '--no-prune');
            fs.unlinkSync(path.join(dir, '.git', 'refs', 'heads', 'saved'));
          }
          // Recreate a completed ref write interrupted before its lock is renamed.
          const file = path.join(dir, '.git', ref);
          fs.renameSync(file, `${file}.lock`);
          if (ref === 'HEAD') fs.writeFileSync(file, publishedHead);
          expect(git('status', '--porcelain', '--untracked-files=normal').trim()).toBe('');
          expect(git('log', '--all', '--not', '--remotes', '--format=%H').trim()).toBe('');
          expect(() =>
            git('--git-dir', path.join(root, 'acme__pending_ref.remote.git'), 'cat-file', '-e', saved),
          ).toThrow();
        });
        expect(await expireQuarantine(root)).toEqual({ expired: [], errors: [] });
        const checkout = path.join(container, 'checkout');
        expect(fs.readFileSync(path.join(checkout, '.git', `${ref}.lock`), 'utf8')).toContain(saved);
        expect(execFileSync('git', ['-C', checkout, 'show', `${saved}:source`], { encoding: 'utf8' })).toBe(
          'private pending history',
        );
        expect(fs.readFileSync(path.join(checkout, 'source'), 'utf8')).toBe('pushed');
      },
    );

    it('keeps unpublished branch history hidden by local grafts', async () => {
      const root = fixture();
      let privateHead;
      const container = quarantined(root, 'acme__grafted', (git, dir) => {
        const published = git('rev-parse', 'HEAD').trim();
        const branch = git('symbolic-ref', '--short', 'HEAD').trim();
        git('checkout', '-q', '--orphan', 'private');
        fs.writeFileSync(path.join(dir, 'source'), 'private unpublished work');
        git('add', 'source');
        git('commit', '-qm', 'Private root');
        privateHead = git('rev-parse', 'HEAD').trim();
        git('checkout', '-q', branch);
        git('config', 'advice.graftFileDeprecated', 'false');
        fs.writeFileSync(path.join(dir, '.git', 'info', 'grafts'), `${published} ${privateHead}\n`);
        expect(git('status', '--porcelain').trim()).toBe('');
        expect(git('log', '--all', '--not', '--remotes', '--format=%H').trim()).toBe('');
        expect(
          spawnSync('git', [
            '--git-dir',
            path.join(root, 'acme__grafted.remote.git'),
            'cat-file',
            '-e',
            privateHead,
          ]).status,
        ).not.toBe(0);
      });
      expect(await expireQuarantine(root)).toEqual({ expired: [], errors: [] });
      expect(
        execFileSync('git', ['-C', path.join(container, 'checkout'), 'show', 'private:source'], {
          encoding: 'utf8',
        }),
      ).toBe('private unpublished work');
    });

    it('reports a nonzero Git inspection exit and retains the checkout', async () => {
      const root = fixture();
      const container = quarantined(root, 'acme__corrupt', (git, dir) => {
        fs.writeFileSync(path.join(dir, '.git', 'index'), 'corrupt');
      });
      expect(await expireQuarantine(root)).toEqual({
        expired: [],
        errors: [{ path: container, error: expect.stringMatching(/Git ls-files.*128.*index/i) }],
      });
      expect(fs.readFileSync(path.join(container, 'checkout', 'source'), 'utf8')).toBe('pushed');
      expect(fs.existsSync(path.join(container, 'checkout', '.git', 'HEAD'))).toBe(true);
    });

    it('frees capacity at the retention bound', async () => {
      const root = fixture();
      const recovery = path.join(root, QUARANTINE_NAME);
      quarantined(root, 'acme__clean');
      for (let i = 1; i < QUARANTINE_LIMIT; i++)
        fs.mkdirSync(path.join(recovery, `backup-${i}`, 'checkout'), { recursive: true });
      const dir = path.join(root, 'acme__app');
      fs.mkdirSync(dir);
      expect(() => quarantineWorkspace(dir)).toThrow(/Recovery limit/);
      expect((await expireQuarantine(root)).expired).toHaveLength(1);
      expect(fs.existsSync(quarantineWorkspace(dir))).toBe(true);
    });

    it('expires a clean checkout whose index output exceeds 1 MiB', async () => {
      const root = fixture();
      const container = quarantined(root, 'acme__large', (git, dir) => {
        const files = path.join(dir, 'files');
        fs.mkdirSync(files);
        for (let i = 0; i < 14000; i++)
          fs.writeFileSync(path.join(files, `source-${String(i).padStart(5, '0')}.txt`), 'pushed');
        git('add', '.');
        git('commit', '-qm', 'Large index');
        git('push', '-q', 'origin', 'HEAD');
      });
      expect(await expireQuarantine(root)).toEqual({ expired: [container], errors: [] });
      expect(fs.existsSync(container)).toBe(false);
    });

    it.skipIf(process.platform === 'win32')(
      'reports an exceeded Git output bound and retains the checkout',
      async () => {
        const root = fixture();
        const container = quarantined(root, 'acme__oversized');
        const bin = path.join(root, 'bin');
        fs.mkdirSync(bin);
        fs.writeFileSync(
          path.join(bin, 'git'),
          `#!/bin/sh\nexec '${process.execPath}' -e 'process.stdout.write(Buffer.alloc(17 * 1024 * 1024, 120))'\n`,
          { mode: 0o755 },
        );
        const module = new URL('../lib/workspace-quarantine.js', import.meta.url).href;
        const child = spawnSync(
          process.execPath,
          [
            '--input-type=module',
            '-e',
            `
        import { expireQuarantine } from ${JSON.stringify(module)};
        console.log(JSON.stringify(await expireQuarantine(${JSON.stringify(root)})));
      `,
          ],
          {
            encoding: 'utf8',
            env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` },
            timeout: 4000,
            killSignal: 'SIGKILL',
          },
        );
        expect(child.error).toBeUndefined();
        expect(child.status, child.stderr).toBe(0);
        expect(JSON.parse(child.stdout)).toEqual({
          expired: [],
          errors: [{ path: container, error: expect.stringMatching(/Git.*output.*limit/i) }],
        });
        expect(fs.readFileSync(path.join(container, 'checkout', 'source'), 'utf8')).toBe('pushed');
      },
    );

    it.each(['source', 'deep/source', 'deep\twith\nspace/source'])(
      'keeps embedded repository history for tracked src/%s',
      async (source) => {
        const root = fixture();
        const container = quarantined(root, 'acme__embedded', (git, dir) => {
          const file = path.join(dir, 'src', source);
          fs.mkdirSync(path.dirname(file), { recursive: true });
          fs.writeFileSync(file, 'pushed');
          git('add', 'src');
          git('commit', '-qm', 'Track ordinary source directory');
          git('push', '-q', 'origin', 'HEAD');
          git('-C', 'src', 'init', '-q');
          fs.writeFileSync(file, 'private embedded work');
          git('-C', 'src', 'add', '.');
          git('-C', 'src', 'commit', '-qm', 'Private embedded history');
          fs.writeFileSync(file, 'pushed');
          expect(git('status', '--porcelain').trim()).toBe('');
          expect(git('stash', 'list').trim()).toBe('');
          expect(git('log', '--all', '--not', '--remotes', '--format=%H').trim()).toBe('');
        });
        expect(await expireQuarantine(root)).toEqual({ expired: [], errors: [] });
        expect(
          execFileSync('git', ['-C', path.join(container, 'checkout', 'src'), 'show', `HEAD:${source}`], {
            encoding: 'utf8',
          }),
        ).toBe('private embedded work');
        expect(fs.readFileSync(path.join(container, 'checkout', 'src', source), 'utf8')).toBe('pushed');
      },
    );

    it.each(['src', 'src/deep'])('keeps bare repository history in tracked %s', async (nested) => {
      const root = fixture();
      let privateCommit;
      const container = quarantined(root, 'acme__bare', (git, dir) => {
        const bare = path.join(dir, nested);
        fs.mkdirSync(bare, { recursive: true });
        fs.writeFileSync(path.join(bare, 'source'), 'pushed');
        fs.appendFileSync(path.join(dir, '.gitignore'), `/${nested}/*\n!/${nested}/source\n`);
        git('add', '.');
        git('commit', '-qm', 'Track source beside bare metadata');
        git('push', '-q', 'origin', 'HEAD');
        git('init', '-q', '--bare', bare);
        fs.writeFileSync(path.join(bare, 'source'), 'private bare work');
        git('--git-dir', bare, '--work-tree', bare, 'add', 'source');
        git('--git-dir', bare, '--work-tree', bare, 'commit', '-qm', 'Private bare history');
        privateCommit = git('--git-dir', bare, 'rev-parse', 'HEAD').trim();
        fs.writeFileSync(path.join(bare, 'source'), 'pushed');
        expect(git('ls-files', '--stage', `${nested}/source`)).toMatch(/^100644 /);
        expect(git('status', '--porcelain', '--untracked-files=normal').trim()).toBe('');
        expect(git('stash', 'list').trim()).toBe('');
        expect(git('log', '--all', '--not', '--remotes', '--format=%H').trim()).toBe('');
        expect(
          spawnSync('git', [
            '--git-dir',
            path.join(root, 'acme__bare.remote.git'),
            'cat-file',
            '-e',
            privateCommit,
          ]).status,
        ).not.toBe(0);
      });
      expect(await expireQuarantine(root)).toEqual({ expired: [], errors: [] });
      const bare = path.join(container, 'checkout', nested);
      expect(
        execFileSync('git', ['--git-dir', bare, 'show', `${privateCommit}:source`], { encoding: 'utf8' }),
      ).toBe('private bare work');
      expect(fs.readFileSync(path.join(bare, 'source'), 'utf8')).toBe('pushed');
    });

    it('expires tracked source directories with only some bare repository filenames', async () => {
      const root = fixture();
      const container = quarantined(root, 'acme__ordinary', (git, dir) => {
        fs.mkdirSync(path.join(dir, 'src', 'objects'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'src', 'HEAD'), 'ordinary source');
        fs.writeFileSync(path.join(dir, 'src', 'objects', 'source'), 'pushed');
        git('add', 'src');
        git('commit', '-qm', 'Track ordinary source');
        git('push', '-q', 'origin', 'HEAD');
      });
      expect(await expireQuarantine(root)).toEqual({ expired: [container], errors: [] });
      expect(fs.existsSync(container)).toBe(false);
    });

    it.skipIf(process.platform !== 'linux').each([Buffer.from([0xff]), Buffer.from([0xe2, 0x82])])(
      'keeps embedded history under a tracked directory with invalid UTF-8 bytes %s',
      async (bytes) => {
        const root = fixture();
        const dirname = Buffer.concat([Buffer.from('src-'), bytes]);
        const container = quarantined(root, 'acme__invalid', (git, dir) => {
          const rawDir = Buffer.concat([Buffer.from(`${dir}/`), dirname]);
          fs.mkdirSync(rawDir);
          fs.writeFileSync(Buffer.concat([rawDir, Buffer.from('/source')]), 'pushed');
          git('add', '.');
          git('commit', '-qm', 'Track raw pathname');
          git('push', '-q', 'origin', 'HEAD');
          const nested = path.join(root, 'nested');
          fs.mkdirSync(nested);
          git('-C', nested, 'init', '-q');
          fs.writeFileSync(path.join(nested, 'source'), 'private embedded work');
          git('-C', nested, 'add', '.');
          git('-C', nested, 'commit', '-qm', 'Private embedded history');
          fs.renameSync(path.join(nested, '.git'), Buffer.concat([rawDir, Buffer.from('/.git')]));
          expect(git('status', '--porcelain').trim()).toBe('');
          expect(git('log', '--all', '--not', '--remotes', '--format=%H').trim()).toBe('');
        });
        expect(await expireQuarantine(root)).toEqual({ expired: [], errors: [] });
        const alias = path.join(root, 'retained');
        fs.symlinkSync(Buffer.concat([Buffer.from(`${container}/checkout/`), dirname]), alias);
        expect(execFileSync('git', ['-C', alias, 'show', 'HEAD:source'], { encoding: 'utf8' })).toBe(
          'private embedded work',
        );
        expect(fs.readFileSync(path.join(alias, 'source'), 'utf8')).toBe('pushed');
      },
    );

    it('expires clean checkouts with valid UTF-8 replacement characters in tracked paths', async () => {
      const root = fixture();
      const container = quarantined(root, 'acme__unicode', (git, dir) => {
        fs.mkdirSync(path.join(dir, 'src-\uFFFD'));
        fs.writeFileSync(path.join(dir, 'src-\uFFFD', 'source'), 'pushed');
        git('add', '.');
        git('commit', '-qm', 'Track valid Unicode pathname');
        git('push', '-q', 'origin', 'HEAD');
      });
      expect(await expireQuarantine(root)).toEqual({ expired: [container], errors: [] });
      expect(fs.existsSync(container)).toBe(false);
    });

    it('keeps private Git notes', async () => {
      const root = fixture();
      const container = quarantined(root, 'acme__notes', (git) =>
        git('notes', 'add', '-m', 'private recovery notes'),
      );
      expect(await expireQuarantine(root)).toEqual({ expired: [], errors: [] });
      expect(
        execFileSync('git', ['-C', path.join(container, 'checkout'), 'notes', 'show'], {
          encoding: 'utf8',
        }).trim(),
      ).toBe('private recovery notes');
    });

    it('keeps unpublished commits in detached linked worktrees after relocation', async () => {
      const root = fixture();
      const linked = path.join(root, 'linked');
      let saved;
      const container = quarantined(root, 'acme__linked', (git) => {
        git('worktree', 'add', '-q', '--detach', linked);
        git('-C', linked, 'commit', '-q', '--allow-empty', '-m', 'Linked work');
        saved = git('-C', linked, 'rev-parse', 'HEAD').trim();
      });
      expect(await expireQuarantine(root)).toEqual({ expired: [], errors: [] });
      expect(
        execFileSync(
          'git',
          ['--git-dir', path.join(container, 'checkout', '.git'), 'cat-file', '-t', saved],
          {
            encoding: 'utf8',
          },
        ).trim(),
      ).toBe('commit');
    });

    it('keeps linked-worktree indexes and staged-only contents after relocation', async () => {
      const root = fixture();
      const linked = path.join(root, 'linked');
      const container = quarantined(root, 'acme__staged', (git) => {
        git('worktree', 'add', '-q', '--detach', linked);
        fs.writeFileSync(path.join(linked, 'source'), 'private staged work');
        git('-C', linked, 'add', 'source');
        fs.writeFileSync(path.join(linked, 'source'), 'pushed');
        expect(git('status', '--porcelain').trim()).toBe('');
        expect(git('log', '--all', '--not', '--remotes', '--format=%H').trim()).toBe('');
      });
      expect(await expireQuarantine(root)).toEqual({ expired: [], errors: [] });
      expect(
        execFileSync(
          'git',
          ['--git-dir', path.join(container, 'checkout', '.git', 'worktrees', 'linked'), 'show', ':source'],
          { encoding: 'utf8' },
        ),
      ).toBe('private staged work');
      expect(fs.readFileSync(path.join(linked, 'source'), 'utf8')).toBe('pushed');
    });

    it.each([
      ['blob', 'lightweight'],
      ['blob', 'annotated'],
      ['blob', 'nested'],
      ['tree', 'lightweight'],
      ['tree', 'annotated'],
      ['tree', 'nested'],
    ])('keeps private %s contents retained by a %s tag', async (type, tag) => {
      const root = fixture();
      const container = quarantined(root, 'acme__tagged', (git, dir) => {
        fs.writeFileSync(path.join(dir, 'private'), 'private tagged work');
        let target = git('hash-object', '-w', 'private').trim();
        if (type === 'tree') {
          git('add', 'private');
          target = git('write-tree').trim();
          git('reset', '-q', 'HEAD');
        }
        if (tag === 'nested') {
          git('tag', '-a', 'inner', target, '-m', 'Inner tag');
          target = 'inner';
        }
        if (tag === 'lightweight') git('tag', 'saved-private', target);
        else git('-c', 'advice.nestedTag=false', 'tag', '-a', 'saved-private', target, '-m', 'Saved');
        fs.unlinkSync(path.join(dir, 'private'));
        expect(git('status', '--porcelain').trim()).toBe('');
        expect(git('log', '--all', '--not', '--remotes', '--format=%H').trim()).toBe('');
      });
      expect(await expireQuarantine(root)).toEqual({ expired: [], errors: [] });
      expect(
        execFileSync(
          'git',
          [
            '-C',
            path.join(container, 'checkout'),
            'show',
            type === 'tree' ? 'saved-private:private' : 'saved-private^{}',
          ],
          { encoding: 'utf8' },
        ),
      ).toBe('private tagged work');
    });

    it('inspects the physical checkout when core.worktree points elsewhere', async () => {
      const root = fixture();
      const outside = fixture();
      const container = quarantined(root, 'acme__external', (git, dir) => {
        fs.copyFileSync(path.join(dir, 'source'), path.join(outside, 'source'));
        fs.copyFileSync(path.join(dir, '.gitignore'), path.join(outside, '.gitignore'));
        git('config', 'core.worktree', outside);
        fs.writeFileSync(path.join(dir, 'source'), 'unsaved physical work');
        expect(git('status', '--porcelain').trim()).toBe('');
      });
      expect(await expireQuarantine(root)).toEqual({ expired: [], errors: [] });
      expect(fs.readFileSync(path.join(container, 'checkout', 'source'), 'utf8')).toBe(
        'unsaved physical work',
      );
      expect(fs.readFileSync(path.join(outside, 'source'), 'utf8')).toBe('pushed');
    });

    it.each(['detached HEAD', 'lightweight tag', 'annotated tag'])(
      'keeps unpublished commits reachable from %s',
      async (ref) => {
        const root = fixture();
        let saved;
        const container = quarantined(root, 'acme__saved', (git) => {
          git('checkout', '-q', '--detach');
          git('commit', '-q', '--allow-empty', '-m', 'Saved work');
          saved = git('rev-parse', 'HEAD').trim();
          if (ref !== 'detached HEAD') {
            if (ref === 'annotated tag') git('tag', '-a', 'saved-work', '-m', 'Saved');
            else git('tag', 'saved-work');
            git('checkout', '-q', '-');
          }
        });
        expect(await expireQuarantine(root)).toEqual({ expired: [], errors: [] });
        expect(
          execFileSync('git', ['-C', path.join(container, 'checkout'), 'cat-file', '-t', saved], {
            encoding: 'utf8',
          }).trim(),
        ).toBe('commit');
      },
    );

    it('still expires a published detached HEAD and tags', async () => {
      const root = fixture();
      const container = quarantined(root, 'acme__published', (git) => {
        git('tag', '-a', 'published', '-m', 'Published');
        git('-c', 'advice.nestedTag=false', 'tag', '-a', 'nested', 'published', '-m', 'Nested');
        git('checkout', '-q', '--detach');
      });
      expect(await expireQuarantine(root)).toEqual({ expired: [container], errors: [] });
    });

    it('keeps untracked files when status.showUntrackedFiles is no', async () => {
      const root = fixture();
      const container = quarantined(root, 'acme__hidden', (git, dir) => {
        git('config', 'status.showUntrackedFiles', 'no');
        fs.writeFileSync(path.join(dir, 'notes'), 'untracked work');
        expect(git('status', '--porcelain').trim()).toBe('');
      });
      expect(await expireQuarantine(root)).toEqual({ expired: [], errors: [] });
      expect(fs.readFileSync(path.join(container, 'checkout', 'notes'), 'utf8')).toBe('untracked work');
    });

    it.skipIf(process.platform !== 'linux')(
      'keeps distinct untracked files hidden by core.ignoreCase',
      async () => {
        const root = fixture();
        const container = quarantined(root, 'acme__case', (git, dir) => {
          git('config', 'core.ignoreCase', 'true');
          fs.writeFileSync(path.join(dir, 'SOURCE'), 'private untracked work');
          expect(fs.readFileSync(path.join(dir, 'source'), 'utf8')).toBe('pushed');
          expect(git('status', '--porcelain', '--untracked-files=normal').trim()).toBe('');
          expect(
            git('-c', 'core.ignoreCase=false', 'status', '--porcelain', '--untracked-files=normal').trim(),
          ).toBe('?? SOURCE');
        });
        expect(await expireQuarantine(root)).toEqual({ expired: [], errors: [] });
        expect(fs.readFileSync(path.join(container, 'checkout', 'SOURCE'), 'utf8')).toBe(
          'private untracked work',
        );
        expect(fs.readFileSync(path.join(container, 'checkout', 'source'), 'utf8')).toBe('pushed');
      },
    );

    it('still expires a clean checkout configured with core.ignoreCase', async () => {
      const root = fixture();
      const container = quarantined(root, 'acme__case', (git) => git('config', 'core.ignoreCase', 'true'));
      expect(await expireQuarantine(root)).toEqual({ expired: [container], errors: [] });
      expect(fs.existsSync(container)).toBe(false);
    });

    it.skipIf(process.platform === 'win32')(
      'keeps executable-bit edits hidden by core.fileMode',
      async () => {
        const root = fixture();
        const container = quarantined(root, 'acme__mode', (git, dir) => {
          fs.chmodSync(path.join(dir, 'source'), 0o644);
          git('update-index', '--chmod=-x', 'source');
          git('config', 'core.fileMode', 'false');
          fs.chmodSync(path.join(dir, 'source'), 0o755);
          expect(git('status', '--porcelain', '--untracked-files=normal').trim()).toBe('');
          expect(
            git('-c', 'core.fileMode=true', 'status', '--porcelain', '--untracked-files=normal').trim(),
          ).toBe('M source');
        });
        expect(await expireQuarantine(root)).toEqual({ expired: [], errors: [] });
        const source = path.join(container, 'checkout', 'source');
        expect(fs.statSync(source).mode & 0o777).toBe(0o755);
        expect(fs.readFileSync(source, 'utf8')).toBe('pushed');
      },
    );

    it('still expires a clean checkout configured with core.fileMode=false', async () => {
      const root = fixture();
      const container = quarantined(root, 'acme__mode', (git) => git('config', 'core.fileMode', 'false'));
      expect(await expireQuarantine(root)).toEqual({ expired: [container], errors: [] });
      expect(fs.existsSync(container)).toBe(false);
    });

    it('keeps same-length edits with restored mtimes hidden by core.trustctime', async () => {
      const root = fixture();
      const container = quarantined(root, 'acme__mtime', (git, dir) => {
        git('config', 'core.trustctime', 'false');
        const source = path.join(dir, 'source');
        fs.utimesSync(source, 946684800, 946684800);
        git('update-index', '--refresh');
      });
      const checkout = path.join(container, 'checkout');
      const source = path.join(checkout, 'source');
      const before = fs.statSync(source);
      // Cross a full timestamp second so ctime is the only changed cache field.
      await new Promise((resolve) => setTimeout(resolve, 1100));
      fs.writeFileSync(source, 'secret');
      fs.utimesSync(source, before.atime, before.mtime);
      expect(Math.floor(fs.statSync(source).ctimeMs / 1000)).toBeGreaterThan(
        Math.floor(before.ctimeMs / 1000),
      );
      expect(
        execFileSync('git', ['-C', checkout, 'status', '--porcelain'], { encoding: 'utf8' }).trim(),
      ).toBe('');
      expect(await expireQuarantine(root)).toEqual({ expired: [], errors: [] });
      expect(fs.readFileSync(source, 'utf8')).toBe('secret');
    });

    it('still expires a clean checkout configured with core.trustctime=false', async () => {
      const root = fixture();
      const container = quarantined(root, 'acme__mtime', (git) => git('config', 'core.trustctime', 'false'));
      expect(await expireQuarantine(root)).toEqual({ expired: [container], errors: [] });
      expect(fs.existsSync(container)).toBe(false);
    });

    it.skipIf(process.platform === 'win32').each([false, true])(
      'inspects symlink types with core.symlinks=false (replaced: %s)',
      async (replaced) => {
        const root = fixture();
        const container = quarantined(root, 'acme__symlink', (git, dir) => {
          const link = path.join(dir, 'link');
          fs.symlinkSync('source', link);
          git('add', 'link');
          git('commit', '-qm', 'Publish symlink');
          git('push', '-q', 'origin', 'HEAD');
          git('config', 'core.symlinks', 'false');
          if (replaced) {
            fs.unlinkSync(link);
            fs.writeFileSync(link, 'source');
          }
          expect(git('status', '--porcelain', '--untracked-files=normal').trim()).toBe('');
        });
        expect(await expireQuarantine(root)).toEqual({ expired: replaced ? [] : [container], errors: [] });
        if (replaced) {
          const link = path.join(container, 'checkout', 'link');
          expect(fs.lstatSync(link).isFile()).toBe(true);
          expect(fs.readFileSync(link, 'utf8')).toBe('source');
        } else expect(fs.existsSync(container)).toBe(false);
      },
    );

    it.each(['--assume-unchanged', '--skip-worktree'])('keeps tracked edits hidden by %s', async (flag) => {
      const root = fixture();
      const container = quarantined(root, 'acme__hidden', (git, dir) => {
        git('update-index', flag, 'source');
        fs.writeFileSync(path.join(dir, 'source'), 'hidden work');
        expect(git('status', '--porcelain').trim()).toBe('');
      });
      expect(await expireQuarantine(root)).toEqual({ expired: [], errors: [] });
      expect(fs.readFileSync(path.join(container, 'checkout', 'source'), 'utf8')).toBe('hidden work');
    });

    it.each([false, true])('keeps a submodule stash (deinitialized: %s)', async (deinitialized) => {
      const root = fixture();
      const container = quarantined(root, 'acme__submodule', (git, dir) => {
        git(
          '-c',
          'protocol.file.allow=always',
          'submodule',
          'add',
          '-q',
          path.join(root, 'acme__submodule.remote.git'),
          'dependency',
        );
        git('commit', '-qm', 'Add submodule');
        git('push', '-q', 'origin', 'HEAD');
        fs.writeFileSync(path.join(dir, 'dependency', 'notes'), 'submodule work');
        git('-C', 'dependency', 'stash', 'push', '-qu');
        if (deinitialized) git('submodule', 'deinit', '-q', 'dependency');
        expect(git('status', '--porcelain').trim()).toBe('');
      });
      expect(await expireQuarantine(root)).toEqual({ expired: [], errors: [] });
      expect(
        execFileSync(
          'git',
          [
            '--git-dir',
            path.join(container, 'checkout', '.git', 'modules', 'dependency'),
            'show',
            'stash^3:notes',
          ],
          { encoding: 'utf8' },
        ),
      ).toBe('submodule work');
    });

    it.skipIf(process.platform === 'win32')('does not follow a symlinked checkout', async () => {
      const root = fixture();
      const container = quarantined(root, 'acme__linked');
      const checkout = path.join(container, 'checkout');
      const outside = path.join(fixture(), 'external-checkout');
      fs.renameSync(checkout, outside);
      fs.symlinkSync(outside, checkout);
      expect(await expireQuarantine(root)).toEqual({ expired: [], errors: [] });
      expect(fs.readFileSync(path.join(outside, 'source'), 'utf8')).toBe('pushed');
      expect(fs.lstatSync(checkout).isSymbolicLink()).toBe(true);
    });

    it('keeps unchecked files beside the checkout', async () => {
      const root = fixture();
      const container = quarantined(root, 'acme__notes');
      fs.writeFileSync(path.join(container, 'recovery-notes'), 'operator work');
      expect(await expireQuarantine(root)).toEqual({ expired: [], errors: [] });
      expect(fs.readFileSync(path.join(container, 'recovery-notes'), 'utf8')).toBe('operator work');
      expect(fs.existsSync(path.join(container, 'checkout', '.git'))).toBe(true);
    });

    it.skipIf(process.platform === 'win32')('does not run a configured fsmonitor hook', async () => {
      const root = fixture();
      const marker = path.join(root, 'hook-ran');
      const hook = path.join(root, 'fsmonitor');
      fs.writeFileSync(hook, `#!/bin/sh\ntouch '${marker}'\nexec sleep 2\n`, { mode: 0o755 });
      const container = quarantined(root, 'acme__hook', (git) => git('config', 'core.fsmonitor', hook));
      expect(await expireQuarantine(root)).toEqual({ expired: [container], errors: [] });
      expect(fs.existsSync(marker)).toBe(false);
    });

    it.skipIf(process.platform === 'win32')(
      'bounds a stalled Git probe and keeps the checkout',
      async () => {
        const root = fixture();
        const container = quarantined(root, 'acme__stalled');
        const bin = path.join(root, 'bin');
        const pidFile = path.join(root, 'git.pid');
        fs.mkdirSync(bin);
        fs.writeFileSync(
          path.join(bin, 'git'),
          `#!/bin/sh\nprintf '%s' "$$" > '${pidFile}'\nexec sleep 30\n`,
          { mode: 0o755 },
        );
        const module = new URL('../lib/workspace-quarantine.js', import.meta.url).href;
        try {
          // An outer deadline makes a missing production timeout fail safely.
          const child = spawnSync(
            process.execPath,
            [
              '--input-type=module',
              '-e',
              `
          import { expireQuarantine } from ${JSON.stringify(module)};
          console.log(JSON.stringify(await expireQuarantine(${JSON.stringify(root)}, { gitTimeoutMs: 1000 })));
        `,
            ],
            {
              encoding: 'utf8',
              env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` },
              timeout: 4000,
              killSignal: 'SIGKILL',
            },
          );
          expect(child.error).toBeUndefined();
          expect(child.status, child.stderr).toBe(0);
          expect(JSON.parse(child.stdout)).toEqual({
            expired: [],
            errors: [{ path: container, error: expect.stringMatching(/Git ls-files.*ETIMEDOUT/i) }],
          });
          expect(fs.readFileSync(path.join(container, 'checkout', 'source'), 'utf8')).toBe('pushed');
        } finally {
          if (fs.existsSync(pidFile)) {
            try {
              process.kill(Number(fs.readFileSync(pidFile, 'utf8')), 'SIGKILL');
            } catch {
              /* Already exited. */
            }
          }
        }
      },
      10000,
    );

    it('does nothing without a recovery directory or through a symlinked one', async () => {
      const root = fixture();
      expect(await expireQuarantine(root)).toEqual({ expired: [], errors: [] });
      const outside = fixture();
      quarantined(outside, 'acme__clean');
      fs.symlinkSync(path.join(outside, QUARANTINE_NAME), path.join(root, QUARANTINE_NAME));
      expect(await expireQuarantine(root)).toEqual({ expired: [], errors: [] });
      expect(fs.readdirSync(path.join(outside, QUARANTINE_NAME))).toHaveLength(1);
    });

    it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
      'reports a checkout whose build output refuses removal and keeps its history',
      async () => {
        const root = fixture();
        const container = quarantined(root, 'acme__clean');
        const build = path.join(container, 'checkout', 'build');
        fs.chmodSync(build, 0o555);
        try {
          const result = await expireQuarantine(root);
          expect(result.expired).toEqual([]);
          expect(result.errors).toEqual([{ path: container, error: expect.stringMatching(/EACCES|EPERM/) }]);
          expect(fs.existsSync(path.join(container, 'checkout', '.git', 'HEAD'))).toBe(true);
        } finally {
          fs.chmodSync(build, 0o755);
        }
      },
    );
  });
});
