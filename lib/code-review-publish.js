// @ts-check
import { codeReviewAnchor, codeReviewFindingAnchor } from './markers.js';

export function findingBody(review, finding) {
  return [
    codeReviewFindingAnchor(review.id, finding.id),
    `**${finding.title}**`,
    `Category: ${finding.category} · Severity: ${finding.severity}`,
    finding.details,
    finding.failureScenario && `**Scenario / impact**\n${finding.failureScenario}`,
    finding.proof && `**Reviewer evidence**\n${finding.proof}`,
    finding.comments,
    `Independent verification: ${finding.verificationStatus}.`,
    finding.verificationProof && `**Verification evidence**\n${finding.verificationProof}`,
    finding.fixReason && `**${finding.shouldFix ? 'Worth fixing' : 'Not fixed'}:** ${finding.fixReason}`,
  ]
    .filter(Boolean)
    .join('\n\n');
}

export function summaryBody(review) {
  const counts = new Map();
  for (const f of review.findings) counts.set(f.category, (counts.get(f.category) || 0) + 1);
  return [
    codeReviewAnchor(review.id),
    `## Code review · ${review.effort} effort · ${review.findings.length} findings`,
    review.summary,
    `Reviewed commit: \`${review.headSha}\`.`,
    [...counts].map(([category, count]) => `${category}: ${count}`).join(' · '),
    review.findings.length
      ? 'Findings are posted inline below; confirmation and fix-value decisions are recorded separately.'
      : 'The review command reported no findings.',
    ...review.findings
      .filter((f) => !f.path)
      .map((f) => `### Finding without a diff location\n\n${findingBody(review, f)}`),
  ]
    .filter(Boolean)
    .join('\n\n');
}

export async function assertReviewHead(review, request) {
  const pr = await request(review, 'GET', `/repos/${review.repo}/pulls/${review.prNumber}`);
  if (pr.state !== 'open' || pr.head?.sha !== review.headSha || pr.base?.sha !== review.baseSha)
    throw Object.assign(
      new Error('The pull request changed or closed; start a new review of its current commits'),
      { stale: true, status: 409 },
    );
  return pr;
}

// Every read must succeed before another POST. After an uncertain write we stop;
// a later explicit retry or restart first locates our durable marker on GitHub.
export async function publishCodeReview(review, { store, request }) {
  async function all(path) {
    const rows = [];
    for (let page = 1; page <= 30; page++) {
      const batch = await request(review, 'GET', `${path}?per_page=100&page=${page}`);
      if (!Array.isArray(batch)) throw new Error('GitHub returned an invalid comments page');
      rows.push(...batch);
      if (batch.length < 100) return rows;
    }
    throw new Error('Too many comments to safely resume review publication');
  }
  await assertReviewHead(review, request);
  const issuePath = `/repos/${review.repo}/issues/${review.prNumber}/comments`;
  if (!review.summaryCommentId) {
    const marker = codeReviewAnchor(review.id);
    const existing = (await all(issuePath)).find((c) => String(c.body).includes(marker));
    const comment = existing || (await request(review, 'POST', issuePath, { body: summaryBody(review) }));
    if (!comment?.id || !comment.html_url) throw new Error('GitHub did not confirm the summary comment');
    await store.update(review.id, 'publishing', {
      summaryCommentId: comment.id,
      summaryCommentUrl: comment.html_url,
    });
    review.summaryCommentId = comment.id;
  }
  // The summary is persisted before any inline finding can be posted.
  const commentsPath = `/repos/${review.repo}/pulls/${review.prNumber}/comments`;
  const comments = review.findings.some((f) => f.path && !f.inlineCommentId) ? await all(commentsPath) : [];
  for (const finding of review.findings) {
    if (!finding.path || finding.inlineCommentId) continue;
    await assertReviewHead(review, request);
    const marker = codeReviewFindingAnchor(review.id, finding.id);
    const existing = comments.find((c) => String(c.body).includes(marker) && c.commit_id === review.headSha);
    const comment =
      existing ||
      (await request(review, 'POST', commentsPath, {
        body: findingBody(review, finding),
        commit_id: review.headSha,
        path: finding.path,
        ...(finding.endLine == null
          ? { subject_type: 'file' }
          : {
              line: finding.endLine,
              side: finding.side,
              ...(finding.startLine !== finding.endLine
                ? { start_line: finding.startLine, start_side: finding.side }
                : {}),
            }),
      }));
    if (!comment?.id || !comment.html_url) throw new Error('GitHub did not confirm the inline comment');
    await store.updateFinding(review.id, finding.id, {
      inlineCommentId: comment.id,
      inlineCommentUrl: comment.html_url,
    });
  }
  await assertReviewHead(review, request);
}
