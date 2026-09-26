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
