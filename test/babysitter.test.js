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
  reviewAuthor: '',
  reviewProviderId: 3,
  reviewModel: 'opus',
  reviewEffort: 'high',
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

describe('errandsFor', () => {
  it('lists conflicts before failing checks before a review', () => {
    const p = project();
    expect(errandsFor(pr({ recommended: 'solve-conflicts', checks: 'failure', labels: [] }), p)).toEqual([
      'solve-conflicts',
      'fix-checks',
      'review',
    ]);
    expect(errandsFor(pr({ checks: 'failure' }), p)).toEqual(['fix-checks', 'review']);
    expect(
      errandsFor(pr({ checks: 'error', recommended: null, labels: [{ name: 'feedback-given' }] }), p),
    ).toEqual(['fix-checks']);
    expect(errandsFor(pr(), p)).toEqual(['review']);
    expect(errandsFor(pr({ recommended: 'qa', labels: [{ name: 'code-approved' }] }), p)).toEqual([]);
    expect(errandsFor(pr({ checks: 'pending' }), p)).toEqual(['review']);
  });

  it('still offers the review behind a has-conflicts label', () => {
    const labels = [{ name: 'has-conflicts' }];
    expect(errandsFor(pr({ recommended: 'solve-conflicts', labels }), project())).toEqual([
      'solve-conflicts',
      'review',
    ]);
    const reviewed = [...labels, { name: 'feedback-given' }];
    expect(errandsFor(pr({ recommended: 'solve-conflicts', labels: reviewed }), project())).toEqual([
      'solve-conflicts',
    ]);
  });

  it('skips drafts, stalled pull requests and ones opened from a fork', () => {
    expect(errandsFor(pr({ draft: true }), project())).toEqual([]);
    expect(errandsFor(pr({ labels: [{ name: 'blocked' }], checks: 'failure' }), project())).toEqual([]);
    expect(errandsFor(pr({ crossRepository: true, checks: 'failure' }), project())).toEqual([]);
  });

  it('pushes only to the configured author’s pull requests, but reviews anyone’s', () => {
    const p = project({ reviewAuthor: 'Morgan' });
    expect(errandsFor(pr({ author: 'someone', checks: 'failure' }), p)).toEqual(['review']);
    expect(errandsFor(pr({ author: 'someone', recommended: 'solve-conflicts' }), p)).toEqual(['review']);
    expect(errandsFor(pr({ author: 'morgan', checks: 'failure' }), p)).toEqual(['fix-checks', 'review']);
    expect(errandsFor(pr({ author: 'someone' }), p)).toEqual(['review']);
  });
});

