// @ts-check
// Marks the test sheet comment, so a re-run updates it instead of stacking another.
export const TEST_SHEET_ANCHOR = '<!-- reviewer:test-sheet -->';

// Review ids make publication recoverable without duplicating comments after a restart.
export const codeReviewAnchor = (id) => `<!-- briareus:code-review:${id} -->`;
export const codeReviewFindingAnchor = (reviewId, findingId) =>
  `<!-- briareus:code-review:${reviewId}:finding:${findingId} -->`;
