import { expect, it } from 'vitest';
import { taskFamily, taskReport } from '../lib/task-history.js';
it('includes archived reviews and same-PR errands once without swallowing sibling tasks', () => {
  const records = [
    { id: 'orchestrator', repo: 'a/b', activity: 'orchestrator' },
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
    ],
    ['task'],
  );
  expect(report.usage.costUsd).toBe(3);
  expect(report.usage.unpricedTurns).toBe(1);
  expect(report.sessions[1].conversationAvailable).toBe(false);
});
it('terminates corrupt ancestry cycles', () => {
  expect(
    taskFamily('a', [
      { id: 'a', repo: 'r', parentId: 'b' },
      { id: 'b', repo: 'r', parentId: 'a' },
    ]).sessions,
  ).toHaveLength(2);
});
