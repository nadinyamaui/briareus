# Client API v1

`/api/v1` is the one HTTP API a Briareus client talks to: Briareus Windows and
Briareus iOS, each in a repository of its own. It is the only API the server has, and
the server has no UI of its own: the routes the removed dashboard called with
its login cookie (`/api/dev/*`,
`/api/projects`, …) and the earlier mobile API (`/api/mobile/v1`) are retired,
and every handler they reached is behind a route here.

It is for servers and native apps. A browser page is refused: the token would
sit in page script, so CORS is off and a web client calls from its own server.

## Connect a client

1. Create the first token on the server itself:

   ```sh
   npm run create-token -- --label Desktop
   ```

   The first run also writes `AUTH_SECRET` into `.env`: every token is signed
   with it, and the API fails closed with 503 until it is set. Removing it and
   running the command again revokes every token at once.
   The server reads `AUTH_SECRET` at boot, so restart it after that first run.
   Later tokens need no restart: the running server picks them up within 15
   seconds.

   That is an admin token good for 365 days. `--permission read|manage` with
   one `--repo owner/name` per project makes a narrower one, and `--days`
   (1–365) sets the expiry. `--list` shows the tokens there are and
   `--revoke <id>` revokes one, also without a restart.

2. Give the client the address `https://<your-host>/api/v1` and the token. The
   token is shown once.
3. Check it: `GET /` answers with the token's own record.

```sh
curl -s https://briareus.example.com/api/v1/ -H "Authorization: Bearer brm_..."
# {"version":1,"client":{"id":"...","label":"Web","repos":[],"permission":"admin",...},"transcribe":false}
```

Tokens are stored as hashes only. Revoking one, its expiry, or a changed
`AUTH_SECRET` stops it at the next request, and ends its open event streams
within 15 seconds. A client can revoke its own token with `DELETE /token`.
Every other token is issued, listed and revoked on the machine with
`npm run create-token`; the API has no route for it, admin or not.

`--list` also shows each token's last recorded usage in UTC. Its own record
(`GET /`) includes `lastUsedAt` in epoch milliseconds, or `null` until usage
has been recorded; older tokens have no usage history to backfill. An
authenticated request counts even if the route later returns an error.
Usage is persisted at most once per minute per token, so the timestamp may
trail the latest request by less than a minute. Stream keepalive checks do
not count as new requests. Failed usage writes are logged and retried on
the next request without failing authentication; timestamps can be stale
while the database is unavailable.

## Permissions

| Permission | What it may do                                                                                       |
| ---------- | ---------------------------------------------------------------------------------------------------- |
| `read`     | Read the projects it was given: sessions, transcripts, pull requests, findings, usage                |
| `manage`   | Also start paid agents, send messages, merge, decide findings and delete sessions, on those projects |
| `admin`    | Everything, on every project: settings, provider keys, SSH approvals, deployments                    |

A `read` or `manage` token is held to its project list:

- A route about one project takes `repo` (`owner/name`): in the query of a GET
  or DELETE, in the JSON body otherwise. A project the token was not given
  answers 403, the same as one that does not exist.
- A route about one session answers 404 for a session of another project.
- `/projects`, `/sessions` and `/events` show only the token's projects.

An `admin` token carries no project list and is the operator's own: treat it
like a password to the machine. It is what the client you run Briareus from
needs; give a client that only follows and steers sessions `manage`.

## Conventions

- Send `Authorization: Bearer <token>` on every request. No cookies.
- JSON bodies need `Content-Type: application/json` and are limited to 1 MiB.
  Uploads and voice notes send the raw bytes (up to 25 MiB) with any other
  content type, such as `application/octet-stream`.
- An error is `{ "error": "..." }` with a 4xx or 5xx status. 401 means the
  token is missing, wrong, expired or revoked; 403 that it lacks the permission
  or the project.
- Responses may grow: ignore fields and event kinds you do not know.
- `GET /openapi.json` describes every route: its parameters and body with
  their types, its answer, the permission it needs (`x-briareus-access`) and
  how it is held to a project (`x-briareus-scope`).
- A start (`POST /sessions`, `POST /actions`, `POST /pulls/{number}/serve`,
  `POST /branches/serve`) that names no `provider` runs on the project's configured review runtime, or
  the errand's own step runtime. `GET /runtimes` lists what can be named.

