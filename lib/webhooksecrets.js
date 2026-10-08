// @ts-check
import crypto from 'crypto';
import { getConfig } from './config.js';
import { loadAppSetting, saveAppSetting } from './db.js';

// Where the webhook sender delivers and the secret it authenticates with; its own module
// so lib/webhooks.js and the hook installer share it without an import cycle.
//
// Secrets are generated on first use and kept in `app_settings`. Delete the `webhooks`
// row to rotate them: the GitHub hook is rewritten at next boot and every session's key
// changes. One session's key rotates from its Webhook dialog.

const SETTINGS_KEY = 'webhooks';

let cached = null;
let reading = null;

// Concurrent first callers share one read; each minting its own would leave a shown key or
// installed secret the row never kept. A failed read is not cached, so the next retries.
export function webhookSecrets() {
  if (cached) return Promise.resolve(cached);
  reading ??= readSecrets().finally(() => {
    reading = null;
  });
  return reading;
}

async function readSecrets() {
  const stored = await loadAppSetting(SETTINGS_KEY, null);
  const next = {
    github: (stored && stored.github) || crypto.randomBytes(32).toString('hex'),
    sessions: (stored && stored.sessions) || crypto.randomBytes(32).toString('hex'),
  };
  // An older row has only the GitHub secret; it gains the second without changing the
  // first under the installed hook.
  if (!stored || stored.github !== next.github || stored.sessions !== next.sessions) {
    await saveAppSetting(SETTINGS_KEY, next);
  }
  cached = next;
  return cached;
}

// The public origin, only if a webhook sender can reach it: GitHub requires https and
// cannot resolve .test or localhost. Empty means no hook; sessions sync on the timer.
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

// A session's webhook key, derived rather than stored: HMAC of the master secret over the
// session id, so one session's key opens no other and there is no per-session row. The
// epoch (on the session record) is raised to rotate a leaked key. Session ids carry no
// colon, so no id reads as another's epoch. Each session has two webhooks with separate
// keys, `messages` (third parties) and `instructions` (the operator); their names differ
// in the first word so a messages key can never speak for the operator.
export async function sessionWebhookKey(id, epoch = 0, channel = 'messages') {
  const { sessions } = await webhookSecrets();
  const prefix = channel === 'instructions' ? 'instructions' : 'session';
  const name = epoch ? `${prefix}:${id}:${epoch}` : `${prefix}:${id}`;
  return crypto.createHmac('sha256', sessions).update(name).digest('hex');
}

// Unlike GitHub's hook, a session webhook also serves local senders (CI, n8n, cron), so
// the URL uses whatever origin is configured, reachable from the internet or not.
export function sessionWebhookUrl(id, channel = 'messages') {
  const url = `${getConfig().publicBaseUrl}/webhooks/session/${encodeURIComponent(id)}`;
  return channel === 'instructions' ? `${url}/instructions` : url;
}
