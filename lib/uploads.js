// @ts-check
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';

// Files attached to a chat message. Each upload gets its own OS temp directory so the
// original filename survives, and the agent is handed the absolute path, since provider
// CLIs read files from disk, not inline. Never written into a workspace clone: a local
// checkout is the developer's tree and pooled clones are reset between sessions.
const ROOT = path.join(os.tmpdir(), 'reviewer-uploads');

// Uploads outlive their message (a reopened session reuses the prompt paths), so they are
// pruned by age at boot, not per turn.
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

// The client's name reduced to a plain, never-empty basename without separators, control
// characters or shell/filesystem metacharacters.
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
