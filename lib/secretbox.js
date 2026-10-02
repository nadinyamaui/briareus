// @ts-check
import crypto from 'crypto';
import { getConfig } from './config.js';

// Encryption at rest for the credentials the server keeps for others to use
// (an SSH server's database login). AES-256-GCM under CREDENTIALS_KEY from
// .env, so a database dump or backup carries ciphertext and the key stays on
// the machine. The key is its own setting rather than one derived from
// AUTH_SECRET: rotating the token secret must not make every stored password
// unreadable.
//
// A sealed value is `v1:<iv>:<tag>:<ciphertext>`, base64 each; the version
// leaves room for a new format without guessing what an old row holds.

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
