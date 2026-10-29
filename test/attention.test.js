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
});
