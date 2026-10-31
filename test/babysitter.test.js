import { describe, it, expect, vi } from 'vitest';

vi.mock('../lib/db.js', () => ({ loadAppSetting: vi.fn(), saveAppSetting: vi.fn() }));
vi.mock('../lib/jobs.js', () => ({
  createDevSession: vi.fn(),
  devSessionSlots: vi.fn(() => Infinity),
  pullRequestHasOpenSession: vi.fn(() => false),
}));
// The spec itself is lib/actions.js's business, tested there; here it only has to
// reach createDevSession with the runtime on top.
vi.mock('../lib/actions.js', () => ({
  getAction: vi.fn((id) => (['fix-checks', 'solve-conflicts', 'review'].includes(id) ? { id } : null)),
  actionSessionSpec: vi.fn(async (action, context) => ({ activity: action.id, prNumber: context.prNumber })),
}));

import {
  createBabysitter,
  errandsFor,
  startErrand,
  MAX_PUSH_ERRANDS,
  MAX_REVIEWS_PER_TICK,
} from '../lib/babysitter.js';
import { createDevSession } from '../lib/jobs.js';
import { actionSessionSpec } from '../lib/actions.js';

const project = (over = {}) => ({
  repo: 'acme/shop',
  enabled: true,
  babysitPrs: true,
  prAuthor: '',
  actionProviderId: 3,
  actionModel: 'opus',
  actionEffort: 'high',
  ...over,
});

const pr = (over = {}) => ({
  number: 7,
  title: 'Add cart',
  draft: false,
  author: 'morgan',
  branch: 'feature/cart',
  baseBranch: 'main',
  labels: [],
  checks: 'success',
  headSha: 'abc1234def',
  recommended: null,
  ...over,
});

function sitter({ projects = [project()], pulls = [pr()], stored = {}, ...over } = {}) {
  const start = vi.fn(async () => {});
  const saved = [];
  const b = createBabysitter({
    projects: () => projects,
    pulls: async () => ({ pulls }),
    hasSession: () => false,
    slots: () => Infinity,
    start,
    load: async () => stored,
    save: async (v) => saved.push(JSON.parse(JSON.stringify(v))),
    ...over,
  });
  return { b, start, saved };
}

const labelled = (...names) => names.map((name) => ({ name }));

