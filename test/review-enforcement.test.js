import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The stage and outcome tables as lib/db.js keeps them, in memory, one pull request at
// a time. The SQL, its row lock included, runs against a real MySQL in
// test/code-review-outcomes.mysql.test.js; here the rules run against the same shapes.
// lib/github.js is the real one with `fetch` stubbed, so what is asserted is the
// request GitHub would get: its URL, its body and whose token it carries.
const store = vi.hoisted(() => ({
  row: null,
  review: null,
  stages: [],
  findings: [],
  decisions: [],
  count: null,
  rounds: [],
  at: 0,
  // Set by a test to make the next write of that kind fail, as a database that is down.
  failing: {},
  now: () => new Date(Date.UTC(2026, 10, 10, 12, 0, store.at++)).toISOString(),
  fail(what) {
    if (!store.failing[what]) return;
    const error = store.failing[what];
    if (store.failing[what].once) delete store.failing[what];
    throw new Error(error.message);
  },
  // What the row should carry is what it is recorded to carry.
  settled(row, { sha, state, description }) {
    return row.headSha === sha && row.statusState === state && row.statusDescription === description;
  },
  state(reviewId) {
    const wanted = reviewId ?? store.row?.codeReviewId ?? null;
    const review = !store.review || (wanted && store.review.id !== wanted) ? store.other : store.review;
    return {
      row: store.row ? { ...store.row } : null,
      review: review || null,
      stages: review === store.review ? store.stages : [],
      findings: review === store.review ? store.findings : [],
      decisions: store.decisions,
      count: store.count,
      rounds: store.rounds,
    };
  },
}));

vi.mock('../lib/db.js', () => ({
  readCodeReviewOutcomeState: vi.fn(async (_repo, _pr, { reviewId = null } = {}) => store.state(reviewId)),
  refreshCodeReviewOutcome: vi.fn(async (repo, prNumber, { reviewId = null }, compute) => {
    store.fail('refresh');
    store.row ||= {
      repo,
      prNumber,
      codeReviewId: null,
      headSha: null,
      baseRef: null,
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
      recomputeAt: null,
    };
    const state = store.state(reviewId);
    const { owed, ...next } = compute(state);
    // One transaction: the outcome, the debt it creates and the recomputation it settles.
    Object.assign(store.row, next, {
      codeReviewId: state.review?.id ?? null,
      computedAt: store.now(),
      recomputeAt: null,
      publishOwedAt: owed ? store.row.publishOwedAt || store.now() : null,
      // The security result is stored with the outcome; a read joins its policy.
      securityPolicy: next.security?.policy ?? null,
    });
    return { ...state, row: { ...store.row } };
  }),
  getCodeReviewOutcome: vi.fn(async () => (store.row ? { ...store.row } : null)),
  markCodeReviewOutcomeStale: vi.fn(async () => {
    store.fail('stale');
    if (store.row) store.row.recomputeAt ||= store.now();
  }),
  // A setting of the project changed: the rows of these pull requests owe a recomputation.
  markRepoCodeReviewOutcomesStale: vi.fn(async (_repo, prNumbers = null) => {
    if (!store.row || (prNumbers && !prNumbers.includes(store.row.prNumber))) return 0;
    store.row.recomputeAt ||= store.now();
    return 1;
  }),
  markCodeReviewStatusSending: vi.fn(async () => {
    store.row.publishedConfirmed = false;
  }),
  recordCodeReviewStatusPublished: vi.fn(async (_repo, _pr, status, { posted = true } = {}) => {
    store.fail('published');
    Object.assign(store.row, {
      publishedSha: status.sha,
      publishedState: status.state,
      publishedDescription: status.description,
      publishedConfirmed: true,
      publishedAt: posted ? store.now() : store.row.publishedAt || store.now(),
      publishError: null,
      publishErrorStatus: null,
      publishAttempts: 0,
      publishFailedAt: null,
      publishRetryAt: null,
      publishOwedAt: store.settled(store.row, status) ? null : store.row.publishOwedAt,
    });
  }),
  recordCodeReviewStatusFailed: vi.fn(async (_repo, _pr, { error, status = null, retryAt }) => {
    Object.assign(store.row, {
      publishError: error,
      publishErrorStatus: status,
      publishAttempts: store.row.publishAttempts + 1,
      publishFailedAt: store.now(),
      publishRetryAt: retryAt == null ? null : new Date(retryAt).toISOString(),
      publishOwedAt: retryAt == null ? null : store.row.publishOwedAt || store.now(),
    });
  }),
  dropCodeReviewStatusDebt: vi.fn(async () => {
    Object.assign(store.row, {
      publishError: null,
      publishErrorStatus: null,
      publishAttempts: 0,
      publishFailedAt: null,
      publishRetryAt: null,
      publishOwedAt: null,
      recomputeAt: null,
    });
  }),
  listFailedCodeReviewStatuses: vi.fn(async () => (store.row?.publishFailedAt ? [{ ...store.row }] : [])),
  listCodeReviewStatusesAtHead: vi.fn(async () => []),
  oweCodeReviewStatusesAtHead: vi.fn(async () => 0),
  listCodeReviewOutcomesDue: vi.fn(async ({ now }) => {
    const row = store.row;
    const due =
      row &&
      (row.recomputeAt ||
        (row.publishOwedAt && (!row.publishRetryAt || Date.parse(row.publishRetryAt) <= now)));
    return due ? [{ ...row }] : [];
  }),
  // What lib/review-rounds.js imports beside these; nothing here calls them.
  claimCodeReviewRound: vi.fn(),
  codeReviewDecisionsSince: vi.fn(async () => 0),
  getCodeReviewRounds: vi.fn(async () => ({ count: null, rounds: [] })),
  listCodeReviewDecisions: vi.fn(async () => []),
  listPullCodeReviews: vi.fn(async () => []),
  listRefusedCodeReviewRounds: vi.fn(async () => []),
}));

import {
  dropCodeReviewStatusDebt,
  markRepoCodeReviewOutcomesStale,
  recordCodeReviewStatusFailed,
  refreshCodeReviewOutcome,
} from '../lib/db.js';

const repo = 'acme/shop';
const head = 'a'.repeat(40);
const next = 'b'.repeat(40);
const cfg = { githubToken: 'server-token' };
const off = { repo, reviewRoundLimit: 3 };
const on = { ...off, enforceReviewOutcome: true };
const STATUS_URL = (sha) => `https://api.github.com/repos/${repo}/statuses/${sha}`;

const stagesAt = (sha, over = {}) =>
  ['discover', 'publish', 'verify', 'label'].map((stage) => ({
    codeReviewId: 5,
    stage,
    headSha: sha,
    status: 'completed',
    detail: null,
    startedAt: '2026-11-10T11:00:00.000Z',
    endedAt: '2026-11-10T11:05:00.000Z',
    ...(over[stage] || {}),
  }));
const finding = (over = {}) => ({
  id: 1,
  findingRef: 'ref-1',
  title: 'Lost update',
  reconciliation: 'new',
  commentId: 501,
  threadId: 'PRRT_1',
  shouldFix: 'optional',
  verification: 'confirmed',
  comments: 'Style only, lib/cart.js:44',
  ...over,
});
// A review of `sha` that ran to its end with every stage seen.
function reviewed(sha = head, over = {}) {
  store.review = { id: 5, status: 'completed', headSha: sha, baseRef: 'main', round: 1, ...over };
  store.stages = stagesAt(sha);
  store.findings = [];
}

// Each test gets its own copy of the modules: lib/github.js keeps rate-limit cooldowns
// and lib/review-enforcement.js its publication queue at module level.
let enforcement, github, requests, answers, carried;
const answer = (status, body = {}, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
// Every status write GitHub was sent, in order.
const posted = () =>
  requests
    .filter((r) => r.method === 'POST' && r.url.includes('/statuses/'))
    .map((r) => ({ sha: r.url.split('/').pop(), ...r.body }));
// Every time the commit's statuses were read back.
const readBack = () => requests.filter((r) => r.method === 'GET' && r.url.includes('/statuses'));
// GitHub takes a status write: the commit carries it from here, newest first.
const take = (sha, body) => carried.set(sha, [body, ...(carried.get(sha) || [])]);
// A write GitHub took and never answered: the connection dropped on the way back.
const lostAnswer = () => (url, init) => {
  take(url.split('/').pop(), JSON.parse(init.body));
  throw new TypeError('fetch failed');
};

beforeEach(async () => {
  Object.assign(store, {
    row: null,
    review: null,
    other: null,
    stages: [],
    findings: [],
    decisions: [],
    count: null,
    rounds: [],
    at: 0,
    failing: {},
  });
  vi.clearAllMocks();
  vi.resetModules();
  requests = [];
  // What GitHub answers to status writes, in order; once they run out every write is
  // accepted. A function answers for itself (and decides whether the write landed).
  answers = [];
  // The statuses each commit carries on GitHub, as its read answers them.
  carried = new Map();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url, init) => {
      // Which open pull requests are at the commit, asked before every status write: this
      // one alone here. What two that share a head get is in test/review-revision.test.js.
      if (
        init.method === 'GET' &&
        (/\/commits\/[0-9a-f]+\/pulls/.test(url) || url.includes('/pulls?state=open'))
      )
        return answer(200, []);
      requests.push({
        url,
        method: init.method,
        token: init.headers.Authorization.replace('Bearer ', ''),
        body: init.body ? JSON.parse(init.body) : null,
      });
      if (init.method === 'GET') {
        const sha = /\/commits\/([0-9a-f]+)\/statuses/.exec(url)?.[1];
        return sha ? answer(200, carried.get(sha) || []) : answer(404, {});
      }
      const next = answers.length ? answers.shift() : null;
      if (next instanceof Error) throw next;
      if (typeof next === 'function') return next(url, init);
      if (next) return next;
      take(url.split('/').pop(), JSON.parse(init.body));
      return answer(201, {});
    }),
  );
  enforcement = await import('../lib/review-enforcement.js');
  github = await import('../lib/github.js');
});
afterEach(() => vi.unstubAllGlobals());

const refresh = async (project, options = {}) => {
  const { outcome, published } = await enforcement.refreshReviewOutcome(project, 7, {
    cfg,
    retryDelayMs: 0,
    ...options,
  });
  return { outcome, published: await published };
};

