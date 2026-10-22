import express from 'express';
import { expect, it } from 'vitest';
import { taskHistoryRoutes } from '../lib/task-history-routes.js';
async function serve(user, repos = null) {
  const app = express();
  app.use((_req, res, next) => {
    res.locals.apiUser = user;
    res.locals.apiRepos = repos;
    next();
  });
  app.use(
    taskHistoryRoutes({
      loadSnapshots: async () => [{ id: 's', repo: 'a/b', title: 'Task', ownerId: 2 }],
      listSessions: () => [],
      loadUsage: async () => [{ jobId: 's', costUsd: 5 }],
      estimateCosts: async (r) => r,
    }),
  );
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  return { url: `http://127.0.0.1:${server.address().port}/api/operations/tasks/s`, server };
}

it('serves archived task history with exact ledger rows', async () => {
  const { url, server } = await serve({ id: 1, role: 'admin' });
  try {
    const res = await fetch(url);
    const data = await res.json();
    expect(data.usage.costUsd).toBe(5);
    expect(data.sessions[0].conversationAvailable).toBe(false);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

it('answers 404 for another user’s task and one outside the token’s projects', async () => {
  for (const [user, repos, status] of [
    [{ id: 3, role: 'member' }, null, 404],
    [{ id: 2, role: 'member' }, ['o/other'], 404],
    [{ id: 2, role: 'member' }, ['a/b'], 200],
  ]) {
    const { url, server } = await serve(user, repos);
    try {
      expect((await fetch(url)).status).toBe(status);
    } finally {
      await new Promise((r) => server.close(r));
    }
  }
});
