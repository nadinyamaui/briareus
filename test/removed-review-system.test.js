import { describe, expect, it } from 'vitest';
import { ACTIONS, getAction } from '../lib/actions.js';
import { API_V1_ROUTES, FIELDS, OBJECTS } from '../lib/api-v1-catalog.js';
import { PROJECT_DEFAULTS } from '../lib/projects.js';
import { TEMPLATE_IDS } from '../lib/templates.js';
import { BINARIES } from '../lib/providers.js';

describe('retired review system', () => {
  it('keeps retired feedback workflows removed alongside the code review action', () => {
    expect(getAction('review')).toMatchObject({ workspace: 'worktree' });
    // implement-feedback is back, but as a plain prompt with no assessment step.
    expect(getAction('custom-feedback')).toBeNull();
    expect(ACTIONS.map((a) => a.id)).toEqual(
      expect.arrayContaining([
        'test-sheet',
        'test-run',
        'solve-conflicts',
        'fix-checks',
        'implement-feedback',
      ]),
    );
    for (const id of ['assessFeedback', 'customFeedback']) expect(TEMPLATE_IDS).not.toContain(id);
    for (const binary of Object.values(BINARIES)) {
      expect(binary).not.toHaveProperty('reviewPrompt');
      expect(binary).not.toHaveProperty('buildReviewArgs');
    }
  });
  it('keeps retired triage and project review settings out of the public contract', () => {
    const paths = API_V1_ROUTES.map((route) => route.path);
    expect(paths.filter((path) => path.includes('/findings'))).toEqual([
      '/pulls/:number/code-reviews/:reviewId/findings/:findingId',
    ]);
    expect(paths).toContain('/sessions/:id/review-loop');
    expect(JSON.stringify(API_V1_ROUTES)).not.toMatch(/triage\/save/);
    expect(FIELDS).toHaveProperty('reviewLoop');
    expect(OBJECTS).not.toHaveProperty('Finding');
    for (const key of [
      'reviewProviderId',
      'reviewPublishInstructions',
      'autonomousReviewLoop',
      'feedbackInstructions',
      'reviewTestSheet',
    ])
      expect(PROJECT_DEFAULTS).not.toHaveProperty(key);
    expect(PROJECT_DEFAULTS).toMatchObject({ actionProviderId: null, qaTestRun: false, prAuthor: '' });
  });
});
