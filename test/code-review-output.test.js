import { describe, it, expect } from 'vitest';
import { reviewOutput } from '../lib/code-review-output.js';

const finding = {
  title: 'Missing tenant filter',
  severity: 'high',
  details: 'A member can read another tenant.',
  proof: 'GET /items/2 returns 200.',
  path: 'lib/items.js',
  startLine: 12,
  shouldFix: true,
};
describe('review output', () => {
  it('keeps the original recommendation distinct from independent assessment', () => {
    const result = reviewOutput({ summary: 'One bug', findings: [finding] });
    expect(result.findings[0]).toMatchObject({
      reviewerShouldFix: true,
      proof: finding.proof,
      endLine: 12,
      side: 'RIGHT',
    });
    expect(result.findings[0]).not.toHaveProperty('shouldFix');
  });
  it('accepts an explicit clean review and findings without a diff location', () => {
    expect(reviewOutput({ summary: 'No issues found.', findings: [] }).findings).toEqual([]);
    expect(
      reviewOutput({ summary: 'One issue', findings: [{ ...finding, path: null }] }).findings[0].path,
    ).toBeNull();
  });
  it.each([
    {},
    { summary: 'No bugs' },
    { summary: '', findings: [] },
    { summary: 'x', findings: [{ ...finding, severity: 'surprise' }] },
    { summary: 'x', findings: [{ ...finding, path: '../outside' }] },
    { summary: 'x', findings: [{ ...finding, startLine: 0 }] },
    { summary: 'x', findings: [{ ...finding, shouldFix: 'yes' }] },
  ])('rejects malformed output instead of declaring a clean review: %j', (input) => {
    expect(() => reviewOutput(input)).toThrow();
  });
});
