import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/github.js', () => ({ githubGraphql: vi.fn() }));

import { githubGraphql } from '../lib/github.js';
import {
  buildReviewHistory,
  dispositionOf,
  fetchReviewThreads,
  findingDecision,
  findingRefFor,
  forgetReviewHistory,
  linkPublishedFindings,
  loadReviewHistory,
  parseVerdict,
  reconcileFinding,
  reviewHistoryCounts,
  reviewHistoryFile,
  reviewHistoryOf,
} from '../lib/review-history.js';

const cfg = { githubToken: 'tok' };
const head = 'a'.repeat(40);
const earlier = 'b'.repeat(40);
const minute = (n) => Date.UTC(2026, 9, 29, 10, n);

// GraphQL nodes, as GitHub answers them.
const commentNode = (databaseId, login, body, { at = 0, commit = earlier } = {}) => ({
  databaseId,
  url: `https://github.com/acme/shop/pull/7#discussion_r${databaseId}`,
  body,
  createdAt: new Date(minute(at)).toISOString(),
  author: login ? { login } : null,
  originalCommit: commit ? { oid: commit } : null,
});
const threadNode = (id, comments, extra = {}) => ({
  id,
  isResolved: false,
  isOutdated: false,
  path: 'lib/cart.js',
  line: 10,
  startLine: null,
  originalLine: 10,
  comments: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: comments },
  ...extra,
});
const threadsPage = (nodes, { next = null, viewer = 'octo-reviewer', headRefOid = head } = {}) => ({
  viewer: { login: viewer },
  repository: {
    pullRequest: {
      headRefOid,
      reviewThreads: { pageInfo: { hasNextPage: !!next, endCursor: next }, nodes },
    },
  },
});

// Threads as fetchReviewThreads normalises them, for the rules on top of it.
const said = (id, author, body, at = 0, commit = earlier) => ({
  id,
  url: `https://github.com/acme/shop/pull/7#discussion_r${id}`,
  body,
  at: minute(at),
  author,
  commit,
});
const thread = (id, comments, extra = {}) => ({
  id,
  resolved: false,
  outdated: false,
  path: 'lib/cart.js',
  line: 10,
  startLine: null,
  comments,
  ...extra,
});
const history = (threads, { decisions = [], reviewerLogins = [], viewer = 'octo-reviewer' } = {}) =>
  buildReviewHistory({
    repo: 'acme/shop',
    prNumber: 7,
    head,
    fetched: { viewer, headSha: head, threads },
    decisions,
    reviewerLogins,
    now: minute(59),
  });
const only = (threads, options) => history(threads, options).threads[0];

// A block, not an expression: Vitest would run a returned mock as the test's cleanup.
beforeEach(() => {
  githubGraphql.mockReset();
});

