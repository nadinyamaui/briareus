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

// Webhooks: the app being told, instead of the app asking.
//
// GitHub's deliveries start no work. Every session this app runs is started
// by somebody pressing a button; what a delivery buys is freshness: the pull
// request panel of an open session keeps up with the reviews, comments and CI
// runs landing on its branch, instead of waiting out the twenty-second sync
// tick.
//
// A session's own webhook is the exception, and on purpose: it is how a system
// outside the app (a support platform, an alerting tool, a CI) wakes one
// conversation up with a message, reopening it if it had let go of its
// workspace. It is off until the session's operator arms it, and what arrives
// is handed over as information, never as the operator's word (see
// deliverToSession in lib/jobs.js, and lib/deliveries.js).
//
// It has a second route, /instructions, for the operator's own word sent from
// outside the dashboard: a messaging bridge that decides, by who wrote a
// message, whether it goes here or to the first one. It has a key of its own
// and is off until the operator turns it on, and what it delivers goes to the
// agent as if typed in the dashboard (instructSession in lib/jobs.js).
//
// These routes are the only ones on the app that a stranger can reach
// (Cloudflare Access has to be told to bypass them, since nobody at GitHub can
// log into your Access account), so each authenticates its sender itself:
// GitHub signs every delivery with HMAC-SHA256 over the raw body
// (X-Hub-Signature-256), keyed with a secret this app generates and installs on
// the repository itself; a session webhook is signed with that session's own
// key (see sessionWebhookKey), over the time it was sent and the raw body.
//
// The secrets live in `app_settings`, generated on first use: nothing to paste
// anywhere, and nothing that has to survive in .env.

function log(message) {
  console.log(`webhooks: ${message}`);
}

// ---------------------------------------------------------------------------
// the router
// ---------------------------------------------------------------------------

// The handler answers before it does the work. GitHub gives a delivery ten
// seconds and marks anything slower as failed. A review that takes minutes
// must not look like a failed delivery, so the work is started and the
// response goes out immediately.
function accept(res, body = { ok: true }) {
  if (!res.headersSent) res.status(202).json(body);
}

// A session id is a few letters and digits (lib/jobs.js). Anything else is no
// session's, and is answered like a wrong key before anything reads it:
// decoded from the URL, it could carry a line break into the log.
const SESSION_ID = /^[\w-]{1,64}$/;

