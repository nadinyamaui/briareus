import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The approval requirement end to end, below the HTTP routes: what the server reads from
// GitHub about a revision (lib/review-revision.js), the requirement computed beside the
// outcome and stored with it, and its status published by the outcome's own publisher
// (lib/review-enforcement.js). The tables are kept in memory, one pull request at a time,
// in the shapes lib/db.js gives them; the SQL runs against a real MySQL in
// test/code-review-approvals.mysql.test.js. lib/github.js is the real one with `fetch`
// stubbed, so what is asserted is what GitHub would be asked and told.
const store = vi.hoisted(() => {
  const publication = () => ({
    publishedSha: null,
    publishedState: null,
    publishedDescription: null,
    publishedConfirmed: false,
    publishedAt: null,
    publishError: null,
    publishErrorStatus: null,
    publishAttempts: 0,
    publishFailedAt: null,
    publishRetryAt: null,
    publishOwedAt: null,
  });
  const s = {
    row: null,
    readiness: null,
    risk: null,
    approvals: [],
    review: null,
    stages: [],
    findings: [],
    decisions: [],
    count: null,
    at: 0,
    failing: {},
    publication,
    now: () => new Date(Date.UTC(2026, 10, 10, 12, 0, s.at++)).toISOString(),
    ledger: (name) => (name === 'approvals' ? s.readiness : s.row),
    state: () => ({
      row: s.row ? { ...s.row } : null,
      review: s.review,
      stages: s.stages,
      findings: s.findings,
      decisions: s.decisions,
      count: s.count,
      rounds: [],
      risk: s.risk ? { ...s.risk } : null,
      approvals: s.approvals.map((a) => ({ ...a })),
      readiness: s.readiness ? { ...s.readiness } : null,
    }),
  };
  return s;
});

vi.mock('../lib/db.js', () => {
  const due = (row, now) =>
    row && row.publishOwedAt && (!row.publishRetryAt || Date.parse(row.publishRetryAt) <= now);
  return {
    readCodeReviewOutcomeState: vi.fn(async () => store.state()),
    refreshCodeReviewOutcome: vi.fn(async (repo, prNumber, _options, compute) => {
      if (store.failing.refresh) throw new Error(store.failing.refresh);
      store.row ||= {
        repo,
        prNumber,
        codeReviewId: null,
        headSha: null,
        baseRef: null,
        recomputeAt: null,
        ...store.publication(),
      };
      const state = store.state();
      const { owed, security, readiness, ...next } = compute(state);
      Object.assign(store.row, next, {
        codeReviewId: state.review?.id ?? null,
        computedAt: store.now(),
        recomputeAt: null,
        publishOwedAt: owed ? store.row.publishOwedAt || store.now() : null,
        securityPolicy: security?.policy ?? null,
      });
      if (readiness) {
        const { owed: owes, waiting, ...kept } = readiness;
        const before = store.readiness;
        store.readiness = {
          ledger: 'approvals',
          repo,
          prNumber,
          ...store.publication(),
          ...(before || {}),
          ...kept,
          headSha: next.headSha,
          baseRef: next.baseRef,
          // A wait carries on only on the same head.
          waitingSince: !waiting
            ? null
            : before?.headSha === next.headSha && before.waitingSince
              ? before.waitingSince
              : store.now(),
          computedAt: store.now(),
          publishOwedAt: owes ? before?.publishOwedAt || store.now() : null,
          recomputeAt: null,
        };
      }
      return { ...store.state(), review: state.review };
    }),
    getCodeReviewOutcome: vi.fn(async () => (store.row ? { ...store.row } : null)),
    getCodeReviewReadiness: vi.fn(async () => (store.readiness ? { ...store.readiness } : null)),
    getCodeReviewRisk: vi.fn(async () => (store.risk ? { ...store.risk } : null)),
    saveCodeReviewRisk: vi.fn(async (repo, prNumber, risk) => {
      if (store.failing.risk) throw new Error(store.failing.risk);
      const iso = (ms) => (ms == null ? null : new Date(ms).toISOString());
      store.risk = {
        repo,
        prNumber,
        ...risk,
        reviewsSyncedAt: iso(risk.reviewsSyncedAt),
        retryAt: iso(risk.retryAt),
        observedAt: store.now(),
        updatedAt: store.now(),
      };
      return { ...store.risk };
    }),
    clearCodeReviewRiskRetry: vi.fn(async () => {
      if (store.risk) store.risk.retryAt = null;
    }),
    // One row per GitHub review; what was concluded when it was first seen is kept.
    syncGithubCodeReviewApprovals: vi.fn(async (_repo, _pr, { rows, dismissed }) => {
      for (const row of rows) {
        const known = store.approvals.find((a) => a.githubReviewId === row.githubReviewId);
        if (!known)
          store.approvals.push({
            id: store.approvals.length + 1,
            source: 'github',
            userId: null,
            approver: row.githubLogin,
            ...row,
            approvedAt: row.approvedAt ? new Date(row.approvedAt).toISOString() : null,
          });
        else
          Object.assign(known, {
            status: known.status === 'dismissed' ? known.status : row.status,
            baseRef: known.baseRef ?? row.baseRef,
            automation: known.automation ?? row.automation,
            authorship: known.authorship ?? row.authorship,
            association: row.association,
          });
      }
      for (const a of store.approvals)
        if (a.source === 'github' && dismissed.includes(a.githubReviewId)) a.status = 'dismissed';
    }),
    listCodeReviewReadinessWaiting: vi.fn(async () =>
      store.readiness?.waitingSince ? [{ ...store.readiness }] : [],
    ),
    markCodeReviewOutcomeStale: vi.fn(async () => {
      if (store.row) store.row.recomputeAt ||= store.now();
    }),
    markRepoCodeReviewOutcomesStale: vi.fn(async () => {
      if (!store.row) return 0;
      store.row.recomputeAt ||= store.now();
      return 1;
    }),
    markCodeReviewStatusSending: vi.fn(async (_repo, _pr, ledger) => {
      store.ledger(ledger).publishedConfirmed = false;
    }),
    recordCodeReviewStatusPublished: vi.fn(async (_repo, _pr, status, { posted = true, ledger } = {}) => {
      const row = store.ledger(ledger);
      const settled =
        row.headSha === status.sha &&
        row.statusState === status.state &&
        row.statusDescription === status.description;
      Object.assign(row, {
        publishedSha: status.sha,
        publishedState: status.state,
        publishedDescription: status.description,
        publishedConfirmed: true,
        publishedAt: posted ? store.now() : row.publishedAt || store.now(),
        publishError: null,
        publishErrorStatus: null,
        publishAttempts: 0,
        publishFailedAt: null,
        publishRetryAt: null,
        publishOwedAt: settled ? null : row.publishOwedAt,
      });
    }),
    recordCodeReviewStatusFailed: vi.fn(async (_repo, _pr, { error, status = null, retryAt, ledger }) => {
      const row = store.ledger(ledger);
      Object.assign(row, {
        publishError: error,
        publishErrorStatus: status,
        publishAttempts: row.publishAttempts + 1,
        publishFailedAt: store.now(),
        publishRetryAt: retryAt == null ? null : new Date(retryAt).toISOString(),
        publishOwedAt: retryAt == null ? null : row.publishOwedAt || store.now(),
      });
    }),
    dropCodeReviewStatusDebt: vi.fn(async (_repo, _pr, ledger) => {
      Object.assign(store.ledger(ledger), {
        publishError: null,
        publishErrorStatus: null,
        publishAttempts: 0,
        publishFailedAt: null,
        publishRetryAt: null,
        publishOwedAt: null,
        ...(ledger === 'approvals' ? {} : { recomputeAt: null }),
      });
    }),
    listFailedCodeReviewStatuses: vi.fn(async () =>
      [store.row, store.readiness].filter((row) => row?.publishFailedAt).map((row) => ({ ...row })),
    ),
    // As the query answers: outcomes owed a recomputation or a status, a risk whose read
    // is due again, and approval requirements owed their status.
    listCodeReviewOutcomesDue: vi.fn(async ({ now }) => {
      const rows = [];
      const riskDue = !!store.risk?.retryAt && Date.parse(store.risk.retryAt) <= now;
      if (store.row && (store.row.recomputeAt || riskDue || due(store.row, now)))
        rows.push({
          ...store.row,
          ...(riskDue && !store.row.recomputeAt ? { recomputeAt: store.risk.retryAt, riskRetry: true } : {}),
        });
      if (due(store.readiness, now)) rows.push({ ...store.readiness });
      return rows;
    }),
    claimCodeReviewRound: vi.fn(),
    codeReviewDecisionsSince: vi.fn(async () => 0),
    getCodeReviewRounds: vi.fn(async () => ({ count: null, rounds: [] })),
    listCodeReviewDecisions: vi.fn(async () => []),
    listPullCodeReviews: vi.fn(async () => []),
    listRefusedCodeReviewRounds: vi.fn(async () => []),
  };
});

