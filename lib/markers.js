// @ts-check
// Marks the test sheet comment, so a re-run updates it instead of stacking another.
export const TEST_SHEET_ANCHOR = '<!-- reviewer:test-sheet -->';

// Ends the summary comment of a code review of `head`, so a retried publish step
// updates the comment it already posted instead of stacking another.
/** @param {string} head */
export const codeReviewAnchor = (head) => `<!-- reviewer:code-review ${head} -->`;
