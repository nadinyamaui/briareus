import { createCiStore } from '../lib/ci-store.js';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { ciRoutes } from '../lib/ci-routes.js';
import { normalizeCiRates } from '../lib/ci-rates.js';
import { apiV1Routes } from '../lib/api-v1.js';
import { createMobileAuth } from '../lib/mobile-auth.js';

const now = Date.parse('2026-10-28T12:00:00Z');
const secret = 'test-owner-secret';
let server, url, store, rates, tokens, shared;

beforeEach(async () => {
  let saved = [];
  const auth = createMobileAuth({
    load: async () => structuredClone(saved),
    save: async (_key, value) => {
      saved = structuredClone(value);
    },
    now: () => now,
  });
  await auth.init();
  tokens = {};
  for (const [key, userId, permission, repos] of [
    ['admin', 1, 'admin', []],
    ['read', 1, 'read', ['acme/shop']],
    ['member', 2, 'read', ['acme/shop', 'private/other']],
  ])
    tokens[key] = (await auth.create({ userId, permission, repos, label: key, days: 1 }, secret)).token;
  shared = ['acme/shop'];
  store = {
    stats: vi.fn(async () => ({ totals: { total: 0 }, daily: [], repositories: [], checks: [] })),
    runs: vi.fn(async () => ({ runs: [], nextOffset: null })),
  };
  let savedRates = { currency: 'EUR', groups: { 'Ubuntu EU': 0.2 } };
  rates = {
    get: vi.fn(async () => savedRates),
    set: vi.fn(async (input) => (savedRates = normalizeCiRates(input))),
  };
  const handlers = express.Router();
  handlers.use(express.json());
  handlers.use(ciRoutes({ store, rates, now: () => now }));
  const app = express();
  app.use(
    apiV1Routes({
      auth,
      users: { get: (id) => ({ id, name: `User ${id}`, role: id === 1 ? 'admin' : 'member' }) },
      memberRepos: () => shared,
      apiEnabled: () => true,
      ownerSecret: () => secret,
      handlers,
      getJob: () => null,
      getProject: () => null,
      listSessions: () => [],
      bus: new EventEmitter(),
    }),
  );
  await new Promise((resolve) => {
    server = createServer({ maxHeaderSize: 1024 * 1024 }, app).listen(0, '127.0.0.1', resolve);
  });
  url = `http://127.0.0.1:${server.address().port}/api/v1`;
});
afterEach(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});
const get = (path, token = 'read') =>
  fetch(`${url}${path}`, { headers: { Authorization: `Bearer ${tokens[token]}` } });

