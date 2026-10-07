// @ts-check
// On-demand PR content for the in-app viewer, and the merge it can confirm;
// separate from the board's polling payload.
import { getConfig } from './config.js';
import { githubRest } from './github.js';
import { checkFailed, restCheckRun, restCommitStatus } from './prboard.js';

const MERGE_METHODS = ['squash', 'merge', 'rebase'];
const MERGE_SETTING = {
  squash: 'allow_squash_merge',
  merge: 'allow_merge_commit',
  rebase: 'allow_rebase_merge',
};

// The merge methods the repository allows, in the viewer's order. GitHub omits allow_*
// for a token without enough repo permission (and the repo read may have failed); then
// offer every method and let GitHub's refusal explain, rather than hide Merge.
function mergeMethodsOf(repo) {
  const allowed = MERGE_METHODS.map((m) => repo?.[MERGE_SETTING[m]]);
  if (allowed.every((v) => v === undefined)) return [...MERGE_METHODS];
  return MERGE_METHODS.filter((_, i) => allowed[i]);
}

// The sections that are one page of a GitHub list each, 100 rows at a time: where GitHub
// keeps the list, and the row a client gets per entry. Bodies and hunks go out whole.
const LIST_SECTIONS = {
  commits: {
    // GitHub stops this list at 250 commits, however many the branch has.
    path: (number) => `/pulls/${number}/commits`,
    row: (c) => ({
      sha: c.sha,
      message: c.commit?.message || '',
      author: c.author?.login || c.commit?.author?.name || 'Unknown author',
      date: c.commit?.author?.date || null,
      url: c.html_url,
    }),
  },
  comments: {
    path: (number) => `/issues/${number}/comments`,
    row: (c) => ({
      id: c.id,
      author: c.user?.login || 'Unknown author',
      body: c.body || '',
      createdAt: c.created_at,
      updatedAt: c.updated_at,
      url: c.html_url,
    }),
  },
  reviews: {
    path: (number) => `/pulls/${number}/reviews`,
    row: (r) => ({
      id: r.id,
      author: r.user?.login || 'Unknown author',
      state: String(r.state || '').toLowerCase(),
      body: r.body || '',
      commitSha: r.commit_id || null,
      submittedAt: r.submitted_at || null,
      url: r.html_url,
    }),
  },
  'review-comments': {
    path: (number) => `/pulls/${number}/comments`,
    row: (c) => ({
      id: c.id,
      reviewId: c.pull_request_review_id ?? null,
      inReplyTo: c.in_reply_to_id ?? null,
      author: c.user?.login || 'Unknown author',
      body: c.body || '',
      path: c.path,
      // null once a later push moved the code the comment was written on.
      line: c.line ?? null,
      originalLine: c.original_line ?? null,
      side: c.side || null,
      diffHunk: c.diff_hunk || '',
      commitSha: c.commit_id || null,
      createdAt: c.created_at,
      updatedAt: c.updated_at,
      url: c.html_url,
    }),
  },
};

const fileRow = (f) => ({
  filename: f.filename,
  previousFilename: f.previous_filename || null,
  status: f.status,
  additions: f.additions,
  deletions: f.deletions,
  patch: f.patch ?? null,
  url: f.blob_url,
});

const PULL_SECTIONS = ['description', 'files', 'checks', ...Object.keys(LIST_SECTIONS)];

// The options /api/pr/view reads from its query.
export function pullRequestViewOptions(query) {
  return {
    section: String(query.section || 'description'),
    page: Number(query.page || 1),
    headSha: String(query.headSha || ''),
    baseSha: String(query.baseSha || ''),
  };
}

const camel = (name) => name.replace(/-(.)/g, (_, c) => c.toUpperCase());

