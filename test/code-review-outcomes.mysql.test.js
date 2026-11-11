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
  completeCodeReview,
  createCodeReview,
  dbHealthy,
  dropCodeReviewStatusDebt,
  failCodeReview,
  failRunningCodeReviewStages,
  getCodeReviewByJob,
  getCodeReviewDecision,
  getCodeReviewOutcome,
  getProjectRow,
  listCodeReviewDecisions,
  listCodeReviewOutcomesDue,
  listCodeReviewStages,
  listFailedCodeReviewStatuses,
  markCodeReviewOutcomeStale,
  markCodeReviewStatusSending,
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
  noteReviewedRevision,
  provisionalReviewOutcome,
  publishReviewStatus,
  readReviewOutcome,
  refreshReviewOutcome,
  retryReviewStatuses,
  reviewStatusFailures,
} from '../lib/review-enforcement.js';
import { verdictDecision } from '../lib/review-history.js';
import { requiredReviewStages } from '../lib/review-outcome.js';
import { up, down } from '../migrations/2026_11_10_140000_add_code_review_outcomes.js';

describe.skipIf(process.env.CODE_REVIEW_MYSQL !== '1')('code review outcomes on MySQL', () => {
  const repo = 'acme/shop';
  const sha = (letter) => letter.repeat(40);
  const STAGES = requiredReviewStages();
  const off = { repo, reviewRoundLimit: 3 };
  const on = { ...off, enforceReviewOutcome: true };
  const cfg = { githubToken: 'server-token' };
  let bootstrap, pool, requests, answers, carried;
  // The status a commit carries under the review's context, as GitHub would answer.
  const onGithub = (letter) => carried.get(sha(letter))?.[0]?.state ?? null;
  // A finding's verdict written as the routes write it: the finding and the pull
  // request's decision on its claim in one transaction (lib/code-reviews.js).
  const rule = (review, prNumber, findingId, changes, who = { source: 'review', decidedBy: 'session:x' }) =>
    updateCodeReviewFinding(review.id, findingId, changes, {
      repo,
      prNumber,
      outcomeStale: who.source === 'api',
      build: (finding, previous) =>
        verdictDecision({ headSha: review.head }, finding, previous, changes, who),
    });
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
  const statusOf = (row) => ({
    sha: row.headSha,
    state: row.statusState,
    description: row.statusDescription,
  });
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
    // What GitHub answers to status writes, in order; then every write is accepted.
    answers = [];
    // What each commit carries on GitHub, newest first, as its read answers.
    carried = new Map();
    const json = (status, body) =>
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url, init) => {
        const body = init.body ? JSON.parse(init.body) : null;
        requests.push({ url, method: init.method, body });
        const read = /\/commits\/([0-9a-f]+)\/statuses/.exec(url)?.[1];
        if (init.method === 'GET') return json(200, read ? carried.get(read) || [] : {});
        const next = answers.shift();
        if (typeof next === 'function') return next(url, body);
        if (next) return next;
        const commit = url.split('/').pop();
        carried.set(commit, [body, ...(carried.get(commit) || [])]);
        return json(201, {});
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
      'published_confirmed',
      'published_at',
      'publish_error',
      'publish_error_status',
      'publish_attempts',
      'publish_failed_at',
      'publish_retry_at',
      'publish_owed_at',
      'recompute_at',
      'created_at',
      'updated_at',
    ]);
    // The earlier migration's table gains what a verdict was recorded with.
    const decisions = await columns('code_review_decisions');
    expect(decisions[decisions.indexOf('rationale') + 1]).toBe('verification');
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
    expect(await listCodeReviewOutcomesDue({ now: due - 1 })).toEqual([]);
    expect((await listCodeReviewOutcomesDue({ now: due })).map((r) => r.prNumber)).toEqual([51]);
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
      publishOwedAt: null,
      publishedConfirmed: true,
    });
    expect(await listFailedCodeReviewStatuses()).toEqual([]);
    expect(await listCodeReviewOutcomesDue({ now: due + 86_400_000 })).toEqual([]);
    expect((await readReviewOutcome(on, 51)).status.published).toBe(true);
  });

  it('records a status write, its failure and what is owed as the row’s own columns', async () => {
    await refresh(off, 52);
    // A project that publishes nothing owes nothing.
    expect(await getCodeReviewOutcome(repo, 52)).toMatchObject({
      publishOwedAt: null,
      recomputeAt: null,
      publishedConfirmed: false,
    });
    await recordCodeReviewStatusFailed(
      repo,
      52,
      { error: 'x'.repeat(3000), status: 502, retryAt: 5_000 },
      statusOf(await getCodeReviewOutcome(repo, 52)),
    );
    const failed = await getCodeReviewOutcome(repo, 52);
    expect(failed.publishError).toHaveLength(2000);
    expect(failed).toMatchObject({ publishErrorStatus: 502, publishAttempts: 1 });
    expect(failed.publishRetryAt).toBe(new Date(5_000).toISOString());
    // A failure that is to be tried again is a debt, whoever recorded it.
    expect(failed.publishOwedAt).toBeTruthy();
    // The longest-failing first, and for the sweep only what is due.
    await refresh(off, 53);
    await recordCodeReviewStatusFailed(
      repo,
      53,
      { error: 'later', retryAt: 9_000 },
      statusOf(await getCodeReviewOutcome(repo, 53)),
    );
    expect((await listFailedCodeReviewStatuses()).map((r) => r.prNumber)).toEqual([52, 53]);
    expect((await listFailedCodeReviewStatuses({ limit: 1 })).map((r) => r.prNumber)).toEqual([52]);
    const due = async (now) => (await listCodeReviewOutcomesDue({ now })).map((r) => r.prNumber);
    expect(await due(4_999)).toEqual([]);
    expect(await due(6_000)).toEqual([52]);
    expect(await due(9_000)).toEqual([52, 53]);
    expect((await listCodeReviewOutcomesDue({ now: 9_000, limit: 1 })).map((r) => r.prNumber)).toEqual([52]);
    // A refusal that asking again cannot change: the failure stays, the debt goes.
    await recordCodeReviewStatusFailed(
      repo,
      52,
      { error: 'No commit found', status: 422, retryAt: null },
      statusOf(await getCodeReviewOutcome(repo, 52)),
    );
    expect(await getCodeReviewOutcome(repo, 52)).toMatchObject({
      publishAttempts: 2,
      publishErrorStatus: 422,
      publishRetryAt: null,
      publishOwedAt: null,
    });
    expect(await due(9_000)).toEqual([53]);
    expect((await listFailedCodeReviewStatuses()).map((r) => r.prNumber)).toEqual([53, 52]);
    // An outcome owed a recomputation is due at once, and counts once.
    await markCodeReviewOutcomeStale(repo, 52);
    const marked = (await getCodeReviewOutcome(repo, 52)).recomputeAt;
    expect(marked).toBeTruthy();
    await new Promise((resolve) => setTimeout(resolve, 5));
    await markCodeReviewOutcomeStale(repo, 52);
    expect((await getCodeReviewOutcome(repo, 52)).recomputeAt).toBe(marked);
    expect(await due(0)).toEqual([52]);
    // Nothing is marked for a pull request that has no outcome to be out of date.
    await markCodeReviewOutcomeStale(repo, 5200);
    expect(await getCodeReviewOutcome(repo, 5200)).toBeNull();
    // Computing it again settles that, in the same write.
    await refresh(off, 52);
    expect((await getCodeReviewOutcome(repo, 52)).recomputeAt).toBeNull();
    // Dropped: neither listed nor due any more.
    await markCodeReviewOutcomeStale(repo, 53);
    await dropCodeReviewStatusDebt(repo, 53);
    await dropCodeReviewStatusDebt(repo, 52);
    expect(await listFailedCodeReviewStatuses()).toEqual([]);
    expect(await due(Date.now())).toEqual([]);
    // What GitHub took is confirmed; a write under way is not, until its answer.
    const status = { sha: sha('c'), state: 'pending', description: 'Waiting for a review of ccccccc' };
    await recordCodeReviewStatusPublished(repo, 53, status);
    const taken = await getCodeReviewOutcome(repo, 53);
    expect(taken).toMatchObject({
      publishedSha: sha('c'),
      publishedState: 'pending',
      publishedDescription: 'Waiting for a review of ccccccc',
      publishedConfirmed: true,
      publishError: null,
    });
    expect(taken.publishedAt).toBeTruthy();
    await markCodeReviewStatusSending(repo, 53);
    expect(await getCodeReviewOutcome(repo, 53)).toMatchObject({
      publishedState: 'pending',
      publishedConfirmed: false,
    });
    // Confirmed again by a read of the commit: the time it was written stays.
    await recordCodeReviewStatusPublished(repo, 53, status, { posted: false });
    expect(await getCodeReviewOutcome(repo, 53)).toMatchObject({
      publishedConfirmed: true,
      publishedAt: taken.publishedAt,
    });
  });

  it('keeps a verdict’s verification with the decision, through a rerun and into the next round', async () => {
    requests.length = 0;
    const decision = async () =>
      (await listCodeReviewDecisions(repo, 60)).find((d) => d.findingRef === 'ref-x');
    // Review one finds a problem, and its verification step dismisses it on a likelihood.
    const first = await started(60, 'a');
    await refresh(on, 60, { reviewId: first.id });
    const found = await addCodeReviewFinding(first.id, {
      severity: 'high',
      title: 'Lost update',
      findingRef: 'ref-x',
      commentId: 6001,
      threadId: 'PRRT_x',
    });
    await rule(first, 60, found.id, {
      shouldFix: 'dismiss',
      verification: 'plausible',
      comments: 'Probably guarded upstream.',
    });
    expect(await decision()).toMatchObject({
      verdict: 'dismiss',
      verification: 'plausible',
      rationale: 'Probably guarded upstream.',
      source: 'review',
      findingId: found.id,
    });
    for (const stage of STAGES)
      await setCodeReviewStage(first.jobId, stage, sha('a'), { status: 'completed' });
    await completeCodeReview(first.jobId);
    expect((await refresh(on, 60)).outcome.outcome).toBe('incomplete');
    expect(onGithub('a')).toBe('error');

    // `/review` again in the same session, on the same head: the review starts over,
    // its findings are deleted, and this time it raises nothing.
    await restartCodeReview(first.jobId, sha('a'));
    await beginCodeReviewStages(first.jobId, { headSha: sha('a'), baseRef: 'main', stages: STAGES });
    await refresh(on, 60, { reviewId: first.id });
    for (const stage of STAGES)
      await setCodeReviewStage(first.jobId, stage, sha('a'), { status: 'completed' });
    await completeCodeReview(first.jobId);
    expect(await listPullCodeReviews(repo, 60, 5)).toMatchObject([{ status: 'completed', findings: [] }]);
    // The decision outlived the finding, with what it is worth: still not proven.
    expect(await decision()).toMatchObject({ verdict: 'dismiss', verification: 'plausible' });
    const rerun = await refresh(on, 60);
    expect(rerun.outcome.outcome).toBe('incomplete');
    expect(rerun.outcome.reasons).toEqual([
      expect.objectContaining({
        code: 'earlier_finding_unverified',
        findingRef: 'ref-x',
        threadId: 'PRRT_x',
        verdict: 'dismiss',
        missing: ['verification'],
      }),
    ]);
    expect(onGithub('a')).toBe('error');

    // The next round, by another session on the next head, finds the claim again and
    // registers it as suppressed against that dismissal.
    const second = await started(60, 'b');
    await refresh(on, 60, { reviewId: second.id, current: { headSha: sha('b'), baseRef: 'main' } });
    const repeated = await addCodeReviewFinding(second.id, {
      severity: 'high',
      title: 'Lost update',
      findingRef: 'ref-x',
      reconciliation: 'suppressed',
      priorThreadId: 'PRRT_x',
      priorDisposition: 'dismissed',
      shouldFix: 'dismiss',
      comments: 'Not repeated: already dismissed. Probably guarded upstream.',
    });
    for (const stage of STAGES)
      await setCodeReviewStage(second.jobId, stage, sha('b'), { status: 'completed' });
    await completeCodeReview(second.jobId);
    const next = await refresh(on, 60);
    expect(next.outcome).toMatchObject({ outcome: 'incomplete', headSha: sha('b'), stale: false });
    expect(next.outcome.reasons).toEqual([
      expect.objectContaining({
        code: 'prior_decision_unverified',
        findingId: repeated.id,
        findingRef: 'ref-x',
      }),
    ]);
    expect(onGithub('b')).toBe('error');
    // Never, on either head, did GitHub get a `success`.
    expect(requests.filter((r) => r.method === 'POST').map((r) => r.body.state)).not.toContain('success');
    expect((await readReviewOutcome(on, 60)).status).toMatchObject({ state: 'error', published: true });

    // A person looks into it and records the proof on the duplicate. Its verdict was
    // another finding's, so that rules on the claim again, under their name.
    await rule(
      second,
      60,
      repeated.id,
      { verification: 'confirmed' },
      { source: 'api', decidedBy: 'user:4' },
    );
    expect(await decision()).toMatchObject({
      verdict: 'dismiss',
      verification: 'confirmed',
      source: 'api',
      decidedBy: 'user:4',
      findingId: repeated.id,
    });
    // Marked out of date in that write, so the recomputation is owed until it lands.
    expect((await getCodeReviewOutcome(repo, 60)).recomputeAt).toBeTruthy();
    expect((await listCodeReviewOutcomesDue({ now: 0 })).map((r) => r.prNumber)).toEqual([60]);
    const proven = await refresh(on, 60);
    expect(proven.outcome).toMatchObject({ outcome: 'passed', reasons: [] });
    expect(onGithub('b')).toBe('success');
    expect((await getCodeReviewOutcome(repo, 60)).recomputeAt).toBeNull();
  });

  it('brings a decision’s verification up to date only through the finding that gave it', async () => {
    const review = await reviewed(61, 'a');
    const decision = async () =>
      (await listCodeReviewDecisions(repo, 61)).find((d) => d.findingRef === 'ref-y');
    const found = await addCodeReviewFinding(review.id, {
      severity: 'low',
      title: 'Naming',
      findingRef: 'ref-y',
      threadId: 'PRRT_y',
      commentId: 6101,
    });
    // Optional, with nothing recorded about how that was established.
    await rule(review, 61, found.id, { shouldFix: 'optional', comments: 'Style only.' });
    expect(await decision()).toMatchObject({ verdict: 'optional', verification: null });
    expect((await refresh(off, 61)).outcome.reasons.map((r) => r.code)).toEqual(['finding_unverified']);
    // The verification is recorded afterwards, on the same finding: the decision follows.
    await rule(review, 61, found.id, { verification: 'plausible' });
    expect(await decision()).toMatchObject({
      verdict: 'optional',
      verification: 'plausible',
      findingId: found.id,
    });
    expect((await refresh(off, 61)).outcome.outcome).toBe('passed');
    // A person rules on the decision itself, as the API does where no finding is left.
    const row = await decision();
    expect(await getCodeReviewDecision(repo, 61, row.id)).toMatchObject({ id: row.id, anchor: 'PRRT_y' });
    expect(await getCodeReviewDecision(repo, 62, row.id)).toBeNull();
    await saveCodeReviewDecisions(
      repo,
      61,
      [
        {
          anchor: row.anchor,
          findingRef: row.findingRef,
          verdict: 'dismiss',
          verification: null,
          rationale: 'Not worth changing',
          source: 'api',
          decidedBy: 'user:4',
          decidedAt: Date.now(),
        },
      ],
      { outcomeStale: true },
    );
    expect(await decision()).toMatchObject({ verdict: 'dismiss', verification: null, findingId: null });
    expect((await getCodeReviewOutcome(repo, 61)).recomputeAt).toBeTruthy();
    // The claim is that person's now. The old finding still says optional and verified,
    // and it no longer speaks for the decision: neither its note nor its verification.
    await rule(review, 61, found.id, { verification: 'confirmed', comments: 'Style, confirmed.' });
    expect(await decision()).toMatchObject({
      verdict: 'dismiss',
      verification: null,
      rationale: 'Not worth changing',
    });
    const outcome = (await refresh(off, 61)).outcome;
    expect(outcome.outcome).toBe('incomplete');
    expect(outcome.reasons).toEqual([
      expect.objectContaining({
        code: 'earlier_finding_unverified',
        verdict: 'dismiss',
        findingRef: 'ref-y',
      }),
    ]);
    // A verdict read from GitHub's history is stored with no verification, and one that
    // carries no verdict stores none whatever it says.
    await saveCodeReviewDecisions(repo, 61, [
      {
        anchor: 'PRRT_old',
        threadId: 'PRRT_old',
        findingRef: 'ref-old',
        verdict: 'dismiss',
        rationale: 'Handled in the caller.',
        source: 'github',
        decidedBy: 'octo-reviewer',
        decidedAt: Date.UTC(2026, 9, 1),
      },
      { anchor: 'PRRT_open', threadId: 'PRRT_open', findingRef: 'ref-open', verification: 'confirmed' },
    ]);
    const stored = await listCodeReviewDecisions(repo, 61);
    expect(stored.find((d) => d.findingRef === 'ref-old')).toMatchObject({
      source: 'github',
      verification: null,
    });
    expect(stored.find((d) => d.findingRef === 'ref-open')).toMatchObject({
      verdict: null,
      verification: null,
    });
    expect((await refresh(off, 61)).outcome.reasons.map((r) => r.findingRef)).toEqual([
      'ref-y',
      'ref-old',
      'ref-open',
    ]);
  });

  it('posts again after a write whose answer was lost, instead of trusting the record', async () => {
    requests.length = 0;
    const review = await reviewed(54, 'a');
    const fix = await addCodeReviewFinding(review.id, verdict({ shouldFix: 'fix' }));
    await refresh(on, 54, { reviewId: review.id });
    expect(onGithub('a')).toBe('failure');
    // The fix is waived. GitHub takes the `success` and the answer never arrives, on
    // any of the attempts.
    await updateCodeReviewFinding(review.id, fix.id, { shouldFix: 'optional' });
    const lost = (url, body) => {
      carried.set(url.split('/').pop(), [body, ...(carried.get(url.split('/').pop()) || [])]);
      throw new TypeError('fetch failed');
    };
    answers.push(lost, lost, lost);
    expect((await refresh(on, 54)).published).toEqual({ published: false, error: 'fetch failed' });
    expect(onGithub('a')).toBe('success');
    expect(await getCodeReviewOutcome(repo, 54)).toMatchObject({
      statusState: 'success',
      publishedState: 'failure',
      publishedConfirmed: false,
    });
    // Back to a required fix before any retry: what is owed equals what was last
    // confirmed, and GitHub shows `success`.
    await updateCodeReviewFinding(review.id, fix.id, { shouldFix: 'fix' });
    const back = await refresh(on, 54);
    expect(back.outcome.outcome).toBe('changes_required');
    expect(back.published).toEqual({ published: true });
    expect(onGithub('a')).toBe('failure');
    expect(await getCodeReviewOutcome(repo, 54)).toMatchObject({
      publishedState: 'failure',
      publishedConfirmed: true,
      publishFailedAt: null,
      publishOwedAt: null,
    });
    expect((await readReviewOutcome(on, 54)).status).toMatchObject({ state: 'failure', published: true });
  });

  it('finds an outcome that was stored and never posted, and one whose recomputation is owed', async () => {
    requests.length = 0;
    const review = await reviewed(55, 'a');
    const fix = await addCodeReviewFinding(review.id, verdict({ shouldFix: 'fix', findingRef: 'ref-55' }));
    await refresh(on, 55, { reviewId: review.id });
    expect(onGithub('a')).toBe('failure');
    // The outcome changes and is committed, and the server stops before it posts
    // anything: this is that transaction, with no publication after it.
    await updateCodeReviewFinding(review.id, fix.id, { shouldFix: 'optional' });
    await refreshCodeReviewOutcome(repo, 55, {}, () => ({
      outcome: 'passed',
      stale: false,
      reasons: [],
      headSha: sha('a'),
      baseRef: 'main',
      statusState: 'success',
      statusDescription: 'Review passed at aaaaaaa: 1 optional, nothing to fix',
      owed: true,
    }));
    const stored = await getCodeReviewOutcome(repo, 55);
    expect(stored).toMatchObject({
      statusState: 'success',
      publishedState: 'failure',
      publishFailedAt: null,
    });
    expect(stored.publishOwedAt).toBeTruthy();
    expect(onGithub('a')).toBe('failure');
    // No failure was ever recorded; the debt is what the sweep, and a boot, find.
    expect(await listFailedCodeReviewStatuses()).toEqual([]);
    const swept = await retryReviewStatuses({ getProject: () => on, cfg });
    expect(swept).toEqual([{ repo, prNumber: 55, published: true }]);
    expect(onGithub('a')).toBe('success');
    expect(await getCodeReviewOutcome(repo, 55)).toMatchObject({
      publishedState: 'success',
      publishOwedAt: null,
    });
    expect(await retryReviewStatuses({ getProject: () => on, cfg })).toEqual([]);

    // A client requires the fix again and the server stops before computing anything:
    // the write itself left the outcome marked as out of date.
    await rule(review, 55, fix.id, { shouldFix: 'fix' }, { source: 'api', decidedBy: 'user:4' });
    expect(await getCodeReviewOutcome(repo, 55)).toMatchObject({
      outcome: 'passed',
      publishedState: 'success',
    });
    expect((await getCodeReviewOutcome(repo, 55)).recomputeAt).toBeTruthy();
    expect(await retryReviewStatuses({ getProject: () => on, cfg })).toEqual([
      { repo, prNumber: 55, published: true },
    ]);
    expect(await getCodeReviewOutcome(repo, 55)).toMatchObject({
      outcome: 'changes_required',
      publishedState: 'failure',
      recomputeAt: null,
    });
    expect(onGithub('a')).toBe('failure');
    // A project that is gone, and a failing status of a closed pull request, are
    // dropped rather than kept first in line.
    answers.push(new Response('{}', { status: 403, headers: { 'content-type': 'application/json' } }));
    await rule(review, 55, fix.id, { shouldFix: 'optional' }, { source: 'api', decidedBy: 'user:4' });
    expect((await refresh(on, 55)).published.published).toBe(false);
    const due = Date.parse((await getCodeReviewOutcome(repo, 55)).publishRetryAt);
    expect(
      await retryReviewStatuses({ getProject: () => on, cfg, now: () => due, isOpen: async () => false }),
    ).toEqual([{ repo, prNumber: 55, published: false, skipped: 'closed' }]);
    expect(await getCodeReviewOutcome(repo, 55)).toMatchObject({
      publishFailedAt: null,
      publishOwedAt: null,
    });
    await markCodeReviewOutcomeStale(repo, 55);
    expect(await retryReviewStatuses({ getProject: () => null, cfg })).toEqual([
      { repo, prNumber: 55, published: false, skipped: 'no_project' },
    ]);
    expect(await listCodeReviewOutcomesDue({ now: Date.now() + 86_400_000 })).toEqual([]);
  });

  it('reads a status as published when its description had to be cut inside an astral character', async () => {
    const review = await reviewed(56, 'a');
    // No verdict, so the description quotes the title, and the cut falls in the middle
    // of a pair: half of one is stored as U+FFFD and never equals what was sent again.
    for (const pad of [0, 1]) {
      await pool.query('DELETE FROM `code_review_findings` WHERE `code_review_id` = ?', [review.id]);
      await addCodeReviewFinding(review.id, {
        severity: 'low',
        title: `${'x'.repeat(pad)}${'🙂'.repeat(120)}`,
        findingRef: `ref-56-${pad}`,
      });
      const { outcome, published } = await refresh(on, 56, { reviewId: review.id });
      expect(published.published).toBe(true);
      const row = await getCodeReviewOutcome(repo, 56);
      expect(row.statusDescription.isWellFormed()).toBe(true);
      expect(row.statusDescription).not.toContain('\ufffd');
      expect(row.statusDescription).toBe(outcome.status.description);
      // What was sent is what was stored, to the character.
      expect(requests.at(-1).body.description).toBe(row.statusDescription);
      expect(row.publishedDescription).toBe(row.statusDescription);
      expect((await readReviewOutcome(on, 56)).status.published).toBe(true);
      expect(await publishReviewStatus(on, 56, { cfg })).toEqual({ published: true, skipped: 'unchanged' });
    }
  });

  it('turns a passed outcome stale when the pull request is seen retargeted', async () => {
    const review = await reviewed(57, 'a');
    await refresh(on, 57, { reviewId: review.id });
    expect(onGithub('a')).toBe('success');
    expect(await noteReviewedRevision(on, 57, { headSha: sha('a'), baseRef: 'main' }, { cfg })).toBeNull();
    const seen = await noteReviewedRevision(on, 57, { headSha: sha('a'), baseRef: 'release' }, { cfg });
    await seen.published;
    expect(seen.outcome).toMatchObject({ outcome: 'pending', stale: true, baseRef: 'release' });
    expect(await getCodeReviewOutcome(repo, 57)).toMatchObject({
      outcome: 'pending',
      stale: true,
      baseRef: 'release',
      publishedState: 'pending',
    });
    // On the very commit that carried the `success`.
    expect(onGithub('a')).toBe('pending');
    expect(await noteReviewedRevision(on, 5700, { headSha: sha('a'), baseRef: 'main' }, { cfg })).toBeNull();
    expect(await getCodeReviewOutcome(repo, 5700)).toBeNull();
  });

  it('computes the outcome from the review that was named, also when its row has no pull request yet', async () => {
    // An earlier review of the pull request passed.
    const earlier = await reviewed(58, 'a');
    expect((await refresh(off, 58, { reviewId: earlier.id })).outcome.outcome).toBe('passed');
    // A session that did not know its pull request when its review row was created
    // reviews the same head now. Its discovery names its review.
    await createCodeReview({ jobId: 'job-58-late', repo, prNumber: null, branch: 'feature' });
    await restartCodeReview('job-58-late', sha('a'));
    const [row] = await pool.query('SELECT `id`, `pr_number` FROM `code_reviews` WHERE `job_id` = ?', [
      'job-58-late',
    ]);
    expect(row[0].pr_number).toBeNull();
    const late = Number(row[0].id);
    const named = await refresh(off, 58, { reviewId: late });
    // That review governs: running, so pending. Not the earlier review's pass.
    expect(named.outcome).toMatchObject({ outcome: 'pending', reviewId: late, execution: 'running' });
    expect(named.outcome.reasons.map((r) => r.code)).toEqual(['review_running']);
    expect((await getCodeReviewOutcome(repo, 58)).codeReviewId).toBe(late);
    expect((await readReviewOutcome(off, 58)).reviewId).toBe(late);
    // Another repository's review of that id is nobody's here.
    expect((await readCodeReviewOutcomeState('acme/other', 58, { reviewId: late })).review).toBeNull();
    // Discovery records the pull request it verified on a row that has none, and
    // leaves one that has it alone.
    await beginCodeReviewStages('job-58-late', {
      headSha: sha('a'),
      baseRef: 'main',
      stages: STAGES,
      prNumber: 58,
    });
    expect((await getCodeReviewByJob('job-58-late')).prNumber).toBe(58);
    await beginCodeReviewStages(earlier.jobId, {
      headSha: sha('a'),
      baseRef: 'main',
      stages: STAGES,
      prNumber: 9999,
    });
    expect((await getCodeReviewByJob(earlier.jobId)).prNumber).toBe(58);
    expect((await listPullCodeReviews(repo, 58, 5)).map((r) => r.id).sort()).toEqual(
      [earlier.id, late].sort(),
    );
  });

  it.each(['head', 'state', 'description'])(
    'starts fresh status retries when the owed %s changes, preserving retries when it does not',
    async (change) => {
      const next = {
        outcome: 'passed',
        stale: false,
        reasons: [],
        headSha: sha('a'),
        baseRef: 'main',
        statusState: 'success',
        statusDescription: 'Review passed',
        owed: true,
      };
      const store = () => refreshCodeReviewOutcome(repo, 80, {}, () => next);
      await store();
      const attempted = statusOf(await getCodeReviewOutcome(repo, 80));
      for (let i = 0; i < 5; i++)
        await recordCodeReviewStatusFailed(
          repo,
          80,
          { error: 'No commit', status: 422, retryAt: null },
          attempted,
        );
      await store();
      expect((await getCodeReviewOutcome(repo, 80)).publishAttempts).toBe(5);
      if (change === 'head') next.headSha = sha('b');
      if (change === 'state') next.statusState = 'failure';
      if (change === 'description') next.statusDescription = 'Review Passed';
      await store();
      expect(await getCodeReviewOutcome(repo, 80)).toMatchObject({
        publishAttempts: 0,
        publishFailedAt: null,
        publishRetryAt: null,
        publishError: null,
        publishErrorStatus: null,
      });
      answers.push(new Response('{}', { status: 422 }));
      expect(await publishReviewStatus(on, 80, { cfg, retryDelayMs: 0, now: () => 0 })).toMatchObject({
        published: false,
      });
      expect(await getCodeReviewOutcome(repo, 80)).toMatchObject({
        publishAttempts: 1,
        publishRetryAt: new Date(60_000).toISOString(),
        publishOwedAt: expect.any(String),
      });
      await dropCodeReviewStatusDebt(repo, 80);
    },
  );

  it.each([null, 90_000])(
    'keeps a newer status’s debt and retry history when an older write fails (retry %s)',
    async (retryAt) => {
      const next = {
        outcome: 'passed',
        stale: false,
        reasons: [],
        headSha: sha('a'),
        baseRef: 'main',
        statusState: 'success',
        statusDescription: 'Review passed',
        owed: true,
      };
      await refreshCodeReviewOutcome(repo, 81, {}, () => next);
      const attempted = statusOf(await getCodeReviewOutcome(repo, 81));
      next.statusState = 'failure';
      await refreshCodeReviewOutcome(repo, 81, {}, () => next);
      const newer = await getCodeReviewOutcome(repo, 81);
      // The old HTTP request completes after the new outcome commits, before its own
      // queued publication can run (or before a restart). It cannot drop that debt.
      await recordCodeReviewStatusFailed(repo, 81, { error: 'No commit', status: 422, retryAt }, attempted);
      expect(await getCodeReviewOutcome(repo, 81)).toEqual(newer);
      expect((await listCodeReviewOutcomesDue({ now: Date.now() })).some((r) => r.prNumber === 81)).toBe(
        true,
      );
      await dropCodeReviewStatusDebt(repo, 81);
    },
  );

  it.each(['Review passed', 'réview passed', 'review passed '])(
    'compares status descriptions byte for byte when settling debt (%s)',
    async (description) => {
      await refreshCodeReviewOutcome(repo, 82, {}, () => ({
        outcome: 'passed',
        stale: false,
        reasons: [],
        headSha: sha('a'),
        baseRef: 'main',
        statusState: 'success',
        statusDescription: 'review passed',
        owed: true,
      }));
      const current = statusOf(await getCodeReviewOutcome(repo, 82));
      const older = { ...current, description };
      await recordCodeReviewStatusPublished(repo, 82, older);
      expect((await getCodeReviewOutcome(repo, 82)).publishOwedAt).toBeTruthy();
      await recordCodeReviewStatusFailed(repo, 82, { error: 'No commit', status: 422, retryAt: null }, older);
      expect((await getCodeReviewOutcome(repo, 82)).publishOwedAt).toBeTruthy();
      await recordCodeReviewStatusPublished(repo, 82, current);
      expect((await getCodeReviewOutcome(repo, 82)).publishOwedAt).toBeNull();
    },
  );

  it('rolls back to the earlier schema and comes back up with nothing passed', async () => {
    // A review whose findings some of the decisions below were given by.
    const fixture = await reviewed(59, 'a');
    const reviews = await columns('code_reviews');
    const projects = await columns('projects');
    await down({ context: pool });
    await down({ context: pool });
    expect(await tables()).toEqual([]);
    expect(await columns('code_reviews')).not.toContain('base_ref');
    expect(await columns('projects')).not.toContain('enforce_review_outcome');
    expect(await columns('code_review_decisions')).not.toContain('verification');
    // Decisions as the earlier schema holds them, before the verification was kept:
    const finding = async (fields) =>
      (await addCodeReviewFinding(fixture.id, { severity: 'low', title: 'Kept', ...fields })).id;
    const proven = await finding({ findingRef: 'm-proven', shouldFix: 'dismiss', verification: 'confirmed' });
    const likely = await finding({
      findingRef: 'm-likely',
      shouldFix: 'optional',
      verification: 'plausible',
    });
    const changed = await finding({ findingRef: 'm-changed', shouldFix: 'fix', verification: 'confirmed' });
    const other = await finding({ findingRef: 'm-other', shouldFix: 'dismiss', verification: 'confirmed' });
    const decided = (anchor, findingRef, findingId, verdict, source, prNumber = 59) =>
      pool.query(
        'INSERT INTO `code_review_decisions` (`repo`, `pr_number`, `anchor`, `finding_ref`, `finding_id`, `verdict`, `rationale`, `source`, `decided_at`, `created_at`, `updated_at`) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 1, 1)',
        [repo, prNumber, anchor, findingRef, findingId, verdict, 'Because', source],
      );
    await decided('M1', 'm-proven', proven, 'dismiss', 'review');
    await decided('M2', 'm-likely', likely, 'optional', 'api');
    // The finding says something else by now, or is another claim's, or another pull
    // request's, or gone; and a verdict read from GitHub never had one.
    await decided('M3', 'm-changed', changed, 'dismiss', 'review');
    await decided('M4', 'm-elsewhere', other, 'dismiss', 'review');
    await decided('M5', 'm-other', other, 'dismiss', 'review', 5900);
    await decided('M6', 'm-gone', 4_000_000, 'dismiss', 'review');
    await decided('M7', 'm-history', null, 'dismiss', 'github');
    // The reviews themselves are untouched by the rollback.
    const [kept] = await pool.query('SELECT COUNT(*) AS n FROM `code_reviews` WHERE `repo` = ?', [repo]);
    expect(Number(kept[0].n)).toBeGreaterThan(0);
    await up({ context: pool });
    expect(await tables()).toEqual(['code_review_outcomes', 'code_review_stages']);
    expect(await columns('code_reviews')).toEqual(reviews);
    expect(await columns('projects')).toEqual(projects);
    // A decision takes its verification from the finding that gave it, where that
    // finding still stands for it. Every other one has none, and so is not verified.
    const migrated = [
      ...(await listCodeReviewDecisions(repo, 59)),
      ...(await listCodeReviewDecisions(repo, 5900)),
    ]
      .filter((d) => /^M\d$/.test(d.anchor))
      .map((d) => [d.anchor, d.verification]);
    expect(migrated).toEqual([
      ['M1', 'confirmed'],
      ['M2', 'plausible'],
      ['M3', null],
      ['M4', null],
      ['M6', null],
      ['M7', null],
      ['M5', null],
    ]);
    // Applying it again assumes nothing new.
    await pool.query("UPDATE `code_review_decisions` SET `verification` = NULL WHERE `anchor` = 'M1'");
    await up({ context: pool });
    expect((await listCodeReviewDecisions(repo, 59)).find((d) => d.anchor === 'M1').verification).toBeNull();
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
