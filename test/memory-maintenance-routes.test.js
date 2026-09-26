import express from 'express';
import { expect, it, vi } from 'vitest';
vi.mock('../lib/db.js', () => ({ loadAppSetting: async () => ({}), saveAppSetting: async () => {} }));
import { memoryMaintenanceRoutes } from '../lib/memory-maintenance-routes.js';
import { memoryRevision } from '../lib/memory-selection.js';
it('rejects stale and cross-project merges before changing memories', async () => {
  const rows = [
    { id: 1, repo: 'a/b', name: 'a', body: 'old' },
    { id: 2, repo: 'a/c', name: 'b', body: 'old' },
  ];
  const updateMemory = vi.fn();
  const app = express();
  app.use(express.json());
  app.use(memoryMaintenanceRoutes({ listMemories: () => rows, updateMemory }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const post = (path, body) =>
    fetch(`http://127.0.0.1:${server.address().port}/api/operations/memories${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  try {
    expect((await post('/1', { revision: 'stale', action: 'archive' })).status).toBe(409);
    expect(
      (
        await post('/merge/apply', {
          targetId: 1,
          sourceId: 2,
          body: 'new',
          revisions: rows.map(memoryRevision),
        })
      ).status,
    ).toBe(400);
    expect(updateMemory).not.toHaveBeenCalled();
  } finally {
    await new Promise((r) => server.close(r));
  }
});