describe('fetchReviewThreads', () => {
  it('follows the thread cursor past the first page and keeps every thread', async () => {
    const first = Array.from({ length: 50 }, (_, i) =>
      threadNode(`PRRT_${i}`, [commentNode(1000 + i, 'octo-reviewer', `Finding ${i}`)]),
    );
    const second = Array.from({ length: 50 }, (_, i) =>
      threadNode(`PRRT_${50 + i}`, [commentNode(2000 + i, 'octo-reviewer', `Finding ${50 + i}`)]),
    );
    const third = [threadNode('PRRT_last', [commentNode(3000, 'dev-ana', 'One more')], { isResolved: true })];
    githubGraphql
      .mockResolvedValueOnce(threadsPage(first, { next: 'cursor-1' }))
      .mockResolvedValueOnce(threadsPage(second, { next: 'cursor-2' }))
      .mockResolvedValueOnce(threadsPage(third));
    const fetched = await fetchReviewThreads(cfg, 'acme/shop', 7);
    expect(fetched.threads).toHaveLength(101);
    expect(fetched.threads.at(-1)).toMatchObject({ id: 'PRRT_last', resolved: true });
    expect(fetched).toMatchObject({ viewer: 'octo-reviewer', headSha: head });
    expect(githubGraphql.mock.calls.map(([, , variables]) => variables)).toEqual([
      { owner: 'acme', name: 'shop', number: 7, cursor: null },
      { owner: 'acme', name: 'shop', number: 7, cursor: 'cursor-1' },
      { owner: 'acme', name: 'shop', number: 7, cursor: 'cursor-2' },
    ]);
    // Reads only: the server's own token, whoever the review posts as.
    expect(githubGraphql.mock.calls.every(([, query]) => /^\s*query\b/.test(query))).toBe(true);
  });

  it('follows a long thread’s own cursor until its last reply', async () => {
    const long = threadNode(
      'PRRT_long',
      [commentNode(1, 'octo-reviewer', 'Finding'), commentNode(2, 'dev-ana', 'Why?', { at: 1 })],
      {
        comments: {
          pageInfo: { hasNextPage: true, endCursor: 'c-1' },
          nodes: [commentNode(1, 'octo-reviewer', 'Finding'), commentNode(2, 'dev-ana', 'Why?', { at: 1 })],
        },
      },
    );
    githubGraphql
      .mockResolvedValueOnce(
        threadsPage([long, threadNode('PRRT_short', [commentNode(9, 'dev-ana', 'Nit')])]),
      )
      .mockResolvedValueOnce({
        node: {
          comments: {
            pageInfo: { hasNextPage: true, endCursor: 'c-2' },
            nodes: [commentNode(3, 'octo-reviewer', 'Because.', { at: 2 })],
          },
        },
      })
      .mockResolvedValueOnce({
        node: {
          comments: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [commentNode(4, 'octo-reviewer', '**Dismissed** Guarded upstream.', { at: 3 })],
          },
        },
      });
    const { threads } = await fetchReviewThreads(cfg, 'acme/shop', 7);
    expect(threads[0].comments.map((c) => c.id)).toEqual([1, 2, 3, 4]);
    expect(threads[1].comments.map((c) => c.id)).toEqual([9]);
    expect(githubGraphql.mock.calls.slice(1).map(([, , variables]) => variables)).toEqual([
      { id: 'PRRT_long', cursor: 'c-1' },
      { id: 'PRRT_long', cursor: 'c-2' },
    ]);
    // The verdict on the last page is the one that decides the thread.
    expect(only(threads).disposition).toBe('dismissed');
  });

  it('normalises a thread: its place, its state, and each comment’s author and commit', async () => {
    githubGraphql.mockResolvedValueOnce(
      threadsPage([
        threadNode('PRRT_a', [commentNode(1, null, 'From a deleted account', { commit: null })], {
          isResolved: true,
          isOutdated: true,
          path: 'lib/stock.js',
          line: null,
          originalLine: 42,
          startLine: 40,
        }),
      ]),
    );
    expect((await fetchReviewThreads(cfg, 'acme/shop', 7)).threads).toEqual([
      {
        id: 'PRRT_a',
        resolved: true,
        outdated: true,
        path: 'lib/stock.js',
        line: 42,
        startLine: 40,
        comments: [
          {
            id: 1,
            url: 'https://github.com/acme/shop/pull/7#discussion_r1',
            body: 'From a deleted account',
            at: minute(0),
            author: null,
            commit: null,
          },
        ],
      },
    ]);
  });

  it.each([
    [
      'the pull request is missing',
      { viewer: { login: 'octo-reviewer' }, repository: { pullRequest: null } },
    ],
    ['the repository is missing', { repository: null }],
    ['a thread is null', threadsPage([null])],
    ['a thread has no comments connection', threadsPage([{ id: 'PRRT_x' }])],
    ['a thread is empty', threadsPage([threadNode('PRRT_x', [])])],
    ['a comment has no id', threadsPage([threadNode('PRRT_x', [{ body: 'x', createdAt: null }])])],
    [
      'more pages are promised without a cursor',
      {
        viewer: { login: 'octo-reviewer' },
        repository: {
          pullRequest: {
            headRefOid: head,
            reviewThreads: { pageInfo: { hasNextPage: true, endCursor: null }, nodes: [] },
          },
        },
      },
    ],
    [
      'the page info is missing',
      { repository: { pullRequest: { headRefOid: head, reviewThreads: { nodes: [] } } } },
    ],
    [
      'a thread promises more comments without a cursor',
      threadsPage([
        threadNode('PRRT_x', [], {
          comments: { pageInfo: { hasNextPage: true, endCursor: null }, nodes: [commentNode(1, 'a', 'b')] },
        }),
      ]),
    ],
  ])('refuses a partial answer when %s', async (_name, answer) => {
    githubGraphql.mockResolvedValue(answer);
    await expect(fetchReviewThreads(cfg, 'acme/shop', 7)).rejects.toThrow(/incomplete review history/);
  });

  it('refuses a cursor that repeats and a missing comment page', async () => {
    githubGraphql.mockResolvedValue(threadsPage([], { next: 'same' }));
    await expect(fetchReviewThreads(cfg, 'acme/shop', 7)).rejects.toThrow(/no cursor to them/);
    expect(githubGraphql).toHaveBeenCalledTimes(2);
    githubGraphql.mockReset();
    githubGraphql
      .mockResolvedValueOnce(
        threadsPage([
          threadNode('PRRT_x', [], {
            comments: { pageInfo: { hasNextPage: true, endCursor: 'c' }, nodes: [commentNode(1, 'a', 'b')] },
          }),
        ]),
      )
      .mockResolvedValueOnce({ node: null });
    await expect(fetchReviewThreads(cfg, 'acme/shop', 7)).rejects.toThrow(/comments of thread PRRT_x/);
  });

  it('tries a passing GitHub failure again, at the page that failed, and then gives up', async () => {
    const flaky = Object.assign(new Error('Something went wrong while executing your query'), {
      status: 200,
    });
    githubGraphql
      .mockResolvedValueOnce(
        threadsPage([threadNode('PRRT_1', [commentNode(1, 'octo-reviewer', 'One')])], { next: 'c-1' }),
      )
      .mockRejectedValueOnce(flaky)
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(threadsPage([threadNode('PRRT_2', [commentNode(2, 'octo-reviewer', 'Two')])]));
    const fetched = await fetchReviewThreads(cfg, 'acme/shop', 7, { retryDelayMs: 0 });
    expect(fetched.threads.map((t) => t.id)).toEqual(['PRRT_1', 'PRRT_2']);
    expect(githubGraphql.mock.calls.map(([, , variables]) => variables.cursor)).toEqual([
      null,
      'c-1',
      'c-1',
      'c-1',
    ]);
    githubGraphql.mockReset();
    githubGraphql.mockRejectedValue(Object.assign(new Error('GitHub GraphQL answered 502'), { status: 502 }));
    await expect(fetchReviewThreads(cfg, 'acme/shop', 7, { retryDelayMs: 0 })).rejects.toThrow(
      'GitHub GraphQL answered 502',
    );
    expect(githubGraphql).toHaveBeenCalledTimes(3);
  });

  it.each([
    ['a rate limit', { status: 429, rateLimited: true, retryAt: Date.now() + 60000 }],
    ['a rate limit answered as a query error', { status: 200, rateLimited: true }],
    ['refused credentials', { status: 401 }],
    [
      'a missing pull request',
      { status: 200, errors: [{ type: 'NOT_FOUND', message: 'Could not resolve' }] },
    ],
  ])('does not hammer GitHub after %s', async (_name, details) => {
    githubGraphql.mockRejectedValue(Object.assign(new Error('refused'), details));
    await expect(fetchReviewThreads(cfg, 'acme/shop', 7, { retryDelayMs: 0 })).rejects.toThrow('refused');
    expect(githubGraphql).toHaveBeenCalledTimes(1);
  });
});

describe('parseVerdict', () => {
  it('reads the bold verdict a reply starts with, and the evidence after it', () => {
    expect(parseVerdict('**Dismissed** The caller validates it, lib/a.js:4.')).toEqual({
      verdict: 'dismiss',
      rationale: 'The caller validates it, lib/a.js:4.',
    });
    expect(parseVerdict('  **Fix**: reproduced with `npm test`')).toEqual({
      verdict: 'fix',
      rationale: 'reproduced with `npm test`',
    });
    expect(parseVerdict('**Optional:** cleanup only')).toEqual({
      verdict: 'optional',
      rationale: 'cleanup only',
    });
    expect(parseVerdict('**dismiss** — duplicate of the check above')).toEqual({
      verdict: 'dismiss',
      rationale: 'duplicate of the check above',
    });
    expect(parseVerdict('**Fix**\n\nStill fails on an empty cart.')).toEqual({
      verdict: 'fix',
      rationale: 'Still fails on an empty cart.',
    });
    expect(parseVerdict('**Dismissed**')).toEqual({ verdict: 'dismiss', rationale: null });
    expect(parseVerdict(`**Fix** ${'x'.repeat(5000)}`).rationale).toHaveLength(4000);
  });

  it('is not fooled by a verdict that is quoted, mentioned or merely similar', () => {
    for (const body of [
      'I think this should be **Dismissed**.',
      '> **Dismissed** not reachable\n\nI disagree.',
      'Dismissed, see above',
      '**Fixed** in 1a2b3c4',
      '**Fix this** please',
      '*Dismissed* italic only',
      '**Note** unrelated',
      '',
      null,
    ])
      expect(parseVerdict(body)).toBeNull();
  });
});

