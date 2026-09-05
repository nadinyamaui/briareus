import { describe, it, expect } from 'vitest';
import { TEST_SHEET_ANCHOR, FIXES_ANCHOR, FIX_COMMIT_MARKER } from '../lib/markers.js';

// These three strings are a contract with pull requests that already exist on
// GitHub (see the note in lib/markers.js). Changing any of them makes every PR
// written before the change unreadable, so the exact values are pinned here,
// and a failing test in this file means "you are about to break old PRs".
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
