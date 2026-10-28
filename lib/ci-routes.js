// @ts-check
import { Router } from 'express';
import { ciStore, CI_MAX_OFFSET } from './ci-store.js';

const DAY = 86400000;
const bad = (message) => Object.assign(new Error(message), { status: 400 });

export function ciRoutes({ store = ciStore, now = Date.now } = {}) {
  const router = Router();
  const integer = (query, key, fallback, min, max) => {
    if (query[key] == null) return fallback;
    if (typeof query[key] !== 'string' || !/^\d+$/.test(query[key])) throw bad(`Invalid ${key}`);
    const value = Number(query[key]);
    if (!Number.isSafeInteger(value) || value < min || value > max) throw bad(`Invalid ${key}`);
    return value;
  };
  const text = (query, key, max = 255) => {
    const value = query[key];
    if (value == null) return undefined;
    if (typeof value !== 'string' || !value.length || [...value].length > max) throw bad(`Invalid ${key}`);
    if (['name', 'branch'].includes(key) && Buffer.byteLength(value, 'utf8') > 65535)
      throw bad(`Invalid ${key}`);
    return value;
  };
  const filters = (req, res) => {
    const until = integer(req.query, 'until', now() + 1, 1, 8640000000000000);
    const since = integer(req.query, 'since', Math.max(0, until - 30 * DAY), 0, until - 1);
    if (until - since > 366 * DAY) throw bad('CI windows must not exceed 366 days');
    const repo = text(req.query, 'repo');
    const allowed = res.locals.apiRepos;
    if (repo && allowed && !allowed.includes(repo))
      throw Object.assign(new Error('Name one of this token’s projects in `repo`'), { status: 403 });
    const kind = text(req.query, 'kind') || 'check_run';
    if (!['check_run', 'status'].includes(kind)) throw bad('Invalid kind');
    return {
      repos: repo ? [repo] : (allowed ?? null),
      kind,
      since,
      until,
      branch: text(req.query, 'branch', 65535),
      name: text(req.query, 'name', 65535),
      status: text(req.query, 'status', 32),
      conclusion: text(req.query, 'conclusion', 32),
    };
  };

  router.get('/api/dev/stats/ci', async (req, res) => {
    const query = filters(req, res);
    res.json({ since: query.since, until: query.until, kind: query.kind, ...(await store.stats(query)) });
  });
  router.get('/api/dev/ci/runs', async (req, res) => {
    const query = filters(req, res);
    const limit = integer(req.query, 'limit', 50, 1, 100);
    const offset = integer(req.query, 'offset', 0, 0, CI_MAX_OFFSET);
    res.json({
      since: query.since,
      until: query.until,
      kind: query.kind,
      ...(await store.runs(query, { limit, offset })),
    });
  });
  return router;
}
