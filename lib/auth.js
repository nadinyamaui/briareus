// @ts-check
import { getConfig } from './config.js';

// Who may call this server, now that it serves nothing but its API.
//
// There is no login of its own any more. A client calls /api/v1 with a token
// (lib/api-v1.js), every token is signed with AUTH_SECRET, and `npm run
// create-token` writes that secret into .env the first time it runs. Without
// it no token can be checked, so the API answers nothing at all rather than
// everything.

export function apiEnabled() {
  return !!getConfig().auth.secret;
}

// The agent-facing routes carry a bearer token of their own (the session's,
// handed to the memory tool through its environment) and check it themselves.
const AGENT_PREFIX = '/api/agent/';

// The one way to a handler by its own path. Everything else on the handlers'
// router is the operator's, and is reached through /api/v1 with a token.
export function agentOnly(handlers) {
  return (req, res, next) => (req.path.startsWith(AGENT_PREFIX) ? handlers(req, res, next) : next());
}
