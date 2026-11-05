// @ts-check
// Marks the test sheet comment, so a re-run updates it instead of stacking another.
export const TEST_SHEET_ANCHOR = '<!-- reviewer:test-sheet -->';

// Only this run's enclosed results contribute to an automated QA verdict.
export const QA_RUN_PREFIX = '<!-- reviewer:qa-run ';
export const QA_RUN_END = '<!-- /reviewer:qa-run -->';
