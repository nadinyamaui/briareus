import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { readSecurityFile, replaceSecurityFile } from '../lib/review-security-files.js';
import { RECORD_BYTES_MAX } from '../lib/review-security.js';

let root;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'review-security-files-'));
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

// Run FIFO operations in a process with a deadline: a regression must fail the test
// instead of hanging the test runner in openSync.
function child(code, file) {
  const result = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
      import assert from 'node:assert/strict';
      import { readSecurityFile, replaceSecurityFile } from ${JSON.stringify(new URL('../lib/review-security-files.js', import.meta.url).href)};
      const file = process.argv[1];
      ${code}
    `,
      file,
    ],
    { timeout: 5000, encoding: 'utf8' },
  );
  expect(result.error).toBeUndefined();
  expect(result.stderr).toBe('');
  expect(result.status).toBe(0);
}

describe('reading the agent’s security record', () => {
  it('rejects a FIFO promptly without a writer', () => {
    const file = path.join(root, 'record');
    execFileSync('mkfifo', [file]);
    child('assert.throws(() => readSecurityFile(file), /not a regular file/);', file);
  });

  it('rejects directories and symlinks', () => {
    expect(() => readSecurityFile(root)).toThrow('not a regular file');
    const target = path.join(root, 'target');
    fs.writeFileSync(target, '{}');
    const link = path.join(root, 'record');
    fs.symlinkSync(target, link);
    expect(() => readSecurityFile(link)).toThrow('The security pass left no record');
  });

  it('sizes the read to the UTF-8 file plus a growth sentinel', () => {
    const file = path.join(root, 'record');
    const text = JSON.stringify({ assessment: 'Checked authorization 🔒' });
    fs.writeFileSync(file, text);
    const alloc = vi.spyOn(Buffer, 'alloc');
    expect(readSecurityFile(file)).toEqual(JSON.parse(text));
    expect(alloc).toHaveBeenCalledExactlyOnceWith(Buffer.byteLength(text) + 1);
  });

  it('refuses growth after fstat instead of accepting a truncated record', () => {
    const file = path.join(root, 'record');
    fs.writeFileSync(file, '{}');
    const fstat = fs.fstatSync;
    vi.spyOn(fs, 'fstatSync').mockImplementationOnce((fd) => {
      const stat = fstat(fd);
      fs.appendFileSync(file, ' ');
      return stat;
    });
    expect(() => readSecurityFile(file)).toThrow('changed while it was being read');
  });

  it('rejects oversized records before allocating or reading', () => {
    const file = path.join(root, 'record');
    fs.writeFileSync(file, '{}');
    fs.truncateSync(file, RECORD_BYTES_MAX + 1);
    const read = vi.spyOn(fs, 'readSync');
    const alloc = vi.spyOn(Buffer, 'alloc');
    expect(() => readSecurityFile(file)).toThrow('larger than 1024 KB');
    expect(read).not.toHaveBeenCalled();
    expect(alloc).not.toHaveBeenCalled();
  });
});

describe.each(['review-security-claims.json', 'review-security.json'])('replacing %s', (name) => {
  it.each(['hard link', 'symlink'])('replaces a %s without changing the target’s bytes or mode', (kind) => {
    const target = path.join(root, 'server-file');
    const file = path.join(root, name);
    fs.writeFileSync(target, 'keep me');
    fs.chmodSync(target, 0o640);
    if (kind === 'hard link') fs.linkSync(target, file);
    else fs.symlinkSync(target, file);
    replaceSecurityFile(file, '{"accepted":true}');
    expect(fs.readFileSync(target, 'utf8')).toBe('keep me');
    expect(fs.statSync(target).mode & 0o777).toBe(0o640);
    expect(fs.lstatSync(file).isFile()).toBe(true);
    expect(fs.statSync(file).nlink).toBe(1);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ accepted: true });
    expect(fs.readdirSync(root).sort()).toEqual([name, 'server-file'].sort());
  });

  it('replaces a FIFO promptly without a reader', () => {
    const file = path.join(root, name);
    execFileSync('mkfifo', [file]);
    child("replaceSecurityFile(file, '{}');", file);
    expect(fs.statSync(file).isFile()).toBe(true);
    expect(fs.readFileSync(file, 'utf8')).toBe('{}');
  });

  it('cleans up its temporary directory if replacement fails', () => {
    const file = path.join(root, name);
    fs.mkdirSync(file);
    expect(() => replaceSecurityFile(file, '{}')).toThrow();
    expect(fs.readdirSync(root)).toEqual([name]);
  });
});
