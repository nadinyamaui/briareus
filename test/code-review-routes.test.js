import express from 'express';
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { codeReviewRoutes } from '../lib/code-review-routes.js';

let server, url, user, repos, store;
beforeEach(async () => {
  user = { id: 2, role: 'member' };
  repos = ['acme/shop'];
  store = {
    list: vi.fn(async () => ({ reviews: [], nextPage: null })),
    get: vi.fn(async () => ({ id: 'r', repo: 'acme/shop', ownerId: 2, findings: [] })),
  };
  const app = express();
  app.use((_req, res, next) => {
    Object.assign(res.locals, { apiUser: user, apiRepos: repos });
    next();
  });
  app.use(codeReviewRoutes({ store }));
  server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  url = `http://127.0.0.1:${server.address().port}/api/code-reviews`;
});
afterEach(() => new Promise((r) => server.close(r)));
it('filters members at the database query and validates pagination', async () => {
  expect((await fetch(`${url}?repo=acme/shop&prNumber=4`)).status).toBe(200);
  expect(store.list).toHaveBeenCalledWith({ repo: 'acme/shop', prNumber: 4, page: 1, ownerId: 2 });
  expect((await fetch(`${url}?repo=acme/shop&page=-1`)).status).toBe(400);
  expect((await fetch(`${url}?repo=foreign/shop`)).status).toBe(403);
  expect(store.list).toHaveBeenCalledTimes(1);
});
it('does not disclose another owner or project by id', async () => {
  expect((await fetch(`${url}/r`)).status).toBe(200);
  store.get.mockResolvedValue({ repo: 'acme/shop', ownerId: 3 });
  expect((await fetch(`${url}/r`)).status).toBe(404);
  store.get.mockResolvedValue({ repo: 'other/repo', ownerId: 2 });
  expect((await fetch(`${url}/r`)).status).toBe(404);
  store.get.mockResolvedValue(null);
  expect((await fetch(`${url}/r`)).status).toBe(404);
});
it('allows an admin within its token projects and ownerless work for members', async () => {
  store.get.mockResolvedValue({ repo: 'acme/shop', ownerId: null });
  expect((await fetch(`${url}/r`)).status).toBe(200);
  user = { id: 1, role: 'admin' };
  store.get.mockResolvedValue({ repo: 'acme/shop', ownerId: 3 });
  expect((await fetch(`${url}/r`)).status).toBe(200);
  store.get.mockResolvedValue({ repo: 'other/repo', ownerId: 3 });
  expect((await fetch(`${url}/r`)).status).toBe(404);
});
