import express from 'express';
import { afterEach, describe, it, expect, vi } from 'vitest';

vi.mock('../lib/db.js', () => ({ loadShareRows: vi.fn(), replaceShares: vi.fn() }));
const { createShares } = await import('../lib/shares.js');
const { shareRoutes } = await import('../lib/share-routes.js');

const admin = { id: 1, role: 'admin' };
const ana = { id: 2, role: 'member' };

// An in-memory table behind the store, as lib/db.js would keep it.
function store(initial = []) {
  let table = structuredClone(initial);
  const replace = vi.fn(async (kind, id, userIds) => {
    table = table.filter((r) => !(r.kind === kind && r.id === id));
    for (const userId of userIds) table.push({ kind, id, userId });
  });
  return { shares: createShares({ load: async () => structuredClone(table), replace }), replace };
}

describe('the share store', () => {
  it('fails closed until it loads, then answers by user and kind', async () => {
    const { shares } = store([
      { kind: 'project', id: '3', userId: 2 },
      { kind: 'sshServer', id: '3', userId: 2 },
    ]);
    expect(() => shares.allows(ana, 'project', 3)).toThrow(expect.objectContaining({ status: 503 }));
    expect(shares.allows(admin, 'project', 9)).toBe(true);
    await shares.init();
    expect(shares.allows(ana, 'project', 3)).toBe(true);
    expect(shares.allows(ana, 'project', '3')).toBe(true);
    expect(shares.allows(ana, 'project', 4)).toBe(false);
    expect(shares.allows(ana, 'dbServer', 3)).toBe(false);
    expect(shares.allows(null, 'project', 3)).toBe(false);
    expect(shares.idsFor(2, 'project')).toEqual(['3']);
    expect(shares.list({ id: '3' })).toHaveLength(2);
  });

  it('replaces who a resource is shared with, without duplicates, and shows what stuck', async () => {
    const { shares, replace } = store([{ kind: 'project', id: '3', userId: 2 }]);
    await shares.init();
    await shares.set('project', '3', [3, 3, 4]);
    expect(replace).toHaveBeenCalledWith('project', '3', [3, 4]);
    expect(shares.list({ kind: 'project' }).map((r) => r.userId)).toEqual([3, 4]);
    expect(shares.allows(ana, 'project', 3)).toBe(false);
    replace.mockRejectedValueOnce(new Error('DB down'));
    await expect(shares.set('project', '3', [])).rejects.toThrow('DB down');
    await shares.set('project', '3', []);
    expect(shares.list()).toEqual([]);
  });
});

describe('the share routes', () => {
  let server;
  afterEach(() => new Promise((resolve) => server.close(resolve)));

  async function serve(initial) {
    const { shares } = store(initial);
    await shares.init();
    const app = express();
    app.use(express.json());
    app.use(
      shareRoutes({
        shares,
        users: { list: () => [admin, ana] },
        exists: {
          project: (id) => id === '3',
          dbServer: () => false,
          sshServer: (id) => id === '1790000000000',
          mcpServer: () => false,
          forgeAccount: () => false,
          envoyerAccount: () => false,
        },
      }),
    );
    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}/api/shares`;
    const put = (body, headers = {}) =>
      fetch(base, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body),
      });
    return { base, put };
  }

  it('shares a resource with users and lists only what still exists', async () => {
    const { base, put } = await serve([{ kind: 'project', id: '99', userId: 2 }]);
    const saved = await put({ kind: 'sshServer', id: 1790000000000, userIds: [2] });
    expect(await saved.json()).toEqual({ kind: 'sshServer', id: '1790000000000', userIds: [2] });
    expect(await (await fetch(`${base}?user=2`)).json()).toEqual({
      shares: [{ kind: 'sshServer', id: '1790000000000', userId: 2 }],
    });
    expect((await (await fetch(`${base}?kind=project`)).json()).shares).toEqual([]);
  });

  it('refuses an unknown kind, resource or user, a bad list and an agent token', async () => {
    const { base, put } = await serve([]);
    expect((await put({ kind: 'printer', id: '3', userIds: [] })).status).toBe(400);
    expect((await put({ kind: 'project', id: '4', userIds: [] })).status).toBe(404);
    expect((await put({ kind: 'project', id: '3', userIds: [7] })).status).toBe(400);
    expect((await put({ kind: 'project', id: '3', userIds: ['2'] })).status).toBe(400);
    expect(
      (await put({ kind: 'project', id: '3', userIds: [2] }, { Authorization: 'Bearer s' })).status,
    ).toBe(403);
    expect((await fetch(`${base}?kind=printer`)).status).toBe(400);
  });
});
