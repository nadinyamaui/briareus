import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { quarantineWorkspace, QUARANTINE_NAME, QUARANTINE_LIMIT } from '../lib/workspace-quarantine.js';

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

  it('refuses at the retention bound without altering the source or old backups', () => {
    const root = fixture();
    const recovery = path.join(root, QUARANTINE_NAME);
    fs.mkdirSync(recovery);
    for (let i = 0; i < QUARANTINE_LIMIT; i++) fs.mkdirSync(path.join(recovery, `backup-${i}`));
    const dir = path.join(root, 'acme__app');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'work'), 'preserve');
    expect(() => quarantineWorkspace(dir)).toThrow(/Recovery limit.*recover or move preserved work/);
    expect(fs.readFileSync(path.join(dir, 'work'), 'utf8')).toBe('preserve');
    expect(fs.readdirSync(recovery)).toHaveLength(QUARANTINE_LIMIT);
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
});