describe('the stored outcome', () => {
  it('is computed and stored for a project that does not enforce it, and nothing goes to GitHub', async () => {
    reviewed();
    store.findings = [finding()];
    const { outcome, published } = await refresh(off);
    expect(outcome).toMatchObject({
      outcome: 'passed',
      reasons: [],
      stale: false,
      headSha: head,
      baseRef: 'main',
      reviewId: 5,
      execution: 'completed',
      enforced: false,
    });
    expect(outcome.stages.map((s) => [s.stage, s.status])).toEqual([
      ['discover', 'completed'],
      ['publish', 'completed'],
      ['verify', 'completed'],
      ['label', 'completed'],
    ]);
    expect(outcome.stages[0]).not.toHaveProperty('codeReviewId');
    // What the status would be is still said; that GitHub carries it is not.
    expect(outcome.status).toMatchObject({
      context: 'briareus/code-review',
      sha: head,
      state: 'success',
      description: 'Review passed at aaaaaaa: 1 optional, nothing to fix',
      published: false,
      publishedSha: null,
      error: null,
    });
    expect(published).toEqual({ published: false, skipped: 'not_enforced' });
    expect(fetch).not.toHaveBeenCalled();
    expect(store.row).toMatchObject({
      outcome: 'passed',
      stale: false,
      headSha: head,
      baseRef: 'main',
      statusState: 'success',
      publishedSha: null,
    });
  });

  it('reads the reviewed base and merge base from the round the review ran as', async () => {
    reviewed();
    store.rounds = [
      { round: 1, headSha: head, baseSha: 'c'.repeat(40), mergeBaseSha: 'd'.repeat(40) },
      { round: 2, headSha: next, baseSha: 'e'.repeat(40), mergeBaseSha: 'f'.repeat(40) },
    ];
    const { outcome } = await refresh(off);
    expect(outcome.reviewed).toEqual({
      headSha: head,
      baseRef: 'main',
      baseSha: 'c'.repeat(40),
      mergeBaseSha: 'd'.repeat(40),
      round: 1,
    });
  });

  it('is incomplete for a review stored before stages were recorded', async () => {
    reviewed();
    store.stages = [];
    store.findings = [finding()];
    const { outcome } = await refresh(off);
    expect(outcome.outcome).toBe('incomplete');
    expect(outcome.reasons.map((r) => r.code)).toEqual(['stages_not_recorded']);
    expect(outcome.status.state).toBe('error');
  });

  it('is pending for a pull request no review has covered', async () => {
    const { outcome } = await refresh(off);
    expect(outcome).toMatchObject({ outcome: 'pending', reviewId: null, reviewed: null, execution: null });
    expect(outcome.reasons.map((r) => r.code)).toEqual(['no_review']);
  });

  it('counts the decisions still standing on the pull request and the round limit', async () => {
    reviewed();
    store.decisions = [
      {
        findingRef: 'ref-owed',
        threadId: 'PRRT_owed',
        title: 'Leaks the token',
        verdict: 'fix',
        resolved: false,
        decidedAt: '2026-11-01T00:00:00.000Z',
      },
    ];
    store.count = { rounds: 3 };
    const { outcome } = await refresh(off);
    expect(outcome.outcome).toBe('changes_required');
    expect(outcome.reasons.map((r) => [r.code, r.effect])).toEqual([
      ['fix_owed', 'changes_required'],
      ['round_limit_reached', 'note'],
    ]);
    // The same pull request without a limit has nothing to note.
    expect((await refresh({ ...off, reviewRoundLimit: 0 })).outcome.reasons.map((r) => r.code)).toEqual([
      'fix_owed',
    ]);
  });

  it('does not pass a rerun or a later review on a dismissal an earlier one never proved', async () => {
    // Review one dismissed its finding on a likelihood and resolved the thread. The
    // verdict is the pull request's decision from then on, kept with how well it was
    // established, and that is all a rerun leaves: its findings are deleted.
    const decision = {
      findingRef: 'ref-1',
      threadId: 'PRRT_1',
      title: 'Lost update',
      verdict: 'dismiss',
      verification: 'plausible',
      rationale: 'Probably guarded upstream',
      source: 'review',
      resolved: true,
      decidedAt: '2026-11-10T11:00:00.000Z',
    };
    store.decisions = [decision];
    // The rerun on the same head raises nothing.
    reviewed();
    const rerun = await refresh(on);
    expect(rerun.outcome.outcome).toBe('incomplete');
    expect(rerun.outcome.reasons).toEqual([
      expect.objectContaining({
        code: 'earlier_finding_unverified',
        findingRef: 'ref-1',
        verdict: 'dismiss',
        missing: ['verification'],
      }),
    ]);
    expect(posted().at(-1)).toMatchObject({ sha: head, state: 'error' });
    // The next round, on the next head, raises the claim again and has it suppressed
    // against that decision: carrying an unproven dismissal over proves nothing.
    reviewed(next);
    store.findings = [
      finding({
        reconciliation: 'suppressed',
        shouldFix: 'dismiss',
        verification: null,
        threadId: null,
        commentId: null,
      }),
    ];
    const later = await refresh(on, { current: { headSha: next, baseRef: 'main' } });
    expect(later.outcome.outcome).toBe('incomplete');
    expect(later.outcome.reasons.map((r) => r.code)).toEqual(['prior_decision_unverified']);
    expect(posted().map((status) => status.state)).not.toContain('success');
    // Proven, by a person or a review: the same record passes, the duplicate counted
    // as decided earlier.
    store.decisions = [{ ...decision, verification: 'confirmed', rationale: 'lib/api.js:12 rejects it' }];
    const proven = await refresh(on);
    expect(proven.outcome).toMatchObject({ outcome: 'passed', reasons: [] });
    expect(posted().at(-1)).toEqual({
      sha: next,
      state: 'success',
      context: 'briareus/code-review',
      description: 'Review passed at bbbbbbb: 1 decided earlier, nothing to fix',
    });
    // A verdict read from GitHub's history carries no record of what it proved.
    store.decisions = [{ ...decision, source: 'github', verification: null }];
    expect((await refresh(on)).outcome.outcome).toBe('incomplete');
  });

  it('follows the head the server last saw, and goes stale when it is not the reviewed one', async () => {
    reviewed();
    expect((await refresh(off)).outcome.outcome).toBe('passed');
    const moved = await refresh(off, { current: { headSha: next, baseRef: 'main' } });
    expect(moved.outcome).toMatchObject({ outcome: 'pending', stale: true, headSha: next });
    expect(moved.outcome.reviewed.headSha).toBe(head);
    expect(store.row).toMatchObject({ headSha: next, outcome: 'pending', stale: true });
    // A later recomputation that read nothing from GitHub keeps the head it knows.
    expect((await refresh(off)).outcome).toMatchObject({ outcome: 'pending', stale: true, headSha: next });
    // And a retargeted pull request is stale on the same head.
    const retargeted = await refresh(off, { current: { headSha: head, baseRef: 'release' } });
    expect(retargeted.outcome).toMatchObject({ outcome: 'pending', stale: true });
    expect(retargeted.outcome.reasons[0].code).toBe('base_changed');
  });

  it('is computed from the review a discovery run names from then on', async () => {
    reviewed();
    store.other = { id: 4, status: 'completed', headSha: next, baseRef: 'main' };
    await refresh(off, { reviewId: 5 });
    expect(refreshCodeReviewOutcome.mock.calls[0][2]).toEqual({ reviewId: 5 });
    expect(store.row.codeReviewId).toBe(5);
    expect((await refresh(off)).outcome.reviewId).toBe(5);
  });

  it('answers a read computed now, against a head the caller just saw, without writing', async () => {
    reviewed();
    await refresh(on);
    const stored = { ...store.row };
    const read = await enforcement.readReviewOutcome(on, 7);
    expect(read).toMatchObject({ outcome: 'passed', enforced: true });
    expect(read.status).toMatchObject({ state: 'success', published: true, publishedSha: head });
    const live = await enforcement.readReviewOutcome(on, 7, { current: { headSha: next } });
    expect(live).toMatchObject({ outcome: 'pending', stale: true, headSha: next, baseRef: 'main' });
    // GitHub carries nothing from Briareus on that head, and the read says so.
    expect(live.status).toMatchObject({ sha: next, state: 'pending', published: false, publishedSha: head });
    expect(store.row).toEqual(stored);
    expect(posted()).toHaveLength(1);
    // A finding changed in the store shows at once, before anything recomputed it.
    store.findings = [finding({ shouldFix: 'fix' })];
    const changed = await enforcement.readReviewOutcome(on, 7);
    expect(changed.outcome).toBe('changes_required');
    expect(changed.status).toMatchObject({ state: 'failure', published: false, publishedState: 'success' });
  });
});

