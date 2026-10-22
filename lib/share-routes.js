// @ts-check
import { Router } from 'express';
import { SHARE_KINDS } from './shares.js';

// Settings' sharing handlers, reached only through /api/v1 with an admin token: who each
// project and server is shared with. `exists` answers, per kind, whether an id names a
// resource there is, so a share cannot be saved for something that is not.
/**
 * @param {{
 *   shares: ReturnType<typeof import('./shares.js').createShares>,
 *   users: { list: () => { id: number }[] },
 *   exists: Record<string, (id: string) => boolean>,
 * }} deps
 */
export function shareRoutes({ shares, users, exists }) {
  const router = Router();
  const fail = (status, message) => Object.assign(new Error(message), { status });
  router.use('/api/shares', (req, res, next) => {
    if (req.headers.authorization)
      return res.status(403).json({ error: 'Sharing is changed through /api/v1' });
    next();
  });
  const kindOf = (kind) => {
    if (typeof kind !== 'string' || !SHARE_KINDS.includes(kind))
      throw fail(400, `Name a kind: ${SHARE_KINDS.join(', ')}`);
    return kind;
  };
  // Only what still exists is shown: a resource removed since keeps its rows, which no
  // longer reach anything, since ids are not given out again.
  const live = (share) => exists[share.kind]?.(share.id);

  const handle = (fn) => async (req, res) => {
    try {
      await fn(req, res);
    } catch (e) {
      res.status(e.status || 400).json({ error: e.message });
    }
  };

  router.get(
    '/api/shares',
    handle((req, res) => {
      const filter = {};
      if (req.query.kind !== undefined) filter.kind = kindOf(req.query.kind);
      if (typeof req.query.id === 'string') filter.id = req.query.id;
      if (req.query.user !== undefined) filter.userId = Number(req.query.user);
      res.json({ shares: shares.list(filter).filter(live) });
    }),
  );

  router.put(
    '/api/shares',
    handle(async (req, res) => {
      const { kind, id, userIds } = req.body || {};
      kindOf(kind);
      const key = typeof id === 'number' || typeof id === 'string' ? String(id) : '';
      if (!key || !exists[kind](key)) throw fail(404, `No ${kind} with id ${key || '(none)'}`);
      if (!Array.isArray(userIds) || userIds.some((u) => !Number.isInteger(u)))
        throw fail(400, 'Send `userIds`, a list of user ids; an empty one shares it with nobody');
      const known = new Set(users.list().map((u) => u.id));
      const unknown = userIds.filter((u) => !known.has(u));
      if (unknown.length) throw fail(400, `No user with id ${unknown.join(', ')}`);
      await shares.set(kind, key, userIds);
      res.json({ kind, id: key, userIds: shares.list({ kind, id: key }).map((s) => s.userId) });
    }),
  );
  return router;
}
