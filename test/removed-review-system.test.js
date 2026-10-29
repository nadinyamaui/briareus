import { describe, expect, it } from 'vitest';
import { ACTIONS, getAction } from '../lib/actions.js';
import { API_V1_ROUTES, FIELDS, OBJECTS } from '../lib/api-v1-catalog.js';
import { PROJECT_DEFAULTS } from '../lib/projects.js';
import { TEMPLATE_IDS } from '../lib/templates.js';
import { BINARIES } from '../lib/providers.js';

describe('retired review system', () => {
  it('exposes no review or feedback action, template, or CLI workflow', () => {
    for (const id of ['review', 'implement-feedback', 'custom-feedback']) expect(getAction(id)).toBeNull();
    expect(ACTIONS.map((a) => a.id)).toEqual(
      expect.arrayContaining(['test-sheet', 'test-run', 'solve-conflicts', 'fix-checks']),
    );
    for (const id of ['assessFeedback', 'implementFeedback', 'customFeedback'])
      expect(TEMPLATE_IDS).not.toContain(id);
    for (const binary of Object.values(BINARIES)) {
      expect(binary).not.toHaveProperty('reviewPrompt');
      expect(binary).not.toHaveProperty('buildReviewArgs');
    }
  });
  it('removes findings and loop endpoints and review settings from the public contract', () => {
    expect(JSON.stringify(API_V1_ROUTES)).not.toMatch(/\/findings|findings\/|review-loop|triage\/save/);
    expect(JSON.stringify(FIELDS)).not.toMatch(/"review"|"reviewLoop"/);
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