describe('dispositionOf', () => {
  it('reads a resolved thread as a decision only with a verdict', () => {
    expect(dispositionOf({ resolved: true })).toBe('resolved');
    expect(dispositionOf({ resolved: false })).toBe('open');
    expect(dispositionOf({ verdict: 'fix', resolved: false })).toBe('fix');
    expect(dispositionOf({ verdict: 'fix', resolved: true })).toBe('addressed');
    expect(dispositionOf({ verdict: 'optional', resolved: false })).toBe('optional');
    expect(dispositionOf({ verdict: 'optional', resolved: true })).toBe('optional');
    expect(dispositionOf({ verdict: 'dismiss', rationale: 'Guarded upstream.', resolved: true })).toBe(
      'dismissed',
    );
    expect(dispositionOf({ verdict: 'dismiss', rationale: 'Guarded upstream.', resolved: false })).toBe(
      'dismissed',
    );
  });

  it('does not count a dismissal that gives no reason', () => {
    expect(dispositionOf({ verdict: 'dismiss', rationale: null, resolved: true })).toBe('resolved');
    expect(dispositionOf({ verdict: 'dismiss', rationale: '', resolved: false })).toBe('open');
  });
});

describe('buildReviewHistory', () => {
  const finding = said(1, 'octo-reviewer', 'Cart total ignores the coupon');

  it('gives each thread the disposition its verdict and state amount to', () => {
    const built = history([
      thread('T_open', [finding]),
      thread('T_resolved', [said(2, 'octo-reviewer', 'Stock can go negative')], { resolved: true }),
      thread('T_fix', [
        said(3, 'octo-reviewer', 'Lost update'),
        said(4, 'octo-reviewer', '**Fix** Reproduced.', 1),
      ]),
      thread(
        'T_addressed',
        [
          said(5, 'octo-reviewer', 'Missing await'),
          said(6, 'octo-reviewer', '**Fix** The promise is dropped.', 1),
          said(7, 'dev-ana', 'Fixed in 1a2b3c4', 2),
        ],
        { resolved: true },
      ),
      thread('T_optional', [
        said(8, 'octo-reviewer', 'Name is vague'),
        said(9, 'octo-reviewer', '**Optional** Cleanup.', 1),
      ]),
      thread(
        'T_optional_closed',
        [
          said(10, 'octo-reviewer', 'Duplicate helper'),
          said(11, 'octo-reviewer', '**Optional** Could reuse.', 1),
        ],
        { resolved: true },
      ),
      thread(
        'T_dismissed',
        [
          said(12, 'octo-reviewer', 'Null deref'),
          said(13, 'octo-reviewer', '**Dismissed** Guarded at lib/a.js:4.', 1),
        ],
        { resolved: true },
      ),
    ]);
    expect(built.threads.map((t) => [t.threadId, t.disposition, t.suppressible])).toEqual([
      ['T_open', 'open', false],
      // Resolved with no verdict is not a dismissal, and stops nothing.
      ['T_resolved', 'resolved', false],
      ['T_fix', 'fix', false],
      ['T_addressed', 'addressed', true],
      ['T_optional', 'optional', false],
      ['T_optional_closed', 'optional', true],
      ['T_dismissed', 'dismissed', true],
    ]);
    expect(reviewHistoryCounts(built)).toEqual({
      threads: 7,
      withoutThread: 0,
      dispositions: { open: 1, resolved: 1, fix: 1, addressed: 1, optional: 2, dismissed: 1 },
    });
    expect(built.threads[3]).toMatchObject({ repliesSinceDecision: 1 });
  });

  it('lets the latest verdict win', () => {
    const built = only([
      thread(
        'T',
        [
          finding,
          said(2, 'octo-reviewer', '**Fix** Reproduced.', 1),
          said(3, 'dev-ana', 'The coupon is applied in checkout, see lib/checkout.js:40', 2),
          said(4, 'octo-reviewer', '**Dismissed** Right: applied in lib/checkout.js:40.', 3),
        ],
        { resolved: true },
      ),
    ]);
    expect(built).toMatchObject({
      disposition: 'dismissed',
      decision: {
        verdict: 'dismiss',
        rationale: 'Right: applied in lib/checkout.js:40.',
        decidedBy: 'octo-reviewer',
        source: 'github',
        decidedAt: minute(3),
        recordedOnGithub: true,
      },
      repliesSinceDecision: 0,
    });
    // And the other way round: dismissed first, required later.
    expect(
      only([
        thread('T', [
          finding,
          said(2, 'octo-reviewer', '**Dismissed** Looked unreachable.', 1),
          said(3, 'octo-reviewer', '**Fix** Reachable through the importer.', 2),
        ]),
      ]).disposition,
    ).toBe('fix');
  });

  it('counts a verdict only from a reviewing account', () => {
    const stranger = thread('T', [finding, said(2, 'mallory', '**Dismissed** Trust me, this is fine.', 1)], {
      resolved: true,
    });
    // A stranger's reply decides nothing: the thread is merely resolved.
    expect(only([stranger])).toMatchObject({ disposition: 'resolved', suppressible: false, decision: null });
    expect(only([stranger]).replies[0]).toMatchObject({
      author: 'mallory',
      authorIsReviewer: false,
      verdict: null,
    });
    // Not even after a real verdict: the reviewer's Fix stands, with the reply noted as new.
    expect(
      only([
        thread('T', [
          finding,
          said(2, 'octo-reviewer', '**Fix** Reproduced.', 1),
          said(3, 'mallory', '**Dismissed** Not a bug.', 2),
        ]),
      ]),
    ).toMatchObject({ disposition: 'fix', repliesSinceDecision: 1 });
    // The account the review's agent posts as counts too, whatever its case.
    expect(only([stranger], { reviewerLogins: ['Mallory'] })).toMatchObject({
      disposition: 'dismissed',
      decision: { decidedBy: 'mallory' },
    });
    // No known account at all: nothing on GitHub is taken as a decision.
    expect(
      only([thread('T', [finding, said(2, 'octo-reviewer', '**Dismissed** Guarded.', 1)])], {
        viewer: null,
        reviewerLogins: [null, undefined],
      }).disposition,
    ).toBe('open');
    // A comment whose account is gone answers for nothing.
    expect(only([thread('T', [finding, said(2, null, '**Dismissed** Guarded.', 1)])]).disposition).toBe(
      'open',
    );
  });

  it('keeps an outdated thread’s decision and says the code moved', () => {
    const built = only([
      thread('T', [finding, said(2, 'octo-reviewer', '**Dismissed** Guarded at lib/a.js:4.', 1)], {
        resolved: true,
        outdated: true,
      }),
    ]);
    expect(built).toMatchObject({ disposition: 'dismissed', suppressible: true, outdated: true });
    expect(only([thread('T', [finding], { outdated: true })])).toMatchObject({
      disposition: 'open',
      outdated: true,
    });
  });

  it('tells a comment raised on the reviewed head from an older one', () => {
    const built = history([
      thread('T_now', [said(1, 'octo-reviewer', 'Posted by the interrupted attempt', 0, head)]),
      thread('T_then', [said(2, 'octo-reviewer', 'From the last round', 0, earlier)]),
      thread('T_human', [said(3, 'dev-ana', 'A person’s comment', 0, head)]),
    ]);
    expect(built.threads.map((t) => [t.raisedOnThisHead, t.authorIsReviewer, t.raisedSha])).toEqual([
      [true, true, head],
      [false, true, earlier],
      [true, false, head],
    ]);
  });

  it('gives a thread the same reference every time, and the stored one once there is one', () => {
    const first = only([thread('T', [finding])]);
    expect(first.findingRef).toBe(findingRefFor('acme/shop', 7, 1));
    expect(first.findingRef).toMatch(/^[0-9a-f]{16}$/);
    expect(findingRefFor('Acme/Shop', 7, 1)).toBe(first.findingRef);
    expect(findingRefFor('acme/shop', 8, 1)).not.toBe(first.findingRef);
    expect(findingRefFor('acme/shop', 7, 2)).not.toBe(first.findingRef);
    const stored = only([thread('T', [finding])], {
      decisions: [{ anchor: 'T', threadId: 'T', findingRef: 'ref-carried', title: 'Coupon ignored' }],
    });
    expect(stored).toMatchObject({ findingRef: 'ref-carried', title: 'Coupon ignored', disposition: 'open' });
  });

  describe('with stored decisions', () => {
    const stored = (overrides = {}) => ({
      anchor: 'T',
      threadId: 'T',
      findingRef: 'ref-1',
      verdict: 'dismiss',
      rationale: 'The caller caps retries at three.',
      source: 'review',
      decidedBy: 'session:earlier',
      headSha: earlier,
      decidedAt: new Date(minute(5)).toISOString(),
      ...overrides,
    });

    it('trusts a decision Briareus stored when GitHub shows none from a reviewing account', () => {
      const built = history(
        [
          thread('T', [finding, said(2, 'other-account', '**Dismissed** Capped at three.', 1)], {
            resolved: true,
          }),
        ],
        { decisions: [stored()] },
      );
      expect(built.threads[0]).toMatchObject({
        disposition: 'dismissed',
        suppressible: true,
        findingRef: 'ref-1',
        decision: {
          verdict: 'dismiss',
          rationale: 'The caller caps retries at three.',
          source: 'review',
          decidedBy: 'session:earlier',
          recordedOnGithub: false,
        },
      });
      // What was seen is refreshed; the stored verdict is not rewritten.
      expect(built.sync).toEqual([
        {
          anchor: 'T',
          threadId: 'T',
          commentId: 1,
          findingRef: 'ref-1',
          filePath: 'lib/cart.js',
          line: 10,
          raisedSha: earlier,
          resolved: true,
        },
      ]);
    });

    it('lets a client’s later decision stand over the verdict reply on GitHub', () => {
      const replied = thread(
        'T',
        [finding, said(2, 'octo-reviewer', '**Dismissed** Looked unreachable.', 1)],
        { resolved: true },
      );
      const overridden = history([replied], {
        decisions: [
          stored({
            verdict: 'fix',
            rationale: 'Reachable through the importer.',
            source: 'api',
            decidedBy: 'user:4',
          }),
        ],
      });
      expect(overridden.threads[0]).toMatchObject({
        // A required fix on a resolved thread: to suppress it the agent must find it fixed.
        disposition: 'addressed',
        decision: { verdict: 'fix', source: 'api', decidedBy: 'user:4', recordedOnGithub: false },
      });
      expect(overridden.sync[0]).not.toHaveProperty('verdict');
      // A verdict cleared since leaves the thread undecided, whatever the old reply says.
      expect(
        history([replied], { decisions: [stored({ verdict: null, rationale: null, source: 'api' })] })
          .threads[0],
      ).toMatchObject({
        disposition: 'resolved',
        suppressible: false,
      });
    });

    it('lets a later verdict reply on GitHub stand over the stored decision, and stores it', () => {
      const built = history(
        [thread('T', [finding, said(2, 'octo-reviewer', '**Fix** Reachable through the importer.', 9)])],
        { decisions: [stored()] },
      );
      expect(built.threads[0]).toMatchObject({
        disposition: 'fix',
        decision: { verdict: 'fix', source: 'github', decidedBy: 'octo-reviewer', recordedOnGithub: true },
      });
      expect(built.sync[0]).toMatchObject({
        anchor: 'T',
        verdict: 'fix',
        rationale: 'Reachable through the importer.',
        source: 'github',
        decidedBy: 'octo-reviewer',
        // Another verdict than the stored one, so the stored head is not its head.
        headSha: null,
        decidedAt: minute(9),
        resolved: false,
      });
      // The same verdict restated on GitHub keeps the head it was first given on.
      expect(
        history([thread('T', [finding, said(2, 'octo-reviewer', '**Dismissed** Capped at three.', 9)])], {
          decisions: [stored()],
        }).sync[0],
      ).toMatchObject({ verdict: 'dismiss', headSha: earlier });
    });

    it('stores a verdict found on a thread nothing was stored for, and no undecided stranger', () => {
      const built = history([
        thread('T_new', [finding, said(2, 'octo-reviewer', '**Dismissed** Guarded.', 1)], { resolved: true }),
        thread('T_plain', [said(3, 'dev-ana', 'A question')]),
      ]);
      expect(built.sync).toEqual([
        expect.objectContaining({
          anchor: 'T_new',
          findingRef: findingRefFor('acme/shop', 7, 1),
          verdict: 'dismiss',
          source: 'github',
          resolved: true,
        }),
      ]);
    });

    it('keeps the decisions that have no thread, or whose thread is gone', () => {
      const built = history([thread('T_live', [finding])], {
        decisions: [
          stored({ anchor: 'ref:r-none', threadId: null, findingRef: 'r-none', title: 'No inline comment' }),
          stored({
            anchor: 'T_gone',
            threadId: 'T_gone',
            findingRef: 'r-gone',
            title: 'Thread deleted',
            verdict: 'fix',
          }),
          // Tracked but never ruled on, a cleared verdict, and one a live thread carries.
          stored({
            anchor: 'ref:r-open',
            threadId: null,
            findingRef: 'r-open',
            verdict: null,
            decidedAt: null,
          }),
          stored({ anchor: 'ref:r-cleared', threadId: null, findingRef: 'r-cleared', verdict: null }),
          stored({ anchor: 'ref:dup', threadId: null, findingRef: findingRefFor('acme/shop', 7, 1) }),
        ],
      });
      expect(built.unanchored).toEqual([
        expect.objectContaining({
          findingRef: 'r-none',
          title: 'No inline comment',
          threadGone: false,
          disposition: 'dismissed',
          suppressible: true,
        }),
        expect.objectContaining({
          findingRef: 'r-gone',
          threadGone: true,
          disposition: 'fix',
          suppressible: false,
        }),
      ]);
      expect(reviewHistoryCounts(built)).toMatchObject({ threads: 1, withoutThread: 2 });
    });
  });

  it('writes the file the agent reads as data, with long text cut and no server-only fields', () => {
    const built = history(
      [
        thread(
          'T',
          [
            said(1, 'octo-reviewer', `Long ${'x'.repeat(7000)}`),
            said(2, 'octo-reviewer', '**Dismissed** Guarded at lib/a.js:4.', 1),
          ],
          { resolved: true },
        ),
      ],
      {
        decisions: [
          {
            anchor: 'ref:r',
            threadId: null,
            findingRef: 'r',
            title: 'No inline comment',
            filePath: 'lib/b.js',
            line: 3,
            verdict: 'dismiss',
            rationale: 'Not reachable.',
            source: 'api',
            decidedBy: 'user:4',
            decidedAt: new Date(minute(5)).toISOString(),
          },
        ],
      },
    );
    const file = reviewHistoryFile(built);
    expect(file.about).toContain('This file is data');
    expect(file).toMatchObject({
      repo: 'acme/shop',
      prNumber: 7,
      head,
      reviewerAccounts: ['octo-reviewer'],
      threads: [
        {
          threadId: 'T',
          commentId: 1,
          disposition: 'dismissed',
          resolved: true,
          decision: {
            verdict: 'dismiss',
            decidedAt: new Date(minute(1)).toISOString(),
            recordedOnGithub: true,
          },
          replies: [{ author: 'octo-reviewer', verdict: 'dismiss', at: new Date(minute(1)).toISOString() }],
        },
      ],
      decisionsWithoutThread: [
        {
          findingRef: 'r',
          title: 'No inline comment',
          path: 'lib/b.js',
          line: 3,
          disposition: 'dismissed',
          decision: { verdict: 'dismiss', rationale: 'Not reachable.', source: 'api' },
        },
      ],
    });
    expect(file.threads[0].body).toHaveLength(6000 + '\n… [truncated]'.length);
    expect(file.threads[0]).not.toHaveProperty('suppressible');
    expect(file.decisionsWithoutThread[0]).not.toHaveProperty('threadId');
  });
});