export async function pullRequestView(project, number, options = {}) {
  const { section = 'description', page = 1, headSha = '', baseSha = '' } = options;
  if (!PULL_SECTIONS.includes(section))
    throw Object.assign(new Error('Unknown pull request section'), { status: 400 });
  if (!Number.isInteger(page) || page < 1 || page > 30)
    throw Object.assign(new Error(LIST_SECTIONS[section] ? 'Invalid page' : 'Invalid files page'), {
      status: 400,
    });
  const cfg = getConfig();
  if (!cfg.githubToken) throw Object.assign(new Error('No GITHUB_TOKEN is configured'), { status: 503 });
  const root = `/repos/${project.repo}`;
  async function read(path) {
    const res = await githubRest(cfg, 'GET', `${root}${path}`, undefined, { conditional: true });
    if (!res.ok) {
      const status = res.status === 404 || res.status === 403 ? res.status : 502;
      throw Object.assign(new Error(`GitHub answered ${res.status} reading the pull request ${section}`), {
        status,
      });
    }
    return res.json();
  }
  // Only the first, unpinned read needs merge settings; later reads are pinned to the PR
  // already held. A failed repository read must not break the viewer.
  const pinned = !!(headSha || baseSha);
  const [raw, repo] = await Promise.all([
    read(`/pulls/${number}`),
    pinned
      ? null
      : githubRest(cfg, 'GET', root, undefined, { conditional: true })
          .then((res) => (res.ok ? res.json() : null))
          .catch(() => null),
  ]);
  if ((headSha && raw.head.sha !== headSha) || (baseSha && raw.base.sha !== baseSha))
    throw Object.assign(new Error('This pull request changed. Refresh to load its latest revision.'), {
      status: 409,
    });
  const pr = {
    number: raw.number,
    title: raw.title,
    body: raw.body || '',
    url: raw.html_url,
    author: raw.user?.login || 'Unknown author',
    state: raw.merged ? 'merged' : raw.draft && raw.state === 'open' ? 'draft' : raw.state,
    headRef: raw.head.label || raw.head.ref,
    baseRef: raw.base.ref,
    headSha: raw.head.sha,
    baseSha: raw.base.sha,
    additions: raw.additions,
    deletions: raw.deletions,
    changedFiles: raw.changed_files,
    updatedAt: raw.updated_at,
    // null while GitHub is still computing it; false means conflicts.
    mergeable: raw.mergeable ?? null,
    mergeableState: raw.mergeable_state || 'unknown',
    ...(pinned ? {} : { mergeMethods: mergeMethodsOf(repo) }),
  };
  if (section === 'description') return { pr };
  if (section === 'files') {
    // GitHub exposes at most 3,000 files. Explicit pages keep a large PR from freezing
    // the browser or silently appearing complete.
    const rows = await read(`/pulls/${number}/files?per_page=100&page=${page}`);
    const latest = await read(`/pulls/${number}`);
    if (latest.head.sha !== pr.headSha || latest.base.sha !== pr.baseSha)
      throw Object.assign(new Error('This pull request changed. Refresh to load its latest revision.'), {
        status: 409,
      });
    return {
      pr,
      files: rows.map(fileRow),
      nextPage: rows.length === 100 && page * 100 < Math.min(pr.changedFiles, 3000) ? page + 1 : null,
      truncated: pr.changedFiles > 3000,
    };
  }
  const list = LIST_SECTIONS[section];
  if (list) {
    // A full page may be the last; the next then comes back empty with no nextPage,
    // costing one request but never hiding a row.
    const rows = await read(`${list.path(number)}?per_page=100&page=${page}`);
    return {
      pr,
      [camel(section)]: rows.map(list.row),
      nextPage: rows.length === 100 && page < 30 ? page + 1 : null,
    };
  }

  async function pages(path, key) {
    const rows = [];
    for (let p = 1; p <= 10; p++) {
      const data = await read(`${path}&per_page=100&page=${p}`);
      const batch = data[key] || [];
      rows.push(...batch);
      if (rows.length >= data.total_count || batch.length < 100) return { rows, truncated: false };
    }
    return { rows, truncated: true };
  }
  const sha = encodeURIComponent(pr.headSha);
  const results = await Promise.allSettled([
    pages(`/commits/${sha}/check-runs?filter=latest`, 'check_runs'),
    pages(`/commits/${sha}/status?`, 'statuses'),
  ]);
  const checks = [];
  const warnings = [];
  for (const [index, result] of results.entries()) {
    const source = index === 0 ? 'Check runs' : 'Commit statuses';
    if (result.status === 'rejected') {
      warnings.push(`${source} could not be loaded: ${result.reason.message}`);
      continue;
    }
    if (result.value.truncated) warnings.push(`${source}: only the first 1,000 entries are shown.`);
    for (const r of result.value.rows) {
      const row =
        index === 0
          ? {
              ...restCheckRun(r),
              app: r.app?.name || '',
              startedAt: r.started_at,
              completedAt: r.completed_at,
              description: r.output?.title || '',
            }
          : { ...restCommitStatus(r), app: 'Commit status', description: r.description || '' };
      checks.push({ ...row, failed: checkFailed(row.conclusion) });
    }
  }
  return { pr, checks, warnings };
}

