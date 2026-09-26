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
  it('preserves the exact SSH approval and its destination', () => {
    const request = { id: 'ssh1', createdAt: 1, jobId: 'a', command: 'echo hello', host: 'host' };
    expect(attentionItems([], [request])[0]).toMatchObject({ id: 'ssh:ssh1', request, href: '/sessions/a' });
  });
});
