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
    // Whose sessions made commits of the revision, and what the other pull requests at
    // the same head should carry by their own reckoning, per ledger.
    workers: [],
    siblings: { review: [], approvals: [] },
    owedAtHead: [],
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
      workers: s.workers,
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
        observedAt: iso(risk.observedAt) || store.now(),
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
    clearCodeReviewWaiting: vi.fn(async () => {
      if (store.readiness) store.readiness.waitingSince = null;
    }),
    // This pull request's own row and the others' at that head, as stored.
    listCodeReviewStatusesAtHead: vi.fn(async (_repo, sha, ledger = 'review') => {
      const own = store.ledger(ledger);
      return [
        ...(own?.headSha === sha && own.statusState
          ? [{ prNumber: own.prNumber, state: own.statusState, description: own.statusDescription || '' }]
          : []),
        ...store.siblings[ledger].filter((row) => row.sha === sha).map(({ sha: _sha, ...row }) => row),
      ];
    }),
    oweCodeReviewStatusesAtHead: vi.fn(async (_repo, sha, exceptPr) => {
      store.owedAtHead.push([sha, exceptPr]);
      // The row of this pull request, when another one's change is what marks it.
      for (const row of [store.row, store.readiness])
        if (row && row.headSha === sha && row.prNumber !== exceptPr) row.publishOwedAt ||= store.now();
      return 0;
    }),
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
    recordCodeReviewStatusPublished: vi.fn(
      async (_repo, _pr, status, { posted = true, ledger, own } = {}) => {
        const row = store.ledger(ledger);
        // Settled against the pull request's own status, which a shared commit may not carry.
        const mine = own || status;
        const settled =
          row.headSha === mine.sha &&
          row.statusState === mine.state &&
          row.statusDescription === mine.description;
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
      },
    ),
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

