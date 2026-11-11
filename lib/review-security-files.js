// @ts-check
import fs from 'node:fs';
import path from 'node:path';
import { RECORD_BYTES_MAX } from './review-security.js';

// The agent writes this path. Opening a FIFO must never wait for a writer, and only
// regular files are records. Check the opened descriptor, not a path that can change.
export function readSecurityFile(file) {
  const unreadable = 'The security pass left no record, or one that is not JSON';
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  } catch {
    throw new Error(unreadable);
  }
  let text;
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw new Error('The security record is not a regular file');
    if (stat.size > RECORD_BYTES_MAX)
      throw new Error(`The security record is larger than ${Math.round(RECORD_BYTES_MAX / 1024)} KB`);
    // One extra byte detects growth without allocating a megabyte for every record.
    const buffer = Buffer.alloc(stat.size + 1);
    const read = fs.readSync(fd, buffer, 0, buffer.length, 0);
    if (read > stat.size) throw new Error('The security record changed while it was being read');
    text = buffer.toString('utf8', 0, read);
  } finally {
    fs.closeSync(fd);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(unreadable);
  }
}

// Both the claims path and the accepted-record path can already name an agent-made
// link or FIFO. Replace their directory entry without opening or chmodding the target.
export function replaceSecurityFile(file, text) {
  const scratch = fs.mkdtempSync(path.join(path.dirname(file), '.review-security-'));
  try {
    const fresh = path.join(scratch, 'record');
    fs.writeFileSync(fresh, text, { flag: 'wx', mode: 0o600 });
    fs.renameSync(fresh, file);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}
