import { describe, it, expect } from 'vitest';
import { TEST_SHEET_ANCHOR, FIXES_ANCHOR, FIX_COMMIT_MARKER } from '../lib/markers.js';

// These strings are a contract with PRs already on GitHub (see lib/markers.js): changing one
// makes every older PR unreadable, so a failure here means you are about to break old PRs.
describe('markers', () => {
  it('pins the test sheet anchor', () => {
    expect(TEST_SHEET_ANCHOR).toBe('<!-- reviewer:test-sheet -->');
  });

  it('pins the required-fixes anchor', () => {
    expect(FIXES_ANCHOR).toBe('<!-- reviewer:required-fixes -->');
  });

  it('pins the fix commit marker', () => {
    expect(FIX_COMMIT_MARKER).toBe('[reviewer-fix]');
  });
});
