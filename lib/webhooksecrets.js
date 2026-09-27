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
// The secrets are generated on first use and kept in `app_settings`: nothing
// to paste into .env, and nothing an operator has to invent. Delete the
// `webhooks` row to rotate them: the GitHub hook is rewritten at the next
// boot, and every session's webhook key changes with it.

const SETTINGS_KEY = 'webhooks';

let cached = null;

export async function webhookSecrets() {
  if (cached) return cached;
  const stored = await loadAppSetting(SETTINGS_KEY, null);
  const next = {
    github: (stored && stored.github) || crypto.randomBytes(32).toString('hex'),
    sessions: (stored && stored.sessions) || crypto.randomBytes(32).toString('hex'),
  };
  // A row from before session webhooks carries only the GitHub secret; it
  // gains the second one without the first changing under the installed hook.
  if (!stored || stored.github !== next.github || stored.sessions !== next.sessions) {
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

// A session's own webhook key, derived rather than stored: HMAC of the master
// secret over the session id. Handing one sender the key for one session gives
// it nothing on any other, and there is no per-session row to create, migrate
// or clean up when the session is deleted.
export async function sessionWebhookKey(id) {
  const { sessions } = await webhookSecrets();
  return crypto.createHmac('sha256', sessions).update(`session:${id}`).digest('hex');
}

// Unlike GitHub's hook, a session's webhook is also for senders on this
// machine or this network (a local CI, n8n, a cron script), so the URL hangs
// off whatever origin is configured, reachable from the internet or not.
export function sessionWebhookUrl(id) {
  return `${getConfig().publicBaseUrl}/webhooks/session/${encodeURIComponent(id)}`;
}
