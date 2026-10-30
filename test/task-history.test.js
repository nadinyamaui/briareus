import { expect, it } from 'vitest';
import { taskSnapshot } from '../lib/task-snapshot.js';
import { taskFamily, taskReport } from '../lib/task-history.js';
it.each(['orchestrator', 'zeus'])(
  'keeps %s worker history, costs and PR separate from its supervisor and siblings',
  (activity) => {
    const records = [
      {
        id: 'orchestrator',
        repo: 'a/b',
        activity,
        prNumber: 99,
        qaLoop: { done: true },
      },
      { id: 'task', repo: 'a/b', parentId: 'orchestrator', prNumber: 8 },
      { id: 'review', repo: 'a/b', parentId: 'task' },
      { id: 'qa', repo: 'a/b', prNumber: 8 },
      { id: 'other', repo: 'a/b', parentId: 'orchestrator', prNumber: 9 },
      { id: 'foreign', repo: 'other/repo', prNumber: 8 },
    ];
    const family = taskFamily('review', records);
    expect(family.root.id).toBe('task');
    expect(family.sessions.map((s) => s.id)).toEqual(['task', 'review', 'qa']);
    const report = taskReport(
      family,
      [
        { jobId: 'task', costUsd: 2 },
        { jobId: 'review', costUsd: 1 },
        { jobId: 'qa', costUsd: null },
        { jobId: 'other', costUsd: 20 },
        { jobId: 'orchestrator', costUsd: 50 },
      ],
      ['task'],
    );
    expect(report.usage.costUsd).toBe(3);
    expect(report.prUrl).toBe('https://github.com/a/b/pull/8');
    expect(report.root.qaLoop).toBeUndefined();
    expect(report.usage.unpricedTurns).toBe(1);
    expect(report.sessions[1].conversationAvailable).toBe(false);
  },
);
it('terminates corrupt ancestry cycles', () => {
  expect(
    taskFamily('a', [
      { id: 'a', repo: 'r', parentId: 'b' },
      { id: 'b', repo: 'r', parentId: 'a' },
    ]).sessions,
  ).toHaveLength(2);
});

it('retains deleted review and fix history and ledger totals after the parent moves PR', () => {
  const parent = { id: 'task', repo: 'a/b', prStatus: { number: 42 } };
  const archived = ['review', 'implement-feedback'].map((activity) =>
    taskSnapshot({ id: activity, repo: parent.repo, activity, reviewParentId: parent.id, startedOnPr: 42 }),
  );
  parent.prStatus.number = 43;
  const snapshots = [taskSnapshot(parent), ...archived.map(taskSnapshot)];
  const rows = [
    { jobId: 'task', costUsd: 2 },
    { jobId: 'review', costUsd: 3 },
    { jobId: 'implement-feedback', costUsd: 4 },
  ];
  for (const id of ['task', 'review', 'implement-feedback']) {
    const report = taskReport(taskFamily(id, snapshots), rows, [parent.id]);
    expect(report.root.id).toBe(parent.id);
    expect(report.sessions.map((s) => s.id)).toEqual(['task', 'review', 'implement-feedback']);
    expect(report.sessions.slice(1).every((s) => !s.conversationAvailable)).toBe(true);
    expect(report.usage.costUsd).toBe(9);
  }
});
