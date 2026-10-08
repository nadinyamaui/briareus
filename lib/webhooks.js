// @ts-check
import crypto from 'crypto';
import express from 'express';
import {
  syncSessionsOn,
  noteWebhookDelivery,
  noteWebhookCurrent,
  getJob,
  deliverToSession,
  instructSession,
} from './jobs.js';
import { webhookSecrets, githubWebhookUrl, sessionWebhookKey } from './webhooksecrets.js';
import { readDelivery, deliveryId, SIGNATURE_TOLERANCE_S } from './deliveries.js';
import { localUpdater } from './local-update.js';

// Webhooks: the app being told, instead of the app asking.
//
// GitHub deliveries start no sessions; they keep open sessions' PR panels fresh between
// sync ticks. The one exception is a merged PR updating the project's local checkout,
// when the project asked for it (lib/local-update.js).
//
// A session's own webhook does wake a conversation: an outside system (support
// platform, alerting, CI) sends it a message. Off until armed, and its content is
// information, never the operator's word (deliverToSession in lib/jobs.js,
// lib/deliveries.js). Its /instructions route, with its own key and its own switch,
// carries the operator's word from a messaging bridge (instructSession in lib/jobs.js).
//
// These are the only routes a stranger can reach (Cloudflare Access must bypass them),
// so each authenticates its sender: GitHub by HMAC over the raw body with a secret this
// app installs, sessions by their own key (sessionWebhookKey) over timestamp and body.
// Secrets are generated on first use and stored in `app_settings`, not .env.

function log(message) {
  console.log(`webhooks: ${message}`);
}

// ---------------------------------------------------------------------------
// the router
// ---------------------------------------------------------------------------

// Answer before working: GitHub marks a delivery failed after ten seconds.
function accept(res, body = { ok: true }) {
  if (!res.headersSent) res.status(202).json(body);
}

// Anything else is answered like a wrong key before use: a URL-decoded id could
// inject a line break into the log.
const SESSION_ID = /^[\w-]{1,64}$/;

export function webhookRouter() {
  const router = express.Router();
  // Raw, since signatures cover the exact bytes sent. Limits are per sender, as bodies
  // are read before the sender is authenticated.
  const githubBody = express.raw({ type: () => true, limit: '5mb' });
  const sessionBody = express.raw({ type: () => true, limit: '256kb' });

  router.post('/github', githubBody, async (req, res) => {
    const { github } = await webhookSecrets();
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');
    if (!verifyGithubSignature(raw, req.get('X-Hub-Signature-256'), github)) {
      log(`rejected a /github delivery with a bad signature (${req.ip})`);
      return res.status(401).json({ error: 'Bad signature' });
    }
    let payload;
    try {
      payload = JSON.parse(raw.toString('utf8'));
    } catch {
      return res.status(400).json({ error: 'Body is not JSON' });
    }
    const event = req.get('X-GitHub-Event') || '';
    // Proof the hook reaches us; with a current hook this lets the sync timer slow
    // down for the repo (lib/jobs.js).
    noteWebhookDelivery((payload.repository || {}).full_name);
    if (event === 'ping') {
      log(`ping from ${(payload.repository || {}).full_name || 'GitHub'}: the hook is live`);
      return res.json({ ok: true, pong: true });
    }
    accept(res);
    handleGithubEvent(event, payload).catch((e) => log(`${event}: ${e.message}`));
  });

  // The routes differ in key and in what the delivery is: outside information
  // (deliverToSession) or the operator's word (instructSession).
  const sessionRoute = (channel, intake) => async (req, res) => {
    const id = req.params.id;
    const route = channel === 'instructions' ? `/session/${id}/instructions` : `/session/${id}`;
    if (!SESSION_ID.test(id)) return res.status(401).json({ error: 'Bad signature' });
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');
    // Every id derives a key, so the same 401 reveals nothing about which ids exist
    // or are armed.
    const job = getJob(id);
    const key = await sessionWebhookKey(id, (job && job.webhook && job.webhook.epoch) || 0, channel);
    const proof = verifySessionSender(raw, req, key);
    if (!proof.ok) {
      log(`rejected a ${route} delivery: ${proof.error} (${req.ip})`);
      return res.status(401).json({ error: proof.error });
    }
    const delivery = readDelivery(raw, req.get('Content-Type'), {
      source: req.get('X-Briareus-Source'),
      id: req.get('X-Briareus-Delivery'),
    });
    if ('error' in delivery) return res.status(delivery.status).json({ error: delivery.error });
    try {
      // Dedupe on the sender's delivery id, else on the signed bytes.
      const outcome = intake(id, { ...delivery, id: delivery.id || proof.signed });
      log(
        `session ${id} ← ${channel === 'instructions' ? 'an instruction from ' : ''}${delivery.source || 'a sender'} (${delivery.text.length} chars, ${outcome.status})`,
      );
      // Tell the sender only whether it runs now, is held, or was a duplicate.
      res.status(outcome.status === 'duplicate' ? 200 : 202).json({ ok: true, ...outcome });
    } catch (e) {
      if (e.retryAfter) res.set('Retry-After', String(e.retryAfter));
      res.status(e.status || 409).json({ error: e.message });
    }
  };
  router.post('/session/:id', sessionBody, sessionRoute('messages', deliverToSession));
  router.post('/session/:id/instructions', sessionBody, sessionRoute('instructions', instructSession));

  return router;
}

