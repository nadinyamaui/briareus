import express from 'express';
import { expect, it } from 'vitest';
import { operationsRoutes } from '../lib/operations-routes.js';
it('only exposes operator projections to browser requests', async () => {
  const app = express();
  app.use(
    operationsRoutes({
      listSessions: () => [{ id: 's', status: 'failed' }],
      ssh: { pending: () => [], runningCount: () => 0 },
      getJob: () => null,
      sendMessage: () => null,
    }),
  );
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const url = `http://127.0.0.1:${server.address().port}/api/operations/attention`;
  try {
    expect((await (await fetch(url)).json()).items[0].kind).toBe('recovery');
    expect((await fetch(url, { headers: { authorization: 'Bearer internal' } })).status).toBe(403);
  } finally {
    await new Promise((r) => server.close(r));
  }
});
