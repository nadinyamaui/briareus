// @ts-check
import { getConfig } from './config.js';

// Who may call this API-only server. Clients call /api/v1 with a token (lib/api-v1.js)
// signed with AUTH_SECRET, which `npm run create-token` writes into .env on first run.
// Without it no token can be checked, so the API answers nothing rather than everything.

export function apiEnabled() {
  return !!getConfig().auth.secret;
}

// Agent-facing routes check their own bearer token (the session's, passed to the memory
// tool through its environment).
const AGENT_PREFIX = '/api/agent/';

// The one way to reach a handler by its own path; everything else on that router is the
// operator's, reached through /api/v1.
export function agentOnly(handlers) {
  return (req, res, next) => (req.path.startsWith(AGENT_PREFIX) ? handlers(req, res, next) : next());
}
