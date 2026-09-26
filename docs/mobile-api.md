# Mobile API v1

This API is for a separately developed native iPhone client. It reuses the
dashboard's project-scoped operations without exposing the browser's settings
or accepting browser cookies. No iOS app is included.

## Connect an iPhone

1. Deploy this version of Briareus and build the stylesheet with `npm run build:css`.
   No new environment variables or database migrations are required; device
   records use the existing `app_settings` table.
2. Enable Briareus password login (`npm run set-password`, then restart) if it
   is not already enabled. The mobile API fails closed when login is disabled.
3. Sign in to the web dashboard and open **Settings → Mobile devices**
   (`/settings/mobile`). Create a token with a device name, permitted projects,
   **Read only** or **Manage**, and an expiry of 1–365 days (90 by default).
4. Enter the public HTTPS API address and the one-time token into the iPhone
   client, for example `https://briareus.example.com/api/mobile/v1`.
   The page shows its current origin; if opened on localhost, replace that with
   the public hostname. Never use an HTTP address outside local development.
5. Validate the connection with `GET /` and then list projects as shown below.

The owner issues a separate personal access token for each device; this is not
a public username/password login endpoint or an OAuth flow. There is no shared
secret to embed in the app binary. The server stores only SHA-256 token hashes.
Device permissions survive a server restart. Revocation and expiry reject
subsequent requests; work already started continues until explicitly cancelled.
Rotating `AUTH_SECRET` invalidates existing mobile tokens too.

Keep the token in the iOS **Keychain**, not UserDefaults, source code, logs or
URLs; see Apple's [Keychain services documentation](https://developer.apple.com/documentation/security/keychain-services).
Store tokens separately for each server origin. Send a token only to its
configured HTTPS origin, and reject HTTP redirects rather than forwarding
credentials or interpreting a Cloudflare login page as an API response.

To replace a token, create a new device entry, configure the phone with it, and
revoke the old entry in Settings. Tokens cannot extend their own expiry or
create other tokens. There is no refresh token. A device can revoke itself with
`DELETE /token`; remove its Keychain item after success (or after a 401 showing
that it is already invalid). Clearing local credentials without contacting the
server does not revoke the token; the owner can still revoke it in Settings.

**Manage** permits paid agent starts, messages, GitHub changes and session
deletion for the selected projects. It does not permit editing global settings,
providers, credentials or device permissions. Project scoping is an API access
boundary, not a sandbox for the agents: agents still run with the server user's
machine permissions, just as in the web dashboard.

## Cloudflare Access

Keep the existing tunnel and dashboard Access policy. On the same hostname,
create a more specific Access application covering **`/api/mobile/v1` and
`/api/mobile/v1/*`**, with a **Bypass → Include → Everyone** policy. This removes
the interactive Cloudflare Access login for only these routes; Briareus still
requires its bearer token on every mobile endpoint, including discovery.

Do **not** exempt `/api/*`, `/api/mobile-devices`, `/settings`, `/login`, or the
whole hostname. The browser management API stays under Cloudflare Access and
Briareus cookie authentication. A mobile token cannot use those browser APIs.
No Cloudflare service token needs to be distributed with the iPhone app.

Cloudflare selects the more specific application path; check the root and
wildcard coverage in the [application path rules](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/app-paths/)
and [Bypass policy examples](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/common-policies/).
These are Cloudflare dashboard changes, not settings this repository applies.

Verify after deployment, without Cloudflare or Briareus cookies:

```sh
curl -i https://briareus.example.com/api/mobile/v1/
# Expected: 401, application/json, WWW-Authenticate: Bearer ...
# A 302 or HTML login page means Cloudflare Access still intercepts this path.

curl -i https://briareus.example.com/settings/mobile
# Expected: still protected by Cloudflare Access.
```

Also test a valid token, a revoked token, a foreign project, and the protected
`/api/mobile-devices` management path before relying on the public deployment.

## HTTP contract

