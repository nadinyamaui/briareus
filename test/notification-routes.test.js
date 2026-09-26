import express from 'express';
import { expect, it, vi } from 'vitest';
import { notificationRoutes } from '../lib/notification-routes.js';
it('rejects subscriptions scoped to nonexistent projects', async () => {
  const subscribe = vi.fn();
  const app = express();
  app.use(express.json());
  app.use(notificationRoutes({ service: { subscribe }, getProject: () => null }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  try {
    const res = await fetch(
      `http://127.0.0.1:${server.address().port}/api/operations/notifications/subscribe`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repos: ['a/b'] }),
      },
    );
    expect(res.status).toBe(400);
    expect(subscribe).not.toHaveBeenCalled();
  } finally {
    await new Promise((r) => server.close(r));
  }
});