describe('CI dashboard API through the authenticated gateway', () => {
  it.each(['🚀'.repeat(128), 'build'.repeat(100)])(
    'accepts a persisted Unicode or long name filter',
    async (name) => {
      expect((await get(`/ci/runs?name=${encodeURIComponent(name)}`)).status).toBe(200);
      expect(store.runs).toHaveBeenCalledWith(expect.objectContaining({ name }), {
        limit: 50,
        offset: 0,
        rates: { 'Ubuntu EU': 0.2 },
      });
    },
  );

  it('rejects text filters beyond the storage byte limit', async () => {
    const response = await get(`/ci/runs?name=${encodeURIComponent('🚀'.repeat(16384))}`);
    expect(response.status).toBe(400);
    expect(store.runs).not.toHaveBeenCalled();
  });
  it('applies the project scope to both queries, with bounded default windows', async () => {
    const res = await get('/stats/ci');
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toMatchObject({ kind: 'check_run', until: now + 1, since: now + 1 - 30 * 86400000 });
    expect(store.stats.mock.calls[0][0]).toMatchObject({ repos: ['acme/shop'], kind: 'check_run' });
    await get(
      '/ci/runs?kind=status&branch=main&name=deploy&status=completed&conclusion=success&limit=10&offset=20',
    );
    expect(store.runs).toHaveBeenCalledWith(
      expect.objectContaining({
        repos: ['acme/shop'],
        kind: 'status',
        branch: 'main',
        name: 'deploy',
        status: 'completed',
        conclusion: 'success',
      }),
      { limit: 10, offset: 20, rates: { 'Ubuntu EU': 0.2 } },
    );
  });

  it('refuses explicit foreign projects and intersects member access with current shares', async () => {
    expect((await get('/stats/ci?repo=private/other')).status).toBe(403);
    expect((await get('/ci/runs?repo=private/other', 'member')).status).toBe(403);
    expect(store.stats).not.toHaveBeenCalled();
    expect(store.runs).not.toHaveBeenCalled();
    await get('/stats/ci', 'member');
    expect(store.stats.mock.calls.at(-1)[0].repos).toEqual(['acme/shop']);
    shared = [];
    await get('/ci/runs', 'member');
    expect(store.runs.mock.calls.at(-1)[0].repos).toEqual([]);
    await get('/stats/ci', 'admin');
    expect(store.stats.mock.calls.at(-1)[0].repos).toBeNull();
  });

  it.each([
    'since=-1',
    'since=abc',
    'since=2&until=1',
    'until=0',
    'since=0&until=9999999999999',
    'since=1&since=2',
    'repo=acme/shop&repo=private/other',
    'kind=workflow',
    'limit=101',
    'limit=0',
    'offset=-1',
    'offset=100001',
    'offset=1.5',
    'name=',
  ])('rejects invalid query %s without executing a database query', async (query) => {
    expect((await get(`/ci/runs?${query}`)).status).toBe(400);
    expect(store.runs).not.toHaveBeenCalled();
  });

  it.each([
    [99900, 100000, false],
    [99950, null, true],
    [100000, null, true],
  ])(
    'returns an accepted continuation or explicit truncation at offset %i',
    async (offset, nextOffset, truncated) => {
      const connection = {
        query: vi.fn(async () => [
          Array.from({ length: 101 }, (_, i) => ({
            github_id: String(i),
            run_at: now,
            observed_at: now,
          })),
        ]),
        release: vi.fn(),
      };
      const ledger = createCiStore({ connection: async () => connection });
      store.runs.mockImplementation((...args) => ledger.runs(...args));
      const response = await get(`/ci/runs?offset=${offset}&limit=100`);
      expect(response.status).toBe(200);
      const page = await response.json();
      expect(page).toMatchObject({ nextOffset, truncated });
      expect(page.runs).toHaveLength(100);
      expect(connection.query.mock.calls[0][1].slice(-2)).toEqual([101, offset]);
      if (nextOffset != null) expect((await get(`/ci/runs?offset=${nextOffset}&limit=100`)).status).toBe(200);
    },
  );

  it('passes explicit time boundaries unchanged and requires authentication', async () => {
    expect((await fetch(`${url}/stats/ci`)).status).toBe(401);
    await get(`/stats/ci?since=${now - 1000}&until=${now}&repo=acme/shop`);
    expect(store.stats.mock.calls[0][0]).toMatchObject({
      since: now - 1000,
      until: now,
      repos: ['acme/shop'],
    });
  });

  it('prices reports with the stored rates and filters by runner', async () => {
    const data = await (await get('/stats/ci?runnerGroup=Ubuntu%20EU&runner=ubuntu-eu-1')).json();
    expect(data.currency).toBe('EUR');
    expect(store.stats).toHaveBeenCalledWith(
      expect.objectContaining({ runnerGroup: 'Ubuntu EU', runner: 'ubuntu-eu-1' }),
      { 'Ubuntu EU': 0.2 },
    );
    expect((await (await get('/ci/runs')).json()).currency).toBe('EUR');
  });

  it('lets only admins read and replace runner group rates', async () => {
    const put = (body, token = 'admin') =>
      fetch(`${url}/settings/ci-rates`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${tokens[token]}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    expect((await get('/settings/ci-rates')).status).toBe(403);
    expect((await put({ groups: { Default: 1 } }, 'read')).status).toBe(403);
    expect(rates.set).not.toHaveBeenCalled();
    const res = await put({ groups: { Default: 0, 'Ubuntu EU': 0.05 } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ currency: 'USD', groups: { Default: 0, 'Ubuntu EU': 0.05 } });
    expect(await (await get('/settings/ci-rates', 'admin')).json()).toEqual({
      currency: 'USD',
      groups: { Default: 0, 'Ubuntu EU': 0.05 },
    });
    expect((await put({ groups: { Default: -1 } })).status).toBe(400);
    expect((await put({ currency: 'usd', groups: {} })).status).toBe(400);
  });
});