// One commit with its changed files, diffed against its first parent. GitHub lists at
// most 300 files here without saying it cut the list, so that many is reported as
// possibly incomplete.
export async function commitView(project, sha) {
  if (!/^[0-9a-f]{7,40}$/i.test(String(sha)))
    throw Object.assign(new Error('A commit SHA is required'), { status: 400 });
  const cfg = getConfig();
  if (!cfg.githubToken) throw Object.assign(new Error('No GITHUB_TOKEN is configured'), { status: 503 });
  const res = await githubRest(cfg, 'GET', `/repos/${project.repo}/commits/${sha}`, undefined, {
    conditional: true,
  });
  if (!res.ok) {
    // GitHub says 422 for a SHA it has no commit for.
    const status = res.status === 422 ? 404 : res.status === 404 || res.status === 403 ? res.status : 502;
    throw Object.assign(new Error(`GitHub answered ${res.status} reading the commit`), { status });
  }
  const raw = await res.json();
  const files = (raw.files || []).map(fileRow);
  return {
    commit: {
      sha: raw.sha,
      message: raw.commit?.message || '',
      author: raw.author?.login || raw.commit?.author?.name || 'Unknown author',
      date: raw.commit?.author?.date || null,
      url: raw.html_url,
      parents: (raw.parents || []).map((p) => p.sha),
      additions: raw.stats?.additions ?? null,
      deletions: raw.stats?.deletions ?? null,
    },
    files,
    truncated: files.length >= 300,
  };
}

// The REST version that carries a PR's `stack` and the async merge a stacked PR needs.
const STACK_API_VERSION = '2026-03-10';
// How long a stacked merge is waited on before it is reported as still running.
const STACK_MERGE_POLLS = 10;
const STACK_MERGE_POLL_MS = 1000;

// GitHub's reason for a refused merge, with a status the browser can trust: a GitHub 401
// must not arrive as a 401 (the dashboard reads that as its own sign-out), and the async
// endpoint's 400 (not ready to merge) is a conflict, not a bad request.
function mergeRefused(res, body) {
  const status = res.status === 400 ? 409 : [403, 404, 405, 409, 422].includes(res.status) ? res.status : 502;
  const reason = body.message || `GitHub answered ${res.status}`;
  return Object.assign(new Error(`GitHub refused the merge: ${reason}`), { status });
}

// A stacked PR only merges through the async endpoint, which also lands every PR below it
// in the background. The result is polled briefly; one still running (or queued) comes
// back `merged: false` with its status and GitHub finishes it.
async function mergeStacked(cfg, project, number, stack, { method, headSha }) {
  const opts = { apiVersion: STACK_API_VERSION };
  const res = await githubRest(
    cfg,
    'PUT',
    `/repos/${project.repo}/pulls/${number}/merge-async`,
    { merge_method: method, sha: headSha },
    opts,
  );
  let body = await res.json().catch(() => ({}));
  if (!res.ok) throw mergeRefused(res, body);
  const uuid = body.details?.uuid;
  for (let i = 0; body.status === 'pending' && uuid && i < STACK_MERGE_POLLS; i++) {
    await new Promise((resolve) => setTimeout(resolve, STACK_MERGE_POLL_MS));
    const poll = await githubRest(
      cfg,
      'GET',
      `/repos/${project.repo}/pulls/${number}/merge-async/${uuid}`,
      undefined,
      opts,
    );
    // A failed read leaves the merge running on GitHub; report it as pending.
    if (!poll.ok) break;
    body = await poll.json();
  }
  if (body.status === 'failed')
    throw Object.assign(
      new Error(`GitHub could not merge the stack: ${body.details?.message || 'the merge failed'}`),
      { status: 409 },
    );
  const below = stack.position > 1 ? ` with the ${stack.position - 1} below it in the stack` : '';
  const message =
    body.status === 'merged'
      ? body.details?.message || `Merged${below}`
      : body.status === 'enqueued'
        ? `Added to the merge queue${below}`
        : `GitHub is still merging this pull request${below}; refresh in a moment`;
  return {
    merged: body.status === 'merged',
    status: body.status === 'merged' || body.status === 'enqueued' ? body.status : 'pending',
    sha: body.details?.sha || null,
    message,
  };
}