describe('babysitter tick', () => {
  it('starts the errand on the project’s review runtime and remembers the head commit', async () => {
    const { b, start, saved } = sitter();
    await b.tick();
    expect(start).toHaveBeenCalledWith(
      'review',
      expect.objectContaining({ repo: 'acme/shop' }),
      expect.anything(),
      {
        providerId: 3,
        model: 'opus',
        effort: 'high',
      },
    );
    expect(saved.at(-1)).toEqual({ 'acme/shop#7': { review: 'abc1234def' } });
  });

  it('does not repeat an errand on the same head commit, but does on a new push', async () => {
    const stored = { 'acme/shop#7': { review: 'abc1234def' } };
    const same = sitter({ stored });
    await same.b.tick();
    expect(same.start).not.toHaveBeenCalled();
    const pushed = sitter({ stored, pulls: [pr({ headSha: 'fff9999' })] });
    await pushed.b.tick();
    expect(pushed.start).toHaveBeenCalledTimes(1);
  });

  it('runs fix-checks on a commit already reviewed', async () => {
    const { b, start, saved } = sitter({
      stored: { 'acme/shop#7': { review: 'abc1234def' } },
      pulls: [pr({ checks: 'failure' })],
    });
    await b.tick();
    expect(start.mock.calls[0][0]).toBe('fix-checks');
    expect(saved.at(-1)['acme/shop#7']).toEqual({
      review: 'abc1234def',
      'fix-checks': 'abc1234def',
      pushes: 1,
    });
  });

  it('reviews a head whose checks were already tried and stayed red', async () => {
    const { b, start, saved } = sitter({
      stored: { 'acme/shop#7': { 'fix-checks': 'abc1234def', pushes: 1 } },
      pulls: [pr({ checks: 'failure' })],
    });
    await b.tick();
    expect(start.mock.calls.map((c) => c[0])).toEqual(['review']);
    expect(saved.at(-1)['acme/shop#7']).toEqual({
      'fix-checks': 'abc1234def',
      review: 'abc1234def',
      pushes: 1,
    });
  });

  it('starts one errand per pull request a round', async () => {
    const { b, start } = sitter({ pulls: [pr({ checks: 'failure' })] });
    await b.tick();
    expect(start.mock.calls.map((c) => c[0])).toEqual(['fix-checks']);
  });

  it('stops pushing after MAX_PUSH_ERRANDS in a row, but keeps reviewing', async () => {
    const { b, start, saved } = sitter({
      stored: { 'acme/shop#7': { 'fix-checks': 'older', pushes: MAX_PUSH_ERRANDS } },
      pulls: [pr({ checks: 'failure' })],
    });
    await b.tick();
    expect(start.mock.calls.map((c) => c[0])).toEqual(['review']);
    expect(saved.at(-1)['acme/shop#7'].pushes).toBe(MAX_PUSH_ERRANDS);
  });

  it('counts pushes until a green head, which starts the count again', async () => {
    const red = sitter({
      stored: { 'acme/shop#7': { 'solve-conflicts': 'older', pushes: 1 } },
      pulls: [pr({ recommended: 'solve-conflicts', checks: 'success' })],
    });
    await red.b.tick();
    expect(red.start.mock.calls[0][0]).toBe('solve-conflicts');
    expect(red.saved.at(-1)['acme/shop#7'].pushes).toBe(2);

    const green = sitter({ stored: { 'acme/shop#7': { 'fix-checks': 'older', pushes: MAX_PUSH_ERRANDS } } });
    await green.b.tick();
    expect(green.saved.at(-1)['acme/shop#7']).toEqual({
      'fix-checks': 'older',
      review: 'abc1234def',
      pushes: 0,
    });
  });

  it('starts the count again on a mergeable head with no checks, but not on pending ones', async () => {
    const stored = () => ({ 'acme/shop#7': { 'solve-conflicts': 'older', pushes: MAX_PUSH_ERRANDS } });
    const none = sitter({ stored: stored(), pulls: [pr({ checks: null })] });
    await none.b.tick();
    expect(none.saved.at(-1)['acme/shop#7'].pushes).toBe(0);

    const pending = sitter({ stored: stored(), pulls: [pr({ checks: 'pending' })] });
    await pending.b.tick();
    expect(pending.saved.at(-1)['acme/shop#7'].pushes).toBe(MAX_PUSH_ERRANDS);
  });

  it('leaves pull requests with an open session alone', async () => {
    const { b, start } = sitter({ hasSession: () => true });
    await b.tick();
    expect(start).not.toHaveBeenCalled();
  });

  it('ignores projects without the setting, disabled ones, and ones with no review provider', async () => {
    const pulls = vi.fn(async () => ({ pulls: [pr()] }));
    const { b, start } = sitter({
      projects: [
        project({ babysitPrs: false }),
        project({ enabled: false }),
        project({ reviewProviderId: null }),
      ],
      pulls,
    });
    await b.tick();
    expect(start).not.toHaveBeenCalled();
    expect(pulls).not.toHaveBeenCalled();
  });

  it('stops for the project when no session slot is free', async () => {
    const { b, start } = sitter({ slots: () => 0, pulls: [pr(), pr({ number: 8 })] });
    await b.tick();
    expect(start).not.toHaveBeenCalled();
  });

  it('retries next tick when a start fails, and forgets closed pull requests', async () => {
    const start = vi.fn(async () => {
      throw new Error('pool full');
    });
    const { b, saved } = sitter({
      start,
      stored: { 'acme/shop#3': { review: 'old' }, 'other/repo#1': { review: 'x' } },
    });
    await b.tick();
    expect(saved.at(-1)).toEqual({ 'other/repo#1': { review: 'x' } });
  });
});

describe('startErrand', () => {
  const runtime = { providerId: 3, model: 'opus', effort: 'high' };
  const run = { provider: 3, model: 'opus', effort: 'high' };

  it('starts a code review on the PR branch', async () => {
    createDevSession.mockClear();
    await startErrand('review', project(), pr(), runtime);
    expect(createDevSession).toHaveBeenCalledWith({
      ...run,
      repo: 'acme/shop',
      branch: 'feature/cart',
      review: true,
      prNumber: 7,
    });
  });

  it('starts a pushing errand from its action spec, with the PR as context', async () => {
    createDevSession.mockClear();
    const p = project();
    await startErrand('fix-checks', p, pr(), runtime);
    expect(actionSessionSpec).toHaveBeenLastCalledWith(
      { id: 'fix-checks' },
      {
        repo: 'acme/shop',
        prNumber: 7,
        branch: 'feature/cart',
        baseBranch: 'main',
        title: 'Add cart',
        project: p,
        input: '',
      },
    );
    expect(createDevSession).toHaveBeenCalledWith({ ...run, activity: 'fix-checks', prNumber: 7 });
  });

  it('refuses an errand it has no action for', async () => {
    await expect(startErrand('qa', project(), pr(), runtime)).rejects.toThrow(/Unknown action: qa/);
  });
});
