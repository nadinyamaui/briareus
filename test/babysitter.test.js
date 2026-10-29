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
  getAction: vi.fn((id) => (id === 'fix-checks' || id === 'solve-conflicts' ? { id } : null)),
  actionSessionSpec: vi.fn(async (action, context) => ({ activity: action.id, prNumber: context.prNumber })),
}));

import { createBabysitter, errandsFor, startErrand, MAX_PUSH_ERRANDS } from '../lib/babysitter.js';
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
  recommended: 'review',
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

describe('remaining PR errands', () => {
  it('only proposes conflicts and failed checks', () => {
    expect(errandsFor(pr({ recommended: 'solve-conflicts', checks: 'failure' }), project())).toEqual([
      'solve-conflicts',
      'fix-checks',
    ]);
    expect(errandsFor(pr({ checks: 'success' }), project())).toEqual([]);
    expect(errandsFor(pr({ checks: 'pending' }), project())).toEqual([]);
  });
  it.each([{ draft: true }, { crossRepository: true }, { headSha: '' }, { labels: [{ name: 'blocked' }] }])(
    'skips ineligible PRs: %j',
    (extra) => {
      expect(errandsFor(pr({ checks: 'failure', ...extra }), project())).toEqual([]);
    },
  );
  it('only pushes to the selected author', () => {
    expect(errandsFor(pr({ checks: 'failure', author: 'other' }), project({ prAuthor: 'morgan' }))).toEqual(
      [],
    );
    expect(errandsFor(pr({ checks: 'failure', author: 'MORGAN' }), project({ prAuthor: 'morgan' }))).toEqual([
      'fix-checks',
    ]);
  });
  it('uses the selected action runtime and deduplicates the head', async () => {
    const stored = {};
    const { b, start, saved } = sitter({ stored, pulls: [pr({ checks: 'failure' })] });
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
      pulls: [pr({ checks: 'failure' })],
    });
    await capped.b.tick();
    expect(capped.start).not.toHaveBeenCalled();
  });
  it('resets the cap after a settled green head', async () => {
    const { b, saved, start } = sitter({
      stored: { 'acme/shop#7': { pushes: MAX_PUSH_ERRANDS } },
      pulls: [pr({ checks: 'success', recommended: null })],
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
  it('starts only the requested remaining action', async () => {
    await startErrand('fix-checks', project(), pr(), { providerId: 3, model: 'opus', effort: 'high' });
    expect(actionSessionSpec).toHaveBeenCalledWith(
      { id: 'fix-checks' },
      expect.objectContaining({ prNumber: 7 }),
    );
    expect(createDevSession).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 3, model: 'opus', effort: 'high', activity: 'fix-checks' }),
    );
    await expect(startErrand('review', project(), pr(), { providerId: 3 })).rejects.toThrow('Unknown action');
  });
});