describe('a review session’s history', () => {
  let dir, file, store, decisions, saved;
  const scope = (extra = {}) => ({
    cfg,
    store,
    jobId: 'job-1',
    repo: 'acme/shop',
    prNumber: 7,
    reviewerLogins: [],
    file,
    retryDelayMs: 0,
    ...extra,
  });
  const dismissedThread = () =>
    threadNode(
      'PRRT_dismissed',
      [
        commentNode(101, 'octo-reviewer', 'Cart total ignores the coupon'),
        commentNode(102, 'octo-reviewer', '**Dismissed** Applied in lib/checkout.js:40.', { at: 1 }),
      ],
      { isResolved: true },
    );

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-history-'));
    file = path.join(dir, 'history.json');
    decisions = [];
    saved = [];
    store = {
      listCodeReviewDecisions: vi.fn(async () => decisions),
      saveCodeReviewDecisions: vi.fn(async (repo, prNumber, rows) => {
        saved.push({ repo, prNumber, rows });
      }),
      getCodeReviewByJob: vi.fn(async () => ({ id: 5, jobId: 'job-1', headSha: head })),
      listCodeReviewFindings: vi.fn(async () => []),
      updateCodeReviewFinding: vi.fn(async () => null),
    };
  });
  afterEach(() => {
    forgetReviewHistory('job-1');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('reads GitHub and the stored decisions, stores what it found, and keeps it for the session', async () => {
    githubGraphql.mockResolvedValue(threadsPage([dismissedThread()]));
    const loaded = await loadReviewHistory(scope({ head }));
    expect(store.listCodeReviewDecisions).toHaveBeenCalledWith('acme/shop', 7);
    expect(saved).toEqual([
      {
        repo: 'acme/shop',
        prNumber: 7,
        rows: [expect.objectContaining({ anchor: 'PRRT_dismissed', verdict: 'dismiss' })],
      },
    ]);
    expect(loaded.threads[0].disposition).toBe('dismissed');
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).threads[0]).toMatchObject({
      threadId: 'PRRT_dismissed',
      disposition: 'dismissed',
    });
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    const held = reviewHistoryOf('job-1');
    expect(held.threads.get('PRRT_dismissed')).toEqual({
      threadId: 'PRRT_dismissed',
      findingRef: findingRefFor('acme/shop', 7, 101),
      commentId: 101,
      url: 'https://github.com/acme/shop/pull/7#discussion_r101',
      resolved: true,
      raisedSha: earlier,
      disposition: 'dismissed',
      suppressible: true,
      verdict: 'dismiss',
      rationale: 'Applied in lib/checkout.js:40.',
    });
    // Replies are known too, so none can be passed off as a new comment.
    expect([...held.comments]).toEqual([
      [101, 'PRRT_dismissed'],
      [102, 'PRRT_dismissed'],
    ]);
    expect(reviewHistoryOf('job-2')).toBeNull();
    forgetReviewHistory('job-1');
    expect(reviewHistoryOf('job-1')).toBeNull();
  });

  it('will not follow a link planted where the file goes', async () => {
    githubGraphql.mockResolvedValue(threadsPage([]));
    const target = path.join(dir, 'elsewhere');
    fs.writeFileSync(target, 'untouched');
    fs.symlinkSync(target, file);
    await expect(loadReviewHistory(scope({ head }))).rejects.toThrow(/ELOOP/);
    expect(fs.readFileSync(target, 'utf8')).toBe('untouched');
    expect(reviewHistoryOf('job-1')).toBeNull();
  });

  it('keeps nothing when the read fails anywhere', async () => {
    githubGraphql.mockRejectedValue(new Error('GitHub GraphQL answered 502'));
    await expect(loadReviewHistory(scope({ head }))).rejects.toThrow('GitHub GraphQL answered 502');
    githubGraphql.mockResolvedValue(threadsPage([dismissedThread()], { headRefOid: 'c'.repeat(40) }));
    await expect(loadReviewHistory(scope({ head }))).rejects.toThrow('The PR changed during review');
    githubGraphql.mockResolvedValue(threadsPage([dismissedThread()]));
    store.listCodeReviewDecisions.mockRejectedValueOnce(new Error('Database unavailable'));
    await expect(loadReviewHistory(scope({ head }))).rejects.toThrow('Database unavailable');
    store.saveCodeReviewDecisions.mockRejectedValueOnce(new Error('write failed'));
    await expect(loadReviewHistory(scope({ head }))).rejects.toThrow('write failed');
    await expect(loadReviewHistory(scope({ head, prNumber: undefined }))).rejects.toThrow('no pull request');
    expect(reviewHistoryOf('job-1')).toBeNull();
    expect(fs.existsSync(file)).toBe(false);
  });

  it('ties each published finding to the thread its comment became, and tracks it', async () => {
    githubGraphql.mockResolvedValue(
      threadsPage(
        [
          dismissedThread(),
          threadNode('PRRT_new', [commentNode(501, 'octo-reviewer', 'Lost update', { commit: head })], {
            line: 44,
          }),
          threadNode('PRRT_adopted', [
            commentNode(601, 'octo-reviewer', 'Missing await'),
            commentNode(602, 'dev-ana', 'Is it?', { at: 1 }),
          ]),
        ],
        // The PR moved on while the step published: linking does not mind.
        { headRefOid: 'c'.repeat(40) },
      ),
    );
    store.listCodeReviewFindings.mockResolvedValue([
      {
        id: 1,
        title: 'Lost update',
        filePath: 'lib/cart.js',
        startLine: 44,
        findingRef: 'ref-new',
        commentId: 501,
        headSha: head,
      },
      // Adopted when registered: already tied, tracked under the thread's reference.
      {
        id: 2,
        title: 'Missing await',
        findingRef: 'ref-adopted',
        reconciliation: 'adopted',
        threadId: 'PRRT_adopted',
        commentId: 601,
      },
      // Registered with the id of a reply: still that thread.
      {
        id: 3,
        title: 'Reply id',
        findingRef: 'ref-reply',
        commentId: 602,
        shouldFix: 'fix',
        comments: 'Reproduced.',
        updatedAt: new Date(minute(7)).toISOString(),
      },
      {
        id: 4,
        title: 'Suppressed',
        findingRef: 'ref-s',
        reconciliation: 'suppressed',
        priorThreadId: 'PRRT_dismissed',
        shouldFix: 'dismiss',
      },
      { id: 5, title: 'No inline comment', findingRef: 'ref-none' },
      { id: 6, title: 'Comment from another PR', findingRef: 'ref-x', commentId: 999 },
    ]);
    const result = await linkPublishedFindings(scope());
    expect(result).toEqual({ linked: 2, unmatched: [6] });
    expect(store.updateCodeReviewFinding.mock.calls).toEqual([
      [5, 1, { threadId: 'PRRT_new' }],
      [5, 3, { threadId: 'PRRT_adopted' }],
    ]);
    const tracked = saved.at(-1).rows;
    expect(tracked).toEqual([
      {
        anchor: 'PRRT_new',
        threadId: 'PRRT_new',
        commentId: 501,
        findingRef: 'ref-new',
        title: 'Lost update',
        filePath: 'lib/cart.js',
        line: 44,
        raisedSha: head,
        resolved: false,
      },
      expect.objectContaining({
        anchor: 'PRRT_adopted',
        commentId: 601,
        findingRef: 'ref-adopted',
        title: 'Missing await',
      }),
      // A verdict the finding already carries is stored with the thread, dated as recorded.
      expect.objectContaining({
        anchor: 'PRRT_adopted',
        findingRef: 'ref-reply',
        verdict: 'fix',
        rationale: 'Reproduced.',
        source: 'review',
        decidedBy: 'session:job-1',
        headSha: head,
        decidedAt: minute(7),
      }),
    ]);
    expect(tracked[0]).not.toHaveProperty('verdict');
    // The history kept for the session is the fresh one, new thread included.
    expect(reviewHistoryOf('job-1').comments.get(501)).toBe('PRRT_new');
  });

  it('links nothing for a session without a review row, and fails as a whole when GitHub does', async () => {
    githubGraphql.mockResolvedValue(threadsPage([]));
    store.getCodeReviewByJob.mockResolvedValue(null);
    expect(await linkPublishedFindings(scope())).toEqual({ linked: 0, unmatched: [] });
    expect(store.listCodeReviewFindings).not.toHaveBeenCalled();
    githubGraphql.mockRejectedValue(new Error('GitHub GraphQL answered 502'));
    await expect(linkPublishedFindings(scope())).rejects.toThrow('502');
  });
});

