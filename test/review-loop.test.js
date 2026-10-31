import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createReviewLoop, newReviewLoop, REVIEW_LOOP_MAX_ROUNDS } from '../lib/review-loop.js';

let parent, sessions, pr, review, deps, loop;
const fix = {
  id: 1,
  title: 'Lost update',
  shouldFix: 'fix',
  verification: 'confirmed',
  comments: 'Reproduced with two concurrent requests',
};
beforeEach(() => {
  parent = { id: 'task', repo: 'owner/repo', status: 'idle', reviewLoop: newReviewLoop() };
  sessions = new Map();
  pr = {
    number: 42,
    state: 'open',
    head: { sha: 'head-a', ref: 'feature', repo: { full_name: parent.repo } },
  };
  review = { status: 'completed', summary: 'Review report', headSha: 'head-a', findings: [] };
  deps = {
    getSession: (id) => sessions.get(id),
    readPull: vi.fn(async () => structuredClone(pr)),
    readReview: vi.fn(async () => structuredClone(review)),
    startAction: vi.fn(async (_parent, state) => {
      const child = { id: `child-${sessions.size}`, status: 'running', phase: state.phase };
      sessions.set(child.id, child);
      return child;
    }),
    canStart: (job) => job.status === 'idle' && !job.awaitingAnswer,
    save: vi.fn(),
    report: vi.fn(),
  };
  loop = createReviewLoop(deps);
});

async function finish(success = true) {
  const child = sessions.get(parent.reviewLoop.sessionId);
  child.status = 'closed';
  child.reviewLoopDone = success;
  await loop.finished(parent, child);
}

