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

// The methods the repository allows, in the order the viewer offers them.
// GitHub leaves the allow_* fields out for a token without enough repo
// permission (and there is no repo at all when its read failed); offer every
// method then and let GitHub's refusal explain, rather than hide Merge.
function mergeMethodsOf(repo) {
  const allowed = MERGE_METHODS.map((m) => repo?.[MERGE_SETTING[m]]);
  if (allowed.every((v) => v === undefined)) return [...MERGE_METHODS];
  return MERGE_METHODS.filter((_, i) => allowed[i]);
}

// The options /api/pr/view reads from its query, for the browser's PR viewer
// and the mobile pull_files operation alike.
export function pullRequestViewOptions(query) {
  return {
    section: String(query.section || 'description'),
    page: Number(query.page || 1),
    headSha: String(query.headSha || ''),
    baseSha: String(query.baseSha || ''),
  };
}

export async function pullRequestView(project, number, options = {}) {
  const { section = 'description', page = 1, headSha = '', baseSha = '' } = options;
  if (!['description', 'files', 'checks'].includes(section))
    throw Object.assign(new Error('Unknown pull request section'), { status: 400 });
  if (!Number.isInteger(page) || page < 1 || page > 30)
    throw Object.assign(new Error('Invalid files page'), { status: 400 });
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
  // Only the viewer's first, unpinned read needs the merge settings: later
  // reads are pinned to the PR it already holds. A failed repository read
  // must not break the viewer.
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
    // GitHub exposes at most 3,000 files. Keep pages explicit so a large PR
    // doesn't freeze the browser or silently appear complete.
    const rows = await read(`/pulls/${number}/files?per_page=100&page=${page}`);
    const latest = await read(`/pulls/${number}`);
    if (latest.head.sha !== pr.headSha || latest.base.sha !== pr.baseSha)
      throw Object.assign(new Error('This pull request changed. Refresh to load its latest revision.'), {
        status: 409,
      });
    return {
      pr,
      files: rows.map((f) => ({
        filename: f.filename,
        previousFilename: f.previous_filename || null,
        status: f.status,
        additions: f.additions,
        deletions: f.deletions,
        patch: f.patch ?? null,
        url: f.blob_url,
      })),
      nextPage: rows.length === 100 && page * 100 < Math.min(pr.changedFiles, 3000) ? page + 1 : null,
      truncated: pr.changedFiles > 3000,
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

// Merges the pull request at the head and into the base branch the viewer
// showed: GitHub refuses with 409 if a push landed since, and its sha check
// says nothing about the base, so a retarget is refused here the same way.
// New commits on the same base branch are fine.
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
  const current = await githubRest(cfg, 'GET', `/repos/${project.repo}/pulls/${number}`);
  if (!current.ok) {
    const status = current.status === 404 || current.status === 403 ? current.status : 502;
    throw Object.assign(
      new Error(`GitHub answered ${current.status} reading the pull request before merging`),
      {
        status,
      },
    );
  }
  const base = (await current.json()).base?.ref;
  if (base !== baseRef)
    throw Object.assign(
      new Error(
        `This pull request now merges into ${base}, not ${baseRef}. Refresh to load its latest revision.`,
      ),
      { status: 409 },
    );
  const res = await githubRest(cfg, 'PUT', `/repos/${project.repo}/pulls/${number}/merge`, {
    merge_method: method,
    sha: headSha,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    // GitHub's own reason (conflicts, branch protection, head moved) is what
    // the user needs. A GitHub 401 must not reach the browser as a 401, which
    // the dashboard reads as its own sign-out.
    const status = [403, 404, 405, 409, 422].includes(res.status) ? res.status : 502;
    const reason = body.message || `GitHub answered ${res.status}`;
    throw Object.assign(new Error(`GitHub refused the merge: ${reason}`), { status });
  }
  return { merged: !!body.merged, sha: body.sha || null, message: body.message || '' };
}
