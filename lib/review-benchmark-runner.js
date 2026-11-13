// @ts-check
// Puts a benchmark run's cases through the real code review (lib/review-benchmark.js
// says what a case and a run are). For each case, in turn and a few at a time:
//
//   1. two branches at the case's base and head commits, under neutral names, and a pull
//      request between them with the case's title and description and nothing else;
//   2. a code review of that pull request started exactly as a person's would be, on
//      the project's configured review runtime, with discovery, publication,
//      verification and the label step all as they are for any pull request;
//   3. when the review ends, what it left (its execution status, its findings and their
//      verdicts, its outcome as the server computes it, its cost) kept with the result;
//   4. the pull request closed and the two branches deleted.
//
// Every step is recorded before the next starts and each one finds what it already made,
// so a run the server picks up after a restart neither opens a second pull request nor
// starts a second review. The answer is never part of any of it: the pull request is made
// from reviewerView alone.
//
// Each tick reads the state from the database, so there is nothing to recover in memory.
import { randomBytes } from 'node:crypto';
import { reviewerView } from './review-benchmark.js';

// A review that has not ended by then is given up on and counts as no result.
export const REVIEW_TIMEOUT_MS = 6 * 3_600_000;
// Answers that will not change by asking again: the case cannot be opened as it is.
const DEFINITIVE = [400, 404, 409, 422];

const githubError = (what, status, detail = '') =>
  Object.assign(new Error(`${what}: GitHub answered ${status}${detail ? ` (${detail})` : ''}`), {
    status,
    definitive: DEFINITIVE.includes(status),
  });

async function detail(res) {
  try {
    const body = await res.json();
    return body?.message || '';
  } catch {
    return '';
  }
}

/**
 * @param {{
 *   store: ReturnType<typeof import('./review-benchmark-store.js').createBenchmarkStore>,
 *   github: (method: string, path: string, body?: any) => Promise<{ ok: boolean, status: number, json: () => Promise<any> }>,
 *   getProject: (repo: string) => any,
 *   startReview: (input: { project: any, prNumber: number, ownerId: number | null }) => Promise<{ jobId: string }>,
 *   findReview: (repo: string, prNumber: number, jobId?: string | null) => Promise<any | null>,
 *   readOutcome: (project: any, prNumber: number) => Promise<any>,
 *   closeSession?: (jobId: string, why: string) => Promise<unknown>,
 *   now?: () => number,
 *   timeoutMs?: number,
 *   branchName?: () => string,
 *   log?: (message: string) => void,
 * }} deps
 * `findReview` answers the code review of the pull request (the one `jobId` ran when
 * given, else the latest), with its findings and stages (lib/db.js listPullCodeReviews).
 */
