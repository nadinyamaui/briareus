// @ts-check
// Authenticated GitHub REST/GraphQL calls for mirroring a session's PR state and
// checks and commenting on it, with rate-limit backoff so a 403/429 is not hammered.

import { execFile } from 'child_process';
import { childEnv } from './childenv.js';

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

// retryAt is always a real time here. ISO 8601 UTC so the message is unambiguous
// next to UTC logs or in another timezone.
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

// A PR's conversation comments, capped at three pages like the findings reader.
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

// Posts `body` on a PR, replacing the last comment containing `anchor` (a hidden
// HTML comment) so repeated notices leave one live comment. No anchor just posts.
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

// Pull requests use the issues label endpoint in GitHub's REST API. Adding a
// label is idempotent and preserves every label already on the pull request.
export async function addPullRequestLabel(cfg, repo, prNumber, label) {
  const res = await githubRest(cfg, 'POST', `/repos/${repo}/issues/${prNumber}/labels`, {
    labels: [label],
  });
  if (!res.ok)
    throw new GithubError(`GitHub answered ${res.status} adding ${label} to ${repo}#${prNumber}`, res.status);
  return res.json();
}

// A 404 means the label was already absent, which is the requested end state.
export async function removePullRequestLabel(cfg, repo, prNumber, label) {
  const res = await githubRest(
    cfg,
    'DELETE',
    `/repos/${repo}/issues/${prNumber}/labels/${encodeURIComponent(label)}`,
  );
  if (!res.ok && res.status !== 404) {
    throw new GithubError(
      `GitHub answered ${res.status} removing ${label} from ${repo}#${prNumber}`,
      res.status,
    );
  }
  return res.status === 404 ? [] : res.json();
}

// ---------------------------------------------------------------------------
// branch listing (the composer's branch picker)
// ---------------------------------------------------------------------------

// Short cache: the picker reloads on every project switch.
const branchCache = new Map(); // repo -> { at, value }
const BRANCH_TTL_MS = 60000;

// Branches a session can start from, default first. REST when a token is set,
// else `git ls-remote`.
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
  // Capped: thousands of branches would not make a usable dropdown anyway.
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
      // Fail fast instead of hanging on a credential prompt nobody can see.
      { timeout: 30000, maxBuffer: 8 * 1024 * 1024, env: childEnv({ GIT_TERMINAL_PROMPT: '0' }) },
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
    // A partly failed query still throws, but carries what did resolve for callers
    // that can carry on without the missing piece (lib/prboard.js does).
    err.errors = payload.errors;
    err.data = payload.data || null;
    throw err;
  }
  return payload.data;
}

// Conditional GETs: a 304 for If-None-Match does not count against the rate limit,
// so caching ETag and body makes the sync tick's repeated reads free. Opt-in per
// call (`{ conditional: true }`) for polled URLs only; keyed per token and URL.
const ETAG_CACHE_MAX = 500;
const etagCache = new Map(); // `${token}\n${url}` -> { etag, body }

function rememberEtag(key, etag, body) {
  // Re-insert so the map's order is recency, and drop the oldest past the cap.
  etagCache.delete(key);
  etagCache.set(key, { etag, body });
  if (etagCache.size > ETAG_CACHE_MAX) etagCache.delete(etagCache.keys().next().value);
}

// A Response-like answer when the cache took part, plus `notModified` and `etag` so
// a caller can tell whether the resource changed since its own last read. json()
// returns a copy so callers cannot mutate the cached body.
function cachedResponse(res, etag, body, notModified) {
  return {
    ok: true,
    status: 200,
    headers: res.headers,
    notModified,
    etag,
    json: async () => structuredClone(body),
  };
}

// `apiVersion` pins the X-GitHub-Api-Version a newer endpoint needs; without
// it GitHub answers in its default version.
export async function githubRest(cfg, method, url, body, { conditional = false, apiVersion = '' } = {}) {
  checkCooldown('core');
  const cacheKey = conditional && method === 'GET' ? `${cfg.githubToken}\n${url}` : null;
  const cached = cacheKey ? etagCache.get(cacheKey) : null;
  const headers = {
    Authorization: `Bearer ${cfg.githubToken}`,
    Accept: 'application/vnd.github+json',
    'Content-Type': 'application/json',
    'User-Agent': 'claude-pr-reviewer',
  };
  if (apiVersion) headers['X-GitHub-Api-Version'] = apiVersion;
  if (cached) headers['If-None-Match'] = cached.etag;
  const res = await fetch(`https://api.github.com${url}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const resource = recordRateHeaders(res, 'core');
  handleLimitResponse(res, resource);
  if (cached && res.status === 304) {
    rememberEtag(cacheKey, cached.etag, cached.body); // keep it recent
    return cachedResponse(res, cached.etag, cached.body, true);
  }
  if (cacheKey && res.ok) {
    const etag = res.headers.get('etag');
    if (etag) {
      const fresh = await res.json();
      rememberEtag(cacheKey, etag, fresh);
      return cachedResponse(res, etag, fresh, false);
    }
  }
  return res;
}

// The token's own GitHub login, so the app can tell the user's PRs from others'
// without a configured username. Cached per token.
const viewerCache = new Map(); // token -> login | null

export async function viewerLogin(cfg) {
  if (!cfg.githubToken) return null;
  if (viewerCache.has(cfg.githubToken)) return viewerCache.get(cfg.githubToken);
  let login = null;
  try {
    const res = await githubRest(cfg, 'GET', '/user');
    if (res.ok) {
      const user = await res.json();
      login = (user && user.login) || null;
    }
  } catch {
    // Unknown rather than failing the caller.
  }
  // Failures are cached too, to avoid a doomed request on every review.
  viewerCache.set(cfg.githubToken, login);
  return login;
}
