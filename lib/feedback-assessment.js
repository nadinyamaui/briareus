// @ts-check
// Incoming reviews are evidence to assess, never permission to implement them.
import crypto from 'crypto';
import { getConfig } from './config.js';
import { githubRest } from './github.js';
import { findingKey } from './findings.js';
import { feedbackAssessmentPrompt } from './prtasks.js';
import { reviewerRuntime } from './projects.js';

async function read(route) {
  const res = await githubRest(getConfig(), 'GET', route);
  if (!res.ok) throw new Error(`GitHub answered ${res.status} reading feedback`);
  return res.json();
}

async function pages(route) {
  const rows = [];
  for (let page = 1; page <= 20; page++) {
    const next = await read(`${route}?per_page=100&page=${page}`);
    if (!Array.isArray(next)) throw new Error('GitHub returned an invalid feedback page');
    rows.push(...next);
    if (next.length < 100) return rows;
  }
  throw new Error('Feedback exceeds the pagination limit; assessment would be incomplete');
}

export async function readFeedbackSnapshot(repo, prNumber) {
  const root = `/repos/${repo}`;
  const pr = await read(`${root}/pulls/${prNumber}`);
  if (pr.state !== 'open' || !pr.head?.sha || !pr.head?.ref)
    throw new Error('Feedback assessment needs an open pull request with a head branch');
  if (pr.head.repo?.full_name?.toLowerCase() !== repo.toLowerCase())
    throw new Error('Feedback assessment requires a branch in the project repository');
  const [reviews, comments, issues] = await Promise.all([
    pages(`${root}/pulls/${prNumber}/reviews`),
    pages(`${root}/pulls/${prNumber}/comments`),
    pages(`${root}/issues/${prNumber}/comments`),
  ]);
  const source = (kind, row) => ({
    id: `${kind}:${row.id}`,
    author: row.user?.login || '',
    bot: row.user?.type === 'Bot',
    body: row.body || '',
    url: row.html_url || `https://github.com/${repo}/pull/${prNumber}`,
    file: row.path || null,
    line: row.line ?? row.original_line ?? null,
    commitSha: row.commit_id || null,
    reviewId: row.pull_request_review_id || (kind === 'review' ? row.id : null),
    replyTo: row.in_reply_to_id || null,
    state: row.state || null,
    updatedAt: row.updated_at || row.submitted_at || row.created_at || null,
  });
  const history = [
    ...reviews.map((r) => source('review', r)),
    ...comments.map((c) => source('comment', c)),
    ...issues.map((c) => source('issue', c)),
  ];
  const inactive = new Set(
    reviews.filter((r) => ['DISMISSED', 'PENDING'].includes(r.state)).map((r) => r.id),
  );
  const sources = history.filter(
    (s) =>
      s.body.trim() &&
      !s.replyTo &&
      !['PENDING', 'DISMISSED'].includes(s.state) &&
      !inactive.has(s.reviewId) &&
      !/^\s*<!--\s*reviewer:(?:review-started\s*-->\s*\n### 🔍 Code review started|required-fixes\s*-->\s*\n## Required fixes|triage-notes [\w.-]+\s*-->\s*\n## Review triage notes(?: \(round \d+\))?)(?:\r?\n|$)/i.test(
        s.body,
      ),
  );
  return {
    repo,
    prNumber,
    sha: pr.head.sha,
    branch: pr.head.ref,
    author: pr.user?.login || '',
    draft: !!pr.draft,
    labels: pr.labels || [],
    sources,
    history,
  };
}