describe('the reading taken before the label step', () => {
  it('is this review’s outcome without that step, while it still runs', async () => {
    reviewed(head, { status: 'running' });
    store.stages = stagesAt(head, { label: { status: 'running' } });
    store.findings = [finding()];
    const before = await enforcement.provisionalReviewOutcome(on, 7, { reviewId: 5 });
    expect(before).toMatchObject({ outcome: 'passed', reasons: [] });
    store.findings = [finding({ shouldFix: 'dismiss', verification: 'plausible' })];
    const unproven = await enforcement.provisionalReviewOutcome(on, 7, { reviewId: 5 });
    expect(unproven.outcome).toBe('incomplete');
    expect(unproven.reasons.map((r) => r.code)).toEqual(['dismissal_unproven']);
    const moved = await enforcement.provisionalReviewOutcome(on, 7, {
      reviewId: 5,
      current: { headSha: next },
    });
    expect(moved).toMatchObject({ outcome: 'pending', stale: true });
    // Nothing is stored or published by asking.
    expect(refreshCodeReviewOutcome).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('never borrows another review’s evidence when this one kept no record', async () => {
    reviewed();
    for (const reviewId of [null, 9]) {
      const result = await enforcement.provisionalReviewOutcome(on, 7, { reviewId });
      expect(result.outcome).toBe('pending');
      expect(result.reasons.map((r) => r.code)).toEqual(['no_review']);
    }
  });
});

describe('the commit status', () => {
  it('is written by the server on the reviewed head, mapped from the outcome', async () => {
    reviewed();
    store.findings = [finding()];
    const { outcome, published } = await refresh(on);
    expect(published).toEqual({ published: true });
    expect(requests).toEqual([
      {
        url: STATUS_URL(head),
        method: 'POST',
        token: 'server-token',
        body: {
          state: 'success',
          context: 'briareus/code-review',
          description: 'Review passed at aaaaaaa: 1 optional, nothing to fix',
        },
      },
    ]);
    // No target URL: the server has no page to link.
    expect(requests[0].body).not.toHaveProperty('target_url');
    expect(outcome.enforced).toBe(true);
    expect(store.row).toMatchObject({
      publishedSha: head,
      publishedState: 'success',
      publishedDescription: 'Review passed at aaaaaaa: 1 optional, nothing to fix',
      publishFailedAt: null,
    });
    expect((await enforcement.readReviewOutcome(on, 7)).status).toMatchObject({
      published: true,
      publishedSha: head,
      publishedState: 'success',
    });
  });

  it.each([
    ['changes_required', 'failure', () => (store.findings = [finding({ shouldFix: 'fix' })])],
    ['incomplete', 'error', () => (store.findings = [finding({ shouldFix: null })])],
    ['pending', 'pending', () => (store.review.status = 'running')],
  ])('publishes %s as %s', async (outcome, state, arrange) => {
    reviewed();
    arrange();
    expect((await refresh(on)).outcome.outcome).toBe(outcome);
    expect(posted()).toEqual([expect.objectContaining({ sha: head, state })]);
  });

  it('goes out under the server’s token when a client’s request led to it', async () => {
    reviewed();
    await github.asGithubUser('a-users-own-token', () => refresh(on));
    expect(requests.map((r) => r.token)).toEqual(['server-token']);
  });

  it('is not posted again while GitHub carries exactly that status for that head', async () => {
    reviewed();
    await refresh(on);
    expect((await refresh(on)).published).toEqual({ published: true, skipped: 'unchanged' });
    expect(await enforcement.publishReviewStatus(on, 7, { cfg })).toEqual({
      published: true,
      skipped: 'unchanged',
    });
    expect(posted()).toHaveLength(1);
    // A different description is a different status, and is posted.
    store.findings = [finding()];
    await refresh(on);
    expect(posted().map((s) => s.description)).toEqual([
      'Review passed at aaaaaaa: no findings',
      'Review passed at aaaaaaa: 1 optional, nothing to fix',
    ]);
  });

  it('posts pending on a head when its review starts, before any result', async () => {
    // An earlier review left a success on this very head; the review runs again.
    reviewed();
    await refresh(on);
    store.review.status = 'running';
    store.stages = stagesAt(head, { discover: { status: 'running' }, publish: { status: 'pending' } });
    await refresh(on, { reviewId: 5 });
    store.review.status = 'completed';
    store.stages = stagesAt(head);
    store.findings = [finding({ shouldFix: 'fix' })];
    await refresh(on);
    expect(posted().map((s) => [s.sha.slice(0, 1), s.state])).toEqual([
      ['a', 'success'],
      ['a', 'pending'],
      ['a', 'failure'],
    ]);
  });

  it('posts pending on a new head, and leaves the old head’s status alone', async () => {
    reviewed();
    await refresh(on);
    const moved = await refresh(on, { current: { headSha: next, baseRef: 'main' } });
    expect(moved.outcome).toMatchObject({ outcome: 'pending', stale: true });
    // The success stays on the old head, where it is harmless: GitHub wants the status
    // on the head the pull request has now, and that one says pending.
    expect(posted()).toEqual([
      expect.objectContaining({ sha: head, state: 'success' }),
      { sha: next, state: 'pending', context: 'briareus/code-review', description: expect.any(String) },
    ]);
    expect(posted()[1].description).toBe('Waiting for a review of bbbbbbb');
    expect(store.row).toMatchObject({ publishedSha: next, publishedState: 'pending' });
  });

  it('says a person must continue on a new head once the round limit is reached', async () => {
    reviewed();
    store.count = { rounds: 3 };
    await refresh(on);
    const refused = await refresh(on, { current: { headSha: next, baseRef: 'main' } });
    expect(refused.outcome.outcome).toBe('incomplete');
    expect(refused.outcome.reasons.map((r) => r.code)).toEqual(['head_moved', 'round_limit_reached']);
    expect(posted().at(-1)).toMatchObject({
      sha: next,
      state: 'error',
      description: 'Not reviewed at bbbbbbb; the review limit is reached and a person must continue',
    });
  });

  it('tries a write that fails in passing again at once', async () => {
    reviewed();
    answers = [answer(502, { message: 'Bad gateway' }), new TypeError('fetch failed')];
    expect((await refresh(on)).published).toEqual({ published: true });
    expect(posted()).toHaveLength(3);
    expect(recordCodeReviewStatusFailed).not.toHaveBeenCalled();
    expect(store.row).toMatchObject({ publishedState: 'success', publishFailedAt: null });
  });

  it('records a passing status GitHub did not take as not published, and retries it later', async () => {
    reviewed(head, { status: 'running' });
    await refresh(on, { reviewId: 5 });
    store.review.status = 'completed';
    answers = [answer(500), answer(500), answer(500)];
    const { outcome, published } = await enforcement.refreshReviewOutcome(on, 7, { cfg, retryDelayMs: 0 });
    expect(await published).toEqual({ published: false, error: 'GitHub answered 500' });
    expect(outcome.outcome).toBe('passed');
    expect(posted()).toHaveLength(4);
    // The outcome is passed and stored as such; what GitHub carries is still the
    // pending this review started with, and the record says exactly that.
    expect(store.row).toMatchObject({
      outcome: 'passed',
      statusState: 'success',
      publishedState: 'pending',
      publishError: 'GitHub answered 500',
      publishErrorStatus: 500,
      publishAttempts: 1,
    });
    const read = await enforcement.readReviewOutcome(on, 7);
    expect(read).toMatchObject({ outcome: 'passed', enforced: true });
    expect(read.status).toMatchObject({
      state: 'success',
      published: false,
      publishedState: 'pending',
      error: 'GitHub answered 500',
      errorStatus: 500,
      attempts: 1,
    });
    expect(read.status.failedAt).toBeTruthy();
    // Not due yet: the timer leaves it. Due: it is sent again and lands.
    const due = Date.parse(store.row.publishRetryAt);
    expect(await enforcement.retryReviewStatuses({ getProject: () => on, cfg, now: () => due - 1 })).toEqual(
      [],
    );
    expect(posted()).toHaveLength(4);
    expect(await enforcement.retryReviewStatuses({ getProject: () => on, cfg, now: () => due })).toEqual([
      { repo, prNumber: 7, published: true },
    ]);
    expect(posted().at(-1)).toMatchObject({ sha: head, state: 'success' });
    expect(store.row).toMatchObject({ publishedState: 'success', publishError: null, publishAttempts: 0 });
    expect((await enforcement.readReviewOutcome(on, 7)).status).toMatchObject({
      published: true,
      error: null,
    });
  });

  it('backs off between later attempts, a minute doubling up to an hour', () => {
    expect([0, 1, 2, 5, 6, 40].map(enforcement.statusRetryDelay)).toEqual([
      60_000, 120_000, 240_000, 1_920_000, 3_600_000, 3_600_000,
    ]);
  });

  it('counts the attempts of one failure and waits longer each time', async () => {
    reviewed();
    const at = Date.UTC(2026, 10, 10, 13);
    answers = Array.from({ length: 6 }, () => answer(503));
    await enforcement.refreshReviewOutcome(on, 7, { cfg, retryDelayMs: 0 }).then((r) => r.published);
    expect(store.row.publishAttempts).toBe(1);
    await enforcement.publishReviewStatus(on, 7, { cfg, retryDelayMs: 0, now: () => at });
    expect(store.row.publishAttempts).toBe(2);
    expect(Date.parse(store.row.publishRetryAt)).toBe(at + 120_000);
    // The same status sent again after an answer that was lost is harmless: it lands.
    expect(await enforcement.publishReviewStatus(on, 7, { cfg })).toEqual({ published: true });
  });

  it.each([
    [403, 'Resource not accessible by personal access token', 'may not write commit statuses'],
    [404, 'Not Found', 'cannot see this repository or may not write commit statuses'],
    [401, 'Bad credentials', 'was not accepted'],
  ])('surfaces a token GitHub refuses with %i, without hammering it', async (status, said, hint) => {
    reviewed();
    answers = [answer(status, { message: said })];
    const { outcome, published } = await refresh(on);
    // One attempt: a refusal does not pass by trying again at once.
    expect(posted()).toHaveLength(1);
    expect(published.published).toBe(false);
    expect(published.error).toContain(`GitHub answered ${status} (${said})`);
    expect(published.error).toContain(hint);
    expect(outcome.outcome).toBe('passed');
    const read = await enforcement.readReviewOutcome(on, 7);
    // Passed, enforced by the project, and not on GitHub: never reported as published.
    expect(read).toMatchObject({ outcome: 'passed', enforced: true });
    expect(read.status).toMatchObject({ published: false, publishedSha: null, errorStatus: status });
    expect(read.status.error).toContain(hint);
    expect(await enforcement.reviewStatusFailures({ getProject: () => on })).toEqual([
      expect.objectContaining({
        repo,
        prNumber: 7,
        headSha: head,
        outcome: 'passed',
        state: 'success',
        publishedState: null,
        errorStatus: status,
        attempts: 1,
      }),
    ]);
  });

  it('waits out a rate limit instead of retrying into it', async () => {
    reviewed();
    answers = [answer(403, { message: 'secondary rate limit' }, { 'retry-after': '120' })];
    const before = Date.now();
    const { published } = await refresh(on);
    expect(published.published).toBe(false);
    expect(published.error).toContain('rate limit');
    expect(posted()).toHaveLength(1);
    expect(Date.parse(store.row.publishRetryAt)).toBeGreaterThanOrEqual(before + 120_000);
    expect(store.row.publishErrorStatus).toBe(429);
  });

  it('fails without a token, recorded like any other failure', async () => {
    reviewed();
    const { published } = await enforcement.refreshReviewOutcome(on, 7, { cfg: {}, retryDelayMs: 0 });
    expect(await published).toEqual({ published: false, error: 'No GITHUB_TOKEN is configured' });
    expect(fetch).not.toHaveBeenCalled();
    expect(store.row.publishError).toBe('No GITHUB_TOKEN is configured');
  });

  it('sends the statuses of one pull request in the order their outcomes were stored', async () => {
    // Two outcomes stored close together, and GitHub slow to answer the first write:
    // sent side by side, the older `success` could land after the newer `failure`.
    reviewed();
    let release;
    answers = [
      () =>
        new Promise((resolve) => {
          release = () => resolve(answer(201));
        }),
    ];
    const first = await enforcement.refreshReviewOutcome(on, 7, { cfg, retryDelayMs: 0 });
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    store.findings = [finding({ shouldFix: 'fix' })];
    const second = await enforcement.refreshReviewOutcome(on, 7, { cfg, retryDelayMs: 0 });
    // The second waits its turn: only the first write is in flight.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(posted().map((s) => s.state)).toEqual(['success']);
    release();
    expect(await first.published).toEqual({ published: true });
    expect(await second.published).toEqual({ published: true });
    expect(posted().map((s) => s.state)).toEqual(['success', 'failure']);
    expect(store.row).toMatchObject({ outcome: 'changes_required', publishedState: 'failure' });
  });

  it('owes GitHub nothing once the project stops enforcing', async () => {
    reviewed();
    answers = [answer(403, { message: 'Forbidden' })];
    await refresh(on);
    expect(store.row.publishFailedAt).toBeTruthy();
    expect(await enforcement.reviewStatusFailures({ getProject: () => off })).toEqual([]);
    const due = Date.parse(store.row.publishRetryAt);
    expect(await enforcement.retryReviewStatuses({ getProject: () => off, cfg, now: () => due })).toEqual([
      { repo, prNumber: 7, published: false, skipped: 'not_enforced' },
    ]);
    expect(dropCodeReviewStatusDebt).toHaveBeenCalledWith(repo, 7);
    expect(store.row).toMatchObject({ publishFailedAt: null, publishOwedAt: null });
    expect(posted()).toHaveLength(1);
    // And a later outcome of that project creates no debt at all.
    await refresh(off);
    expect(store.row.publishOwedAt).toBeNull();
  });

  it('lists only failures of open pull requests of enforcing projects as waiting on a person', async () => {
    reviewed();
    answers = [answer(403, { message: 'Forbidden' })];
    await refresh(on);
    const list = (deps) => enforcement.reviewStatusFailures({ getProject: () => on, ...deps });
    expect(await list({ isOpen: async () => false })).toEqual([]);
    expect(await list({ isOpen: async () => true })).toHaveLength(1);
    // A board that cannot say keeps the item listed.
    expect(
      await list({
        isOpen: async () => {
          throw new Error('board unreadable');
        },
      }),
    ).toHaveLength(1);
    expect(await enforcement.reviewStatusFailures({ getProject: () => null })).toEqual([]);
  });
});

describe('what GitHub is known to carry', () => {
  it('is unknown from the moment a write is sent until its answer says it was taken', async () => {
    reviewed();
    store.findings = [finding({ shouldFix: 'fix' })];
    await refresh(on);
    expect(store.row).toMatchObject({ publishedState: 'failure', publishedConfirmed: true });
    // The fix is waived: `success` is sent and GitHub takes it, but every answer is lost.
    store.findings = [finding()];
    answers = [lostAnswer(), lostAnswer(), lostAnswer()];
    const lost = await refresh(on);
    expect(lost.published).toEqual({ published: false, error: 'fetch failed' });
    expect(carried.get(head)[0].state).toBe('success');
    // The record still names the last status GitHub confirmed, and says it is no longer
    // known to be what the commit carries.
    expect(store.row).toMatchObject({
      statusState: 'success',
      publishedState: 'failure',
      publishedConfirmed: false,
      publishError: 'fetch failed',
    });
    expect(lost.outcome.status.published).toBe(false);
    // The verdict goes back to Fix before any retry: what should be there now equals
    // what was last confirmed, while GitHub shows `success`.
    store.findings = [finding({ shouldFix: 'fix' })];
    const back = await refresh(on);
    // Not trusted, so not skipped: the write goes out and GitHub carries `failure` again.
    expect(back.published).toEqual({ published: true });
    expect(posted().map((status) => status.state)).toEqual([
      'failure',
      'success',
      'success',
      'success',
      'failure',
    ]);
    expect(carried.get(head)[0].state).toBe('failure');
    expect(store.row).toMatchObject({
      outcome: 'changes_required',
      publishedState: 'failure',
      publishedConfirmed: true,
      publishFailedAt: null,
      publishOwedAt: null,
    });
    expect((await enforcement.readReviewOutcome(on, 7)).status).toMatchObject({
      state: 'failure',
      published: true,
      publishedConfirmed: true,
    });
  });

  it('is not reported as published while a write is unanswered, even for the same status', async () => {
    reviewed();
    await refresh(on);
    // Marked by the store as sent and not yet answered, as a server stopping mid-write leaves it.
    store.row.publishedConfirmed = false;
    const read = await enforcement.readReviewOutcome(on, 7);
    expect(read.status).toMatchObject({ state: 'success', published: false, publishedState: 'success' });
    // The next publication posts rather than conclude anything from the record.
    expect(await enforcement.publishReviewStatus(on, 7, { cfg })).toEqual({ published: true });
    expect(posted()).toHaveLength(2);
  });

  it('reads the commit back before concluding that it already carries the status', async () => {
    reviewed();
    store.findings = [finding({ shouldFix: 'fix' })];
    await refresh(on);
    expect(readBack()).toHaveLength(0);
    // Nothing changed: one read of the commit's statuses confirms it, and nothing is posted.
    expect((await refresh(on)).published).toEqual({ published: true, skipped: 'unchanged' });
    expect(readBack().map((r) => [r.url, r.token])).toEqual([
      [`https://api.github.com/repos/${repo}/commits/${head}/statuses?per_page=100`, 'server-token'],
    ]);
    expect(posted()).toHaveLength(1);
    // Something else wrote `success` under this context since (an agent holding a token
    // that may write statuses, say). The record says `failure` is there; GitHub does not.
    take(head, { state: 'success', context: 'briareus/code-review', description: 'Looks good to me' });
    expect((await refresh(on)).published).toEqual({ published: true });
    expect(posted().at(-1)).toMatchObject({ sha: head, state: 'failure' });
    expect(carried.get(head)[0].state).toBe('failure');
    // Another context on the commit is nobody's business here.
    take(head, { state: 'failure', context: 'ci/build', description: 'Tests failed' });
    expect((await refresh(on)).published).toEqual({ published: true, skipped: 'unchanged' });
    // A read that fails proves nothing either way, so the status is sent again.
    const github = fetch.getMockImplementation();
    fetch.mockImplementation(async (url, init) =>
      init.method === 'GET' && url.includes('/statuses') ? answer(502, {}) : github(url, init),
    );
    expect((await refresh(on)).published).toEqual({ published: true });
    expect(posted()).toHaveLength(3);
  });
});

describe('what is owed and swept', () => {
  const sweep = (deps = {}) =>
    enforcement.retryReviewStatuses({ getProject: () => on, cfg, retryDelayMs: 0, ...deps });

  it('posts an outcome that was stored and never sent, with no failure on record', async () => {
    reviewed();
    store.findings = [finding({ shouldFix: 'fix' })];
    await refresh(on);
    // A verdict changes and the outcome is stored, and the server stops before the
    // write goes out: GitHub is left on `failure`... or, the other way round, on `success`.
    store.findings = [finding()];
    await refreshCodeReviewOutcome(repo, 7, {}, () => ({
      outcome: 'passed',
      stale: false,
      reasons: [],
      headSha: head,
      baseRef: 'main',
      statusState: 'success',
      statusDescription: 'Review passed at aaaaaaa: 1 optional, nothing to fix',
      owed: true,
    }));
    expect(store.row).toMatchObject({ publishedState: 'failure', publishFailedAt: null });
    expect(store.row.publishOwedAt).toBeTruthy();
    // Nothing failed, so nothing is listed as failing; the debt alone is what the sweep finds.
    expect(await enforcement.reviewStatusFailures({ getProject: () => on })).toEqual([]);
    expect(await sweep()).toEqual([{ repo, prNumber: 7, published: true }]);
    expect(posted().at(-1)).toMatchObject({ sha: head, state: 'success' });
    expect(store.row).toMatchObject({
      publishedState: 'success',
      publishedConfirmed: true,
      publishOwedAt: null,
    });
    // Paid: the next sweep has nothing to do.
    expect(await sweep()).toEqual([]);
    expect(posted()).toHaveLength(2);
  });

  it('creates the debt with the outcome, and settles it only for the status that outcome owes', async () => {
    reviewed();
    const { published } = await enforcement.refreshReviewOutcome(on, 7, { cfg, retryDelayMs: 0 });
    // Owed from the transaction that stored the outcome: before anything was sent.
    expect((await refreshCodeReviewOutcome.mock.results[0].value).row.publishOwedAt).toBeTruthy();
    await published;
    expect(store.row.publishOwedAt).toBeNull();
    // A write that lands for an older outcome leaves the newer one's debt standing.
    let release;
    answers = [
      () =>
        new Promise((resolve) => {
          release = () => {
            take(head, { state: 'pending', context: 'briareus/code-review' });
            resolve(answer(201));
          };
        }),
    ];
    store.review.status = 'running';
    const slow = await enforcement.refreshReviewOutcome(on, 7, { cfg, retryDelayMs: 0 });
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    // Stored meanwhile by something that then stopped before publishing it.
    Object.assign(store.row, { statusState: 'error', statusDescription: 'Review incomplete' });
    release();
    await slow.published;
    expect(store.row).toMatchObject({ publishedState: 'pending', statusState: 'error' });
    expect(store.row.publishOwedAt).toBeTruthy();
    expect(await sweep()).toEqual([{ repo, prNumber: 7, published: true }]);
    expect(posted().at(-1)).toMatchObject({ state: 'error' });
  });

  it('computes again an outcome whose recomputation failed, and publishes what it then is', async () => {
    reviewed();
    await refresh(on);
    expect(carried.get(head)[0].state).toBe('success');
    // A client turns a finding into a required fix; the write lands, the recomputation
    // that should follow does not.
    store.findings = [finding({ shouldFix: 'fix' })];
    store.failing.refresh = { message: 'Deadlock found when trying to get lock', once: true };
    await expect(refresh(on)).rejects.toThrow('Deadlock found');
    // Owed on the row, so it survives a restart, and GitHub is not left on `success`.
    expect(store.row.recomputeAt).toBeTruthy();
    expect(store.row).toMatchObject({ outcome: 'passed', publishedState: 'success' });
    expect(await sweep()).toEqual([{ repo, prNumber: 7, published: true }]);
    expect(store.row).toMatchObject({
      outcome: 'changes_required',
      publishedState: 'failure',
      recomputeAt: null,
    });
    expect(carried.get(head)[0].state).toBe('failure');
    expect(await sweep()).toEqual([]);
  });

  it('keeps that debt in memory when the store cannot even record it', async () => {
    reviewed();
    await refresh(on);
    store.findings = [finding({ shouldFix: 'fix' })];
    store.failing.refresh = { message: 'Connection lost', once: true };
    store.failing.stale = { message: 'Connection lost', once: true };
    await expect(refresh(on)).rejects.toThrow('Connection lost');
    expect(store.row.recomputeAt).toBeNull();
    // The database is back by the next sweep.
    expect(await sweep()).toEqual([{ repo, prNumber: 7, published: true }]);
    expect(store.row).toMatchObject({ outcome: 'changes_required', publishedState: 'failure' });
    expect(await sweep()).toEqual([]);
  });

  it('survives a row it cannot work and goes on, reporting it', async () => {
    reviewed();
    await refresh(on);
    store.row.recomputeAt = store.now();
    store.failing.refresh = { message: 'Connection lost', once: true };
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await sweep()).toEqual([{ repo, prNumber: 7, published: false, error: 'Connection lost' }]);
    expect(error).toHaveBeenCalledWith('Code review status for acme/shop#7: Connection lost');
    error.mockRestore();
    expect(await sweep()).toEqual([{ repo, prNumber: 7, published: true, skipped: 'unchanged' }]);
  });

  it('drops what a project that is gone owes, instead of keeping it first in line', async () => {
    reviewed();
    answers = [answer(403, { message: 'Forbidden' })];
    await refresh(on);
    const due = Date.parse(store.row.publishRetryAt);
    expect(await sweep({ getProject: () => null, now: () => due })).toEqual([
      { repo, prNumber: 7, published: false, skipped: 'no_project' },
    ]);
    expect(dropCodeReviewStatusDebt).toHaveBeenCalledWith(repo, 7);
    expect(store.row).toMatchObject({ publishFailedAt: null, publishOwedAt: null, publishRetryAt: null });
    expect(await sweep({ getProject: () => null, now: () => due })).toEqual([]);
    expect(posted()).toHaveLength(1);
  });

  it('drops a closed pull request’s debt before the first attempt and retries when its state is unreadable', async () => {
    reviewed();
    const closed = { isOpen: async () => false };
    // A closed PR can share a head with a live one: even a first write is skipped.
    await refreshCodeReviewOutcome(repo, 7, {}, () => ({
      outcome: 'passed',
      stale: false,
      reasons: [],
      headSha: head,
      baseRef: 'main',
      statusState: 'success',
      statusDescription: 'Review passed',
      owed: true,
    }));
    expect(await sweep(closed)).toEqual([{ repo, prNumber: 7, published: false, skipped: 'closed' }]);
    expect(store.row).toMatchObject({ publishFailedAt: null, publishOwedAt: null });
    expect(posted()).toEqual([]);
    expect(await sweep(closed)).toEqual([]);
    // A board that cannot say reads as open: the retry goes on.
    answers = [answer(403, { message: 'Forbidden' })];
    await refresh(on);
    const again = Date.parse(store.row.publishRetryAt);
    const unreadable = {
      isOpen: async () => {
        throw new Error('board unreadable');
      },
    };
    expect(await sweep({ ...unreadable, now: () => again })).toEqual([
      { repo, prNumber: 7, published: true },
    ]);
  });

  it('stops asking for a status GitHub will not accept for the commit', async () => {
    reviewed();
    const refused = () => answer(422, { message: 'No commit found for SHA' });
    answers = [refused()];
    const { published } = await refresh(on);
    expect(published.error).toContain('GitHub answered 422 (No commit found for SHA)');
    expect(published).not.toHaveProperty('gaveUp');
    let now = Date.parse(store.row.publishRetryAt);
    for (let attempt = 2; attempt < enforcement.UNPROCESSABLE_ATTEMPTS; attempt++) {
      answers = [refused()];
      const [result] = await sweep({ now: () => now });
      expect(result).not.toHaveProperty('gaveUp');
      expect(store.row.publishAttempts).toBe(attempt);
      now = Date.parse(store.row.publishRetryAt);
    }
    answers = [refused()];
    expect(await sweep({ now: () => now })).toEqual([
      { repo, prNumber: 7, published: false, error: expect.stringContaining('422'), gaveUp: true },
    ]);
    // No further attempt is due, ever; the failure stays for a person to see.
    expect(store.row).toMatchObject({
      publishAttempts: enforcement.UNPROCESSABLE_ATTEMPTS,
      publishRetryAt: null,
      publishOwedAt: null,
      publishErrorStatus: 422,
    });
    expect(await sweep({ now: () => now + 86_400_000 })).toEqual([]);
    expect(posted()).toHaveLength(enforcement.UNPROCESSABLE_ATTEMPTS);
    expect(await enforcement.reviewStatusFailures({ getProject: () => on })).toEqual([
      expect.objectContaining({ errorStatus: 422, retryAt: null }),
    ]);
    // A token GitHub refuses is another matter: fixing it is all it takes, so that goes on.
    expect(enforcement.statusRetryDelay(50)).toBe(3_600_000);
  });

  it('runs one sweep at a time', async () => {
    reviewed();
    await refreshCodeReviewOutcome(repo, 7, {}, () => ({
      outcome: 'passed',
      stale: false,
      reasons: [],
      headSha: head,
      baseRef: 'main',
      statusState: 'success',
      statusDescription: 'Review passed',
      owed: true,
    }));
    // GitHub is slow to answer, and the timer comes round again meanwhile.
    let release;
    answers = [
      (url, init) =>
        new Promise((resolve) => {
          release = () => {
            take(head, JSON.parse(init.body));
            resolve(answer(201));
          };
        }),
    ];
    const first = sweep();
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    expect(await sweep()).toEqual([]);
    release();
    expect(await first).toEqual([{ repo, prNumber: 7, published: true }]);
    expect(posted()).toHaveLength(1);
    // And the next one runs again.
    store.row.recomputeAt = store.now();
    expect(await sweep()).toHaveLength(1);
  });

  it('leaves a pull request alone whose publication is already under way', async () => {
    reviewed();
    let release;
    answers = [
      (url, init) =>
        new Promise((resolve) => {
          release = () => {
            take(head, JSON.parse(init.body));
            resolve(answer(201));
          };
        }),
    ];
    const { published } = await enforcement.refreshReviewOutcome(on, 7, { cfg, retryDelayMs: 0 });
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    expect(store.row.publishOwedAt).toBeTruthy();
    expect(await sweep()).toEqual([]);
    release();
    expect(await published).toEqual({ published: true });
    expect(posted()).toHaveLength(1);
  });
});

describe('a pull request seen at another revision', () => {
  const note = (revision) =>
    enforcement
      .noteReviewedRevision(on, 7, revision, { cfg, retryDelayMs: 0 })
      .then(async (result) =>
        result ? { outcome: result.outcome, published: await result.published } : null,
      );

  it('turns a passed outcome stale when the pull request is retargeted under the same head', async () => {
    reviewed();
    await refresh(on);
    expect(carried.get(head)[0].state).toBe('success');
    // Seen again as it was: nothing to do, and nothing is read or written for it.
    expect(await note({ headSha: head, baseRef: 'main' })).toBeNull();
    expect(refreshCodeReviewOutcome).toHaveBeenCalledTimes(1);
    // Retargeted to a branch nobody reviewed against. The head, and the `success` on it,
    // are the same commit: only a new status on that commit takes the pass away.
    const retargeted = await note({ headSha: head, baseRef: 'release' });
    expect(retargeted.outcome).toMatchObject({ outcome: 'pending', stale: true, baseRef: 'release' });
    expect(retargeted.outcome.reasons[0]).toMatchObject({ code: 'base_changed', reviewedBaseRef: 'main' });
    expect(posted().at(-1)).toEqual({
      sha: head,
      state: 'pending',
      context: 'briareus/code-review',
      description: 'Waiting for a review of aaaaaaa',
    });
    expect(carried.get(head)[0].state).toBe('pending');
    expect(store.row).toMatchObject({ baseRef: 'release', outcome: 'pending', stale: true });
    // Retargeted back: the review stands again for what it reviewed.
    expect((await note({ headSha: head, baseRef: 'main' })).outcome.outcome).toBe('passed');
    expect(carried.get(head)[0].state).toBe('success');
  });

  it('puts pending on a head that was pushed', async () => {
    reviewed();
    await refresh(on);
    const pushed = await note({ headSha: next, baseRef: 'main' });
    expect(pushed.outcome).toMatchObject({ outcome: 'pending', stale: true, headSha: next });
    expect(carried.get(next)[0]).toMatchObject({ state: 'pending' });
    // A sighting that names no base branch says nothing about it.
    expect(await note({ headSha: next })).toBeNull();
  });

  it('does nothing for a pull request no review has a record of, or for no revision at all', async () => {
    expect(await note({ headSha: head, baseRef: 'main' })).toBeNull();
    expect(await note({ headSha: null, baseRef: 'main' })).toBeNull();
    expect(await enforcement.noteReviewedRevision(null, 7, { headSha: head }, { cfg })).toBeNull();
    expect(refreshCodeReviewOutcome).not.toHaveBeenCalled();
    expect(store.row).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('stores the staleness for a project that publishes nothing, too', async () => {
    reviewed();
    await refresh(off);
    const moved = await enforcement.noteReviewedRevision(off, 7, { headSha: next, baseRef: 'main' }, { cfg });
    expect(moved.outcome).toMatchObject({ outcome: 'pending', stale: true, enforced: false });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('the security result beside the outcome', () => {
  const advisory = { ...off, securityReview: 'advisory' };
  const required = { ...off, securityReview: 'required' };
  const enforcing = { ...on, securityReview: 'required' };
  const categories = (count = 0) => ({
    categories: ['permissions', 'secrets', 'isolation', 'execution', 'untrusted_input', 'dependencies'].map(
      (id) => ({
        id,
        applicable: id === 'execution',
        assessment: 'Traced the changed handler and what it calls.',
        findings: id === 'execution' ? count : 0,
      }),
    ),
    findings: count,
    // Each recorded finding under the id the server gave it.
    entries: Array.from({ length: count }, (_, i) => ({
      id: i + 1,
      category: 'execution',
      severity: 'high',
      title: `Recorded finding ${i + 1}`,
      filePath: null,
      startLine: null,
      claim: null,
    })),
    claims: [],
    widened: null,
  });
  const pass = (over = {}) => ({
    codeReviewId: 5,
    stage: 'security',
    headSha: head,
    status: 'completed',
    detail: { coverage: categories() },
    startedAt: '2026-11-10T11:01:00.000Z',
    endedAt: '2026-11-10T11:02:00.000Z',
    ...over,
  });
  // A review that ran to its end, with a security pass as recorded.
  const withPass = (over = {}) => {
    reviewed();
    store.stages = [store.stages[0], pass(over), ...store.stages.slice(1)];
  };
  const read = (project, options) => enforcement.readReviewOutcome(project, 7, options);

  it('changes nothing for a project that never asked for a pass', async () => {
    reviewed();
    store.findings = [finding()];
    const { outcome } = await refresh(off);
    expect(outcome.outcome).toBe('passed');
    expect(outcome.reasons).toEqual([]);
    expect(outcome.security).toEqual({
      policy: 'off',
      result: 'not_required',
      blocking: false,
      stale: false,
      reasons: [],
      reviewId: 5,
      headSha: head,
      stage: null,
      coverage: null,
      counts: { findings: 0, fix: 0, optional: 0, dismissed: 0, suppressed: 0, unverified: 0 },
    });
    expect(store.row.security).toMatchObject({ policy: 'off', result: 'not_required' });
    expect(outcome.status.description).toBe('Review passed at aaaaaaa: 1 optional, nothing to fix');
  });

  it('is tracked and shown under advisory, and never holds the outcome back', async () => {
    // The pass ran to its end and passed.
    withPass();
    const passed = (await refresh(advisory)).outcome;
    expect(passed.outcome).toBe('passed');
    expect(passed.security).toMatchObject({
      policy: 'advisory',
      result: 'passed',
      blocking: false,
      stage: 'completed',
      coverage: categories(),
    });
    // The stage is listed with the others, and is not one the outcome requires.
    expect(passed.stages.map((s) => s.stage)).toEqual(['discover', 'security', 'publish', 'verify', 'label']);
    // The pass failed, was interrupted, or left nothing: the outcome is what it was.
    for (const over of [
      { status: 'failed', detail: { error: 'The security pass left no record, or one that is not JSON' } },
      { status: 'running', detail: null },
      { status: 'pending', detail: null },
      { detail: null },
    ]) {
      withPass(over);
      const { outcome } = await refresh(advisory);
      expect(outcome.outcome).toBe('passed');
      expect(outcome.reasons).toEqual([]);
      expect(outcome.status.state).toBe('success');
      expect(outcome.security).toMatchObject({ result: 'incomplete', blocking: false });
      expect(outcome.security.reasons).toHaveLength(1);
    }
    // And a review from before the policy reads as not run, still without blocking.
    reviewed();
    const before = (await refresh(advisory)).outcome;
    expect(before.outcome).toBe('passed');
    expect(before.security).toMatchObject({ result: 'not_run', blocking: false });
  });

  it('blocks the outcome under required when the pass is incomplete', async () => {
    withPass({
      status: 'failed',
      detail: { error: 'The security pass left no record, or one that is not JSON' },
    });
    const { outcome, published } = await refresh(enforcing);
    expect(outcome.outcome).toBe('incomplete');
    expect(outcome.reasons).toEqual([
      {
        code: 'requirement_unmet',
        effect: 'incomplete',
        requirement: 'security',
        message:
          'The required security review is incomplete: The security pass failed: The security pass left no record, or one that is not JSON',
      },
    ]);
    expect(outcome.security).toMatchObject({ policy: 'required', result: 'incomplete', blocking: true });
    // The commit status follows from the outcome, with no rule of its own.
    expect(published).toEqual({ published: true });
    expect(posted()).toEqual([
      {
        sha: head,
        state: 'error',
        context: 'briareus/code-review',
        description:
          'Review incomplete: The required security review is incomplete: The security pass failed: The security pass left no record, or one that is n…',
      },
    ]);
    // So does the reading the label step is given and held to.
    store.review.status = 'running';
    const provisional = await enforcement.provisionalReviewOutcome(enforcing, 7, { reviewId: 5 });
    expect(provisional.outcome).toBe('incomplete');
    expect(provisional.reasons[0]).toMatchObject({ code: 'requirement_unmet', requirement: 'security' });
  });

  it('cannot pass a required project’s review in which the pass did not run', async () => {
    reviewed();
    store.findings = [finding()];
    const { outcome } = await refresh(enforcing);
    expect(outcome.outcome).toBe('incomplete');
    expect(outcome.reasons.map((r) => [r.code, r.requirement])).toEqual([['requirement_unmet', 'security']]);
    expect(outcome.reasons[0].message).toContain(
      'The required security review did not run: The review of aaaaaaa ran without a security pass',
    );
    expect(outcome.security).toMatchObject({ result: 'not_run', blocking: true, stage: null });
    expect(posted().at(-1)).toMatchObject({ sha: head, state: 'error' });
  });

  it('fails the pass on a standing security fix, which blocks like any required fix under every policy', async () => {
    for (const project of [off, advisory, required]) {
      withPass({ detail: { coverage: categories(1) } });
      store.findings = [
        finding({ security: true, securityEntry: 1, shouldFix: 'fix', title: 'Token logged' }),
      ];
      const { outcome } = await refresh(project);
      expect(outcome.outcome).toBe('changes_required');
      expect(outcome.security.result).toBe('failed');
      expect(outcome.security.reasons).toEqual([
        expect.objectContaining({ code: 'fix_required', effect: 'failed', title: 'Token logged' }),
      ]);
      // Only a project that requires the pass also hears it as a requirement.
      expect(outcome.reasons.map((r) => r.code)).toEqual(
        project === required ? ['fix_required', 'requirement_unmet'] : ['fix_required'],
      );
      expect(outcome.security.blocking).toBe(project === required);
    }
    expect(store.row.security).toMatchObject({ policy: 'required', result: 'failed', blocking: true });
    expect(store.row.statusDescription).toBe('1 required fix at aaaaaaa');
  });

  it('passes a required project’s review once the pass and its findings are settled', async () => {
    withPass({ detail: { coverage: categories(2) } });
    store.findings = [
      finding({ security: true, securityEntry: 1 }),
      finding({
        id: 2,
        findingRef: 'ref-2',
        commentId: 502,
        threadId: 'PRRT_2',
        security: true,
        securityEntry: 2,
        shouldFix: 'dismiss',
      }),
    ];
    const { outcome } = await refresh(enforcing);
    expect(outcome.outcome).toBe('passed');
    expect(outcome.reasons).toEqual([]);
    expect(outcome.security).toMatchObject({
      result: 'passed',
      blocking: false,
      counts: { findings: 2, optional: 1, dismissed: 1 },
    });
    expect(posted().at(-1)).toMatchObject({ state: 'success' });
    // An unproven dismissal of a security finding is incomplete for both.
    store.findings[1].verification = 'plausible';
    const unproven = (await refresh(enforcing)).outcome;
    expect(unproven.outcome).toBe('incomplete');
    expect(unproven.security.result).toBe('incomplete');
    expect(unproven.security.reasons.map((r) => r.code)).toEqual(['dismissal_unproven']);
    // And what the pass recorded has to have been registered, finding by finding.
    store.findings = [finding({ security: true, securityEntry: 1 })];
    const missing = (await refresh(enforcing)).outcome;
    expect(missing.security.reasons.map((r) => r.code)).toEqual(['findings_missing']);
    expect(missing.outcome).toBe('incomplete');
  });

  it('does not let a marked finding stand in for a recorded one that was never registered', async () => {
    // The pass recorded one finding. Publication never registered it; it registered a
    // finding of the provider's report as suppressed against an earlier dismissed security
    // claim, which carries that claim's mark, and an unrelated one it marked itself.
    withPass({ detail: { coverage: categories(1) } });
    const at = '2026-11-10T10:00:00.000Z';
    store.decisions = [
      {
        id: 1,
        anchor: 'PRRT_old',
        threadId: 'PRRT_old',
        findingRef: 'old-dismissed',
        title: 'Session id reaches the log',
        verdict: 'dismiss',
        rationale: 'Redacted in lib/log.js:12',
        verification: 'confirmed',
        security: true,
        source: 'review',
        resolved: true,
        decidedAt: at,
      },
    ];
    store.findings = [
      finding({
        id: 7,
        findingRef: 'old-dismissed',
        security: true,
        reconciliation: 'suppressed',
        commentId: null,
        threadId: null,
        shouldFix: 'dismiss',
      }),
      finding({ id: 8, findingRef: 'ref-nit', commentId: 508, threadId: 'PRRT_8', security: true }),
    ];
    const { outcome } = await refresh(enforcing);
    expect(outcome.security.result).toBe('incomplete');
    expect(outcome.security.reasons).toEqual([
      expect.objectContaining({
        code: 'findings_missing',
        recorded: 1,
        registered: 0,
        entries: [{ id: 1, title: 'Recorded finding 1' }],
      }),
    ]);
    expect(outcome.outcome).toBe('incomplete');
    expect(posted().at(-1)).toMatchObject({ sha: head, state: 'error' });
    expect(posted().map((p) => p.state)).not.toContain('success');
    // Registered as the publication of that finding, it passes.
    store.findings[1].securityEntry = 1;
    const published = (await refresh(enforcing)).outcome;
    expect(published.outcome).toBe('passed');
    expect(published.security).toMatchObject({ result: 'passed', counts: { findings: 2, suppressed: 1 } });
  });

  it('does not read a pass that found nothing as passed when the review never published', async () => {
    // The pass completed with its coverage and no finding; the publish step then failed.
    withPass();
    store.review.status = 'failed';
    store.stages = store.stages.map((s) =>
      s.stage === 'publish'
        ? { ...s, status: 'failed', detail: { error: 'Codex entry exited with code 1' } }
        : ['verify', 'label'].includes(s.stage)
          ? { ...s, status: 'pending' }
          : s,
    );
    const { outcome } = await refresh(advisory);
    expect(outcome.outcome).toBe('incomplete');
    expect(outcome.security.result).toBe('incomplete');
    expect(outcome.security.reasons).toEqual([
      expect.objectContaining({ code: 'publication_incomplete', effect: 'incomplete', recorded: 0 }),
    ]);
    expect(store.row.security).toMatchObject({ result: 'incomplete' });
  });

  it('does not take a resolved thread as proof that a security fix was made', async () => {
    const fixRequired = (over = {}) => ({
      id: 1,
      anchor: 'PRRT_9',
      threadId: 'PRRT_9',
      findingRef: 'old-fix',
      title: 'Token logged',
      verdict: 'fix',
      security: true,
      source: 'review',
      // Resolved after the fix was required: by the author, and then a push.
      resolved: true,
      decidedAt: '2026-11-10T10:00:00.000Z',
      ...over,
    });
    // Round two's pass was clean and was never asked about the claim.
    withPass();
    store.decisions = [fixRequired()];
    const unchecked = (await refresh(enforcing)).outcome;
    expect(unchecked.security.result).toBe('incomplete');
    expect(unchecked.security.reasons).toEqual([
      expect.objectContaining({
        code: 'security_fix_unchecked',
        findingRef: 'old-fix',
        title: 'Token logged',
      }),
    ]);
    expect(unchecked.outcome).toBe('incomplete');
    expect(unchecked.reasons.map((r) => [r.code, r.requirement])).toEqual([
      ['requirement_unmet', 'security'],
    ]);
    expect(posted().at(-1)).toMatchObject({ state: 'error' });
    // Under advisory it is shown and holds nothing back, like any incomplete pass.
    expect((await refresh(advisory)).outcome).toMatchObject({
      outcome: 'passed',
      security: { result: 'incomplete', blocking: false },
    });
    // The pass confirmed the fix in the code it reviewed: settled.
    const confirmed = {
      ...categories(),
      claims: [
        { findingRef: 'old-fix', status: 'fixed', evidence: 'Redacted before logging, lib/log.js:12.' },
      ],
    };
    withPass({ detail: { coverage: confirmed } });
    const checked = (await refresh(enforcing)).outcome;
    expect(checked.outcome).toBe('passed');
    expect(checked.security).toMatchObject({ result: 'passed', reasons: [] });
    expect(posted().at(-1)).toMatchObject({ state: 'success' });
    // What `addressed` means for a finding that is not a security one has not changed.
    withPass();
    store.decisions = [fixRequired({ security: false })];
    expect((await refresh(enforcing)).outcome).toMatchObject({
      outcome: 'passed',
      security: { result: 'passed' },
    });
  });

  it('counts a security fix an earlier round left owed, by the mark its decision keeps', async () => {
    withPass();
    const at = '2026-11-10T10:00:00.000Z';
    store.decisions = [
      {
        id: 1,
        anchor: 'PRRT_9',
        threadId: 'PRRT_9',
        findingRef: 'old-1',
        title: 'Token logged',
        verdict: 'fix',
        security: true,
        source: 'review',
        resolved: false,
        decidedAt: at,
      },
      {
        id: 2,
        anchor: 'PRRT_8',
        threadId: 'PRRT_8',
        findingRef: 'old-2',
        title: 'Off by one',
        verdict: 'fix',
        source: 'review',
        resolved: false,
        decidedAt: at,
      },
    ];
    const { outcome } = await refresh(required);
    expect(outcome.outcome).toBe('changes_required');
    expect(outcome.security.result).toBe('failed');
    expect(outcome.security.reasons.map((r) => [r.code, r.findingRef])).toEqual([['fix_owed', 'old-1']]);
    // The outcome lists both; the security result only the security claim.
    expect(outcome.reasons.filter((r) => r.code === 'fix_owed').map((r) => r.findingRef)).toEqual([
      'old-1',
      'old-2',
    ]);
  });

  it('turns stale with the outcome when the pull request moves', async () => {
    withPass();
    await refresh(required);
    const moved = await read(required, { current: { headSha: next } });
    expect(moved).toMatchObject({ outcome: 'pending', stale: true });
    expect(moved.security).toMatchObject({ result: 'pending', stale: true, headSha: head });
    expect(moved.security.reasons.map((r) => r.code)).toEqual(['head_moved']);
  });

  describe('when the policy changes on an open pull request', () => {
    const note = (project, revision = { headSha: head, baseRef: 'main' }) =>
      enforcement
        .noteReviewedRevision(project, 7, revision, { cfg, retryDelayMs: 0 })
        .then(async (result) =>
          result ? { outcome: result.outcome, published: await result.published } : null,
        );

    it('never reads a pass that did not run as passed, and takes the pass away on GitHub', async () => {
      // Reviewed and passed while the project asked for no pass.
      reviewed();
      await refresh(on);
      expect(carried.get(head)[0].state).toBe('success');
      expect(store.row.securityPolicy).toBe('off');
      // Seen again under the same policy: nothing to do.
      expect(await note(on)).toBeNull();
      expect(refreshCodeReviewOutcome).toHaveBeenCalledTimes(1);
      // The project now requires the pass. A read says so at once, without writing:
      const now = await read(enforcing);
      expect(now.outcome).toBe('incomplete');
      expect(now.security).toMatchObject({ policy: 'required', result: 'not_run', blocking: true });
      // what GitHub carries is no longer this outcome's status.
      expect(now.status).toMatchObject({ state: 'error', published: false, publishedState: 'success' });
      // The next time the server sees the pull request, same head and base, the stored
      // outcome is computed again and the `success` is replaced.
      const seen = await note(enforcing);
      expect(seen.outcome.outcome).toBe('incomplete');
      expect(seen.published).toEqual({ published: true });
      expect(carried.get(head)[0].state).toBe('error');
      expect(store.row).toMatchObject({ outcome: 'incomplete', securityPolicy: 'required' });
      // Once, not on every sighting.
      expect(await note(enforcing)).toBeNull();
      expect(refreshCodeReviewOutcome).toHaveBeenCalledTimes(2);
    });

    it('recomputes a quiet pull request’s outcome when the project’s settings change, without waiting to see it', async () => {
      const sweep = (project) =>
        enforcement.retryReviewStatuses({ getProject: () => project, cfg, retryDelayMs: 0 });
      // Reviewed and passed while the project asked for no pass; then nothing happens to
      // the pull request: no push, no webhook, no session.
      reviewed();
      await refresh(on);
      expect(carried.get(head)[0].state).toBe('success');
      expect(await sweep(on)).toEqual([]);
      // The project is switched to `required`. Its open pull requests' outcomes are
      // marked as owed, and the sweep computes and publishes them again.
      expect(await enforcement.oweProjectOutcomes(enforcing, { openPulls: async () => [7, 9] })).toBe(1);
      expect(markRepoCodeReviewOutcomesStale).toHaveBeenLastCalledWith(repo, [7, 9]);
      expect(store.row.recomputeAt).toBeTruthy();
      expect(await sweep(enforcing)).toEqual([{ repo, prNumber: 7, published: true }]);
      expect(carried.get(head)[0]).toMatchObject({ state: 'error' });
      expect(store.row).toMatchObject({
        outcome: 'incomplete',
        securityPolicy: 'required',
        recomputeAt: null,
      });
      expect(store.row.security).toMatchObject({ result: 'not_run', blocking: true });
      // Paid once.
      expect(await sweep(enforcing)).toEqual([]);
      // A pull request that is no longer open is left as it is: its commit needs no new status.
      const before = posted().length;
      expect(await enforcement.oweProjectOutcomes(on, { openPulls: async () => [9] })).toBe(0);
      expect(await sweep(on)).toEqual([]);
      expect(posted()).toHaveLength(before);
      // When the open ones cannot be listed, every outcome of the repository is marked:
      // a status too many is the lesser harm.
      const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        const failing = { openPulls: async () => Promise.reject(new Error('GitHub is down')) };
        expect(await enforcement.oweProjectOutcomes(on, failing)).toBe(1);
        expect(markRepoCodeReviewOutcomesStale).toHaveBeenLastCalledWith(repo, null);
      } finally {
        logged.mockRestore();
      }
      // Back to no pass asked for: the same sweep takes the requirement away again.
      expect(await sweep(on)).toEqual([{ repo, prNumber: 7, published: true }]);
      expect(carried.get(head)[0]).toMatchObject({ state: 'success' });
    });

    it('stops an incomplete pass from blocking when the project no longer requires it', async () => {
      withPass({ status: 'running', detail: null });
      await refresh(enforcing);
      expect(carried.get(head)[0].state).toBe('error');
      const relaxed = { ...on, securityReview: 'advisory' };
      const seen = await note(relaxed);
      expect(seen.outcome.outcome).toBe('passed');
      // What the pass amounts to is still said.
      expect(seen.outcome.security).toMatchObject({
        policy: 'advisory',
        result: 'incomplete',
        blocking: false,
      });
      expect(carried.get(head)[0].state).toBe('success');
      // Switched off altogether: the same evidence, and nothing owed.
      const switchedOff = await note(on);
      expect(switchedOff.outcome.security).toMatchObject({
        policy: 'off',
        result: 'incomplete',
        blocking: false,
      });
      expect(switchedOff.outcome.outcome).toBe('passed');
    });

    it('keeps a verified security fix blocking through every change of policy', async () => {
      withPass({ detail: { coverage: categories(1) } });
      store.findings = [finding({ security: true, securityEntry: 1, shouldFix: 'fix' })];
      await refresh(enforcing);
      for (const project of [{ ...on, securityReview: 'advisory' }, on, enforcing]) {
        const seen = await note(project);
        expect(seen.outcome.outcome).toBe('changes_required');
        expect(seen.outcome.security.result).toBe('failed');
        expect(carried.get(head)[0].state).toBe('failure');
      }
    });
  });

  it('reads one stored review’s own result, apart from the pull request’s', () => {
    const coverage = categories(1);
    const stored = {
      id: 5,
      jobId: 'job-5',
      status: 'completed',
      headSha: head,
      baseRef: 'main',
      stages: [...stagesAt(head).slice(0, 1), pass({ detail: { coverage } }), ...stagesAt(head).slice(1)],
      findings: [finding({ security: true, securityEntry: 1, shouldFix: 'fix' })],
    };
    const own = enforcement.reviewSecurity(required, stored, []);
    expect(own).toMatchObject({
      policy: 'required',
      result: 'failed',
      blocking: true,
      stale: false,
      coverage,
    });
    // Another round's claims are not this review's.
    const others = [
      {
        id: 1,
        anchor: 'T',
        threadId: 'T',
        findingRef: 'x',
        verdict: 'fix',
        security: true,
        decidedAt: '2026-11-10T10:00:00.000Z',
      },
    ];
    const clean = enforcement.reviewSecurity(
      required,
      {
        ...stored,
        findings: [],
        stages: [...stagesAt(head).slice(0, 1), pass(), ...stagesAt(head).slice(1)],
      },
      others,
    );
    expect(clean).toMatchObject({ result: 'passed', reasons: [] });
    // A review from before the pass existed, under each policy.
    const old = { ...stored, stages: stagesAt(head), findings: [] };
    expect(enforcement.reviewSecurity(off, old, []).result).toBe('not_required');
    expect(enforcement.reviewSecurity(advisory, old, []).result).toBe('not_run');
    expect(enforcement.reviewSecurity(required, { ...old, stages: [] }, []).result).toBe('not_run');
  });
});

describe('findings closed to the review itself', () => {
  const review = { id: 5, headSha: head };
  const stages = (label) => async () => stagesAt(head, { label: { status: label } });
  const frozen = (over) =>
    enforcement.reviewFindingsFrozen({ project: on, review, listStages: stages('pending'), ...over });

  it('from the label step on, by the stage record', async () => {
    expect(await frozen()).toBe(false);
    for (const status of ['running', 'completed', 'failed'])
      expect(await frozen({ listStages: stages(status) })).toBe(true);
  });

  it('by the session too, so a stage write that was lost does not leave them open', async () => {
    // The step's start never reached the stage record: it still says pending.
    const session = { codeReviewRecord: { id: 5, head, labelAt: 1_700_000_000_000 } };
    expect(await frozen({ session })).toBe(true);
    // Not for another run of the review, nor before the step.
    expect(await frozen({ session: { codeReviewRecord: { id: 5, head: next, labelAt: 1 } } })).toBe(false);
    expect(await frozen({ session: { codeReviewRecord: { id: 5, head } } })).toBe(false);
    expect(await frozen({ session: null })).toBe(false);
  });

  it('never for a project that does not enforce the outcome, which is not even asked', async () => {
    const listStages = vi.fn(stages('running'));
    expect(await enforcement.reviewFindingsFrozen({ project: off, review, listStages })).toBe(false);
    expect(listStages).not.toHaveBeenCalled();
  });

  it('refuses rather than allows when the record cannot be read', async () => {
    const listStages = async () => {
      throw new Error('database down');
    };
    await expect(frozen({ listStages })).rejects.toThrow('database down');
  });
});

describe('the label step held against the outcome', () => {
  const since = Date.UTC(2026, 10, 10, 12);
  const at = (ms) => new Date(since + ms).toISOString();
  const approval = (id, login, over = {}) => ({
    id,
    state: 'APPROVED',
    commit_id: head,
    user: { login },
    submitted_at: at(30_000),
    ...over,
  });
  // GitHub as the check reads it: the labels, the reviews, and who the server is.
  function github_({ labels = [], reviews = [], viewer = 'briareus-bot', dismissal = 200 } = {}) {
    answers = [];
    fetch.mockImplementation(async (url, init) => {
      requests.push({
        url,
        method: init.method,
        token: init.headers.Authorization.replace('Bearer ', ''),
        body: init.body ? JSON.parse(init.body) : null,
      });
      if (url.includes('/labels'))
        return answer(
          200,
          labels.map((name) => ({ name })),
        );
      if (url.includes('/reviews?')) return answer(200, reviews);
      if (url.endsWith('/user')) return answer(200, { login: viewer });
      if (url.includes('/dismissals')) return answer(dismissal, {});
      return answer(404, {});
    });
  }
  const check = (over = {}) =>
    enforcement.checkLabelStep({
      cfg,
      repo,
      prNumber: 7,
      head,
      outcome: 'changes_required',
      approvedLabels: ['code-approved'],
      since,
      ...over,
    });
  const dismissals = () => requests.filter((r) => r.url.includes('/dismissals'));

  it('finds nothing to note when the step left no approval and no approved label', async () => {
    github_({ labels: ['feedback-given'], reviews: [{ id: 1, state: 'COMMENTED', commit_id: head }] });
    expect(await check()).toEqual([]);
    expect(requests.map((r) => r.method)).toEqual(['GET', 'GET']);
  });

  it('notes an approved label and leaves it on the pull request', async () => {
    github_({ labels: ['Code-Approved', 'feedback-given'] });
    expect(await check()).toEqual([
      {
        code: 'approved_label_ignored',
        message:
          'The pull request carries `Code-Approved` while the review outcome is changes_required: the label does not count as a passed review.',
        labels: ['Code-Approved'],
      },
    ]);
    // Read only: a project's labels are its own.
    expect(requests.every((r) => r.method === 'GET')).toBe(true);
  });

  it('dismisses the approval the server’s own account submitted during the step', async () => {
    github_({ reviews: [approval(900, 'Briareus-Bot')] });
    const notes = await check();
    expect(notes).toEqual([
      {
        code: 'approval_dismissed',
        message:
          'The review approved aaaaaaa as briareus-bot while its outcome is changes_required; Briareus dismissed that approval.',
        reviewId: 900,
      },
    ]);
    expect(dismissals()).toEqual([
      {
        url: `https://api.github.com/repos/${repo}/pulls/7/reviews/900/dismissals`,
        method: 'PUT',
        token: 'server-token',
        body: {
          message:
            'Briareus: the code review outcome for aaaaaaa is changes required, so the review’s own approval of it does not stand.',
          event: 'DISMISS',
        },
      },
    ]);
  });

  it('dismisses as the account the agent posts as, when that is its owner’s', async () => {
    github_({ reviews: [approval(901, 'dana'), approval(902, 'briareus-bot')] });
    const notes = await check({ reviewer: { login: 'Dana', token: 'danas-token' } });
    expect(notes.map((n) => [n.code, n.reviewId])).toEqual([['approval_dismissed', 901]]);
    expect(dismissals().map((r) => [r.url.split('/').at(-2), r.token])).toEqual([['901', 'danas-token']]);
    // Whose account that is was given, so the server's own was not asked.
    expect(requests.some((r) => r.url.endsWith('/user'))).toBe(false);
  });

  it('leaves alone an approval by somebody else or from before the step', async () => {
    github_({
      reviews: [
        approval(1, 'a-person'),
        // By the same account, by hand, long before the review's label step.
        approval(3, 'briareus-bot', { submitted_at: at(-3_600_000) }),
        approval(4, 'briareus-bot', { state: 'DISMISSED' }),
        approval(5, 'briareus-bot', { state: 'CHANGES_REQUESTED' }),
      ],
    });
    expect(await check()).toEqual([]);
    expect(dismissals()).toEqual([]);
  });

  it('dismisses the step’s approval of a head pushed meanwhile too', async () => {
    // The pull request moved while the step ran and the agent approved what it found
    // there: no more supported by the outcome than an approval of the reviewed commit.
    github_({ reviews: [approval(902, 'briareus-bot', { commit_id: next })] });
    const notes = await check({ outcome: 'pending' });
    expect(notes).toEqual([
      {
        code: 'approval_dismissed',
        message:
          'The review approved bbbbbbb as briareus-bot while its outcome is pending; Briareus dismissed that approval.',
        reviewId: 902,
      },
    ]);
    expect(dismissals()[0].body.message).toBe(
      'Briareus: the code review outcome for aaaaaaa is pending, so the review’s own approval of bbbbbbb does not stand.',
    );
  });

  it('goes by the approvals that existed before the step, not by two clocks', async () => {
    github_({
      reviews: [
        // By the reviewing account, by hand, a few seconds before the step: within any
        // slack a clock comparison would have to allow, and not the step's.
        approval(10, 'briareus-bot', { submitted_at: at(-5_000) }),
        // Submitted during the step, and stamped by a GitHub clock running well behind.
        approval(11, 'briareus-bot', { submitted_at: at(-300_000) }),
      ],
    });
    const notes = await check({ known: [10] });
    expect(notes.map((n) => [n.code, n.reviewId])).toEqual([['approval_dismissed', 11]]);
    expect(dismissals().map((r) => r.url.split('/').at(-2))).toEqual(['11']);
  });

  it('lists the approvals a pull request carries, for that comparison', async () => {
    github_({
      reviews: [
        approval(10, 'briareus-bot'),
        approval(12, 'a-person'),
        approval(13, 'briareus-bot', { state: 'DISMISSED' }),
        { id: 14, state: 'COMMENTED', user: { login: 'briareus-bot' } },
      ],
    });
    expect(await enforcement.approvalsBefore({ cfg, repo, prNumber: 7 })).toEqual([10, 12]);
    fetch.mockImplementation(async () => answer(502, {}));
    await expect(enforcement.approvalsBefore({ cfg, repo, prNumber: 7 })).rejects.toThrow(
      'GitHub answered 502',
    );
  });

  it('says so when GitHub will not dismiss the approval', async () => {
    github_({ reviews: [approval(900, 'briareus-bot')], dismissal: 403 });
    const notes = await check({ outcome: 'incomplete' });
    expect(notes).toEqual([expect.objectContaining({ code: 'approval_not_dismissed', reviewId: 900 })]);
    expect(notes[0].message).toContain('GitHub answered 403');
    expect(notes[0].message).toContain('does not count as a passed review');
  });

  it('reads every page of the reviews', async () => {
    const page = Array.from({ length: 100 }, (_, i) => ({ id: i + 1, state: 'COMMENTED', commit_id: head }));
    github_({});
    let asked = 0;
    const base = fetch.getMockImplementation();
    fetch.mockImplementation(async (url, init) => {
      if (!url.includes('/reviews?')) return base(url, init);
      asked++;
      requests.push({ url, method: init.method, token: 'server-token', body: null });
      return answer(200, url.endsWith('page=1') ? page : [approval(900, 'briareus-bot')]);
    });
    expect((await check()).map((n) => n.code)).toEqual(['approval_dismissed']);
    expect(asked).toBe(2);
  });

  it('notes a check it could not make instead of passing over it', async () => {
    github_({});
    fetch.mockImplementation(async () => answer(502, {}));
    expect(await check()).toEqual([
      {
        code: 'label_check_failed',
        message:
          'Briareus could not check the pull request’s labels and approvals against the outcome: GitHub answered 502 reading the pull request’s labels',
      },
    ]);
  });
});
