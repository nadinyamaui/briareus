// @ts-check
import crypto from 'crypto';
import express from 'express';
import { syncSessionsOn } from './jobs.js';
import { webhookSecrets, githubWebhookUrl } from './webhooksecrets.js';

// Webhooks: the app being told, instead of the app asking.
//
// Nothing here starts work. Every session this app runs is started by somebody
// pressing a button; what a delivery buys is freshness: the pull request panel
// of an open session keeps up with the reviews, comments and CI runs landing on
// its branch, instead of waiting out the twenty-second sync tick.
//
// This route is the only one on the app that a stranger can reach (Cloudflare
// Access has to be told to bypass it, since nobody at GitHub can log into your
// Access account), so it authenticates its sender itself: GitHub signs every
// delivery with HMAC-SHA256 over the raw body (X-Hub-Signature-256), keyed
// with a secret this app generates and installs on the repository itself.
//
// The secret lives in `app_settings`, generated on first use: nothing to paste
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
  router.use(express.raw({ type: '*/*', limit: '5mb' }));

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
    if (event === 'ping') {
      log(`ping from ${(payload.repository || {}).full_name || 'GitHub'}: the hook is live`);
      return res.json({ ok: true, pong: true });
    }
    accept(res);
    handleGithubEvent(event, payload).catch((e) => log(`${event}: ${e.message}`));
  });

  return router;
}

function verifyGithubSignature(raw, header, secret) {
  if (!header || !header.startsWith('sha256=')) return false;
  const expected = `sha256=${crypto.createHmac('sha256', secret).update(raw).digest('hex')}`;
  if (header.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(header), Buffer.from(expected));
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
    case 'check_suite':
      syncSessionsOn(repo, (payload.check_suite || {}).head_branch);
      break;
    case 'check_run':
      syncSessionsOn(repo, ((payload.check_run || {}).check_suite || {}).head_branch);
      break;
    case 'status':
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
  // anything else is not this app's business.
  const events = ['pull_request', 'pull_request_review', 'issue_comment', 'check_suite'];

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
      if (res.ok && res.action !== 'unchanged') log(`${project.repo}: hook ${res.action} → ${res.url}`);
      else if (!res.ok) log(`${project.repo}: ${res.reason}, falling back to the sync timer`);
    } catch (e) {
      log(`${project.repo}: ${e.message}, falling back to the sync timer`);
    }
  }
}