All paths below are relative to `/api/mobile/v1`. Requests carry:

```http
Authorization: Bearer brm_<device-token>
Accept: application/json
Content-Type: application/json
```

`Content-Type` is needed for JSON bodies. No cookies, Cloudflare headers, query
tokens or `Origin` header are required. Browser origins are rejected and CORS
is not enabled; use native networking such as `URLSession`. JSON request bodies
are limited to 1 MiB. Responses use `Cache-Control: no-store`.

| Method | Path                 | Response                                                                                         |
| ------ | -------------------- | ------------------------------------------------------------------------------------------------ |
| GET    | `/`                  | `{ "version": 1, "device": { "id", "label", "repos", "permission", "createdAt", "expiresAt" } }` |
| GET    | `/operations`        | `{ "operations": [{ "name", "description", "inputSchema", "readOnly" }] }`                       |
| GET    | `/openapi.json`      | OpenAPI 3.1 document with operation request schemas and bearer security                          |
| POST   | `/operations/{name}` | Operation-specific JSON result; success is always HTTP 200                                       |
| DELETE | `/token`             | `{ "ok": true }`; revokes the token used for this request                                        |

The response notation in the table lists field names, not literal JSON.
Device timestamps are milliseconds since the Unix epoch. Operations use POST
for both reads and writes so their typed arguments stay in JSON. `{}` is the
body for argument-free operations. The catalog marks reads with `readOnly: true`;
the server rejects every other operation for a read-only token. All devices can
revoke their own token.

The API shares the existing dashboard handlers. Read the authenticated catalog
for the installed server's complete set of operations and exact input schemas;
unknown fields are rejected. OpenAPI describes request validation, while result
objects retain the dashboard's extensible shapes. A client should ignore unknown
response fields and unknown event kinds. Optional fields may be absent or null.

### Main operations

| Name                                           | Arguments                                                                | Result                                                           |
| ---------------------------------------------- | ------------------------------------------------------------------------ | ---------------------------------------------------------------- |
| `projects`                                     | `{}`                                                                     | `{ "projects": [{ "repo": "owner/repo", "label": "Project" }] }` |
| `sessions`                                     | `{ "repo": "owner/repo" }`                                               | `{ "sessions": [...] }`, only that permitted project             |
| `session`                                      | `{ "sessionId": "...", "since": 0 }`                                     | `{ "session": {...}, "events": [...] }`                          |
| `start_session`                                | `{ "repo": "owner/repo", "prompt": "..." }`                              | `{ "session": {...} }`                                           |
| `message`                                      | `{ "sessionId": "...", "text": "..." }`                                  | `{ "session": {...} }`; may queue while running                  |
| `rename`                                       | `{ "sessionId": "...", "title": "..." }`                                 | `{ "session": {...} }`                                           |
| `cancel`, `close`, `reopen`, `serve`, `delete` | `{ "sessionId": "..." }`                                                 | Operation-specific result; refresh session/list after success    |
| `pulls`, `branches`, `usage`                   | `{ "repo": "owner/repo" }`                                               | Project dashboard result                                         |
| `pull`, `findings`                             | `{ "repo": "owner/repo", "pr": 123 }`                                    | PR details or findings                                           |
| `review`, `qa`                                 | `{ "repo": "owner/repo", "prNumber": 123, "branch": "feature/example" }` | Started session                                                  |

Additional operations cover findings drafts, triage, replies, queued messages,
review/QA loops and the configured dashboard actions. Session operations infer
the project from `sessionId`; a caller cannot override it. Starts use the
project's configured review runtime or the action's configured step runtime,
as applicable. Configure those in the web Settings first. Provider/model
overrides are not accepted from the phone.

### Requests to try

Use a token supplied at runtime in `$BRIAREUS_DEVICE_TOKEN` (do not commit it).

