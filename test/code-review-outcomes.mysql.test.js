import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import mysql from 'mysql2/promise';

// Opt in against a real MySQL server, like test/code-review-rounds.mysql.test.js:
// lib/db.js is pointed at a randomly named database that only this file creates and
// drops, built the way the server builds it at boot. What is exercised here is the SQL
// the in-memory suites stand in for: the schema, the stage records bound to a head, the
// outcome computed and stored under the pull request's row lock, and what is recorded of
// a commit status GitHub took or refused. GitHub itself is a stubbed `fetch`.
const scratch = vi.hoisted(() => ({
  database: `briareus_outcome_test_${Math.random().toString(16).slice(2, 14)}`,
}));
vi.mock('../lib/config.js', async (importOriginal) => {
  const real = await importOriginal();
  return {
    ...real,
    getConfig: () => ({ ...real.getConfig(), db: { ...real.getConfig().db, database: scratch.database } }),
  };
});

import { getConfig } from '../lib/config.js';
import {
  addCodeReviewFinding,
  beginCodeReviewStages,
  claimCodeReviewRound,
  clearCodeReviewStatusFailure,
  completeCodeReview,
  createCodeReview,
  dbHealthy,
  failCodeReview,
  failRunningCodeReviewStages,
  getCodeReviewByJob,
  getCodeReviewOutcome,
  getProjectRow,
  listCodeReviewStages,
  listFailedCodeReviewStatuses,
  listPullCodeReviews,
  readCodeReviewOutcomeState,
  recordCodeReviewStatusFailed,
  recordCodeReviewStatusPublished,
  refreshCodeReviewOutcome,
  restartCodeReview,
  saveCodeReviewDecisions,
  saveProject,
  setCodeReviewStage,
  updateCodeReviewFinding,
} from '../lib/db.js';
import {
  provisionalReviewOutcome,
  readReviewOutcome,
  refreshReviewOutcome,
  retryReviewStatuses,
  reviewStatusFailures,
} from '../lib/review-enforcement.js';
import { requiredReviewStages } from '../lib/review-outcome.js';
import { up, down } from '../migrations/2026_11_10_140000_add_code_review_outcomes.js';

