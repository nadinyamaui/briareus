// @ts-check
import { asGithubUser, githubRest } from './github.js';

// The CLI can return a review without obeying --comment. Verify publication
// before the caller marks the turn complete and deletes its session.
export async function ensureCodeReviewOverview(
  cfg,
  { repo, prNumber, marker, summary, since, canceled = () => false },
) {
  return asGithubUser(cfg.githubToken, async () => {
    const signal = AbortSignal.timeout(30_000);
    const request = async (method, route, body = undefined) => {
      if (canceled()) throw new Error('Code review publication canceled');
      const res = await githubRest(cfg, method, route, body, { signal });
      if (!res.ok) throw new Error(`GitHub answered ${res.status} verifying code review publication`);
      return res.json();
    };
    if (!prNumber) throw new Error('Code review has no pull request for its overview');
    const viewer = await request('GET', '/user');
    if (!viewer.login) throw new Error('Could not identify the code review publisher');
    const anchor = `<!-- briareus-code-review:${marker} -->`;
    const route = `/repos/${repo}/issues/${prNumber}/comments`;
    for (let page = 1; ; page++) {
      const comments = await request('GET', `${route}?per_page=100&page=${page}`);
      if (!Array.isArray(comments)) throw new Error('Invalid pull request comments response');
      const existing = comments.find(
        (comment) =>
          comment.user?.login === viewer.login &&
          (comment.body?.includes(anchor) ||
            (Date.parse(comment.created_at) >= Date.parse(since) &&
              (/^# Code Review\s*$/im.test(comment.body || '') || comment.body?.trim() === summary.trim()))),
      );
      if (existing) return existing.html_url;
      if (comments.length < 100) break;
    }
    if (!summary.trim()) throw new Error('Code review returned no overview to publish');
    const body = `${anchor}\n\n${/^# Code Review\s*$/im.test(summary) ? '' : '# Code Review\n\n'}${summary}`;
    // Preserve the full artifact for recovery rather than silently truncate it.
    if (body.length > 65_536) throw new Error('Code review overview exceeds GitHub’s comment limit');
    const posted = await request('POST', route, { body });
    if (!posted.html_url) throw new Error('GitHub did not confirm the code review overview');
    return posted.html_url;
  });
}
