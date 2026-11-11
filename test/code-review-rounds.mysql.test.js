import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import mysql from 'mysql2/promise';

// Opt in against a real MySQL server, like test/code-review-decisions.mysql.test.js:
// lib/db.js is pointed at a randomly named database that only this file creates and
// drops, built the way the server builds it at boot. What is exercised here is the SQL
// the in-memory suites stand in for: the schema, the claim under the pull request's row
// lock, and claims racing each other on separate connections.
const scratch = vi.hoisted(() => ({
  database: `briareus_rounds_test_${Math.random().toString(16).slice(2, 14)}`,
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
  completeCodeReview,
  createCodeReview,
  dbHealthy,
  failCodeReview,
  getCodeReviewByJob,
  getCodeReviewRounds,
  getProjectRow,
  listPullCodeReviews,
  listRefusedCodeReviewRounds,
  markCodeReviewRoundPublished,
  restartCodeReview,
  saveCodeReviewDecisions,
  saveProject,
  setCodeReviewRoundScope,
} from '../lib/db.js';
import { claimReviewRound, readReviewRounds, reviewLimitsWaiting } from '../lib/review-rounds.js';
import { up, down } from '../migrations/2026_11_10_130000_add_code_review_rounds.js';

describe.skipIf(process.env.CODE_REVIEW_MYSQL !== '1')('code review rounds on MySQL', () => {
  const repo = 'acme/shop';
  const sha = (letter) => letter.repeat(40);
  const REVIEW_COLUMNS = ['round', 'scope', 'scope_reason', 'scope_base_sha'];
  let bootstrap, pool;
  const columns = async (table) => {
    const [rows] = await pool.query(
      'SELECT COLUMN_NAME AS name FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION',
      [table],
    );
    return rows.map((r) => r.name);
  };
  const tables = async () => {
    const [rows] = await pool.query("SHOW TABLES LIKE 'code_review_round%'");
    return rows.map((r) => Object.values(r)[0]).sort();
  };
  const claim = (over = {}) =>
    claimReviewRound({
      repo,
      prNumber: 7,
      headSha: sha('a'),
      baseRef: 'main',
      limit: 3,
      source: 'babysitter',
      jobId: 'job-a',
      ...over,
    });
  const outcome = (promise) =>
    promise.then(
      (c) => c.number,
      (e) => e.code || e.message,
    );
  // A round whose review ran to its end, the way a session leaves it.
  async function review(prNumber, letter, over = {}) {
    const jobId = `job-${prNumber}-${letter}`;
    await createCodeReview({ jobId, repo, prNumber, branch: 'feature' });
    const claimed = await claim({ prNumber, headSha: sha(letter), jobId, ...over });
    await markCodeReviewRoundPublished(jobId, claimed.round.id);
    await completeCodeReview(jobId);
    return claimed;
  }

  beforeAll(async () => {
    const { database, ...config } = getConfig().db;
    expect(database).toBe(scratch.database);
    bootstrap = await mysql.createConnection(config);
    // The first query makes lib/db.js create the database and run every migration.
    expect(await dbHealthy()).toBe(true);
    pool = mysql.createPool({ ...config, database, connectionLimit: 2 });
    // Every migration runs first, which takes longer when another suite builds its own
    // database beside this one.
  }, 120_000);
  afterAll(async () => {
    await pool?.end();
    await bootstrap?.query(`DROP DATABASE IF EXISTS \`${scratch.database}\``);
    await bootstrap?.end();
  });

  it('adds the tables, the review columns and the project limit at boot, and applies twice', async () => {
    const [ran] = await pool.query('SELECT `migration` FROM `migrations` ORDER BY `id` DESC LIMIT 1');
    expect(ran[0].migration).toBe('2026_11_10_130000_add_code_review_rounds');
    expect(await tables()).toEqual(['code_review_round_counts', 'code_review_rounds']);
    const reviews = await columns('code_reviews');
    expect(reviews.slice(reviews.indexOf('head_sha') + 1, reviews.indexOf('user_id'))).toEqual(
      REVIEW_COLUMNS,
    );
    const projects = await columns('projects');
    expect(projects[projects.indexOf('babysit_prs') + 1]).toBe('review_round_limit');
    await up({ context: pool });
    await up({ context: pool });
    expect(await columns('code_reviews')).toEqual(reviews);
    expect(await columns('projects')).toEqual(projects);
    expect(await columns('code_review_round_counts')).toEqual([
      'repo',
      'pr_number',
      'rounds',
      'continuations',
      'refused_at',
      'refused_head_sha',
      'refused_source',
      'created_at',
      'updated_at',
    ]);
    expect(await columns('code_review_rounds')).toEqual([
      'id',
      'repo',
      'pr_number',
      'round',
      'head_sha',
      'base_ref',
      'base_sha',
      'merge_base_sha',
      'status',
      'job_id',
      'attempts',
      'source',
      'requested_by',
      'continued_by',
      'continued_at',
      'scope',
      'scope_reason',
      'scope_base_sha',
      'published_at',
      'reviewed_at',
      'created_at',
      'updated_at',
    ]);
  });

  it('stores the project limit, three for a project that never set one', async () => {
    await pool.query(
      "INSERT INTO `projects` (`repo`, `label`, `created_at`, `updated_at`) VALUES ('acme/legacy', 'Legacy', 1, 1)",
    );
    const [rows] = await pool.query("SELECT `id` FROM `projects` WHERE `repo` = 'acme/legacy'");
    const legacy = await getProjectRow(rows[0].id);
    expect(legacy.reviewRoundLimit).toBe(3);
    expect((await saveProject({ ...legacy, reviewRoundLimit: 5 })).reviewRoundLimit).toBe(5);
    expect((await saveProject({ ...legacy, reviewRoundLimit: 0 })).reviewRoundLimit).toBe(0);
    const created = await saveProject({ repo: 'acme/new', label: 'New', enabled: true });
    expect(created.reviewRoundLimit).toBe(3);
  });

  it('claims a round per revision and keeps a retry on the round it had', async () => {
    await createCodeReview({ jobId: 'job-a', repo, prNumber: 7, branch: 'feature' });
    const first = await claim();
    expect(first).toMatchObject({ number: 1, used: 1, previous: null, continued: false });
    expect(first.round).toMatchObject({
      round: 1,
      headSha: sha('a'),
      baseRef: 'main',
      status: 'running',
      jobId: 'job-a',
      source: 'babysitter',
      attempts: 1,
      publishedAt: null,
      reviewedAt: null,
    });
    // The same session recovers, then a new one retries the same revision after a failure.
    expect((await claim()).round).toMatchObject({ round: 1, attempts: 2 });
    await failCodeReview('job-a');
    expect((await getCodeReviewRounds(repo, 7)).rounds[0].status).toBe('failed');
    const retried = await claim({ jobId: 'job-a2' });
    expect(retried.round).toMatchObject({ round: 1, jobId: 'job-a2', status: 'running', attempts: 3 });
    const { count, rounds } = await getCodeReviewRounds(repo, 7);
    expect(count).toMatchObject({ rounds: 1, continuations: 0, refusedAt: null });
    expect(rounds).toHaveLength(1);
    // A late failure from the session that lost the round does not touch it.
    await failCodeReview('job-a');
    expect((await getCodeReviewRounds(repo, 7)).rounds[0].status).toBe('running');
  });

  it('records what a round covers on the round and the review, for the session that holds it', async () => {
    await createCodeReview({ jobId: 'job-a2', repo, prNumber: 7, branch: 'feature' });
    await restartCodeReview('job-a2', sha('a'));
    const [{ id }] = (await getCodeReviewRounds(repo, 7)).rounds;
    const details = {
      round: 1,
      scope: 'full',
      scopeReason: 'first_review',
      scopeBaseSha: null,
      baseSha: sha('1'),
      mergeBaseSha: sha('2'),
    };
    await expect(setCodeReviewRoundScope('job-a', id, details)).rejects.toThrow(
      'This session no longer holds its code review round',
    );
    await setCodeReviewRoundScope('job-a2', id, details);
    expect((await getCodeReviewRounds(repo, 7)).rounds[0]).toMatchObject({
      scope: 'full',
      scopeReason: 'first_review',
      scopeBaseSha: null,
      baseSha: sha('1'),
      mergeBaseSha: sha('2'),
    });
    expect(await getCodeReviewByJob('job-a2')).toMatchObject({
      round: 1,
      scope: 'full',
      scopeReason: 'first_review',
      scopeBaseSha: null,
    });
    // A rerun starts the review row over. The round stays: the claim that precedes the
    // reset names it, and the scope is worked out again.
    await restartCodeReview('job-a2', sha('a'));
    expect(await getCodeReviewByJob('job-a2')).toMatchObject({ round: 1, scope: null, scopeReason: null });
    await setCodeReviewRoundScope('job-a2', id, details);
  });

  it('settles the round with the review, and keeps the count when the review rows go', async () => {
    const [{ id }] = (await getCodeReviewRounds(repo, 7)).rounds;
    // Only the session that holds the round marks it.
    expect(await markCodeReviewRoundPublished('job-a', id)).toBe(false);
    expect((await getCodeReviewRounds(repo, 7)).rounds[0].publishedAt).toBeNull();
    expect(await markCodeReviewRoundPublished('job-a2', id)).toBe(true);
    const published = (await getCodeReviewRounds(repo, 7)).rounds[0].publishedAt;
    expect(published).toBeTruthy();
    // Kept from the first time: a recovered publish step does not move it.
    await markCodeReviewRoundPublished('job-a2', id);
    expect((await getCodeReviewRounds(repo, 7)).rounds[0].publishedAt).toBe(published);
    await completeCodeReview('job-a2');
    const done = (await getCodeReviewRounds(repo, 7)).rounds[0];
    expect(done).toMatchObject({ status: 'completed', jobId: 'job-a2' });
    expect(done.reviewedAt).toBeTruthy();
    // A later turn of the session going wrong does not undo a review that finished.
    await failCodeReview('job-a2');
    expect((await getCodeReviewRounds(repo, 7)).rounds[0].status).toBe('completed');
    const [stored] = await listPullCodeReviews(repo, 7, 1);
    expect(stored).toMatchObject({ jobId: 'job-a2', round: 1, scope: 'full', scopeReason: 'first_review' });
    // A newer session's row that has not finished is left out of the finished reviews.
    await createCodeReview({ jobId: 'job-a3', repo, prNumber: 7, branch: 'feature', headSha: sha('b') });
    expect((await listPullCodeReviews(repo, 7, 1))[0].jobId).toBe('job-a3');
    expect((await listPullCodeReviews(repo, 7, 1, { completed: true }))[0].jobId).toBe('job-a2');
    // The session and its review are deleted; the pull request's count is not theirs.
    await pool.query('DELETE FROM `code_reviews` WHERE `repo` = ? AND `pr_number` = ?', [repo, 7]);
    const { count, rounds } = await getCodeReviewRounds(repo, 7);
    expect(count.rounds).toBe(1);
    expect(rounds[0]).toMatchObject({ round: 1, headSha: sha('a'), status: 'completed' });
  });

  it('counts across pushes, refuses at the limit and runs one more only on a continuation', async () => {
    // Automation does not review the reviewed revision again; that is not the limit.
    expect(await outcome(claim({ jobId: 'job-again' }))).toBe('review_round_reviewed');
    expect(await outcome(claim({ jobId: 'job-again', source: 'user' }))).toBe(1);
    await completeCodeReview('job-again');
    const second = await review(7, 'b');
    expect(second).toMatchObject({ number: 2, used: 2 });
    expect(second.previous).toMatchObject({ round: 1, headSha: sha('a'), mergeBaseSha: sha('2') });
    expect((await review(7, 'c')).number).toBe(3);
    for (const letter of ['d', 'e']) {
      const error = await claim({ headSha: sha(letter), jobId: `job-${letter}` }).catch((e) => e);
      expect(error).toMatchObject({ status: 409, code: 'review_round_limit' });
      expect(error.reviewRounds).toMatchObject({ limit: 3, used: 3, remaining: 0, limitReached: true });
    }
    // Asking before a session exists is refused the same and claims nothing.
    expect(await outcome(claim({ headSha: sha('f'), jobId: null, admitOnly: true }))).toBe(
      'review_round_limit',
    );
    let state = await getCodeReviewRounds(repo, 7);
    expect(state.count).toMatchObject({
      rounds: 3,
      continuations: 0,
      refusedHeadSha: sha('f'),
      refusedSource: 'babysitter',
    });
    expect(state.rounds.map((r) => r.headSha)).toEqual([sha('a'), sha('b'), sha('c')]);
    const firstRefusal = state.count.refusedAt;
    expect(firstRefusal).toBeTruthy();
    expect((await listRefusedCodeReviewRounds()).map((r) => `${r.repo}#${r.prNumber}`)).toEqual([
      `${repo}#7`,
    ]);
    // A reader scoped to other repositories gets none of it, before the limit is applied.
    expect(await listRefusedCodeReviewRounds({ repos: ['acme/other'], limit: 1 })).toEqual([]);
    expect(await listRefusedCodeReviewRounds({ repos: [] })).toEqual([]);
    expect(
      (await listRefusedCodeReviewRounds({ repos: [repo, 'acme/other'] })).map((r) => r.prNumber),
    ).toEqual([7]);
    // A plain request from a person is refused too; an admitted continuation claims nothing yet.
    expect(await outcome(claim({ headSha: sha('f'), jobId: 'job-f', source: 'user' }))).toBe(
      'review_round_limit',
    );
    const admitted = await claim({
      headSha: sha('f'),
      jobId: null,
      admitOnly: true,
      source: 'user',
      continuation: true,
    });
    expect(admitted).toMatchObject({ number: 4, round: null, continued: true });
    state = await getCodeReviewRounds(repo, 7);
    expect(state.count).toMatchObject({ rounds: 3, continuations: 0, refusedAt: firstRefusal });
    const more = await claim({
      headSha: sha('f'),
      jobId: 'job-f',
      source: 'user',
      requestedBy: 'user:4',
      continuation: true,
    });
    expect(more).toMatchObject({ number: 4, used: 4, continued: true });
    expect(more.round).toMatchObject({
      round: 4,
      source: 'user',
      requestedBy: 'user:4',
      continuedBy: 'user:4',
    });
    expect(more.round.continuedAt).toBeTruthy();
    state = await getCodeReviewRounds(repo, 7);
    expect(state.count).toMatchObject({ rounds: 4, continuations: 1, refusedAt: null, refusedHeadSha: null });
    expect(await listRefusedCodeReviewRounds()).toEqual([]);
    // The grant was for that round: the next head is at the limit again.
    await markCodeReviewRoundPublished('job-f', more.round.id);
    await completeCodeReview('job-f');
    expect(await outcome(claim({ headSha: sha('g'), jobId: 'job-g', source: 'user' }))).toBe(
      'review_round_limit',
    );
    expect((await getCodeReviewRounds(repo, 7)).count.rounds).toBe(4);
  });

  it('hands a round that never published to the next revision', async () => {
    await claim({ prNumber: 8, jobId: 'job-8a' });
    await failCodeReview('job-8a');
    const next = await claim({ prNumber: 8, headSha: sha('b'), jobId: 'job-8b', source: 'orchestrator' });
    expect(next).toMatchObject({ number: 1, used: 1 });
    expect(next.round).toMatchObject({
      round: 1,
      headSha: sha('b'),
      jobId: 'job-8b',
      source: 'orchestrator',
      attempts: 2,
      scope: null,
      mergeBaseSha: null,
    });
    await markCodeReviewRoundPublished('job-8b', next.round.id);
    await failCodeReview('job-8b');
    expect((await claim({ prNumber: 8, headSha: sha('c'), jobId: 'job-8c' })).number).toBe(2);
    const { count, rounds } = await getCodeReviewRounds(repo, 8);
    expect(count.rounds).toBe(2);
    expect(rounds.map((r) => [r.round, r.headSha])).toEqual([
      [1, sha('b')],
      [2, sha('c')],
    ]);
  });

  it('settles exactly the round its review names, together with the review', async () => {
    const jobId = 'job-30';
    const status = async () =>
      (await getCodeReviewRounds(repo, 30)).rounds.map((r) => [r.round, r.status, !!r.reviewedAt]);
    await createCodeReview({ jobId, repo, prNumber: 30, branch: 'feature' });
    const first = await claim({ prNumber: 30, jobId });
    // The claim itself names the round on the session's review row.
    expect(await getCodeReviewByJob(jobId)).toMatchObject({ round: 1, status: 'running' });
    await markCodeReviewRoundPublished(jobId, first.round.id);
    // Its settling write is lost, and the session moves on to the next head.
    const second = await claim({ prNumber: 30, headSha: sha('b'), jobId });
    expect(second.number).toBe(2);
    expect((await getCodeReviewByJob(jobId)).round).toBe(2);
    await restartCodeReview(jobId, sha('b'));
    expect((await getCodeReviewByJob(jobId)).round).toBe(2);
    // The claim recorded the round nobody was running any more as failed.
    expect(await status()).toEqual([
      [1, 'failed', false],
      [2, 'running', false],
    ]);
    // Even with that round still marked running, finishing the review of the second
    // head completes the second round alone: the one its review names.
    await pool.query("UPDATE `code_review_rounds` SET `status` = 'running' WHERE `id` = ?", [first.round.id]);
    await completeCodeReview(jobId);
    expect(await status()).toEqual([
      [1, 'running', false],
      [2, 'completed', true],
    ]);
    expect((await getCodeReviewByJob(jobId)).status).toBe('completed');
    // Nor does a failure reach past the review's own round, or undo a finished review.
    await failCodeReview(jobId);
    expect(await status()).toEqual([
      [1, 'running', false],
      [2, 'completed', true],
    ]);
    // A review that is running fails together with its round, and only that one.
    await claim({ prNumber: 30, headSha: sha('c'), jobId, isLive: () => true });
    await restartCodeReview(jobId, sha('c'));
    await failCodeReview(jobId);
    expect(await status()).toEqual([
      [1, 'failed', false],
      [2, 'completed', true],
      [3, 'failed', false],
    ]);
    expect(await getCodeReviewByJob(jobId)).toMatchObject({ round: 3, status: 'failed' });
  });

  it('lets a session claim while its last attempt is still being settled, without a deadlock', async () => {
    const jobId = 'job-31';
    await createCodeReview({ jobId, repo, prNumber: 31, branch: 'feature' });
    // Both take the session's review row first, then the round: whichever goes first,
    // the other waits and neither is rolled back.
    for (let attempt = 0; attempt < 12; attempt++) {
      await restartCodeReview(jobId, sha('a'));
      const [claimed] = await Promise.all([outcome(claim({ prNumber: 31, jobId })), failCodeReview(jobId)]);
      expect(claimed).toBe(1);
    }
    const { count, rounds } = await getCodeReviewRounds(repo, 31);
    expect(count.rounds).toBe(1);
    expect(rounds).toHaveLength(1);
    expect(['running', 'failed']).toContain(rounds[0].status);
  });

  it('tells branches apart by case and pull requests apart by number', async () => {
    await claim({ prNumber: 9, jobId: 'job-9a' });
    expect((await claim({ prNumber: 9, baseRef: 'Main', jobId: 'job-9b', isLive: () => true })).number).toBe(
      2,
    );
    expect((await claim({ prNumber: 10, jobId: 'job-10' })).number).toBe(1);
    expect((await getCodeReviewRounds(repo, 9)).rounds.map((r) => r.baseRef)).toEqual(['main', 'Main']);
  });

  it('gives racing claims for different revisions distinct rounds, and no more than the limit', async () => {
    // Eight starters at once, each on its own connection of lib/db.js's pool.
    const letters = ['a', 'b', 'c', 'd', 'e', 'f', '1', '2'];
    const results = await Promise.all(
      letters.map((letter) =>
        outcome(claim({ prNumber: 20, headSha: sha(letter), jobId: `job-20-${letter}`, isLive: () => true })),
      ),
    );
    expect(results.filter((r) => typeof r === 'number').sort()).toEqual([1, 2, 3]);
    expect(results.filter((r) => r === 'review_round_limit')).toHaveLength(5);
    const { count, rounds } = await getCodeReviewRounds(repo, 20);
    expect(count.rounds).toBe(3);
    expect(rounds.map((r) => r.round)).toEqual([1, 2, 3]);
    expect(new Set(rounds.map((r) => r.headSha)).size).toBe(3);
  });

  it('gives racing claims for the same revision one round', async () => {
    // Recoveries of one session racing each other: every claim lands on the same row.
    const same = await Promise.all(
      Array.from({ length: 6 }, () => outcome(claim({ prNumber: 21, jobId: 'job-21' }))),
    );
    expect(same).toEqual([1, 1, 1, 1, 1, 1]);
    let state = await getCodeReviewRounds(repo, 21);
    expect(state.count.rounds).toBe(1);
    expect(state.rounds).toHaveLength(1);
    expect(state.rounds[0].attempts).toBe(6);
    // Two sessions racing for one revision: one holds it, the other is told so.
    const raced = await Promise.all(
      ['x', 'y'].map((name) =>
        outcome(claim({ prNumber: 22, jobId: `job-22-${name}`, isLive: (id) => id.startsWith('job-22-') })),
      ),
    );
    expect(raced.sort()).toEqual([1, 'review_round_in_progress']);
    state = await getCodeReviewRounds(repo, 22);
    expect(state.count.rounds).toBe(1);
    expect(state.rounds).toHaveLength(1);
  });

  it('reads the rounds and what is unresolved, and lists the limit as waiting on a person', async () => {
    await saveCodeReviewDecisions(repo, 7, [
      {
        anchor: 'PRRT_fix',
        threadId: 'PRRT_fix',
        findingRef: 'ref-fix',
        title: 'Leaks the token',
        verdict: 'fix',
        source: 'review',
        decidedAt: Date.now(),
      },
      { anchor: 'PRRT_open', threadId: 'PRRT_open', findingRef: 'ref-open', title: 'Unchecked input' },
    ]);
    const project = { repo, reviewRoundLimit: 3 };
    const view = await readReviewRounds(project, 7);
    expect(view).toMatchObject({ limit: 3, used: 4, remaining: 0, limitReached: true, continuations: 1 });
    expect(view.rounds.map((r) => r.round)).toEqual([1, 2, 3, 4]);
    expect(view.rounds[3]).toMatchObject({ sessionId: 'job-f', continuation: { by: 'user:4' } });
    expect(view.unresolved.fix.map((f) => f.findingRef)).toEqual(['ref-fix']);
    expect(view.unresolved.unverified.map((f) => f.findingRef)).toEqual(['ref-open']);
    const waiting = await reviewLimitsWaiting({ getProject: () => project });
    // The latest refusal first.
    expect(waiting).toEqual([
      expect.objectContaining({ repo, prNumber: 20, used: 3, limit: 3, fix: 0, unverified: 0 }),
      expect.objectContaining({
        repo,
        prNumber: 7,
        used: 4,
        limit: 3,
        continuations: 1,
        fix: 1,
        unverified: 1,
      }),
    ]);
  });

  it('rolls back to the earlier schema and comes back up empty', async () => {
    const before = await columns('code_reviews');
    await down({ context: pool });
    await down({ context: pool });
    expect(await tables()).toEqual([]);
    expect((await columns('code_reviews')).filter((name) => REVIEW_COLUMNS.includes(name))).toEqual([]);
    expect(await columns('projects')).not.toContain('review_round_limit');
    await up({ context: pool });
    expect(await tables()).toEqual(['code_review_round_counts', 'code_review_rounds']);
    expect(await columns('code_reviews')).toEqual(before);
    // Counting starts over with the tables: nothing is reconstructed from old reviews.
    expect(await getCodeReviewRounds(repo, 7)).toEqual({ count: null, rounds: [] });
    expect((await claim({ jobId: 'job-fresh' })).number).toBe(1);
  });
});
