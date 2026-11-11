import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import mysql from 'mysql2/promise';

// Opt in against a real MySQL server, like test/code-review-outcomes.mysql.test.js:
// lib/db.js is pointed at a randomly named database that only this file creates and
// drops, built the way the server builds it at boot. What is exercised here is the SQL
// the in-memory suites stand in for: the schema of the security review, the mark on a
// finding and on the decision that outlives it, the pass's stage with its coverage, and
// the security result stored beside the outcome in one transaction. GitHub is a stubbed
// `fetch`.
const scratch = vi.hoisted(() => ({
  database: `briareus_security_test_${Math.random().toString(16).slice(2, 14)}`,
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
  completeCodeReview,
  createCodeReview,
  dbHealthy,
  failCodeReview,
  failRunningCodeReviewStages,
  getCodeReviewOutcome,
  getCodeReviewSecurity,
  getProjectRow,
  listCodeReviewDecisions,
  listCodeReviewFindings,
  listCodeReviewOutcomesDue,
  listCodeReviewStages,
  listPullCodeReviews,
  markRepoCodeReviewOutcomesStale,
  restartCodeReview,
  saveCodeReviewDecisions,
  saveProject,
  setCodeReviewStage,
  updateCodeReviewFinding,
} from '../lib/db.js';
import {
  noteReviewedRevision,
  oweProjectOutcomes,
  readReviewOutcome,
  refreshReviewOutcome,
  retryReviewStatuses,
  reviewSecurity,
} from '../lib/review-enforcement.js';
import { verdictDecision } from '../lib/review-history.js';
import { requiredReviewStages } from '../lib/review-outcome.js';
import { securityClaims, unresolvedWork } from '../lib/review-rounds.js';
import { SECURITY_CATEGORIES, securityCoverage, securityPassCompleted } from '../lib/review-security.js';
import { up, down } from '../migrations/2026_11_10_150000_add_code_review_security.js';

describe.skipIf(process.env.CODE_REVIEW_MYSQL !== '1')('the security review on MySQL', () => {
  const repo = 'acme/shop';
  const sha = (letter) => letter.repeat(40);
  const STAGES = requiredReviewStages({ security: true });
  const off = { repo, reviewRoundLimit: 3 };
  const advisory = { ...off, securityReview: 'advisory' };
  const required = { ...off, securityReview: 'required' };
  const enforcing = { ...required, enforceReviewOutcome: true };
  const cfg = { githubToken: 'server-token' };
  let bootstrap, pool, requests, carried;
  const columns = async (table) => {
    const [rows] = await pool.query(
      'SELECT COLUMN_NAME AS name FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION',
      [table],
    );
    return rows.map((r) => r.name);
  };
  const columnType = async (table, column) => {
    const [rows] = await pool.query(
      'SELECT DATA_TYPE AS type FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?',
      [table, column],
    );
    return rows[0]?.type;
  };
  const hasTable = async (table) => {
    const [rows] = await pool.query(
      'SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?',
      [table],
    );
    return rows.length > 0;
  };
  // The record a pass leaves, as the server keeps it once it accepted it.
  const coverage = (letter, findings = 0) =>
    securityCoverage(
      {
        head: sha(letter),
        status: 'complete',
        categories: SECURITY_CATEGORIES.map(({ id }) => ({
          id,
          applicable: id === 'secrets',
          assessment: 'Read the changed handler and what it logs and returns.',
        })),
        findings: Array.from({ length: findings }, (_, i) => ({
          category: 'secrets',
          severity: 'high',
          title: `Finding ${i + 1}`,
        })),
      },
      sha(letter),
    );
  // A review whose discovery verified `letter`'s head, with the stages it must complete.
  async function started(prNumber, letter, { stages = STAGES } = {}) {
    const jobId = `job-${prNumber}-${letter}`;
    await createCodeReview({ jobId, repo, prNumber, branch: 'feature' });
    await restartCodeReview(jobId, sha(letter));
    const id = await beginCodeReviewStages(jobId, { headSha: sha(letter), baseRef: 'main', stages });
    return { jobId, id, head: sha(letter), stages };
  }
  // The same, run to its end: every stage seen to complete, the pass as given.
  async function reviewed(prNumber, letter, { pass = {}, stages = STAGES } = {}) {
    const review = await started(prNumber, letter, { stages });
    for (const stage of stages) {
      const seen =
        stage === 'security'
          ? { status: 'completed', detail: { coverage: coverage(letter) }, ...pass }
          : { status: 'completed' };
      await setCodeReviewStage(review.jobId, stage, review.head, seen);
    }
    await completeCodeReview(review.jobId);
    return review;
  }
  // A registered security finding, published as the record's first finding unless told.
  const marked = (over = {}) => ({
    severity: 'high',
    title: 'Token logged',
    security: true,
    securityEntry: 1,
    shouldFix: 'optional',
    verification: 'confirmed',
    comments: 'Only at debug level, lib/auth.js:10',
    findingRef: `ref-${Math.random().toString(16).slice(2, 10)}`,
    ...over,
  });
  // A finding's verdict written as the routes write it (lib/code-reviews.js).
  const rule = (review, prNumber, findingId, changes) =>
    updateCodeReviewFinding(review.id, findingId, changes, {
      repo,
      prNumber,
      build: (finding, previous) =>
        verdictDecision({ headSha: review.head }, finding, previous, changes, {
          source: 'review',
          decidedBy: `session:${review.jobId}`,
        }),
    });
  const refresh = async (project, prNumber, options = {}) => {
    const { outcome, published } = await refreshReviewOutcome(project, prNumber, {
      cfg,
      retryDelayMs: 0,
      ...options,
    });
    return { outcome, published: await published };
  };
  const posted = () =>
    requests.filter((r) => r.method === 'POST').map((r) => [r.url.split('/').pop(), r.body.state]);

  beforeAll(async () => {
    const { database, ...config } = getConfig().db;
    expect(database).toBe(scratch.database);
    bootstrap = await mysql.createConnection(config);
    // The first query makes lib/db.js create the database and run every migration.
    expect(await dbHealthy()).toBe(true);
    pool = mysql.createPool({ ...config, database, connectionLimit: 3 });
    requests = [];
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

  it('adds the table, the policy and the two marks at boot, and applies twice', async () => {
    const [ran] = await pool.query('SELECT `migration` FROM `migrations` WHERE `migration` = ?', [
      '2026_11_10_150000_add_code_review_security',
    ]);
    expect(ran).toHaveLength(1);
    const projects = await columns('projects');
    expect(projects[projects.indexOf('enforce_review_outcome') + 1]).toBe('security_review');
    const findings = await columns('code_review_findings');
    expect(findings[findings.indexOf('type') + 1]).toBe('security');
    expect(findings[findings.indexOf('security') + 1]).toBe('security_entry');
    // The stage's detail holds a whole coverage record now.
    expect(await columnType('code_review_stages', 'detail')).toBe('mediumtext');
    const decisions = await columns('code_review_decisions');
    expect(decisions[decisions.indexOf('verification') + 1]).toBe('security');
    const outcomes = await columns('code_review_outcomes');
    const stages = await columns('code_review_stages');
    await up({ context: pool });
    await up({ context: pool });
    expect(await columns('projects')).toEqual(projects);
    expect(await columns('code_review_findings')).toEqual(findings);
    expect(await columns('code_review_decisions')).toEqual(decisions);
    // The earlier workstreams' tables are as they were: the pass is a stage row.
    expect(await columns('code_review_outcomes')).toEqual(outcomes);
    expect(outcomes).not.toContain('security_policy');
    expect(await columns('code_review_stages')).toEqual(stages);
    expect(await columns('code_review_security')).toEqual([
      'repo',
      'pr_number',
      'code_review_id',
      'head_sha',
      'reviewed_sha',
      'policy',
      'result',
      'blocking',
      'stale',
      'reasons',
      'coverage',
      'computed_at',
      'created_at',
      'updated_at',
    ]);
  });

  it('stores the policy by name, off for a project that never set it', async () => {
    await pool.query(
      "INSERT INTO `projects` (`repo`, `label`, `created_at`, `updated_at`) VALUES ('acme/legacy', 'Legacy', 1, 1)",
    );
    const [rows] = await pool.query("SELECT `id` FROM `projects` WHERE `repo` = 'acme/legacy'");
    const legacy = await getProjectRow(rows[0].id);
    expect(legacy.securityReview).toBe('off');
    for (const policy of ['advisory', 'required', 'off'])
      expect((await saveProject({ ...legacy, securityReview: policy })).securityReview).toBe(policy);
    // The store keeps nothing it does not know, even if a caller hands it something else.
    expect((await saveProject({ ...legacy, securityReview: 'sometimes' })).securityReview).toBe('off');
    expect((await saveProject({ repo: 'acme/new', label: 'New', enabled: true })).securityReview).toBe('off');
    await expect(
      pool.query("UPDATE `projects` SET `security_review` = 'sometimes' WHERE `repo` = 'acme/legacy'"),
    ).rejects.toThrow();
    // Nothing else of the project is touched by it.
    expect((await getProjectRow(rows[0].id)).enforceReviewOutcome).toBe(false);
  });

  it('records the pass as a stage of the review, with the coverage the server accepted', async () => {
    const review = await started(7, 'a', {
      stages: requiredReviewStages({ security: true, delegation: true }),
    });
    expect((await listCodeReviewStages(review.id)).map((s) => [s.stage, s.status])).toEqual([
      ['discover', 'running'],
      ['security', 'pending'],
      ['publish', 'pending'],
      ['delegation', 'pending'],
      ['verify', 'pending'],
      ['label', 'pending'],
    ]);
    const stageOf = async () => (await listCodeReviewStages(review.id)).find((s) => s.stage === 'security');
    await setCodeReviewStage(review.jobId, 'discover', review.head, { status: 'completed' });
    await setCodeReviewStage(review.jobId, 'security', review.head, { status: 'running' });
    expect(await stageOf()).toMatchObject({ status: 'running', detail: null, endedAt: null });
    expect(securityPassCompleted(await listCodeReviewStages(review.id), review.head)).toBe(false);
    // A record for another head marks nothing.
    expect(
      await setCodeReviewStage(review.jobId, 'security', sha('b'), {
        status: 'completed',
        detail: { coverage: coverage('b') },
      }),
    ).toBe(false);
    expect((await stageOf()).status).toBe('running');
    // The turn stopped: whatever was under way failed, with why.
    await failRunningCodeReviewStages(review.jobId, review.head, { error: 'Codex entry exited with code 1' });
    expect(await stageOf()).toMatchObject({
      status: 'failed',
      detail: { error: 'Codex entry exited with code 1' },
    });
    // Run again and completed on its record: the coverage comes back as it was stored,
    // text beyond ASCII included.
    const kept = coverage('a', 2);
    kept.categories[1].assessment = 'Lee el token de sesión y lo registra — «debug» 🔐';
    await setCodeReviewStage(review.jobId, 'security', review.head, {
      status: 'completed',
      detail: { coverage: kept },
    });
    const completed = await stageOf();
    expect(completed).toMatchObject({ status: 'completed', headSha: review.head });
    expect(completed.detail.coverage).toEqual(kept);
    expect(completed.startedAt).toBeTruthy();
    expect(completed.endedAt).toBeTruthy();
    expect(securityPassCompleted(await listCodeReviewStages(review.id), review.head)).toBe(true);
    // A rerun of the review starts the pass over with everything else.
    await restartCodeReview(review.jobId, sha('c'));
    expect(await listCodeReviewStages(review.id)).toEqual([]);
  });

  it('marks a finding and the decision that outlives it, and never takes the mark back', async () => {
    const review = await reviewed(8, 'a');
    const plain = await addCodeReviewFinding(review.id, {
      severity: 'low',
      title: 'Typo',
      type: 'security',
      findingRef: 'ref-plain',
    });
    const secure = await addCodeReviewFinding(
      review.id,
      marked({
        shouldFix: null,
        verification: null,
        comments: null,
        findingRef: 'ref-sec',
        threadId: 'PRRT_sec',
        commentId: 501,
      }),
    );
    // The free-text type is not the mark.
    expect(plain).toMatchObject({ type: 'security', security: false });
    expect(secure).toMatchObject({ security: true });
    expect((await listCodeReviewFindings(review.id)).map((f) => [f.title, f.security])).toEqual([
      ['Typo', false],
      ['Token logged', true],
    ]);
    expect((await listPullCodeReviews(repo, 8, 5))[0].findings.map((f) => f.security)).toEqual([false, true]);
    // Its verdict, written with its decision in one transaction, is a security claim's.
    await rule(review, 8, secure.id, {
      shouldFix: 'fix',
      verification: 'confirmed',
      comments: 'lib/auth.js:10',
    });
    await rule(review, 8, plain.id, {
      shouldFix: 'optional',
      verification: 'confirmed',
      comments: 'Cosmetic',
    });
    const decided = async () =>
      Object.fromEntries((await listCodeReviewDecisions(repo, 8)).map((d) => [d.findingRef, d]));
    expect((await decided())['ref-sec']).toMatchObject({
      verdict: 'fix',
      security: true,
      anchor: 'PRRT_sec',
    });
    expect((await decided())['ref-plain']).toMatchObject({ verdict: 'optional', security: false });
    // Ruled on again by somebody who says nothing of it, or says otherwise: still marked.
    await saveCodeReviewDecisions(repo, 8, [
      {
        anchor: 'PRRT_sec',
        findingRef: 'ref-sec',
        verdict: 'dismiss',
        rationale: 'Redacted in lib/log.js:12',
        verification: 'confirmed',
        source: 'api',
        decidedBy: 'user:1',
        decidedAt: Date.now() + 1000,
      },
    ]);
    await saveCodeReviewDecisions(repo, 8, [
      { anchor: 'PRRT_sec', findingRef: 'ref-sec', security: false, resolved: true },
    ]);
    expect((await decided())['ref-sec']).toMatchObject({
      verdict: 'dismiss',
      security: true,
      resolved: true,
    });
    // And a claim becomes one when a later review's pass marks it.
    await saveCodeReviewDecisions(repo, 8, [
      { anchor: `ref:ref-plain`, findingRef: 'ref-plain', security: true },
    ]);
    expect((await decided())['ref-plain']).toMatchObject({ verdict: 'optional', security: true });
    // What is unresolved carries the mark for the next round's pass.
    await saveCodeReviewDecisions(repo, 8, [
      {
        anchor: 'PRRT_owed',
        threadId: 'PRRT_owed',
        findingRef: 'ref-owed',
        title: 'SSRF',
        verdict: 'fix',
        source: 'review',
        decidedAt: Date.now(),
        security: true,
      },
    ]);
    expect(
      unresolvedWork(await listCodeReviewDecisions(repo, 8)).fix.map((f) => [f.findingRef, f.security]),
    ).toEqual([['ref-owed', true]]);
  });

  it('computes and stores the result beside the outcome, for each state of the policy', async () => {
    // Off, and no pass: nothing changes and nothing is required.
    await reviewed(20, 'a', { stages: requiredReviewStages() });
    const none = (await refresh(off, 20)).outcome;
    expect(none.outcome).toBe('passed');
    expect(none.security).toMatchObject({
      policy: 'off',
      result: 'not_required',
      blocking: false,
      stage: null,
    });
    expect(await getCodeReviewSecurity(repo, 20)).toMatchObject({
      policy: 'off',
      result: 'not_required',
      blocking: false,
      stale: false,
      reasons: [],
      coverage: null,
      headSha: sha('a'),
      reviewedSha: sha('a'),
    });
    expect((await getCodeReviewOutcome(repo, 20)).securityPolicy).toBe('off');
    // The same review under a policy that asks for a pass: not run, never passed.
    for (const [project, outcome] of [
      [advisory, 'passed'],
      [required, 'incomplete'],
    ]) {
      const result = (await refresh(project, 20)).outcome;
      expect(result.outcome).toBe(outcome);
      expect(result.security).toMatchObject({ result: 'not_run', blocking: project === required });
      expect(await getCodeReviewSecurity(repo, 20)).toMatchObject({
        policy: project.securityReview,
        result: 'not_run',
        blocking: project === required,
      });
    }
    expect((await getCodeReviewOutcome(repo, 20)).securityPolicy).toBe('required');
    expect((await getCodeReviewOutcome(repo, 20)).reasons.map((r) => [r.code, r.requirement])).toEqual([
      ['requirement_unmet', 'security'],
    ]);

    // A pass that completed with its coverage and nothing to fix passes, under every policy.
    const clean = await reviewed(21, 'a');
    for (const project of [off, advisory, required]) {
      const result = (await refresh(project, 21)).outcome;
      expect(result.outcome).toBe('passed');
      expect(result.security).toMatchObject({ result: 'passed', blocking: false, stage: 'completed' });
      expect(result.security.coverage).toEqual(coverage('a'));
    }
    const stored = await getCodeReviewSecurity(repo, 21);
    expect(stored).toMatchObject({ policy: 'required', result: 'passed', codeReviewId: clean.id });
    expect(stored.coverage).toEqual(coverage('a'));
    expect(stored.computedAt).toBeTruthy();

    // A pass that failed or was cut off: shown under advisory, blocking under required.
    for (const [prNumber, pass, code] of [
      [
        22,
        { status: 'failed', detail: { error: 'The security pass left no record, or one that is not JSON' } },
        'stage_failed',
      ],
      [23, { status: 'running', detail: null }, 'stage_interrupted'],
      [24, { status: 'completed', detail: null }, 'coverage_missing'],
    ]) {
      await reviewed(prNumber, 'a', { pass });
      const shown = (await refresh(advisory, prNumber)).outcome;
      expect(shown.outcome).toBe('passed');
      expect(shown.security).toMatchObject({ result: 'incomplete', blocking: false });
      expect(shown.security.reasons.map((r) => r.code)).toEqual([code]);
      const blocked = (await refresh(required, prNumber)).outcome;
      expect(blocked.outcome).toBe('incomplete');
      expect(blocked.reasons.map((r) => [r.code, r.effect, r.requirement])).toEqual([
        ['requirement_unmet', 'incomplete', 'security'],
      ]);
      expect(await getCodeReviewSecurity(repo, prNumber)).toMatchObject({
        result: 'incomplete',
        blocking: true,
      });
      expect((await getCodeReviewSecurity(repo, prNumber)).reasons.map((r) => r.code)).toEqual([code]);
    }
  });

  it('holds security findings to the evidence rule, and what the pass recorded to what was registered', async () => {
    const review = await reviewed(30, 'a', { pass: { detail: { coverage: coverage('a', 2) } } });
    const first = await addCodeReviewFinding(
      review.id,
      marked({ shouldFix: null, verification: null, comments: null }),
    );
    // One of two registered: the other never reached the pull request.
    let { outcome } = await refresh(required, 30);
    expect(outcome.security.result).toBe('incomplete');
    expect(outcome.security.reasons.map((r) => r.code)).toEqual([
      'findings_missing',
      'finding_without_verdict',
    ]);
    const second = await addCodeReviewFinding(
      review.id,
      marked({
        title: 'Key in the URL',
        securityEntry: 2,
        shouldFix: null,
        verification: null,
        comments: null,
      }),
    );
    // A general finding beside them is the outcome's alone.
    await addCodeReviewFinding(review.id, {
      severity: 'low',
      title: 'Typo',
      shouldFix: 'optional',
      verification: 'confirmed',
      comments: 'Cosmetic',
      findingRef: 'ref-typo',
    });
    // A required fix fails the pass; an unproven dismissal leaves it incomplete.
    await rule(review, 30, first.id, {
      shouldFix: 'fix',
      verification: 'confirmed',
      comments: 'lib/auth.js:10',
    });
    await rule(review, 30, second.id, {
      shouldFix: 'dismiss',
      verification: 'plausible',
      comments: 'Probably stripped',
    });
    ({ outcome } = await refresh(required, 30));
    expect(outcome.outcome).toBe('incomplete');
    expect(outcome.security.result).toBe('incomplete');
    expect(outcome.security.reasons.map((r) => [r.code, r.effect])).toEqual([
      ['fix_required', 'failed'],
      ['dismissal_unproven', 'incomplete'],
    ]);
    expect(outcome.security.counts).toEqual({
      findings: 2,
      fix: 1,
      optional: 0,
      dismissed: 0,
      suppressed: 0,
      unverified: 1,
    });
    await rule(review, 30, second.id, { verification: 'confirmed', comments: 'Stripped in lib/http.js:40' });
    ({ outcome } = await refresh(required, 30));
    expect(outcome.outcome).toBe('changes_required');
    expect(outcome.security).toMatchObject({ result: 'failed', blocking: true });
    expect(outcome.reasons.map((r) => r.code)).toEqual(['fix_required', 'requirement_unmet']);
    // The standing fix blocks whatever the policy; only the requirement follows it.
    for (const project of [off, advisory]) {
      const relaxed = (await refresh(project, 30)).outcome;
      expect(relaxed.outcome).toBe('changes_required');
      expect(relaxed.security).toMatchObject({ result: 'failed', blocking: false });
      expect(relaxed.reasons.map((r) => r.code)).toEqual(['fix_required']);
    }
    // Verified Optional and Dismissed alone pass.
    await rule(review, 30, first.id, {
      shouldFix: 'optional',
      verification: 'plausible',
      comments: 'Debug level only',
    });
    ({ outcome } = await refresh(required, 30));
    expect(outcome.outcome).toBe('passed');
    expect(outcome.security).toMatchObject({
      result: 'passed',
      counts: { findings: 2, optional: 1, dismissed: 1 },
    });
    expect(await getCodeReviewSecurity(repo, 30)).toMatchObject({
      result: 'passed',
      blocking: false,
      reasons: [],
    });
    // Each stored review reads its own result from the same rows.
    const [stored] = await listPullCodeReviews(repo, 30, 5);
    expect(reviewSecurity(required, stored, await listCodeReviewDecisions(repo, 30))).toMatchObject({
      result: 'passed',
      stage: 'completed',
      counts: { findings: 2 },
    });
  });

  it('keeps a dismissed security finding dismissed through a rerun and into the next review', async () => {
    // Round one: the pass finds it, verification refutes it, with the reason.
    const first = await reviewed(40, 'a', { pass: { detail: { coverage: coverage('a', 1) } } });
    const raised = await addCodeReviewFinding(
      first.id,
      marked({
        shouldFix: null,
        verification: null,
        comments: null,
        findingRef: 'ref-log',
        threadId: 'PRRT_log',
        commentId: 601,
      }),
    );
    await rule(first, 40, raised.id, {
      shouldFix: 'dismiss',
      verification: 'confirmed',
      comments: 'Redacted in lib/log.js:12',
    });
    expect((await refresh(required, 40)).outcome.security.result).toBe('passed');
    // The review is run again in the same session: its findings go, the decision stays.
    await restartCodeReview(first.jobId, first.head);
    expect(await listCodeReviewFindings(first.id)).toEqual([]);
    await beginCodeReviewStages(first.jobId, { headSha: first.head, baseRef: 'main', stages: STAGES });
    const kept = (await listCodeReviewDecisions(repo, 40)).find((d) => d.findingRef === 'ref-log');
    expect(kept).toMatchObject({
      verdict: 'dismiss',
      rationale: 'Redacted in lib/log.js:12',
      verification: 'confirmed',
      security: true,
      threadId: 'PRRT_log',
    });
    // The rerun's pass meets the claim again and suppresses it: registered, not posted.
    for (const stage of STAGES)
      await setCodeReviewStage(first.jobId, stage, first.head, {
        status: 'completed',
        ...(stage === 'security' ? { detail: { coverage: coverage('a', 1) } } : {}),
      });
    await completeCodeReview(first.jobId);
    const again = await addCodeReviewFinding(first.id, {
      severity: 'high',
      title: 'Token logged',
      security: true,
      securityEntry: 1,
      reconciliation: 'suppressed',
      findingRef: 'ref-log',
      priorThreadId: 'PRRT_log',
      priorDisposition: 'dismissed',
      priorReason: 'Redacted in lib/log.js:12',
      shouldFix: 'dismiss',
      comments: 'Not repeated: already dismissed. Redacted in lib/log.js:12',
    });
    expect(again).toMatchObject({
      reconciliation: 'suppressed',
      security: true,
      securityEntry: 1,
      commentId: null,
      threadId: null,
    });
    const rerun = (await refresh(required, 40)).outcome;
    expect(rerun.outcome).toBe('passed');
    expect(rerun.security).toMatchObject({ result: 'passed', counts: { findings: 1, suppressed: 1 } });
    // A later review of a new head, by another session, still knows it.
    const later = await reviewed(40, 'b', { pass: { detail: { coverage: coverage('b', 1) } } });
    await addCodeReviewFinding(later.id, {
      ...again,
      id: undefined,
      codeReviewId: undefined,
      createdAt: undefined,
      updatedAt: undefined,
      headSha: later.head,
    });
    const next = (
      await refresh(required, 40, { reviewId: later.id, current: { headSha: later.head, baseRef: 'main' } })
    ).outcome;
    expect(next.outcome).toBe('passed');
    expect(next.security).toMatchObject({ result: 'passed', headSha: later.head, counts: { suppressed: 1 } });
    expect((await listCodeReviewDecisions(repo, 40)).filter((d) => d.findingRef === 'ref-log')).toEqual([
      expect.objectContaining({ verdict: 'dismiss', rationale: 'Redacted in lib/log.js:12', security: true }),
    ]);
    // A security fix an earlier round left owed fails the later round's result.
    await saveCodeReviewDecisions(repo, 40, [
      {
        anchor: 'PRRT_owed',
        threadId: 'PRRT_owed',
        findingRef: 'ref-owed',
        title: 'SSRF',
        verdict: 'fix',
        source: 'review',
        decidedAt: Date.now(),
        security: true,
      },
    ]);
    const owed = (await refresh(required, 40)).outcome;
    expect(owed.outcome).toBe('changes_required');
    expect(owed.security.reasons.map((r) => [r.code, r.findingRef])).toEqual([['fix_owed', 'ref-owed']]);
  });

  it('accounts for each finding of the record by the row that publishes it, and by no other', async () => {
    // An earlier review's security pass left a dismissal with its reason on the pull request.
    await saveCodeReviewDecisions(repo, 70, [
      {
        anchor: 'PRRT_old',
        threadId: 'PRRT_old',
        findingRef: 'old-dismissed',
        title: 'Session id reaches the log',
        verdict: 'dismiss',
        rationale: 'Redacted in lib/log.js:12',
        verification: 'confirmed',
        source: 'review',
        decidedAt: Date.now(),
        resolved: true,
        security: true,
      },
    ]);
    // This review's pass recorded one new finding. Publication never registered it: it
    // registered a finding of the report as suppressed against that dismissal, which
    // carries the claim's mark, and marked an unrelated one itself.
    const review = await reviewed(70, 'a', { pass: { detail: { coverage: coverage('a', 1) } } });
    const inherited = await addCodeReviewFinding(review.id, {
      severity: 'high',
      title: 'Session id reaches the log',
      security: true,
      reconciliation: 'suppressed',
      findingRef: 'old-dismissed',
      priorThreadId: 'PRRT_old',
      shouldFix: 'dismiss',
      comments: 'Not repeated: already dismissed. Redacted in lib/log.js:12',
    });
    const nit = await addCodeReviewFinding(
      review.id,
      marked({ title: 'Unrelated nit', securityEntry: undefined }),
    );
    expect([inherited.securityEntry, nit.securityEntry]).toEqual([null, null]);
    carried.clear();
    requests.length = 0;
    const { outcome } = await refresh(enforcing, 70);
    expect(outcome.security.result).toBe('incomplete');
    expect(outcome.security.reasons).toEqual([
      expect.objectContaining({
        code: 'findings_missing',
        recorded: 1,
        registered: 0,
        entries: [{ id: 1, title: 'Finding 1' }],
      }),
    ]);
    expect(outcome.security.counts).toMatchObject({ findings: 2, suppressed: 1, optional: 1 });
    expect(outcome.outcome).toBe('incomplete');
    expect(posted()).toEqual([[sha('a'), 'error']]);
    // Registered as the publication of that finding, the pass passes.
    const published = await addCodeReviewFinding(review.id, marked({ title: 'Finding 1', securityEntry: 1 }));
    expect(published.securityEntry).toBe(1);
    expect((await listCodeReviewFindings(review.id)).map((f) => f.securityEntry)).toEqual([null, null, 1]);
    const after = (await refresh(enforcing, 70)).outcome;
    expect(after.outcome).toBe('passed');
    expect(after.security).toMatchObject({ result: 'passed', counts: { findings: 3 } });
    expect(posted().at(-1)).toEqual([sha('a'), 'success']);
  });

  it('keeps a whole record with the stage, however many findings and whatever their characters', async () => {
    const wide = (n) => '😀'.repeat(n);
    const record = {
      head: sha('a'),
      status: 'complete',
      categories: SECURITY_CATEGORIES.map(({ id }) => ({ id, applicable: true, assessment: wide(5000) })),
      findings: Array.from({ length: 100 }, () => ({
        category: 'secrets',
        severity: 'high',
        title: wide(500),
        filePath: wide(500),
      })),
      widened: wide(5000),
    };
    const kept = securityCoverage(record, sha('a'));
    // More than the TEXT column this detail used to be could hold.
    expect(Buffer.byteLength(JSON.stringify({ coverage: kept }))).toBeGreaterThan(65535);
    const review = await started(71, 'a');
    expect(
      await setCodeReviewStage(review.jobId, 'security', review.head, {
        status: 'completed',
        detail: { coverage: kept },
      }),
    ).toBe(true);
    const stage = (await listCodeReviewStages(review.id)).find((s) => s.stage === 'security');
    expect(stage.detail.coverage).toEqual(kept);
    expect(stage.detail.coverage.entries).toHaveLength(100);
    expect(securityPassCompleted(await listCodeReviewStages(review.id), review.head)).toBe(true);
  });

  it('does not take a resolved thread as proof of a security fix: the pass confirms it or it stays open', async () => {
    const fix = (over = {}) => ({
      anchor: 'PRRT_fix',
      threadId: 'PRRT_fix',
      findingRef: 'ref-fix',
      title: 'Token logged',
      verdict: 'fix',
      rationale: 'lib/auth.js:10',
      source: 'review',
      decidedAt: Date.now(),
      security: true,
      ...over,
    });
    // Round one required the fix. The author pushed and resolved the thread.
    await saveCodeReviewDecisions(repo, 72, [fix()]);
    await saveCodeReviewDecisions(repo, 72, [{ anchor: 'PRRT_fix', findingRef: 'ref-fix', resolved: true }]);
    const decisions = await listCodeReviewDecisions(repo, 72);
    expect(securityClaims(decisions).map((c) => [c.findingRef, c.status])).toEqual([
      ['ref-fix', 'addressed'],
    ]);
    // For everything else that claim is settled, as it always was.
    expect(unresolvedWork(decisions)).toEqual({ fix: [], unverified: [] });
    // Round two's pass was clean and never looked at it.
    await reviewed(72, 'b');
    const unchecked = (await refresh(required, 72)).outcome;
    expect(unchecked.outcome).toBe('incomplete');
    expect(unchecked.security.reasons).toEqual([
      expect.objectContaining({
        code: 'security_fix_unchecked',
        findingRef: 'ref-fix',
        threadId: 'PRRT_fix',
      }),
    ]);
    expect((await refresh(advisory, 72)).outcome).toMatchObject({
      outcome: 'passed',
      security: { result: 'incomplete' },
    });
    // A pass that was given the claim and recorded where the fix is settles it.
    const head = sha('b');
    const confirmed = securityCoverage(
      {
        head,
        status: 'complete',
        categories: SECURITY_CATEGORIES.map(({ id }) => ({
          id,
          applicable: id === 'secrets',
          assessment: 'Read the changed handler and what it logs and returns.',
        })),
        findings: [],
        claims: [
          { findingRef: 'ref-fix', status: 'fixed', evidence: 'Redacted before logging, lib/log.js:12.' },
        ],
      },
      head,
      { claims: ['ref-fix'] },
    );
    await setCodeReviewStage('job-72-b', 'security', head, {
      status: 'completed',
      detail: { coverage: confirmed },
    });
    const checked = (await refresh(required, 72)).outcome;
    expect(checked.outcome).toBe('passed');
    expect(checked.security).toMatchObject({ result: 'passed', reasons: [] });
    expect((await getCodeReviewSecurity(repo, 72)).coverage.claims).toEqual(confirmed.claims);
    // The same history on a claim that is not a security one asks nothing of the pass.
    await saveCodeReviewDecisions(repo, 73, [fix({ security: false })]);
    await saveCodeReviewDecisions(repo, 73, [{ anchor: 'PRRT_fix', findingRef: 'ref-fix', resolved: true }]);
    await reviewed(73, 'b');
    expect((await refresh(required, 73)).outcome).toMatchObject({
      outcome: 'passed',
      security: { result: 'passed' },
    });
  });

  it('does not pass a pass that found nothing when the review’s publication did not complete', async () => {
    const review = await started(74, 'a');
    await setCodeReviewStage(review.jobId, 'discover', review.head, { status: 'completed' });
    await setCodeReviewStage(review.jobId, 'security', review.head, {
      status: 'completed',
      detail: { coverage: coverage('a') },
    });
    await setCodeReviewStage(review.jobId, 'publish', review.head, { status: 'running' });
    await failRunningCodeReviewStages(review.jobId, review.head, { error: 'Codex entry exited with code 1' });
    await failCodeReview(review.jobId);
    const { outcome } = await refresh(required, 74);
    expect(outcome.security.result).toBe('incomplete');
    expect(outcome.security.reasons.map((r) => r.code)).toEqual(['publication_incomplete']);
    expect(await getCodeReviewSecurity(repo, 74)).toMatchObject({ result: 'incomplete', blocking: true });
  });

  it('recomputes all stored outcomes of a project when its settings change', async () => {
    carried.clear();
    requests.length = 0;
    const on = { ...off, enforceReviewOutcome: true };
    // Three pull requests reviewed and passed while the project asked for no pass.
    for (const prNumber of [80, 81, 82]) {
      await reviewed(prNumber, 'c', { stages: requiredReviewStages() });
      await refresh(on, prNumber);
    }
    expect(await listCodeReviewOutcomesDue({ now: Date.now() })).toEqual([]);
    // The project is switched to `required`. 80 and 81 are open; 82 was merged; 83 is
    // open and was never reviewed, so it has no outcome to recompute; the board is not consulted.
    expect(await oweProjectOutcomes(enforcing)).toBeGreaterThanOrEqual(3);
    const due = await listCodeReviewOutcomesDue({ now: Date.now() });
    expect(due.map((row) => [row.repo, row.prNumber, !!row.recomputeAt])).toEqual(
      expect.arrayContaining([
        [repo, 80, true],
        [repo, 81, true],
        [repo, 82, true],
      ]),
    );
    // Marked once, however often the project is saved before the sweep runs.
    const since = due.map((row) => row.recomputeAt);
    expect(await markRepoCodeReviewOutcomesStale(repo, [80, 81])).toBe(2);
    expect((await listCodeReviewOutcomesDue({ now: Date.now() })).map((row) => row.recomputeAt)).toEqual(
      since,
    );
    expect(await markRepoCodeReviewOutcomesStale(repo, [])).toBe(0);
    expect(await markRepoCodeReviewOutcomesStale('acme/other', null)).toBe(0);
    // The sweep pays it: every stored outcome follows the new policy.
    const swept = await retryReviewStatuses({ getProject: () => enforcing, cfg, retryDelayMs: 0 });
    expect(swept).toEqual(
      expect.arrayContaining([
        { repo, prNumber: 80, published: true },
        { repo, prNumber: 81, published: true },
        { repo, prNumber: 82, published: true },
      ]),
    );
    for (const prNumber of [80, 81, 82]) {
      expect(await getCodeReviewOutcome(repo, prNumber)).toMatchObject({
        outcome: 'incomplete',
        securityPolicy: 'required',
        recomputeAt: null,
      });
      expect(await getCodeReviewSecurity(repo, prNumber)).toMatchObject({
        result: 'not_run',
        blocking: true,
      });
    }
    expect(posted().slice(-2)).toEqual([
      [sha('c'), 'error'],
      [sha('c'), 'error'],
    ]);
    // A closed PR also gets a harmless refresh rather than trusting the board's list.
    expect(await getCodeReviewOutcome(repo, 82)).toMatchObject({
      outcome: 'incomplete',
      securityPolicy: 'required',
    });
    expect(await listCodeReviewOutcomesDue({ now: Date.now() })).toEqual([]);
    expect(await oweProjectOutcomes(on)).toBeGreaterThanOrEqual(3);
    const again = await listCodeReviewOutcomesDue({ now: Date.now() });
    expect(again.map((row) => row.prNumber)).toEqual(expect.arrayContaining([80, 81, 82]));
    await retryReviewStatuses({ getProject: () => on, cfg, retryDelayMs: 0 });
    expect(await getCodeReviewOutcome(repo, 80)).toMatchObject({ outcome: 'passed', securityPolicy: 'off' });
  });

  it('goes stale when the pull request moves, and follows a change of policy the next time it is seen', async () => {
    carried.clear();
    requests.length = 0;
    // Reviewed and passed while the project asked for no pass.
    await reviewed(50, 'a', { stages: requiredReviewStages() });
    const on = { ...off, enforceReviewOutcome: true };
    await refresh(on, 50);
    expect(posted()).toEqual([[sha('a'), 'success']]);
    // Seen again as it was, under the same policy: nothing to do.
    expect(
      await noteReviewedRevision(on, 50, { headSha: sha('a'), baseRef: 'main' }, { cfg, retryDelayMs: 0 }),
    ).toBeNull();
    // The project now requires the pass. A read says so at once, and GitHub is told the
    // next time the server sees the pull request: same head, same base.
    const read = await readReviewOutcome(enforcing, 50);
    expect(read.outcome).toBe('incomplete');
    expect(read.security).toMatchObject({ policy: 'required', result: 'not_run', blocking: true });
    expect(read.status).toMatchObject({ state: 'error', published: false, publishedState: 'success' });
    const seen = await noteReviewedRevision(
      enforcing,
      50,
      { headSha: sha('a'), baseRef: 'main' },
      { cfg, retryDelayMs: 0 },
    );
    expect(seen.outcome.outcome).toBe('incomplete');
    await seen.published;
    expect(posted().at(-1)).toEqual([sha('a'), 'error']);
    expect((await getCodeReviewOutcome(repo, 50)).securityPolicy).toBe('required');
    expect(
      await noteReviewedRevision(
        enforcing,
        50,
        { headSha: sha('a'), baseRef: 'main' },
        { cfg, retryDelayMs: 0 },
      ),
    ).toBeNull();
    // Reviewed again with the pass, it passes; a push then leaves the result pending.
    const again = await reviewed(50, 'a');
    const passed = await refresh(enforcing, 50, { reviewId: again.id });
    expect(passed.outcome.outcome).toBe('passed');
    expect(posted().at(-1)).toEqual([sha('a'), 'success']);
    const moved = await noteReviewedRevision(
      enforcing,
      50,
      { headSha: sha('b'), baseRef: 'main' },
      { cfg, retryDelayMs: 0 },
    );
    await moved.published;
    expect(moved.outcome.security).toMatchObject({ result: 'pending', stale: true, headSha: sha('a') });
    expect(await getCodeReviewSecurity(repo, 50)).toMatchObject({
      result: 'pending',
      stale: true,
      headSha: sha('b'),
      reviewedSha: sha('a'),
    });
    expect(posted().at(-1)).toEqual([sha('b'), 'pending']);
    // A failed review leaves its pass where it stopped.
    const cut = await started(51, 'a');
    await setCodeReviewStage(cut.jobId, 'discover', cut.head, { status: 'completed' });
    await setCodeReviewStage(cut.jobId, 'security', cut.head, { status: 'running' });
    expect((await refresh(required, 51, { reviewId: cut.id })).outcome.security.result).toBe('pending');
    await failCodeReview(cut.jobId);
    const stopped = (await refresh(required, 51)).outcome;
    expect(stopped.security.reasons.map((r) => r.code)).toEqual(['stage_interrupted']);
    expect(stopped.outcome).toBe('incomplete');
  });

  it('rolls back to the earlier schema and comes back up with nothing passed', async () => {
    const review = await reviewed(60, 'a');
    await addCodeReviewFinding(review.id, marked({ findingRef: 'ref-kept' }));
    await refresh(required, 60);
    const projects = await columns('projects');
    const findings = await columns('code_review_findings');
    const decisions = await columns('code_review_decisions');
    await down({ context: pool });
    await down({ context: pool });
    expect(await hasTable('code_review_security')).toBe(false);
    expect(await columns('projects')).not.toContain('security_review');
    expect(await columns('code_review_findings')).not.toContain('security');
    expect(await columns('code_review_findings')).not.toContain('security_entry');
    expect(await columns('code_review_decisions')).not.toContain('security');
    // With the passes gone, the stages' detail is the column it was.
    expect(await columnType('code_review_stages', 'detail')).toBe('text');
    // The passes go with it, so the earlier code, which requires every stage row it
    // finds, is not left with one it does not know. Every other record stays.
    const [passes] = await pool.query(
      "SELECT COUNT(*) AS n FROM `code_review_stages` WHERE `stage` = 'security'",
    );
    expect(Number(passes[0].n)).toBe(0);
    const [others] = await pool.query(
      'SELECT `stage` FROM `code_review_stages` s JOIN `code_reviews` r ON r.`id` = s.`code_review_id` WHERE r.`job_id` = ? ORDER BY s.`id`',
      [review.jobId],
    );
    expect(others.map((s) => s.stage)).toEqual(['discover', 'publish', 'verify', 'label']);
    const [kept] = await pool.query(
      'SELECT COUNT(*) AS n FROM `code_review_findings` WHERE `code_review_id` = ?',
      [review.id],
    );
    expect(Number(kept[0].n)).toBe(1);
    const [outcomes] = await pool.query('SELECT COUNT(*) AS n FROM `code_review_outcomes`');
    expect(Number(outcomes[0].n)).toBeGreaterThan(0);
    await up({ context: pool });
    expect(await columns('projects')).toEqual(projects);
    expect(await columns('code_review_findings')).toEqual(findings);
    expect(await columns('code_review_decisions')).toEqual(decisions);
    // Nothing is back-filled: no project asks for a pass, no finding or decision is a
    // security one, and a review reads as having run none.
    const [asking] = await pool.query(
      "SELECT COUNT(*) AS n FROM `projects` WHERE `security_review` <> 'off'",
    );
    expect(Number(asking[0].n)).toBe(0);
    expect((await listCodeReviewFindings(review.id)).map((f) => f.security)).toEqual([false]);
    expect((await listCodeReviewDecisions(repo, 8)).every((d) => d.security === false)).toBe(true);
    expect(await getCodeReviewSecurity(repo, 60)).toBeNull();
    expect((await getCodeReviewOutcome(repo, 60)).securityPolicy).toBeNull();
    expect((await readReviewOutcome(off, 60)).security).toMatchObject({ result: 'not_required' });
    const after = await readReviewOutcome(required, 60);
    expect(after.outcome).toBe('incomplete');
    expect(after.security).toMatchObject({ result: 'not_run', blocking: true });
  });
});
