import { describe, expect, it } from 'vitest';
import { attentionItems } from '../lib/attention.js';
describe('operator attention', () => {
  it('includes unresolved work without treating idle or completed QA as failures', () => {
    const items = attentionItems([
      { id: 'a', status: 'idle', awaitingAnswer: true },
      { id: 'b', status: 'interrupted' },
      { id: 'c', status: 'idle', qaLoop: { done: true, failedScenarios: 0 } },
      { id: 'd', status: 'closed', awaitingAnswer: true },
      {
        id: 'e',
        status: 'idle',
        qaLoop: { failedScenarios: 2 },
      },
    ]);
    expect(items.map((i) => i.id)).toEqual(['a:question', 'b:recovery', 'e:qa-failed']);
  });
  it('surfaces incomplete manual coverage without calling it failed', () => {
    const items = attentionItems([
      { id: 'manual', status: 'idle', qaLoop: { done: true, incomplete: true, failedScenarios: 0 } },
    ]);
    expect(items.map((i) => i.id)).toEqual(['manual:qa-incomplete']);
    expect(items[0].summary).toContain('coverage is incomplete');
  });
  it('surfaces stalled loops and unreadable QA verdicts, but not a stall on a merged PR', () => {
    const items = attentionItems([
      { id: 'a', status: 'idle', qaLoop: { verdictError: 'sheet 404' } },
      { id: 'b', status: 'idle', prStatus: { state: 'merged' } },
    ]);
    expect(items.map((i) => i.id)).toEqual(['a:qa-verdict']);
    expect(items[0].summary).toContain('sheet 404');
  });
  it('lists a webhook that stopped taking deliveries, until the session is closed', () => {
    const paused = { kind: 'turns', reason: '10 automatic turns ran since your last message', at: 'x' };
    const items = attentionItems([
      { id: 'a', status: 'idle', webhook: { armed: true }, webhookPaused: paused },
      { id: 'b', status: 'idle', webhook: { armed: true }, webhookPaused: null },
      { id: 'c', status: 'closed', webhook: { armed: true }, webhookPaused: paused },
    ]);
    expect(items.map((i) => i.id)).toEqual(['a:webhook-paused']);
    expect(items[0]).toMatchObject({ summary: paused.reason, href: '/sessions/a', at: 'x' });
  });
  it('dates each item by when it began to wait, not by session creation', () => {
    const items = attentionItems([
      { id: 'old', status: 'idle', createdAt: '2026-09-01', awaitingAnswer: true, askedAt: '2026-09-26' },
      {
        id: 'new',
        status: 'idle',
        createdAt: '2026-09-20',
      },
    ]);
    expect(items.map((i) => [i.id, i.at])).toEqual([['old:question', '2026-09-26']]);
  });
  it('shows what was asked, and leaves a worker question to its open orchestrator', () => {
    const items = attentionItems([
      { id: 'o', status: 'idle', orchestrator: true },
      { id: 'w', status: 'idle', parentId: 'o', awaitingAnswer: true, askText: 'Keep it?' },
      { id: 'c', status: 'closed', orchestrator: true },
      {
        id: 'x',
        status: 'idle',
        parentId: 'c',
        awaitingAnswer: true,
        askText: 'Drop it?\nOptions: Drop | Keep',
      },
      { id: 'y', status: 'idle', parentId: 'gone', awaitingAnswer: true },
    ]);
    expect(items.map((i) => [i.id, i.summary])).toEqual([
      ['x:question', 'Drop it?\nOptions: Drop | Keep'],
      ['y:question', 'The agent needs your answer'],
    ]);
  });
  it('leaves a worker failure and its loop failure to an open orchestrator', () => {
    const failure = { status: 'failed', error: 'boom' };
    const items = attentionItems([
      { id: 'o', status: 'idle', orchestrator: true },
      { id: 'w', parentId: 'o', ...failure },
      { id: 'c', status: 'closed', orchestrator: true },
      { id: 'x', parentId: 'c', ...failure },
    ]);
    expect(items.map((i) => i.id)).toEqual(['x:recovery']);
  });
  it('leaves a worker stall and its QA results to an open orchestrator', () => {
    const loops = {
      status: 'idle',
      qaLoop: { failedScenarios: 2, verdictError: 'sheet 404' },
    };
    const items = attentionItems([
      { id: 'o', status: 'idle', orchestrator: true },
      { id: 'w', parentId: 'o', ...loops },
      { id: 'c', status: 'closed', orchestrator: true },
      { id: 'x', parentId: 'c', ...loops },
    ]);
    expect(items.map((i) => i.id)).toEqual(['x:qa-failed', 'x:qa-verdict']);
  });
  it('lists a worker item its open orchestrator only got as a plain line', () => {
    const items = attentionItems([
      { id: 'o', status: 'idle', orchestrator: true, unattendedTurns: 10 },
      {
        id: 'w',
        status: 'idle',
        parentId: 'o',
        awaitingAnswer: true,
        askText: 'Keep it?',
        noticeUnheard: true,
      },
      { id: 'f', status: 'failed', error: 'boom', parentId: 'o', noticeUnheard: true },
      { id: 'h', status: 'idle', parentId: 'o', awaitingAnswer: true, noticeUnheard: false },
    ]);
    expect(items.map((i) => i.id)).toEqual(['w:question', 'f:recovery']);
  });
  it('drops loop failures and QA results once the pull request is merged or closed', () => {
    const loops = {
      qaLoop: { failedScenarios: 2, verdictError: 'sheet 404' },
    };
    const items = attentionItems([
      { id: 'open', status: 'idle', prStatus: { state: 'open' }, ...loops },
      { id: 'merged', status: 'idle', prStatus: { state: 'merged' }, ...loops },
      { id: 'closed', status: 'idle', prStatus: { state: 'closed' }, ...loops },
    ]);
    expect(items.map((i) => i.id)).toEqual(['open:qa-failed', 'open:qa-verdict']);
  });
  it('lists a loop failure beside the recovery of an interrupted parent, as QA is', () => {
    const items = attentionItems([
      {
        id: 'p',
        status: 'interrupted',
        qaLoop: { failedScenarios: 1 },
      },
    ]);
    expect(items.map((i) => i.id)).toEqual(['p:recovery', 'p:qa-failed']);
  });
  it('preserves the exact SSH approval and its destination', () => {
    const request = {
      id: 'ssh1',
      createdAt: 1,
      jobId: 'a',
      sessionTitle: 'Fix the deploy',
      command: 'echo hello',
      host: 'host',
    };
    expect(attentionItems([], [request])[0]).toMatchObject({
      id: 'ssh:ssh1',
      request,
      sessionTitle: 'Fix the deploy',
      href: '/sessions/a',
    });
  });
  it('lists a pull request whose review outcome GitHub does not carry, with what it shows instead', () => {
    const failing = {
      repo: 'acme/shop',
      prNumber: 7,
      headSha: 'b'.repeat(40),
      outcome: 'changes_required',
      state: 'failure',
      publishedSha: 'b'.repeat(40),
      publishedState: 'success',
      error: 'GitHub answered 403 (Forbidden): the server’s GitHub token may not write commit statuses',
      errorStatus: 403,
      attempts: 4,
      failedAt: '2026-11-10T12:00:00.000Z',
      retryAt: '2026-11-10T12:08:00.000Z',
    };
    const [item] = attentionItems([], [], [], [], [failing]);
    expect(item).toEqual({
      id: 'review-status:acme/shop#7',
      kind: 'review-status',
      sessionId: null,
      taskId: null,
      revision: `${'b'.repeat(40)}:failure`,
      repo: 'acme/shop',
      prNumber: 7,
      title: 'PR #7',
      // The stale success is the thing a person must know about. "Last confirmed",
      // since a write whose answer never came may have landed after it.
      summary:
        'The code review outcome (changes required) could not be published as a commit status on bbbbbbb: GitHub answered 403 (Forbidden): the server’s GitHub token may not write commit statuses. GitHub last confirmed `success` on bbbbbbb. Retried automatically; check the server’s GitHub token if it keeps failing.',
      href: 'https://github.com/acme/shop/pull/7',
      at: '2026-11-10T12:00:00.000Z',
    });
    // The retries of one failure are one occurrence; the next outcome owed is another.
    expect(attentionItems([], [], [], [], [{ ...failing, attempts: 5 }])[0].revision).toBe(item.revision);
    expect(attentionItems([], [], [], [], [{ ...failing, state: 'error' }])[0].revision).not.toBe(
      item.revision,
    );
    const never = { ...failing, publishedSha: null, publishedState: null };
    expect(attentionItems([], [], [], [], [never])[0].summary).toContain(
      'GitHub has confirmed no status from Briareus.',
    );
    // Given up on: a status GitHub will not accept for the commit is not asked for again.
    expect(
      attentionItems([], [], [], [], [{ ...failing, errorStatus: 422, retryAt: null }])[0].summary,
    ).toMatch(/No longer retried: GitHub will not accept a status for this commit\.$/);
  });
  it('lists a pull request whose code review stopped at its round limit, with what is unresolved', () => {
    const waiting = {
      repo: 'acme/shop',
      prNumber: 7,
      used: 3,
      limit: 3,
      continuations: 0,
      refusedAt: '2026-11-10T12:00:00.000Z',
      refusedHeadSha: 'd'.repeat(40),
      fix: 2,
      unverified: 1,
      asOf: { source: 'stored', round: 3, headSha: 'c'.repeat(40), at: '2026-11-10T11:00:00.000Z' },
    };
    const [item] = attentionItems([], [], [], [waiting]);
    expect(item).toEqual({
      id: 'review-limit:acme/shop#7',
      kind: 'review-limit',
      sessionId: null,
      taskId: null,
      revision: '3:0',
      repo: 'acme/shop',
      prNumber: 7,
      title: 'PR #7',
      summary:
        'Code review stopped at its limit (3 of 3 rounds); 2 required fixes and 1 unverified finding unresolved as of round 3, which GitHub may have moved past. Not reviewed past round 3 and not marked as passed: decide whether to continue.',
      href: 'https://github.com/acme/shop/pull/7',
      at: '2026-11-10T12:00:00.000Z',
    });
    // The pushes that keep being refused are the same occurrence; a continued review
    // that runs out again is a new one.
    const later = { ...waiting, refusedHeadSha: 'e'.repeat(40) };
    expect(attentionItems([], [], [], [later])[0].revision).toBe('3:0');
    const again = { ...waiting, used: 4, continuations: 1, fix: 0, unverified: 0 };
    expect(attentionItems([], [], [], [again])[0]).toMatchObject({
      revision: '4:1',
      summary: expect.stringContaining('(4 of 3 rounds); no unresolved finding recorded as of round 3,'),
    });
    // The counts are never passed off as current, whatever is known of their age.
    const undated = { ...waiting, asOf: { source: 'stored', round: null } };
    expect(attentionItems([], [], [], [undated])[0].summary).toContain(
      'unresolved in the stored records, which GitHub may have moved past',
    );
  });
});

