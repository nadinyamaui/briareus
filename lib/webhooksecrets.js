// @ts-check
import crypto from 'crypto';
import { getConfig } from './config.js';
import { loadAppSetting, saveAppSetting } from './db.js';

// Where the webhook sender delivers, and the secret it authenticates itself
// with.
//
// Its own module so lib/webhooks.js (which verifies what arrives) and the
// hook installer can share it without an import cycle.
//
// The secret is generated on first use and kept in `app_settings`: nothing
// to paste into .env, and nothing an operator has to invent. Delete the
// `webhooks` row to rotate it: the GitHub hook is rewritten at the next boot.

const SETTINGS_KEY = 'webhooks';

let cached = null;

export async function webhookSecrets() {
  if (cached) return cached;
  const stored = await loadAppSetting(SETTINGS_KEY, null);
  const next = {
    github: (stored && stored.github) || crypto.randomBytes(32).toString('hex'),
  };
  if (!stored || stored.github !== next.github) {
    await saveAppSetting(SETTINGS_KEY, next);
  }
  cached = next;
  return cached;
}

// The app's public origin, but only when it is one a webhook sender can
// actually reach: GitHub requires https, and it cannot resolve a .test
// hostname or localhost. Empty means "no hook, sessions sync on the timer".
export function webhookBase() {
  const url = getConfig().publicBaseUrl;
  if (!/^https:\/\//i.test(url)) return '';
  // The port goes too: `https://localhost:4300` is still localhost.
  const host = url
    .replace(/^https:\/\//i, '')
    .split('/')[0]
    .split(':')[0]
    .toLowerCase();
  const unreachable =
    host === 'localhost' ||
    host.startsWith('127.') ||
    host.endsWith('.test') ||
    host.endsWith('.local') ||
    host.endsWith('.localhost');
  return unreachable ? '' : url;
}

export function githubWebhookUrl() {
  const base = webhookBase();
  return base ? `${base}/webhooks/github` : '';
}
