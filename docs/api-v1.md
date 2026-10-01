# Client API v1

`/api/v1` is the one HTTP API a Briareus client talks to: a web app in its own
repository, the iOS app, a desktop app. It reaches the same handlers the
built-in dashboard does, so a client can do everything the dashboard can, and
nothing it cannot.

It is for servers and native apps. A browser page is refused: the token would
sit in page script, so CORS is off and a web client calls from its own server.

## Connect a client

1. Enable the password login (`npm run set-password`, then restart). The API
   fails closed with 503 while the login is off.
2. Sign in to the dashboard and open **Settings → Devices and clients**
   (`/settings/mobile`). Create a token: a name, a permission, the projects it
   may use, and an expiry of 1–365 days.
3. Give the client the address `https://<your-host>/api/v1` and the token. The
   token is shown once.
4. Check it: `GET /` answers with the token's own record.

```sh
curl -s https://briareus.example.com/api/v1/ -H "Authorization: Bearer brm_..."
# {"version":1,"client":{"id":"...","label":"Web","repos":[],"permission":"admin",...},"transcribe":false}
```

Tokens are the same ones the [mobile API](mobile-api.md) uses, stored as hashes
only. Revoking one in Settings, its expiry, or a changed `AUTH_SECRET` stops it
at the next request, and ends its open event streams within 15 seconds. A
client can revoke its own token with `DELETE /token`. The first token is
created in the dashboard, behind the password; after that an admin token can
issue and revoke others (see [Tokens and connections](#tokens-and-connections)).

## Permissions

| Permission | What it may do                                                                                         |
| ---------- | ------------------------------------------------------------------------------------------------------ |
| `read`     | Read the projects it was given: sessions, transcripts, pull requests, findings, usage                  |
| `manage`   | Also start paid agents, send messages, merge, decide findings and delete sessions, on those projects   |
| `admin`    | Everything the dashboard can do, on every project: settings, provider keys, SSH approvals, deployments |

A `read` or `manage` token is held to its project list:

- A route about one project takes `repo` (`owner/name`): in the query of a GET
  or DELETE, in the JSON body otherwise. A project the token was not given
  answers 403, the same as one that does not exist.
- A route about one session answers 404 for a session of another project.
- `/projects`, `/sessions` and `/events` show only the token's projects.

An `admin` token carries no project list and is the operator's own: treat it
like the dashboard password. It is what a client that replaces the dashboard
needs; give the iPhone app `manage`.

## Conventions

- Send `Authorization: Bearer <token>` on every request. No cookies.
- JSON bodies need `Content-Type: application/json` and are limited to 1 MiB.
  Uploads and voice notes send the raw bytes (up to 25 MiB) with any other
  content type, such as `application/octet-stream`.
- An error is `{ "error": "..." }` with a 4xx or 5xx status. 401 means the
  token is missing, wrong, expired or revoked; 403 that it lacks the permission
  or the project.
- Responses are the dashboard's own shapes and may grow: ignore fields and
  event kinds you do not know.
- `GET /openapi.json` describes every route: its parameters and body with
  their types, its answer, the permission it needs (`x-briareus-access`) and
  how it is held to a project (`x-briareus-scope`).
- A start (`POST /sessions`, `POST /actions`, `POST /pulls/{number}/serve`)
  that names no `provider` runs on the project's configured review runtime, or
  the errand's own step runtime. `GET /runtimes` lists what can be named.

## Routes

[The reference](api-v1-reference.md) lists every route with its fields, their
types and what it answers. `GET /openapi.json` is the same catalog as an
OpenAPI 3.1 document, with a schema for every request and response. Both are
generated from `lib/api-v1-catalog.js`, which is also what the server routes
from, so neither can describe a route the server does not have.

What is there, by area:

| Area          | Paths                                                                                     | Needs         |
| ------------- | ----------------------------------------------------------------------------------------- | ------------- |
| The token     | `/`, `/openapi.json`, `/token`, `/events`                                                 | read          |
| Projects      | `/projects`, `/branches`, `/runtimes`, `/usage`, `/actions`                               | read / manage |
| Pull requests | `/pulls`, `/pulls/{number}` and its files, commits, checks, comments, reviews; `/commits` | read / manage |
| Sessions      | `/sessions`, `/sessions/{id}` and its messages, events, findings, preview, loops          | read / manage |
| Composer      | `/prompts`, `/uploads`, `/transcribe`, `/providers`                                       | read to admin |
| Memory        | `/memories`, `/memories/health`                                                           | read / admin  |
| Operations    | `/attention`, `/maintenance`, `/deployments`, `/notifications`, `/ssh/requests`, `/tasks` | admin         |
| Settings      | `/settings/projects`, `providers`, `db-servers`, `workspaces`, `ssh/servers`, `templates` | admin         |
| Tokens        | `/settings/devices`                                                                       | admin         |

Everything the built-in dashboard can do has a route. The reference ends with a
table from each of the dashboard's own routes to the one that replaces it, for
porting a page. `npm test` fails if a handler is added for the dashboard
without a route here.

## Pull request data

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

`patch` is `null` for a binary file or a diff GitHub would not render. GitHub
lists at most 3,000 files on a pull request, 250 commits, and 300 files on one
commit; `truncated` says when a file list hit its limit. A review comment's
`line` is `null` once a later push moved the code it was written on;
`originalLine` still says where it was.

## Events

Two server-sent event streams. Both send a `: ping` comment every 25 seconds.

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

## Deploying behind Cloudflare Access

Add an Access application for **`/api/v1` and `/api/v1/*`** with a **Bypass →
Everyone** policy, as the [mobile guide](mobile-api.md#cloudflare-access) does
for `/api/mobile/v1`. Briareus still requires its token on every route. Do not
exempt `/api/*`: the dashboard's own routes and the pages that issue tokens
stay behind Access and the password.

## Tokens

An admin token manages tokens as the dashboard's settings page does:
`/settings/devices` lists, issues and revokes them. A token's secret is in the
answer that creates it and nowhere afterwards.

An admin token can issue other tokens, admin ones included. Revoking a leaked
admin token is therefore not enough on its own: check the device list for
tokens it issued.

## What is not in this API

- Signing in. The dashboard's password login (`/api/login`) is the built-in
  pages' own; a client authenticates its users itself and calls with its token.
- `/api/agent/*`: the calls an agent makes from inside its own session.
- `/webhooks/*`: deliveries from GitHub and from systems that wake a session.
- `/healthz` is public and outside the prefix: 200 when the server and its
  database answer.

The dashboard's own routes (`/api/dev/*`, `/api/projects`, …) still exist for
the built-in pages and take only the login cookie. They are not a contract;
build against `/api/v1`.