```sh
curl --fail-with-body https://briareus.example.com/api/mobile/v1/operations/projects \
  -H "Authorization: Bearer $BRIAREUS_DEVICE_TOKEN" \
  -H 'Content-Type: application/json' -d '{}'

curl --fail-with-body https://briareus.example.com/api/mobile/v1/operations/sessions \
  -H "Authorization: Bearer $BRIAREUS_DEVICE_TOKEN" \
  -H 'Content-Type: application/json' -d '{"repo":"owner/repo"}'

# Requires Manage; starts a paid agent session.
curl --fail-with-body https://briareus.example.com/api/mobile/v1/operations/start_session \
  -H "Authorization: Bearer $BRIAREUS_DEVICE_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"repo":"owner/repo","prompt":"Explain this project without changing files"}'

curl --fail-with-body https://briareus.example.com/api/mobile/v1/operations/session \
  -H "Authorization: Bearer $BRIAREUS_DEVICE_TOKEN" \
  -H 'Content-Type: application/json' -d '{"sessionId":"ID_FROM_RESPONSE","since":0}'
```

### Conversations and incremental updates

A session includes its `id`, `repo`, `status` and optional display fields such as
`title`, `provider`, `model`, usage and PR information. Treat the response's
`session` as the current snapshot. The events array holds numbered log entries
with `seq`, `t`, `kind` and kind-specific fields. Text events commonly include
`text`; tool and result events carry different data. Reuse the event rendering
rules in `public/developer.js` when building a complete transcript UI.

For a first load call `session` with `since: 0`. Save the largest received
`seq`, then poll with that value to receive entries strictly after it. Deduplicate
by `(sessionId, seq)` and persist the cursor only together with its events. The
session snapshot still updates when `events` is empty. Re-entering the app
should fetch from the saved cursor; use zero when no local transcript exists.

Poll only while the relevant screen is active (for example every 2 seconds for
an active conversation, less often while idle), and back off on network errors.
Read requests may be retried. Do not automatically retry writes after a timeout:
the action may already have succeeded, and v1 has no idempotency keys. Refresh
the session list/transcript before offering a retry.

V1 uses polling, not an SSE/WebSocket connection. It does not provide APNs push
notifications, file upload/download, voice transcription, workspace previews,
provider management or all web-only composer modes. URLs embedded in results
(such as preview or attachment links) keep their existing browser protection;
the device token does not authorize them. These features can be added as
separate mobile endpoints when the iOS app needs them.

### Errors

Errors are JSON: `{ "error": "message" }`. Use the HTTP status for decisions,
not English message matching. Never interpret a proxy's HTML response as JSON.

| Status | Client behavior                                                                |
| ------ | ------------------------------------------------------------------------------ |
| 400    | Show argument or operation error; fix the request before retrying              |
| 401    | Token missing, expired, revoked or invalid; reconnect with a new token         |
| 403    | Read-only device attempted a write, disallowed project, or browser Origin      |
| 404    | Unknown route/operation, missing session or session outside permitted projects |
| 409    | Operation conflicts with current state; refresh before retrying                |
| 413    | JSON request exceeds 1 MiB                                                     |
| 429    | If returned by the edge, honor Retry-After and back off                        |
| 5xx    | Backend unavailable; show a retry state and avoid blindly repeating writes     |

## Implementation and checks

`lib/mobile-auth.js` handles device credentials, `lib/mobile-api.js` contains
the dedicated native and browser management routers, and
`lib/dashboard-routes.js` enforces the shared project boundary. Mobile tokens
are separate from MCP OAuth and internal agent tokens. Owner management writes
retain the existing same-origin check. Device records use the same single-server
in-memory cache/persistence model as remote MCP settings; multiple independent
Briareus processes must not share that database for token management.

Run the auth/transport regression checks with:

```sh
env -u PREVIEW_HOSTNAME -u PREVIEW_ACCESS_EMAILS \
  npx vitest run test/mobile-api.test.js test/dashboard-mcp.test.js test/remote-mcp.test.js test/auth.test.js
```
