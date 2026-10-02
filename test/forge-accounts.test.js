import express from 'express';
import { describe, expect, it, vi } from 'vitest';

import { createForgeAccounts } from '../lib/forge-accounts.js';
import { forgeRoutes } from '../lib/forge-routes.js';

vi.mock('../lib/config.js', () => ({ getConfig: () => ({ credentialsKey: 'k'.repeat(32) }) }));

async function accounts(rows = []) {
  const save = vi.fn(async () => {});
  const service = createForgeAccounts({ load: async () => rows, save });
  await service.init();
  return { service, save };
}

describe('the Forge accounts', () => {
  it('stores the token sealed and never hands it back', async () => {
    const { service, save } = await accounts();
    const account = await service.create({ organization: 'okanet', token: 'forge-secret', repos: ['o/a'] });
    expect(account).toEqual({
      id: expect.any(Number),
      label: 'okanet',
      organization: 'okanet',
      repos: ['o/a'],
      hasToken: true,
    });
    const stored = save.mock.calls[0][1][0];
    expect(stored.token).toMatch(/^v1:/);
    expect(JSON.stringify(stored)).not.toContain('forge-secret');
    expect(service.credentials(account.id)).toEqual({
      label: 'okanet',
      organization: 'okanet',
      token: 'forge-secret',
    });
  });

  it('keeps the stored token when an edit leaves it blank', async () => {
    const { service } = await accounts();
    const { id } = await service.create({ organization: 'okanet', token: 'forge-secret' });
    await service.update(id, { label: 'Okanet', token: '', repos: ['o/b', 'o/b'] });
    expect(service.list()).toEqual([expect.objectContaining({ label: 'Okanet', repos: ['o/b'] })]);
    expect(service.credentials(id).token).toBe('forge-secret');
  });

  it('lists only the accounts available to a project when asked for one', async () => {
    const { service } = await accounts();
    await service.create({ organization: 'one', token: 't', repos: ['o/a'] });
    await service.create({ organization: 'two', token: 't', repos: ['o/b'] });
    expect(service.list('o/b').map((a) => a.organization)).toEqual(['two']);
    expect(service.list()).toHaveLength(2);
  });

  it('refuses an account without a token or a usable organization', async () => {
    const { service } = await accounts();
    await expect(service.create({ organization: 'okanet' })).rejects.toThrow('token');
    await expect(service.create({ organization: '../x', token: 't' })).rejects.toThrow('organization');
    await expect(service.create({ organization: 'o', token: 't', repos: 'o/a' })).rejects.toThrow('list');
    expect(() => service.credentials(1)).toThrow(expect.objectContaining({ status: 404 }));
  });
});

describe('the Forge account routes', () => {
  it('refuses a project that does not exist and answers the list with defaults', async () => {
    const { service } = await accounts();
    const app = express();
    app.use(express.json());
    app.use(forgeRoutes({ accounts: service, client: vi.fn(), getProject: (repo) => repo === 'o/a' }));
    const server = app.listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    const base = `http://127.0.0.1:${server.address().port}/api/forge/accounts`;
    const post = (body) =>
      fetch(base, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    try {
      expect((await post({ organization: 'o', token: 't', repos: ['o/nope'] })).status).toBe(400);
      const created = await post({ organization: 'o', token: 't', repos: ['o/a'] });
      expect(created.status).toBe(201);
      const list = await (await fetch(`${base}?repo=o/a`)).json();
      expect(list.accounts).toHaveLength(1);
      expect(list.defaults).toEqual({ label: '', organization: '', repos: [] });
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
});