export function createBenchmarkRunner({
  store,
  github,
  getProject,
  startReview,
  findReview,
  readOutcome,
  closeSession = async () => {},
  now = () => Date.now(),
  timeoutMs = REVIEW_TIMEOUT_MS,
  branchName = () => `review/${randomBytes(5).toString('hex')}`,
  log = (message) => console.error(message),
}) {
  let ticking = null;

  // `field` names the result's column the branch is recorded in, so that a branch found
  // at another commit, which is somebody else's, is forgotten and never deleted.
  async function ensureBranch(repo, name, sha, field) {
    const res = await github('POST', `/repos/${repo}/git/refs`, { ref: `refs/heads/${name}`, sha });
    if (res.ok) return;
    if (res.status === 422) {
      // Made by an earlier attempt that did not get to record it, or somebody else's.
      const found = await github('GET', `/repos/${repo}/git/ref/heads/${encodeURI(name)}`);
      if (found.ok) {
        const ref = await found.json();
        if (ref?.object?.sha === sha) return;
        throw Object.assign(new Error(`Branch ${name} exists at another commit`), {
          definitive: true,
          forget: { [field]: null },
        });
      }
      // No such branch: the 422 was about something else and stands. Any other failed
      // lookup says nothing about the branch, so its answer decides whether to try again.
      if (found.status !== 404)
        throw githubError(`Looking up branch ${name}`, found.status, await detail(found));
    }
    throw githubError(`Creating branch ${name} at ${sha.slice(0, 7)}`, res.status, await detail(res));
  }

  async function openPull(repo, result) {
    const owner = repo.split('/')[0];
    const listed = await github(
      'GET',
      `/repos/${repo}/pulls?state=all&head=${encodeURIComponent(`${owner}:${result.headBranch}`)}&per_page=5`,
    );
    if (!listed.ok) throw githubError('Looking for the pull request', listed.status);
    const existing = (await listed.json()).find((pr) => pr?.head?.ref === result.headBranch);
    if (existing) return existing.number;
    const view = reviewerView(result.answer.change);
    const res = await github('POST', `/repos/${repo}/pulls`, {
      title: view.title,
      body: view.body,
      head: result.headBranch,
      base: result.baseBranch,
      maintainer_can_modify: false,
    });
    if (!res.ok) throw githubError('Opening the pull request', res.status, await detail(res));
    return (await res.json()).number;
  }

  // Branches, pull request and review session, each skipped when already recorded.
  async function open(run, project, result) {
    let r = result;
    if (!r.headBranch) {
      const head = branchName();
      const moved = await store.updateResult(
        r.id,
        { headBranch: head, baseBranch: `${head}-base`, state: 'opening', startedAt: now(), error: null },
        { from: ['queued'] },
      );
      if (!moved) return;
      r = { ...r, headBranch: head, baseBranch: `${head}-base`, state: 'opening' };
    }
    const change = r.answer.change;
    await ensureBranch(run.repo, r.baseBranch, change.baseSha, 'baseBranch');
    await ensureBranch(run.repo, r.headBranch, change.headSha, 'headBranch');
    if (r.prNumber == null) {
      const prNumber = await openPull(run.repo, r);
      // Recorded whatever the state now is, so a cancelled case still gets closed.
      await store.updateResult(r.id, { prNumber });
      r = { ...r, prNumber };
    }
    // A review this result already started, found after a restart, is the one.
    let jobId = r.jobId || (await findReview(run.repo, r.prNumber))?.jobId || null;
    if (!jobId) {
      const current = (await store.getRun(null, run.id))?.results.find((x) => x.id === r.id);
      if (current?.state !== 'opening') return;
      jobId = (await startReview({ project, prNumber: r.prNumber, ownerId: run.requestedBy })).jobId;
    }
    const moved = await store.updateResult(
      r.id,
      { jobId, state: 'reviewing', error: null },
      { from: ['opening'] },
    );
    if (!moved) {
      await store.updateResult(r.id, { jobId });
      await closeSession(jobId, 'The benchmark run was cancelled').catch(() => {});
    }
  }

  // What the review left, once it ended, kept with the result.
  function snapshot(result, review, outcome) {
    const own = outcome && outcome.reviewId === review.id;
    return {
      codeReviewId: review.id,
      status: review.status,
      headSha: review.headSha ?? null,
      provider: review.provider || null,
      model: review.model || null,
      effort: review.effort || null,
      costUsd: review.costUsd ?? null,
      costEstimated: !!review.costEstimated,
      unpricedTurns: review.unpricedTurns || 0,
      inputTokens: review.inputTokens ?? null,
      outputTokens: review.outputTokens ?? null,
      // Another review's outcome is not this one's: none is better than a wrong one.
      outcome: own
        ? {
            outcome: outcome.outcome,
            reasons: (outcome.reasons || []).map((x) => ({
              code: x.code,
              effect: x.effect ?? null,
              ...(x.stage ? { stage: x.stage } : {}),
            })),
          }
        : null,
      stages: (review.stages || []).map((s) => ({ stage: s.stage, status: s.status })),
      findings: (review.findings || []).map((f) => ({
        id: f.id,
        severity: f.severity,
        type: f.type || '',
        security: !!f.security,
        shouldFix: f.shouldFix ?? null,
        verification: f.verification ?? null,
        title: f.title,
        body: f.body ?? null,
        filePath: f.filePath ?? null,
        startLine: f.startLine ?? null,
        endLine: f.endLine ?? null,
        comments: f.comments ?? null,
        reconciliation: f.reconciliation || 'new',
      })),
      startedAt: result.startedAt,
      endedAt: now(),
    };
  }

  async function watch(run, project, result) {
    const review = await findReview(run.repo, result.prNumber, result.jobId);
    const overdue = result.startedAt != null && now() - result.startedAt > timeoutMs;
    if (!review || review.status === 'running') {
      if (!overdue) return;
      if (result.jobId)
        await closeSession(result.jobId, 'The benchmark gave up waiting for this review').catch(() => {});
      await store.updateResult(
        result.id,
        {
          state: 'failed',
          error: review ? 'The review did not end in time' : 'No review was recorded for the pull request',
          review: review ? snapshot(result, review, null) : null,
          codeReviewId: review?.id ?? null,
          endedAt: now(),
        },
        { from: ['reviewing'] },
      );
      return;
    }
    // A failed read is thrown, so the case stays reviewing and is read again next tick
    // (until the deadline) rather than kept as done without its outcome.
    const outcome = await readOutcome(project, result.prNumber);
    await store.updateResult(
      result.id,
      { state: 'done', review: snapshot(result, review, outcome), codeReviewId: review.id, endedAt: now() },
      { from: ['reviewing'] },
    );
  }

  async function cleanUp(run, result) {
    try {
      if (result.prNumber != null) {
        const res = await github('PATCH', `/repos/${run.repo}/pulls/${result.prNumber}`, { state: 'closed' });
        if (!res.ok && res.status !== 404 && res.status !== 422)
          throw githubError(`Closing pull request #${result.prNumber}`, res.status);
      }
      for (const name of [result.headBranch, result.baseBranch].filter(Boolean)) {
        const res = await github('DELETE', `/repos/${run.repo}/git/refs/heads/${encodeURI(name)}`);
        if (!res.ok && res.status !== 404 && res.status !== 422)
          throw githubError(`Deleting branch ${name}`, res.status);
      }
      await store.updateResult(result.id, { cleanedAt: now(), cleanupError: null });
    } catch (e) {
      await store.updateResult(result.id, { cleanupError: e.message }).catch(() => {});
    }
  }

  const FINAL = ['done', 'failed', 'cancelled'];
  const madeSomething = (r) => r.prNumber != null || r.headBranch != null || r.baseBranch != null;

  async function advance(id) {
    const run = await store.getRun(null, id);
    if (!run) return;
    const project = getProject(run.repo);
    const usable = !!project && project.reviewBenchmark === true;
    for (const result of run.results) {
      if (run.status !== 'running' || !['opening', 'reviewing'].includes(result.state)) continue;
      try {
        if (!usable)
          throw Object.assign(new Error('The project is no longer set aside for the benchmark'), {
            definitive: true,
          });
        if (result.state === 'opening') await open(run, project, result);
        else await watch(run, project, result);
      } catch (e) {
        // A definitive refusal ends the case; anything else is tried again next tick,
        // until the case has tried for as long as a review may run.
        const overdue = result.startedAt != null && now() - result.startedAt > timeoutMs;
        const ends = e.definitive || overdue;
        const ended = await store.updateResult(
          result.id,
          ends ? { state: 'failed', error: e.message, endedAt: now(), ...e.forget } : { error: e.message },
          ends ? { from: ['opening', 'reviewing'] } : {},
        );
        // Its review is stopped before cleanup closes the pull request under it.
        if (ends && ended && result.jobId)
          await closeSession(result.jobId, 'The benchmark gave up on this case').catch(() => {});
      }
    }
    let current = (await store.getRun(null, id)) || run;
    if (current.status === 'running') {
      let active = current.results.filter((r) => ['opening', 'reviewing'].includes(r.state)).length;
      for (const result of current.results) {
        if (active >= current.concurrency) break;
        if (result.state !== 'queued') continue;
        active++;
        try {
          if (!usable)
            throw Object.assign(new Error('The project is no longer set aside for the benchmark'), {
              definitive: true,
            });
          await open(current, project, result);
        } catch (e) {
          await store.updateResult(
            result.id,
            e.definitive
              ? { state: 'failed', error: e.message, endedAt: now(), ...e.forget }
              : { error: e.message },
            e.definitive ? { from: ['queued', 'opening'] } : {},
          );
        }
      }
      current = (await store.getRun(null, id)) || current;
    }
    for (const result of current.results)
      if (FINAL.includes(result.state) && result.cleanedAt == null && madeSomething(result))
        await cleanUp(current, result);
    // A run ends once every case has. Cleanup that keeps failing is still retried on the
    // ended run (store.listRunningRuns), but does not hold the project's next run back.
    const after = (await store.getRun(null, id)) || current;
    const settled = after.results.every((r) => FINAL.includes(r.state));
    if (after.status === 'running' && settled) await store.finishRun(id, 'completed');
  }

  // One pass over every run with work left. A pass still going makes the next one wait
  // for it rather than run beside it.
  async function tick() {
    if (ticking) return ticking;
    ticking = (async () => {
      try {
        for (const id of await store.listRunningRuns()) {
          await advance(id).catch((e) => log(`Benchmark run ${id}: ${e.message}`));
        }
      } finally {
        ticking = null;
      }
    })();
    return ticking;
  }

  // A cancelled run's reviews under way are stopped; what they made is cleaned up by the
  // next ticks.
  async function cancelled(run) {
    for (const result of run.results)
      if (result.jobId && !result.review && result.state === 'cancelled')
        await closeSession(result.jobId, 'The benchmark run was cancelled').catch(() => {});
  }

  return { tick, advance, cancelled };
}
