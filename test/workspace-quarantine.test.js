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

    it('deletes checkouts with no local work and keeps every kind of work', () => {
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

      expect(expireQuarantine(root)).toEqual({ expired: [clean], errors: [] });
      expect(fs.existsSync(clean)).toBe(false);
      for (const kept of [modified, untracked, unpushed, otherBranch, stashed, noGit])
        expect(fs.existsSync(path.join(kept, 'checkout')), kept).toBe(true);
    });

    it.each(['rebase-merge', 'rebase-apply', 'merge'])(
      'keeps private autostash contents held by an unfinished %s',
      (operation) => {
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
        expect(expireQuarantine(root)).toEqual({ expired: [], errors: [] });
        expect(
          execFileSync('git', ['-C', path.join(container, 'checkout'), 'show', `${autostash}:.gitignore`], {
            encoding: 'utf8',
          }),
        ).toBe('build/\nprivate saved work\n');
      },
    );

    it('keeps recoverable staged contents in an interrupted index write', () => {
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
      expect(expireQuarantine(root)).toEqual({ expired: [], errors: [] });
      const checkout = path.join(container, 'checkout');
      expect(
        execFileSync('git', ['-C', checkout, 'show', ':source'], {
          encoding: 'utf8',
          env: { ...process.env, GIT_INDEX_FILE: path.join(checkout, '.git', 'index.lock') },
        }),
      ).toBe('private staged work');
      expect(fs.readFileSync(path.join(checkout, 'source'), 'utf8')).toBe('pushed');
    });

    it('keeps unpublished branch history hidden by local grafts', () => {
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
      expect(expireQuarantine(root)).toEqual({ expired: [], errors: [] });
      expect(
        execFileSync('git', ['-C', path.join(container, 'checkout'), 'show', 'private:source'], {
          encoding: 'utf8',
        }),
      ).toBe('private unpublished work');
    });

    it('reports a nonzero Git inspection exit and retains the checkout', () => {
      const root = fixture();
      const container = quarantined(root, 'acme__corrupt', (git, dir) => {
        fs.writeFileSync(path.join(dir, '.git', 'index'), 'corrupt');
      });
      expect(expireQuarantine(root)).toEqual({
        expired: [],
        errors: [{ path: container, error: expect.stringMatching(/Git ls-files.*128.*index/i) }],
      });
      expect(fs.readFileSync(path.join(container, 'checkout', 'source'), 'utf8')).toBe('pushed');
      expect(fs.existsSync(path.join(container, 'checkout', '.git', 'HEAD'))).toBe(true);
    });

    it('frees capacity at the retention bound', () => {
      const root = fixture();
      const recovery = path.join(root, QUARANTINE_NAME);
      quarantined(root, 'acme__clean');
      for (let i = 1; i < QUARANTINE_LIMIT; i++)
        fs.mkdirSync(path.join(recovery, `backup-${i}`, 'checkout'), { recursive: true });
      const dir = path.join(root, 'acme__app');
      fs.mkdirSync(dir);
      expect(() => quarantineWorkspace(dir)).toThrow(/Recovery limit/);
      expect(expireQuarantine(root).expired).toHaveLength(1);
      expect(fs.existsSync(quarantineWorkspace(dir))).toBe(true);
    });

    it('expires a clean checkout whose index output exceeds 1 MiB', () => {
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
      expect(expireQuarantine(root)).toEqual({ expired: [container], errors: [] });
      expect(fs.existsSync(container)).toBe(false);
    });

    it.skipIf(process.platform === 'win32')(
      'reports an exceeded Git output bound and retains the checkout',
      () => {
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
        console.log(JSON.stringify(expireQuarantine(${JSON.stringify(root)})));
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
      (source) => {
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
        expect(expireQuarantine(root)).toEqual({ expired: [], errors: [] });
        expect(
          execFileSync('git', ['-C', path.join(container, 'checkout', 'src'), 'show', `HEAD:${source}`], {
            encoding: 'utf8',
          }),
        ).toBe('private embedded work');
        expect(fs.readFileSync(path.join(container, 'checkout', 'src', source), 'utf8')).toBe('pushed');
      },
    );

    it.skipIf(process.platform !== 'linux').each([Buffer.from([0xff]), Buffer.from([0xe2, 0x82])])(
      'keeps embedded history under a tracked directory with invalid UTF-8 bytes %s',
      (bytes) => {
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
        expect(expireQuarantine(root)).toEqual({ expired: [], errors: [] });
        const alias = path.join(root, 'retained');
        fs.symlinkSync(Buffer.concat([Buffer.from(`${container}/checkout/`), dirname]), alias);
        expect(execFileSync('git', ['-C', alias, 'show', 'HEAD:source'], { encoding: 'utf8' })).toBe(
          'private embedded work',
        );
        expect(fs.readFileSync(path.join(alias, 'source'), 'utf8')).toBe('pushed');
      },
    );

    it('expires clean checkouts with valid UTF-8 replacement characters in tracked paths', () => {
      const root = fixture();
      const container = quarantined(root, 'acme__unicode', (git, dir) => {
        fs.mkdirSync(path.join(dir, 'src-\uFFFD'));
        fs.writeFileSync(path.join(dir, 'src-\uFFFD', 'source'), 'pushed');
        git('add', '.');
        git('commit', '-qm', 'Track valid Unicode pathname');
        git('push', '-q', 'origin', 'HEAD');
      });
      expect(expireQuarantine(root)).toEqual({ expired: [container], errors: [] });
      expect(fs.existsSync(container)).toBe(false);
    });

    it('keeps private Git notes', () => {
      const root = fixture();
      const container = quarantined(root, 'acme__notes', (git) =>
        git('notes', 'add', '-m', 'private recovery notes'),
      );
      expect(expireQuarantine(root)).toEqual({ expired: [], errors: [] });
      expect(
        execFileSync('git', ['-C', path.join(container, 'checkout'), 'notes', 'show'], {
          encoding: 'utf8',
        }).trim(),
      ).toBe('private recovery notes');
    });

    it('keeps unpublished commits in detached linked worktrees after relocation', () => {
      const root = fixture();
      const linked = path.join(root, 'linked');
      let saved;
      const container = quarantined(root, 'acme__linked', (git) => {
        git('worktree', 'add', '-q', '--detach', linked);
        git('-C', linked, 'commit', '-q', '--allow-empty', '-m', 'Linked work');
        saved = git('-C', linked, 'rev-parse', 'HEAD').trim();
      });
      expect(expireQuarantine(root)).toEqual({ expired: [], errors: [] });
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

    it('keeps linked-worktree indexes and staged-only contents after relocation', () => {
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
      expect(expireQuarantine(root)).toEqual({ expired: [], errors: [] });
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
    ])('keeps private %s contents retained by a %s tag', (type, tag) => {
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
      expect(expireQuarantine(root)).toEqual({ expired: [], errors: [] });
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

    it('inspects the physical checkout when core.worktree points elsewhere', () => {
      const root = fixture();
      const outside = fixture();
      const container = quarantined(root, 'acme__external', (git, dir) => {
        fs.copyFileSync(path.join(dir, 'source'), path.join(outside, 'source'));
        fs.copyFileSync(path.join(dir, '.gitignore'), path.join(outside, '.gitignore'));
        git('config', 'core.worktree', outside);
        fs.writeFileSync(path.join(dir, 'source'), 'unsaved physical work');
        expect(git('status', '--porcelain').trim()).toBe('');
      });
      expect(expireQuarantine(root)).toEqual({ expired: [], errors: [] });
      expect(fs.readFileSync(path.join(container, 'checkout', 'source'), 'utf8')).toBe(
        'unsaved physical work',
      );
      expect(fs.readFileSync(path.join(outside, 'source'), 'utf8')).toBe('pushed');
    });

    it.each(['detached HEAD', 'lightweight tag', 'annotated tag'])(
      'keeps unpublished commits reachable from %s',
      (ref) => {
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
        expect(expireQuarantine(root)).toEqual({ expired: [], errors: [] });
        expect(
          execFileSync('git', ['-C', path.join(container, 'checkout'), 'cat-file', '-t', saved], {
            encoding: 'utf8',
          }).trim(),
        ).toBe('commit');
      },
    );

    it('still expires a published detached HEAD and tags', () => {
      const root = fixture();
      const container = quarantined(root, 'acme__published', (git) => {
        git('tag', '-a', 'published', '-m', 'Published');
        git('-c', 'advice.nestedTag=false', 'tag', '-a', 'nested', 'published', '-m', 'Nested');
        git('checkout', '-q', '--detach');
      });
      expect(expireQuarantine(root)).toEqual({ expired: [container], errors: [] });
    });

    it('keeps untracked files when status.showUntrackedFiles is no', () => {
      const root = fixture();
      const container = quarantined(root, 'acme__hidden', (git, dir) => {
        git('config', 'status.showUntrackedFiles', 'no');
        fs.writeFileSync(path.join(dir, 'notes'), 'untracked work');
        expect(git('status', '--porcelain').trim()).toBe('');
      });
      expect(expireQuarantine(root)).toEqual({ expired: [], errors: [] });
      expect(fs.readFileSync(path.join(container, 'checkout', 'notes'), 'utf8')).toBe('untracked work');
    });

    it.each(['--assume-unchanged', '--skip-worktree'])('keeps tracked edits hidden by %s', (flag) => {
      const root = fixture();
      const container = quarantined(root, 'acme__hidden', (git, dir) => {
        git('update-index', flag, 'source');
        fs.writeFileSync(path.join(dir, 'source'), 'hidden work');
        expect(git('status', '--porcelain').trim()).toBe('');
      });
      expect(expireQuarantine(root)).toEqual({ expired: [], errors: [] });
      expect(fs.readFileSync(path.join(container, 'checkout', 'source'), 'utf8')).toBe('hidden work');
    });

    it.each([false, true])('keeps a submodule stash (deinitialized: %s)', (deinitialized) => {
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
      expect(expireQuarantine(root)).toEqual({ expired: [], errors: [] });
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

    it.skipIf(process.platform === 'win32')('does not follow a symlinked checkout', () => {
      const root = fixture();
      const container = quarantined(root, 'acme__linked');
      const checkout = path.join(container, 'checkout');
      const outside = path.join(fixture(), 'external-checkout');
      fs.renameSync(checkout, outside);
      fs.symlinkSync(outside, checkout);
      expect(expireQuarantine(root)).toEqual({ expired: [], errors: [] });
      expect(fs.readFileSync(path.join(outside, 'source'), 'utf8')).toBe('pushed');
      expect(fs.lstatSync(checkout).isSymbolicLink()).toBe(true);
    });

    it('keeps unchecked files beside the checkout', () => {
      const root = fixture();
      const container = quarantined(root, 'acme__notes');
      fs.writeFileSync(path.join(container, 'recovery-notes'), 'operator work');
      expect(expireQuarantine(root)).toEqual({ expired: [], errors: [] });
      expect(fs.readFileSync(path.join(container, 'recovery-notes'), 'utf8')).toBe('operator work');
      expect(fs.existsSync(path.join(container, 'checkout', '.git'))).toBe(true);
    });

    it.skipIf(process.platform === 'win32')('does not run a configured fsmonitor hook', () => {
      const root = fixture();
      const marker = path.join(root, 'hook-ran');
      const hook = path.join(root, 'fsmonitor');
      fs.writeFileSync(hook, `#!/bin/sh\ntouch '${marker}'\nexec sleep 2\n`, { mode: 0o755 });
      const container = quarantined(root, 'acme__hook', (git) => git('config', 'core.fsmonitor', hook));
      expect(expireQuarantine(root)).toEqual({ expired: [container], errors: [] });
      expect(fs.existsSync(marker)).toBe(false);
    });

    it.skipIf(process.platform === 'win32')(
      'bounds a stalled Git probe and keeps the checkout',
      () => {
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
          console.log(JSON.stringify(expireQuarantine(${JSON.stringify(root)})));
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

    it('does nothing without a recovery directory or through a symlinked one', () => {
      const root = fixture();
      expect(expireQuarantine(root)).toEqual({ expired: [], errors: [] });
      const outside = fixture();
      quarantined(outside, 'acme__clean');
      fs.symlinkSync(path.join(outside, QUARANTINE_NAME), path.join(root, QUARANTINE_NAME));
      expect(expireQuarantine(root)).toEqual({ expired: [], errors: [] });
      expect(fs.readdirSync(path.join(outside, QUARANTINE_NAME))).toHaveLength(1);
    });

    it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
      'reports a checkout whose build output refuses removal and keeps its history',
      () => {
        const root = fixture();
        const container = quarantined(root, 'acme__clean');
        const build = path.join(container, 'checkout', 'build');
        fs.chmodSync(build, 0o555);
        try {
          const result = expireQuarantine(root);
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