describe('review and feedback loop', () => {
  it('requires retired loop state to be explicitly re-armed', async () => {
    parent.reviewLoop = { reviewing: true, rounds: 2 };
    await loop.tick(parent);
    expect(parent.reviewLoop.failure.reason).toMatch(/retired review-loop state/);
    expect(deps.startAction).not.toHaveBeenCalled();
  });

  it('discards a result when the task has switched to another PR', async () => {
    review.findings = [fix];
    await loop.tick(parent);
    pr.number = 43;
    await finish();
    expect(parent.reviewLoop).toMatchObject({
      prNumber: 43,
      phase: 'review',
      rounds: 1,
      findings: [],
      done: false,
    });
  });

  it('reviews, fixes only confirmed fix verdicts, then reviews the pushed commit', async () => {
    review.findings = [fix, { id: 2, shouldFix: 'optional' }, { id: 3, shouldFix: 'dismiss' }];
    await loop.tick(parent);
    expect(parent.reviewLoop).toMatchObject({ rounds: 1, phase: 'review', headSha: 'head-a' });
    await finish();
    expect(parent.reviewLoop).toMatchObject({ phase: 'fix', rounds: 1, findings: [fix] });
    pr.head.sha = 'head-b';
    await finish();
    expect(parent.reviewLoop).toMatchObject({ phase: 'review', rounds: 2, headSha: 'head-b' });
    review.headSha = 'head-b';
    review.findings = [];
    await finish();
    expect(parent.reviewLoop).toMatchObject({
      done: true,
      sessionId: null,
      pendingResult: null,
      failure: null,
    });
    expect(deps.startAction).toHaveBeenCalledTimes(3);
  });

  it.each([
    {},
    { shouldFix: 'fix', verification: 'plausible', comments: 'Maybe' },
    { shouldFix: 'fix', verification: 'confirmed', comments: ' ' },
  ])('stops for a decision when a finding lacks verification: %j', async (finding) => {
    review.findings = [finding];
    await loop.tick(parent);
    await finish();
    expect(parent.reviewLoop.done).toBe(false);
    expect(parent.reviewLoop.failure.reason).toMatch(/verification/);
    expect(deps.startAction).toHaveBeenCalledTimes(1);
  });

  it.each([
    null,
    { status: 'running', summary: 'Report' },
    { status: 'failed' },
    { status: 'completed', summary: '' },
  ])('does not call an incomplete stored review clean: %j', async (record) => {
    review = record;
    await loop.tick(parent);
    await finish();
    expect(parent.reviewLoop.done).toBe(false);
    expect(parent.reviewLoop.failure).toBeTruthy();
    expect(deps.startAction).toHaveBeenCalledTimes(1);
  });

  it('rejects a review without a recorded commit', async () => {
    review.headSha = null;
    await loop.tick(parent);
    await finish();
    expect(parent.reviewLoop.failure.reason).toMatch(/reviewed commit/);
  });

  it('reviews a new head without fixing stale findings or declaring convergence', async () => {
    review.findings = [fix];
    await loop.tick(parent);
    pr.head.sha = 'head-b';
    await finish();
    expect(parent.reviewLoop).toMatchObject({ phase: 'review', done: false, rounds: 2, findings: [] });
  });

  it('stops if feedback implementation pushes no commit', async () => {
    review.findings = [fix];
    await loop.tick(parent);
    await finish();
    await finish();
    expect(parent.reviewLoop.failure.reason).toMatch(/did not push/);
    expect(parent.reviewLoop).toMatchObject({ sessionId: null, pendingResult: null });
    expect(deps.startAction).toHaveBeenCalledTimes(2);
  });

  it('bounds the loop and does not launch a fix it cannot review afterwards', async () => {
    parent.reviewLoop.rounds = REVIEW_LOOP_MAX_ROUNDS - 1;
    review.findings = [fix];
    await loop.tick(parent);
    await finish();
    expect(parent.reviewLoop.failure.reason).toMatch(/limit/);
    expect(deps.startAction).toHaveBeenCalledTimes(1);
  });

  it('does not repeat a finished review after a failed result read or restart', async () => {
    await loop.tick(parent);
    deps.readReview.mockRejectedValueOnce(new Error('database unavailable'));
    await finish();
    expect(parent.reviewLoop.pendingResult).toMatchObject({ success: true });
    sessions.clear(); // action was auto-deleted
    parent = structuredClone(parent); // restored job
    loop = createReviewLoop(deps);
    await loop.tick(parent);
    expect(parent.reviewLoop.failure.reason).toBe('database unavailable');
    parent.reviewLoop.failure = null; // explicit retry
    await loop.tick(parent);
    expect(parent.reviewLoop.done).toBe(true);
    expect(deps.startAction).toHaveBeenCalledTimes(1);
  });

  it('retains a completed fix after a failed PR read and reviews its push on retry', async () => {
    review.findings = [fix];
    await loop.tick(parent);
    await finish();
    pr.head.sha = 'head-b';
    deps.readPull.mockRejectedValueOnce(new Error('GitHub unavailable'));
    await finish();
    expect(parent.reviewLoop).toMatchObject({
      phase: 'fix',
      pendingResult: { success: true },
      failure: { reason: 'GitHub unavailable' },
    });
    sessions.clear(); // completed action was auto-deleted
    parent = structuredClone(parent); // restored job
    loop = createReviewLoop(deps);
    parent.reviewLoop.failure = null; // explicit retry
    await loop.tick(parent);
    expect(parent.reviewLoop).toMatchObject({
      phase: 'review',
      rounds: 2,
      headSha: 'head-b',
      pendingResult: null,
      failure: null,
    });
    expect(deps.startAction).toHaveBeenCalledTimes(3);
  });

  it('waits for a recovering child and consumes its persisted close result', async () => {
    await loop.tick(parent);
    const child = sessions.get(parent.reviewLoop.sessionId);
    child.status = 'interrupted';
    child.restartPending = true;
    await loop.tick(parent);
    expect(parent.reviewLoop.failure).toBeNull();
    child.restartPending = false;
    child.status = 'closed';
    child.reviewLoopDone = true;
    loop = createReviewLoop(deps);
    await loop.tick(parent);
    expect(parent.reviewLoop.done).toBe(true);
    expect(deps.startAction).toHaveBeenCalledTimes(1);
  });

  it('surfaces a failed or missing child instead of waiting forever', async () => {
    await loop.tick(parent);
    sessions.clear();
    await loop.tick(parent);
    expect(parent.reviewLoop.failure.reason).toMatch(/missing/);
    expect(deps.startAction).toHaveBeenCalledTimes(1);
  });

  it('does not advance a stopped action', async () => {
    await loop.tick(parent);
    await finish(false);
    expect(parent.reviewLoop.failure.reason).toMatch(/stopped/);
    expect(parent.reviewLoop.done).toBe(false);
  });

  it.each(['running', 'closed', 'failed'])('does not start actions while the task is %s', async (status) => {
    parent.status = status;
    await loop.tick(parent);
    expect(deps.startAction).not.toHaveBeenCalled();
  });

  it('does not answer a task question or overlap an existing action', async () => {
    parent.awaitingAnswer = true;
    await loop.tick(parent);
    expect(deps.startAction).not.toHaveBeenCalled();
    parent.awaitingAnswer = false;
    await loop.tick(parent);
    await loop.tick(parent);
    expect(deps.startAction).toHaveBeenCalledTimes(1);
  });

  it('rechecks readiness after an asynchronous read', async () => {
    deps.readPull.mockImplementationOnce(async () => {
      parent.status = 'running';
      return pr;
    });
    await loop.tick(parent);
    expect(deps.startAction).not.toHaveBeenCalled();
  });

  it('invalidates a pending read when a push resets the loop', async () => {
    parent.reviewLoop.headSha = 'head-a';
    deps.readPull.mockImplementationOnce(async () => {
      parent.prStatus = { headSha: 'head-b' };
      loop.pushed(parent);
      return pr;
    });
    await loop.tick(parent);
    expect(deps.startAction).not.toHaveBeenCalled();
    expect(parent.reviewLoop).toMatchObject({ headSha: null, rounds: 0 });
  });

  it('disarming during a result read prevents all later work', async () => {
    await loop.tick(parent);
    deps.readReview.mockImplementationOnce(async () => {
      parent.reviewLoop = null;
      return review;
    });
    await finish();
    expect(parent.reviewLoop).toBeNull();
    expect(deps.startAction).toHaveBeenCalledTimes(1);
  });

  it('serializes concurrent ticks', async () => {
    await Promise.all([loop.tick(parent), loop.tick(parent), loop.tick(parent)]);
    expect(deps.startAction).toHaveBeenCalledTimes(1);
  });

  it('reopens a settled loop only for a different commit', async () => {
    await loop.tick(parent);
    await finish();
    parent.prStatus = { headSha: 'head-a' };
    loop.pushed(parent);
    expect(parent.reviewLoop.done).toBe(true);
    parent.prStatus.headSha = 'head-b';
    loop.pushed(parent);
    expect(parent.reviewLoop).toMatchObject({ done: false, rounds: 0, phase: 'review' });
  });

  it('invalidates a completed verdict when another PR attaches at the same head', async () => {
    await loop.tick(parent);
    await finish();
    parent.prStatus = null; // releasePrLeftBehind clears the previous attachment
    parent.prStatus = { number: 43, headSha: 'head-a' };
    pr.number = 43;
    loop.pushed(parent);
    await loop.tick(parent);
    expect(parent.reviewLoop).toMatchObject({ done: false, prNumber: 43, rounds: 1 });
    expect(deps.startAction).toHaveBeenCalledTimes(2);
  });

  it.each(['before review', 'after review'])(
    'stops polling a closed PR %s, including after restart',
    async (when) => {
      if (when === 'after review') await loop.tick(parent);
      pr.state = 'closed';
      if (when === 'after review') await finish();
      else await loop.tick(parent);
      expect(parent.reviewLoop).toMatchObject({
        done: false,
        sessionId: null,
        pendingResult: null,
        failure: { reason: 'the pull request is no longer open' },
      });
      const reads = deps.readPull.mock.calls.length;
      parent = structuredClone(parent);
      loop = createReviewLoop(deps);
      for (let i = 0; i < 3; i++) await loop.tick(parent);
      expect(deps.readPull).toHaveBeenCalledTimes(reads);
      pr.state = 'open';
      parent.reviewLoop = newReviewLoop(); // explicit re-arm
      await loop.tick(parent);
      expect(parent.reviewLoop).toMatchObject({ failure: null, rounds: 1, prNumber: 42 });
      expect(deps.startAction).toHaveBeenCalledTimes(when === 'after review' ? 2 : 1);
    },
  );

  it('does not reset an active fix when its expected push arrives', async () => {
    review.findings = [fix];
    await loop.tick(parent);
    await finish();
    parent.prStatus = { headSha: 'head-b' };
    loop.pushed(parent);
    expect(parent.reviewLoop).toMatchObject({ phase: 'fix', rounds: 1 });
  });

  it('refuses fork heads and stops cleanly when the PR is closed', async () => {
    pr.head.repo.full_name = 'fork/repo';
    await loop.tick(parent);
    expect(parent.reviewLoop.failure.reason).toMatch(/head branch/);
    expect(deps.startAction).not.toHaveBeenCalled();
    parent.reviewLoop = newReviewLoop();
    pr.state = 'closed';
    await loop.tick(parent);
    expect(deps.startAction).not.toHaveBeenCalled();
  });
});
