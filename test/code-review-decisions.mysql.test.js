import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import mysql from 'mysql2/promise';

// Opt in against a real MySQL server: the normal suite needs no infrastructure.
// lib/db.js is pointed at a randomly named database that only this file creates and
// drops, and builds it the way the server does at boot: every migration, in order.
const scratch = vi.hoisted(() => ({
  database: `briareus_review_test_${Math.random().toString(16).slice(2, 14)}`,
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
  createCodeReview,
  dbHealthy,
  getCodeReviewFinding,
  listCodeReviewDecisions,
  listCodeReviewFindings,
  listPullCodeReviews,
  restartCodeReview,
  saveCodeReviewDecisions,
  updateCodeReviewFinding,
} from '../lib/db.js';
import { up, down } from '../migrations/2026_11_10_120000_add_code_review_decisions.js';

describe.skipIf(process.env.CODE_REVIEW_MYSQL !== '1')('code review decisions on MySQL', () => {
  const repo = 'acme/shop';
  const head = 'a'.repeat(40);
  const ADDED = [
    'finding_ref',
    'reconciliation',
    'comment_id',
    'thread_id',
    'head_sha',
    'prior_thread_id',
    'prior_disposition',
    'prior_reason',
    'prior_url',
    'revisit_reason',
  ];
  let bootstrap, pool, review;
  const columns = async (table) => {
    const [rows] = await pool.query(
      'SELECT COLUMN_NAME AS name FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION',
      [table],
    );
    return rows.map((r) => r.name);
  };
  const decision = async (prNumber, anchor) =>
    (await listCodeReviewDecisions(repo, prNumber)).find((d) => d.anchor === anchor);

  beforeAll(async () => {
    const { database, ...config } = getConfig().db;
    expect(database).toBe(scratch.database);
    bootstrap = await mysql.createConnection(config);
    // The first query makes lib/db.js create the database and run every migration.
    expect(await dbHealthy()).toBe(true);
    pool = mysql.createPool({ ...config, database, connectionLimit: 2 });
    review = await createCodeReview({ jobId: 'job-1', repo, prNumber: 7, branch: 'feature' });
  });
  afterAll(async () => {
    await pool?.end();
    await bootstrap?.query(`DROP DATABASE IF EXISTS \`${scratch.database}\``);
    await bootstrap?.end();
  });

  it('adds the decisions table and the finding columns at boot, and applies twice', async () => {
    const [ran] = await pool.query('SELECT `migration` FROM `migrations` ORDER BY `id` DESC LIMIT 1');
    expect(ran[0].migration).toBe('2026_11_10_120000_add_code_review_decisions');
    const before = await columns('code_review_findings');
    expect(before.slice(before.indexOf('comments') + 1, before.indexOf('created_at'))).toEqual(ADDED);
    await up({ context: pool });
    await up({ context: pool });
    expect(await columns('code_review_findings')).toEqual(before);
    expect(await columns('code_review_decisions')).toEqual([
      'id',
      'repo',
      'pr_number',
      'anchor',
      'thread_id',
      'comment_id',
      'finding_ref',
      'title',
      'file_path',
      'line',
      'verdict',
      'rationale',
      'source',
      'decided_by',
      'head_sha',
      'raised_sha',
      'resolved',
      'decided_at',
      'created_at',
      'updated_at',
    ]);
  });

  it('stores how a finding relates to earlier threads and reads it back', async () => {
    await restartCodeReview('job-1', head);
    const plain = await addCodeReviewFinding(review.id, { severity: 'low', title: 'Plain' });
    expect(plain).toMatchObject({
      reconciliation: 'new',
      findingRef: null,
      commentId: null,
      threadId: null,
      headSha: null,
      priorThreadId: null,
      priorDisposition: null,
      priorReason: null,
      priorUrl: null,
      revisitReason: null,
    });
    const suppressed = await addCodeReviewFinding(review.id, {
      severity: 'medium',
      title: 'Unbounded retry',
      shouldFix: 'dismiss',
      comments: 'Not repeated: already dismissed.',
      reconciliation: 'suppressed',
      findingRef: 'ref-1',
      headSha: head,
      priorThreadId: 'PRRT_kwAbC',
      priorDisposition: 'dismissed',
      priorReason: 'The caller caps retries at three.',
      priorUrl: 'https://github.com/acme/shop/pull/7#discussion_r11',
    });
    expect(suppressed).toMatchObject({
      reconciliation: 'suppressed',
      findingRef: 'ref-1',
      shouldFix: 'dismiss',
      headSha: head,
      priorThreadId: 'PRRT_kwAbC',
      priorDisposition: 'dismissed',
      priorReason: 'The caller caps retries at three.',
    });
    // GitHub comment ids are past 32 bits.
    const posted = await addCodeReviewFinding(review.id, {
      severity: 'high',
      title: 'Lost update',
      reconciliation: 'revisit',
      findingRef: 'ref-2',
      commentId: 5123456789,
      revisitReason: 'The guard was removed in this push.',
    });
    expect(posted).toMatchObject({ commentId: 5123456789, threadId: null, reconciliation: 'revisit' });
    const linked = await updateCodeReviewFinding(review.id, posted.id, { threadId: 'PRRT_kwXyZ' });
    expect(linked).toMatchObject({
      threadId: 'PRRT_kwXyZ',
      revisitReason: 'The guard was removed in this push.',
    });
    expect((await listCodeReviewFindings(review.id)).map((f) => f.reconciliation)).toEqual([
      'new',
      'suppressed',
      'revisit',
    ]);
    const [stored] = await listPullCodeReviews(repo, 7, 20);
    expect(stored.findings.map((f) => f.findingRef)).toEqual([null, 'ref-1', 'ref-2']);
    await expect(
      addCodeReviewFinding(review.id, { severity: 'low', title: 't', reconciliation: 'maybe' }),
    ).rejects.toThrow();
  });

  it('keeps a decision moving forward only, and what the row describes filled in', async () => {
    const pr = 8;
    const anchor = 'PRRT_thread1';
    // Tracked when published: no verdict yet.
    await saveCodeReviewDecisions(repo, pr, [
      {
        anchor,
        threadId: anchor,
        commentId: 5123456790,
        findingRef: 'ref-a',
        title: 'Race in the queue',
        filePath: 'lib/queue.js',
        line: 12,
        raisedSha: head,
        resolved: false,
      },
    ]);
    expect(await decision(pr, anchor)).toMatchObject({
      repo,
      prNumber: pr,
      threadId: anchor,
      commentId: 5123456790,
      findingRef: 'ref-a',
      title: 'Race in the queue',
      filePath: 'lib/queue.js',
      line: 12,
      verdict: null,
      rationale: null,
      source: null,
      decidedBy: null,
      decidedAt: null,
      resolved: false,
      raisedSha: head,
    });
    // The verification step rules on it.
    await saveCodeReviewDecisions(repo, pr, [
      {
        anchor,
        findingRef: 'ref-other',
        verdict: 'dismiss',
        rationale: 'The lock is taken by the caller.',
        source: 'review',
        decidedBy: 'session:job-1',
        headSha: head,
        decidedAt: 2000,
      },
    ]);
    expect(await decision(pr, anchor)).toMatchObject({
      // The reference is kept once given, and a row without the description leaves it.
      findingRef: 'ref-a',
      title: 'Race in the queue',
      commentId: 5123456790,
      verdict: 'dismiss',
      rationale: 'The lock is taken by the caller.',
      source: 'review',
      decidedBy: 'session:job-1',
      headSha: head,
      decidedAt: new Date(2000).toISOString(),
    });
    // A stale reading of GitHub (an older verdict reply) changes nothing but what was seen.
    await saveCodeReviewDecisions(repo, pr, [
      {
        anchor,
        findingRef: 'ref-a',
        resolved: true,
        verdict: 'fix',
        rationale: 'older',
        source: 'github',
        decidedBy: 'octo-reviewer',
        decidedAt: 1000,
      },
    ]);
    expect(await decision(pr, anchor)).toMatchObject({
      verdict: 'dismiss',
      rationale: 'The lock is taken by the caller.',
      source: 'review',
      decidedBy: 'session:job-1',
      decidedAt: new Date(2000).toISOString(),
      resolved: true,
    });
    // A refresh that carries no verdict leaves the decision, and `resolved` unsaid stays.
    await saveCodeReviewDecisions(repo, pr, [
      { anchor, findingRef: 'ref-a', title: 'Race in the queue (reworded)' },
    ]);
    expect(await decision(pr, anchor)).toMatchObject({
      verdict: 'dismiss',
      resolved: true,
      title: 'Race in the queue (reworded)',
    });
    // A later decision replaces all of it together, including a cleared verdict.
    await saveCodeReviewDecisions(repo, pr, [
      {
        anchor,
        findingRef: 'ref-a',
        verdict: 'fix',
        rationale: 'Reproduced.',
        source: 'api',
        decidedBy: 'user:4',
        decidedAt: 3000,
      },
    ]);
    expect(await decision(pr, anchor)).toMatchObject({
      verdict: 'fix',
      rationale: 'Reproduced.',
      source: 'api',
      decidedBy: 'user:4',
      headSha: null,
      decidedAt: new Date(3000).toISOString(),
    });
    await saveCodeReviewDecisions(repo, pr, [
      {
        anchor,
        findingRef: 'ref-a',
        verdict: null,
        rationale: null,
        source: 'api',
        decidedBy: 'user:4',
        decidedAt: 4000,
      },
    ]);
    expect(await decision(pr, anchor)).toMatchObject({
      verdict: null,
      rationale: null,
      source: 'api',
      decidedAt: new Date(4000).toISOString(),
    });
    // The same instant again is the same reply read again, and still applies.
    await saveCodeReviewDecisions(repo, pr, [
      {
        anchor,
        findingRef: 'ref-a',
        verdict: 'optional',
        rationale: 'Edited.',
        source: 'github',
        decidedBy: 'octo-reviewer',
        decidedAt: 4000,
      },
    ]);
    expect(await decision(pr, anchor)).toMatchObject({
      verdict: 'optional',
      rationale: 'Edited.',
      source: 'github',
    });
    expect(await listCodeReviewDecisions(repo, pr)).toHaveLength(1);
  });

  it('keys decisions per pull request, case-sensitively, and saves a batch whole', async () => {
    const pr = 9;
    await saveCodeReviewDecisions(repo, pr, [
      { anchor: 'PRRT_abc', threadId: 'PRRT_abc', findingRef: 'r1', verdict: 'fix', decidedAt: 10 },
      { anchor: 'PRRT_ABC', threadId: 'PRRT_ABC', findingRef: 'r2', verdict: 'optional', decidedAt: 10 },
      { anchor: 'ref:r3', findingRef: 'r3', verdict: 'dismiss', rationale: 'Not reachable.', decidedAt: 10 },
    ]);
    expect((await listCodeReviewDecisions(repo, pr)).map((d) => [d.anchor, d.threadId, d.verdict])).toEqual([
      ['PRRT_abc', 'PRRT_abc', 'fix'],
      ['PRRT_ABC', 'PRRT_ABC', 'optional'],
      ['ref:r3', null, 'dismiss'],
    ]);
    // The same thread id on another pull request or project is another row.
    await saveCodeReviewDecisions(repo, 10, [
      { anchor: 'PRRT_abc', findingRef: 'r9', verdict: 'dismiss', decidedAt: 10 },
    ]);
    await saveCodeReviewDecisions('acme/other', pr, [
      { anchor: 'PRRT_abc', findingRef: 'r8', decidedAt: 10 },
    ]);
    expect((await decision(pr, 'PRRT_abc')).verdict).toBe('fix');
    expect(await listCodeReviewDecisions('acme/other', pr)).toHaveLength(1);
    // One bad row and nothing of the batch is kept.
    await expect(
      saveCodeReviewDecisions(repo, 11, [
        { anchor: 'PRRT_ok', findingRef: 'r4', verdict: 'fix', decidedAt: 10 },
        { anchor: 'PRRT_bad', findingRef: 'r5', verdict: 'maybe', decidedAt: 10 },
      ]),
    ).rejects.toThrow();
    expect(await listCodeReviewDecisions(repo, 11)).toEqual([]);
    await saveCodeReviewDecisions(repo, 11, []);
    expect(await listCodeReviewDecisions(repo, 11)).toEqual([]);
  });

  it('keeps the decisions when a rerun deletes the review’s findings', async () => {
    await restartCodeReview('job-1', head);
    const finding = await addCodeReviewFinding(review.id, {
      severity: 'high',
      title: 'Kept after a rerun',
      findingRef: 'ref-keep',
      threadId: 'PRRT_keep',
    });
    await saveCodeReviewDecisions(repo, 7, [
      {
        anchor: 'PRRT_keep',
        threadId: 'PRRT_keep',
        findingRef: 'ref-keep',
        verdict: 'dismiss',
        rationale: 'Guarded upstream.',
        source: 'review',
        decidedBy: 'session:job-1',
        headSha: head,
        decidedAt: Date.now(),
      },
    ]);
    await restartCodeReview('job-1', 'b'.repeat(40));
    expect(await getCodeReviewFinding(review.id, finding.id)).toBeNull();
    expect(await listCodeReviewFindings(review.id)).toEqual([]);
    expect(await decision(7, 'PRRT_keep')).toMatchObject({
      verdict: 'dismiss',
      rationale: 'Guarded upstream.',
      headSha: head,
    });
    // Nothing ties a decision to the review row either: the session's records can go.
    await pool.query('DELETE FROM `code_reviews` WHERE `job_id` = ?', ['job-1']);
    expect((await decision(7, 'PRRT_keep')).verdict).toBe('dismiss');
  });

  it('rolls back to the earlier schema and gives older findings a reference on the way up', async () => {
    const legacy = await createCodeReview({ jobId: 'job-legacy', repo, prNumber: 12, branch: 'feature' });
    await down({ context: pool });
    await down({ context: pool });
    const [tables] = await pool.query("SHOW TABLES LIKE 'code_review_decisions'");
    expect(tables).toHaveLength(0);
    const rolledBack = await columns('code_review_findings');
    expect(rolledBack.filter((name) => ADDED.includes(name))).toEqual([]);
    expect(rolledBack.slice(-3)).toEqual(['comments', 'created_at', 'updated_at']);
    // A finding as the earlier schema stored it.
    const [res] = await pool.query(
      "INSERT INTO `code_review_findings` (`code_review_id`, `severity`, `title`, `should_fix`, `created_at`, `updated_at`) VALUES (?, 'low', 'Older finding', 'optional', 1, 1)",
      [legacy.id],
    );
    await up({ context: pool });
    expect(await getCodeReviewFinding(legacy.id, res.insertId)).toMatchObject({
      title: 'Older finding',
      shouldFix: 'optional',
      findingRef: `f${res.insertId}`,
      reconciliation: 'new',
      commentId: null,
      threadId: null,
    });
    expect(await listCodeReviewDecisions(repo, 7)).toEqual([]);
  });
});
