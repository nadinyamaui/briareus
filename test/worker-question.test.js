import { describe, expect, it } from 'vitest';
import { workerQuestion } from '../lib/worker-question.js';

describe('current worker review/fix question ownership', () => {
  const worker = { id: 'w', repo: 'own/repo', reviewLoop: { fixing: true, fixSessionId: 'f' } };
  const child = {
    id: 'f',
    kind: 'devchat',
    repo: worker.repo,
    loopFixParentId: 'w',
    status: 'idle',
    awaitingAnswer: true,
    questionSeq: 12,
  };
  const question = (w = worker, c = child) => workerQuestion(w, (id) => (id === c.id ? c : null));
  it('reports an idle current fix question with an answer token', () => {
    expect(question()).toEqual({
      childId: 'f',
      role: 'fix',
      status: 'idle',
      questionSeq: 12,
      answerable: true,
    });
  });
  it('supports the current review with reciprocal ownership', () => {
    expect(
      question(
        { ...worker, reviewLoop: { reviewing: true, reviewSessionId: 'f' } },
        { ...child, loopFixParentId: null, loopParentId: 'w' },
      ),
    ).toMatchObject({ role: 'review', answerable: true });
  });
  it.each([
    { loopFixParentId: 'another-worker' },
    { repo: 'other/project' },
    { kind: 'review' },
    { status: 'closed' },
    { awaitingAnswer: false },
    { id: 'stale' },
  ])('does not expose unrelated or unavailable children: %s', (change) => {
    expect(question(worker, { ...child, ...change })).toBeNull();
  });
  it('does not authorize answers while the child is closing', () => {
    expect(question(worker, { ...child, closing: true })).toMatchObject({ answerable: false });
  });
  it('does not expose children of a disarmed loop', () => {
    expect(question({ ...worker, reviewLoop: null })).toBeNull();
  });
  it.each(['running', 'interrupted', 'failed'])(
    'reports %s questions without authorizing a send',
    (status) => {
      expect(question(worker, { ...child, status })).toMatchObject({ status, answerable: false });
    },
  );
});
