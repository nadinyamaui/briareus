import { describe, it, expect } from 'vitest';
import fs from 'fs';
import { initUploads, storeUpload, getUpload } from '../lib/uploads.js';

// These run against the real OS temp dir, the same place the app uses, so
// initUploads() first, exactly like boot does.
initUploads();

describe('storeUpload / getUpload', () => {
  it('stores a file and reads it back by id', () => {
    const stored = storeUpload('notes.txt', Buffer.from('hello'));
    expect(stored.id).toMatch(/^[0-9a-f]{8}$/);
    expect(stored).toMatchObject({ name: 'notes.txt', size: 5 });

    const found = getUpload(stored.id);
    expect(found).toMatchObject({ id: stored.id, name: 'notes.txt', size: 5 });
    expect(fs.readFileSync(found.path, 'utf8')).toBe('hello');
  });

  it('reduces the client name to a safe basename', () => {
    expect(storeUpload('../../../etc/passwd', Buffer.from('x')).name).toBe('passwd');
    expect(storeUpload('..\\..\\evil.txt', Buffer.from('x')).name).toBe('evil.txt');
    expect(storeUpload('a<b>:c"d|e?f*.txt', Buffer.from('x')).name).toBe('abcdef.txt');
    expect(storeUpload('ctl\x00\x1fchars.txt', Buffer.from('x')).name).toBe('ctlchars.txt');
  });

  it('never stores an empty name', () => {
    expect(storeUpload('', Buffer.from('x')).name).toBe('file');
    expect(storeUpload('<>:*', Buffer.from('x')).name).toBe('file');
    expect(storeUpload(null, Buffer.from('x')).name).toBe('file');
  });

  it('rejects an id that is not eight hex chars, including a path traversal', () => {
    expect(getUpload('nope')).toBeNull();
    expect(getUpload('../secret')).toBeNull();
    expect(getUpload('DEADBEEF')).toBeNull(); // uppercase is not ours either
    expect(getUpload('')).toBeNull();
    expect(getUpload(null)).toBeNull();
  });

  it('answers null for a well-formed id nothing was stored under', () => {
    expect(getUpload('0123abcd')).toBeNull();
  });
});
