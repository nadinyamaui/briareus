// @ts-check
import { Router } from 'express';
import { createHomeAssistantService, homeAssistantUrl } from './home-assistant.js';

// What a user sets up for themselves, reached through /api/v1 as that user: their GitHub
// identity and their Home Assistant. With a GitHub token of their own, the changes they
// make through the API (comments, merges, labels, verdicts) and what their sessions commit
// and push are made as them rather than as the server's account (lib/github.js
// asGithubUser, lib/jobs.js); with their Home Assistant, /home-assistant reaches their home.
/**
 * @param {{
 *   credentials: ReturnType<typeof import('./user-credentials.js').createUserCredentials>,
 *   request?: typeof fetch,
 *   homeAssistantCheck?: (cfg: { url: string, token: string }) => Promise<unknown>,
 * }} deps
 */
export function meRoutes({
  credentials,
  request = fetch,
  homeAssistantCheck = (cfg) => createHomeAssistantService({ config: () => cfg }).status(),
}) {
  const router = Router();
  const fail = (status, message) => Object.assign(new Error(message), { status });
  router.use('/api/me', (req, res, next) => {
    if (req.headers.authorization) return res.status(403).json({ error: 'Reached through /api/v1' });
    next();
  });
  const handle = (fn) => async (req, res) => {
    try {
      await fn(req, res);
    } catch (e) {
      res.status(e.status || 400).json({ error: e.message });
    }
  };
  const userOf = (res) => {
    const user = res.locals.apiUser;
    if (!user) throw fail(401, 'Call this with a token');
    return user;
  };
  const view = (stored) => ({ connected: !!stored, login: stored?.login ?? null });

  router.get(
    '/api/me/github',
    handle((_req, res) => res.json(view(credentials.get(userOf(res).id, 'github')))),
  );
  router.put(
    '/api/me/github',
    handle(async (req, res) => {
      const user = userOf(res);
      const token = typeof req.body?.token === 'string' ? req.body.token.trim() : '';
      if (!token || token.length > 500 || /\s/.test(token)) throw fail(400, 'Paste a GitHub token');
      // The token's own answer names the account, so nobody can claim someone else's login.
      // Validate outside githubRest: its rate buckets belong to the server's token.
      const answer = await request('https://api.github.com/user', {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'claude-pr-reviewer',
        },
      });
      if (!answer.ok) throw fail(400, `GitHub refused that token (${answer.status})`);
      const { login, id } = await answer.json();
      if (typeof login !== 'string' || !Number.isInteger(id))
        throw fail(502, 'GitHub did not name the account');
      const stored = { token, login, id };
      await credentials.set(user.id, 'github', stored);
      res.json(view(stored));
    }),
  );
  router.delete(
    '/api/me/github',
    handle(async (_req, res) => {
      await credentials.remove(userOf(res).id, 'github');
      res.json(view(null));
    }),
  );

  const homeView = (stored) => ({ connected: !!stored, url: stored?.url ?? null });
  router.get(
    '/api/me/home-assistant',
    handle((_req, res) => res.json(homeView(credentials.get(userOf(res).id, 'homeAssistant')))),
  );
  router.put(
    '/api/me/home-assistant',
    handle(async (req, res) => {
      const user = userOf(res);
      const url = homeAssistantUrl(req.body?.url);
      const token = typeof req.body?.token === 'string' ? req.body.token.trim() : '';
      if (!token || token.length > 2000 || /\s/.test(token))
        throw fail(400, 'Paste a Home Assistant long-lived access token');
      // Saved only once Home Assistant answers to it, so a typo is caught now.
      await homeAssistantCheck({ url, token });
      const stored = { url, token };
      await credentials.set(user.id, 'homeAssistant', stored);
      res.json(homeView(stored));
    }),
  );
  router.delete(
    '/api/me/home-assistant',
    handle(async (_req, res) => {
      await credentials.remove(userOf(res).id, 'homeAssistant');
      res.json(homeView(null));
    }),
  );
  return router;
}
