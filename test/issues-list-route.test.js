import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Exercise the actual route without booting the dashboard and its workers.
const source = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const route = source.slice(
  source.indexOf('// A failed board read:'),
  source.indexOf('// One issue read whole, and its timeline a page at a time.'),
);
const servers = [];

async function setup(projectIssues, project = { repo: 'owner/repo' }) {
  const api = express();
  new Function('api', 'getProject', 'projectIssues', route)(api, () => project, projectIssues);
  const server = createServer(api);
  servers.push(server);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (query) => fetch(`http://127.0.0.1:${server.address().port}/api/issues/list?${query}`);
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
});

describe('GET /api/issues/list', () => {
  it('passes the page it was asked for', async () => {
    const projectIssues = vi.fn(async () => ({ issues: [], total: 0, nextOffset: null }));
    const get = await setup(projectIssues);
    expect((await get('repo=owner/repo&offset=100&limit=25')).status).toBe(200);
    expect(projectIssues).toHaveBeenCalledWith({ repo: 'owner/repo' }, { offset: 100, limit: 25 });
    await get('repo=owner/repo');
    expect(projectIssues).toHaveBeenLastCalledWith({ repo: 'owner/repo' }, { offset: 0, limit: 50 });
  });

  it.each([
    'limit=0',
    'limit=101',
    'limit=0x10',
    'limit=1e1',
    'limit=%2010',
    'limit=5&limit=5',
    'offset=-1',
    'offset=1.5',
  ])('refuses %s', async (query) => {
    const projectIssues = vi.fn();
    const get = await setup(projectIssues);
    const res = await get(`repo=owner/repo&${query}`);
    expect(res.status).toBe(400);
    expect(projectIssues).not.toHaveBeenCalled();
  });

  it('answers 404 for an unknown project', async () => {
    const get = await setup(vi.fn(), null);
    expect((await get('repo=nobody/none')).status).toBe(404);
  });

  it.each([
    ['a GraphQL error', 200],
    ['an expired GitHub token', 401],
  ])('answers %s as a 502, not its upstream status', async (_name, status) => {
    const get = await setup(async () => {
      throw Object.assign(new Error('upstream'), { status });
    });
    const res = await get('repo=owner/repo');
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'upstream' });
  });

  it('answers a spent allowance as a 429 that says when to come back', async () => {
    const retryAt = Date.now() + 90_000;
    const get = await setup(async () => {
      throw Object.assign(new Error('rate limited'), { status: 429, rateLimited: true, retryAt });
    });
    const res = await get('repo=owner/repo');
    expect(res.status).toBe(429);
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(await res.json()).toEqual({ error: 'rate limited', retryAt: new Date(retryAt).toISOString() });
  });
});