function discussionReplies(snapshot, sources) {
  const selected = new Set(sources.map((s) => s.id));
  const reviews = new Set(sources.filter((s) => s.id.startsWith('review:')).map((s) => s.reviewId));
  const roots = new Map(
    [...(snapshot.history || []), ...sources]
      .filter(
        (s) => s.id.startsWith('comment:') && !s.replyTo && (selected.has(s.id) || reviews.has(s.reviewId)),
      )
      .map((s) => [Number(s.id.split(':')[1]), s]),
  );
  // The reviewer's replies can withdraw or correct a claim. Other threads and
  // our own implementation/triage notes do not revise that reviewer's evidence.
  return (snapshot.history || [])
    .filter((s) => s.replyTo && s.author.toLowerCase() === roots.get(s.replyTo)?.author.toLowerCase())
    .map(({ id, replyTo, body, author, state, updatedAt }) => ({
      id,
      replyTo,
      body,
      author,
      state,
      updatedAt,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

// The review id alone misses edits; the head alone misses a second review on the same commit.
export function externalFeedbackRevisions(snapshot) {
  const groups = new Map();
  for (const s of snapshot.sources) {
    if (s.bot || !s.author || s.author.toLowerCase() === snapshot.author.toLowerCase()) continue;
    if (!s.id.startsWith('review:') && !s.id.startsWith('comment:')) continue;
    const id = s.reviewId ? `review:${s.reviewId}` : s.id;
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(s);
  }
  return [...groups].map(([id, sources]) => ({
    id,
    // GitHub reanchors inline locations after a push; that is not a new review edit.
    revision: crypto
      .createHash('sha256')
      .update(
        JSON.stringify([
          ...sources.map(({ id, body, author, state, updatedAt }) => ({
            id,
            body,
            author,
            state,
            updatedAt,
          })),
          ...discussionReplies(snapshot, sources),
        ]),
      )
      .digest('hex'),
    sources: sources.map((s) => s.id),
  }));
}

export function feedbackAssessmentSpec(project, snapshot, sourceIds = null) {
  const runtime = reviewerRuntime(project);
  if (!runtime) throw new Error('Choose a review provider in this project’s Settings first');
  const assessment = {
    ...snapshot,
    sources: sourceIds ? snapshot.sources.filter((s) => sourceIds.includes(s.id)) : snapshot.sources,
    resultFile: `.briareus-feedback-${crypto.randomUUID()}.json`,
    completed: false,
  };
  return {
    provider: runtime.providerId,
    model: runtime.model,
    effort: runtime.effort,
    repo: snapshot.repo,
    branch: snapshot.branch,
    prNumber: snapshot.prNumber,
    prBranch: snapshot.branch,
    title: `Assess feedback: #${snapshot.prNumber}`,
    prompt: feedbackAssessmentPrompt({ ...snapshot, assessment, project }),
    feedbackAssessment: assessment,
    autoClose: true,
    reviewLoop: false,
    activity: 'assess-feedback',
  };
}

// Fail closed on missing/partial output. Source identities and links come from GitHub,
// not from generated JSON, and recommendations are advice rather than saved verdicts.
export function parseFeedbackAssessment(text, snapshot) {
  const result = JSON.parse(text);
  if (result.complete !== true || result.sha !== snapshot.sha || !Array.isArray(result.findings))
    throw new Error('Feedback assessment is incomplete or refers to a different commit');
  if (result.findings.length > 200) throw new Error('Feedback assessment has too many findings');
  if (
    !Array.isArray(result.sourcesReviewed) ||
    snapshot.sources.some((s) => !result.sourcesReviewed.includes(s.id))
  )
    throw new Error('Feedback assessment did not process every selected source');
  const sources = new Map(snapshot.sources.map((s) => [s.id, s]));
  const findings = new Map();
  for (const f of result.findings) {
    const source = sources.get(f.source);
    const a = f.assessment;
    if (
      !source ||
      !f.title?.trim() ||
      !['fix', 'optional', 'dismissed'].includes(f.recommendation) ||
      typeof a?.verified !== 'boolean' ||
      typeof a?.worthFixing !== 'boolean' ||
      !a.evidence?.trim() ||
      !a.reason?.trim()
    )
      throw new Error('Feedback assessment contains a finding without a source or evidence');
    const title = f.title.trim().slice(0, 200);
    const key = findingKey(title);
    if (findings.has(key)) throw new Error('Feedback assessment contains duplicate finding titles');
    findings.set(key, {
      key,
      title,
      severity: ['critical', 'high', 'medium', 'low'].includes(f.severity) ? f.severity : 'medium',
      file: typeof f.file === 'string' ? f.file : source.file,
      line: Number.isInteger(f.line) && f.line > 0 ? f.line : source.line,
      url: source.url,
      sourceId: source.id,
      sourceBody: source.body,
      reviewAuthorLogin: source.author,
      ...(source.id.startsWith('comment:') ? { reviewCommentId: Number(source.id.split(':')[1]) } : {}),
      assessment: a,
      recommendation: f.recommendation,
      parked: null,
      parkedWhy: `${f.recommendation === 'fix' ? 'Recommended fix' : f.recommendation === 'optional' ? 'Optional' : 'Recommended dismissal'}: ${a.reason}`,
    });
  }
  return [...findings.values()];
}

export function feedbackSnapshotCurrent(assessment, current) {
  if (assessment.sha !== current.sha || assessment.branch !== current.branch) return false;
  const sources = new Map(current.sources.map((s) => [s.id, s]));
  return (
    assessment.sources.every((s) => JSON.stringify(sources.get(s.id)) === JSON.stringify(s)) &&
    JSON.stringify(discussionReplies(assessment, assessment.sources)) ===
      JSON.stringify(discussionReplies(current, assessment.sources))
  );
}
