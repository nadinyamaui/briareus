import express from 'express';
import { expect, it } from 'vitest';
import { taskHistoryRoutes } from '../lib/task-history-routes.js';
it('serves archived task history with exact ledger rows', async () => {
  const app = express();
  app.use(
    taskHistoryRoutes({
      loadSnapshots: async () => [{ id: 's', repo: 'a/b', title: 'Task' }],
      listSessions: () => [],
      loadUsage: async () => [{ jobId: 's', costUsd: 5 }],
      estimateCosts: async (r) => r,
    }),
  );
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/operations/tasks/s`);
    const data = await res.json();
    expect(data.usage.costUsd).toBe(5);
    expect(data.sessions[0].conversationAvailable).toBe(false);
  } finally {
    await new Promise((r) => server.close(r));
  }
});
