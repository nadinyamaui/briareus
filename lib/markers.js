// @ts-check
// The three strings this app writes into GitHub and later reads back.
//
// They are a contract with pull requests that already exist: the sheet turn
// writes an anchor the run turn finds again, the checklist comment carries one
// a fix turn ticks items in, and a fix commit ends with a line this app looks
// for. Changing any of them makes every pull request written
// before the change unreadable, so they are constants rather than settings,
// and they live in a module of their own so the prompts (lib/prtasks.js) and
// the parsing (lib/findings.js) can both name them without
// importing each other.

// Marks the test sheet comment. A re-run of the sheet updates the comment
// carrying it instead of stacking a second one.
export const TEST_SHEET_ANCHOR = '<!-- reviewer:test-sheet -->';

// Marks the "Required fixes" checklist comment.
export const FIXES_ANCHOR = '<!-- reviewer:required-fixes -->';

// The line every fix commit ends with. The dashboard reads it off the
// head commit it is about to review: the push a fix turn made is still worth
// reviewing (that is how the fix gets verified), but the session started for it
// must not fix again; otherwise review and fix keep pushing at each other.
export const FIX_COMMIT_MARKER = '[reviewer-fix]';