export function webhookRouter() {
  const router = express.Router();
  // Raw, because a signature over a re-serialized body is a signature over
  // something the sender never sent. Each route reads as much as its sender
  // has any reason to post, and both read it before they know who is asking.
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
    // A signed delivery is the proof the hook reaches this install, which,
    // with a hook installRepoWebhooks found carrying every event, is what lets
    // the sync timer slow down for the repository (lib/jobs.js).
    noteWebhookDelivery((payload.repository || {}).full_name);
    if (event === 'ping') {
      log(`ping from ${(payload.repository || {}).full_name || 'GitHub'}: the hook is live`);
      return res.json({ ok: true, pong: true });
    }
    accept(res);
    handleGithubEvent(event, payload).catch((e) => log(`${event}: ${e.message}`));
  });

  // The two routes differ in the key they check and in what the delivery is
  // to the agent: information from outside (deliverToSession), or the
  // operator's word (instructSession).
  const sessionRoute = (channel, intake) => async (req, res) => {
    const id = req.params.id;
    const route = channel === 'instructions' ? `/session/${id}/instructions` : `/session/${id}`;
    if (!SESSION_ID.test(id)) return res.status(401).json({ error: 'Bad signature' });
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');
    // The key is derived from the id, so any id has one: a wrong key answers
    // the same 401 whether the session exists or not, and the route tells a
    // stranger nothing about which ids are real, or which of them are armed.
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
      // A sender that names its deliveries is deduplicated on the name. One
      // that does not is still caught sending the same signed bytes twice.
      const outcome = intake(id, { ...delivery, id: delivery.id || proof.signed });
      log(
        `session ${id} ← ${channel === 'instructions' ? 'an instruction from ' : ''}${delivery.source || 'a sender'} (${delivery.text.length} chars, ${outcome.status})`,
      );
      // Only what the sender needs to know it landed: whether it runs now, is
      // held until the session is free, or had been taken already.
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

// Compared as bytes: timingSafeEqual throws on buffers of different lengths,
// and a header can hold as many characters as the secret and still be longer
// in bytes (Node reads header bytes as latin1, so one "é" is one character
// and two bytes). Measured in characters, that request was a 500.
function sameSecret(given, expected) {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// ---------------------------------------------------------------------------
// session webhooks
// ---------------------------------------------------------------------------

// Two ways to prove the sender holds the session's key. The signature is the
// one to prefer: the key never travels, and because it covers the time it was
// made (X-Briareus-Timestamp, in seconds) as well as the body, a request
// somebody captured is worth nothing a few minutes later. The bearer is for
// the many alerting tools and no-code senders that can set a header but cannot
// compute an HMAC; a leaked one opens this one session and no other, until its
// key is rotated.
//
// `signed` names the signed bytes, for a sender that did not name its
// delivery: the same ones twice are a retry or a replay, and one delivery
// either way.
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
    // A push, a label, a review posted, a comment written, CI finishing:
    // nothing to start, but every session mirroring that branch is now showing
    // a stale panel.
    case 'pull_request':
    case 'pull_request_review':
    case 'pull_request_review_comment':
      syncSessionsOn(repo, branchOf(payload.pull_request));
      break;
    case 'issue_comment':
      // Issue comments carry no branch, and the number is enough to find the
      // sessions working on that pull request.
      syncSessionsOn(repo, null, (payload.issue || {}).number);
      break;
    // CI moves without touching the pull request (a re-run on the same head);
    // a nudge reads the checks whatever the pull request says.
    case 'check_suite':
      syncSessionsOn(repo, (payload.check_suite || {}).head_branch);
      break;
    case 'check_run':
      syncSessionsOn(repo, ((payload.check_run || {}).check_suite || {}).head_branch);
      break;
    case 'status':
      // A CI that reports per stage posts a pending status for each as it
      // starts; only one reaching a result is worth a read, and the minute
      // tick a fresh head keeps (checksAwaited in lib/jobs.js) shows the rest.
      if (payload.state === 'pending') break;
      // A commit status names no branch either; the branches it belongs to are
      // in the payload when GitHub can work them out.
      for (const b of payload.branches || []) syncSessionsOn(repo, b.name);
      break;
    case 'push':
      // Pushes to a PR branch arrive as pull_request/synchronize too; this is
      // so an open session's panel keeps up with a branch that has no pull
      // request yet.
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

// The app installs its own hook on every repository it works on, and keeps it
// pointed at the current public hostname; the `repo` scope the token already
// needs for reviewing covers it. A token without hook rights, or a repository
// somebody else owns, leaves a line in the log and the sync tick in charge;
// nothing fails.
//
// Ours is recognised by URL, so an existing deploy hook on the same repository
// is never touched.
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
  // Only the events something here reacts to. `push` is deliberately absent: a
  // push to a PR branch arrives as pull_request/synchronize, and a push to
  // anything else is not this app's business. `status` is there for the CI
  // that reports through commit statuses (Jenkins, older CircleCI), which
  // sends no check_suite at all.
  const events = ['pull_request', 'pull_request_review', 'issue_comment', 'check_suite', 'status'];

  const listed = await githubRest(cfg, 'GET', `/repos/${repo}/hooks`);
  if (!listed.ok) {
    return {
      ok: false,
      reason: `GitHub answered ${listed.status} listing hooks; the token may not manage them`,
    };
  }
  const hooks = await listed.json();
  // Match on the path rather than the whole URL, so moving the app to a new
  // hostname updates the hook that is there instead of adding a second one.
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

  // Already there: only rewrite it when something it carries has drifted. The
  // secret is never returned, so it is always re-sent.
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

// Called at boot for every enabled project. Best effort by design: the sync
// tick is still there, so a repository this cannot reach shows a slightly
// staler panel rather than a broken one.
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
