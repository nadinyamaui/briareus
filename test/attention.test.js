import { describe, expect, it } from 'vitest';
import { attentionItems } from '../lib/attention.js';
describe('operator attention', () => {
  it('includes unresolved work without treating idle or completed QA as failures', () => {
    const items = attentionItems([
      { id: 'a', status: 'idle', awaitingAnswer: true, reviewLoop: { triage: { round: 2 } } },
      { id: 'b', status: 'interrupted' },
      { id: 'c', status: 'idle', qaLoop: { done: true, failedScenarios: 0 } },
      { id: 'd', status: 'closed', awaitingAnswer: true },
      {
        id: 'e',
        status: 'idle',
        qaLoop: { failedScenarios: 2 },
        reviewLoop: { failure: { reason: 'quota' } },
      },
    ]);
    expect(items.map((i) => i.id)).toEqual([
      'a:question',
      'a:findings',
      'b:recovery',
      'e:review-failed',
      'e:qa-failed',
    ]);
  });
  it('keeps held findings of a closed review and nothing else of it', () => {
    const items = attentionItems([
      { id: 'r', status: 'closed', awaitingAnswer: true, reviewTriage: { standalone: true, heldAt: 'x' } },
    ]);
    expect(items.map((i) => i.id)).toEqual(['r:findings']);
  });
  it('surfaces stalled loops and unreadable QA verdicts, but not a stall on a merged PR', () => {
    const items = attentionItems([
      { id: 'a', status: 'idle', reviewLoop: { stalled: true }, qaLoop: { verdictError: 'sheet 404' } },
      { id: 'b', status: 'idle', reviewLoop: { stalled: true }, prStatus: { state: 'merged' } },
    ]);
    expect(items.map((i) => i.id)).toEqual(['a:review-stalled', 'a:qa-verdict']);
    expect(items[1].summary).toContain('sheet 404');
  });
  it('reports a failed loop child only on its parent', () => {
    const items = attentionItems([
      { id: 'p', status: 'idle', reviewLoop: { failure: { reason: 'quota' } } },
      { id: 'rev', status: 'failed', loopParentId: 'p' },
      { id: 'qa', status: 'failed', qaParentId: 'p' },
      { id: 'fix', status: 'interrupted', loopFixParentId: 'p' },
    ]);
    expect(items.map((i) => i.id)).toEqual(['p:review-failed']);
  });
  it('dates each item by when it began to wait, not by session creation', () => {
    const items = attentionItems([
      { id: 'old', status: 'idle', createdAt: '2026-09-01', awaitingAnswer: true, askedAt: '2026-09-26' },
      {
        id: 'new',
        status: 'idle',
        createdAt: '2026-09-20',
        reviewLoop: { triage: { heldAt: '2026-09-25' }, failure: { reason: 'x', at: '2026-09-24' } },
      },
    ]);
    expect(items.map((i) => [i.id, i.at])).toEqual([
      ['old:question', '2026-09-26'],
      ['new:findings', '2026-09-25'],
      ['new:review-failed', '2026-09-24'],
    ]);
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
  it('drops loop failures and QA results once the pull request is merged or closed', () => {
    const loops = {
      reviewLoop: { failure: { reason: 'quota' } },
      qaLoop: { failedScenarios: 2, verdictError: 'sheet 404' },
    };
    const items = attentionItems([
      { id: 'open', status: 'idle', prStatus: { state: 'open' }, ...loops },
      { id: 'merged', status: 'idle', prStatus: { state: 'merged' }, ...loops },
      { id: 'closed', status: 'idle', prStatus: { state: 'closed' }, ...loops },
    ]);
    expect(items.map((i) => i.id)).toEqual(['open:review-failed', 'open:qa-failed', 'open:qa-verdict']);
  });
  it('lists a loop failure beside the recovery of an interrupted parent, as QA is', () => {
    const items = attentionItems([
      {
        id: 'p',
        status: 'interrupted',
        reviewLoop: { failure: { reason: 'restart' } },
        qaLoop: { failedScenarios: 1 },
      },
    ]);
    expect(items.map((i) => i.id)).toEqual(['p:recovery', 'p:review-failed', 'p:qa-failed']);
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