## Routes

[The reference](api-v1-reference.md) lists every route with its fields, their
types and what it answers. `GET /openapi.json` is the same catalog as an
OpenAPI 3.1 document, with a schema for every request and response. Both are
generated from `lib/api-v1-catalog.js`, which is also what the server routes
from, so neither can describe a route the server does not have.

What is there, by area:

| Area                     | Paths                                                                                                                                                                                                | Needs         |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| The token                | `/`, `/openapi.json`, `/token`, `/events`                                                                                                                                                            | read          |
| Projects                 | `/projects`, `/branches`, `/runtimes`, `/usage`, `/actions`                                                                                                                                          | read / manage |
| Pull requests and issues | `/pulls`, `/pulls/{number}` and its files, commits, checks, comments, reviews; `/commits`; `/repo/tree`, `/repo/file`, `/repo/archive`; `/issues/{number}` and its timeline, close; `/project-board` | read / manage |
| Sessions                 | `/sessions`, `/sessions/{id}` and its messages, events, findings, preview, loops; `/preview/access`                                                                                                  | read / manage |
| Composer                 | `/prompts`, `/uploads`, `/transcribe`, `/providers`                                                                                                                                                  | read to admin |
| Memory                   | `/memories`, `/memories/health`                                                                                                                                                                      | read / admin  |
| Slack inbox              | `/slack/workspaces`, `/slack/workspaces/{id}/conversations`, `people`, `direct-messages`, `events`; conversation history, threads, replies and read positions                                        | admin         |
| Operations               | `/attention`, `/maintenance`, `/deployments`, `/ssh/requests`, `/slack/requests`, `/tasks`, `/videos`                                                                                                | admin         |
| Mail                     | `/mail/messages`, `/mail/accounts/{account}/messages/{id}`                                                                                                                                           | admin         |
| Settings                 | `/settings/projects`, `providers`, `db-servers`, `workspaces`, `ssh/servers`, `slack/workspaces`, `mail/accounts`, `templates`                                                                       | admin         |

Everything the removed dashboard could do has a route, except its browser push
notifications, which went with it. The reference ends with a table from each of
the dashboard's retired routes to the one that replaces it, for porting a page. `npm test` fails if a handler is added without a route
here, since a handler with no route is one nothing can reach.

## Slack inbox

Slack is a core business inbox, independent of agent sessions: no Claude run,
project association or session token is needed to read or reply. All inbox
routes require an **admin** API token, since a workspace includes private DMs
unrelated to project access. The existing session tools and their approvals
are separate; inbox sends are human-authored and send immediately as the
connected Slack user.

