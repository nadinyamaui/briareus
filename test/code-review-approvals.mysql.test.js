import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import mysql from 'mysql2/promise';

// Opt in against a real MySQL server, like test/code-review-security.mysql.test.js:
// lib/db.js is pointed at a randomly named database that only this file creates and
// drops, built the way the server builds it at boot. What is exercised here is the SQL
// the in-memory suites stand in for: the project's policy, the risk record of a
// revision, the approvals with the key that holds a person to one standing approval per
// revision, and the approval requirement stored and published beside the outcome.
// GitHub is a stubbed `fetch`.
const scratch = vi.hoisted(() => ({
  database: `briareus_approvals_test_${Math.random().toString(16).slice(2, 14)}`,
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
  addCodeReviewApproval,
  beginCodeReviewStages,
  clearCodeReviewRiskRetry,
  completeCodeReview,
  createCodeReview,
  dbHealthy,
  dropCodeReviewStatusDebt,
  getCodeReviewOutcome,
  getCodeReviewReadiness,
  getCodeReviewRisk,
  getProjectRow,
  listCodeReviewApprovals,
  listCodeReviewOutcomesDue,
  listCodeReviewReadinessWaiting,
  listFailedCodeReviewStatuses,
  restartCodeReview,
  saveCodeReviewRisk,
  saveProject,
  setCodeReviewStage,
  syncGithubCodeReviewApprovals,
  withdrawCodeReviewApproval,
  clearCodeReviewWaiting,
  listCodeReviewCommitOwners,
  listCodeReviewStatusesAtHead,
  loadGithubLinkRows,
  oweCodeReviewStatusesAtHead,
  recordCodeReviewCommitOwners,
  saveGithubLink,
} from '../lib/db.js';
import {
  approvalsWaiting,
  noteReviewedRevision,
  oweProjectOutcomes,
  readReviewOutcome,
  refreshReviewOutcome,
  retryReviewStatuses,
  setApprovalDirectory,
} from '../lib/review-enforcement.js';
import { requiredReviewStages } from '../lib/review-outcome.js';
import { assessRisk, normalizeApprovalPolicy, policyFingerprint } from '../lib/review-risk.js';
import { up, down } from '../migrations/2026_11_10_160000_add_code_review_approvals.js';

describe.skipIf(process.env.CODE_REVIEW_MYSQL !== '1')('risk-based approvals on MySQL', () => {
  const repo = 'acme/shop';
  // A commit of the pull request a test is about: no two pull requests here share one
  // unless the test is about that, since GitHub's statuses hang on the commit.
  let about = 0;
  const sha = (letter) => `${letter.repeat(38)}${String(about).padStart(2, '0')}`;
  const STAGES = requiredReviewStages();
  const policy = normalizeApprovalPolicy({
    enabled: true,
    rules: [
      { pattern: '/migrations/', tier: 'high', label: 'Schéma ✓' },
      { pattern: '/config/', tier: 'medium' },
    ],
  });
  const plain = { id: 1, repo, reviewRoundLimit: 3 };
  const withPolicy = { ...plain, approvalPolicy: policy };
  const enforcing = { ...withPolicy, enforceReviewOutcome: true };
  const cfg = { githubToken: 'server-token' };
  let bootstrap, pool, requests, carried, github, refuse;
  const columns = async (table) => {
    const [rows] = await pool.query(
      'SELECT COLUMN_NAME AS name FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION',
      [table],
    );
    return rows.map((r) => r.name);
  };
  const hasTable = async (table) => {
    const [rows] = await pool.query(
      'SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?',
      [table],
    );
    return rows.length > 0;
  };
  // A review of `letter`'s head that ran to its end with every stage seen.
  async function reviewed(prNumber, letter, { head = prNumber } = {}) {
    about = head;
    const jobId = `job-${prNumber}-${letter}`;
    await createCodeReview({ jobId, repo, prNumber, branch: 'feature' });
    await restartCodeReview(jobId, sha(letter));
    const id = await beginCodeReviewStages(jobId, { headSha: sha(letter), baseRef: 'main', stages: STAGES });
    for (const stage of STAGES) await setCodeReviewStage(jobId, stage, sha(letter), { status: 'completed' });
    await completeCodeReview(jobId);
    return { jobId, id, head: sha(letter) };
  }
  // The pull request as GitHub answers for it, per pull request number.
  const pullAt = (prNumber, letter, files = ['migrations/002_orders.sql'], over = {}) => {
    github.set(prNumber, {
      pull: {
        state: 'open',
        head: { sha: sha(letter) },
        base: { ref: 'main' },
        user: { login: 'octo-author', id: 900 },
        changed_files: files.length,
        commits: 1,
      },
      files: files.map((filename) => ({ filename, status: 'modified', additions: 2, deletions: 1 })),
      commits: [
        {
          sha: sha(letter),
          author: { login: 'octo-author', id: 900 },
          committer: { login: 'octo-author', id: 900 },
        },
      ],
      reviews: [],
      ...over,
    });
  };
  const refresh = async (project, prNumber, options = {}) => {
    const { outcome, published } = await refreshReviewOutcome(project, prNumber, {
      cfg,
      retryDelayMs: 0,
      ...options,
    });
    await published;
    // The approval requirement's status goes out beside the outcome's.
    await new Promise((resolve) => setTimeout(resolve, 150));
    return outcome;
  };
  const posted = (prNumber, context) =>
    requests
      .filter((r) => r.method === 'POST' && r.body.context === context && r.pr === prNumber)
      .map((r) => [r.url.split('/').pop().slice(0, 1), r.body.state]);
  const approval = (userId, letter, over = {}) => ({
    userId,
    approver: `user ${userId}`,
    headSha: sha(letter),
    baseRef: 'main',
    ...over,
  });

  beforeAll(async () => {
    const { database, ...config } = getConfig().db;
    expect(database).toBe(scratch.database);
    bootstrap = await mysql.createConnection(config);
    // The first query makes lib/db.js create the database and run every migration.
    expect(await dbHealthy()).toBe(true);
    pool = mysql.createPool({ ...config, database, connectionLimit: 3 });
    requests = [];
    carried = new Map();
    github = new Map();
    refuse = [];
    // Which pull request a commit belongs to, so status writes can be told apart.
    const prOf = (commit) => [...github.entries()].find(([, g]) => g.pull.head.sha === commit)?.[0] ?? null;
    const json = (status, body) =>
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url, init) => {
        const body = init.body ? JSON.parse(init.body) : null;
        const path = url.replace('https://api.github.com', '');
        if (init.method === 'GET') {
          const read = /\/commits\/([0-9a-f]+)\/statuses/.exec(path)?.[1];
          if (read) return json(200, carried.get(read) || []);
          // The open pull requests at a commit: every one a test put there.
          const at = /\/commits\/([0-9a-f]+)\/pulls/.exec(path)?.[1];
          if (at)
            return json(
              200,
              [...github.entries()]
                .filter(([, g]) => g.pull.head.sha === at)
                .map(([number, g]) => ({ number, state: g.pull.state, head: { sha: at } })),
            );
          if (path === '/user') return json(200, { login: 'briareus-bot', id: 7 });
          const [, number, what = 'pull'] = /\/pulls\/(\d+)(?:\/(\w+))?/.exec(path) || [];
          const known = github.get(Number(number));
          if (!known) return json(404, { message: 'Not Found' });
          const page = Number(/[?&]page=(\d+)/.exec(path)?.[1] || 1);
          return json(
            200,
            what === 'pull' ? known.pull : (known[what] || []).slice((page - 1) * 100, page * 100),
          );
        }
        const commit = url.split('/').pop();
        requests.push({ url, method: init.method, body, pr: prOf(commit) });
        if (refuse.includes(body.context)) return json(403, { message: 'Resource not accessible' });
        carried.set(commit, [body, ...(carried.get(commit) || [])]);
        return json(201, {});
      }),
    );
    setApprovalDirectory({
      user: (id) => ({ id, name: `user ${id}`, disabled: false }),
      mayApprove: () => true,
      // Every user here has linked an account of their own.
      accountsOf: (id) => [{ id: 100 + id, login: `user-${id}` }],
      linkedAccounts: () => [1, 2, 3].map((id) => ({ id: 100 + id, login: `user-${id}` })),
    });
  }, 120_000);
  afterAll(async () => {
    vi.unstubAllGlobals();
    await pool?.end();
    await bootstrap?.query(`DROP DATABASE IF EXISTS \`${scratch.database}\``);
    await bootstrap?.end();
  });

  it('adds the policy column and its tables at boot, and applies twice', async () => {
    const [ran] = await pool.query('SELECT `migration` FROM `migrations` WHERE `migration` = ?', [
      '2026_11_10_160000_add_code_review_approvals',
    ]);
    expect(ran).toHaveLength(1);
    const projects = await columns('projects');
    expect(projects[projects.indexOf('security_review') + 1]).toBe('approval_policy');
    const outcomes = await columns('code_review_outcomes');
    const security = await columns('code_review_security');
    await up({ context: pool });
    await up({ context: pool });
    expect(await columns('projects')).toEqual(projects);
    // The earlier workstreams' tables are as they were.
    expect(await columns('code_review_outcomes')).toEqual(outcomes);
    expect(await columns('code_review_security')).toEqual(security);
    expect(await columns('code_review_risk')).toEqual([
      'repo',
      'pr_number',
      'head_sha',
      'base_ref',
      'policy_hash',
      'tier',
      'complete',
      'assessment',
      'authors',
      'reviews_synced_at',
      'error',
      'attempts',
      'retry_at',
      'observed_at',
      'created_at',
      'updated_at',
    ]);
    expect(await columns('code_review_approvals')).toEqual([
      'id',
      'repo',
      'pr_number',
      'source',
      'user_id',
      'approver',
      'github_login',
      'github_user_id',
      'github_review_id',
      'status',
      'active',
      'head_sha',
      'base_ref',
      'code_review_id',
      'review_outcome',
      'note',
      'authorship',
      'automation',
      'association',
      'approved_at',
      'seen_at',
      'withdrawn_at',
      'withdraw_note',
      'created_at',
      'updated_at',
    ]);
    // The publication of its status is recorded under the outcome's own column names.
    const readiness = await columns('code_review_readiness');
    for (const column of outcomes.filter((name) => name.startsWith('publish') || name.startsWith('status_')))
      expect(readiness).toContain(column);
    expect(readiness).not.toContain('recompute_at');
    expect(readiness).toEqual(
      expect.arrayContaining(['result', 'tier', 'required', 'valid', 'waiting_since']),
    );
  });

  it('stores the policy whole, and none for a project that never set one', async () => {
    await pool.query(
      "INSERT INTO `projects` (`repo`, `label`, `created_at`, `updated_at`) VALUES ('acme/legacy', 'Legacy', 1, 1)",
    );
    const [rows] = await pool.query("SELECT `id` FROM `projects` WHERE `repo` = 'acme/legacy'");
    const legacy = await getProjectRow(rows[0].id);
    expect(legacy.approvalPolicy).toBeNull();
    const saved = await saveProject({ ...legacy, approvalPolicy: policy });
    expect(saved.approvalPolicy).toEqual(policy);
    expect(policyFingerprint(saved.approvalPolicy)).toBe(policyFingerprint(policy));
    // The largest policy the validation lets through fits the column.
    const large = normalizeApprovalPolicy({
      enabled: true,
      rules: Array.from({ length: 50 }, (_, i) => ({
        pattern: `/${'é'.repeat(190)}${String(i).padStart(2, '0')}/**`,
        tier: 'high',
        label: '✓'.repeat(80),
      })),
    });
    expect((await saveProject({ ...legacy, approvalPolicy: large })).approvalPolicy).toEqual(large);
    expect((await saveProject({ ...legacy, approvalPolicy: null })).approvalPolicy).toBeNull();
    expect((await saveProject({ repo: 'acme/new', label: 'New', enabled: true })).approvalPolicy).toBeNull();
    // Nothing else of the project is touched by it.
    expect((await getProjectRow(rows[0].id)).securityReview).toBe('off');
  });

  it('keeps one risk record per pull request, replaced with the revision', async () => {
    about = 10;
    const assessment = assessRisk({
      policy,
      files: [{ path: 'migrations/1.sql', additions: 1, deletions: 0 }],
    });
    const first = await saveCodeReviewRisk(repo, 10, {
      headSha: sha('a'),
      baseRef: 'Main',
      policyHash: policyFingerprint(policy),
      tier: assessment.tier,
      complete: true,
      assessment,
      authors: { author: 'octo-author', commits: ['octo-author'], complete: true },
      reviewsSyncedAt: 1_800_000_000_000,
    });
    expect(first).toMatchObject({
      headSha: sha('a'),
      baseRef: 'Main',
      tier: 'high',
      complete: true,
      error: null,
      attempts: 0,
      retryAt: null,
      reviewsSyncedAt: '2027-01-15T08:00:00.000Z',
    });
    expect(first.assessment).toEqual(assessment);
    expect(first.assessment.reasons[0].label).toBe('Schéma ✓');
    // A failed read of the next head replaces it whole: nothing of the old one stays.
    const unknown = assessRisk({
      policy,
      complete: false,
      incomplete: 'github_error',
      detail: 'x'.repeat(5000),
    });
    const second = await saveCodeReviewRisk(repo, 10, {
      headSha: sha('b'),
      baseRef: 'main',
      policyHash: policyFingerprint(policy),
      tier: unknown.tier,
      complete: false,
      assessment: unknown,
      authors: null,
      error: 'e'.repeat(5000),
      attempts: 2,
      retryAt: 1_800_000_100_000,
    });
    expect(second).toMatchObject({
      headSha: sha('b'),
      baseRef: 'main',
      complete: false,
      authors: null,
      attempts: 2,
    });
    expect(second.reviewsSyncedAt).toBeNull();
    expect(second.error).toHaveLength(2000);
    expect(second.createdAt).toBe(first.createdAt);
    const [rows] = await pool.query(
      'SELECT COUNT(*) AS n FROM `code_review_risk` WHERE `repo` = ? AND `pr_number` = 10',
      [repo],
    );
    expect(Number(rows[0].n)).toBe(1);
    // Branch names are case-sensitive, as on the outcome.
    const [bin] = await pool.query(
      "SELECT COUNT(*) AS n FROM `code_review_risk` WHERE `repo` = ? AND `pr_number` = 10 AND `base_ref` = 'MAIN'",
      [repo],
    );
    expect(Number(bin[0].n)).toBe(0);
  });

  it('lists an outcome whose risk is due to be read again, and stops when told', async () => {
    await reviewed(11, 'a');
    await refresh(plain, 11);
    const unknown = assessRisk({ policy, complete: false, incomplete: 'github_error' });
    await saveCodeReviewRisk(repo, 11, {
      headSha: sha('a'),
      baseRef: 'main',
      policyHash: policyFingerprint(policy),
      tier: 'high',
      complete: false,
      assessment: unknown,
      error: 'GitHub answered 502',
      attempts: 1,
      retryAt: 5000,
    });
    const due = async (now) => (await listCodeReviewOutcomesDue({ now })).filter((r) => r.prNumber === 11);
    expect(await due(4999)).toEqual([]);
    expect(await due(5000)).toEqual([
      expect.objectContaining({
        repo,
        prNumber: 11,
        riskRetry: true,
        recomputeAt: new Date(5000).toISOString(),
      }),
    ]);
    await clearCodeReviewRiskRetry(repo, 11);
    expect(await due(9000)).toEqual([]);
    expect((await getCodeReviewRisk(repo, 11)).retryAt).toBeNull();
  });

  it('holds a person to one standing approval per revision, and marks the outcome owed with it', async () => {
    await reviewed(12, 'a');
    await refresh(plain, 12);
    expect((await getCodeReviewOutcome(repo, 12)).recomputeAt).toBeNull();
    const first = await addCodeReviewApproval(
      repo,
      12,
      approval(1, 'a', {
        note: 'Looks right ✓',
        codeReviewId: 3,
        reviewOutcome: 'passed',
        githubLogin: 'ada-dev',
      }),
    );
    expect(first.created).toBe(true);
    expect(first.approval).toMatchObject({
      source: 'briareus',
      userId: 1,
      approver: 'user 1',
      githubLogin: 'ada-dev',
      status: 'approved',
      headSha: sha('a'),
      baseRef: 'main',
      codeReviewId: 3,
      reviewOutcome: 'passed',
      note: 'Looks right ✓',
      authorship: null,
      withdrawnAt: null,
    });
    // Written in the approval's transaction.
    expect((await getCodeReviewOutcome(repo, 12)).recomputeAt).toBeTruthy();
    // The same request again, and five at once: still the one approval.
    const again = await addCodeReviewApproval(repo, 12, approval(1, 'a', { note: 'Sent twice' }));
    expect(again).toMatchObject({
      created: false,
      approval: { id: first.approval.id, note: 'Looks right ✓' },
    });
    const racing = await Promise.all(
      Array.from({ length: 5 }, () => addCodeReviewApproval(repo, 12, approval(2, 'a'))),
    );
    expect(racing.filter((r) => r.created)).toHaveLength(1);
    expect(new Set(racing.map((r) => r.approval.id)).size).toBe(1);
    // Another head, another base branch (by exact name) and another pull request are other approvals.
    expect((await addCodeReviewApproval(repo, 12, approval(1, 'b'))).created).toBe(true);
    expect((await addCodeReviewApproval(repo, 12, approval(1, 'a', { baseRef: 'Main' }))).created).toBe(true);
    expect((await addCodeReviewApproval(repo, 13, approval(1, 'a'))).created).toBe(true);
    expect(
      (await listCodeReviewApprovals(repo, 12)).map((a) => [a.userId, a.headSha.slice(0, 1), a.baseRef]),
    ).toEqual([
      [1, 'a', 'main'],
      [2, 'a', 'main'],
      [1, 'b', 'main'],
      [1, 'a', 'Main'],
    ]);
  });

  it('lets only its approver withdraw an approval, keeps it on record, and takes a new one after', async () => {
    await reviewed(14, 'a');
    await refresh(plain, 14);
    const { approval: given } = await addCodeReviewApproval(repo, 14, approval(1, 'a'));
    await refresh(plain, 14);
    // Somebody else's attempt changes nothing and finds nothing.
    expect(await withdrawCodeReviewApproval(repo, 14, given.id, 2, { note: 'Not mine' })).toEqual({
      approval: null,
      changed: false,
    });
    expect(await withdrawCodeReviewApproval(repo, 15, given.id, 1)).toEqual({
      approval: null,
      changed: false,
    });
    expect((await getCodeReviewOutcome(repo, 14)).recomputeAt).toBeNull();
    const withdrawn = await withdrawCodeReviewApproval(repo, 14, given.id, 1, { note: 'Missed the index' });
    expect(withdrawn.changed).toBe(true);
    expect(withdrawn.approval).toMatchObject({
      id: given.id,
      status: 'withdrawn',
      withdrawNote: 'Missed the index',
    });
    expect(withdrawn.approval.withdrawnAt).toBeTruthy();
    expect((await getCodeReviewOutcome(repo, 14)).recomputeAt).toBeTruthy();
    // Again: nothing changes, the first note stays.
    const twice = await withdrawCodeReviewApproval(repo, 14, given.id, 1, { note: 'Again' });
    expect(twice).toMatchObject({ changed: false, approval: { withdrawNote: 'Missed the index' } });
    // The same person approves the same revision anew: a new row beside the withdrawn one.
    const anew = await addCodeReviewApproval(repo, 14, approval(1, 'a'));
    expect(anew.created).toBe(true);
    expect(anew.approval.id).not.toBe(given.id);
    expect((await listCodeReviewApprovals(repo, 14)).map((a) => a.status)).toEqual(['withdrawn', 'approved']);
  });

  it('keeps what it concluded when it first saw a GitHub approval, and follows GitHub on the rest', async () => {
    about = 16;
    const row = (id, login, over = {}) => ({
      githubReviewId: id,
      githubLogin: login,
      status: 'approved',
      headSha: sha('a'),
      baseRef: 'main',
      association: 'COLLABORATOR',
      automation: null,
      authorship: null,
      approvedAt: 1_800_000_000_000,
      ...over,
    });
    await syncGithubCodeReviewApprovals(repo, 16, {
      rows: [
        row(9_000_000_001, 'octo-reviewer'),
        row(9_000_000_002, 'ada-dev', { automation: 'linked_account' }),
        row(9_000_000_003, 'old-head', { headSha: sha('z'), baseRef: null }),
      ],
      dismissed: [],
    });
    // The same review ids on another pull request are other rows.
    await syncGithubCodeReviewApprovals(repo, 17, {
      rows: [row(9_000_000_001, 'octo-reviewer')],
      dismissed: [],
    });
    // Seen again later: the account is no longer linked, the pull request was
    // retargeted, one approval was superseded and one dismissed.
    await syncGithubCodeReviewApprovals(repo, 16, {
      rows: [
        row(9_000_000_001, 'octo-reviewer', {
          status: 'superseded',
          baseRef: 'release',
          association: 'MEMBER',
        }),
        row(9_000_000_002, 'ada-dev', { automation: null, baseRef: 'release' }),
        row(9_000_000_003, 'old-head', { headSha: sha('z'), baseRef: null, authorship: 'commits' }),
      ],
      dismissed: [9_000_000_002, 9_999_999_999],
    });
    const stored = await listCodeReviewApprovals(repo, 16);
    expect(
      stored.map((a) => [
        a.githubReviewId,
        a.githubLogin,
        a.status,
        a.baseRef,
        a.automation,
        a.association,
        a.authorship,
      ]),
    ).toEqual([
      [9_000_000_001, 'octo-reviewer', 'superseded', 'main', null, 'MEMBER', null],
      [9_000_000_002, 'ada-dev', 'dismissed', 'main', 'linked_account', 'COLLABORATOR', null],
      [9_000_000_003, 'old-head', 'approved', null, null, 'COLLABORATOR', 'commits'],
    ]);
    expect(stored[0]).toMatchObject({
      source: 'github',
      userId: null,
      approver: 'octo-reviewer',
      approvedAt: '2027-01-15T08:00:00.000Z',
    });
    // A dismissal is never undone by a later read that lists the review as approving.
    await syncGithubCodeReviewApprovals(repo, 16, { rows: [row(9_000_000_002, 'ada-dev')], dismissed: [] });
    expect((await listCodeReviewApprovals(repo, 16))[1].status).toBe('dismissed');
    expect(await listCodeReviewApprovals(repo, 17)).toHaveLength(1);
  });

  it('takes how a review stands from the newest read, whichever read finishes last', async () => {
    about = 18;
    const row = (status, over = {}) => ({
      githubReviewId: 9_100_000_001,
      githubLogin: 'octo-reviewer',
      githubUserId: 6001,
      status,
      headSha: sha('a'),
      baseRef: 'main',
      association: 'COLLABORATOR',
      automation: null,
      authorship: null,
      approvedAt: 1_800_000_000_000,
      ...over,
    });
    const stored = async () => (await listCodeReviewApprovals(repo, 18))[0];
    // Two reads of the pull request's reviews were under way at once. The one that
    // started later saw the approval superseded, and is stored first.
    await syncGithubCodeReviewApprovals(repo, 18, { rows: [row('superseded')], dismissed: [], seenAt: 2000 });
    expect(await stored()).toMatchObject({ status: 'superseded', githubUserId: 6001 });
    // The one that started earlier still saw it standing, and finishes afterwards.
    await syncGithubCodeReviewApprovals(repo, 18, {
      rows: [row('approved', { association: 'NONE' })],
      dismissed: [],
      seenAt: 1000,
    });
    expect(await stored()).toMatchObject({ status: 'superseded', association: 'COLLABORATOR' });
    // A read made after both is believed, in either direction.
    await syncGithubCodeReviewApprovals(repo, 18, { rows: [row('approved')], dismissed: [], seenAt: 3000 });
    expect((await stored()).status).toBe('approved');
    await syncGithubCodeReviewApprovals(repo, 18, { rows: [row('superseded')], dismissed: [], seenAt: 3000 });
    expect((await stored()).status).toBe('superseded');
    // A dismissal stands whatever read reports it.
    await syncGithubCodeReviewApprovals(repo, 18, { rows: [], dismissed: [9_100_000_001], seenAt: 500 });
    expect((await stored()).status).toBe('dismissed');
    // What was learned of the account later fills in what was not known.
    await syncGithubCodeReviewApprovals(repo, 19, {
      rows: [row('approved', { githubUserId: null })],
      dismissed: [],
      seenAt: 1,
    });
    await syncGithubCodeReviewApprovals(repo, 19, { rows: [row('approved')], dismissed: [], seenAt: 2 });
    expect((await listCodeReviewApprovals(repo, 19))[0].githubUserId).toBe(6001);
  });

  it('keeps whose session made which commit, per repository, entered once', async () => {
    const shas = ['1'.repeat(40), '2'.repeat(40), '3'.repeat(40)];
    expect(
      await recordCodeReviewCommitOwners(repo, {
        userId: 2,
        jobId: 'job-a',
        branch: 'Feature/Cart',
        shas: shas.slice(0, 2),
      }),
    ).toBe(2);
    // The same commits again, and one more by somebody else's session.
    expect(
      await recordCodeReviewCommitOwners(repo, { userId: 2, jobId: 'job-b', shas: shas.slice(0, 2) }),
    ).toBe(0);
    await recordCodeReviewCommitOwners(repo, { userId: 3, jobId: 'job-c', shas: [shas[1], shas[2]] });
    await recordCodeReviewCommitOwners('acme/other', { userId: 9, shas });
    expect(await recordCodeReviewCommitOwners(repo, { userId: 4, shas: [] })).toBe(0);
    expect((await listCodeReviewCommitOwners(repo, [shas[0]])).sort()).toEqual([2]);
    expect((await listCodeReviewCommitOwners(repo, shas)).sort()).toEqual([2, 3]);
    expect(await listCodeReviewCommitOwners(repo, ['4'.repeat(40)])).toEqual([]);
    expect(await listCodeReviewCommitOwners(repo, [])).toEqual([]);
    const [rows] = await pool.query(
      'SELECT `job_id`, `branch` FROM `code_review_commit_owners` WHERE `repo` = ? AND `commit_sha` = ? AND `user_id` = 2',
      [repo, shas[0]],
    );
    expect(rows).toEqual([{ job_id: 'job-a', branch: 'Feature/Cart' }]);
  });

  it('ties a change to the user whose session committed it, when the requirement is computed', async () => {
    const review = await reviewed(26, 'a');
    pullAt(26, 'a', ['config/app.yml']);
    const current = { headSha: review.head, baseRef: 'main' };
    await refresh(withPolicy, 26, { current });
    await addCodeReviewApproval(repo, 26, approval(2, 'a'));
    expect((await refresh(withPolicy, 26)).approvals).toMatchObject({ valid: 1, result: 'satisfied' });
    // A merged base-only commit attributed conservatively to this session cannot
    // disqualify the user: only GitHub's actual PR commit SHAs are consulted.
    await recordCodeReviewCommitOwners(repo, { userId: 2, jobId: 'base-import', shas: [sha('b')] });
    expect((await readReviewOutcome(withPolicy, 26)).approvals).toMatchObject({
      valid: 1,
      result: 'satisfied',
    });
    // The record of the commit arrives after the head was first read: the session's turn
    // ended later. It is found all the same, without the head being read again.
    await recordCodeReviewCommitOwners(repo, { userId: 2, jobId: 'job-26', shas: [review.head] });
    const tied = await readReviewOutcome(withPolicy, 26);
    expect(tied.approvals).toMatchObject({ valid: 0, result: 'pending' });
    expect(tied.approvals.approvals[0]).toMatchObject({ counted: false, reason: 'own_change' });
  });

  it('keeps every GitHub account a user linked, by id and login', async () => {
    await saveGithubLink(4, { id: 104, login: 'user-four' });
    await saveGithubLink(4, { id: 104, login: 'user-four' });
    await saveGithubLink(4, { id: 104, login: 'user-four-renamed' });
    await saveGithubLink(5, { id: null, login: 'legacy-five' });
    const rows = (await loadGithubLinkRows()).filter((row) => [4, 5].includes(row.userId));
    expect(rows.map((row) => [row.userId, row.id, row.login]).sort()).toEqual([
      [4, 104, 'user-four'],
      [4, 104, 'user-four-renamed'],
      [5, null, 'legacy-five'],
    ]);
  });

  it('writes nothing more for a project without a policy', async () => {
    await reviewed(20, 'a');
    pullAt(20, 'a');
    const outcome = await refresh({ ...plain, enforceReviewOutcome: true }, 20, {
      current: { headSha: sha('a'), baseRef: 'main' },
    });
    expect(outcome).toMatchObject({ outcome: 'passed', ready: true });
    expect(outcome.approvals).toMatchObject({ enabled: false, result: 'not_required' });
    expect(await getCodeReviewReadiness(repo, 20)).toBeNull();
    expect(await getCodeReviewRisk(repo, 20)).toBeNull();
    expect(posted(20, 'briareus/approvals')).toEqual([]);
    expect(posted(20, 'briareus/code-review')).toEqual([['a', 'success']]);
  });

  it('stores the requirement with the outcome, publishes both statuses, and follows approvals and pushes', async () => {
    await reviewed(21, 'a');
    pullAt(21, 'a');
    const current = { headSha: sha('a'), baseRef: 'main' };
    const waiting = await refresh(enforcing, 21, { current });
    expect(waiting).toMatchObject({ outcome: 'passed', ready: false });
    expect(waiting.approvals).toMatchObject({ result: 'pending', tier: 'high', required: 2, valid: 0 });
    expect(waiting.approvals.risk.reasons[0]).toMatchObject({ code: 'sensitive_path', label: 'Schéma ✓' });
    expect(await getCodeReviewRisk(repo, 21)).toMatchObject({
      headSha: sha('a'),
      baseRef: 'main',
      tier: 'high',
      complete: true,
    });
    const stored = await getCodeReviewReadiness(repo, 21);
    expect(stored).toMatchObject({
      ledger: 'approvals',
      headSha: sha('a'),
      baseRef: 'main',
      result: 'pending',
      tier: 'high',
      required: 2,
      valid: 0,
      statusState: 'pending',
      statusDescription: '0 of 2 human approvals at aaaaaaa (high risk)',
      publishedSha: sha('a'),
      publishedState: 'pending',
      publishedConfirmed: true,
      publishOwedAt: null,
    });
    expect(stored.reasons.map((r) => r.code)).toEqual(['approvals_missing']);
    expect(stored.waitingSince).toBeTruthy();
    expect((await listCodeReviewReadinessWaiting()).map((r) => r.prNumber)).toContain(21);
    expect(
      (await approvalsWaiting({ getProject: () => enforcing })).find((r) => r.prNumber === 21),
    ).toMatchObject({
      tier: 'high',
      required: 2,
      valid: 0,
      waitingSince: stored.waitingSince,
    });

    // One approval: still waiting, since the same moment.
    await addCodeReviewApproval(repo, 21, approval(1, 'a'));
    const one = await refresh(enforcing, 21);
    expect(one.approvals).toMatchObject({ valid: 1, missing: 1, waitingSince: stored.waitingSince });
    // The second: satisfied, and no longer waiting.
    await addCodeReviewApproval(repo, 21, approval(2, 'a'));
    const both = await refresh(enforcing, 21);
    expect(both).toMatchObject({ outcome: 'passed', ready: true });
    expect(both.approvals).toMatchObject({ result: 'satisfied', valid: 2, waitingSince: null });
    expect((await getCodeReviewReadiness(repo, 21)).waitingSince).toBeNull();
    expect(posted(21, 'briareus/approvals')).toEqual([
      ['a', 'pending'],
      ['a', 'pending'],
      ['a', 'success'],
    ]);
    expect(posted(21, 'briareus/code-review')).toEqual([['a', 'success']]);

    // A push: both approvals stop counting, and the new head carries `pending` twice over.
    pullAt(21, 'b');
    const moved = (
      await noteReviewedRevision(
        enforcing,
        21,
        { headSha: sha('b'), baseRef: 'main' },
        { cfg, retryDelayMs: 0 },
      )
    ).outcome;
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(moved).toMatchObject({ outcome: 'pending', stale: true, ready: false });
    expect(moved.approvals).toMatchObject({ result: 'pending', valid: 0, reviewCurrent: false });
    expect(moved.approvals.approvals.map((a) => a.reason)).toEqual(['head_moved', 'head_moved']);
    expect(posted(21, 'briareus/approvals').at(-1)).toEqual(['b', 'pending']);
    expect(await getCodeReviewRisk(repo, 21)).toMatchObject({ headSha: sha('b') });
    expect(await listCodeReviewApprovals(repo, 21)).toHaveLength(2);
    // Read again without writing: the same answer from the store.
    const read = await readReviewOutcome(enforcing, 21);
    expect(read.approvals).toMatchObject({ result: 'pending', headSha: sha('b') });
    expect(read.approvals.status).toMatchObject({ state: 'pending', published: true });
  });

  it('starts the wait over on a new head', async () => {
    await reviewed(22, 'a');
    pullAt(22, 'a');
    await refresh(withPolicy, 22, { current: { headSha: sha('a'), baseRef: 'main' } });
    const first = (await getCodeReviewReadiness(repo, 22)).waitingSince;
    expect(first).toBeTruthy();
    await new Promise((resolve) => setTimeout(resolve, 20));
    await refresh(withPolicy, 22);
    expect((await getCodeReviewReadiness(repo, 22)).waitingSince).toBe(first);
    // The next head is reviewed and passes: it waits from then, not from before.
    const later = await reviewed(22, 'b');
    pullAt(22, 'b');
    await refresh(withPolicy, 22, { current: { headSha: sha('b'), baseRef: 'main' }, reviewId: later.id });
    const second = await getCodeReviewReadiness(repo, 22);
    expect(second).toMatchObject({ headSha: sha('b'), result: 'pending' });
    expect(Date.parse(second.waitingSince)).toBeGreaterThan(Date.parse(first));
  });

  it('records a refused status write on the requirement’s own record and pays it from the sweep', async () => {
    await reviewed(23, 'a');
    pullAt(23, 'a');
    refuse = ['briareus/approvals'];
    await refresh(enforcing, 23, { current: { headSha: sha('a'), baseRef: 'main' } });
    refuse = [];
    // The outcome's status landed; the requirement's did not, and says so.
    expect(await getCodeReviewOutcome(repo, 23)).toMatchObject({
      publishedConfirmed: true,
      publishedState: 'success',
      publishOwedAt: null,
    });
    const failed = await getCodeReviewReadiness(repo, 23);
    expect(failed).toMatchObject({
      publishErrorStatus: 403,
      publishAttempts: 1,
      publishedConfirmed: false,
      publishedSha: null,
    });
    expect(failed.publishOwedAt).toBeTruthy();
    expect(failed.publishRetryAt).toBeTruthy();
    expect((await readReviewOutcome(enforcing, 23)).approvals.status).toMatchObject({
      published: false,
      errorStatus: 403,
    });
    expect(
      (await listFailedCodeReviewStatuses()).filter((r) => r.prNumber === 23).map((r) => r.ledger),
    ).toEqual(['approvals']);
    const retryAt = Date.parse(failed.publishRetryAt);
    const dueAt = async (now) => (await listCodeReviewOutcomesDue({ now })).filter((r) => r.prNumber === 23);
    expect(await dueAt(retryAt - 1)).toEqual([]);
    expect((await dueAt(retryAt)).map((r) => r.ledger)).toEqual(['approvals']);
    const results = await retryReviewStatuses({
      getProject: () => enforcing,
      cfg,
      retryDelayMs: 0,
      now: () => retryAt + 1,
    });
    expect(results.find((r) => r.prNumber === 23)).toEqual({
      repo,
      prNumber: 23,
      channel: 'approvals',
      published: true,
    });
    expect(await getCodeReviewReadiness(repo, 23)).toMatchObject({
      publishedConfirmed: true,
      publishedState: 'pending',
      publishOwedAt: null,
      publishError: null,
      publishAttempts: 0,
    });
    expect(await dueAt(retryAt + 1)).toEqual([]);
  });

  it('drops a debt on one record without touching the other', async () => {
    await reviewed(24, 'a');
    pullAt(24, 'a');
    refuse = ['briareus/approvals', 'briareus/code-review'];
    await refresh(enforcing, 24, { current: { headSha: sha('a'), baseRef: 'main' } });
    refuse = [];
    await oweProjectOutcomes(enforcing);
    expect((await getCodeReviewOutcome(repo, 24)).recomputeAt).toBeTruthy();
    await dropCodeReviewStatusDebt(repo, 24, 'approvals');
    expect(await getCodeReviewReadiness(repo, 24)).toMatchObject({
      publishOwedAt: null,
      publishFailedAt: null,
      publishError: null,
    });
    const outcome = await getCodeReviewOutcome(repo, 24);
    expect(outcome.recomputeAt).toBeTruthy();
    expect(outcome.publishFailedAt).toBeTruthy();
    await dropCodeReviewStatusDebt(repo, 24);
    expect(await getCodeReviewOutcome(repo, 24)).toMatchObject({ recomputeAt: null, publishFailedAt: null });
  });

  it('assesses again under changed rules once the outcome is marked owed', async () => {
    await reviewed(25, 'a');
    pullAt(25, 'a', ['config/app.yml']);
    await refresh(withPolicy, 25, { current: { headSha: sha('a'), baseRef: 'main' } });
    expect(await getCodeReviewReadiness(repo, 25)).toMatchObject({ tier: 'medium', required: 1 });
    const stricter = {
      ...plain,
      approvalPolicy: normalizeApprovalPolicy({
        enabled: true,
        rules: [{ pattern: '/config/', tier: 'high' }],
      }),
    };
    expect((await readReviewOutcome(stricter, 25)).approvals.risk).toMatchObject({
      unknown: true,
      tier: 'high',
    });
    // Every stored outcome of the repository is marked; the board is not consulted.
    expect(await oweProjectOutcomes(stricter)).toBeGreaterThanOrEqual(1);
    await retryReviewStatuses({ getProject: () => stricter, cfg, retryDelayMs: 0 });
    expect(await getCodeReviewReadiness(repo, 25)).toMatchObject({ tier: 'high', required: 2 });
    expect((await getCodeReviewRisk(repo, 25)).policyHash).toBe(policyFingerprint(stricter.approvalPolicy));
    expect((await readReviewOutcome(stricter, 25)).approvals.risk.unknown).toBe(false);
  });

  it('gives a commit two pull requests share the most restrictive status of the two', async () => {
    // Pull request 40: high risk, reviewed and passed, nobody approved yet.
    const first = await reviewed(40, 'a');
    pullAt(40, 'a');
    const head = first.head;
    const current = { headSha: head, baseRef: 'main' };
    await refresh(enforcing, 40, { current });
    const carries = (context) => carried.get(head).find((status) => status.context === context);
    expect(carries('briareus/approvals')).toMatchObject({
      state: 'pending',
      description: '0 of 2 human approvals at aaaaaaa (high risk)',
    });
    expect(carries('briareus/code-review')).toMatchObject({ state: 'success' });

    // Its author opens pull request 41 from the same branch against another base: one
    // trivial file, low risk, reviewed and passed. By itself it asks for no approval.
    await reviewed(41, 'a', { head: 40 });
    pullAt(41, 'a', ['README.md']);
    const second = await refresh(enforcing, 41, { current });
    expect(second).toMatchObject({ outcome: 'passed', ready: true });
    expect(second.approvals).toMatchObject({ result: 'not_required', tier: 'low' });
    expect(await getCodeReviewReadiness(repo, 41)).toMatchObject({ statusState: 'success' });
    // The commit still says what holds for both: pull request 40 waits on people.
    expect(carries('briareus/approvals')).toEqual({
      context: 'briareus/approvals',
      state: 'pending',
      description: 'PR #40: 0 of 2 human approvals at aaaaaaa (high risk)',
    });
    expect(carries('briareus/code-review')).toMatchObject({
      state: 'success',
      description: 'PR #40: Review passed at aaaaaaa: no findings',
    });
    expect(await listCodeReviewStatusesAtHead(repo, head, 'approvals')).toEqual([
      { prNumber: 40, state: 'pending', description: '0 of 2 human approvals at aaaaaaa (high risk)' },
      { prNumber: 41, state: 'success', description: 'No human approval required at aaaaaaa: low risk' },
    ]);
    const mine = (await readReviewOutcome(enforcing, 41)).approvals.status;
    expect(mine).toMatchObject({
      state: 'success',
      published: false,
      publishedState: 'pending',
      publishedDescription: 'PR #40: 0 of 2 human approvals at aaaaaaa (high risk)',
    });
    // Nothing is owed for 41: the commit carries what it should. 40 is told to look
    // again, finds its own status there under its name, and writes nothing.
    expect((await getCodeReviewReadiness(repo, 41)).publishOwedAt).toBeNull();
    expect((await getCodeReviewReadiness(repo, 40)).publishOwedAt).toBeTruthy();
    const writes = () => requests.filter((r) => r.url.endsWith(head)).length;
    const before = writes();
    await retryReviewStatuses({ getProject: () => enforcing, cfg, retryDelayMs: 0 });
    expect(writes()).toBe(before);
    expect(await getCodeReviewReadiness(repo, 40)).toMatchObject({
      publishOwedAt: null,
      publishedState: 'pending',
      publishedDescription: 'PR #40: 0 of 2 human approvals at aaaaaaa (high risk)',
    });
    expect((await readReviewOutcome(enforcing, 40)).approvals.status.published).toBe(true);

    // Two people approve pull request 40: now both pass, and the commit says so.
    await addCodeReviewApproval(repo, 40, approval(1, 'a'));
    await addCodeReviewApproval(repo, 40, approval(2, 'a'));
    expect((await refresh(enforcing, 40)).ready).toBe(true);
    expect(carries('briareus/approvals')).toMatchObject({
      state: 'success',
      description: 'PR #40: 2 of 2 human approvals at aaaaaaa (high risk)',
    });
    // 41 looks again in its turn and settles on the same status without another write.
    const settled = writes();
    await retryReviewStatuses({ getProject: () => enforcing, cfg, retryDelayMs: 0 });
    await retryReviewStatuses({ getProject: () => enforcing, cfg, retryDelayMs: 0 });
    expect(writes()).toBe(settled);
    expect((await readReviewOutcome(enforcing, 41)).approvals.status).toMatchObject({ published: true });

    // 41 closes: 40 has the commit to itself again, under its own words.
    github.get(41).pull.state = 'closed';
    expect(await oweCodeReviewStatusesAtHead(repo, head, 41)).toBe(2);
    await retryReviewStatuses({ getProject: () => enforcing, cfg, retryDelayMs: 0 });
    expect(carries('briareus/approvals')).toMatchObject({
      state: 'success',
      description: '2 of 2 human approvals at aaaaaaa (high risk)',
    });
  });

  it('writes no success for a commit shared with a pull request nobody reviewed', async () => {
    const review = await reviewed(42, 'a');
    pullAt(42, 'a', ['README.md']);
    // Another open pull request at the same head, which the server holds nothing for.
    github.set(43, { pull: { state: 'open', head: { sha: review.head }, base: { ref: 'release' } } });
    await refresh(enforcing, 42, { current: { headSha: review.head, baseRef: 'main' } });
    const statuses = carried.get(review.head);
    expect(statuses.find((s) => s.context === 'briareus/code-review')).toMatchObject({
      state: 'pending',
      description: 'PR #43: not reviewed at this commit yet',
    });
    expect(statuses.find((s) => s.context === 'briareus/approvals').state).toBe('pending');
    expect(statuses.some((s) => s.state === 'success')).toBe(false);
  });

  it('lists who waits on people past the ones that closed, and takes their marks off', async () => {
    // Three pull requests wait; the two that have waited longest have closed since.
    for (const number of [50, 51, 52]) {
      const review = await reviewed(number, 'a');
      pullAt(number, 'a');
      await refresh(withPolicy, number, { current: { headSha: review.head, baseRef: 'main' } });
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const mine = (rows) =>
      rows.filter((row) => [50, 51, 52].includes(row.prNumber)).map((row) => row.prNumber);
    expect(mine(await listCodeReviewReadinessWaiting({ limit: 500 }))).toEqual([50, 51, 52]);
    // Every other row of this file's earlier tests is taken for closed as well.
    const isOpen = async (_project, number) => number === 52;
    const waiting = await approvalsWaiting({ getProject: () => withPolicy, isOpen, limit: 2 });
    expect(waiting.map((row) => row.prNumber)).toEqual([52]);
    expect(mine(await listCodeReviewReadinessWaiting({ limit: 500 }))).toEqual([52]);
    expect((await getCodeReviewReadiness(repo, 50)).waitingSince).toBeNull();
    // Told directly, too.
    await clearCodeReviewWaiting(repo, 52);
    expect(await approvalsWaiting({ getProject: () => withPolicy, isOpen, limit: 2 })).toEqual([]);
  });

  it('rolls back to the earlier schema and comes back up with nothing approved', async () => {
    await reviewed(30, 'a');
    pullAt(30, 'a');
    await refresh(enforcing, 30, { current: { headSha: sha('a'), baseRef: 'main' } });
    await addCodeReviewApproval(repo, 30, approval(1, 'a'));
    const projects = await columns('projects');
    const outcomes = await columns('code_review_outcomes');
    await down({ context: pool });
    await down({ context: pool });
    for (const table of [
      'code_review_risk',
      'code_review_approvals',
      'code_review_readiness',
      'code_review_commit_owners',
      'user_github_links',
    ])
      expect(await hasTable(table)).toBe(false);
    expect(await columns('projects')).toEqual(projects.filter((name) => name !== 'approval_policy'));
    // Every earlier record stays as it was.
    expect(await columns('code_review_outcomes')).toEqual(outcomes);
    const [kept] = await pool.query(
      'SELECT `outcome` FROM `code_review_outcomes` WHERE `repo` = ? AND `pr_number` = 30',
      [repo],
    );
    expect(kept[0].outcome).toBe('passed');
    const [security] = await pool.query('SELECT COUNT(*) AS n FROM `code_review_security`');
    expect(Number(security[0].n)).toBeGreaterThan(0);

    await up({ context: pool });
    expect(await columns('projects')).toEqual(projects);
    // Nothing is back-filled: no approval, no assessment, no requirement on record.
    expect(await listCodeReviewApprovals(repo, 30)).toEqual([]);
    expect(await getCodeReviewRisk(repo, 30)).toBeNull();
    expect(await getCodeReviewReadiness(repo, 30)).toBeNull();
    const again = await refresh(enforcing, 30, { current: { headSha: sha('a'), baseRef: 'main' } });
    expect(again).toMatchObject({ outcome: 'passed', ready: false });
    expect(again.approvals).toMatchObject({ result: 'pending', required: 2, valid: 0, approvals: [] });
  });
});