describe.skipIf(process.env.CODE_REVIEW_MYSQL !== '1')('code review outcomes on MySQL', () => {
  const repo = 'acme/shop';
  const sha = (letter) => letter.repeat(40);
  const STAGES = requiredReviewStages();
  const off = { repo, reviewRoundLimit: 3 };
  const on = { ...off, enforceReviewOutcome: true };
  const cfg = { githubToken: 'server-token' };
  let bootstrap, pool, requests, answers;
  const columns = async (table) => {
    const [rows] = await pool.query(
      'SELECT COLUMN_NAME AS name FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION',
      [table],
    );
    return rows.map((r) => r.name);
  };
  const tables = async () => {
    const [rows] = await pool.query(
      "SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN ('code_review_stages', 'code_review_outcomes') ORDER BY TABLE_NAME",
    );
    return rows.map((r) => r.name);
  };
  // A review whose discovery verified `letter`'s head against `baseRef`.
  async function started(prNumber, letter, { baseRef = 'main', stages = STAGES } = {}) {
    const jobId = `job-${prNumber}-${letter}`;
    await createCodeReview({ jobId, repo, prNumber, branch: 'feature' });
    await restartCodeReview(jobId, sha(letter));
    const id = await beginCodeReviewStages(jobId, { headSha: sha(letter), baseRef, stages });
    return { jobId, id, head: sha(letter) };
  }
  // The same, run to its end with every stage seen to complete.
  async function reviewed(prNumber, letter, options) {
    const review = await started(prNumber, letter, options);
    for (const stage of options?.stages || STAGES)
      await setCodeReviewStage(review.jobId, stage, review.head, { status: 'completed' });
    await completeCodeReview(review.jobId);
    return review;
  }
  const verdict = (over = {}) => ({
    severity: 'medium',
    title: 'Lost update',
    shouldFix: 'optional',
    verification: 'confirmed',
    comments: 'Style only, lib/cart.js:44',
    findingRef: `ref-${Math.random().toString(16).slice(2, 10)}`,
    ...over,
  });
  const posted = () =>
    requests.filter((r) => r.method === 'POST').map((r) => [r.url.split('/').pop(), r.body.state]);
  const refresh = async (project, prNumber, options = {}) => {
    const { outcome, published } = await refreshReviewOutcome(project, prNumber, {
      cfg,
      retryDelayMs: 0,
      ...options,
    });
    return { outcome, published: await published };
  };

  beforeAll(async () => {
    const { database, ...config } = getConfig().db;
    expect(database).toBe(scratch.database);
    bootstrap = await mysql.createConnection(config);
    // The first query makes lib/db.js create the database and run every migration.
    expect(await dbHealthy()).toBe(true);
    pool = mysql.createPool({ ...config, database, connectionLimit: 3 });
    requests = [];
    answers = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url, init) => {
        requests.push({ url, method: init.method, body: init.body ? JSON.parse(init.body) : null });
        return (
          answers.shift() ||
          new Response('{}', { status: 201, headers: { 'content-type': 'application/json' } })
        );
      }),
    );
  }, 120_000);
  afterAll(async () => {
    vi.unstubAllGlobals();
    await pool?.end();
    await bootstrap?.query(`DROP DATABASE IF EXISTS \`${scratch.database}\``);
    await bootstrap?.end();
  });

  it('adds the tables, the reviewed base and the project switch at boot, and applies twice', async () => {
    // By name, not as the latest: later migrations follow it.
    const [ran] = await pool.query('SELECT `migration` FROM `migrations` WHERE `migration` = ?', [
      '2026_11_10_140000_add_code_review_outcomes',
    ]);
    expect(ran).toHaveLength(1);
    expect(await tables()).toEqual(['code_review_outcomes', 'code_review_stages']);
    const reviews = await columns('code_reviews');
    expect(reviews[reviews.indexOf('branch') + 1]).toBe('base_ref');
    const projects = await columns('projects');
    expect(projects[projects.indexOf('review_round_limit') + 1]).toBe('enforce_review_outcome');
    await up({ context: pool });
    await up({ context: pool });
    expect(await columns('code_reviews')).toEqual(reviews);
    expect(await columns('projects')).toEqual(projects);
    expect(await columns('code_review_stages')).toEqual([
      'id',
      'code_review_id',
      'stage',
      'head_sha',
      'status',
      'detail',
      'started_at',
      'ended_at',
      'created_at',
      'updated_at',
    ]);
    expect(await columns('code_review_outcomes')).toEqual([
      'repo',
      'pr_number',
      'code_review_id',
      'head_sha',
      'base_ref',
      'outcome',
      'stale',
      'reasons',
      'computed_at',
      'status_state',
      'status_description',
      'published_sha',
      'published_state',
      'published_description',
      'published_at',
      'publish_error',
      'publish_error_status',
      'publish_attempts',
      'publish_failed_at',
      'publish_retry_at',
      'created_at',
      'updated_at',
    ]);
  });

  it('stores the project switch, off for a project that never set it', async () => {
    await pool.query(
      "INSERT INTO `projects` (`repo`, `label`, `created_at`, `updated_at`) VALUES ('acme/legacy', 'Legacy', 1, 1)",
    );
    const [rows] = await pool.query("SELECT `id` FROM `projects` WHERE `repo` = 'acme/legacy'");
    const legacy = await getProjectRow(rows[0].id);
    expect(legacy.enforceReviewOutcome).toBe(false);
    expect((await saveProject({ ...legacy, enforceReviewOutcome: true })).enforceReviewOutcome).toBe(true);
    expect((await saveProject({ ...legacy, enforceReviewOutcome: false })).enforceReviewOutcome).toBe(false);
    const created = await saveProject({ repo: 'acme/new', label: 'New', enabled: true });
    expect(created.enforceReviewOutcome).toBe(false);
  });

  it('starts a review’s stage records with its discovery, for the head and base it verified', async () => {
    expect(
      await beginCodeReviewStages('job-nobody', { headSha: sha('a'), baseRef: 'main', stages: STAGES }),
    ).toBe(null);
    const review = await started(7, 'a', { stages: requiredReviewStages({ delegation: true }) });
    expect(review.id).toBeGreaterThan(0);
    expect(await getCodeReviewByJob(review.jobId)).toMatchObject({ headSha: sha('a'), baseRef: 'main' });
    const rows = await listCodeReviewStages(review.id);
    expect(rows.map((s) => [s.stage, s.status, s.headSha])).toEqual([
      ['discover', 'running', sha('a')],
      ['publish', 'pending', sha('a')],
      ['delegation', 'pending', sha('a')],
      ['verify', 'pending', sha('a')],
      ['label', 'pending', sha('a')],
    ]);
    expect(rows[0].startedAt).toBeTruthy();
    expect(rows[1]).toMatchObject({ startedAt: null, endedAt: null, detail: null });
    // The stored review lists them, in the order they run.
    const [listed] = await listPullCodeReviews(repo, 7, 1);
    expect(listed.stages.map((s) => s.stage)).toEqual([
      'discover',
      'publish',
      'delegation',
      'verify',
      'label',
    ]);
    expect(listed.baseRef).toBe('main');
  });

  it('records a stage only for the head the review holds, and keeps when it first started', async () => {
    const jobId = 'job-7-a';
    const { id } = await getCodeReviewByJob(jobId);
    const at = async (stage) => (await listCodeReviewStages(id)).find((s) => s.stage === stage);
    // A late write from a run on another head marks nothing.
    expect(await setCodeReviewStage(jobId, 'discover', sha('z'), { status: 'completed' })).toBe(false);
    expect(await setCodeReviewStage('job-nobody', 'discover', sha('a'), { status: 'completed' })).toBe(false);
    expect((await at('discover')).status).toBe('running');
    expect(await setCodeReviewStage(jobId, 'discover', sha('a'), { status: 'completed' })).toBe(true);
    expect(await at('discover')).toMatchObject({ status: 'completed', detail: null });
    expect((await at('discover')).endedAt).toBeTruthy();
    await setCodeReviewStage(jobId, 'publish', sha('a'), { status: 'running' });
    const first = (await at('publish')).startedAt;
    expect(first).toBeTruthy();
    await new Promise((resolve) => setTimeout(resolve, 5));
    // Recovered after a restart: under way again, dated from its first start.
    await setCodeReviewStage(jobId, 'publish', sha('a'), { status: 'running' });
    expect(await at('publish')).toMatchObject({ status: 'running', startedAt: first, endedAt: null });
    await setCodeReviewStage(jobId, 'publish', sha('a'), {
      status: 'completed',
      detail: { unlinked: [4, 9] },
    });
    expect(await at('publish')).toMatchObject({ status: 'completed', detail: { unlinked: [4, 9] } });
    // The review stops while verification runs: only that stage fails, with why.
    await setCodeReviewStage(jobId, 'verify', sha('a'), { status: 'running' });
    // Of the run on this head: a failure reported for another head marks nothing.
    await failRunningCodeReviewStages(jobId, sha('z'), { error: 'Another run' });
    expect((await at('verify')).status).toBe('running');
    await failRunningCodeReviewStages(jobId, sha('a'), { error: 'Codex entry exited with code 1' });
    expect((await listCodeReviewStages(id)).map((s) => s.status)).toEqual([
      'completed',
      'completed',
      'pending',
      'failed',
      'pending',
    ]);
    expect((await at('verify')).detail).toEqual({ error: 'Codex entry exited with code 1' });
  });

  it('starts the records over when the review is run again, and drops them with the review', async () => {
    const jobId = 'job-7-a';
    const { id } = await getCodeReviewByJob(jobId);
    // A rerun resets the review; with no records it cannot pass until they are begun again.
    await restartCodeReview(jobId, sha('b'));
    expect(await listCodeReviewStages(id)).toEqual([]);
    expect(await getCodeReviewByJob(jobId)).toMatchObject({ headSha: sha('b'), baseRef: null });
    expect(await beginCodeReviewStages(jobId, { headSha: sha('b'), baseRef: 'Main', stages: STAGES })).toBe(
      id,
    );
    // Branch names are case-sensitive.
    expect((await getCodeReviewByJob(jobId)).baseRef).toBe('Main');
    expect((await listCodeReviewStages(id)).map((s) => [s.stage, s.status, s.headSha])).toEqual([
      ['discover', 'running', sha('b')],
      ['publish', 'pending', sha('b')],
      ['verify', 'pending', sha('b')],
      ['label', 'pending', sha('b')],
    ]);
    await pool.query('DELETE FROM `code_reviews` WHERE `id` = ?', [id]);
    const [left] = await pool.query(
      'SELECT COUNT(*) AS n FROM `code_review_stages` WHERE `code_review_id` = ?',
      [id],
    );
    expect(Number(left[0].n)).toBe(0);
  });

  it('computes and stores a pull request’s outcome from what the tables hold', async () => {
    // Nothing reviewed yet.
    expect(await getCodeReviewOutcome(repo, 20)).toBeNull();
    expect((await readReviewOutcome(off, 20)).outcome).toBe('pending');
    // Reading computes and writes nothing.
    expect(await getCodeReviewOutcome(repo, 20)).toBeNull();
    const review = await started(20, 'a');
    const first = await refresh(off, 20, { reviewId: review.id });
    expect(first.outcome).toMatchObject({ outcome: 'pending', reviewId: review.id, headSha: sha('a') });
    expect(first.outcome.reasons.map((r) => r.code)).toEqual(['review_running']);
    expect(first.published).toEqual({ published: false, skipped: 'not_enforced' });
    for (const stage of STAGES)
      await setCodeReviewStage(review.jobId, stage, sha('a'), { status: 'completed' });
    await completeCodeReview(review.jobId);
    const optional = await addCodeReviewFinding(review.id, verdict());
    const dismissed = await addCodeReviewFinding(
      review.id,
      verdict({ shouldFix: 'dismiss', verification: 'plausible', title: 'Maybe a race — “unproven”' }),
    );
    const { outcome } = await refresh(off, 20);
    expect(outcome.outcome).toBe('incomplete');
    expect(outcome.reasons).toEqual([
      expect.objectContaining({ code: 'dismissal_unproven', findingId: dismissed.id, effect: 'incomplete' }),
    ]);
    // Stored as computed, the reasons and the status it maps to included.
    const row = await getCodeReviewOutcome(repo, 20);
    expect(row).toMatchObject({
      repo,
      prNumber: 20,
      codeReviewId: review.id,
      headSha: sha('a'),
      baseRef: 'main',
      outcome: 'incomplete',
      stale: false,
      statusState: 'error',
      publishedSha: null,
      publishAttempts: 0,
    });
    expect(row.reasons).toEqual(outcome.reasons);
    expect(row.statusDescription).toContain('Review incomplete: "Maybe a race — “unproven”" was dismissed');
    expect(row.statusDescription.length).toBeLessThanOrEqual(140);
    expect(row.computedAt).toBeTruthy();
    // A client proves the dismissal: the next computation passes, with both findings counted.
    await updateCodeReviewFinding(review.id, dismissed.id, { verification: 'confirmed' });
    const passed = await refresh(off, 20);
    expect(passed.outcome).toMatchObject({ outcome: 'passed', reasons: [], execution: 'completed' });
    expect(passed.outcome.status).toMatchObject({
      state: 'success',
      description: 'Review passed at aaaaaaa: 1 optional, 1 dismissed, nothing to fix',
      published: false,
    });
    expect(passed.outcome.stages.map((s) => [s.stage, s.status])).toEqual(
      STAGES.map((s) => [s, 'completed']),
    );
    // And a required fix turns it again.
    await updateCodeReviewFinding(review.id, optional.id, { shouldFix: 'fix' });
    expect((await refresh(off, 20)).outcome.outcome).toBe('changes_required');
    expect((await getCodeReviewOutcome(repo, 20)).outcome).toBe('changes_required');
    await updateCodeReviewFinding(review.id, optional.id, { shouldFix: 'optional' });
    expect((await refresh(off, 20)).outcome.outcome).toBe('passed');
  });

  it('reads the decisions standing on the pull request and its rounds into the outcome', async () => {
    const state = await readCodeReviewOutcomeState(repo, 20);
    expect(state.review.id).toBe((await getCodeReviewByJob('job-20-a')).id);
    expect(state).toMatchObject({ decisions: [], count: null, rounds: [] });
    expect(state.findings).toHaveLength(2);
    expect(state.stages).toHaveLength(4);
    await saveCodeReviewDecisions(repo, 20, [
      {
        anchor: 'PRRT_owed',
        threadId: 'PRRT_owed',
        findingRef: 'ref-owed',
        title: 'Leaks the token',
        verdict: 'fix',
        source: 'review',
        decidedAt: Date.now(),
      },
    ]);
    const owed = await refresh(off, 20);
    expect(owed.outcome.outcome).toBe('changes_required');
    expect(owed.outcome.reasons).toEqual([
      expect.objectContaining({ code: 'fix_owed', findingRef: 'ref-owed', threadId: 'PRRT_owed' }),
    ]);
    // The round the review ran as gives the base tip and merge base it reviewed against.
    const claim = (headSha, jobId) =>
      claimCodeReviewRound({ repo, prNumber: 20, headSha, baseRef: 'main', source: 'user', jobId }, () => ({
        action: 'create',
        stale: [],
      }));
    await claim(sha('a'), 'job-20-a');
    const { review, rounds, count } = await readCodeReviewOutcomeState(repo, 20);
    expect(review.round).toBe(1);
    expect(count.rounds).toBe(1);
    expect(rounds.map((r) => [r.round, r.headSha])).toEqual([[1, sha('a')]]);
    expect((await readReviewOutcome(off, 20)).reviewed).toMatchObject({
      headSha: sha('a'),
      baseRef: 'main',
      round: 1,
    });
    // At the limit, a head nobody reviewed waits on a person.
    const limited = await readReviewOutcome({ ...off, reviewRoundLimit: 1 }, 20, {
      current: { headSha: sha('b') },
    });
    expect(limited).toMatchObject({ outcome: 'incomplete', stale: true });
    expect(limited.reasons.map((r) => r.code)).toEqual(['head_moved', 'round_limit_reached']);
  });

  it('binds the outcome to the reviewed head and base, and to the review a discovery names', async () => {
    const first = await reviewed(21, 'a');
    expect((await refresh(off, 21, { reviewId: first.id })).outcome.outcome).toBe('passed');
    // The pull request moved on: stale, and stored for the head it has now.
    const moved = await refresh(off, 21, { current: { headSha: sha('b'), baseRef: 'main' } });
    expect(moved.outcome).toMatchObject({ outcome: 'pending', stale: true, headSha: sha('b') });
    expect(await getCodeReviewOutcome(repo, 21)).toMatchObject({
      outcome: 'pending',
      stale: true,
      headSha: sha('b'),
      codeReviewId: first.id,
    });
    // A later computation that saw nothing new keeps the head the server knows.
    expect((await refresh(off, 21)).outcome).toMatchObject({ outcome: 'pending', headSha: sha('b') });
    // A second session reviews the new head: from its discovery on, its review governs.
    const second = await reviewed(21, 'b');
    const taken = await refresh(off, 21, {
      reviewId: second.id,
      current: { headSha: sha('b'), baseRef: 'main' },
    });
    expect(taken.outcome).toMatchObject({ outcome: 'passed', stale: false, reviewId: second.id });
    expect((await getCodeReviewOutcome(repo, 21)).codeReviewId).toBe(second.id);
    // Retargeted to a branch that differs only by case: another base, so stale.
    const retargeted = await refresh(off, 21, { current: { headSha: sha('b'), baseRef: 'Main' } });
    expect(retargeted.outcome).toMatchObject({ outcome: 'pending', stale: true, baseRef: 'Main' });
    expect((await getCodeReviewOutcome(repo, 21)).baseRef).toBe('Main');
    await refresh(off, 21, { current: { headSha: sha('b'), baseRef: 'main' } });
    // That review is deleted: the latest one stored stands in, and it reviewed another head.
    await pool.query('DELETE FROM `code_reviews` WHERE `id` = ?', [second.id]);
    const fallback = await refresh(off, 21);
    expect(fallback.outcome).toMatchObject({ outcome: 'pending', stale: true, reviewId: first.id });
    // Another pull request of the same repository has its own row.
    expect(await getCodeReviewOutcome(repo, 22)).toBeNull();
  });

  it('reads a review from before stages were recorded as incomplete, never as passed', async () => {
    // As the earlier schema left it: a completed review with findings and no stage rows.
    await createCodeReview({ jobId: 'job-legacy', repo, prNumber: 30, branch: 'feature' });
    await restartCodeReview('job-legacy', sha('a'));
    await completeCodeReview('job-legacy');
    const { outcome } = await refresh(off, 30);
    expect(outcome).toMatchObject({ outcome: 'incomplete', execution: 'completed', stages: [] });
    expect(outcome.reasons.map((r) => r.code)).toEqual(['stages_not_recorded']);
    expect(outcome.reviewed).toMatchObject({ headSha: sha('a'), baseRef: null });
    expect((await getCodeReviewOutcome(repo, 30)).statusState).toBe('error');
  });

  it('reads an interrupted review as incomplete, by the stage that was under way', async () => {
    const review = await started(31, 'a');
    await setCodeReviewStage(review.jobId, 'discover', sha('a'), { status: 'completed' });
    await setCodeReviewStage(review.jobId, 'publish', sha('a'), { status: 'running' });
    // Still running: the server may be restarting, and recovery resumes the step.
    expect((await refresh(off, 31, { reviewId: review.id })).outcome.outcome).toBe('pending');
    // The session is gone for good and its review is settled as failed.
    await failCodeReview(review.jobId);
    const { outcome } = await refresh(off, 31);
    expect(outcome).toMatchObject({ outcome: 'incomplete', execution: 'failed' });
    expect(outcome.reasons.map((r) => [r.code, r.stage])).toEqual([
      ['stage_interrupted', 'publish'],
      ['stage_not_run', 'verify'],
      ['stage_not_run', 'label'],
    ]);
  });

  it('gives the label step this review’s reading, and nothing from another review', async () => {
    const review = await started(32, 'a');
    for (const stage of ['discover', 'publish', 'verify'])
      await setCodeReviewStage(review.jobId, stage, sha('a'), { status: 'completed' });
    await setCodeReviewStage(review.jobId, 'label', sha('a'), { status: 'running' });
    expect((await provisionalReviewOutcome(on, 32, { reviewId: review.id })).outcome).toBe('passed');
    expect((await provisionalReviewOutcome(on, 32, { reviewId: review.id + 1000 })).outcome).toBe('pending');
    expect((await provisionalReviewOutcome(on, 32, { reviewId: null })).outcome).toBe('pending');
    // Asking stores nothing.
    expect(await getCodeReviewOutcome(repo, 32)).toBeNull();
  });

  it('computes one pull request’s outcome at a time, under its row lock', async () => {
    await reviewed(40, 'a');
    await refresh(off, 40);
    // Another connection holds the pull request's outcome row.
    const holder = await pool.getConnection();
    await holder.beginTransaction();
    await holder.query(
      'SELECT * FROM `code_review_outcomes` WHERE `repo` = ? AND `pr_number` = ? FOR UPDATE',
      [repo, 40],
    );
    let settled = false;
    const waiting = refreshCodeReviewOutcome(repo, 40, {}, (state) => ({
      outcome: 'incomplete',
      stale: false,
      reasons: [{ code: 'seen', findings: state.findings.length }],
      headSha: sha('a'),
      baseRef: 'main',
      statusState: 'error',
      statusDescription: 'x',
    })).then((result) => {
      settled = true;
      return result;
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(settled).toBe(false);
    // What is committed before the lock is released is what the waiting one reads.
    const { id } = await getCodeReviewByJob('job-40-a');
    await addCodeReviewFinding(id, verdict());
    await holder.commit();
    holder.release();
    const result = await waiting;
    expect(result.row.reasons).toEqual([{ code: 'seen', findings: 1 }]);
    // Many at once all land, none deadlocks, and the row is whole.
    const results = await Promise.all(Array.from({ length: 12 }, () => refresh(off, 40)));
    expect(new Set(results.map((r) => r.outcome.outcome))).toEqual(new Set(['passed']));
    expect(await getCodeReviewOutcome(repo, 40)).toMatchObject({ outcome: 'passed', statusState: 'success' });
    // A computation that throws writes nothing and frees the lock.
    await expect(
      refreshCodeReviewOutcome(repo, 40, {}, () => {
        throw new Error('rules broke');
      }),
    ).rejects.toThrow('rules broke');
    expect((await getCodeReviewOutcome(repo, 40)).outcome).toBe('passed');
    expect((await refresh(off, 40)).outcome.outcome).toBe('passed');
  });

  it('publishes the status for an enforcing project, once, and records what GitHub took', async () => {
    requests.length = 0;
    const review = await started(50, 'a');
    // Pending on the head as the review starts.
    expect((await refresh(on, 50, { reviewId: review.id })).published).toEqual({ published: true });
    for (const stage of STAGES)
      await setCodeReviewStage(review.jobId, stage, sha('a'), { status: 'completed' });
    await completeCodeReview(review.jobId);
    const fix = await addCodeReviewFinding(
      review.id,
      verdict({ shouldFix: 'fix', title: 'Leaks the token' }),
    );
    expect((await refresh(on, 50)).outcome.outcome).toBe('changes_required');
    expect(posted()).toEqual([
      [sha('a'), 'pending'],
      [sha('a'), 'failure'],
    ]);
    expect(requests[1].body).toEqual({
      state: 'failure',
      context: 'briareus/code-review',
      description: '1 required fix at aaaaaaa',
    });
    expect(await getCodeReviewOutcome(repo, 50)).toMatchObject({
      publishedSha: sha('a'),
      publishedState: 'failure',
      publishedDescription: '1 required fix at aaaaaaa',
      publishFailedAt: null,
    });
    // Nothing changed: nothing is posted again.
    expect((await refresh(on, 50)).published).toEqual({ published: true, skipped: 'unchanged' });
    expect(posted()).toHaveLength(2);
    // A client changes the verdict: the stored outcome and the status on GitHub follow.
    await updateCodeReviewFinding(review.id, fix.id, { shouldFix: 'optional' });
    const after = await refresh(on, 50);
    expect(after.outcome.outcome).toBe('passed');
    expect(posted().at(-1)).toEqual([sha('a'), 'success']);
    expect((await readReviewOutcome(on, 50)).status).toMatchObject({
      state: 'success',
      published: true,
      publishedSha: sha('a'),
      publishedState: 'success',
      error: null,
    });
    // A new head is seen: pending there, and the old head's success is left where it is.
    await refresh(on, 50, { current: { headSha: sha('b'), baseRef: 'main' } });
    expect(posted().at(-1)).toEqual([sha('b'), 'pending']);
    expect(await getCodeReviewOutcome(repo, 50)).toMatchObject({
      headSha: sha('b'),
      outcome: 'pending',
      publishedSha: sha('b'),
      publishedState: 'pending',
    });
  });

  it('keeps a passed outcome marked as not on GitHub while its status is refused, and retries it', async () => {
    requests.length = 0;
    const review = await reviewed(51, 'a');
    const refused = () =>
      new Response(JSON.stringify({ message: 'Resource not accessible by personal access token' }), {
        status: 403,
        headers: { 'content-type': 'application/json' },
      });
    answers.push(refused());
    const { outcome, published } = await refresh(on, 51, { reviewId: review.id });
    expect(outcome.outcome).toBe('passed');
    expect(published.published).toBe(false);
    const row = await getCodeReviewOutcome(repo, 51);
    expect(row).toMatchObject({
      outcome: 'passed',
      statusState: 'success',
      publishedSha: null,
      publishedState: null,
      publishErrorStatus: 403,
      publishAttempts: 1,
    });
    expect(row.publishError).toContain('may not write commit statuses');
    expect(Date.parse(row.publishRetryAt)).toBeGreaterThan(Date.parse(row.publishFailedAt));
    const read = await readReviewOutcome(on, 51);
    expect(read).toMatchObject({ outcome: 'passed', enforced: true });
    expect(read.status).toMatchObject({ published: false, errorStatus: 403, attempts: 1 });
    // It waits on a person, and is listed as such.
    expect(await reviewStatusFailures({ getProject: () => on })).toEqual([
      expect.objectContaining({ repo, prNumber: 51, outcome: 'passed', state: 'success', errorStatus: 403 }),
    ]);
    expect((await listFailedCodeReviewStatuses()).map((r) => r.prNumber)).toEqual([51]);
    // Not due yet; then due and refused again, which counts and backs off further.
    const due = Date.parse(row.publishRetryAt);
    expect(await listFailedCodeReviewStatuses({ dueBy: due - 1 })).toEqual([]);
    expect(await retryReviewStatuses({ getProject: () => on, cfg, now: () => due - 1 })).toEqual([]);
    answers.push(refused());
    const again = await retryReviewStatuses({ getProject: () => on, cfg, now: () => due });
    expect(again).toEqual([expect.objectContaining({ repo, prNumber: 51, published: false })]);
    const second = await getCodeReviewOutcome(repo, 51);
    expect(second.publishAttempts).toBe(2);
    expect(Date.parse(second.publishRetryAt)).toBe(due + 120_000);
    // The token is fixed: the retry lands and the failure is over.
    const landed = await retryReviewStatuses({ getProject: () => on, cfg, now: () => due + 120_000 });
    expect(landed).toEqual([{ repo, prNumber: 51, published: true }]);
    expect(await getCodeReviewOutcome(repo, 51)).toMatchObject({
      publishedSha: sha('a'),
      publishedState: 'success',
      publishError: null,
      publishErrorStatus: null,
      publishAttempts: 0,
      publishFailedAt: null,
      publishRetryAt: null,
    });
    expect(await listFailedCodeReviewStatuses()).toEqual([]);
    expect((await readReviewOutcome(on, 51)).status.published).toBe(true);
  });

  it('records a status write and its failure as the row’s own columns', async () => {
    await refresh(off, 52);
    await recordCodeReviewStatusFailed(repo, 52, { error: 'x'.repeat(3000), status: 502, retryAt: 5_000 });
    const failed = await getCodeReviewOutcome(repo, 52);
    expect(failed.publishError).toHaveLength(2000);
    expect(failed).toMatchObject({ publishErrorStatus: 502, publishAttempts: 1 });
    expect(failed.publishRetryAt).toBe(new Date(5_000).toISOString());
    // The longest-waiting first.
    await refresh(off, 53);
    await recordCodeReviewStatusFailed(repo, 53, { error: 'later', retryAt: 9_000 });
    expect((await listFailedCodeReviewStatuses()).map((r) => r.prNumber)).toEqual([52, 53]);
    expect((await listFailedCodeReviewStatuses({ dueBy: 6_000 })).map((r) => r.prNumber)).toEqual([52]);
    expect((await listFailedCodeReviewStatuses({ limit: 1 })).map((r) => r.prNumber)).toEqual([52]);
    await clearCodeReviewStatusFailure(repo, 52);
    await recordCodeReviewStatusPublished(repo, 53, {
      sha: sha('c'),
      state: 'pending',
      description: 'Waiting for a review of ccccccc',
    });
    expect(await listFailedCodeReviewStatuses()).toEqual([]);
    expect(await getCodeReviewOutcome(repo, 53)).toMatchObject({
      publishedSha: sha('c'),
      publishedState: 'pending',
      publishedDescription: 'Waiting for a review of ccccccc',
      publishError: null,
    });
    expect((await getCodeReviewOutcome(repo, 53)).publishedAt).toBeTruthy();
  });

  it('rolls back to the earlier schema and comes back up with nothing passed', async () => {
    const reviews = await columns('code_reviews');
    const projects = await columns('projects');
    await down({ context: pool });
    await down({ context: pool });
    expect(await tables()).toEqual([]);
    expect(await columns('code_reviews')).not.toContain('base_ref');
    expect(await columns('projects')).not.toContain('enforce_review_outcome');
    // The reviews themselves are untouched by the rollback.
    const [kept] = await pool.query('SELECT COUNT(*) AS n FROM `code_reviews` WHERE `repo` = ?', [repo]);
    expect(Number(kept[0].n)).toBeGreaterThan(0);
    await up({ context: pool });
    expect(await tables()).toEqual(['code_review_outcomes', 'code_review_stages']);
    expect(await columns('code_reviews')).toEqual(reviews);
    expect(await columns('projects')).toEqual(projects);
    // Nothing is back-filled: a review that had passed has no record again, so it is
    // incomplete until it is reviewed again, and no project enforces.
    expect(await getCodeReviewOutcome(repo, 50)).toBeNull();
    const again = await readReviewOutcome(off, 51);
    expect(again.outcome).toBe('incomplete');
    expect(again.reasons.map((r) => r.code)).toEqual(['stages_not_recorded']);
    const [enforcing] = await pool.query(
      'SELECT COUNT(*) AS n FROM `projects` WHERE `enforce_review_outcome` = 1',
    );
    expect(Number(enforcing[0].n)).toBe(0);
  });
});
