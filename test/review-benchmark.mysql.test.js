import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import mysql from 'mysql2/promise';

// Opt in against a real MySQL server, like test/code-review-security.mysql.test.js:
// lib/db.js is pointed at a randomly named database that only this file creates and
// drops, built the way the server builds it at boot. What is exercised here is the SQL
// the in-memory suites stand in for: the benchmark's schema and its store, the runner
// on the stored rows of a real code review, and the review quality reader.
const scratch = vi.hoisted(() => ({
  database: `briareus_benchmark_test_${Math.random().toString(16).slice(2, 14)}`,
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
  completeCodeReview,
  createCodeReview,
  dbHealthy,
  getProjectRow,
  githubStoreConnection,
  listPullCodeReviews,
  restartCodeReview,
  saveProject,
} from '../lib/db.js';
import {
  normalizeCase,
  answerSnapshot,
  caseStanding,
  scoreResult,
  summarizeRun,
} from '../lib/review-benchmark.js';
import { createBenchmarkStore } from '../lib/review-benchmark-store.js';
import { createBenchmarkRunner } from '../lib/review-benchmark-runner.js';
import { readReviewQualityRows, summarizeReviewQuality } from '../lib/review-quality.js';
import { up, down } from '../migrations/2026_11_12_130000_add_review_benchmarks.js';

describe.skipIf(process.env.CODE_REVIEW_MYSQL !== '1')('the review benchmark on MySQL', () => {
  const repo = 'acme/bench';
  const sha = (c) => c.repeat(40);
  let bootstrap, pool, store;
  const columns = async (table) => {
    const [rows] = await pool.query(
      'SELECT COLUMN_NAME AS name FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION',
      [table],
    );
    return rows.map((r) => r.name);
  };
  const caseOf = (key, over = {}) =>
    normalizeCase({
      key,
      title: `Change ${key}`,
      description: 'Adds a cache in front of the lookup.',
      baseSha: sha('a'),
      headSha: sha('b'),
      kind: 'defective',
      defects: [
        {
          id: 'd1',
          filePath: 'lib/a.js',
          startLine: 3,
          severity: 'high',
          summary: 'The cache never expires',
        },
      ],
      referenceFix: 'Give the cache entries a TTL.',
      origin: 'historical',
      ...over,
    });

  beforeAll(async () => {
    const { database, ...config } = getConfig().db;
    expect(database).toBe(scratch.database);
    bootstrap = await mysql.createConnection(config);
    expect(await dbHealthy()).toBe(true);
    pool = mysql.createPool({ ...config, database, connectionLimit: 3 });
    store = createBenchmarkStore();
  }, 120_000);
  afterAll(async () => {
    await pool?.end();
    await bootstrap?.query(`DROP DATABASE IF EXISTS \`${scratch.database}\``);
    await bootstrap?.end();
  });

  it('adds its tables and the project setting at boot, applies twice and rolls back', async () => {
    const [ran] = await pool.query('SELECT `migration` FROM `migrations` WHERE `migration` = ?', [
      '2026_11_12_130000_add_review_benchmarks',
    ]);
    expect(ran).toHaveLength(1);
    const projects = await columns('projects');
    expect(projects[projects.indexOf('approval_policy') + 1]).toBe('review_benchmark');
    await up({ context: pool });
    await down({ context: pool });
    expect(await columns('projects')).not.toContain('review_benchmark');
    expect(await columns('review_benchmark_cases')).toEqual([]);
    await down({ context: pool });
    await up({ context: pool });
    expect(await columns('review_benchmark_results')).toContain('cleanup_error');
  });

  it('stores the project setting', async () => {
    const saved = await saveProject({ repo, label: 'Bench', enabled: true, reviewBenchmark: true });
    expect(saved.reviewBenchmark).toBe(true);
    expect((await saveProject({ ...saved, reviewBenchmark: false })).reviewBenchmark).toBe(false);
    expect((await getProjectRow(saved.id)).reviewBenchmark).toBe(false);
  });

  it('keeps cases with their answers and adjudications of the answer as it stands', async () => {
    const created = await store.createCase(repo, caseOf('cache'), { userId: 1 });
    expect(created).toMatchObject({ key: 'cache', kind: 'defective', authoredBy: 1, origin: 'historical' });
    expect(created.defects[0]).toMatchObject({ id: 'd1', endLine: 3 });
    await expect(store.createCase(repo, caseOf('cache'), { userId: 1 })).rejects.toMatchObject({
      status: 409,
      code: 'case_exists',
    });
    // Keys are case-sensitive.
    await store.createCase(repo, caseOf('Cache'), { userId: 1 });
    await store.adjudicate(repo, created.id, { userId: 2, verdict: 'agree', note: 'right' });
    let read = await store.getCase(repo, created.id);
    expect(caseStanding(read, read.adjudications).status).toBe('adjudicated');
    // Ruling again on the same answer replaces the verdict.
    await store.adjudicate(repo, created.id, { userId: 2, verdict: 'disagree' });
    read = await store.getCase(repo, created.id);
    expect(read.adjudications).toHaveLength(1);
    expect(caseStanding(read, read.adjudications).status).toBe('disputed');
    // An edit moves the fingerprint: the earlier verdict is about another answer.
    const edited = await store.updateCase(repo, created.id, caseOf('cache', { kind: 'clean', defects: [] }));
    expect(edited.answerHash).not.toBe(read.answerHash);
    expect(caseStanding(edited, edited.adjudications)).toMatchObject({ status: 'draft', outdated: 1 });
    await store.adjudicate(repo, created.id, { userId: 3, verdict: 'agree' });
    expect((await store.getCase(repo, created.id)).adjudications).toHaveLength(2);
    const retired = await store.retireCase(repo, created.id, true);
    expect(retired.retiredAt).not.toBeNull();
    expect((await store.retireCase(repo, created.id, true)).retiredAt).toBe(retired.retiredAt);
    expect((await store.retireCase(repo, created.id, false)).retiredAt).toBeNull();
    expect((await store.listCases(repo)).map((c) => c.key)).toEqual(['Cache', 'cache']);
    expect(await store.getCase('acme/other', created.id)).toBeNull();
    await expect(
      store.adjudicate('acme/other', created.id, { userId: 2, verdict: 'agree' }),
    ).rejects.toMatchObject({
      status: 404,
    });
  });

  it('runs a case through a stored code review, judges its finding and scores it', async () => {
    const c = await store.createCase(repo, caseOf('runner'), { userId: 1 });
    const run = await store.createRun(repo, {
      label: 'baseline',
      requestedBy: 1,
      concurrency: 1,
      runtime: { model: 'opus' },
      configuration: { coreRevision: 'abc' },
      cases: [{ caseId: c.id, caseKey: c.key, answer: answerSnapshot(c) }],
    });
    expect(run).toMatchObject({ status: 'running', label: 'baseline', runtime: { model: 'opus' } });
    expect(run.results[0]).toMatchObject({ state: 'queued', caseKey: 'runner' });
    expect(await store.listRunningRuns()).toContain(run.id);

    const refs = new Map();
    const pulls = [];
    const json = (status, body) => ({ ok: status < 300, status, json: async () => body });
    const github = async (method, path, body) => {
      if (method === 'POST' && path.endsWith('/git/refs')) {
        refs.set(body.ref, body.sha);
        return json(201, {});
      }
      if (method === 'GET' && path.includes('/pulls?')) return json(200, []);
      if (method === 'POST' && path.endsWith('/pulls')) {
        pulls.push({ number: 41, ...body });
        return json(201, { number: 41 });
      }
      if (method === 'PATCH') return json(200, {});
      if (method === 'DELETE') return json(204, null);
      return json(500, {});
    };
    let jobId = null;
    const runner = createBenchmarkRunner({
      store,
      github,
      getProject: () => ({ repo, reviewBenchmark: true }),
      startReview: async ({ prNumber }) => {
        jobId = `bench-job-${run.id}`;
        await createCodeReview({ jobId, repo, prNumber, branch: 'review/x' });
        await restartCodeReview(jobId, sha('b'));
        return { jobId };
      },
      findReview: async (r, prNumber, wanted = null) => {
        const reviews = await listPullCodeReviews(r, prNumber, 20);
        return wanted ? reviews.find((x) => x.jobId === wanted) || null : reviews[0] || null;
      },
      readOutcome: async () => {
        const [review] = await listPullCodeReviews(repo, 41, 1);
        return { outcome: 'changes_required', reviewId: review.id, reasons: [] };
      },
      log: () => {},
    });
    await runner.tick();
    let result = (await store.getRun(repo, run.id)).results[0];
    expect(result).toMatchObject({ state: 'reviewing', prNumber: 41, jobId });
    expect(pulls[0].title).toBe('Change runner');

    const [review] = await listPullCodeReviews(repo, 41, 1);
    await addCodeReviewFinding(review.id, {
      severity: 'high',
      title: 'Entries live forever',
      filePath: 'lib/a.js',
      startLine: 4,
      shouldFix: 'fix',
      verification: 'confirmed',
    });
    await completeCodeReview(jobId);
    await runner.tick();
    const ended = await store.getRun(repo, run.id);
    expect(ended.status).toBe('completed');
    result = ended.results[0];
    expect(result).toMatchObject({ state: 'done', codeReviewId: review.id });
    expect(result.cleanedAt).not.toBeNull();
    expect(result.review.findings).toEqual([
      expect.objectContaining({ title: 'Entries live forever', shouldFix: 'fix' }),
    ]);
    expect(await store.listRunningRuns()).not.toContain(run.id);

    const findingId = result.review.findings[0].id;
    await store.saveJudgment(result.id, findingId, {
      assessment: 'matches',
      defectId: 'd1',
      harmfulFix: true,
      userId: 2,
    });
    await store.saveJudgment(result.id, findingId, {
      assessment: 'matches',
      defectId: 'd1',
      note: 'again',
      userId: 2,
    });
    const judged = (await store.getRun(repo, run.id)).results[0];
    expect(judged.judgments).toEqual([
      expect.objectContaining({
        findingId,
        assessment: 'matches',
        defectId: 'd1',
        harmfulFix: false,
        note: 'again',
      }),
    ]);
    const score = scoreResult(judged);
    expect(score).toMatchObject({ scored: true, outcomeCorrect: true });
    expect(score.defects[0]).toMatchObject({ status: 'caught', provisional: false });
    expect(summarizeRun([{ ...judged, score }]).defects.recall).toBe(1);
    expect(await store.deleteJudgment(result.id, findingId)).toBe(true);
    expect(await store.getRun('acme/other', run.id)).toBeNull();
  });

  it('cancels a run: queued cases never start, cases under way are wound down', async () => {
    const c = await store.createCase(repo, caseOf('cancel'), { userId: 1 });
    const d = await store.createCase(repo, caseOf('cancel-2'), { userId: 1 });
    const run = await store.createRun(repo, {
      requestedBy: 1,
      concurrency: 1,
      runtime: null,
      configuration: null,
      cases: [c, d].map((x) => ({ caseId: x.id, caseKey: x.key, answer: answerSnapshot(x) })),
    });
    const [first, second] = run.results;
    expect(
      await store.updateResult(first.id, { state: 'reviewing', prNumber: 7, headBranch: 'review/q' }),
    ).toBe(true);
    const cancelled = await store.cancelRun(repo, run.id);
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.results.map((r) => [r.state, r.cleanedAt != null])).toEqual([
      ['cancelled', false],
      ['cancelled', true],
    ]);
    // A move guarded on the state it expects loses to the cancellation.
    expect(await store.updateResult(first.id, { state: 'done' }, { from: ['reviewing'] })).toBe(false);
    // Its pull request still owes a cleanup, so the runner still has work in the run.
    expect(await store.listRunningRuns()).toContain(run.id);
    await store.updateResult(first.id, { cleanedAt: Date.now() });
    expect(await store.listRunningRuns()).not.toContain(run.id);
    expect(second.state).toBe('queued');
    await expect(store.cancelRun(repo, run.id)).rejects.toMatchObject({
      status: 409,
      code: 'run_not_running',
    });
    expect((await store.listRuns(repo)).map((r) => r.id)).toContain(run.id);
  });

  it('reads a project’s review records for the quality summary', async () => {
    const now = Date.now();
    const q = (sql, params) => pool.query(sql, params);
    await q(
      "INSERT INTO code_reviews (job_id, repo, pr_number, branch, provider, model, effort, cost_usd, cost_estimated, unpriced_turns, status, created_at, updated_at) VALUES ('q1', 'acme/q', 5, 'f', 'Codex', 'gpt', 'high', 1.25, 1, 2, 'completed', ?, ?), ('q2', 'acme/q', 5, 'f', 'Codex', 'gpt', 'high', NULL, 0, 0, 'failed', ?, ?), ('q3', 'acme/other', 1, 'f', 'X', '', '', 9, 0, 0, 'completed', ?, ?)",
      [now - 1000, now, now - 1000, now, now - 1000, now],
    );
    const [[{ id }]] = await q("SELECT id FROM code_reviews WHERE job_id = 'q1'");
    await q(
      "INSERT INTO code_review_findings (code_review_id, severity, title, reconciliation, created_at, updated_at) VALUES (?, 'high', 'a', 'suppressed', ?, ?), (?, 'low', 'b', 'new', ?, ?)",
      [id, now - 900, now, id, now - 900, now],
    );
    await q(
      "INSERT INTO code_review_decisions (repo, pr_number, anchor, finding_ref, verdict, source, decided_by, verification, decided_at, created_at, updated_at) VALUES ('acme/q', 5, 't1', 'r1', 'dismiss', 'api', 'user:3', 'confirmed', ?, ?, ?), ('acme/q', 5, 't2', 'r2', 'fix', 'review', 'session:q1', 'confirmed', ?, ?, ?)",
      [now - 100, now - 800, now, now - 700, now - 800, now],
    );
    await q(
      "INSERT INTO code_review_rounds (repo, pr_number, round, head_sha, base_ref, status, source, reviewed_at, created_at, updated_at) VALUES ('acme/q', 5, 1, ?, 'main', 'completed', 'user', ?, ?, ?)",
      [sha('c'), now - 600, now - 1000, now],
    );
    await q(
      "INSERT INTO code_review_round_counts (repo, pr_number, rounds, refused_at, created_at, updated_at) VALUES ('acme/q', 6, 3, ?, ?, ?)",
      [now - 5000, now, now],
    );
    await q(
      "INSERT INTO code_review_approvals (repo, pr_number, source, user_id, head_sha, base_ref, approved_at, created_at, updated_at) VALUES ('acme/q', 5, 'briareus', 3, ?, 'main', ?, ?, ?)",
      [sha('c'), now - 400, now, now],
    );
    await q(
      "INSERT INTO code_review_readiness (repo, pr_number, result, waiting_since, created_at, updated_at) VALUES ('acme/q', 7, 'pending', ?, ?, ?)",
      [now - 3000, now, now],
    );
    const window = { since: now - 86_400_000, until: now + 1 };
    const rows = await readReviewQualityRows(githubStoreConnection, 'acme/q', window);
    expect(rows.truncated).toEqual([]);
    const s = summarizeReviewQuality({ ...rows, ...window, now });
    expect(s.reviews).toMatchObject({ total: 2, pulls: 1, byStatus: { completed: 1, failed: 1 } });
    expect(s.cost).toMatchObject({ usd: 1.25, estimated: true, unpricedTurns: 2, reviewsWithoutCost: 1 });
    expect(s.repeats.byReconciliation).toEqual({ suppressed: 1, new: 1 });
    expect(s.dispositions).toMatchObject({
      claims: 2,
      bySource: { person: 1, review: 1 },
      byPeople: { dismiss: 1 },
    });
    expect(s.waiting.verdicts).toMatchObject({ count: 1, medianMs: 700 });
    expect(s.waiting.approvals).toMatchObject({ count: 1, medianMs: 200 });
    expect(s.waiting.now.atLimit).toMatchObject({ count: 1, maxMs: 5000 });
    expect(s.waiting.now.forApproval).toMatchObject({ count: 1, maxMs: 3000 });
    expect(s.rounds).toMatchObject({ pulls: 1, waitingAtLimit: 1 });
  });
});