describe('reconcileFinding', () => {
  const review = { repo: 'acme/shop', prNumber: 7, head };
  let held;
  beforeEach(async () => {
    const rule = (id, root, verdict, extra) =>
      threadNode(
        id,
        [
          commentNode(root, 'octo-reviewer', `Claim ${id}`),
          ...(verdict ? [commentNode(root + 1, 'octo-reviewer', verdict, { at: 1 })] : []),
        ],
        extra,
      );
    githubGraphql.mockResolvedValue(
      threadsPage([
        rule('T_dismissed', 10, '**Dismissed** Guarded at lib/a.js:4.', { isResolved: true }),
        rule('T_addressed', 20, '**Fix** Reproduced.', { isResolved: true }),
        rule('T_optional_closed', 30, '**Optional** Cleanup.', { isResolved: true }),
        rule('T_resolved', 40, null, { isResolved: true }),
        rule('T_open', 50, null),
        rule('T_fix', 60, '**Fix** Reproduced.'),
        rule('T_optional', 70, '**Optional** Cleanup.'),
        rule('T_bare', 80, '**Dismissed**', { isResolved: true }),
      ]),
    );
    await loadReviewHistory({
      cfg,
      jobId: 'job-r',
      repo: 'acme/shop',
      prNumber: 7,
      head,
      store: {
        listCodeReviewDecisions: async () => [
          {
            anchor: 'ref:r-none',
            threadId: null,
            findingRef: 'r-none',
            verdict: 'dismiss',
            rationale: 'Not reachable.',
            source: 'api',
            decidedAt: new Date(minute(5)).toISOString(),
          },
          {
            anchor: 'ref:r-fix',
            threadId: null,
            findingRef: 'r-fix',
            verdict: 'fix',
            rationale: 'Reproduced.',
            source: 'review',
            decidedAt: new Date(minute(5)).toISOString(),
          },
        ],
        saveCodeReviewDecisions: async () => {},
      },
    });
    held = reviewHistoryOf('job-r');
  });
  afterEach(() => forgetReviewHistory('job-r'));
  const place = (input, history = held) => reconcileFinding(history, input, review);
  const refused = (input, history = held) => {
    try {
      place(input, history);
    } catch (e) {
      return { status: e.status, message: e.message };
    }
    return null;
  };

  it('registers a new finding under a reference of its own', () => {
    expect(place({ commentId: 900 })).toEqual({
      reconciliation: 'new',
      headSha: head,
      commentId: 900,
      findingRef: findingRefFor('acme/shop', 7, 900),
    });
    const unposted = place({});
    expect(unposted).toMatchObject({ reconciliation: 'new', commentId: null, headSha: head });
    expect(unposted.findingRef).toMatch(/^[0-9a-f]{16}$/);
    expect(place({}).findingRef).not.toBe(unposted.findingRef);
    // A session that read no history (an older flow, a chat turn) still registers new findings.
    expect(place({ reconciliation: 'new', commentId: 10 }, null)).toMatchObject({ commentId: 10 });
  });

  it('refuses a new finding that points at earlier threads or passes off an existing comment', () => {
    for (const extra of [
      { priorThreadId: 'T_open' },
      { priorFindingRef: 'r-none' },
      { revisitReason: 'changed' },
    ])
      expect(refused(extra)).toMatchObject({
        status: 400,
        message: expect.stringContaining('go with reconciliation'),
      });
    // The root of an earlier thread, and a reply in one.
    for (const commentId of [10, 11, 50])
      expect(refused({ commentId })).toMatchObject({
        status: 400,
        message: expect.stringContaining(`Comment ${commentId} was on the PR before this publication`),
      });
  });

  it('suppresses only against a claim that was really dismissed or addressed', () => {
    expect(place({ reconciliation: 'suppressed', priorThreadId: 'T_dismissed' })).toEqual({
      reconciliation: 'suppressed',
      headSha: head,
      findingRef: findingRefFor('acme/shop', 7, 10),
      priorThreadId: 'T_dismissed',
      priorDisposition: 'dismissed',
      priorReason: 'Guarded at lib/a.js:4.',
      priorUrl: 'https://github.com/acme/shop/pull/7#discussion_r10',
      // The earlier decision is the finding's verdict, with its reason kept.
      shouldFix: 'dismiss',
      comments:
        'Not repeated: already dismissed in https://github.com/acme/shop/pull/7#discussion_r10. Guarded at lib/a.js:4.',
    });
    expect(place({ reconciliation: 'suppressed', priorThreadId: 'T_addressed' })).toMatchObject({
      priorDisposition: 'addressed',
      shouldFix: 'dismiss',
      comments: expect.stringContaining(
        'already addressed in https://github.com/acme/shop/pull/7#discussion_r20, and still fixed.',
      ),
    });
    // Optional stays optional: confirmed and not required is not refuted.
    expect(place({ reconciliation: 'suppressed', priorThreadId: 'T_optional_closed' })).toMatchObject({
      priorDisposition: 'optional',
      shouldFix: 'optional',
    });
    expect(
      place({ reconciliation: 'suppressed', priorFindingRef: 'r-none', comments: 'Same as before.' }),
    ).toMatchObject({
      findingRef: 'r-none',
      priorThreadId: null,
      priorDisposition: 'dismissed',
      priorReason: 'Not reachable.',
      priorUrl: null,
      shouldFix: 'dismiss',
      comments: 'Same as before.',
    });
    for (const [priorThreadId, why] of [
      ['T_resolved', 'resolved without a verdict, which is not a decision'],
      ['T_open', 'still open with no verdict'],
      ['T_fix', 'an open required fix'],
      ['T_optional', 'optional feedback'],
      // A dismissal with no reason decided nothing.
      ['T_bare', 'resolved without a verdict, which is not a decision'],
    ])
      expect(refused({ reconciliation: 'suppressed', priorThreadId })).toMatchObject({
        status: 400,
        message: expect.stringContaining(
          `Thread ${priorThreadId} is ${why}, not a claim that was dismissed or addressed`,
        ),
      });
    expect(refused({ reconciliation: 'suppressed', priorFindingRef: 'r-fix' }).message).toContain(
      'Decision r-fix is an open required fix',
    );
  });

  it('refuses a suppression that names nothing real, is posted, or sets its own verdict', () => {
    expect(refused({ reconciliation: 'suppressed' }).message).toContain(
      'exactly one of priorThreadId or priorFindingRef',
    );
    expect(
      refused({ reconciliation: 'suppressed', priorThreadId: 'T_dismissed', priorFindingRef: 'r-none' })
        .message,
    ).toContain('exactly one of');
    // A thread of another pull request is not in this one's history.
    expect(refused({ reconciliation: 'suppressed', priorThreadId: 'PRRT_elsewhere' })).toEqual({
      status: 400,
      message: 'Thread PRRT_elsewhere is not in this PR’s review history',
    });
    // Thread ids are case-sensitive.
    expect(refused({ reconciliation: 'suppressed', priorThreadId: 't_dismissed' }).message).toContain(
      'is not in this PR',
    );
    expect(refused({ reconciliation: 'suppressed', priorFindingRef: 'r-unknown' }).message).toContain(
      'No earlier decision r-unknown',
    );
    const prior = { reconciliation: 'suppressed', priorThreadId: 'T_dismissed' };
    expect(refused({ ...prior, commentId: 900 }).message).toContain('carries no commentId');
    expect(refused({ ...prior, shouldFix: 'fix' }).message).toContain(
      'leave shouldFix and verification unset',
    );
    expect(refused({ ...prior, verification: 'confirmed' }).message).toContain('leave shouldFix');
    expect(refused({ ...prior, revisitReason: 'changed' }).message).toContain('revisitReason goes with');
    // Without the history the server read, nothing can be claimed about earlier threads.
    expect(refused(prior, null)).toMatchObject({
      status: 409,
      message: expect.stringContaining('has not read'),
    });
  });

  it('adopts only a thread still open', () => {
    for (const [priorThreadId, commentId, priorDisposition] of [
      ['T_open', 50, 'open'],
      ['T_fix', 60, 'fix'],
      ['T_optional', 70, 'optional'],
    ])
      expect(place({ reconciliation: 'adopted', priorThreadId, commentId: 123 })).toEqual({
        reconciliation: 'adopted',
        headSha: head,
        findingRef: findingRefFor('acme/shop', 7, commentId),
        priorThreadId,
        priorDisposition,
        priorReason: priorDisposition === 'open' ? null : expect.any(String),
        priorUrl: `https://github.com/acme/shop/pull/7#discussion_r${commentId}`,
        // The thread's own first comment, whatever id the agent sent.
        threadId: priorThreadId,
        commentId,
      });
    for (const priorThreadId of ['T_dismissed', 'T_addressed', 'T_optional_closed', 'T_resolved', 'T_bare'])
      expect(refused({ reconciliation: 'adopted', priorThreadId })).toMatchObject({
        status: 400,
        message: expect.stringContaining('only an unresolved thread is adopted'),
      });
    expect(refused({ reconciliation: 'adopted', priorFindingRef: 'r-none' }).message).toContain(
      'only an unresolved thread',
    );
    expect(
      refused({ reconciliation: 'adopted', priorThreadId: 'T_open', revisitReason: 'x' }).message,
    ).toContain('revisitReason goes with');
  });

  it('reopens a decided claim only with what changed', () => {
    expect(
      place({
        reconciliation: 'revisit',
        priorThreadId: 'T_dismissed',
        commentId: 901,
        revisitReason: 'The guard at lib/a.js:4 was removed in this push.',
      }),
    ).toEqual({
      reconciliation: 'revisit',
      headSha: head,
      // The claim keeps its reference; the new comment is its second thread.
      findingRef: findingRefFor('acme/shop', 7, 10),
      priorThreadId: 'T_dismissed',
      priorDisposition: 'dismissed',
      priorReason: 'Guarded at lib/a.js:4.',
      priorUrl: 'https://github.com/acme/shop/pull/7#discussion_r10',
      commentId: 901,
      revisitReason: 'The guard at lib/a.js:4 was removed in this push.',
    });
    expect(
      place({
        reconciliation: 'revisit',
        priorThreadId: 'T_addressed',
        revisitReason: 'The fix was reverted.',
      }),
    ).toMatchObject({ priorDisposition: 'addressed', commentId: null });
    expect(
      place({
        reconciliation: 'revisit',
        priorFindingRef: 'r-none',
        revisitReason: 'Now reachable from the importer.',
      }),
    ).toMatchObject({ findingRef: 'r-none', priorThreadId: null });
    expect(refused({ reconciliation: 'revisit', priorThreadId: 'T_dismissed', commentId: 901 })).toEqual({
      status: 400,
      message:
        'Thread T_dismissed is dismissed: a revisit must say in revisitReason what changed since, the changed code or the new evidence that invalidates that decision',
    });
    // Nothing was decided on these, so there is nothing to revisit.
    for (const priorThreadId of ['T_resolved', 'T_open', 'T_fix'])
      expect(
        refused({ reconciliation: 'revisit', priorThreadId, revisitReason: 'changed' }).message,
      ).toContain('not a claim that was dismissed or addressed');
    expect(
      refused({ reconciliation: 'revisit', priorThreadId: 'T_open', revisitReason: 'x' }).message,
    ).toContain('adopt the open thread instead');
    expect(
      refused({ reconciliation: 'revisit', priorThreadId: 'T_resolved', revisitReason: 'x' }).message,
    ).toContain('register the finding as new');
    // The earlier thread's own comment is not the revisit's new one.
    expect(
      refused({
        reconciliation: 'revisit',
        priorThreadId: 'T_dismissed',
        commentId: 10,
        revisitReason: 'changed',
      }).message,
    ).toContain('Comment 10 was on the PR before');
  });
});

