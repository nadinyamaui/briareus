// @ts-check
// The one slice of GitHub access a dev session needs: authenticated REST
// calls, used to mirror the session branch's PR state and CI checks, and to say
// on that PR what the app is doing to it. Rate limiting is still handled here
// so a 403/429 backs off instead of hammering.

import { execFile } from 'child_process';

const rate = {
  core: { remaining: null, limit: null, resetAt: null },
  graphql: { remaining: null, limit: null, resetAt: null },
  cooldownUntil: { core: 0, graphql: 0 },
};

class GithubError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
    /** Set when the failure is a rate limit and worth backing off from. */
    this.rateLimited = false;
    /** @type {number|null} epoch ms when the limit resets. */
    this.retryAt = null;
    /** @type {string|null} which budget was exhausted ('core' or 'graphql'). */
    this.resource = null;
    /** @type {Array<{message: string, type?: string}>|null} a GraphQL answer's own errors. */
    this.errors = null;
    /** @type {any} what a partly-failed GraphQL query did resolve. */
    this.data = null;
  }
}

function recordRateHeaders(res, fallbackResource) {
  const resource = res.headers.get('x-ratelimit-resource') || fallbackResource;
  const bucket = rate[resource];
  if (!bucket) return fallbackResource;
  const remaining = Number(res.headers.get('x-ratelimit-remaining'));
  const limit = Number(res.headers.get('x-ratelimit-limit'));
  const reset = Number(res.headers.get('x-ratelimit-reset'));
  if (Number.isFinite(remaining)) bucket.remaining = remaining;
  if (Number.isFinite(limit) && limit) bucket.limit = limit;
  if (Number.isFinite(reset) && reset) bucket.resetAt = reset * 1000;
  return resource;
}

// Both callers have already established when the limit lifts (checkCooldown
// off a running cooldown, handleLimitResponse off the headers) so retryAt is
// always a real time here.
//
// The instant is spelled as ISO 8601 UTC rather than a locale wall-clock time:
// a message read next to a UTC log (or by a worker in another timezone) must
// carry its own date and offset, not just a bare time that only means something
// next to the server's local clock.
function rateLimitedError(resource, retryAt) {
  const until = new Date(retryAt).toISOString();
  const err = new GithubError(`GitHub ${resource} rate limit exhausted, backing off until ${until}`, 429);
  err.rateLimited = true;
  err.retryAt = retryAt;
  err.resource = resource;
  return err;
}

function checkCooldown(resource) {
  const until = rate.cooldownUntil[resource];
  if (!until) return;
  if (Date.now() < until) throw rateLimitedError(resource, until);
  rate.cooldownUntil[resource] = 0;
}

// A 403/429 is only a rate limit when it carries Retry-After (secondary limit)
// or an exhausted primary budget; a plain 403 (missing scopes) must fall
// through to the caller's normal error path.
function handleLimitResponse(res, resource) {
  if (res.status !== 403 && res.status !== 429) return;
  const retryAfter = Number(res.headers.get('retry-after'));
  let retryAt = null;
  if (Number.isFinite(retryAfter) && retryAfter > 0) retryAt = Date.now() + retryAfter * 1000;
  // recordRateHeaders only ever names a bucket that exists, so this is a lookup
  // rather than a search.
  else if (String(res.headers.get('x-ratelimit-remaining')) === '0' && rate[resource].resetAt) {
    retryAt = rate[resource].resetAt;
  }
  if (!retryAt) return;
  rate.cooldownUntil[resource] = retryAt + 5000; // margin so the first retry lands past the reset
  throw rateLimitedError(resource, rate.cooldownUntil[resource]);
}

// ---------------------------------------------------------------------------
// pull request comments
// ---------------------------------------------------------------------------

// A PR's conversation comments, capped at three pages: the same ceiling the
// findings reader uses, for the same reason: a pull request past 300 comments
// is not a case worth paginating forever.
async function issueComments(cfg, repo, prNumber) {
  const out = [];
  for (let page = 1; page <= 3; page++) {
    const res = await githubRest(
      cfg,
      'GET',
      `/repos/${repo}/issues/${prNumber}/comments?per_page=100&page=${page}`,
    );
    if (!res.ok)
      throw new GithubError(`GitHub answered ${res.status} listing ${repo}#${prNumber} comments`, res.status);
    const rows = await res.json();
    out.push(...rows);
    if (rows.length < 100) break;
  }
  return out;
}

// Say `body` on a pull request, replacing whatever the app said last under the
// same `anchor`, an HTML comment nobody sees. A notice the app repeats (it
// reviews every push) then leaves one live comment on the PR instead of one per
// push. Pass no anchor to just post.
export async function upsertPrComment(cfg, repo, prNumber, anchor, body) {
  const existing = anchor
    ? [...(await issueComments(cfg, repo, prNumber))]
        .reverse()
        .find((c) => String(c.body || '').includes(anchor))
    : null;
  const res = existing
    ? await githubRest(cfg, 'PATCH', `/repos/${repo}/issues/comments/${existing.id}`, { body })
    : await githubRest(cfg, 'POST', `/repos/${repo}/issues/${prNumber}/comments`, { body });
  if (!res.ok)
    throw new GithubError(`GitHub answered ${res.status} commenting on ${repo}#${prNumber}`, res.status);
  return res.json();
}