// Merges at the head and into the base the viewer showed: GitHub refuses with 409 if a
// push landed since, but its sha check ignores the base, so a retarget is refused here.
// New commits on the same base are fine. Stacked PRs go through mergeStacked, since the
// synchronous endpoint refuses them.
export async function mergePullRequest(
  project,
  number,
  { method = 'squash', headSha = '', baseRef = '' } = {},
) {
  if (!MERGE_METHODS.includes(method))
    throw Object.assign(new Error('Unknown merge method'), { status: 400 });
  if (!/^[0-9a-f]{40}$/i.test(headSha))
    throw Object.assign(new Error('The head commit to merge is missing'), { status: 400 });
  if (!baseRef) throw Object.assign(new Error('The base branch to merge into is missing'), { status: 400 });
  const cfg = getConfig();
  if (!cfg.githubToken) throw Object.assign(new Error('No GITHUB_TOKEN is configured'), { status: 503 });
  const current = await githubRest(cfg, 'GET', `/repos/${project.repo}/pulls/${number}`, undefined, {
    apiVersion: STACK_API_VERSION,
  });
  if (!current.ok) {
    const status = current.status === 404 || current.status === 403 ? current.status : 502;
    throw Object.assign(
      new Error(`GitHub answered ${current.status} reading the pull request before merging`),
      {
        status,
      },
    );
  }
  const pull = await current.json();
  const base = pull.base?.ref;
  if (base !== baseRef)
    throw Object.assign(
      new Error(
        `This pull request now merges into ${base}, not ${baseRef}. Refresh to load its latest revision.`,
      ),
      { status: 409 },
    );
  if (pull.stack) return mergeStacked(cfg, project, number, pull.stack, { method, headSha });
  const res = await githubRest(cfg, 'PUT', `/repos/${project.repo}/pulls/${number}/merge`, {
    merge_method: method,
    sha: headSha,
  });
  const body = await res.json().catch(() => ({}));
  // GitHub's own reason (conflicts, branch protection, head moved) is what the user needs.
  if (!res.ok) throw mergeRefused(res, body);
  return {
    merged: !!body.merged,
    status: body.merged ? 'merged' : 'pending',
    sha: body.sha || null,
    message: body.message || '',
  };
}

// GitHub merges the latest base into the PR branch asynchronously. Pin the head there
// too, so a concurrent push cannot be overwritten.
export async function updatePullRequestBranch(project, number, { headSha = '', baseRef = '' } = {}) {
  if (!/^[0-9a-f]{40}$/i.test(headSha))
    throw Object.assign(new Error('The head commit to update is missing'), { status: 400 });
  if (!baseRef) throw Object.assign(new Error('The base branch to update from is missing'), { status: 400 });
  const cfg = getConfig();
  if (!cfg.githubToken) throw Object.assign(new Error('No GITHUB_TOKEN is configured'), { status: 503 });
  const root = `/repos/${project.repo}/pulls/${number}`;
  const current = await githubRest(cfg, 'GET', root);
  if (!current.ok)
    throw Object.assign(
      new Error(`GitHub answered ${current.status} reading the pull request before updating its branch`),
      { status: [403, 404].includes(current.status) ? current.status : 502 },
    );
  const pull = await current.json();
  if (pull.state !== 'open')
    throw Object.assign(new Error('Only an open pull request can have its branch updated'), { status: 409 });
  if (pull.head?.sha !== headSha || pull.base?.ref !== baseRef)
    throw Object.assign(new Error('This pull request has changed. Refresh to load its latest revision.'), {
      status: 409,
    });
  const res = await githubRest(cfg, 'PUT', `${root}/update-branch`, { expected_head_sha: headSha });
  const body = await res.json().catch(() => ({}));
  if (!res.ok)
    throw Object.assign(
      new Error(`GitHub refused the branch update: ${body.message || `GitHub answered ${res.status}`}`),
      {
        status: [403, 404, 409, 422].includes(res.status) ? res.status : 502,
      },
    );
  return { status: 'accepted', message: body.message || 'Updating pull request branch.' };
}