describe('findingDecision', () => {
  const review = { headSha: head };
  const who = { source: 'review', decidedBy: 'session:job-1', now: 1234 };

  it('lands on the finding’s own thread', () => {
    expect(
      findingDecision(
        review,
        {
          findingRef: 'ref-1',
          threadId: 'T_own',
          commentId: 501,
          title: 'Lost update',
          filePath: 'lib/cart.js',
          startLine: 44,
          shouldFix: 'dismiss',
          comments: 'Guarded upstream.',
          headSha: earlier,
        },
        who,
      ),
    ).toEqual({
      anchor: 'T_own',
      threadId: 'T_own',
      commentId: 501,
      findingRef: 'ref-1',
      title: 'Lost update',
      filePath: 'lib/cart.js',
      line: 44,
      verdict: 'dismiss',
      rationale: 'Guarded upstream.',
      source: 'review',
      decidedBy: 'session:job-1',
      headSha: head,
      raisedSha: earlier,
      decidedAt: 1234,
    });
  });

  it('rules on the earlier thread for a suppressed duplicate, and is keyed by reference without one', () => {
    expect(
      findingDecision(
        review,
        {
          findingRef: 'ref-1',
          reconciliation: 'suppressed',
          priorThreadId: 'T_prior',
          shouldFix: 'fix',
          comments: 'Real after all.',
        },
        { source: 'api', decidedBy: 'user:4', now: 1 },
      ),
    ).toMatchObject({
      anchor: 'T_prior',
      threadId: 'T_prior',
      commentId: null,
      verdict: 'fix',
      source: 'api',
      decidedBy: 'user:4',
    });
    // A revisit not yet tied to its new thread never writes to the thread it reopens.
    expect(
      findingDecision(
        review,
        { findingRef: 'ref-1', reconciliation: 'revisit', priorThreadId: 'T_prior', commentId: 9 },
        who,
      ),
    ).toMatchObject({ anchor: 'ref:ref-1', threadId: null, commentId: null });
    // A cleared verdict is a decision too: nothing stands any more.
    expect(
      findingDecision(review, { findingRef: 'ref-2', shouldFix: null, comments: null }, who),
    ).toMatchObject({
      anchor: 'ref:ref-2',
      threadId: null,
      verdict: null,
      rationale: null,
      decidedAt: 1234,
    });
    expect(findingDecision({}, { findingRef: 'ref-2' }, { source: 'api' })).toMatchObject({
      headSha: null,
      decidedBy: null,
      decidedAt: expect.any(Number),
    });
  });
});
