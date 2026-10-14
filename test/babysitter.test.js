import { describe, it, expect, vi } from 'vitest';

vi.mock('../lib/db.js', () => ({ loadAppSetting: vi.fn(), saveAppSetting: vi.fn() }));
vi.mock('../lib/jobs.js', () => ({
  createDevSession: vi.fn(),
  devSessionSlots: vi.fn(() => Infinity),
  pullRequestHasOpenSession: vi.fn(() => false),
}));

import { createBabysitter, errandFor } from '../lib/babysitter.js';

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
  author: 'nadin',
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

describe('errandFor', () => {
  it('puts conflicts before failing checks before a review', () => {
    const p = project();
    expect(errandFor(pr({ recommended: 'solve-conflicts', checks: 'failure' }), p)).toBe('solve-conflicts');
    expect(errandFor(pr({ checks: 'failure' }), p)).toBe('fix-checks');
    expect(errandFor(pr({ checks: 'error', recommended: null }), p)).toBe('fix-checks');
    expect(errandFor(pr(), p)).toBe('review');
    expect(errandFor(pr({ recommended: 'qa' }), p)).toBe(null);
    expect(errandFor(pr({ checks: 'pending' }), p)).toBe('review');
  });

  it('skips drafts and stalled pull requests', () => {
    expect(errandFor(pr({ draft: true }), project())).toBe(null);
    expect(errandFor(pr({ labels: [{ name: 'blocked' }], checks: 'failure' }), project())).toBe(null);
  });

  it('pushes only to the configured author’s pull requests, but reviews anyone’s', () => {
    const p = project({ reviewAuthor: 'Nadin' });
    expect(errandFor(pr({ author: 'someone', checks: 'failure' }), p)).toBe(null);
    expect(errandFor(pr({ author: 'someone', recommended: 'solve-conflicts' }), p)).toBe(null);
    expect(errandFor(pr({ author: 'nadin', checks: 'failure' }), p)).toBe('fix-checks');
    expect(errandFor(pr({ author: 'someone' }), p)).toBe('review');
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
    expect(saved.at(-1)['acme/shop#7']).toEqual({ review: 'abc1234def', 'fix-checks': 'abc1234def' });
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