Connect a workspace through `POST /api/v1/settings/slack/workspaces` with
`{ "token": "xoxp-…", "signingSecret": "…", "projects": [] }`. The scopes and
Events API setup are in [the README](../README.md#slack). Workspaces shared
with agent sessions can also be used by the inbox; those sessions keep their
project restrictions. Credentials stay encrypted and are never returned.

Use these routes under `/api/v1`:

| Route                                                             | Purpose                                                              |
| ----------------------------------------------------------------- | -------------------------------------------------------------------- |
| `GET /slack/workspaces`                                           | List connected workspaces and their IDs                              |
| `GET /slack/workspaces/{id}/conversations`                        | List public/private channels, DMs and group DMs                      |
| `GET /slack/workspaces/{id}/people`                               | Resolve authors and choose DM recipients                             |
| `POST /slack/workspaces/{id}/direct-messages`                     | Open a DM with `{ "userId": "U…" }`                                  |
| `GET /slack/workspaces/{id}/conversations/{channel}`              | Load details, including read/unread fields where Slack provides them |
| `GET /slack/workspaces/{id}/conversations/{channel}/messages`     | Load history                                                         |
| `GET /slack/workspaces/{id}/conversations/{channel}/threads/{ts}` | Load a thread's parent and replies                                   |
| `POST /slack/workspaces/{id}/conversations/{channel}/messages`    | Send `{ "text": "…" }`, optionally with `threadTs`                   |
| `POST /slack/workspaces/{id}/conversations/{channel}/read`        | Mark read through `{ "ts": "…" }`                                    |
| `GET /slack/workspaces/{id}/events`                               | Follow incoming messages, edits and deletions via SSE                |

Directory responses contain `nextCursor`; message pages also contain `hasMore`.
Pass the next cursor as `cursor`, including after an empty page. `limit` accepts
1–200, defaults to 100 for directories and 15 for message pages, and Slack may
return fewer. History and thread routes accept exclusive `oldest` / `latest`
Slack timestamp bounds. Timestamps remain strings. Slack objects, including
mrkdwn, blocks, file metadata and thread fields, are returned as Slack shapes
them. File bytes are not proxied by these routes. Optional `types` on the
conversation list selects a comma-separated subset of `public_channel`,
`private_channel`, `im`, `mpim` (all four by default).

For a live native inbox:

1. Connect the workspace's `/events` stream with the admin bearer token; it
   starts with `ready { workspaceId, userId, refresh: true }`.
2. After **every** `ready`, reload the conversation list, visible history and
   open thread from Slack while buffering live events; then apply the buffer.
   The stream has no replay or durable event cursor, so this also recovers
   changes missed while disconnected or while the core was restarting.
3. Merge `message`, `message.changed` and `message.deleted` events, each
   `{ workspaceId, eventId, event }`, by `(channel, message ts)` rather than
   append order. Edits and thread-parent updates (`message_replied`) arrive as
   `message.changed` and carry `event.message`; deletes carry `event.deleted_ts`.
   Include the operator's own messages and bots; a thread reply is a `message`
   carrying `thread_ts`. Deduplicate any initial-history/live overlap by ts.
4. Use the returned message from a successful send for immediate display and
   merge its eventual live event by ts. Debounce read updates per conversation;
   `conversation.read { workspaceId, channel, ts }` syncs Briareus clients after
   a successful mark. Read changes made in Slack itself require a details reload.
5. On `workspace.changed` or `workspace.removed`, the stream closes: reload
   workspaces before reconnecting, and stop if the workspace was removed. A
   revoked/expired client token closes an open stream within 15 seconds.

No signing secret returns 409 on `/events`; enable Slack's signed Event
Subscriptions on behalf of users with `message.im`, `message.mpim`,
`message.channels` and `message.groups` at the workspace's `eventsUrl`.
Setting a secret does not itself subscribe the Slack app. History and sends
can work without a stream. All events are signature-checked, team-matched and
deduplicated on Slack retries; general inbox messages are never routed into
an agent session. The existing replies to agent-sent messages still follow
the session reply rules.

A Slack rate limit returns 429 and a `Retry-After` header; schedule a retry
after that interval. Slack remains the source of truth, so use events for
live updates instead of polling history. Missing scopes and refused Slack
tokens return 502 with an actionable error; an unknown workspace returns 404.
Do not automatically retry a send when a timeout makes its outcome unknown.
See Slack's [message retrieval](https://docs.slack.dev/messaging/retrieving-messages/),
[Events API](https://docs.slack.dev/apis/events-api/) and
[rate limits](https://docs.slack.dev/apis/web-api/rate-limits/) references.

## Autonomous review loops

Set `autonomousReviewLoop` to `true` with
`PUT /api/v1/settings/projects/{id}` and the body
`{ "autonomousReviewLoop": true }` to automatically fix independently verified
findings whose benefit outweighs implementation effort and regression risk.
Every review requires a fresh verifier before publication; its findings block
includes `assessment: { verified: true, evidence, worthFixing, reason }`.
Confirmed findings with `worthFixing: false` are optional and do not prolong the
loop. Previously dismissed/optional findings and findings outside the PR scope
are not automatically fixed. Missing or incomplete assessments hold the round
in Findings for a manual decision. A worthwhile low-severity defect can still
be fixed in later rounds. The fixes are pushed and reviewed
again through the existing loop; a clean round completes only after the review's
publishing policy has applied `code-approved`. Author-specific approval rules
still apply, and a missing approval label keeps the round pending for the existing
retry window before it stalls.

The setting defaults to `false`. Sessions still need their review loop enabled;
standalone reviews keep their manual findings workflow. The existing maximum
round count and repeated-findings checks still stop a loop that cannot converge.
If automatic triage fails, its held findings remain available for manual retry.

## Pull request data

To bring a PR branch up to date with its base, call
`POST /api/v1/pulls/{number}/update-branch` with
`{ "repo": "owner/name", "headSha": "<pr.headSha>", "baseRef": "<pr.baseRef>" }`.
This requires `manage` access to the project and returns HTTP 202 with
`{ "status": "accepted", "message": "Updating pull request branch." }`.
GitHub completes the update asynchronously; read the PR and its checks again
to track completion. A changed head or base branch returns 409, and GitHub
can refuse the update with 422 for conflicts or a concurrent push.

Every read takes `?repo=owner/name`. The list reads return 100 rows a page:
pass `page` (1–30) and follow `nextPage` until it is `null`. Each also returns
`pr`, the pull request as GitHub has it now, with `headSha` and `baseSha`. Pass
those two back on later pages and a push or retarget in between answers 409
instead of mixing two revisions.

| Path                              | Returns                                                                                                                            |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `/pulls`                          | The board: open pull requests with labels, checks and stacks, and the open issues                                                  |
| `/pulls/{number}`                 | `{ pr }`: state, size, up to 100 commit headlines, linked issues, review verdicts, checks summary                                  |
| `/pulls/{number}/description`     | `{ pr }`: title, body, author, refs, `mergeable`, `mergeableState`, `mergeMethods`                                                 |
| `/pulls/{number}/files`           | `{ pr, files, nextPage, truncated }`; a file is `filename`, `previousFilename`, `status`, `additions`, `deletions`, `patch`, `url` |
| `/pulls/{number}/commits`         | `{ pr, commits, nextPage }`; a commit is `sha`, `message`, `author`, `date`, `url`                                                 |
| `/pulls/{number}/checks`          | `{ pr, checks, warnings }`: every check run and commit status on the head                                                          |
| `/pulls/{number}/comments`        | `{ pr, comments, nextPage }`; a comment is `id`, `author`, `body`, `createdAt`, `updatedAt`, `url`                                 |
| `/pulls/{number}/reviews`         | `{ pr, reviews, nextPage }`; a review is `id`, `author`, `state`, `body`, `commitSha`, `submittedAt`, `url`                        |
| `/pulls/{number}/review-comments` | `{ pr, reviewComments, nextPage }`; adds `path`, `line`, `originalLine`, `side`, `diffHunk`, `reviewId`, `inReplyTo`               |
| `/pulls/{number}/findings`        | The findings Briareus's reviews declared, with their verdicts                                                                      |
| `/commits/{sha}`                  | `{ commit, files, truncated }`: one commit and the files it changed, with patches                                                  |
| `/issues/{number}`                | `{ issue }`: body, state, labels, type, parent, sub-issues, linked pull requests and Projects v2 fields                            |
| `/issues/{number}/timeline`       | `{ issue, events, nextPage }`: comments and events, oldest first; see `TimelineEvent` for the kinds                                |
| `/project-board`                  | The project's GitHub Projects v2 board, filtered and grouped into `BoardColumn`s the way its view is                               |

`patch` is `null` for a binary file or a diff GitHub would not render. GitHub
lists at most 3,000 files on a pull request, 250 commits, and 300 files on one
commit; `truncated` says when a file list hit its limit. A review comment's
`line` is `null` once a later push moved the code it was written on;
`originalLine` still says where it was.

The issue reads take `repo` the same way and answer a pull request's number
with 422. An issue's project fields need Projects: read on the server's token
(a classic token's `read:project`); without it the issue is still read, with
`projects` empty and `projectsError` carrying GitHub's reason.

`/project-board` reads the Projects v2 board a project's `projectBoard` setting
names (an organization's or a user's, by number, optionally through one of its
views), so a client can draw it as a tab after the issues; `hasBoard` on
`/projects` says which projects have one. GitHub applies the view's filter
itself, `iteration:@current` and all, and the columns follow the view's group-by
field (Status by default), each with its item count and the total of every number
field, such as Story Points. It needs the same Projects: read, and answers its
absence the same way: no columns, and `projectsError` saying why.
`POST /project-board/move` with `{ repo, itemId, columnId }` moves a card to
another column, the way dragging it does on GitHub: it sets the group-by field
to the column's value (`columnId` null clears it), and needs Projects: write.

## Events

Three server-sent event streams. Each sends a `: ping` comment every 25 seconds.

**`GET /events`** follows every session the token can see, on one connection:

| Event             | Data                       | When                                              |
| ----------------- | -------------------------- | ------------------------------------------------- |
| `session`         | The session record         | Once per session on connect, then on every change |
| `session.deleted` | `{ "id": "..." }`          | A session was deleted                             |
| `transcript`      | `{ "sessionId", "event" }` | A transcript line, only with `?transcripts=1`     |

This is what a server that relays to its own users holds open. Nothing is
replayed on reconnect: read `/sessions` again, and `/sessions/{id}?since=<seq>`
for the transcript lines after the last `event.seq` you saw.

**`GET /sessions/{id}/events`** follows one session. Transcript lines arrive as
unnamed events whose `id:` is their `seq`, so reconnecting with `Last-Event-ID`
(or `?since=<seq>`) resumes without gaps or repeats. The session record arrives
as `session` events, without an id.

**`GET /sessions/{id}/browser/stream`** shows the session's shared browser (see
below):

| Event    | Data                                         | When                                                                          |
| -------- | -------------------------------------------- | ----------------------------------------------------------------------------- |
| `tabs`   | `{ "tabs": [{ id, url, title }], "active" }` | On connect, then whenever a tab opens, closes, navigates or the view switches |
| `frame`  | `{ "data", "width", "height", "tab" }`       | On connect when there is a picture, then as the tab in view repaints          |
| `closed` | `{}`                                         | The browser stopped; the stream ends after it                                 |

## The shared browser

A session can have a Chromium of its own that its agent and its user drive
together: the agent through Playwright, a client through this API, on the same
tabs, so a client can watch the agent work, log in for it, or take over a step
and hand back with a message.

1. `POST /sessions/{id}/browser` switches it on and starts it. The agent is told
   about it from its next turn (Claude and Codex get Playwright's MCP tools,
   Grok and opencode the DevTools endpoint for `connectOverCDP`), and every turn
   that finds it down starts it again, so it survives a close and reopen. The
   profile, cookies and logins included, lasts until the session is deleted.
2. `GET /sessions/{id}/browser/stream` shows it. A frame is a base64 JPEG of the
   tab in view; draw the latest one and drop the rest. At most ten arrive a
   second, and only while somebody watches. `GET …/browser/screenshot` is a PNG
   for a client that does not hold a stream open.
3. `POST /sessions/{id}/browser/input` acts in it: `{ "type": "click", "x", "y" }`,
   `{ "type": "type", "text" }`, `{ "type": "key", "key": "Enter" }`,
   `{ "type": "wheel", "x", "y", "deltaY" }`, `{ "type": "navigate", "url" }`, and
   `back`, `forward`, `reload`, `tab`, `newTab`, `closeTab`. Coordinates are in the
   viewport's CSS pixels, the `width` × `height` every frame carries: a client
   that draws the frame at another size scales its pointer by
   `frame.width / drawnWidth` first.
4. `DELETE /sessions/{id}/browser` switches it off.

The session record's `browser` is `null` while it is off and `{ "running" }`
while it is on, so a client knows when to offer the view without asking.

## Deploying behind Cloudflare Access

Add an Access application for **`/api/v1` and `/api/v1/*`** with a **Bypass →
Everyone** policy: a native client cannot complete Access's browser sign-in.
Briareus still requires its token on every route. GitHub's deliveries need
the same for **`/webhooks/*`**, since they authenticate themselves with an
HMAC, and so does **`/oauth/mail/callback`** when a mailbox's sign-in ends on
this server: the browser that signed in brings it a single-use `state`, which
is all it accepts. Nothing else needs exempting: every other path answers 404
or 410.

## What is not in this API

- Signing in. The server has no login of its own; a client authenticates its
  users itself and calls with its token.
- Managing tokens. `npm run create-token` issues, lists (`--list`) and revokes
  (`--revoke <id>`) them on the machine; a client can only revoke its own, with
  `DELETE /token`.
- `/api/agent/*`: the calls an agent makes from inside its own session.
- `/webhooks/*`: deliveries from GitHub and from systems that wake a session.
- `/healthz` is public and outside the prefix: 200 when the server and its
  database answer.
- `/oauth/mail/callback` is where a Gmail or Outlook sign-in ends when its
  redirect URI is this server's own; it answers the browser in plain text.

Anything else under `/api` answers 410, and any other path a JSON 404.

Test-run videos are fetched at `/videos/*file` here, with a token. Without an
R2 bucket that is also where the links a run leaves on a pull request point,
so they open only for a client holding a token; configure R2 for links anyone
holding them can watch.
