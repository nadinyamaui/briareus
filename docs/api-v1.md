# Client API v1

`/api/v1` is the one HTTP API a Briareus client talks to: a web app in its own
repository, a desktop app, the iOS app. It is the only API the server has: the
routes the built-in dashboard called with its login cookie (`/api/dev/*`,
`/api/projects`, …) and the earlier mobile API (`/api/mobile/v1`) are retired,
and every handler they reached is behind a route here.

It is for servers and native apps. A browser page is refused: the token would
sit in page script, so CORS is off and a web client calls from its own server.

## Connect a client

1. Enable the password login (`npm run set-password`). The API fails closed
   with 503 while the login is off: a token is tied to the `AUTH_SECRET` that
   command writes.
2. Create the first token on the server itself, then restart the server so it
   loads it:

   ```sh
   npm run create-token -- --label Desktop
   ```

   That is an admin token good for 365 days. `--permission read|manage` with
   one `--repo owner/name` per project makes a narrower one, and `--days`
   (1–365) sets the expiry.

3. Give the client the address `https://<your-host>/api/v1` and the token. The
   token is shown once.
4. Check it: `GET /` answers with the token's own record.

```sh
curl -s https://briareus.example.com/api/v1/ -H "Authorization: Bearer brm_..."
# {"version":1,"client":{"id":"...","label":"Web","repos":[],"permission":"admin",...},"transcribe":false}
```

Tokens are stored as hashes only. Revoking one, its expiry, or a changed
`AUTH_SECRET` stops it at the next request, and ends its open event streams
within 15 seconds. A client can revoke its own token with `DELETE /token`. Only
the first token needs the command line; after that an admin token issues and
revokes the others (see [Tokens and connections](#tokens-and-connections)), and
those take effect at once, with no restart.

## Permissions

| Permission | What it may do                                                                                       |
| ---------- | ---------------------------------------------------------------------------------------------------- |
| `read`     | Read the projects it was given: sessions, transcripts, pull requests, findings, usage                |
| `manage`   | Also start paid agents, send messages, merge, decide findings and delete sessions, on those projects |
| `admin`    | Everything, on every project: settings, provider keys, SSH approvals, deployments, tokens            |

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

| Area                   | Paths                                                                                     | Needs         |
| ---------------------- | ----------------------------------------------------------------------------------------- | ------------- |
| The token              | `/`, `/openapi.json`, `/token`, `/events`                                                 | read          |
| Projects               | `/projects`, `/branches`, `/runtimes`, `/usage`, `/actions`                               | read / manage |
| Pull requests          | `/pulls`, `/pulls/{number}` and its files, commits, checks, comments, reviews; `/commits` | read / manage |
| Sessions               | `/sessions`, `/sessions/{id}` and its messages, events, findings, preview, loops          | read / manage |
| Composer               | `/prompts`, `/uploads`, `/transcribe`, `/providers`                                       | read to admin |
| Memory                 | `/memories`, `/memories/health`                                                           | read / admin  |
| Operations             | `/attention`, `/maintenance`, `/deployments`, `/notifications`, `/ssh/requests`, `/tasks` | admin         |
| Settings               | `/settings/projects`, `providers`, `db-servers`, `workspaces`, `ssh/servers`, `templates` | admin         |
| Tokens and connections | `/settings/devices`, `/settings/mcp`                                                      | admin         |

Everything the built-in dashboard could do has a route. The reference ends with
a table from each of the dashboard's retired routes to the one that replaces
it, for porting a page. `npm test` fails if a handler is added without a route
here, since a handler with no route is one nothing can reach.

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
Everyone** policy: a native client cannot complete Access's browser sign-in.
Briareus still requires its token on every route. Do not exempt `/api/*` or the
whole hostname: the login, the consent page and the videos stay behind Access
and the password.

## Tokens and connections

An admin token manages credentials:

- `/settings/devices` lists, issues and revokes tokens. A token's secret is in
  the answer that creates it and nowhere afterwards.
- `/settings/mcp` configures the ChatGPT connection and its clients.
- `/settings/mcp/consent` is the OAuth consent step, for a client that draws
  the authorization page itself: read the request ChatGPT sent the owner's
  browser with, show it, post the owner's answer, and send the browser to the
  `redirect` that comes back. The server's own consent page at
  `/oauth/authorize`, behind the password login, still does the same.

An admin token can issue other tokens, admin ones included. Revoking a leaked
admin token is therefore not enough on its own: check the device list for
tokens it issued. With no admin token left, `npm run create-token` issues a new
one.

## What is not in this API

- Signing in. The password login (`/api/login`) is the cookie in front of the
  consent page and the recorded videos, and opens no API; a client
  authenticates its users itself and calls with its token.
- `/api/agent/*`: the calls an agent makes from inside its own session.
- `/webhooks/*`: deliveries from GitHub and from systems that wake a session.
- `/mcp` and `/oauth/token`: ChatGPT's own transport.
- `/healthz` is public and outside the prefix: 200 when the server and its
  database answer.

Anything else under `/api` answers 410 to a signed-in browser and 401 to
anything else. The built-in dashboard's pages are still served and no longer
work: they were written against the retired routes.
