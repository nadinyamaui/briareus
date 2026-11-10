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
  now: () => new Date(Date.UTC(2026, 10, 10, 12, 0, store.at++)).toISOString(),
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
    store.row ||= {
      repo,
      prNumber,
      codeReviewId: null,
      headSha: null,
      baseRef: null,
      publishedSha: null,
      publishedState: null,
      publishedDescription: null,
      publishedAt: null,
      publishError: null,
      publishErrorStatus: null,
      publishAttempts: 0,
      publishFailedAt: null,
      publishRetryAt: null,
    };
    const state = store.state(reviewId);
    const next = compute(state);
    Object.assign(store.row, next, { codeReviewId: state.review?.id ?? null, computedAt: store.now() });
    return { ...state, row: { ...store.row } };
  }),
  getCodeReviewOutcome: vi.fn(async () => (store.row ? { ...store.row } : null)),
  recordCodeReviewStatusPublished: vi.fn(async (_repo, _pr, { sha, state, description }) => {
    Object.assign(store.row, {
      publishedSha: sha,
      publishedState: state,
      publishedDescription: description,
      publishedAt: store.now(),
      publishError: null,
      publishErrorStatus: null,
      publishAttempts: 0,
      publishFailedAt: null,
      publishRetryAt: null,
    });
  }),
  recordCodeReviewStatusFailed: vi.fn(async (_repo, _pr, { error, status = null, retryAt }) => {
    Object.assign(store.row, {
      publishError: error,
      publishErrorStatus: status,
      publishAttempts: store.row.publishAttempts + 1,
      publishFailedAt: store.now(),
      publishRetryAt: new Date(retryAt).toISOString(),
    });
  }),
  clearCodeReviewStatusFailure: vi.fn(async () => {
    Object.assign(store.row, {
      publishError: null,
      publishErrorStatus: null,
      publishAttempts: 0,
      publishFailedAt: null,
      publishRetryAt: null,
    });
  }),
  listFailedCodeReviewStatuses: vi.fn(async ({ dueBy = null } = {}) =>
    store.row?.publishFailedAt && (dueBy == null || Date.parse(store.row.publishRetryAt) <= dueBy)
      ? [{ ...store.row }]
      : [],
  ),
  // What lib/review-rounds.js imports beside these; nothing here calls them.
  claimCodeReviewRound: vi.fn(),
  codeReviewDecisionsSince: vi.fn(async () => 0),
  getCodeReviewRounds: vi.fn(async () => ({ count: null, rounds: [] })),
  listCodeReviewDecisions: vi.fn(async () => []),
  listPullCodeReviews: vi.fn(async () => []),
  listRefusedCodeReviewRounds: vi.fn(async () => []),
}));

import {
  clearCodeReviewStatusFailure,
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
let enforcement, github, requests, answers;
const answer = (status, body = {}, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
// Every status write GitHub was sent, in order.
const posted = () =>
  requests
    .filter((r) => r.method === 'POST' && r.url.includes('/statuses/'))
    .map((r) => ({ sha: r.url.split('/').pop(), ...r.body }));

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
  });
  vi.clearAllMocks();
  vi.resetModules();
  requests = [];
  // What GitHub answers, in order; once they run out every write is accepted.
  answers = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url, init) => {
      requests.push({
        url,
        method: init.method,
        token: init.headers.Authorization.replace('Bearer ', ''),
        body: init.body ? JSON.parse(init.body) : null,
      });
      const next = answers.length ? answers.shift() : null;
      if (next instanceof Error) throw next;
      if (typeof next === 'function') return next(url, init);
      return next || answer(201, {});
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
    expect(clearCodeReviewStatusFailure).toHaveBeenCalledWith(repo, 7);
    expect(store.row.publishFailedAt).toBeNull();
    expect(posted()).toHaveLength(1);
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

  it('leaves alone an approval by somebody else, of another commit, or from before the step', async () => {
    github_({
      reviews: [
        approval(1, 'a-person'),
        approval(2, 'briareus-bot', { commit_id: next }),
        // By the same account, by hand, long before the review's label step.
        approval(3, 'briareus-bot', { submitted_at: at(-3_600_000) }),
        approval(4, 'briareus-bot', { state: 'DISMISSED' }),
        approval(5, 'briareus-bot', { state: 'CHANGES_REQUESTED' }),
      ],
    });
    expect(await check()).toEqual([]);
    expect(dismissals()).toEqual([]);
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
