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
// boot, and every session's webhook key changes with it. One session's key is
// rotated from its ⚡ Webhook dialog, without touching the row.

const SETTINGS_KEY = 'webhooks';

let cached = null;
let reading = null;

// Callers that arrive while the first read is still out wait for that read.
// Each minting secrets of its own would leave a key shown in the dashboard, or
// the secret installed on a repository, that the row never kept. A read that
// failed is not held on to, so the next caller tries again.
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
//
// The epoch is what rotating one session's key raises (it rides on the
// session's record): a key that leaked stops working, and no other session's
// changes. A session id carries no colon (the route sees to that), so no id
// reads as another id's epoch.
//
// A session has two webhooks, and each its own key: `messages` for what
// somebody else wrote (a customer, an alert), `instructions` for what the
// operator sends from outside the dashboard. The names differ in their first
// word, so the key to one never opens the other: a sender handed the messages
// key cannot speak for the operator.
export async function sessionWebhookKey(id, epoch = 0, channel = 'messages') {
  const { sessions } = await webhookSecrets();
  const prefix = channel === 'instructions' ? 'instructions' : 'session';
  const name = epoch ? `${prefix}:${id}:${epoch}` : `${prefix}:${id}`;
  return crypto.createHmac('sha256', sessions).update(name).digest('hex');
}

// Unlike GitHub's hook, a session's webhook is also for senders on this
// machine or this network (a local CI, n8n, a cron script), so the URL hangs
// off whatever origin is configured, reachable from the internet or not.
export function sessionWebhookUrl(id, channel = 'messages') {
  const url = `${getConfig().publicBaseUrl}/webhooks/session/${encodeURIComponent(id)}`;
  return channel === 'instructions' ? `${url}/instructions` : url;
}
