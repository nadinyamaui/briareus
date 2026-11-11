import { describe, it, expect, vi } from 'vitest';

vi.mock('../lib/db.js', () => ({ loadAppSetting: vi.fn(), saveAppSetting: vi.fn() }));
vi.mock('../lib/jobs.js', () => ({
  createDevSession: vi.fn(),
  pullRequestHasOpenSession: vi.fn(() => false),
  // What a review is created with once it is admitted (lib/review-rounds.js).
  admitPullReview: vi.fn(async ({ source }) => ({ source, requestedBy: null, continuation: false })),
  // The revision each listed pull request was seen at (lib/review-enforcement.js).
  noteReviewedPull: vi.fn(async () => null),
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
import { admitPullReview, createDevSession, noteReviewedPull } from '../lib/jobs.js';
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
  it('says at which head and base branch it saw every listed pull request, errand or none', async () => {
    noteReviewedPull.mockClear();
    // One that needs nothing, and one retargeted since it was reviewed: the board is
    // where the server sees that when no hook and no session tells it.
    const { b } = sitter({
      pulls: [
        pr({ number: 7, labels: labelled('code-approved') }),
        pr({ number: 8, baseBranch: 'release', headSha: 'fed9876cba', draft: true }),
      ],
    });
    await b.tick();
    expect(noteReviewedPull.mock.calls).toEqual([
      ['acme/shop', { number: 7, headSha: 'abc1234def', baseRef: 'main' }],
      ['acme/shop', { number: 8, headSha: 'fed9876cba', baseRef: 'release' }],
    ]);
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
  ])('does not start when unavailable', async (extra) => {
    const { b, start } = sitter({ pulls: [pr({ checks: 'failure' })], ...extra });
    await b.tick();
    expect(start).not.toHaveBeenCalled();
  });
  it('passes idle sessions: only a busy one holds a pull request back', async () => {
    const hasSession = vi.fn(() => false);
    const { b, start } = sitter({
      pulls: [pr({ number: 7 }), pr({ number: 8, branch: 'feature/fix', checks: 'failure' })],
      hasSession,
    });
    await b.tick();
    expect(start.mock.calls.map((c) => [c[0], c[2].number])).toEqual([
      ['review', 7],
      ['fix-checks', 8],
    ]);
    expect(hasSession).toHaveBeenCalledWith('acme/shop', 7, 'feature/cart', { busyOnly: true });
    expect(hasSession).toHaveBeenCalledWith('acme/shop', 8, 'feature/fix', { busyOnly: true });
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
  it('asks for a review round as automation before it starts a review, and only then', async () => {
    createDevSession.mockClear();
    admitPullReview.mockClear();
    const runtime = { providerId: 3, model: 'opus', effort: 'high' };
    await startErrand('fix-checks', project(), pr(), runtime);
    expect(admitPullReview).not.toHaveBeenCalled();
    expect(createDevSession.mock.calls[0][0]).not.toHaveProperty('reviewRequest');
    const shop = project();
    await startErrand('review', shop, pr(), runtime);
    expect(admitPullReview).toHaveBeenCalledWith({
      project: shop,
      prNumber: 7,
      headSha: 'abc1234def',
      baseRef: 'main',
      source: 'babysitter',
    });
    // The session is created as the babysitter's, with no continuation to claim with.
    expect(createDevSession).toHaveBeenLastCalledWith(
      expect.objectContaining({
        activity: 'review',
        reviewRequest: { source: 'babysitter', requestedBy: null, continuation: false },
      }),
    );
    // Refused at the limit: no session is created at all.
    createDevSession.mockClear();
    admitPullReview.mockRejectedValueOnce(Object.assign(new Error('limit'), { code: 'review_round_limit' }));
    await expect(startErrand('review', shop, pr(), runtime)).rejects.toThrow('limit');
    expect(createDevSession).not.toHaveBeenCalled();
  });
});

describe('a pull request at its review round limit', () => {
  const refusal = (code = 'review_round_limit') =>
    Object.assign(new Error('acme/shop PR #7 has used 3 of its 3 code review rounds'), { status: 409, code });
  // Refuses every review the way the server does, and starts everything else.
  const refusing = (code) =>
    vi.fn(async (errand) => {
      if (errand === 'review') throw refusal(code);
    });
  const reviewsAsked = (start) => start.mock.calls.filter(([errand]) => errand === 'review');

  it('is asked once per head, not every fifteen minutes', async () => {
    const stored = {};
    const start = refusing();
    const { b, saved } = sitter({ stored, start });
    for (let tick = 0; tick < 5; tick++) await b.tick();
    expect(reviewsAsked(start)).toHaveLength(1);
    // Remembered as refused, never as reviewed.
    expect(saved.at(-1)['acme/shop#7']).toEqual({ reviewRefused: 'abc1234def:3' });
  });

  it('gets no fresh count from a push: the new head is asked once and refused again', async () => {
    const stored = {};
    const start = refusing();
    const pulls = [pr()];
    const { b, saved } = sitter({ stored, start, pulls });
    await b.tick();
    pulls[0] = pr({ headSha: 'fed9876cba' });
    for (let tick = 0; tick < 4; tick++) await b.tick();
    expect(reviewsAsked(start).map(([, , asked]) => asked.headSha)).toEqual(['abc1234def', 'fed9876cba']);
    expect(saved.at(-1)['acme/shop#7']).toEqual({ reviewRefused: 'fed9876cba:3' });
  });

  it('asks again when the project’s limit changes, without waiting for a push', async () => {
    const stored = {};
    // The server's answer: refused until the limit is above the three rounds used.
    const start = vi.fn(async (errand, asked) => {
      if (errand === 'review' && asked.reviewRoundLimit <= 3) throw refusal();
    });
    const projects = [project({ reviewRoundLimit: 2 })];
    const { b, saved } = sitter({ stored, start, projects });
    await b.tick();
    await b.tick();
    expect(reviewsAsked(start)).toHaveLength(1);
    // Raised, but not past what the pull request used: asked once more, refused again.
    projects[0] = project({ reviewRoundLimit: 3 });
    await b.tick();
    await b.tick();
    expect(reviewsAsked(start)).toHaveLength(2);
    expect(saved.at(-1)['acme/shop#7']).toEqual({ reviewRefused: 'abc1234def:3' });
    // Raised far enough, the review starts, and the head is then reviewed once as ever.
    projects[0] = project({ reviewRoundLimit: 5 });
    await b.tick();
    await b.tick();
    expect(reviewsAsked(start)).toHaveLength(3);
    expect(saved.at(-1)['acme/shop#7'].review).toBe('abc1234def');
  });

  it('still solves conflicts and fixes checks, and does not use up the reviews of a round', async () => {
    const stored = {};
    const start = refusing();
    const pulls = [
      pr({ number: 7 }),
      pr({ number: 8, headSha: 'bbb', checks: 'failure' }),
      pr({ number: 9, headSha: 'ccc' }),
    ];
    const { b, saved } = sitter({ stored, start, pulls });
    await b.tick();
    expect(start.mock.calls.map(([errand, , asked]) => [errand, asked.number])).toEqual([
      ['review', 7],
      ['fix-checks', 8],
      ['review', 9],
    ]);
    expect(saved.at(-1)['acme/shop#8']).toEqual({ 'fix-checks': 'bbb', pushes: 1 });
    // The refused head's other errands are not held back by the refusal.
    pulls[0] = pr({ number: 7, checks: 'failure' });
    await b.tick();
    expect(start).toHaveBeenCalledWith('fix-checks', expect.anything(), pulls[0], expect.anything());
  });

  it('remembers the other refusals of the bound too, and retries what merely failed', async () => {
    const again = refusing('review_round_reviewed');
    const reviewed = sitter({ stored: {}, start: again });
    await reviewed.b.tick();
    await reviewed.b.tick();
    expect(reviewsAsked(again)).toHaveLength(1);
    // A database that was down said nothing about the limit: the next round asks again.
    const failing = vi.fn(async () => {
      throw new Error('Database unavailable');
    });
    const down = sitter({ stored: {}, start: failing });
    await down.b.tick();
    await down.b.tick();
    expect(failing).toHaveBeenCalledTimes(2);
    expect(down.saved.at(-1)).toEqual({});
  });
});
