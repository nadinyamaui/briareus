// @ts-check
// State lives on the task's job, not in timers or in the disposable action sessions.
// Only completed, verified reviews can advance the loop. GitHub labels are presentation,
// never a substitute for a stored verdict.
export const REVIEW_LOOP_MAX_ROUNDS = 10;

export function newReviewLoop() {
  return {
    version: 1,
    phase: 'review',
    rounds: 0,
    sessionId: null,
    pendingResult: null,
    headSha: null,
    prNumber: null,
    done: false,
    failure: null,
    findings: [],
  };
}

export function createReviewLoop({ getSession, readPull, readReview, startAction, canStart, save, report }) {
  const inflight = new Set();
  const changed = (parent, message) => {
    save(parent);
    if (message) report(parent, `Review loop: ${message}`);
  };
  const fail = (parent, loop, reason) => {
    loop.failure = { kind: 'failed', reason, at: new Date().toISOString() };
    changed(parent, `${reason}. Turn the review loop on again to retry.`);
  };
  const live = (parent, loop) =>
    parent.reviewLoop === loop && !parent.closing && !['closed', 'failed'].includes(parent.status);

  async function tick(parent) {
    const loop = parent.reviewLoop;
    if (!loop || loop.failure || !live(parent, loop) || inflight.has(parent.id)) return;
    if (loop.version !== 1) {
      fail(parent, loop, 'this task has retired review-loop state; re-arm it to use stored code reviews');
      return;
    }
    inflight.add(parent.id);
    try {
      if (loop.sessionId && !loop.pendingResult) {
        const child = getSession(loop.sessionId);
        if (
          child &&
          (child.restartPending || ['queued', 'preparing', 'running', 'idle'].includes(child.status))
        )
          return;
        // A restart between the child's close and its callback can still recover it.
        loop.pendingResult = {
          sessionId: loop.sessionId,
          success: child?.status === 'closed' && child.reviewLoopDone === true,
          error: child?.error || 'the action was stopped or its session is missing',
        };
        changed(parent);
      }
      if (loop.pendingResult) {
        const result = loop.pendingResult;
        if (!result.success) {
          loop.sessionId = null;
          loop.pendingResult = null;
          fail(parent, loop, result.error);
          return;
        }
        // Keep pendingResult until all reads succeed: a transient DB/API failure must
        // never turn a finished review into a second, paid review after a restart.
        const review = loop.phase === 'review' ? await readReview(result.sessionId) : null;
        if (!live(parent, loop)) return;
        const pr = await readPull(parent);
        if (!live(parent, loop)) return;
        if (pr.state !== 'open') {
          loop.sessionId = null;
          loop.pendingResult = null;
          fail(parent, loop, 'the pull request is no longer open');
          return;
        }
        if (pr.number !== loop.prNumber) {
          // The task may have opened a different stacked PR while this child ran.
          loop.phase = 'review';
          loop.rounds = 0;
          loop.findings = [];
        } else if (loop.phase === 'review') {
          if (!review || review.status !== 'completed' || !review.summary?.trim()) {
            fail(parent, loop, 'the review has no completed, stored report');
            return;
          }
          if (!review.headSha) {
            fail(parent, loop, 'the stored review does not identify the reviewed commit');
            return;
          }
          if (pr.head.sha !== review.headSha) {
            loop.phase = 'review';
            loop.findings = [];
          } else {
            const undecided = review.findings.some(
              (f) =>
                !['fix', 'optional', 'dismiss'].includes(f.shouldFix) ||
                (f.shouldFix === 'fix' && (f.verification !== 'confirmed' || !f.comments?.trim())),
            );
            if (undecided) {
              fail(parent, loop, 'a finding still needs verification or a fix decision');
              return;
            }
            loop.findings = review.findings.filter((f) => f.shouldFix === 'fix');
            if (!loop.findings.length) {
              loop.done = true;
              changed(parent, 'finished; no verified finding requires a fix.');
            } else {
              loop.phase = 'fix';
            }
          }
        } else {
          if (pr.head.sha === loop.headSha) {
            fail(parent, loop, 'implementing feedback did not push a new commit');
            return;
          }
          loop.phase = 'review';
          loop.findings = [];
        }
        loop.headSha = pr.head.sha;
        loop.sessionId = null;
        loop.pendingResult = null;
        changed(parent);
      }
      if (loop.done || loop.failure || !canStart(parent)) return;
      const pr = await readPull(parent);
      if (!live(parent, loop) || !canStart(parent)) return;
      if (pr.state !== 'open') {
        fail(parent, loop, 'the pull request is no longer open');
        return;
      }
      if (
        !pr.head?.sha ||
        !pr.head.ref ||
        pr.head.repo?.full_name?.toLowerCase() !== parent.repo.toLowerCase()
      ) {
        fail(parent, loop, 'review loops require a head branch in this project');
        return;
      }
      if (loop.phase === 'fix' && loop.headSha !== pr.head.sha) {
        loop.phase = 'review';
        loop.findings = [];
      }
      // At most ten reviews and nine fixes: never push fixes we cannot re-review.
      if (loop.rounds >= REVIEW_LOOP_MAX_ROUNDS) {
        fail(parent, loop, `stopped at the limit of ${REVIEW_LOOP_MAX_ROUNDS} review rounds`);
        return;
      }
      const child = await startAction(parent, loop, pr, () => live(parent, loop) && canStart(parent));
      if (!child) return;
      loop.sessionId = child.id;
      loop.headSha = pr.head.sha;
      loop.prNumber = pr.number;
      if (loop.phase === 'review') loop.rounds++;
      changed(
        parent,
        `${loop.phase === 'review' ? 'review' : 'feedback fix'} started (round ${loop.rounds}).`,
      );
    } catch (e) {
      if (live(parent, loop)) fail(parent, loop, e.message);
    } finally {
      inflight.delete(parent.id);
    }
  }

  function finished(parent, child) {
    const loop = parent?.reviewLoop;
    if (!loop || loop.sessionId !== child.id) return;
    loop.pendingResult = {
      sessionId: child.id,
      success: child.reviewLoopDone === true,
      error: child.error || 'the action was stopped before it finished',
    };
    changed(parent);
    return tick(parent);
  }

  // Only a settled loop is reset by a push or a new PR attachment. Active reviews
  // compare the live head with their starting head; active fixes are expected to push.
  function pushed(parent) {
    const loop = parent.reviewLoop;
    if (
      !loop ||
      loop.version !== 1 ||
      loop.sessionId ||
      loop.pendingResult ||
      (loop.headSha === parent.prStatus?.headSha &&
        (!parent.prStatus?.number || loop.prNumber === parent.prStatus.number))
    )
      return;
    parent.reviewLoop = newReviewLoop();
    changed(parent);
  }

  return { tick, finished, pushed };
}
