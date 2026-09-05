// @ts-check
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';

// Files attached to a chat message. Each upload gets a directory of its own in
// the OS temp dir so the original filename survives beside nothing else, and
// the message hands the agent the absolute path: every provider CLI can read
// a file from disk, none can take the bytes inline. Nothing here is ever
// written into a workspace clone: a local checkout is the developer's own
// tree, and a pooled clone gets reset between sessions.
const ROOT = path.join(os.tmpdir(), 'reviewer-uploads');

// Uploads outlive the message they were sent with (a reopened session re-runs
// against the same prompt paths) so they are pruned by age at boot, not per
// turn.
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export function initUploads() {
  fs.mkdirSync(ROOT, { recursive: true });
  for (const name of fs.readdirSync(ROOT)) {
    const dir = path.join(ROOT, name);
    try {
      if (Date.now() - fs.statSync(dir).mtimeMs > MAX_AGE_MS) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    } catch {
      /* an entry that vanished mid-scan is already gone */
    }
  }
}

// The stored name is the client's, reduced to a plain basename: path
// separators, control characters and the shell/filesystem metacharacters go,
// and the result is never empty.
function safeName(name) {
  const base = String(name || '')
    .split(/[\\/]/)
    .pop()
    .replace(/[\x00-\x1f<>:"|?*]/g, '')
    .trim();
  return base || 'file';
}

export function storeUpload(name, buffer) {
  const id = crypto.randomUUID().slice(0, 8);
  const dir = path.join(ROOT, id);
  fs.mkdirSync(dir, { recursive: true });
  const fileName = safeName(name);
  fs.writeFileSync(path.join(dir, fileName), buffer);
  return { id, name: fileName, size: buffer.length };
}

// id -> { id, name, size, path }, or null for an id that does not resolve to a
// stored upload (expired, mistyped, or never ours).
export function getUpload(id) {
  if (!/^[0-9a-f]{8}$/.test(String(id || ''))) return null;
  const dir = path.join(ROOT, id);
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return null;
  }
  if (!names.length) return null;
  const file = path.join(dir, names[0]);
  try {
    return { id, name: names[0], size: fs.statSync(file).size, path: file };
  } catch {
    return null;
  }
}
