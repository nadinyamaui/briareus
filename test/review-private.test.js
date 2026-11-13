import { describe, expect, it, vi } from 'vitest';

vi.mock('../lib/db.js', () => ({ listCodeReviewDecisions: vi.fn() }));

import { listCodeReviewDecisions } from '../lib/db.js';
import { postsReviewToGithub, privateFeedbackNote, privateFixesNote } from '../lib/review-private.js';

const at = (minute) => new Date(Date.UTC(2026, 10, 13, 12, minute)).toISOString();
const decision = (over) => ({
  findingRef: 'r1',
  threadId: null,
  title: 'Cart total ignores the coupon',
  filePath: 'lib/cart.js',
  line: 44,
  verdict: 'fix',
  verification: 'confirmed',
  rationale: 'Reproduced with a 10% coupon.',
  decidedAt: at(1),
  ...over,
});

describe('postsReviewToGithub', () => {
  it('posts unless the project switched it off', () => {
    expect(postsReviewToGithub({})).toBe(true);
    expect(postsReviewToGithub(null)).toBe(true);
    expect(postsReviewToGithub({ postReviewToGithub: true })).toBe(true);
    expect(postsReviewToGithub({ postReviewToGithub: false })).toBe(false);
  });
});

describe('privateFixesNote', () => {
  it('lists the required fixes still owed that have no thread', () => {
    const note = privateFixesNote([
      decision(),
      decision({ findingRef: 'r2', title: 'Threaded', threadId: 'T1' }),
      decision({ findingRef: 'r3', title: 'Only optional', verdict: 'optional' }),
    ]);
    expect(note).toContain('- Cart total ignores the coupon (lib/cart.js:44): Reproduced with a 10% coupon.');
    expect(note).not.toContain('Threaded');
    expect(note).not.toContain('Only optional');
    expect(note).toContain('leave them out of every comment you post');
  });

  it('drops a fix a later review dismissed as made, and says nothing when none is owed', () => {
    const fixed = decision({
      verdict: 'dismiss',
      rationale: 'Fixed since: lib/cart.js:44.',
      decidedAt: at(2),
    });
    expect(privateFixesNote([decision(), fixed])).toBeNull();
    expect(privateFixesNote([])).toBeNull();
  });

  it('counts what it does not list', () => {
    const many = Array.from({ length: 32 }, (_, i) => decision({ findingRef: `r${i}`, title: `Fix ${i}` }));
    const note = privateFixesNote(many);
    expect(note).toContain('- Fix 29');
    expect(note).not.toContain('- Fix 30');
    expect(note).toContain('- … and 2 more.');
  });

  it('reads the pull request’s stored decisions', async () => {
    listCodeReviewDecisions.mockResolvedValueOnce([decision()]);
    expect(await privateFeedbackNote('acme/shop', 7)).toContain('Cart total ignores the coupon');
    expect(listCodeReviewDecisions).toHaveBeenCalledWith('acme/shop', 7);
  });
});
