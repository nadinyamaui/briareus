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

| Area          | Paths                                                                                               | Needs         |
| ------------- | --------------------------------------------------------------------------------------------------- | ------------- |
| The token     | `/`, `/openapi.json`, `/token`, `/events`                                                           | read          |
| Projects      | `/projects`, `/branches`, `/runtimes`, `/usage`, `/actions`                                         | read / manage |
| Pull requests | `/pulls`, `/pulls/{number}` and its files, commits, checks, comments, reviews; `/commits`           | read / manage |
| Sessions      | `/sessions`, `/sessions/{id}` and its messages, events, findings, preview, loops; `/preview/access` | read / manage |
| Composer      | `/prompts`, `/uploads`, `/transcribe`, `/providers`                                                 | read to admin |
| Memory        | `/memories`, `/memories/health`                                                                     | read / admin  |
| Operations    | `/attention`, `/maintenance`, `/deployments`, `/ssh/requests`, `/tasks`, `/videos`                  | admin         |
| Settings      | `/settings/projects`, `providers`, `db-servers`, `workspaces`, `ssh/servers`, `templates`           | admin         |
| Tokens        | `/settings/devices`                                                                                 | admin         |

Everything the removed dashboard could do has a route, except its browser push
notifications, which went with it. The reference ends with a table from each of
the dashboard's retired routes to the one that replaces it, for porting a page. `npm test` fails if a handler is added without a route
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
Briareus still requires its token on every route. GitHub's deliveries need
the same for **`/webhooks/*`**, since they authenticate themselves with an
HMAC. Nothing else needs exempting: every other path answers 404 or 410.

## Tokens

An admin token manages tokens: `/settings/devices` lists, issues and revokes
them. A token's secret is in the answer that creates it and nowhere afterwards.

An admin token can issue other tokens, admin ones included. Revoking a leaked
admin token is therefore not enough on its own: check the device list for
tokens it issued. With no admin token left, `npm run create-token` issues a new
one, and `npm run create-token -- --list` / `--revoke <id>` do the same checking
and revoking from the machine.

## What is not in this API

- Signing in. The server has no login of its own; a client authenticates its
  users itself and calls with its token.
- `/api/agent/*`: the calls an agent makes from inside its own session.
- `/webhooks/*`: deliveries from GitHub and from systems that wake a session.
- `/healthz` is public and outside the prefix: 200 when the server and its
  database answer.

Anything else under `/api` answers 410, and any other path a JSON 404.

Test-run videos are fetched at `/videos/*file` here, with a token. Without an
R2 bucket that is also where the links a run leaves on a pull request point,
so they open only for a client holding a token; configure R2 for links anyone
holding them can watch.
