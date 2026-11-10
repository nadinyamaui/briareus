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
  codeReviewDecisionsSince,
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
    // Every migration runs first, which takes longer when another suite builds its own
    // database beside this one.
  }, 120_000);
  afterAll(async () => {
    await pool?.end();
    await bootstrap?.query(`DROP DATABASE IF EXISTS \`${scratch.database}\``);
    await bootstrap?.end();
  });

  it('adds the decisions table and the finding columns at boot, and applies twice', async () => {
    // By name, not as the latest: later migrations follow it.
    const [ran] = await pool.query('SELECT `migration` FROM `migrations` WHERE `migration` = ?', [
      '2026_11_10_120000_add_code_review_decisions',
    ]);
    expect(ran).toHaveLength(1);
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
      'finding_id',
      'title',
      'file_path',
      'line',
      'verdict',
      'rationale',
      // Added by the review outcome's migration, which follows this one at boot.
      'verification',
      'source',
      'decided_by',
      'head_sha',
      'raised_sha',
      'resolved',
      'resolved_before',
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

  it('knows when decisions began to be stored', async () => {
    const since = await codeReviewDecisionsSince();
    expect(since).toBeGreaterThan(Date.now() - 10 * 60000);
    expect(since).toBeLessThanOrEqual(Date.now());
  });

  it('fills in what a row describes and keeps the reference it was first given', async () => {
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
      findingId: null,
      title: 'Race in the queue',
      filePath: 'lib/queue.js',
      line: 12,
      verdict: null,
      rationale: null,
      source: null,
      decidedBy: null,
      decidedAt: null,
      resolved: false,
      resolvedBefore: false,
      raisedSha: head,
    });
    // A row without the description leaves it, and `resolved` unsaid stays.
    await saveCodeReviewDecisions(repo, pr, [{ anchor, findingRef: 'ref-other', resolved: true }]);
    await saveCodeReviewDecisions(repo, pr, [
      { anchor, findingRef: 'ref-a', title: 'Race in the queue (reworded)', raisedSha: 'c'.repeat(40) },
    ]);
    expect(await decision(pr, anchor)).toMatchObject({
      findingRef: 'ref-a',
      title: 'Race in the queue (reworded)',
      filePath: 'lib/queue.js',
      commentId: 5123456790,
      resolved: true,
      raisedSha: head,
      verdict: null,
    });
    expect(await listCodeReviewDecisions(repo, pr)).toHaveLength(1);
    await expect(saveCodeReviewDecisions(repo, pr, [{ findingRef: 'ref-a' }])).rejects.toThrow(
      /needs its anchor and reference/,
    );
  });

  it('keeps a stored decision above anything read from GitHub', async () => {
    const pr = 20;
    const github = (anchor, verdict, decidedAt, extra = {}) => ({
      anchor,
      threadId: anchor,
      findingRef: `ref-${anchor}`,
      verdict,
      rationale: `${verdict} on GitHub`,
      source: 'github',
      decidedBy: 'octo-reviewer',
      decidedAt,
      ...extra,
    });
    const stored = (anchor, verdict, decidedAt, extra = {}) => ({
      anchor,
      threadId: anchor,
      findingRef: `ref-${anchor}`,
      verdict,
      rationale: verdict ? `${verdict} stored` : null,
      source: 'review',
      decidedBy: 'session:job-1',
      headSha: head,
      findingId: 77,
      decidedAt,
      ...extra,
    });
    // History read from GitHub: the later reply stands, an older reading changes nothing.
    await saveCodeReviewDecisions(repo, pr, [github('T1', 'fix', 2000)]);
    await saveCodeReviewDecisions(repo, pr, [github('T1', 'dismiss', 1000)]);
    expect(await decision(pr, 'T1')).toMatchObject({ verdict: 'fix', source: 'github' });
    await saveCodeReviewDecisions(repo, pr, [github('T1', 'dismiss', 3000)]);
    expect(await decision(pr, 'T1')).toMatchObject({
      verdict: 'dismiss',
      rationale: 'dismiss on GitHub',
      source: 'github',
      decidedBy: 'octo-reviewer',
      decidedAt: new Date(3000).toISOString(),
    });
    // What the server was given replaces it, whatever the dates say.
    await saveCodeReviewDecisions(repo, pr, [stored('T1', 'fix', 2500)]);
    expect(await decision(pr, 'T1')).toMatchObject({
      verdict: 'fix',
      rationale: 'fix stored',
      source: 'review',
      decidedBy: 'session:job-1',
      headSha: head,
      findingId: 77,
      decidedAt: new Date(2500).toISOString(),
    });
    // And nothing read from GitHub lands on it again, however late the reply.
    await saveCodeReviewDecisions(repo, pr, [github('T1', 'dismiss', 9000, { resolved: true })]);
    expect(await decision(pr, 'T1')).toMatchObject({
      verdict: 'fix',
      source: 'review',
      decidedAt: new Date(2500).toISOString(),
      // What was seen of the thread is still refreshed.
      resolved: true,
    });
    // Among stored decisions the later stands; an older one arriving late does not.
    await saveCodeReviewDecisions(repo, pr, [
      stored('T1', 'optional', 4000, { source: 'api', decidedBy: 'user:4' }),
    ]);
    await saveCodeReviewDecisions(repo, pr, [stored('T1', 'fix', 3500)]);
    expect(await decision(pr, 'T1')).toMatchObject({
      verdict: 'optional',
      source: 'api',
      decidedBy: 'user:4',
    });
    // A cleared verdict is the server's decision too: the old reply does not come back.
    await saveCodeReviewDecisions(repo, pr, [
      stored('T1', null, 5000, { source: 'api', decidedBy: 'user:4' }),
    ]);
    await saveCodeReviewDecisions(repo, pr, [github('T1', 'dismiss', 9500)]);
    expect(await decision(pr, 'T1')).toMatchObject({
      verdict: null,
      rationale: null,
      source: 'api',
      decidedAt: new Date(5000).toISOString(),
    });
    // History does land on a thread a review tracks and has not ruled on.
    await saveCodeReviewDecisions(repo, pr, [
      { anchor: 'T2', threadId: 'T2', findingRef: 'ref-T2', title: 'Tracked' },
    ]);
    await saveCodeReviewDecisions(repo, pr, [github('T2', 'optional', 100)]);
    expect(await decision(pr, 'T2')).toMatchObject({
      verdict: 'optional',
      source: 'github',
      title: 'Tracked',
    });
  });

  it('records whether the thread was already closed when a fix was required', async () => {
    const pr = 21;
    const rule = (anchor, verdict, decidedAt, extra = {}) => ({
      anchor,
      threadId: anchor,
      findingRef: `ref-${anchor}`,
      verdict,
      rationale: 'because',
      source: 'review',
      decidedAt,
      ...extra,
    });
    const before = async (anchor) => (await decision(pr, anchor)).resolvedBefore;
    // Required on an open thread, resolved afterwards: that is a fix addressed.
    await saveCodeReviewDecisions(repo, pr, [
      { anchor: 'T_open', findingRef: 'ref-T_open', resolved: false },
    ]);
    await saveCodeReviewDecisions(repo, pr, [rule('T_open', 'fix', 1000)]);
    await saveCodeReviewDecisions(repo, pr, [{ anchor: 'T_open', findingRef: 'ref-T_open', resolved: true }]);
    expect(await before('T_open')).toBe(false);
    // The same verdict saved again later is not a fix first required now.
    await saveCodeReviewDecisions(repo, pr, [rule('T_open', 'fix', 2000, { source: 'api' })]);
    expect(await decision(pr, 'T_open')).toMatchObject({
      resolvedBefore: false,
      source: 'api',
      decidedAt: new Date(2000).toISOString(),
    });
    // Dismissed (which resolves the thread), then overruled: the fix is still owed, even
    // though no review has read the thread as resolved yet.
    await saveCodeReviewDecisions(repo, pr, [rule('T_dismissed', 'dismiss', 1000)]);
    expect(await before('T_dismissed')).toBe(false);
    await saveCodeReviewDecisions(repo, pr, [rule('T_dismissed', 'fix', 2000, { source: 'api' })]);
    expect(await before('T_dismissed')).toBe(true);
    await saveCodeReviewDecisions(repo, pr, [rule('T_dismissed', 'fix', 3000, { source: 'api' })]);
    expect(await before('T_dismissed')).toBe(true);
    // Required on a thread somebody had already resolved.
    await saveCodeReviewDecisions(repo, pr, [
      { anchor: 'T_closed', findingRef: 'ref-T_closed', resolved: true },
    ]);
    await saveCodeReviewDecisions(repo, pr, [rule('T_closed', 'fix', 1000)]);
    expect(await before('T_closed')).toBe(true);
    // A row that says so itself (history read from GitHub in order) is taken at its word.
    await saveCodeReviewDecisions(repo, pr, [
      rule('T_said', 'fix', 1000, { source: 'github', resolved: true, resolvedBefore: false }),
      rule('T_said2', 'fix', 1000, { source: 'github', resolved: false, resolvedBefore: true }),
    ]);
    expect(await before('T_said')).toBe(false);
    expect(await before('T_said2')).toBe(true);
  });

  it('writes a finding and the decision its verdict amounts to together, or neither', async () => {
    const pr = 22;
    const job = await createCodeReview({ jobId: 'job-22', repo, prNumber: pr, branch: 'feature' });
    const deciding = (changes, source = 'review') => ({
      repo,
      prNumber: pr,
      build: (finding, previous) => ({
        anchor: 'T_tx',
        threadId: 'T_tx',
        findingRef: finding.findingRef,
        findingId: finding.id,
        title: finding.title,
        verdict: finding.shouldFix,
        rationale: `${previous ? (previous.shouldFix ?? 'none') : 'new'} -> ${finding.shouldFix}`,
        source,
        decidedAt: Date.now(),
        ...changes,
      }),
    });
    // Registered with its verdict: the build sees the stored row, with no previous one.
    const finding = await addCodeReviewFinding(
      job.id,
      { severity: 'high', title: 'Lost update', findingRef: 'ref-tx', threadId: 'T_tx', shouldFix: 'fix' },
      deciding({}),
    );
    expect(await decision(pr, 'T_tx')).toMatchObject({
      findingRef: 'ref-tx',
      findingId: finding.id,
      title: 'Lost update',
      verdict: 'fix',
      rationale: 'new -> fix',
    });
    // Updated: the build sees the row as written and as it was.
    const updated = await updateCodeReviewFinding(
      job.id,
      finding.id,
      { shouldFix: 'optional' },
      deciding({}),
    );
    expect(updated.shouldFix).toBe('optional');
    expect(await decision(pr, 'T_tx')).toMatchObject({ verdict: 'optional', rationale: 'fix -> optional' });
    // A build that decides nothing writes the finding alone.
    await updateCodeReviewFinding(
      job.id,
      finding.id,
      { severity: 'low' },
      { repo, prNumber: pr, build: () => null },
    );
    expect((await getCodeReviewFinding(job.id, finding.id)).severity).toBe('low');
    expect((await decision(pr, 'T_tx')).verdict).toBe('optional');
    // A decision that cannot be kept takes the finding's change back with it.
    await expect(
      updateCodeReviewFinding(job.id, finding.id, { shouldFix: 'dismiss' }, deciding({ source: 'nobody' })),
    ).rejects.toThrow();
    expect((await getCodeReviewFinding(job.id, finding.id)).shouldFix).toBe('optional');
    expect((await decision(pr, 'T_tx')).verdict).toBe('optional');
    await expect(
      addCodeReviewFinding(job.id, { severity: 'low', title: 'Never stored' }, deciding({ anchor: null })),
    ).rejects.toThrow(/needs its anchor and reference/);
    expect((await listCodeReviewFindings(job.id)).map((f) => f.title)).toEqual(['Lost update']);
    // A finding a rerun removed is answered as missing, with nothing decided.
    expect(await updateCodeReviewFinding(job.id, 999999, { shouldFix: 'fix' }, deciding({}))).toBeNull();
    expect((await decision(pr, 'T_tx')).verdict).toBe('optional');
    // Only the finding whose verdict stands rewords the reason.
    const reword = (findingId, rationale) => ({
      repo,
      prNumber: pr,
      build: () => ({ anchor: 'T_tx', findingRef: 'ref-tx', findingId, rationale, rationaleOnly: true }),
    });
    await updateCodeReviewFinding(
      job.id,
      finding.id,
      { comments: 'x' },
      reword(finding.id + 1000, 'from another'),
    );
    expect((await decision(pr, 'T_tx')).rationale).toBe('fix -> optional');
    await updateCodeReviewFinding(job.id, finding.id, { comments: 'y' }, reword(finding.id, 'reworded'));
    expect(await decision(pr, 'T_tx')).toMatchObject({ verdict: 'optional', rationale: 'reworded' });
  });

  it('leaves a finding and its decision agreeing when a client and the review write at once', async () => {
    const pr = 23;
    const job = await createCodeReview({ jobId: 'job-23', repo, prNumber: pr, branch: 'feature' });
    const finding = await addCodeReviewFinding(job.id, {
      severity: 'high',
      title: 'Raced',
      findingRef: 'ref-race',
      threadId: 'T_race',
    });
    const write = (shouldFix, source) =>
      updateCodeReviewFinding(
        job.id,
        finding.id,
        { shouldFix },
        {
          repo,
          prNumber: pr,
          build: (stored) => ({
            anchor: 'T_race',
            threadId: 'T_race',
            findingRef: 'ref-race',
            findingId: stored.id,
            verdict: stored.shouldFix,
            rationale: 'raced',
            source,
            decidedAt: Date.now(),
          }),
        },
      );
    const verdicts = ['fix', 'optional', 'dismiss'];
    for (let round = 0; round < 8; round++) {
      await Promise.all(
        Array.from({ length: 6 }, (_, i) => write(verdicts[(round + i) % 3], i % 2 ? 'api' : 'review')),
      );
      const stored = await getCodeReviewFinding(job.id, finding.id);
      expect((await decision(pr, 'T_race')).verdict).toBe(stored.shouldFix);
    }
    // First writers of threads nobody has stored yet queue up rather than deadlock.
    await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        saveCodeReviewDecisions(
          repo,
          pr,
          ['T_new_c', 'T_new_a', 'T_new_b'].map((anchor) => ({
            anchor,
            threadId: anchor,
            findingRef: `ref-${anchor}`,
            verdict: 'fix',
            source: 'github',
            decidedAt: 1000 + i,
          })),
        ),
      ),
    );
    const rows = (await listCodeReviewDecisions(repo, pr)).filter((d) => d.anchor.startsWith('T_new_'));
    expect(rows.map((d) => [d.anchor, d.decidedAt])).toEqual(
      ['T_new_a', 'T_new_b', 'T_new_c'].map((anchor) => [anchor, new Date(1005).toISOString()]),
    );
  });

  it('keys decisions per pull request, case-sensitively, and saves a batch whole', async () => {
    const pr = 9;
    await saveCodeReviewDecisions(repo, pr, [
      { anchor: 'PRRT_abc', threadId: 'PRRT_abc', findingRef: 'r1', verdict: 'fix', decidedAt: 10 },
      { anchor: 'PRRT_ABC', threadId: 'PRRT_ABC', findingRef: 'r2', verdict: 'optional', decidedAt: 10 },
      { anchor: 'ref:r3', findingRef: 'r3', verdict: 'dismiss', rationale: 'Not reachable.', decidedAt: 10 },
    ]);
    // Stored in anchor order, so two batches take their locks the same way.
    expect((await listCodeReviewDecisions(repo, pr)).map((d) => [d.anchor, d.threadId, d.verdict])).toEqual([
      ['PRRT_ABC', 'PRRT_ABC', 'optional'],
      ['PRRT_abc', 'PRRT_abc', 'fix'],
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