import { saveCodeReviewRisk, syncGithubCodeReviewApprovals } from '../lib/db.js';
import { normalizeApprovalPolicy } from '../lib/review-risk.js';

const repo = 'acme/shop';
const head = 'a'.repeat(40);
const next = 'b'.repeat(40);
const cfg = { githubToken: 'server-token' };
const policyOf = (over = {}) =>
  normalizeApprovalPolicy({
    enabled: true,
    rules: [
      { pattern: '/migrations/', tier: 'high', label: 'Schema' },
      { pattern: '/config/', tier: 'medium' },
    ],
    ...over,
  });
const plain = { id: 1, repo, reviewRoundLimit: 3 };
const withPolicy = (over = {}, project = {}) => ({ ...plain, approvalPolicy: policyOf(over), ...project });
const enforcing = (over = {}, project = {}) => withPolicy(over, { enforceReviewOutcome: true, ...project });

const stagesAt = (sha, more = []) =>
  ['discover', ...more, 'publish', 'verify', 'label'].map((stage) => ({
    codeReviewId: 5,
    stage,
    headSha: sha,
    status: 'completed',
    detail: null,
  }));
// A review of `sha` that ran to its end with every stage seen and nothing found.
function reviewed(sha = head, over = {}) {
  store.review = { id: 5, status: 'completed', headSha: sha, baseRef: 'main', round: 1, ...over };
  store.stages = stagesAt(sha);
  store.findings = [];
}
let ids;
const approve = (userId, over = {}) =>
  store.approvals.push({
    id: ++ids,
    source: 'briareus',
    userId,
    approver: `user ${userId}`,
    status: 'approved',
    headSha: head,
    baseRef: 'main',
    approvedAt: store.now(),
    ...over,
  });

// The pull request as GitHub answers for it.
let enforcement, revision, requests, answers, carried, github;
const answer = (status, body = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const posted = (context) =>
  requests
    .filter(
      (r) => r.method === 'POST' && r.url.includes('/statuses/') && (!context || r.body.context === context),
    )
    .map((r) => ({ sha: r.url.split('/').pop(), ...r.body }));
const asked = (part) => requests.filter((r) => r.method === 'GET' && r.url.includes(part));
const changed = (...paths) =>
  paths.map((filename) => ({ filename, status: 'modified', additions: 3, deletions: 1 }));

beforeEach(async () => {
  Object.assign(store, {
    row: null,
    readiness: null,
    risk: null,
    approvals: [],
    review: null,
    stages: [],
    findings: [],
    decisions: [],
    count: null,
    at: 0,
    failing: {},
  });
  ids = 100;
  vi.clearAllMocks();
  vi.resetModules();
  requests = [];
  // What GitHub answers to status writes, in order; once they run out every write lands.
  answers = [];
  carried = new Map();
  github = {
    pull: {
      state: 'open',
      head: { sha: head },
      base: { ref: 'main' },
      user: { login: 'octo-author' },
      changed_files: 1,
      commits: 1,
    },
    files: changed('migrations/002_orders.sql'),
    commits: [{ author: { login: 'octo-author' }, committer: { login: 'web-flow' } }],
    reviews: [],
    user: { login: 'briareus-bot' },
    // Set to a status, or to a function, to make that read fail.
    failing: {},
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url, init) => {
      const path = url.replace('https://api.github.com', '');
      requests.push({
        url: path,
        method: init.method,
        token: init.headers.Authorization.replace('Bearer ', ''),
        body: init.body ? JSON.parse(init.body) : null,
      });
      if (init.method === 'GET') {
        const sha = /\/commits\/([0-9a-f]+)\/statuses/.exec(path)?.[1];
        if (sha) return answer(200, carried.get(sha) || []);
        const page = Number(/[?&]page=(\d+)/.exec(path)?.[1] || 1);
        const paged = (list) => answer(200, list.slice((page - 1) * 100, page * 100));
        const what = path === '/user' ? 'user' : /\/pulls\/7\/(\w+)/.exec(path)?.[1] || 'pull';
        if (github.failing[what]) return answer(github.failing[what], { message: 'Server Error' });
        if (what === 'user') return answer(200, github.user);
        if (what === 'files') return paged(github.files);
        if (what === 'commits') return paged(github.commits);
        if (what === 'reviews') return paged(github.reviews);
        return answer(200, typeof github.pull === 'function' ? github.pull() : github.pull);
      }
      const reply = answers.length ? answers.shift() : null;
      if (reply instanceof Error) throw reply;
      if (typeof reply === 'function') return reply(url, init);
      if (reply) return reply;
      const sha = url.split('/').pop();
      carried.set(sha, [JSON.parse(init.body), ...(carried.get(sha) || [])]);
      return answer(201, {});
    }),
  );
  enforcement = await import('../lib/review-enforcement.js');
  revision = await import('../lib/review-revision.js');
  enforcement.setApprovalDirectory({
    user: (id) => ({ id, name: { 1: 'Ada', 2: 'Grace' }[id] || `user ${id}`, disabled: false }),
    mayApprove: () => true,
    linkedLogins: () => ['ada-dev'],
  });
});
afterEach(() => vi.unstubAllGlobals());

