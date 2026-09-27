// @ts-check
import crypto from 'crypto';
import express from 'express';
import { syncSessionsOn, noteWebhookDelivery, noteWebhookCurrent, sendDevMessage } from './jobs.js';
import { webhookSecrets, githubWebhookUrl, sessionWebhookKey } from './webhooksecrets.js';

// Webhooks: the app being told, instead of the app asking.
//
// GitHub's deliveries start no work. Every session this app runs is started
// by somebody pressing a button; what a delivery buys is freshness: the pull
// request panel of an open session keeps up with the reviews, comments and CI
// runs landing on its branch, instead of waiting out the twenty-second sync
// tick.
//
// A session's own webhook is the exception, and on purpose: it is how a system
// outside the app (a CI, an alerting tool, a script) wakes one conversation up
// with a message, reopening it if it had let go of its workspace.
//
// These routes are the only ones on the app that a stranger can reach
// (Cloudflare Access has to be told to bypass them, since nobody at GitHub can
// log into your Access account), so each authenticates its sender itself:
// GitHub signs every delivery with HMAC-SHA256 over the raw body
// (X-Hub-Signature-256), keyed with a secret this app generates and installs on
// the repository itself; a session webhook is signed the same way with that
// session's own key (see sessionWebhookKey).
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

export function webhookRouter() {
  const router = express.Router();
  // Raw, because a signature over a re-serialized body is a signature over
  // something GitHub never sent.
  router.use(express.raw({ type: () => true, limit: '5mb' }));

  router.post('/github', async (req, res) => {
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

  router.post('/session/:id', async (req, res) => {
    const id = req.params.id;
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');
    // The key is derived from the id, so any id has one: a wrong key answers
    // the same 401 whether the session exists or not, and the route tells a
    // stranger nothing about which ids are real.
    const key = await sessionWebhookKey(id);
    if (!verifySessionSender(raw, req, key)) {
      log(`rejected a /session/${id} delivery with a bad signature (${req.ip})`);
      return res.status(401).json({ error: 'Bad signature' });
    }
    const delivery = readSessionDelivery(raw, req.get('Content-Type'), req.get('X-Briareus-Source'));
    if (delivery.error) return res.status(delivery.status).json({ error: delivery.error });
    try {
      const session = sendDevMessage(id, delivery.message, undefined, undefined, { unattended: true });
      log(
        `session ${id} ← ${delivery.source || 'a sender'} (${delivery.text.length} chars, ${session.status})`,
      );
      // Only what the sender needs to know it landed: the status says
      // whether it runs now or waits behind a turn in flight.
      res.status(202).json({ ok: true, status: session.status });
    } catch (e) {
      const status = e.message === 'Session not found' ? 404 : 409;
      res.status(status).json({ error: e.message });
    }
  });

  return router;
}

function verifyGithubSignature(raw, header, secret) {
  if (!header || !header.startsWith('sha256=')) return false;
  const expected = `sha256=${crypto.createHmac('sha256', secret).update(raw).digest('hex')}`;
  return sameSecret(header, expected);
}

function sameSecret(given, expected) {
  if (given.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}

// ---------------------------------------------------------------------------
// session webhooks
// ---------------------------------------------------------------------------

// Two ways to prove the sender holds the session's key. The signature, as
// GitHub does it, is the one to prefer: the key never travels. The bearer is
// for the many alerting tools and no-code senders that can set a header but
// cannot compute an HMAC; a leaked one opens this one session and no other.
function verifySessionSender(raw, req, key) {
  const signature = req.get('X-Briareus-Signature-256');
  if (signature) {
    if (!signature.startsWith('sha256=')) return false;
    return sameSecret(signature, `sha256=${crypto.createHmac('sha256', key).update(raw).digest('hex')}`);
  }
  const bearer = /^Bearer\s+(\S+)$/i.exec(req.get('Authorization') || '');
  return !!bearer && sameSecret(bearer[1], key);
}

// Longer than any note a sender means an agent to read, short enough that a
// misconfigured sender posting whole logs cannot flood a conversation.
export const SESSION_WEBHOOK_MAX_CHARS = 20000;

// What a delivery says. A JSON body with a `text` string is the message (and
// its `source`, when given, who sent it); any other JSON is some tool's own
// payload, handed to the agent as it came; anything else is plain text.
export function readSessionDelivery(raw, contentType, sourceHeader) {
  const body = raw.toString('utf8');
  let text = body;
  let source = sourceHeader || '';
  if (/json/i.test(contentType || '')) {
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      return { status: 400, error: 'Body is not JSON' };
    }
    if (parsed && typeof parsed === 'object' && typeof parsed.text === 'string') {
      text = parsed.text;
      if (typeof parsed.source === 'string') source = source || parsed.source;
    } else text = JSON.stringify(parsed, null, 2);
  }
  text = text.trim();
  if (!text) return { status: 400, error: 'Empty message' };
  if (text.length > SESSION_WEBHOOK_MAX_CHARS)
    return { status: 413, error: `Message longer than ${SESSION_WEBHOOK_MAX_CHARS} characters` };
  // The sender names itself in a label the transcript shows; nothing in it can
  // pass for markup or run onto the text.
  source = source
    .replace(/[^\w .:/@-]/g, '')
    .trim()
    .slice(0, 60);
  // Said plainly, to the agent and in the transcript: nobody at the keyboard
  // wrote this, so it is information to weigh, not the user's instruction.
  const message = `Webhook delivery${source ? ` from ${source}` : ''}. An outside system sent this through the session's webhook; it was not typed by the user.\n\n${text}`;
  return { text, source, message };
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