describe('a pull request waiting on a human approval', () => {
  const waiting = {
    repo: 'acme/shop',
    prNumber: 7,
    headSha: 'b'.repeat(40),
    tier: 'high',
    required: 2,
    valid: 1,
    waitingSince: '2026-11-10T12:00:00.000Z',
  };

  it('is listed with its tier and how many approvals are missing, and belongs to no session', () => {
    const [item] = attentionItems([], [], [], [], [], [waiting]);
    expect(item).toEqual({
      id: 'review-approval:acme/shop#7',
      kind: 'review-approval',
      sessionId: null,
      taskId: null,
      revision: `${'b'.repeat(40)}:1/2`,
      repo: 'acme/shop',
      prNumber: 7,
      title: 'PR #7',
      summary:
        'The code review of bbbbbbb passed and the change is high risk: 1 more human approval is needed (1 of 2 given). Approve that revision through Briareus once you have looked at it.',
      href: 'https://github.com/acme/shop/pull/7',
      at: '2026-11-10T12:00:00.000Z',
    });
    expect(attentionItems([], [], [], [], [], [{ ...waiting, valid: 0 }])[0].summary).toContain(
      '2 more human approvals are needed (0 of 2 given)',
    );
  });

  it('is news again with each approval and each new head, not with each poll', () => {
    const revision = (over) => attentionItems([], [], [], [], [], [{ ...waiting, ...over }])[0].revision;
    expect(revision({})).toBe(revision({ waitingSince: '2026-11-10T13:00:00.000Z' }));
    expect(revision({ valid: 0 })).not.toBe(revision({}));
    expect(revision({ headSha: 'c'.repeat(40) })).not.toBe(revision({}));
  });

  it('lists a failed approvals status apart from the outcome’s', () => {
    const failing = {
      repo: 'acme/shop',
      prNumber: 7,
      headSha: 'b'.repeat(40),
      outcome: 'pending',
      state: 'pending',
      publishedSha: null,
      publishedState: null,
      error: 'GitHub answered 403',
      failedAt: '2026-11-10T12:00:00.000Z',
      retryAt: '2026-11-10T12:08:00.000Z',
    };
    const items = attentionItems([], [], [], [], [failing, { ...failing, context: 'briareus/approvals' }]);
    expect(items.map((item) => item.id).sort()).toEqual([
      'review-status:acme/shop#7',
      'review-status:acme/shop#7:briareus/approvals',
    ]);
    expect(items.find((item) => item.id.endsWith('approvals')).summary).toMatch(
      /^The approval requirement \(pending\) could not be published as the commit status `briareus\/approvals` on bbbbbbb: GitHub answered 403\./,
    );
  });
});