const refresh = async (project, options = {}) => {
  const { outcome, published } = await enforcement.refreshReviewOutcome(project, 7, {
    cfg,
    retryDelayMs: 0,
    ...options,
  });
  await published;
  // The approval requirement's status is sent beside the outcome's, not waited for.
  await new Promise((resolve) => setTimeout(resolve, 0));
  return outcome;
};
const sweep = (project, now) =>
  enforcement.retryReviewStatuses({
    getProject: () => project,
    cfg,
    retryDelayMs: 0,
    ...(now ? { now: () => now } : {}),
  });

describe('a project without an approval policy', () => {
  it('reads nothing more from GitHub, stores nothing more and asks for nothing', async () => {
    reviewed();
    const outcome = await refresh(
      { ...plain, enforceReviewOutcome: true },
      { current: { headSha: head, baseRef: 'main' } },
    );
    expect(outcome).toMatchObject({ outcome: 'passed', ready: true });
    expect(outcome.approvals).toMatchObject({
      enabled: false,
      result: 'not_required',
      required: 0,
      approvals: [],
    });
    expect(outcome.approvals.status).toMatchObject({
      context: 'briareus/approvals',
      state: 'success',
      published: false,
      publishedSha: null,
    });
    expect(outcome.security).not.toHaveProperty('requiredByRisk');
    expect(store.readiness).toBeNull();
    expect(store.risk).toBeNull();
    expect(saveCodeReviewRisk).not.toHaveBeenCalled();
    // Only the outcome's own status went out, and nothing was read about the pull request.
    expect(posted().map((s) => s.context)).toEqual(['briareus/code-review']);
    expect(asked('/pulls/')).toEqual([]);
    // The same with a policy the project keeps switched off.
    await refresh(
      { ...plain, approvalPolicy: policyOf({ enabled: false }) },
      { current: { headSha: head, baseRef: 'main' } },
    );
    expect(asked('/pulls/')).toEqual([]);
    expect(store.readiness).toBeNull();
  });

  it('answers the policy a review starts under without reading anything', async () => {
    expect(
      await enforcement.reviewSecurityPolicy(
        { ...plain, securityReview: 'advisory' },
        7,
        { headSha: head },
        { cfg },
      ),
    ).toEqual({ policy: 'advisory', raisedBy: null });
    // A policy none of whose tiers requires the pass raises nothing either.
    const lenient = withPolicy({}, { securityReview: 'advisory' });
    expect(await enforcement.reviewSecurityPolicy(lenient, 7, { headSha: head }, { cfg })).toEqual({
      policy: 'advisory',
      raisedBy: null,
    });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('the risk the server reads for a revision', () => {
  it('reads the changed files once per revision and keeps the assessment', async () => {
    reviewed();
    const project = withPolicy();
    const outcome = await refresh(project, { current: { headSha: head, baseRef: 'main' } });
    expect(asked('/pulls/7/files')).toHaveLength(1);
    expect(asked('/pulls/7/files')[0].token).toBe('server-token');
    expect(store.risk).toMatchObject({
      headSha: head,
      baseRef: 'main',
      tier: 'high',
      complete: true,
      error: null,
      retryAt: null,
    });
    expect(store.risk.authors).toEqual({ author: 'octo-author', commits: ['octo-author'], complete: true });
    expect(outcome.approvals).toMatchObject({
      enabled: true,
      tier: 'high',
      required: 2,
      valid: 0,
      result: 'pending',
    });
    expect(outcome.approvals.risk).toMatchObject({ tier: 'high', unknown: false, files: 1 });
    expect(outcome.approvals.risk.reasons[0]).toMatchObject({
      code: 'sensitive_path',
      label: 'Schema',
      paths: ['migrations/002_orders.sql'],
    });
    // Computed again, the stored assessment stands: nothing is read a second time.
    await refresh(project, { current: { headSha: head, baseRef: 'main' } });
    await refresh(project);
    expect(asked('/pulls/7/files')).toHaveLength(1);
  });

  it('reads it for the revision on record when nobody passed one in', async () => {
    reviewed();
    const outcome = await refresh(withPolicy());
    expect(store.risk).toMatchObject({ headSha: head, tier: 'high', complete: true });
    expect(outcome.approvals).toMatchObject({ tier: 'high', required: 2 });
    expect(outcome.approvals.risk.unknown).toBe(false);
  });

  it('reads every page, with the previous path of a renamed file', async () => {
    reviewed();
    github.files = [
      ...Array.from({ length: 149 }, (_, i) => ({
        filename: `src/f${i}.js`,
        status: 'modified',
        additions: 1,
        deletions: 0,
      })),
      {
        filename: 'archive/001.sql',
        previous_filename: 'migrations/001.sql',
        status: 'renamed',
        additions: 0,
        deletions: 0,
      },
    ];
    github.pull.changed_files = 150;
    const outcome = await refresh(withPolicy(), { current: { headSha: head, baseRef: 'main' } });
    expect(asked('/pulls/7/files').map((r) => /&page=(\d+)/.exec(r.url)[1])).toEqual(['1', '2']);
    expect(outcome.approvals.risk).toMatchObject({ tier: 'high', files: 150, unknown: false });
    expect(outcome.approvals.risk.reasons[0].renamedFrom).toEqual([
      { from: 'migrations/001.sql', to: 'archive/001.sql' },
    ]);
  });

  it.each([
    ['GitHub answers an error for the files', () => (github.failing.files = 502), 'github_error', true],
    ['the pull request cannot be read', () => (github.failing.pull = 404), 'github_error', true],
    [
      'GitHub lists fewer files than the pull request changes',
      () => (github.pull.changed_files = 5),
      'list_incomplete',
      false,
    ],
    [
      'the pull request changes more files than GitHub lists',
      () => {
        github.files = Array.from({ length: 3000 }, (_, i) => ({
          filename: `src/f${i}.js`,
          additions: 1,
          deletions: 0,
        }));
        github.pull.changed_files = 4200;
      },
      'too_many_files',
      false,
    ],
    [
      'the head moves while the pages are read',
      () => {
        let reads = 0;
        const pull = github.pull;
        github.pull = () => (reads++ ? { ...pull, head: { sha: next } } : pull);
      },
      'head_moved',
      false,
    ],
  ])('treats the change as the highest tier when %s', async (_name, arrange, why, retried) => {
    reviewed();
    github.files = changed('README.md');
    arrange();
    const outcome = await refresh(withPolicy(), { current: { headSha: head, baseRef: 'main' } });
    expect(outcome.approvals).toMatchObject({ tier: 'high', required: 2, result: 'pending' });
    expect(outcome.approvals.risk).toMatchObject({ unknown: true, tier: 'high' });
    expect(outcome.approvals.risk.reasons[0]).toMatchObject({ code: 'file_list_unknown', why });
    expect(outcome.approvals.reasons.map((r) => r.code)).toContain('file_list_unknown');
    expect(store.risk).toMatchObject({ complete: false, tier: 'high' });
    // Only what may pass by itself is tried again.
    expect(!!store.risk.retryAt).toBe(retried);
    expect(store.risk.attempts).toBe(retried ? 1 : 0);
  });

  it('never trusts a list of exactly as many files as GitHub will list unless the count agrees', async () => {
    reviewed();
    github.files = Array.from({ length: 3000 }, (_, i) => ({
      filename: `src/f${i}.js`,
      additions: 1,
      deletions: 0,
    }));
    github.pull.changed_files = 3000;
    const outcome = await refresh(withPolicy(), { current: { headSha: head, baseRef: 'main' } });
    expect(outcome.approvals.risk).toMatchObject({ unknown: false, tier: 'low', files: 3000 });
    expect(asked('/pulls/7/files')).toHaveLength(30);
  });

  it('tries a failed read again from the sweep, with a backoff, and gives up after a few', async () => {
    reviewed();
    github.failing.files = 502;
    const project = withPolicy();
    await refresh(project, { current: { headSha: head, baseRef: 'main' } });
    const first = Date.parse(store.risk.retryAt);
    // Not due yet: computing again reads nothing.
    await refresh(project, { current: { headSha: head, baseRef: 'main' } });
    expect(asked('/pulls/7/files')).toHaveLength(1);
    expect(await sweep(project, first - 1)).toEqual([]);
    // Due: the sweep computes the outcome again, which reads the files.
    github.failing = {};
    await sweep(project, first + 1);
    expect(asked('/pulls/7/files')).toHaveLength(2);
    expect(store.risk).toMatchObject({
      complete: true,
      tier: 'high',
      error: null,
      retryAt: null,
      attempts: 0,
    });
    expect(store.readiness).toMatchObject({ tier: 'high', required: 2 });

    // A read that keeps failing stops being tried, and stays unknown.
    github.failing.files = 502;
    github.pull = { ...github.pull, head: { sha: next } };
    reviewed(next);
    let now = Date.now();
    await refresh(project, { current: { headSha: next, baseRef: 'main' }, now: () => now });
    for (let i = 0; i < 10 && store.risk.retryAt; i++) {
      now = Date.parse(store.risk.retryAt) + 1;
      await enforcement.retryReviewStatuses({
        getProject: () => project,
        cfg,
        retryDelayMs: 0,
        now: () => now,
      });
    }
    expect(store.risk).toMatchObject({ attempts: revision.OBSERVE_ATTEMPTS, retryAt: null, complete: false });
    expect(asked('/pulls/7/files').length).toBe(2 + revision.OBSERVE_ATTEMPTS);
  });

  it('stops waiting for a read once the project has no policy', async () => {
    reviewed();
    github.failing.files = 502;
    await refresh(withPolicy(), { current: { headSha: head, baseRef: 'main' } });
    const due = Date.parse(store.risk.retryAt) + 1;
    expect(await sweep(plain, due)).toEqual([{ repo, prNumber: 7, published: false, skipped: 'no_policy' }]);
    expect(store.risk.retryAt).toBeNull();
    expect(await sweep(plain, due)).toEqual([]);
  });

  it('assesses again when the rules change, and stands as the highest tier until then', async () => {
    reviewed();
    github.files = changed('config/app.yml');
    await refresh(withPolicy(), { current: { headSha: head, baseRef: 'main' } });
    expect(store.readiness).toMatchObject({ tier: 'medium', required: 1 });
    // The policy now calls /config/ high. Read without recomputing, the stored
    // assessment is of other rules.
    const stricter = withPolicy({ rules: [{ pattern: '/config/', tier: 'high' }] });
    const before = await enforcement.readReviewOutcome(stricter, 7);
    expect(before.approvals.risk).toMatchObject({ unknown: true, tier: 'high' });
    expect(before.approvals.risk.reasons[0].why).toBe('policy_changed');
    // A save of the setting marks the outcome owed, and the sweep pays it.
    await enforcement.oweProjectOutcomes(stricter, { openPulls: async () => [7] });
    await sweep(stricter);
    expect(asked('/pulls/7/files')).toHaveLength(2);
    expect(store.readiness).toMatchObject({ tier: 'high', required: 2 });
    expect((await enforcement.readReviewOutcome(stricter, 7)).approvals.risk.unknown).toBe(false);
  });

  it('reads nothing with no token, and says the tier is unknown', async () => {
    reviewed();
    const { outcome } = await enforcement.refreshReviewOutcome(withPolicy(), 7, {
      cfg: {},
      current: { headSha: head, baseRef: 'main' },
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(outcome.approvals.risk).toMatchObject({ unknown: true, tier: 'high' });
  });
});

describe('the requirement beside the outcome', () => {
  it('leaves the review outcome what it is: a missing approval is no finding and no failure', async () => {
    reviewed();
    const project = enforcing();
    await refresh(project, { current: { headSha: head, baseRef: 'main' } });
    // Read once both statuses went out.
    const outcome = await enforcement.readReviewOutcome(project, 7);
    expect(outcome).toMatchObject({ outcome: 'passed', reasons: [], ready: false });
    expect(outcome.status).toMatchObject({
      context: 'briareus/code-review',
      state: 'success',
      published: true,
    });
    expect(outcome.approvals).toMatchObject({ result: 'pending', required: 2, valid: 0, missing: 2 });
    expect(outcome.approvals.status).toMatchObject({
      context: 'briareus/approvals',
      sha: head,
      state: 'pending',
      description: '0 of 2 human approvals at aaaaaaa (high risk)',
      published: true,
    });
    expect(posted().map((s) => [s.context, s.state])).toEqual([
      ['briareus/code-review', 'success'],
      ['briareus/approvals', 'pending'],
    ]);
    expect(store.row).toMatchObject({ outcome: 'passed' });
    expect(store.readiness).toMatchObject({ result: 'pending', tier: 'high', required: 2, valid: 0 });
  });

  it('turns ready once enough people approved the reviewed revision, and says since when it waited', async () => {
    reviewed();
    const project = enforcing();
    const waiting = await refresh(project, { current: { headSha: head, baseRef: 'main' } });
    expect(waiting.approvals.waitingSince).toBe(store.readiness.waitingSince);
    expect(waiting.approvals.waitingSince).toBeTruthy();
    expect(await enforcement.approvalsWaiting({ getProject: () => project })).toEqual([
      {
        repo,
        prNumber: 7,
        headSha: head,
        tier: 'high',
        required: 2,
        valid: 0,
        waitingSince: waiting.approvals.waitingSince,
      },
    ]);
    approve(1);
    const one = await refresh(project);
    expect(one.approvals).toMatchObject({
      valid: 1,
      missing: 1,
      result: 'pending',
      waitingSince: waiting.approvals.waitingSince,
    });
    approve(2);
    const both = await refresh(project);
    expect(both).toMatchObject({ outcome: 'passed', ready: true });
    expect(both.approvals).toMatchObject({ result: 'satisfied', valid: 2, missing: 0, waitingSince: null });
    expect(both.approvals.approvals.map((a) => [a.by.name, a.counted])).toEqual([
      ['Ada', true],
      ['Grace', true],
    ]);
    expect(posted('briareus/approvals').map((s) => [s.state, s.description])).toEqual([
      ['pending', '0 of 2 human approvals at aaaaaaa (high risk)'],
      ['pending', '1 of 2 human approvals at aaaaaaa (high risk)'],
      ['success', '2 of 2 human approvals at aaaaaaa (high risk)'],
    ]);
    expect(await enforcement.approvalsWaiting({ getProject: () => project })).toEqual([]);
    // The outcome's status was written once: nothing about it changed.
    expect(posted('briareus/code-review')).toHaveLength(1);
  });

  it('does not wait on people while the review itself has not passed', async () => {
    reviewed();
    store.findings = [
      {
        id: 1,
        findingRef: 'r1',
        title: 'Lost update',
        reconciliation: 'new',
        commentId: 1,
        threadId: 'T1',
        shouldFix: 'fix',
      },
    ];
    const outcome = await refresh(enforcing(), { current: { headSha: head, baseRef: 'main' } });
    expect(outcome).toMatchObject({ outcome: 'changes_required', ready: false });
    expect(outcome.approvals).toMatchObject({ result: 'pending', waitingSince: null });
    expect(store.readiness.waitingSince).toBeNull();
    // Approved all the same: the people's side is satisfied, the pull request is not ready.
    approve(1);
    approve(2);
    const approved = await refresh(enforcing());
    expect(approved).toMatchObject({ outcome: 'changes_required', ready: false });
    expect(approved.approvals.result).toBe('satisfied');
    expect(posted('briareus/code-review').at(-1).state).toBe('failure');
    expect(posted('briareus/approvals').at(-1).state).toBe('success');
  });

  it('invalidates the approvals and the readiness when the head moves', async () => {
    reviewed();
    const project = enforcing();
    approve(1);
    approve(2);
    expect((await refresh(project, { current: { headSha: head, baseRef: 'main' } })).ready).toBe(true);
    // A push: the server sees the pull request at another head.
    github.pull = { ...github.pull, head: { sha: next } };
    const { outcome } = await enforcement.noteReviewedRevision(
      project,
      7,
      { headSha: next, baseRef: 'main' },
      { cfg, retryDelayMs: 0 },
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(outcome).toMatchObject({ outcome: 'pending', stale: true, ready: false });
    expect(outcome.approvals).toMatchObject({
      result: 'pending',
      valid: 0,
      missing: 2,
      reviewCurrent: false,
      headSha: next,
    });
    expect(outcome.approvals.approvals.map((a) => a.reason)).toEqual(['head_moved', 'head_moved']);
    expect(outcome.approvals.reasons.map((r) => r.code)).toEqual(['approvals_missing', 'review_not_current']);
    // The new head carries `pending` for both; the approvals stay on record.
    expect(posted('briareus/approvals').at(-1)).toMatchObject({ sha: next, state: 'pending' });
    expect(posted('briareus/code-review').at(-1)).toMatchObject({ sha: next, state: 'pending' });
    expect(store.approvals).toHaveLength(2);
    expect(store.risk.headSha).toBe(next);
  });

  it('invalidates them when the pull request is retargeted on the same head', async () => {
    reviewed();
    const project = enforcing();
    approve(1);
    approve(2);
    await refresh(project, { current: { headSha: head, baseRef: 'main' } });
    github.pull = { ...github.pull, base: { ref: 'release' } };
    const { outcome } = await enforcement.noteReviewedRevision(
      project,
      7,
      { headSha: head, baseRef: 'release' },
      { cfg, retryDelayMs: 0 },
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(outcome).toMatchObject({ stale: true, ready: false });
    expect(outcome.approvals.approvals.map((a) => a.reason)).toEqual(['base_changed', 'base_changed']);
    // The same commit goes from success back to pending.
    expect(posted('briareus/approvals').map((s) => [s.sha, s.state])).toEqual([
      [head, 'success'],
      [head, 'pending'],
    ]);
  });

  it('changes nothing when the server sees the same revision again', async () => {
    reviewed();
    const project = enforcing();
    await refresh(project, { current: { headSha: head, baseRef: 'main' } });
    const before = requests.length;
    expect(
      await enforcement.noteReviewedRevision(project, 7, { headSha: head, baseRef: 'main' }, { cfg }),
    ).toBeNull();
    expect(requests.length).toBe(before);
  });

  it('stops counting a withdrawn approval at the next computation', async () => {
    reviewed();
    const project = enforcing();
    approve(1);
    approve(2);
    await refresh(project, { current: { headSha: head, baseRef: 'main' } });
    store.approvals[0].status = 'withdrawn';
    const outcome = await refresh(project);
    expect(outcome).toMatchObject({ ready: false });
    expect(outcome.approvals).toMatchObject({ result: 'pending', valid: 1 });
    expect(posted('briareus/approvals').at(-1)).toMatchObject({ sha: head, state: 'pending' });
  });

  it('replaces a status left on GitHub when the policy is switched off', async () => {
    reviewed();
    await refresh(enforcing(), { current: { headSha: head, baseRef: 'main' } });
    expect(posted('briareus/approvals').at(-1).state).toBe('pending');
    const outcome = await refresh({ ...plain, enforceReviewOutcome: true });
    expect(outcome.approvals).toMatchObject({ enabled: false, result: 'not_required' });
    expect(outcome.ready).toBe(true);
    expect(posted('briareus/approvals').at(-1)).toMatchObject({
      sha: head,
      state: 'success',
      description: 'Human approval is not required by this project',
    });
  });

  it('computes and shows the requirement for a project that publishes nothing', async () => {
    reviewed();
    const outcome = await refresh(withPolicy(), { current: { headSha: head, baseRef: 'main' } });
    expect(outcome.approvals).toMatchObject({ result: 'pending', required: 2 });
    expect(outcome.approvals.status).toMatchObject({ state: 'pending', published: false });
    expect(posted()).toEqual([]);
    expect(store.readiness.publishOwedAt).toBeNull();
  });
});

describe('the approvals status, published like the outcome’s', () => {
  const lostAnswer = () => (url, init) => {
    const sha = url.split('/').pop();
    carried.set(sha, [JSON.parse(init.body), ...(carried.get(sha) || [])]);
    throw new TypeError('fetch failed');
  };

  it('records a write GitHub refused, keeps it owed and pays it from the sweep', async () => {
    reviewed();
    const project = enforcing();
    // The outcome's write lands; the approval requirement's is refused.
    answers = [null, answer(403, { message: 'Resource not accessible' })];
    await refresh(project, { current: { headSha: head, baseRef: 'main' } });
    expect(store.row).toMatchObject({ publishedConfirmed: true, publishedState: 'success' });
    expect(store.readiness).toMatchObject({
      publishAttempts: 1,
      publishErrorStatus: 403,
      publishedConfirmed: false,
      publishedSha: null,
    });
    expect(store.readiness.publishOwedAt).toBeTruthy();
    const read = await enforcement.readReviewOutcome(project, 7);
    expect(read.approvals.status).toMatchObject({
      state: 'pending',
      published: false,
      errorStatus: 403,
      attempts: 1,
    });
    expect(await enforcement.reviewStatusFailures({ getProject: () => project })).toEqual([
      expect.objectContaining({
        repo,
        prNumber: 7,
        context: 'briareus/approvals',
        outcome: 'pending',
        errorStatus: 403,
      }),
    ]);
    // Not before its backoff; then it goes out and the debt is settled.
    expect(await sweep(project, Date.parse(store.readiness.publishRetryAt) - 1)).toEqual([]);
    const results = await sweep(project, Date.parse(store.readiness.publishRetryAt) + 1);
    expect(results).toEqual([{ repo, prNumber: 7, channel: 'approvals', published: true }]);
    expect(store.readiness).toMatchObject({
      publishedConfirmed: true,
      publishedState: 'pending',
      publishOwedAt: null,
      publishError: null,
    });
    expect((await enforcement.readReviewOutcome(project, 7)).approvals.status.published).toBe(true);
  });

  it('never trusts a write whose answer was lost, in either direction', async () => {
    reviewed();
    const project = enforcing();
    approve(1);
    approve(2);
    // The `success` lands on GitHub and its answer never arrives, three times over.
    answers = [null, lostAnswer(), lostAnswer(), lostAnswer()];
    await refresh(project, { current: { headSha: head, baseRef: 'main' } });
    expect(store.readiness).toMatchObject({
      statusState: 'success',
      publishedConfirmed: false,
      publishedSha: null,
    });
    expect((await enforcement.readReviewOutcome(project, 7)).approvals.status.published).toBe(false);
    // An approval is withdrawn meanwhile: what must replace that success is posted,
    // although the record never learned the success was there.
    store.approvals[0].status = 'withdrawn';
    await refresh(project);
    expect(carried.get(head)[0]).toMatchObject({ context: 'briareus/approvals', state: 'pending' });
    expect(store.readiness).toMatchObject({
      publishedConfirmed: true,
      publishedState: 'pending',
      publishOwedAt: null,
    });
  });

  it('does not post the same status twice, and replaces one somebody else wrote under its name', async () => {
    reviewed();
    const project = enforcing();
    await refresh(project, { current: { headSha: head, baseRef: 'main' } });
    await refresh(project);
    expect(posted('briareus/approvals')).toHaveLength(1);
    // Another holder of a token writes `success` under the context.
    carried.set(head, [
      { context: 'briareus/approvals', state: 'success', description: 'ok' },
      ...carried.get(head),
    ]);
    await refresh(project);
    expect(posted('briareus/approvals')).toHaveLength(2);
    expect(carried.get(head)[0]).toMatchObject({ context: 'briareus/approvals', state: 'pending' });
  });

  it('writes it as the server, whoever’s request led to it', async () => {
    reviewed();
    const { asGithubUser } = await import('../lib/github.js');
    await asGithubUser('ada-token', () =>
      refresh(enforcing(), { current: { headSha: head, baseRef: 'main' } }),
    );
    expect(requests.filter((r) => r.method === 'POST').map((r) => r.token)).toEqual([
      'server-token',
      'server-token',
    ]);
  });

  it('drops what it owes for a pull request that closed with a failing status', async () => {
    reviewed();
    const project = enforcing();
    answers = [null, answer(403, {})];
    await refresh(project, { current: { headSha: head, baseRef: 'main' } });
    const results = await enforcement.retryReviewStatuses({
      getProject: () => project,
      cfg,
      now: () => Date.parse(store.readiness.publishRetryAt) + 1,
      isOpen: async () => false,
    });
    expect(results).toEqual([
      { repo, prNumber: 7, channel: 'approvals', published: false, skipped: 'closed' },
    ]);
    expect(store.readiness).toMatchObject({ publishOwedAt: null, publishFailedAt: null });
  });
});

describe('approvals given on GitHub', () => {
  const review = (id, login, state = 'APPROVED', over = {}) => ({
    id,
    state,
    commit_id: head,
    submitted_at: '2026-11-10T12:00:00Z',
    author_association: 'COLLABORATOR',
    user: { login, type: 'User' },
    ...over,
  });

  it('are not even read for a project that does not accept them', async () => {
    reviewed();
    github.reviews = [review(1, 'octo-reviewer'), review(2, 'mona-reviewer')];
    const outcome = await refresh(withPolicy(), { current: { headSha: head, baseRef: 'main' } });
    expect(asked('/reviews')).toEqual([]);
    expect(syncGithubCodeReviewApprovals).not.toHaveBeenCalled();
    expect(outcome.approvals).toMatchObject({ valid: 0, acceptsGithubApprovals: false });
  });

  it('count from an outside collaborator, and never from an account automation acts as', async () => {
    reviewed();
    github.reviews = [
      review(1, 'octo-reviewer'),
      review(2, 'ada-dev'),
      review(3, 'briareus-bot'),
      review(4, 'drive-by', 'APPROVED', { author_association: 'NONE' }),
    ];
    const project = withPolicy({ acceptGithubApprovals: true });
    const outcome = await refresh(project, { current: { headSha: head, baseRef: 'main' } });
    expect(outcome.approvals.approvals.map((a) => [a.by.name, a.counted, a.reason])).toEqual([
      ['octo-reviewer', true, null],
      ['ada-dev', false, 'linked_account'],
      ['briareus-bot', false, 'server_account'],
      ['drive-by', false, 'not_a_collaborator'],
    ]);
    expect(outcome.approvals).toMatchObject({ valid: 1, required: 2, result: 'pending' });
    // Ada records hers through the API instead, and that one counts.
    approve(1);
    expect((await refresh(project)).approvals).toMatchObject({ valid: 2, result: 'satisfied' });
  });

  it('never counts the approval a review’s own label step submitted, even once the account is no longer linked', async () => {
    reviewed();
    github.reviews = [review(1, 'grace-dev'), review(2, 'grace-dev', 'APPROVED', { id: 2 })];
    const project = withPolicy({ acceptGithubApprovals: true });
    // The review ends: its label step approved as its owner's account, after the
    // approval the server knew of before the step.
    const outcome = await refresh(project, {
      current: { headSha: head, baseRef: 'main' },
      labelStep: { login: 'grace-dev', known: [1], since: Date.parse('2026-11-10T11:59:00Z') },
    });
    expect(outcome.approvals.approvals.map((a) => [a.githubReviewId, a.counted, a.reason])).toEqual([
      // Superseded by the same account's later review, which is the label step's.
      [1, false, 'superseded'],
      [2, false, 'review_label_step'],
    ]);
    // Later, with nobody linked and no label step in sight, it is still the review's.
    enforcement.setApprovalDirectory({
      user: () => null,
      mayApprove: () => false,
      linkedLogins: () => [],
    });
    const later = await refresh(project);
    expect(later.approvals.approvals[1]).toMatchObject({ counted: false, reason: 'review_label_step' });
    expect(later.approvals.valid).toBe(0);
  });

  it('are read once when a review’s label step has run, so its approval is on record before anybody counts those', async () => {
    reviewed();
    github.reviews = [review(1, 'grace-dev')];
    const project = withPolicy();
    await refresh(project, {
      current: { headSha: head, baseRef: 'main' },
      labelStep: { login: 'grace-dev', known: null, since: Date.parse('2026-11-10T11:59:30Z') },
    });
    expect(asked('/reviews')).toHaveLength(1);
    expect(store.approvals).toEqual([
      expect.objectContaining({
        githubReviewId: 1,
        githubLogin: 'grace-dev',
        automation: 'review_label_step',
      }),
    ]);
    // Not read again without a label step, and it counts for nobody either way.
    await refresh(project);
    expect(asked('/reviews')).toHaveLength(1);
    // The project comes to accept GitHub approvals, with nobody linked any more.
    enforcement.setApprovalDirectory({ user: () => null, mayApprove: () => false, linkedLogins: () => [] });
    const later = await refresh(withPolicy({ acceptGithubApprovals: true }));
    expect(later.approvals.approvals).toEqual([
      expect.objectContaining({ githubReviewId: 1, counted: false, reason: 'review_label_step' }),
    ]);
    // A read that fails then is nobody's to wait for.
    store.approvals = [];
    store.risk = null;
    github.failing.reviews = 502;
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    await refresh(project, {
      current: { headSha: head, baseRef: 'main' },
      labelStep: { login: null, since: 1 },
    });
    expect(store.risk).toMatchObject({ complete: true, error: null, retryAt: null, attempts: 0 });
    expect(logged).toHaveBeenCalledWith(expect.stringContaining('Reviews of acme/shop#7'));
    logged.mockRestore();
  });

  it('keep a failed read of the files waiting for its turn while the reviews are read', async () => {
    reviewed();
    github.reviews = [review(1, 'octo-reviewer')];
    github.failing.files = 502;
    const project = withPolicy({ acceptGithubApprovals: true });
    await refresh(project, { current: { headSha: head, baseRef: 'main' } });
    const { retryAt, error } = store.risk;
    expect(retryAt).toBeTruthy();
    // Computed again before the retry is due: the reviews are read, the debt stays.
    github.failing = {};
    await refresh(project);
    expect(asked('/pulls/7/files')).toHaveLength(1);
    expect(asked('/reviews').length).toBeGreaterThan(0);
    expect(store.risk).toMatchObject({ complete: false, retryAt, error, attempts: 1 });
    // No approval given there counts while the revision itself could not be read.
    expect(store.readiness.valid).toBe(0);
    await sweep(project, Date.parse(retryAt) + 1);
    expect(store.risk).toMatchObject({ complete: true, error: null, retryAt: null });
    expect(store.readiness).toMatchObject({ valid: 1 });
  });

  it('follow a dismissal on GitHub, when a webhook says a review changed', async () => {
    reviewed();
    github.reviews = [review(1, 'octo-reviewer'), review(2, 'mona-reviewer')];
    const project = enforcing({ acceptGithubApprovals: true });
    expect((await refresh(project, { current: { headSha: head, baseRef: 'main' } })).ready).toBe(true);
    github.reviews = [review(1, 'octo-reviewer', 'DISMISSED'), review(2, 'mona-reviewer')];
    const { outcome } = await enforcement.noteGithubReview(project, 7, { cfg, retryDelayMs: 0 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(outcome.approvals).toMatchObject({ valid: 1, result: 'pending' });
    expect(outcome.approvals.approvals[0]).toMatchObject({ counted: false, reason: 'dismissed' });
    expect(posted('briareus/approvals').at(-1).state).toBe('pending');
    // Nothing for a project that does not accept them, or a pull request without an outcome.
    expect(await enforcement.noteGithubReview(withPolicy(), 7, { cfg })).toBeNull();
    store.row = null;
    expect(await enforcement.noteGithubReview(project, 7, { cfg })).toBeNull();
  });

  it('count none while the reviews cannot be read, and try again', async () => {
    reviewed();
    github.reviews = [review(1, 'octo-reviewer'), review(2, 'mona-reviewer')];
    const project = withPolicy({ acceptGithubApprovals: true });
    await refresh(project, { current: { headSha: head, baseRef: 'main' } });
    expect(store.readiness).toMatchObject({ valid: 2, result: 'satisfied' });
    github.failing.reviews = 502;
    const outcome = await refresh(project);
    expect(outcome.approvals).toMatchObject({ valid: 0, result: 'pending' });
    expect(outcome.approvals.approvals.map((a) => a.reason)).toEqual([
      'github_unconfirmed',
      'github_unconfirmed',
    ]);
    expect(outcome.approvals.reasons.map((r) => r.code)).toContain('github_approvals_unread');
    expect(store.risk).toMatchObject({ reviewsSyncedAt: null, attempts: 1 });
    expect(store.risk.retryAt).toBeTruthy();
    // The assessment of the files is not thrown away with it.
    expect(store.risk).toMatchObject({ complete: true, tier: 'high' });
    github.failing = {};
    await sweep(project, Date.parse(store.risk.retryAt) + 1);
    expect(store.readiness).toMatchObject({ valid: 2, result: 'satisfied' });
  });

  it('count none when the server cannot tell which account is its own', async () => {
    reviewed();
    github.reviews = [review(1, 'briareus-bot'), review(2, 'mona-reviewer')];
    github.failing.user = 401;
    const outcome = await refresh(withPolicy({ acceptGithubApprovals: true }), {
      current: { headSha: head, baseRef: 'main' },
    });
    expect(syncGithubCodeReviewApprovals).not.toHaveBeenCalled();
    expect(outcome.approvals.valid).toBe(0);
    expect(outcome.approvals.reasons.map((r) => r.code)).toContain('github_approvals_unread');
  });

  it('do not count from somebody whose commits are in the pull request', async () => {
    reviewed();
    github.commits = [{ author: { login: 'octo-author' }, committer: { login: 'octo-pair' } }];
    github.reviews = [review(1, 'octo-pair'), review(2, 'mona-reviewer')];
    const outcome = await refresh(withPolicy({ acceptGithubApprovals: true }), {
      current: { headSha: head, baseRef: 'main' },
    });
    expect(outcome.approvals.approvals.map((a) => [a.by.name, a.counted, a.reason])).toEqual([
      ['octo-pair', false, 'own_change'],
      ['mona-reviewer', true, null],
    ]);
  });
});

describe('risk that makes the security pass required', () => {
  const strict = { tiers: { high: { approvals: 2, requireSecurity: true } } };
  const advisory = (over = strict) => withPolicy(over, { securityReview: 'advisory' });

  it('requires the pass for a review about to start on a high-risk change, and not on a low-risk one', async () => {
    expect(
      await enforcement.reviewSecurityPolicy(advisory(), 7, { headSha: head, baseRef: 'main' }, { cfg }),
    ).toEqual({
      policy: 'required',
      raisedBy: 'high',
    });
    expect(store.risk).toMatchObject({ headSha: head, tier: 'high', complete: true });
    github.files = changed('src/cart.js');
    github.pull = { ...github.pull, head: { sha: next } };
    expect(
      await enforcement.reviewSecurityPolicy(advisory(), 7, { headSha: next, baseRef: 'main' }, { cfg }),
    ).toEqual({
      policy: 'advisory',
      raisedBy: null,
    });
    // A project with no pass of its own gets one on the tier that requires it.
    github.files = changed('migrations/1.sql');
    expect(
      await enforcement.reviewSecurityPolicy(
        withPolicy(strict),
        7,
        { headSha: next, baseRef: 'main' },
        { cfg },
      ),
    ).toEqual({ policy: 'off', raisedBy: null });
    store.risk = null;
    expect(
      await enforcement.reviewSecurityPolicy(
        withPolicy(strict),
        7,
        { headSha: next, baseRef: 'main' },
        { cfg },
      ),
    ).toEqual({ policy: 'required', raisedBy: 'high' });
  });

  it('requires it when the tier cannot be known before discovery', async () => {
    github.failing.files = 502;
    expect(
      await enforcement.reviewSecurityPolicy(advisory(), 7, { headSha: head, baseRef: 'main' }, { cfg }),
    ).toEqual({
      policy: 'required',
      raisedBy: 'high',
    });
    // Even when the store cannot keep what was read.
    store.failing.risk = 'Connection lost';
    github.failing = {};
    github.files = changed('src/cart.js');
    expect(
      await enforcement.reviewSecurityPolicy(advisory(), 7, { headSha: head, baseRef: 'main' }, { cfg }),
    ).toEqual({
      policy: 'required',
      raisedBy: 'high',
    });
  });

  it('holds the outcome to the pass on a high-risk change of a project that leaves it advisory', async () => {
    // The review ran without a pass.
    reviewed();
    const outcome = await refresh(advisory(), { current: { headSha: head, baseRef: 'main' } });
    expect(outcome.security).toMatchObject({
      policy: 'required',
      result: 'not_run',
      blocking: true,
      requiredByRisk: 'high',
    });
    expect(outcome.outcome).toBe('incomplete');
    expect(outcome.reasons).toEqual([
      expect.objectContaining({ code: 'requirement_unmet', requirement: 'security', effect: 'incomplete' }),
    ]);
    expect(outcome.approvals.requiredChecks).toEqual({ security: true });
    expect(store.row.securityPolicy).toBe('required');
    // The same review of a low-risk change is held to nothing more than the project asks.
    store.risk = null;
    github.files = changed('src/cart.js');
    const low = await refresh(advisory(), { current: { headSha: head, baseRef: 'main' } });
    expect(low.security).toMatchObject({ policy: 'advisory', blocking: false });
    expect(low.security).not.toHaveProperty('requiredByRisk');
    expect(low.outcome).toBe('passed');
  });

  it('does not compute again each time the pull request is seen, with the raised policy stored', async () => {
    reviewed();
    const project = advisory();
    await refresh(project, { current: { headSha: head, baseRef: 'main' } });
    const before = requests.length;
    expect(
      await enforcement.noteReviewedRevision(project, 7, { headSha: head, baseRef: 'main' }, { cfg }),
    ).toBeNull();
    expect(requests.length).toBe(before);
    // Once the project stops raising it, the stored outcome is of another policy.
    const relaxed = advisory({});
    const again = await enforcement.noteReviewedRevision(
      relaxed,
      7,
      { headSha: head, baseRef: 'main' },
      { cfg },
    );
    expect(again.outcome.security).toMatchObject({ policy: 'advisory', blocking: false });
  });

  it('never names a provider, a model or an effort', async () => {
    const answer = await enforcement.reviewSecurityPolicy(
      advisory(),
      7,
      { headSha: head, baseRef: 'main' },
      { cfg },
    );
    expect(Object.keys(answer).sort()).toEqual(['policy', 'raisedBy']);
  });
});