describe('PR errands', () => {
  it('proposes conflicts and failed checks', () => {
    const labels = labelled('code-approved');
    expect(errandsFor(pr({ recommended: 'solve-conflicts', checks: 'failure', labels }), project())).toEqual([
      'solve-conflicts',
      'fix-checks',
    ]);
    expect(errandsFor(pr({ checks: 'success', labels }), project())).toEqual([]);
    expect(errandsFor(pr({ checks: 'pending', labels }), project())).toEqual([]);
  });
  it.each([[[]], [labelled('requires-dev-review')], [labelled('feedback-implemented', 'enhancement')]])(
    'proposes a review when the board recommends one: %j',
    (labels) => {
      expect(errandsFor(pr({ labels }), project())).toEqual(['review']);
    },
  );
  it.each([
    [labelled('feedback-given')],
    [labelled('code-approved')],
    [labelled('enhancement')],
    [labelled('feedback-implemented', 'feedback-given')],
  ])('proposes no review when the board does not: %j', (labels) => {
    expect(errandsFor(pr({ labels }), project())).toEqual([]);
  });
  it('still reviews a conflicting PR, after the conflict errand', () => {
    expect(
      errandsFor(pr({ recommended: 'solve-conflicts', labels: labelled('has-conflicts') }), project()),
    ).toEqual(['solve-conflicts', 'review']);
  });
  it("reviews other authors' PRs but never pushes to them", () => {
    expect(
      errandsFor(
        pr({ author: 'other', checks: 'failure', recommended: 'solve-conflicts' }),
        project({ prAuthor: 'morgan' }),
      ),
    ).toEqual(['review']);
  });
  it.each([{ draft: true }, { crossRepository: true }, { headSha: '' }, { labels: [{ name: 'blocked' }] }])(
    'skips ineligible PRs: %j',
    (extra) => {
      expect(errandsFor(pr({ checks: 'failure', ...extra }), project())).toEqual([]);
    },
  );
  it('only pushes to the selected author', () => {
    const labels = labelled('code-approved');
    expect(
      errandsFor(pr({ checks: 'failure', author: 'other', labels }), project({ prAuthor: 'morgan' })),
    ).toEqual([]);
    expect(
      errandsFor(pr({ checks: 'failure', author: 'MORGAN', labels }), project({ prAuthor: 'morgan' })),
    ).toEqual(['fix-checks']);
  });
  it('reviews a head once, without counting it as a push', async () => {
    const stored = {};
    const { b, start, saved } = sitter({ stored });
    await b.tick();
    await b.tick();
    expect(start).toHaveBeenCalledTimes(1);
    expect(start.mock.calls[0][0]).toBe('review');
    expect(saved.at(-1)['acme/shop#7']).toEqual({ review: 'abc1234def' });
    const pushed = sitter({ stored: { 'acme/shop#7': { review: 'old' } } });
    await pushed.b.tick();
    expect(pushed.start).toHaveBeenCalledWith(
      'review',
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
  });
  it('caps the reviews started per project in one round, but not push errands', async () => {
    const many = Array.from({ length: MAX_REVIEWS_PER_TICK + 2 }, (_, i) =>
      pr({ number: i + 1, author: 'other' }),
    );
    const failing = pr({ number: 99, checks: 'failure', labels: labelled('code-approved') });
    const { b, start, saved } = sitter({ pulls: [...many, failing] });
    await b.tick();
    expect(start.mock.calls.map((c) => [c[0], c[2].number])).toEqual([
      ...many.slice(0, MAX_REVIEWS_PER_TICK).map((p) => ['review', p.number]),
      ['fix-checks', 99],
    ]);
    // The rest are left unmarked, so the next round reviews them.
    expect(saved.at(-1)[`acme/shop#${MAX_REVIEWS_PER_TICK + 1}`]).toBeUndefined();
  });
  it('reviews once the failing checks were already tried on the head', async () => {
    const { b, start } = sitter({
      stored: { 'acme/shop#7': { 'fix-checks': 'abc1234def', pushes: 1 } },
      pulls: [pr({ checks: 'failure' })],
    });
    await b.tick();
    expect(start.mock.calls.map((c) => c[0])).toEqual(['review']);
  });
  it('uses the selected action runtime and deduplicates the head', async () => {
    const stored = {};
    const { b, start, saved } = sitter({
      stored,
      pulls: [pr({ checks: 'failure', labels: labelled('code-approved') })],
    });
    await b.tick();
    await b.tick();
    expect(start).toHaveBeenCalledTimes(1);
    expect(start.mock.calls[0][3]).toEqual({ providerId: 3, model: 'opus', effort: 'high' });
    expect(saved.at(-1)['acme/shop#7']).toEqual({ 'fix-checks': 'abc1234def', pushes: 1 });
  });
  it('tries a new head but enforces the consecutive push cap', async () => {
    const next = sitter({
      stored: { 'acme/shop#7': { 'fix-checks': 'old', pushes: 1 } },
      pulls: [pr({ checks: 'failure' })],
    });
    await next.b.tick();
    expect(next.start).toHaveBeenCalledTimes(1);
    const capped = sitter({
      stored: { 'acme/shop#7': { pushes: MAX_PUSH_ERRANDS } },
      pulls: [pr({ checks: 'failure', labels: labelled('code-approved') })],
    });
    await capped.b.tick();
    expect(capped.start).not.toHaveBeenCalled();
  });
  it('resets the cap after a settled green head', async () => {
    const { b, saved, start } = sitter({
      stored: { 'acme/shop#7': { pushes: MAX_PUSH_ERRANDS } },
      pulls: [pr({ checks: 'success', labels: labelled('code-approved') })],
    });
    await b.tick();
    expect(saved.at(-1)['acme/shop#7'].pushes).toBe(0);
    expect(start).not.toHaveBeenCalled();
  });
  it.each([
    { projects: [project({ enabled: false })] },
    { projects: [project({ babysitPrs: false })] },
    { projects: [project({ actionProviderId: null })] },
    { hasSession: () => true },
    { slots: () => 0 },
  ])('does not start when unavailable', async (extra) => {
    const { b, start } = sitter({ pulls: [pr({ checks: 'failure' })], ...extra });
    await b.tick();
    expect(start).not.toHaveBeenCalled();
  });
  it('starts the requested action', async () => {
    await startErrand('fix-checks', project(), pr(), { providerId: 3, model: 'opus', effort: 'high' });
    expect(actionSessionSpec).toHaveBeenCalledWith(
      { id: 'fix-checks' },
      expect.objectContaining({ prNumber: 7 }),
    );
    expect(createDevSession).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 3, model: 'opus', effort: 'high', activity: 'fix-checks' }),
    );
    await startErrand('review', project(), pr(), { providerId: 3, model: 'opus', effort: 'high' });
    expect(createDevSession).toHaveBeenLastCalledWith(
      expect.objectContaining({ activity: 'review', prNumber: 7 }),
    );
    await expect(startErrand('qa', project(), pr(), { providerId: 3 })).rejects.toThrow('Unknown action');
  });
});