function verifyGithubSignature(raw, header, secret) {
  if (!header || !header.startsWith('sha256=')) return false;
  const expected = `sha256=${crypto.createHmac('sha256', secret).update(raw).digest('hex')}`;
  return sameSecret(header, expected);
}

// Length-checked in bytes, not characters: timingSafeEqual throws on unequal lengths,
// and a non-ASCII header can match in characters but not bytes (a 500 otherwise).
function sameSecret(given, expected) {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// ---------------------------------------------------------------------------
// session webhooks
// ---------------------------------------------------------------------------

// Two proofs of the session key. Preferred is an HMAC over X-Briareus-Timestamp and the
// body, so the key never travels and captures expire. The bearer is for senders that
// cannot compute an HMAC; a leaked one opens only this session until rotated.
//
// `signed` identifies the signed bytes, deduplicating retries and replays of unnamed
// deliveries.
function verifySessionSender(raw, req, key, now = Date.now()) {
  const refused = { ok: false, error: 'Bad signature', signed: null };
  const signature = req.get('X-Briareus-Signature-256');
  if (signature) {
    const stamp = req.get('X-Briareus-Timestamp') || '';
    if (!signature.startsWith('sha256=') || !/^\d{1,12}$/.test(stamp)) return refused;
    const hmac = crypto.createHmac('sha256', key).update(`${stamp}.`).update(raw).digest('hex');
    if (!sameSecret(signature, `sha256=${hmac}`)) return refused;
    // Said only to a sender that holds the key, whose clock is what is wrong.
    if (Math.abs(now / 1000 - Number(stamp)) > SIGNATURE_TOLERANCE_S)
      return { ...refused, error: 'Timestamp too far from the clock here' };
    return { ok: true, error: '', signed: deliveryId(hmac) };
  }
  const bearer = /^Bearer\s+(\S+)$/i.exec(req.get('Authorization') || '');
  return bearer && sameSecret(bearer[1], key) ? { ok: true, error: '', signed: null } : refused;
}

// ---------------------------------------------------------------------------
// what each GitHub event means here
// ---------------------------------------------------------------------------

async function handleGithubEvent(event, payload) {
  const repo = (payload.repository || {}).full_name || '';
  if (!repo) return;

  switch (event) {
    // Nothing to start, but sessions on that branch now show a stale panel.
    case 'pull_request': {
      syncSessionsOn(repo, branchOf(payload.pull_request));
      const pr = payload.pull_request || {};
      if (payload.action === 'closed' && pr.merged) {
        localUpdater().onMerged(repo, { base: (pr.base || {}).ref || '', prNumber: pr.number });
      }
      break;
    }
    case 'pull_request_review':
    case 'pull_request_review_comment':
      syncSessionsOn(repo, branchOf(payload.pull_request));
      break;
    case 'issue_comment':
      // Issue comments carry no branch; the PR number finds the sessions.
      syncSessionsOn(repo, null, (payload.issue || {}).number);
      break;
    // CI can move without touching the PR (a re-run on the same head).
    case 'check_suite':
      syncSessionsOn(repo, (payload.check_suite || {}).head_branch);
      break;
    case 'check_run':
      syncSessionsOn(repo, ((payload.check_run || {}).check_suite || {}).head_branch);
      break;
    case 'status':
      // Per-stage pending statuses are noise; checksAwaited in lib/jobs.js covers them.
      if (payload.state === 'pending') break;
      // Statuses name no branch; GitHub lists the branches when it can.
      for (const b of payload.branches || []) syncSessionsOn(repo, b.name);
      break;
    case 'push':
      // For branches with no PR yet; PR branches also get pull_request/synchronize.
      syncSessionsOn(repo, String(payload.ref || '').replace(/^refs\/heads\//, ''));
      break;
    default:
      break; // everything else is subscribed to by nobody here
  }
}

function branchOf(pr) {
  return pr && pr.head ? pr.head.ref : null;
}

// ---------------------------------------------------------------------------
// installing the GitHub hook
// ---------------------------------------------------------------------------

// Installs or updates this app's hook on a repo (the token's `repo` scope covers it).
// Without hook rights it only logs and the sync tick stays in charge. Ours is found by
// URL, so other hooks on the repo are never touched.
export async function ensureRepoWebhook(cfg, repo, githubRest) {
  const url = githubWebhookUrl();
  if (!url) return { ok: false, reason: 'no public https hostname (PUBLIC_BASE_URL)' };
  const { github } = await webhookSecrets();
  const config = {
    url,
    content_type: 'json',
    secret: github,
    insecure_ssl: '0',
  };
  // `push` is deliberately absent (PR pushes arrive as pull_request/synchronize);
  // `status` is for CI that reports via commit statuses and sends no check_suite.
  const events = ['pull_request', 'pull_request_review', 'issue_comment', 'check_suite', 'status'];

  const listed = await githubRest(cfg, 'GET', `/repos/${repo}/hooks`);
  if (!listed.ok) {
    return {
      ok: false,
      reason: `GitHub answered ${listed.status} listing hooks; the token may not manage them`,
    };
  }
  const hooks = await listed.json();
  // Match on path so a hostname change updates the hook instead of adding another.
  const mine = hooks.find((h) => String((h.config || {}).url || '').endsWith('/webhooks/github'));

  if (!mine) {
    const created = await githubRest(cfg, 'POST', `/repos/${repo}/hooks`, {
      name: 'web',
      active: true,
      events,
      config,
    });
    if (!created.ok) {
      return { ok: false, reason: `GitHub answered ${created.status} creating the hook` };
    }
    return { ok: true, action: 'created', url };
  }

  // Rewrite only on drift; the secret is never returned, so it is always re-sent.
  const sameUrl = (mine.config || {}).url === url;
  const sameEvents =
    events.every((e) => (mine.events || []).includes(e)) && (mine.events || []).length === events.length;
  if (sameUrl && sameEvents && mine.active) return { ok: true, action: 'unchanged', url };

  const patched = await githubRest(cfg, 'PATCH', `/repos/${repo}/hooks/${mine.id}`, {
    active: true,
    events,
    config,
  });
  if (!patched.ok) return { ok: false, reason: `GitHub answered ${patched.status} updating the hook` };
  return { ok: true, action: 'updated', url };
}

// Called at boot for every enabled project. Best effort: the sync tick covers failures.
export async function installRepoWebhooks(projects, cfg, githubRest) {
  if (!githubWebhookUrl()) {
    return log('no public https hostname configured (PUBLIC_BASE_URL); sessions sync on the timer alone');
  }
  if (!cfg.githubToken) return log('no GitHub token; sessions sync on the timer alone');
  for (const project of projects) {
    try {
      const res = await ensureRepoWebhook(cfg, project.repo, githubRest);
      // Only a hook carrying every event lets the sync timer slow down there.
      if (res.ok) noteWebhookCurrent(project.repo);
      if (res.ok && res.action !== 'unchanged') log(`${project.repo}: hook ${res.action} → ${res.url}`);
      else if (!res.ok) log(`${project.repo}: ${res.reason}, falling back to the sync timer`);
    } catch (e) {
      log(`${project.repo}: ${e.message}, falling back to the sync timer`);
    }
  }
}
