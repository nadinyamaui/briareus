# Client API v1

`/api/v1` is the HTTP API used by [Briareus Windows](https://github.com/okanetsolutions/briareus-windows),
[Briareus iOS (Swift)](https://github.com/okanetsolutions/briareus-swift), and
[Briareus Meta Quest](https://github.com/okanetsolutions/briareus-quest).
Each client lives in its own repository. This repository contains only the server.
The server has no UI of its own. `/api/v1` is its only client API: the routes the removed dashboard called with
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

   Every token belongs to a [user](#users). While the server has only one,
   the first admin made when it was set up, `--user` can be left out.

2. Give the client the address `https://<your-host>/api/v1` and the token. The
   token is shown once.
3. Check it: `GET /` answers with the token's own record.

```sh
curl -s https://briareus.example.com/api/v1/ -H "Authorization: Bearer brm_..."
# {"version":1,"client":{"id":"...","userId":1,"label":"Web","repos":[],"permission":"admin",...},"user":{"id":1,"name":"Owner","role":"admin","disabled":false},"transcribe":false}
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

| Permission | What it may do                                                                      |
| ---------- | ----------------------------------------------------------------------------------- |
| `read`     | Read the projects it was given: sessions, transcripts, pull requests, usage         |
| `manage`   | Also start paid agents, send messages, merge and delete sessions, on those projects |
| `admin`    | Everything, on every project: settings, provider keys, SSH approvals, deployments   |

A `read` or `manage` token is held to its project list:

- A route about one project takes `repo` (`owner/name`): in the query of a GET
  or DELETE, in the JSON body otherwise. A project the token was not given
  answers 403, the same as one that does not exist.
- A route about one session answers 404 for a session of another project.
- `/projects`, `/sessions` and `/events` show only the token's projects.

An `admin` token carries no project list and is an admin user's own: treat it
like a password to the machine. It is what the client you run Briareus from
needs; give a client that only follows and steers sessions `manage`.

## Users

Several people can share one server. Each token belongs to a user, and the
server acts as that user: a change it makes (a finding's verdict, a reply) is
signed with their name. A user is an `admin`, who runs the server and may
hold admin tokens, or a `member`, whose tokens are `read` or `manage` on the
projects they were given. An admin token kept through a demotion acts as
`manage` on its empty project list: it loses every project and admin route,
but still reaches the routes not tied to a project (uploads, transcription,
the ▶ Run preview access token, server stats), and a stream it had open is
ended. Revoke it to cut it off entirely.

Users are added and changed on the machine, like tokens:

```sh
npm run users                               # list them
npm run users -- --add Ana                  # a member; add --role admin for an admin
npm run users -- --user Ana --role admin    # change a role
npm run users -- --disable Ana              # her tokens stop; --enable undoes it
npm run create-token -- --user Ana --label Laptop --permission manage --repo owner/name
```

### Sharing

An admin reaches every project and server. A member reaches only what an admin
shared with them, through `PUT /settings/shares` with the resource's `kind`
(`project`, `dbServer`, `sshServer`, `mcpServer`, `forgeAccount` or
`envoyerAccount`), its `id` and the `userIds` it is shared with:

```sh
curl -s -X PUT https://briareus.example.com/api/v1/settings/shares \
  -H "Authorization: Bearer brm_..." -H 'Content-Type: application/json' \
  -d '{"kind":"project","id":"2","userIds":[2]}'
```

A member's token reaches the projects it was issued with that are also shared
with them; unsharing a project takes it from all their tokens at once, and
`npm run create-token` refuses to issue a member a token on a project not
shared with them. An Envoyer account must also be shared with a member before
they can list or deploy with it. `GET /settings/shares` lists the shares, by
kind, resource or user.

### What waits on you

`GET /attention` lists what waits on the caller: an admin sees every
session's questions and failures, a member their own and the
ownerless ones of their projects. SSH commands appear for whoever rules on
them, and Slack messages only for the owner of the workspace they would go out
through. `GET /tasks/{id}`, a task's history kept after its sessions are
deleted, answers any user for the tasks they may see and 404 otherwise.

### Sessions belong to users

A session belongs to the user who started it (`ownerId`). A loop's review,
QA run and fix, and an orchestrator's workers, belong to the owner of the
session they were started for; the babysitter's errands belong to nobody. An
admin sees every session; a member sees their own and the ownerless ones of
projects shared with them, in `/sessions`, `/events`, the stats routes and
every session route (another user's session answers 404).

A session a member owns uses only the database servers, SSH servers and MCP
servers shared with that member, on top of what its project is given; one
nobody owns uses what its project is given. If the owner is disabled, their
sessions lose those servers. A member sees and rules on the SSH commands of
their own sessions with a `manage` token (`GET /ssh/requests`); an admin on
all of them. Usage records whose session each turn ran in: `GET /usage/all`
breaks spend down by `users` and filters by `user`, and `GET /usage` adds a
`users` breakdown. Turns spent before users existed are filed under the
first admin; sessions that already existed have no owner. Forge accounts are
still used only by admins.

### Your own GitHub account

Without one, everything goes to GitHub as the server's account
(`GITHUB_TOKEN`). A user can connect their own with a personal access token
(`PUT /me/github`, stored encrypted under `CREDENTIALS_KEY`; `GET /me/github`
shows only the login, `DELETE /me/github` removes it). After that:

- Changes they make through the API, such as comments, merges, labels, finding
  verdicts and board moves, are made as them. Reads keep the server's token,
  so lists and caches stay the same for everyone.
- Their sessions run `gh`, commit and push as them (`GH_TOKEN`, the git
  credential, and the author and committer set to their login and GitHub
  no-reply address). The server's own clones, fetches and setup steps, and the
  automatic PR actions, stay on the server's account.
- A disabled user's token is no longer used.

### Your own mail

Mailboxes belong to the user who connected them. `GET /mail/messages` and
the mail settings routes answer any user, held to their own mailboxes (a
`read` token reads, `manage` connects, changes and sends); an admin has no
access to a member's mail. Sessions reach their owner's mailboxes; see the
[email guide](email-mcp.md).

A disabled user's tokens answer 401 within 15 seconds, without a restart. The
last enabled admin cannot be demoted or disabled. When the server was first
upgraded to users, it created an admin named `Owner` and gave every existing
token to them. `GET /` names the token's user, and an admin can list
everyone with `GET /users`.

## Conventions

- Send `Authorization: Bearer <token>` on every request. No cookies.
- JSON bodies need `Content-Type: application/json` and are limited to 1 MiB.
  Uploads send the raw bytes (up to 500 MiB) with any other content type,
  such as `application/octet-stream`; voice notes are limited to 25 MiB.
- An error is `{ "error": "..." }` with a 4xx or 5xx status. 401 means the
  token is missing, wrong, expired or revoked; 403 that it lacks the permission
  or the project.
- Responses may grow: ignore fields and event kinds you do not know.
- `GET /openapi.json` describes every route: its parameters and body with
  their types, its answer, the permission it needs (`x-briareus-access`) and
  how it is held to a project (`x-briareus-scope`).
- A start (`POST /sessions`, `POST /actions`, `POST /pulls/{number}/serve`,
  `POST /branches/serve`) that names no `provider` runs on the project's configured action runtime, or
  the errand's own step runtime. `GET /runtimes` lists what can be named.

## Routes

[The reference](api-v1-reference.md) lists every route with its fields, their
types and what it answers. `GET /openapi.json` is the same catalog as an
OpenAPI 3.1 document, with a schema for every request and response. Both are
generated from `lib/api-v1-catalog.js`, which is also what the server routes
from, so neither can describe a route the server does not have.

What is there, by area:

See the [feature overview](features.md) for server capabilities and recent additions.

| Area                     | Paths                                                                                                                                                                                                | Needs                     |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| The token                | `/`, `/openapi.json`, `/token`, `/events`, `/me/github`, `/me/home-assistant`; `/users`                                                                                                              | read; admin               |
| Projects                 | `/projects`, `/branches`, `/runtimes`, `/usage`, `/actions`                                                                                                                                          | read / manage             |
| Pull requests and issues | `/pulls`, `/pulls/{number}` and its files, commits, checks, comments, reviews; `/commits`; `/repo/tree`, `/repo/file`, `/repo/archive`; `/issues/{number}` and its timeline, close; `/project-board` | read / manage             |
| Sessions                 | `/sessions`, `/sessions/{id}` and its messages, events, preview, loops; `/preview/access`                                                                                                            | read / manage             |
| Composer                 | `/prompts`, `/uploads`, `/transcribe`, `/providers`                                                                                                                                                  | read to admin             |
| Memory                   | `/memories`, `/memories/health`                                                                                                                                                                      | read / admin              |
| Slack inbox              | `/slack/workspaces`, `/slack/workspaces/{id}/conversations`, `people`, `direct-messages`, `events`; conversation history, threads, replies and read positions                                        | your own                  |
| WhatsApp inbox           | `/whatsapp/accounts`, account linking, QR codes, conversations, messages, read receipts and media downloads                                                                                          | your own                  |
| Operations               | `/maintenance`, `/deployments`, `/videos`; `/ssh/requests`, `/slack/requests`; `/attention`, `/tasks`                                                                                                | admin; manage Slack; read |
| Home Assistant           | `/home-assistant`, `/home-assistant/entities`, `/home-assistant/services`, `/home-assistant/events/{type}`; `/me/home-assistant`                                                                     | your own                  |
| Mail                     | `/mail/messages`, `/mail/accounts/{account}/messages/{id}`                                                                                                                                           | your own                  |
| Laravel Forge            | `/forge/accounts/{account}/servers`, sites, deployment scripts and environment files                                                                                                                 | admin                     |
| Laravel Envoyer          | `/envoyer/accounts`, account projects, servers and deployments                                                                                                                                       | read / manage             |
| Settings                 | `/settings/projects`, `providers`, `db-servers`, `workspaces`, `ssh/servers`, `mcp/servers`, `forge/accounts`, `envoyer/accounts`, `templates`, `shares`; `slack/workspaces`, `mail/accounts`        | admin; your own           |

Everything the removed dashboard could do has a route, except its browser push
notifications, which went with it. The reference ends with a table from each of
the dashboard's retired routes to the one that replaces it, for porting a page. `npm test` fails if a handler is added without a route
here, since a handler with no route is one nothing can reach.

## Slack inbox

Slack is a core business inbox, independent of agent sessions: no Claude run,
project association or session token is needed to read or reply. Each
workspace belongs to the user who connected it, since its token reads their
private DMs and sends as them: every user, admin or member, reaches only their
own workspaces (`read` to read, `manage` to send or change), and another's
answers 404. Workspaces connected before users existed belong to the original
operator, regardless of their current role. Only a workspace's owner sees and rules on what sessions want to send
through it (`/slack/requests`), and a session uses its owner's workspace for its
project; each user may connect their own workspace for the same project. The existing session tools and their approvals
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

## WhatsApp inbox

Admin clients use `/whatsapp/accounts` to link a phone through a local WAHA
service, read conversations and messages, send text replies, mark chats read,
and download attachments. The server provides the API; the client provides
the QR display and inbox UI. See [WhatsApp setup and client flow](whatsapp.md)
for installation, pagination, engine limitations and session-tool access.

## Gmail and Outlook mail

Admin clients connect mailboxes through `/settings/mail/accounts/connect`
and read the synced copy through `/mail/messages` and
`/mail/accounts/{account}/messages/{id}`. Search covers the configured sync
window, and message reads do not mark mail as read.

`DELETE /mail/accounts/{account}/messages/{id}` moves one message to Gmail
Trash or Outlook Deleted Items. It requires a mailbox connected with
`access: manage`; a read-only connection returns 409 and must be reconnected.
It does not permanently erase mail. An uncertain provider write is not retried
automatically.

`POST /mail/accounts/{account}/messages/{id}/reply` with `{ "text": "…" }`
sends a plain-text reply to the message's Reply-To (or sender), threaded on
the original. It also needs `access: manage` (403 otherwise). A 502 means the
send may have gone out: sync and check Sent before retrying.

Sending new mail, marking read/unread, archiving and trashing are also
available through guarded tools in opted-in interactive sessions. These
tools are internal session APIs, separate from the client mail routes.
See [mailbox setup](../README.md#mail) and [email from a session](email-mcp.md).

## Babysitting pull requests

`babysitPrs` enables periodic conflict resolution, CI fixes and code reviews on open
pull requests. A review starts when the board recommends one, at most once per head
commit and at most three per project each round. The project’s action runtime is required, and must be Claude or Codex for
reviews. Author filters (for errands that push), head-commit deduplication, capacity
limits and the repeated-push cap still apply; no feedback agents run.

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
   about it from its next turn (Claude, Codex, DeepSeek Harness and Qwen Code get Playwright's MCP tools,
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

## Download files delivered in chat

Assistant Markdown links to existing files inside the session workspace become
HTTPS download links in transcript reads and both event streams. The server
keeps a snapshot outside the workspace pool, including the rewritten transcript
link, so reopening the chat does not require the original file. Hidden files,
`node_modules`, `vendor`, paths outside the workspace, and escaping symlinks are
excluded from automatic publication. Code examples and user messages remain unchanged.
Uncached links from a pooled workspace are converted only while its ownership
marker still identifies the session, so old transcripts cannot export another
session's files after the slot is reused.

An agent can explicitly publish any intended deliverable, including a file it
created in a temporary directory, with `POST /api/agent/files?name=report.csv`
and its session bearer token. Native clients use
`POST /api/v1/sessions/:id/files?name=report.csv` with a `manage` or `admin` token.
Both accept raw bytes with `Content-Type: application/octet-stream`, up to 500 MiB,
and return `{ name, size, url }`. The session briefing instructs agents to publish
files before linking them in their replies.

Published files live under `TEST_VIDEOS_DIR/.session-files`; keep that volume
persistent and include it in backups. With the existing `R2_*` configuration,
publication uploads the file to the bucket before returning its public URL.
If R2 fails, the response uses the durable local copy at
`PUBLIC_BASE_URL/files/<unguessable-id>/<filename>`.
The URL grants download access to anyone holding it, without a client API token,
and does not expire automatically. Do not publish credentials or private configuration.
Deleting a session does not delete its published files. A remote SSH file must
first be downloaded through the authorized server tools before byte publication.

## Deploying behind Cloudflare Access

Add an Access application for **`/api/v1` and `/api/v1/*`** with a **Bypass →
Everyone** policy: a native client cannot complete Access's browser sign-in.
Briareus still requires its token on every route. GitHub's deliveries need
the same for **`/webhooks/*`**, since they authenticate themselves with an
HMAC, and so does **`/oauth/mail/callback`** when a mailbox's sign-in ends on
this server: the browser that signed in brings it a single-use `state`, which
is all it accepts. Download links under **`/files/*`** also need a bypass if
you want them to open without an Access login. Their unguessable URL grants
access to one file; Briareus does not list published files.

## What is not in this API

- Signing in. The server has no login of its own; a client authenticates its
  users itself and calls with its token.
- Managing tokens. `npm run create-token` issues, lists (`--list`) and revokes
  (`--revoke <id>`) them on the machine; a client can only revoke its own, with
  `DELETE /token`.
- Managing users. `npm run users` adds, changes and disables them on the
  machine; the API only lists them.
- `/api/agent/*`: the calls an agent makes from inside its own session.
- `/webhooks/*`: deliveries from GitHub and from systems that wake a session.
- `/files/*`: downloads of explicitly published files and assistant-linked workspace files, authorized by their unguessable URL.
- `/healthz` is public and outside the prefix: 200 when the server and its
  database answer.
- `/oauth/mail/callback` is where a Gmail or Outlook sign-in ends when its
  redirect URI is this server's own; it answers the browser in plain text.

Anything else under `/api` answers 410, and any other path a JSON 404.

Test-run videos are fetched at `/videos/*file` here, with a token. Without an
R2 bucket that is also where the links a run leaves on a pull request point,
so they open only for a client holding a token; configure R2 for links anyone
holding them can watch.

SSH server settings accept separate write-only `password` (SSH login) and
`sudoPassword` (privilege elevation) fields; omit a field to preserve it or send
an empty string to clear it. Responses expose only `hasPassword` and
`hasSudoPassword`. For key-based SSH plus sudo, leave `password` empty and set
`sudoPassword`. Agent `ssh_execute` calls may set `sudo: true` to execute their
command as root using the stored sudo password. The approval shows the elevated
command; the password is sent over SSH stdin and never included in command text.
Elevated commands have stdin closed, so they cannot consume the password when
sudo uses cached credentials or a NOPASSWD rule.

### Private SSH file upload (agent API)

`POST /api/agent/ssh/upload` takes JSON `{serverId, sourcePath, destination, timeoutSeconds?}`
under the session bearer token and returns `{request}`; it shares SSH approvals and
`GET /api/agent/ssh/requests/:id` polling with command execution.
`request.upload` contains `{sourcePath, destination, size, sha256}` for approval and history;
`request.command` describes the upload without file bytes or credentials.
Only enabled servers assigned to the session project and shared with its owner are usable.
Sources are limited to 25 MiB and to non-hidden regular workspace files or attachments
delivered to the session; arbitrary local paths and symlinks are rejected.
The remote destination is an absolute file path, atomically replaced as the SSH user
with mode `0600` after size and SHA-256 verification; `python3` is required and sudo is
unsupported. Changed sources fail before connecting. No public file URL is involved.

## Main database backups to R2

Set `databaseBackupEnabled: true` with `PUT /api/v1/settings/projects/{id}`.
The server backs up the database in the main `localDir/.env` every 24 hours,
including projects disabled for new sessions; it never uses a session database or
`envTemplate`. Projects without a main database are recorded as skipped.
Backups require explicit opt-in for every project, including existing projects.

`POST /api/v1/settings/projects/{id}/backup` starts a backup immediately (202),
and `GET` at the same path returns its status, last successful upload time,
R2 object key and size, or the failure reason. Both routes require an admin token.
Overlapping runs for one project are coalesced; failed scheduled backups retry
hourly. MySQL needs `mysqldump`, PostgreSQL needs `pg_dump` compatible with the
server version, and SQLite uses Node's online backup API. Database URL query
options are rejected; databases requiring custom connection options need separate
backup configuration.
The self-project uses Briareus's environment parsing and separate `DB_*` fields,
ignoring `DB_URL` and `DATABASE_URL`. MySQL projects declaring
`mysql2` as a runtime dependency (and the self-project) use TCP, including for
`localhost`. Other MySQL projects using `localhost` must set `DB_SOCKET` for socket
transport or use an explicit TCP host such as `127.0.0.1`. Backups ignore MySQL
option and login files so ambient filters cannot silently omit tables or data.
MySQL's consistent snapshot covers transactional tables; schema changes during a
backup and nontransactional tables require a separate maintenance window.

Backups stream through gzip and AES-256-GCM before upload to the existing `R2_*`
bucket under `database-backups/<owner>/<repo>/`. No unencrypted dump is uploaded,
and temporary files are removed after the attempt. Keep a separate secure copy of
`CREDENTIALS_KEY`: the original key is required to recover these backups, even if
it has since been rotated on the server. Objects are retained until removed by
an operator or an R2 lifecycle rule; this feature does not delete older backups.

Download the encrypted object using your R2 console, then authenticate and decrypt
it on a machine configured with the original `CREDENTIALS_KEY`:

```sh
node scripts/decrypt-database-backup.js backup.sql.gz.enc database.sql.gz
gunzip database.sql.gz
```

The decrypt command refuses to overwrite an existing output. Import the resulting
SQL with `mysql` or `psql` into a separate database first to verify recovery.
For SQLite, the decrypted gzip contains the SQLite database file instead of SQL;
unzip it to a new `.sqlite` file. Restoration is an operator action; the backup
feature never writes to the source database.