// The GitHub accounts users linked: Ada's and Grace's.
const linked = [
  { userId: 1, id: 101, login: 'ada-dev' },
  { userId: 2, id: 102, login: 'grace-dev' },
];
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
    workers: [],
    siblings: { review: [], approvals: [] },
    owedAtHead: [],
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
    commits: [
      {
        sha: 'c'.repeat(40),
        author: { login: 'octo-author', id: 900 },
        committer: { login: 'web-flow', id: 2 },
      },
    ],
    // The open pull requests at a commit; this one alone unless a test says otherwise.
    pullsAt: null,
    openPulls: [],
    reviews: [],
    permissions: {},
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
        const at = /\/commits\/([0-9a-f]+)\/pulls/.exec(path)?.[1];
        if (at) {
          if (github.failing.siblings) return answer(github.failing.siblings, { message: 'Server Error' });
          return answer(
            200,
            github.pullsAt ? github.pullsAt(at) : [{ number: 7, state: 'open', head: { sha: at } }],
          );
        }
        if (path.includes('/pulls?state=open')) {
          if (github.failing.openPulls) return answer(github.failing.openPulls);
          const page = Number(/[?&]page=(\d+)/.exec(path)?.[1] || 1);
          return answer(200, github.openPulls.slice((page - 1) * 100, page * 100));
        }
        const member = /\/collaborators\/([^/]+)\/permission/.exec(path)?.[1];
        if (member) return answer(200, github.permissions[member] || { permission: 'read' });
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
    accountsOf: (id) => linked.filter((account) => account.userId === id),
    linkedAccounts: () => linked,
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
    expect(store.risk.authors).toEqual({
      author: { id: null, login: 'octo-author' },
      commits: [{ id: 900, login: 'octo-author' }],
      shas: ['c'.repeat(40)],
      complete: true,
    });
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
    const { refreshCodeReviewOutcome } = await import('../lib/db.js');
    expect(refreshCodeReviewOutcome).toHaveBeenCalledTimes(1);
  });

  it('starts independent file and commit reads together', async () => {
    const fetch = globalThis.fetch;
    let release;
    const blocked = new Promise((resolve) => {
      release = resolve;
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url, init) => {
        if (url.includes('/files?')) await blocked;
        return fetch(url, init);
      }),
    );
    const pending = revision.readRevisionFacts(cfg, repo, 7, { headSha: head });
    try {
      await vi.waitFor(() => expect(asked('/commits?')).toHaveLength(1));
    } finally {
      release();
    }
    expect(await pending).toMatchObject({ complete: true, authors: { complete: true } });
  });

  it('does not reuse an assessment whose base was unknown', async () => {
    await refresh(withPolicy(), { current: { headSha: head, baseRef: 'main' } });
    store.risk.baseRef = null;
    github.files = changed('README.md');
    const result = await refresh(withPolicy(), { current: { headSha: head, baseRef: 'main' } });
    expect(asked('/files?')).toHaveLength(2);
    expect(result.approvals.risk).toMatchObject({ tier: 'low', unknown: false });
  });

  it('rejects facts read across a retarget, and retries for the new base', async () => {
    const pull = github.pull;
    let reads = 0;
    github.pull = () => ({ ...pull, base: { ref: ++reads === 1 ? 'main' : 'release' } });
    const project = withPolicy();
    await refresh(project, { current: { headSha: head, baseRef: 'main' } });
    expect(store.risk).toMatchObject({ complete: false, attempts: 1 });
    github.pull = { ...pull, base: { ref: 'release' } };
    github.files = changed('README.md');
    await refresh(project, { current: { headSha: head, baseRef: 'release' } });
    expect(store.risk).toMatchObject({ baseRef: 'release', complete: true, tier: 'low' });
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
      true,
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
      true,
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

  it('is no dead end once the sweep gave up: read again when a person asks, and by itself after an hour', async () => {
    reviewed();
    github.failing.files = 502;
    const project = withPolicy();
    let now = Date.parse('2026-11-10T12:00:00Z');
    const compute = (options = {}) =>
      refresh(project, { current: { headSha: head, baseRef: 'main' }, now: () => now, ...options });
    await compute();
    for (let i = 0; i < 10 && store.risk.retryAt; i++) {
      now = Date.parse(store.risk.retryAt) + 1;
      await compute();
    }
    expect(store.risk).toMatchObject({ attempts: revision.OBSERVE_ATTEMPTS, retryAt: null, complete: false });
    const reads = () => asked('/pulls/7/files').length;
    const given = reads();
    // Computed again a minute later, for whatever reason: nothing is read.
    now += 60_000;
    await compute();
    expect(reads()).toBe(given);
    // A person waits on it: read at once, and not again within a few seconds.
    await compute({ asked: true });
    expect(reads()).toBe(given + 1);
    now += 5_000;
    await compute({ asked: true });
    expect(reads()).toBe(given + 1);
    // By itself, an hour after the last attempt.
    now += revision.RETRY_MAX_MS - 5_001;
    await compute();
    expect(reads()).toBe(given + 1);
    now += 2;
    await compute();
    expect(reads()).toBe(given + 2);
    expect(store.risk).toMatchObject({ complete: false, retryAt: null });
    // And once GitHub answers, the assessment is the real one.
    github.failing = {};
    now += revision.ASKED_RETRY_MS;
    const outcome = await compute({ asked: true });
    expect(store.risk).toMatchObject({
      complete: true,
      tier: 'high',
      attempts: 0,
      error: null,
      retryAt: null,
    });
    expect(outcome.approvals.risk.unknown).toBe(false);
  });

  it('reads a head again that moved under the first read, instead of leaving it unknown', async () => {
    reviewed();
    let reads = 0;
    const pull = github.pull;
    // The server's own idea of the head was ahead of what GitHub answered at first.
    github.pull = () => (reads++ < 1 ? { ...pull, head: { sha: next } } : pull);
    const project = withPolicy();
    await refresh(project, { current: { headSha: head, baseRef: 'main' } });
    expect(store.risk).toMatchObject({ complete: false, authors: null, attempts: 1 });
    expect(store.risk.assessment.reasons[0].why).toBe('head_moved');
    await sweep(project, Date.parse(store.risk.retryAt) + 1);
    expect(store.risk).toMatchObject({ complete: true, tier: 'high', attempts: 0, retryAt: null });
    expect(store.risk.authors.author).toEqual({ id: null, login: 'octo-author' });
  });

  it('keeps the two reads apart: the commits failing does not unsay what the files gave', async () => {
    reviewed();
    github.files = changed('src/cart.js');
    github.failing.commits = 502;
    const project = withPolicy();
    const outcome = await refresh(project, { current: { headSha: head, baseRef: 'main' } });
    expect(store.risk).toMatchObject({ complete: true, tier: 'low', authors: null, attempts: 1 });
    expect(outcome.approvals.risk).toMatchObject({ unknown: false, tier: 'low' });
    // Only the commits are asked for again.
    github.failing = {};
    await sweep(project, Date.parse(store.risk.retryAt) + 1);
    expect(asked('/pulls/7/files')).toHaveLength(1);
    expect(asked('/pulls/7/commits')).toHaveLength(2);
    expect(store.risk).toMatchObject({ complete: true, attempts: 0, error: null, retryAt: null });
    expect(store.risk.authors.complete).toBe(true);
  });

  it('says so when a pull request has more commits than GitHub lists', async () => {
    reviewed();
    github.pull = { ...github.pull, commits: 400 };
    github.commits = Array.from({ length: 250 }, (_, i) => ({
      sha: String(i).padStart(40, '0'),
      author: { login: 'octo-author', id: 900 },
      committer: { login: 'octo-author', id: 900 },
    }));
    approve(1);
    approve(2);
    const outcome = await refresh(withPolicy(), { current: { headSha: head, baseRef: 'main' } });
    expect(asked('/pulls/7/commits')).toHaveLength(3);
    expect(store.risk.authors).toMatchObject({ complete: false });
    expect(store.risk.authors.shas).toHaveLength(250);
    // Nobody's approval can be told from an approval of their own change.
    expect(outcome.approvals.approvals.map((a) => a.reason)).toEqual([
      'authorship_unknown',
      'authorship_unknown',
    ]);
    expect(outcome.approvals.reasons.map((r) => r.code)).toContain('authorship_unknown');
    // A project that counts such approvals is not held up by it.
    const open = await refresh(withPolicy({ allowSelfApproval: true }));
    expect(open.approvals).toMatchObject({ valid: 2, result: 'satisfied' });
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

describe('a commit shared by several pull requests', () => {
  // Pull request 7 here is the trivial one: a low-risk change whose review passed, so
  // that by itself it asks for nothing. Pull request 5 is at the same commit against
  // another base, high risk, reviewed and passed, with no approval yet.
  const both = (sha) => [5, 7].map((number) => ({ number, state: 'open', head: { sha } }));
  const fivePending = () => {
    store.siblings = {
      review: [
        { sha: head, prNumber: 5, state: 'success', description: 'Review passed at aaaaaaa: no findings' },
      ],
      approvals: [
        {
          sha: head,
          prNumber: 5,
          state: 'pending',
          description: '0 of 2 human approvals at aaaaaaa (high risk)',
        },
      ],
    };
  };
  const trivial = () => {
    reviewed();
    github.files = changed('README.md');
  };
  const current = { headSha: head, baseRef: 'main' };

  it('carries the most restrictive status of them, and says whose it is', async () => {
    trivial();
    fivePending();
    github.pullsAt = both;
    const project = enforcing();
    await refresh(project, { current });
    // By itself this pull request passes on both counts.
    expect(store.row).toMatchObject({ outcome: 'passed', statusState: 'success' });
    expect(store.readiness).toMatchObject({ result: 'not_required', statusState: 'success' });
    // The commit does not say so for the approvals: pull request 5 still waits on people.
    expect(posted('briareus/approvals')).toEqual([
      {
        sha: head,
        context: 'briareus/approvals',
        state: 'pending',
        description: 'PR #5: 0 of 2 human approvals at aaaaaaa (high risk)',
      },
    ]);
    expect(posted('briareus/code-review')).toEqual([
      {
        sha: head,
        context: 'briareus/code-review',
        state: 'success',
        description: 'PR #5: Review passed at aaaaaaa: no findings',
      },
    ]);
    const read = await enforcement.readReviewOutcome(project, 7);
    expect(read.approvals.status).toMatchObject({
      state: 'success',
      published: false,
      publishedState: 'pending',
      publishedDescription: 'PR #5: 0 of 2 human approvals at aaaaaaa (high risk)',
    });
    // The same state under the other pull request's name is this one's state too.
    expect(read.status).toMatchObject({ state: 'success', published: true });
    // Nothing is owed for it: what the commit carries is what it should carry.
    expect(store.readiness.publishOwedAt).toBeNull();
    expect(await sweep(project)).toEqual([]);
    // And the other pull request is told to look at the commit again.
    expect(store.owedAtHead).toEqual([
      [head, 7],
      [head, 7],
    ]);
  });

  it('works out the same status whichever of them publishes, and does not write it twice', async () => {
    trivial();
    fivePending();
    github.pullsAt = both;
    const project = enforcing();
    await refresh(project, { current });
    await refresh(project);
    expect(posted('briareus/approvals')).toHaveLength(1);
    expect(posted('briareus/code-review')).toHaveLength(1);
    // Pull request 5 gets its approvals and publishes for the commit; this one, marked
    // as owing, finds the commit carrying what it would have written and only records it.
    store.siblings.approvals[0] = {
      sha: head,
      prNumber: 5,
      state: 'success',
      description: '2 of 2 human approvals at aaaaaaa (high risk)',
    };
    const theirs = {
      context: 'briareus/approvals',
      state: 'success',
      description: 'PR #5: 2 of 2 human approvals at aaaaaaa (high risk)',
    };
    carried.set(head, [theirs, ...carried.get(head)]);
    store.readiness.publishOwedAt = store.now();
    expect(await sweep(project)).toEqual([
      { repo, prNumber: 7, channel: 'approvals', published: true, skipped: 'unchanged' },
    ]);
    expect(posted('briareus/approvals')).toHaveLength(1);
    expect(store.readiness).toMatchObject({
      publishedState: 'success',
      publishedDescription: theirs.description,
      publishOwedAt: null,
    });
    expect((await enforcement.readReviewOutcome(project, 7)).approvals.status.published).toBe(true);
  });

  it('writes success again only once every pull request at the commit passes', async () => {
    trivial();
    fivePending();
    github.pullsAt = both;
    const project = enforcing();
    await refresh(project, { current });
    // Had the commit not been given it by the other publication, this one writes it.
    store.siblings.approvals[0] = {
      sha: head,
      prNumber: 5,
      state: 'success',
      description: '2 of 2 human approvals at aaaaaaa (high risk)',
    };
    store.readiness.publishOwedAt = store.now();
    await sweep(project);
    expect(posted('briareus/approvals').map((s) => [s.state, s.description])).toEqual([
      ['pending', 'PR #5: 0 of 2 human approvals at aaaaaaa (high risk)'],
      ['success', 'PR #5: 2 of 2 human approvals at aaaaaaa (high risk)'],
    ]);
  });

  it('counts a pull request at the commit the server never saw as not passed', async () => {
    trivial();
    github.pullsAt = (sha) => [7, 9].map((number) => ({ number, state: 'open', head: { sha } }));
    await refresh(enforcing(), { current });
    expect(posted('briareus/code-review').at(-1)).toMatchObject({
      state: 'pending',
      description: 'PR #9: not reviewed at this commit yet',
    });
    expect(posted('briareus/approvals').at(-1)).toMatchObject({
      state: 'pending',
      description: 'PR #9: no code review of this commit yet, so its approvals are not known',
    });
  });

  it.each([false, true])('protects a default-branch head when its sibling is stored (%s)', async (known) => {
    trivial();
    if (known) {
      fivePending();
      store.siblings.review[0].state = 'pending';
    }
    const sibling = known ? 5 : 9;
    // On the default branch GitHub's commit endpoint lists only the merged PR.
    github.pullsAt = () => [{ number: 1, state: 'closed', merged_at: '2026-11-01', head: { sha: head } }];
    github.openPulls = [7, sibling].map((number) => ({ number, state: 'open', head: { sha: head } }));
    await refresh(enforcing(), { current });
    expect(posted()).toHaveLength(2);
    expect(posted().map((s) => s.state)).toEqual(['pending', 'pending']);
    expect(posted().every((s) => s.description.startsWith(`PR #${sibling}:`))).toBe(true);
    expect(asked('/pulls?state=open')).toHaveLength(2);
  });

  it('paginates the default-branch fallback and excludes closed or different heads', async () => {
    github.pullsAt = () => [];
    github.openPulls = [
      ...Array.from({ length: 100 }, (_, i) => ({ number: i + 100, state: 'open', head: { sha: next } })),
      { number: 7, state: 'open', head: { sha: head } },
      { number: 9, state: 'open', head: { sha: head } },
      { number: 5, state: 'closed', head: { sha: head } },
    ];
    expect(await revision.pullsAtHead(cfg, repo, head, { prNumber: 7 })).toEqual([7, 9]);
    expect(asked('/pulls?state=open')).toHaveLength(2);
  });

  it('withholds success when the default-branch fallback cannot be read', async () => {
    trivial();
    github.pullsAt = () => [];
    github.failing.openPulls = 503;
    await refresh(enforcing(), { current });
    expect(posted()).toEqual([]);
    expect(store.row.publishError).toContain('success');
    expect(store.readiness.publishError).toContain('success');
  });

  it('leaves out pull requests that closed or merely contain the commit', async () => {
    trivial();
    // A row is still stored for pull request 5, which closed since.
    fivePending();
    github.pullsAt = (sha) => [
      { number: 5, state: 'closed', head: { sha } },
      { number: 7, state: 'open', head: { sha } },
      // Stacked on top: the commit is in it, its head is another.
      { number: 12, state: 'open', head: { sha: next } },
    ];
    await refresh(enforcing(), { current });
    expect(posted().map((s) => [s.context, s.state, s.description])).toEqual([
      ['briareus/code-review', 'success', 'Review passed at aaaaaaa: no findings'],
      ['briareus/approvals', 'success', 'No human approval required at aaaaaaa: low risk'],
    ]);
  });

  it('writes no success while GitHub cannot say which pull requests are at the commit', async () => {
    trivial();
    github.failing.siblings = 502;
    const project = enforcing();
    await refresh(project, { current });
    expect(posted()).toEqual([]);
    for (const row of [store.row, store.readiness]) {
      expect(row).toMatchObject({ statusState: 'success', publishedSha: null, publishAttempts: 1 });
      expect(row.publishError).toMatch(
        /other pull requests at aaaaaaa could not be read from GitHub \(GitHub answered 502.*so `success` was not written/,
      );
      expect(row.publishRetryAt).toBeTruthy();
    }
    expect((await enforcement.readReviewOutcome(project, 7)).status.published).toBe(false);
    // Tried again like any write that failed, and written once GitHub answers.
    github.failing = {};
    await sweep(project, Date.parse(store.row.publishRetryAt) + 1);
    expect(posted().map((s) => [s.context, s.state])).toEqual([
      ['briareus/code-review', 'success'],
      ['briareus/approvals', 'success'],
    ]);
  });

  it('still writes a status that does not pass when the others cannot be read', async () => {
    reviewed();
    github.failing.siblings = 502;
    await refresh(enforcing(), { current: { headSha: head, baseRef: 'main' } });
    // High risk, nobody approved: restrictive whatever the other pull requests say.
    expect(posted('briareus/approvals')).toEqual([
      expect.objectContaining({
        state: 'pending',
        description: '0 of 2 human approvals at aaaaaaa (high risk)',
      }),
    ]);
    // The review's success is held back.
    expect(posted('briareus/code-review')).toEqual([]);
  });

  it('asks nothing about other pull requests for a project that publishes nothing', async () => {
    trivial();
    github.pullsAt = both;
    await refresh(withPolicy(), { current });
    expect(asked('/commits/')).toEqual([]);
    expect(posted()).toEqual([]);
  });

  it('has the pull requests at a commit look again when one comes to it, leaves it or closes', async () => {
    reviewed();
    const project = enforcing();
    await refresh(project, { current: { headSha: head, baseRef: 'main' } });
    store.owedAtHead = [];
    // A second pull request is opened from the same branch.
    await enforcement.notePullAtCommit(project, { number: 9, headSha: head, state: 'open' });
    expect(store.owedAtHead).toEqual([[head, 9]]);
    expect(store.row.publishOwedAt).toBeTruthy();
    expect(store.readiness.publishOwedAt).toBeTruthy();
    // It is pushed to: the commit it left and the one it came to.
    store.owedAtHead = [];
    await enforcement.notePullAtCommit(project, { number: 9, headSha: next, before: head, state: 'open' });
    expect(store.owedAtHead).toEqual([
      [next, 9],
      [head, 9],
    ]);
    // Nothing for a project that publishes no status.
    store.owedAtHead = [];
    await enforcement.notePullAtCommit(withPolicy(), { number: 9, headSha: head, state: 'open' });
    expect(store.owedAtHead).toEqual([]);
  });
});

describe('the list of pull requests waiting on people', () => {
  it('drops one that closed, and takes its mark off so it cannot crowd the list', async () => {
    reviewed();
    const project = withPolicy();
    await refresh(project, { current: { headSha: head, baseRef: 'main' } });
    expect(store.readiness.waitingSince).toBeTruthy();
    // Whether it is open cannot be told: it stays.
    const unknown = async () => {
      throw new Error('GitHub answered 502');
    };
    expect(await enforcement.approvalsWaiting({ getProject: () => project, isOpen: unknown })).toHaveLength(
      1,
    );
    expect(store.readiness.waitingSince).toBeTruthy();
    expect(
      await enforcement.approvalsWaiting({ getProject: () => project, isOpen: async () => false }),
    ).toEqual([]);
    expect(store.readiness.waitingSince).toBeNull();
  });

  it('drops one whose project asks for nothing any more', async () => {
    reviewed();
    await refresh(withPolicy(), { current: { headSha: head, baseRef: 'main' } });
    expect(await enforcement.approvalsWaiting({ getProject: () => plain })).toEqual([]);
    expect(store.readiness.waitingSince).toBeNull();
  });

  it('is told at once when the pull request closes', async () => {
    reviewed();
    const project = withPolicy();
    await refresh(project, { current: { headSha: head, baseRef: 'main' } });
    await enforcement.notePullAtCommit(project, { number: 7, headSha: head, state: 'closed' });
    expect(store.readiness.waitingSince).toBeNull();
    expect(await enforcement.approvalsWaiting({ getProject: () => project })).toEqual([]);
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

  it('checks MEMBER push access and refreshes it after access is revoked', async () => {
    reviewed();
    const project = withPolicy({ acceptGithubApprovals: true });
    github.reviews = [
      review(1, 'read-member', 'APPROVED', { author_association: 'MEMBER' }),
      review(2, 'write-member', 'APPROVED', { author_association: 'MEMBER' }),
    ];
    github.permissions['write-member'] = { permission: 'write' };
    let result = await refresh(project);
    expect(result.approvals.approvals.map((a) => [a.by.name, a.counted])).toEqual([
      ['read-member', false],
      ['write-member', true],
    ]);
    github.permissions['write-member'] = { permission: 'read' };
    result = await refresh(project);
    expect(result.approvals.valid).toBe(0);
  });

  it('counts no GitHub approvals when MEMBER permission cannot be verified', async () => {
    reviewed();
    github.reviews = [review(1, 'member', 'APPROVED', { author_association: 'MEMBER' })];
    const fetch = globalThis.fetch;
    vi.stubGlobal(
      'fetch',
      vi.fn((url, init) => (url.includes('/permission') ? Promise.resolve(answer(503)) : fetch(url, init))),
    );
    const result = await refresh(withPolicy({ acceptGithubApprovals: true }));
    expect(result.approvals.valid).toBe(0);
    expect(store.risk).toMatchObject({ reviewsSyncedAt: null, attempts: 1 });
    expect(store.risk.retryAt).toBeTruthy();
  });

  it('computes only once when refreshing GitHub reviews without a supplied revision', async () => {
    reviewed();
    github.reviews = [review(1, 'octo-reviewer')];
    const result = await refresh(withPolicy({ acceptGithubApprovals: true }));
    const { refreshCodeReviewOutcome } = await import('../lib/db.js');
    expect(refreshCodeReviewOutcome).toHaveBeenCalledTimes(1);
    expect(asked('/reviews?')).toHaveLength(1);
    expect(result.approvals.valid).toBe(1);
  });

  it('clears reviews-only retries once GitHub approvals are disabled', async () => {
    reviewed();
    const project = enforcing({ acceptGithubApprovals: true });
    github.failing.reviews = 502;
    await refresh(project, { current: { headSha: head, baseRef: 'main' } });
    const due = Date.parse(store.risk.retryAt) + 1;
    expect(store.risk).toMatchObject({ attempts: 1 });
    const disabled = enforcing({ acceptGithubApprovals: false });
    const reads = requests.length;
    await revision.observeRevision(disabled, 7, { headSha: head, baseRef: 'main' }, { cfg, now: () => due });
    expect(requests).toHaveLength(reads);
    expect(store.risk).toMatchObject({ attempts: 0, retryAt: null, error: null });
    const { saveCodeReviewRisk } = await import('../lib/db.js');
    saveCodeReviewRisk.mockClear();
    await revision.observeRevision(
      disabled,
      7,
      { headSha: head, baseRef: 'main' },
      { cfg, now: () => due + 60000 },
    );
    expect(saveCodeReviewRisk).not.toHaveBeenCalled();
    expect(await sweep(disabled, due + 120000)).toEqual([]);
  });

  it.each(['short file list', 'failed files read'])(
    'counts synced approvals at high risk despite a %s',
    async (failure) => {
      reviewed();
      github.reviews = [review(1, 'octo-reviewer'), review(2, 'mona-reviewer')];
      github.files = changed('README.md');
      if (failure === 'short file list') github.pull.changed_files = 5;
      else github.failing.files = 502;
      const project = withPolicy({ acceptGithubApprovals: true });
      const given = await refresh(project, { current: { headSha: head, baseRef: 'main' } });
      expect(store.risk.error).toBeTruthy();
      expect(store.risk.reviewsSyncedAt).toBeTruthy();
      expect(given.approvals).toMatchObject({ tier: 'high', required: 2, valid: 2, result: 'satisfied' });
      // The files failure remains pending before its retry, independently of fresh reviews.
      expect((await refresh(project)).approvals).toMatchObject({ valid: 2, result: 'satisfied' });
    },
  );

  it('reads GitHub reviews once when current names only the head', async () => {
    reviewed();
    github.reviews = [review(1, 'octo-reviewer')];
    const project = withPolicy({ acceptGithubApprovals: true });
    await refresh(project, { current: { headSha: head } });
    expect(asked('/reviews?')).toHaveLength(1);
    await refresh(project, { current: { headSha: head } });
    expect(asked('/reviews?')).toHaveLength(2);
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
      accountsOf: () => [],
      linkedAccounts: () => [],
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
    enforcement.setApprovalDirectory({
      user: () => null,
      mayApprove: () => false,
      accountsOf: () => [],
      linkedAccounts: () => [],
    });
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
    // Unknown files raise risk; successfully synced reviews still count.
    expect(store.readiness.valid).toBe(1);
    await sweep(project, Date.parse(retryAt) + 1);
    expect(store.risk).toMatchObject({ complete: true, error: null, retryAt: null });
    expect(store.readiness).toMatchObject({ valid: 1 });
  });

  it('do not count while who wrote the head could not be read, however the retries end', async () => {
    reviewed();
    // The commits cannot be read; they would show octo-pair as a committer.
    github.failing.commits = 502;
    github.commits = [
      { sha: 'c'.repeat(40), author: { login: 'octo-author' }, committer: { login: 'octo-pair' } },
    ];
    github.reviews = [review(1, 'octo-pair'), review(2, 'mona-reviewer')];
    const project = withPolicy({ acceptGithubApprovals: true });
    let now = Date.parse('2026-11-10T12:00:00Z');
    const compute = (options = {}) =>
      refresh(project, { current: { headSha: head, baseRef: 'main' }, now: () => now, ...options });
    const first = await compute();
    expect(store.risk).toMatchObject({ complete: true, authors: null, attempts: 1 });
    expect(first.approvals.approvals.map((a) => a.reason)).toEqual([
      'authorship_unknown',
      'authorship_unknown',
    ]);
    for (let i = 0; i < 10 && store.risk.retryAt; i++) {
      now = Date.parse(store.risk.retryAt) + 1;
      await compute();
    }
    expect(store.risk).toMatchObject({ authors: null, attempts: revision.OBSERVE_ATTEMPTS, retryAt: null });
    // The reviews are read fine from here on. That settles nothing about the commits.
    now += 60_000;
    const given = await compute();
    expect(store.risk).toMatchObject({ authors: null, attempts: revision.OBSERVE_ATTEMPTS });
    expect(store.risk.error).toMatch(/commits/);
    expect(store.risk.reviewsSyncedAt).toBeTruthy();
    expect(given.approvals).toMatchObject({ valid: 0, result: 'pending' });
    expect(given.approvals.approvals.map((a) => a.counted)).toEqual([false, false]);
    // Once the commits can be read, the co-author's approval is recognised for what it is.
    github.failing = {};
    const known = await compute({ asked: true });
    expect(known.approvals.approvals.map((a) => [a.by.name, a.counted, a.reason])).toEqual([
      ['octo-pair', false, 'own_change'],
      ['mona-reviewer', true, null],
    ]);
  });

  it('do not have the files read again, or their assessment lost, for a retry the reviews alone owe', async () => {
    reviewed();
    github.files = changed('src/cart.js');
    github.reviews = [review(1, 'octo-reviewer')];
    const project = enforcing({ acceptGithubApprovals: true });
    await refresh(project, { current: { headSha: head, baseRef: 'main' } });
    expect(store.risk).toMatchObject({ complete: true, tier: 'low' });
    expect(posted('briareus/approvals').at(-1)).toMatchObject({ state: 'success' });
    github.failing.reviews = 502;
    await refresh(project);
    expect(store.risk).toMatchObject({ attempts: 1, complete: true, tier: 'low' });
    // The reviews answer again; the files would not, and are not asked.
    github.failing = { files: 502 };
    await sweep(project, Date.parse(store.risk.retryAt) + 1);
    expect(asked('/pulls/7/files')).toHaveLength(1);
    expect(store.risk).toMatchObject({
      complete: true,
      tier: 'low',
      error: null,
      attempts: 0,
      retryAt: null,
    });
    expect(store.row).toMatchObject({ outcome: 'passed', statusState: 'success' });
    expect(store.readiness).toMatchObject({ tier: 'low', statusState: 'success' });
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
    github.commits = [
      { sha: 'c'.repeat(40), author: { login: 'octo-author' }, committer: { login: 'octo-pair' } },
    ];
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