// ---------------------------------------------------------------------------
// branch listing (the composer's branch picker)
// ---------------------------------------------------------------------------

// The picker is opened every time the project dropdown changes, so a short
// cache keeps a burst of switches down to one round trip per repo.
const branchCache = new Map(); // repo -> { at, value }
const BRANCH_TTL_MS = 60000;

// The branches a new session can start from, default branch first. The REST API
// is used when a token is configured (it is fast and needs no local git
// credentials) and `git ls-remote` covers the machine that has no token.
export async function listRepoBranches(cfg, repoFull) {
  const cached = branchCache.get(repoFull);
  if (cached && Date.now() - cached.at < BRANCH_TTL_MS) return cached.value;
  let result;
  if (cfg.githubToken) {
    try {
      result = await branchesViaApi(cfg, repoFull);
    } catch {
      /* a missing scope or a rate limit should not kill the picker */
    }
  }
  if (!result) result = await branchesViaLsRemote(repoFull);
  result = sortBranches(result);
  branchCache.set(repoFull, { at: Date.now(), value: result });
  return result;
}

function sortBranches({ defaultBranch, branches }) {
  const rest = branches.filter((b) => b !== defaultBranch).sort((a, b) => a.localeCompare(b));
  return { defaultBranch, branches: defaultBranch ? [defaultBranch, ...rest] : rest };
}

async function branchesViaApi(cfg, repoFull) {
  const info = await githubRest(cfg, 'GET', `/repos/${repoFull}`);
  if (!info.ok) throw new GithubError(`GitHub answered ${info.status} for ${repoFull}`, info.status);
  const { default_branch: defaultBranch } = await info.json();
  const branches = [];
  // Capped: a repo with thousands of branches would not make a usable dropdown
  // anyway, and the pages are one request each.
  for (let page = 1; page <= 5; page++) {
    const res = await githubRest(cfg, 'GET', `/repos/${repoFull}/branches?per_page=100&page=${page}`);
    if (!res.ok)
      throw new GithubError(`GitHub answered ${res.status} listing ${repoFull} branches`, res.status);
    const rows = await res.json();
    branches.push(...rows.map((b) => b.name));
    if (rows.length < 100) break;
  }
  return { defaultBranch: defaultBranch || null, branches };
}

function branchesViaLsRemote(repoFull) {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      ['ls-remote', '--symref', `https://github.com/${repoFull}.git`, 'HEAD', 'refs/heads/*'],
      // GIT_TERMINAL_PROMPT=0: on a machine whose credential helper cannot
      // answer, fail fast instead of hanging the request on a prompt nobody
      // can see.
      { timeout: 30000, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } },
      (err, stdout) => {
        if (err) return reject(new Error(`Could not list branches for ${repoFull}: ${err.message}`));
        const text = String(stdout);
        const defaultBranch = (text.match(/^ref:\s+refs\/heads\/(\S+)\s+HEAD$/m) || [])[1] || null;
        const branches = [...text.matchAll(/^\S+\s+refs\/heads\/(\S+)$/gm)].map((m) => m[1]);
        resolve({ defaultBranch, branches });
      },
    );
  });
}

// The GraphQL endpoint. Its rate budget is separate from core, so it gets its
// own bucket. Used only where REST has no answer (a PR's linked issues).
export async function githubGraphql(cfg, query, variables) {
  checkCooldown('graphql');
  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${cfg.githubToken}`,
      'Content-Type': 'application/json',
      'User-Agent': 'claude-pr-reviewer',
    },
    body: JSON.stringify({ query, variables }),
  });
  const resource = recordRateHeaders(res, 'graphql');
  handleLimitResponse(res, resource);
  if (!res.ok) throw new GithubError(`GitHub GraphQL answered ${res.status}`, res.status);
  const payload = await res.json();
  if (payload.errors && payload.errors.length) {
    const err = new GithubError(payload.errors.map((e) => e.message).join('; '), res.status);
    // GraphQL answers a query whose *parts* failed (a field the token may not
    // read, most often) with those errors and whatever else it could resolve.
    // The failure is still the caller's to decide about, so this stays a throw;
    // what came back rides along for a caller that can carry on without the
    // piece it lost (lib/prboard.js does, for the issues).
    err.errors = payload.errors;
    err.data = payload.data || null;
    throw err;
  }
  return payload.data;
}

export async function githubRest(cfg, method, url, body) {
  checkCooldown('core');
  const res = await fetch(`https://api.github.com${url}`, {
    method,
    headers: {
      Authorization: `Bearer ${cfg.githubToken}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'User-Agent': 'claude-pr-reviewer',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const resource = recordRateHeaders(res, 'core');
  handleLimitResponse(res, resource);
  return res;
}
