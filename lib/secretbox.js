// @ts-check
import crypto from 'crypto';
import { getConfig } from './config.js';

// Encryption at rest for credentials the server keeps for others (an SSH server's
// database login): AES-256-GCM under CREDENTIALS_KEY, so dumps carry only ciphertext.
// The key is separate from AUTH_SECRET so rotating the token secret cannot make stored
// passwords unreadable. Sealed format: `v1:<iv>:<tag>:<ciphertext>` in base64; the version
// allows a future format without guessing.

const MIN_KEY_LENGTH = 32;

function key() {
  const raw = getConfig().credentialsKey || '';
  if (!raw) {
    throw new Error(
      'Set CREDENTIALS_KEY in .env (e.g. `openssl rand -base64 32`) and restart before storing credentials',
    );
  }
  if (raw.length < MIN_KEY_LENGTH)
    throw new Error(`CREDENTIALS_KEY must be at least ${MIN_KEY_LENGTH} characters`);
  // Any string of enough length works; hashing it gives the cipher its 32 bytes.
  return crypto.createHash('sha256').update(raw).digest();
}

/** @param {string} plaintext */
export function seal(plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return ['v1', iv, cipher.getAuthTag(), body]
    .map((p) => (typeof p === 'string' ? p : p.toString('base64')))
    .join(':');
}

/** @param {string} sealed */
export function open(sealed) {
  const [version, iv, tag, body] = String(sealed).split(':');
  if (version !== 'v1' || body === undefined) throw new Error('Unrecognised sealed value');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  try {
    return Buffer.concat([decipher.update(Buffer.from(body, 'base64')), decipher.final()]).toString('utf8');
  } catch {
    // GCM fails closed on a wrong key or a tampered row; say which is likelier.
    throw new Error('Stored credentials could not be decrypted; was CREDENTIALS_KEY changed?');
  }
}
