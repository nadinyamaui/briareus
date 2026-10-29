// @ts-check
import { Router } from 'express';
import { seesSession } from './ownership.js';

export function codeReviewRoutes({ store }) {
  const router = Router();
  router.get('/api/code-reviews', async (req, res) => {
    const repo = req.query.repo;
    const page = req.query.page == null ? 1 : Number(req.query.page);
    const prNumber = req.query.prNumber == null ? null : Number(req.query.prNumber);
    if (
      typeof repo !== 'string' ||
      !/^[\w.-]+\/[\w.-]+$/.test(repo) ||
      !Number.isInteger(page) ||
      page < 1 ||
      page > 30 ||
      (prNumber != null && (!Number.isInteger(prNumber) || prNumber < 1))
    )
      return res
        .status(400)
        .json({ error: 'Name a repository, a positive PR number and a page from 1 to 30' });
    const user = res.locals.apiUser;
    if (!user || (res.locals.apiRepos && !res.locals.apiRepos.includes(repo)))
      return res.status(403).json({ error: 'Project not available' });
    res.json(await store.list({ repo, prNumber, page, ownerId: user.role === 'admin' ? null : user.id }));
  });
  router.get('/api/code-reviews/:id', async (req, res) => {
    const review = await store.get(req.params.id);
    if (
      !review ||
      !seesSession(res.locals.apiUser, review) ||
      (res.locals.apiRepos && !res.locals.apiRepos.includes(review.repo))
    )
      return res.status(404).json({ error: 'Code review not found' });
    res.json({ review });
  });
  return router;
}
