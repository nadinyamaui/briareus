// @ts-check
// On-demand, read-only PR content; separate from the board's polling payload.
import { getConfig } from './config.js';
import { githubRest } from './github.js';
import { checkFailed, restCheckRun, restCommitStatus } from './prboard.js';

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
  const raw = await read(`/pulls/${number}`);
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
