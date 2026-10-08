// @ts-check
// The three strings this app writes into GitHub and later reads back.
//
// They are a contract with existing pull requests: changing any of them makes every PR
// written before the change unreadable, so they are constants, not settings. Their own
// module lets the prompts (lib/prtasks.js) and the parsing (lib/findings.js) share them
// without importing each other.

// Marks the test sheet comment, so a re-run updates it instead of stacking another.
export const TEST_SHEET_ANCHOR = '<!-- reviewer:test-sheet -->';

// Marks the "Required fixes" checklist comment.
export const FIXES_ANCHOR = '<!-- reviewer:required-fixes -->';

// The line every fix commit ends with. A fix push is still reviewed (that verifies the
// fix), but the session started for it must not fix again, or review and fix keep pushing
// at each other.
export const FIX_COMMIT_MARKER = '[reviewer-fix]';
