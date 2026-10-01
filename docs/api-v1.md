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
client can revoke its own token with `DELETE /token`. Tokens are only ever
created in the dashboard, behind the password: no token can mint another.

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
- `GET /openapi.json` describes every route: its path, parameters, the fields a
  body may carry, the permission it needs (`x-briareus-access`) and how it is
  held to a project (`x-briareus-scope`). It does not yet describe response
  bodies.
- A start (`POST /sessions`, `POST /actions`, `POST /pulls/{number}/serve`)
  that names no `provider` runs on the project's configured review runtime, or
  the errand's own step runtime. `GET /runtimes` lists what can be named.

## Routes

All paths are relative to `/api/v1`. "Held to" is what a `read` or `manage`
token must name; an `admin` token is not held to it.

| Method | Path            | Access | What it does                                              |
| ------ | --------------- | ------ | --------------------------------------------------------- |
| GET    | `/`             | read   | The token's own record, the API version, server abilities |
| GET    | `/openapi.json` | read   | This API as an OpenAPI 3.1 document                       |
| DELETE | `/token`        | read   | Revoke the token used for this request                    |
| GET    | `/events`       | read   | Follow every session in scope; see [Events](#events)      |

### Projects and pull requests

| Method | Path                                | Access | Held to | What it does                                                                                                     |
| ------ | ----------------------------------- | ------ | ------- | ---------------------------------------------------------------------------------------------------------------- |
| GET    | `/projects`                         | read   |         | List the projects this token can use                                                                             |
| GET    | `/branches`                         | read   | `repo`  | List a project’s branches                                                                                        |
| GET    | `/runtimes`                         | read   | `repo`  | List the providers, models and efforts a session can start on, and the project’s default                         |
| GET    | `/usage`                            | read   | `repo`  | Read a project’s usage and costs this month                                                                      |
| GET    | `/actions`                          | read   |         | List the pull request errands                                                                                    |
| POST   | `/actions`                          | manage | `repo`  | Start an errand on a pull request; starts a paid session                                                         |
| GET    | `/pulls`                            | read   | `repo`  | List a project’s pull requests and issues                                                                        |
| GET    | `/pulls/{number}`                   | read   | `repo`  | Read a pull request’s overview: state, size, commit headlines, linked issues, review verdicts and checks summary |
| GET    | `/pulls/{number}/description`       | read   | `repo`  | Read a pull request’s body, mergeability and allowed merge methods                                               |
| GET    | `/pulls/{number}/files`             | read   | `repo`  | Read one page (100) of a pull request’s changed files with their patches                                         |
| GET    | `/pulls/{number}/commits`           | read   | `repo`  | Read one page (100) of a pull request’s commits                                                                  |
| GET    | `/pulls/{number}/checks`            | read   | `repo`  | Read every check run and commit status on a pull request’s head                                                  |
| GET    | `/pulls/{number}/comments`          | read   | `repo`  | Read one page (100) of a pull request’s conversation comments                                                    |
| GET    | `/pulls/{number}/reviews`           | read   | `repo`  | Read one page (100) of a pull request’s reviews                                                                  |
| GET    | `/pulls/{number}/review-comments`   | read   | `repo`  | Read one page (100) of a pull request’s inline review comments                                                   |
| GET    | `/pulls/{number}/findings`          | read   | `repo`  | Read the review findings declared on a pull request, with their verdicts                                         |
| POST   | `/pulls/{number}/findings/decision` | manage | `repo`  | Record a verdict on a finding; may post to GitHub                                                                |
| POST   | `/pulls/{number}/merge`             | manage | `repo`  | Merge a pull request on GitHub                                                                                   |
| POST   | `/pulls/{number}/serve`             | manage | `repo`  | Prepare a workspace for a pull request and serve it with the project’s run commands                              |
| GET    | `/commits/{sha}`                    | read   | `repo`  | Read one commit with the files it changed and their patches                                                      |

### Sessions

| Method | Path                              | Access | Held to | What it does                                                                                        |
| ------ | --------------------------------- | ------ | ------- | --------------------------------------------------------------------------------------------------- |
| GET    | `/sessions`                       | read   |         | List the sessions of this token’s projects                                                          |
| POST   | `/sessions`                       | manage | `repo`  | Start a session; starts a paid agent                                                                |
| GET    | `/sessions/{id}`                  | read   | session | Read a session and its transcript from an event offset                                              |
| GET    | `/sessions/{id}/events`           | read   | session | Follow one session: its transcript lines, resumable with Last-Event-ID, and `session` record pushes |
| PATCH  | `/sessions/{id}`                  | manage | session | Edit a session’s title or compaction settings, one per request                                      |
| DELETE | `/sessions/{id}`                  | manage | session | Close a session and delete its record and transcript                                                |
| POST   | `/sessions/{id}/messages`         | manage | session | Send a message to a session; may start a paid turn                                                  |
| DELETE | `/sessions/{id}/queue/{index}`    | manage | session | Take back a queued message                                                                          |
| POST   | `/sessions/{id}/cancel`           | manage | session | Stop the running turn                                                                               |
| POST   | `/sessions/{id}/close`            | manage | session | Close a session, releasing its workspace and database server                                        |
| POST   | `/sessions/{id}/reopen`           | manage | session | Reopen a closed session without messaging the agent                                                 |
| POST   | `/sessions/{id}/serve`            | manage | session | Serve the session’s checkout with one of the project’s run profiles                                 |
| POST   | `/sessions/{id}/compact`          | manage | session | Compact the session’s context                                                                       |
| POST   | `/sessions/{id}/clear`            | manage | session | Hide the transcript so far; the stored log keeps it                                                 |
| POST   | `/sessions/{id}/review-loop`      | manage | session | Arm or disarm automatic review rounds                                                               |
| POST   | `/sessions/{id}/qa-loop`          | manage | session | Arm or disarm automatic QA                                                                          |
| POST   | `/sessions/{id}/link-pr`          | manage | session | Attach a pull request to the session after verifying its branch                                     |
| POST   | `/sessions/{id}/findings/triage`  | manage | session | Complete findings triage; may start paid agents and post to GitHub                                  |
| POST   | `/sessions/{id}/findings/save`    | manage | session | Save findings drafts and post them to GitHub                                                        |
| POST   | `/sessions/{id}/findings/reply`   | manage | session | Reply on a finding’s GitHub thread                                                                  |
| POST   | `/sessions/{id}/findings/delete`  | manage | session | Delete a finding and its GitHub comment                                                             |
| GET    | `/sessions/{id}/preview`          | read   | session | Read the links of a session’s running preview                                                       |
| POST   | `/sessions/{id}/preview/feedback` | manage | session | Send feedback on a preview page as a message with an annotated screenshot                           |
| GET    | `/sessions/{id}/webhook`          | admin  |         | Read a session’s webhook settings, URL and signing keys                                             |
| PUT    | `/sessions/{id}/webhook`          | admin  |         | Change a session’s webhook settings                                                                 |
| POST   | `/sessions/{id}/webhook/rotate`   | admin  |         | Replace a session’s webhook signing keys                                                            |
| GET    | `/sessions/{id}/recovery`         | admin  |         | Inspect what an interrupted session left behind                                                     |
| POST   | `/sessions/{id}/recovery`         | admin  |         | Resume an interrupted session from its recovery report                                              |
| GET    | `/tasks/{id}`                     | admin  |         | Read a task’s history: every session filed under it and what it cost                                |

### Composer

| Method | Path            | Access | Held to | What it does                                                                          |
| ------ | --------------- | ------ | ------- | ------------------------------------------------------------------------------------- |
| GET    | `/prompts`      | read   | `repo`  | List the saved prompts a project offers; without `repo`, the whole library            |
| POST   | `/prompts`      | admin  |         | Add a saved prompt                                                                    |
| PUT    | `/prompts/{id}` | admin  |         | Change a saved prompt                                                                 |
| DELETE | `/prompts/{id}` | admin  |         | Remove a saved prompt                                                                 |
| POST   | `/uploads`      | manage |         | Upload one attachment; send the returned id with a message                            |
| GET    | `/transcribe`   | read   |         | Whether this server can transcribe voice notes                                        |
| POST   | `/transcribe`   | manage |         | Turn a recorded voice note into text                                                  |
| GET    | `/providers`    | admin  |         | List the providers a session can start on, with every account’s login state and quota |

### Memory

| Method | Path                    | Access | Held to | What it does                                               |
| ------ | ----------------------- | ------ | ------- | ---------------------------------------------------------- |
| GET    | `/memories`             | read   | `repo`  | List a project’s memories; without `repo`, every project’s |
| GET    | `/memories/health`      | admin  |         | Read the memory health report                              |
| POST   | `/memories/merge`       | admin  |         | Merge two memories of one project                          |
| POST   | `/memories/{id}/policy` | admin  |         | Mark a memory verified, archive it or restore it           |
| POST   | `/memories`             | admin  |         | Add a memory                                               |
| PUT    | `/memories/{id}`        | admin  |         | Change a memory                                            |
| DELETE | `/memories/{id}`        | admin  |         | Remove a memory                                            |

### Operations

| Method | Path                          | Access | Held to | What it does                                                |
| ------ | ----------------------------- | ------ | ------- | ----------------------------------------------------------- |
| GET    | `/usage/all`                  | admin  |         | Read usage and costs across every project                   |
| GET    | `/attention`                  | admin  |         | List what is waiting on the operator                        |
| GET    | `/maintenance`                | admin  |         | Read whether the server is draining work                    |
| POST   | `/maintenance`                | admin  |         | Start or stop draining work                                 |
| GET    | `/ssh/requests`               | admin  |         | List the SSH commands waiting for approval                  |
| POST   | `/ssh/requests/{id}/decision` | admin  |         | Approve or deny an SSH command                              |
| GET    | `/deployments`                | admin  |         | Read a project’s deployment overview                        |
| GET    | `/deployments/config`         | admin  |         | Read a project’s deployment settings                        |
| POST   | `/deployments/config`         | admin  |         | Change a project’s deployment settings                      |
| POST   | `/deployments/plan`           | admin  |         | Plan a deployment                                           |
| POST   | `/deployments/dispatch`       | admin  |         | Run a planned deployment                                    |
| POST   | `/deployments/acknowledge`    | admin  |         | Acknowledge the last deployment so another can be requested |
| GET    | `/notifications`              | admin  |         | Read the push notification status                           |
| POST   | `/notifications/config`       | admin  |         | Set the push contact address                                |
| POST   | `/notifications/subscribe`    | admin  |         | Subscribe a browser to push notifications                   |
| POST   | `/notifications/unsubscribe`  | admin  |         | Remove a push subscription                                  |
| GET    | `/videos/{file}`              | admin  |         | Download a video a test run recorded                        |

### Settings

| Method | Path                                      | Access | Held to | What it does                                                         |
| ------ | ----------------------------------------- | ------ | ------- | -------------------------------------------------------------------- |
| GET    | `/settings/projects`                      | admin  |         | List projects, with the defaults a new one starts from               |
| POST   | `/settings/projects`                      | admin  |         | Add a project                                                        |
| PUT    | `/settings/projects/order`                | admin  |         | Reorder projects                                                     |
| PUT    | `/settings/projects/{id}`                 | admin  |         | Change a project                                                     |
| DELETE | `/settings/projects/{id}`                 | admin  |         | Remove a project                                                     |
| GET    | `/settings/templates`                     | admin  |         | Read the prompt templates and their catalog                          |
| PUT    | `/settings/templates`                     | admin  |         | Change the prompt templates                                          |
| POST   | `/settings/providers/test`                | admin  |         | Probe a provider endpoint and key as a form holds them               |
| GET    | `/settings/providers`                     | admin  |         | List providers, with the defaults a new one starts from              |
| POST   | `/settings/providers`                     | admin  |         | Add a provider                                                       |
| PUT    | `/settings/providers/{id}`                | admin  |         | Change a provider                                                    |
| DELETE | `/settings/providers/{id}`                | admin  |         | Remove a provider                                                    |
| GET    | `/settings/providers/{id}/status`         | admin  |         | Read one provider’s login state, account and quota                   |
| POST   | `/settings/providers/{id}/login`          | admin  |         | Start a codex or grok device login; returns the URL to approve it at |
| POST   | `/settings/providers/{id}/login/start`    | admin  |         | Start a claude login; returns the authorization URL                  |
| POST   | `/settings/providers/{id}/login/finish`   | admin  |         | Finish a claude login with the code the authorization page showed    |
| POST   | `/settings/db-servers/test`               | admin  |         | Probe a database server as a form holds it                           |
| GET    | `/settings/db-servers`                    | admin  |         | List database servers, with the defaults a new one starts from       |
| POST   | `/settings/db-servers`                    | admin  |         | Add a database server                                                |
| PUT    | `/settings/db-servers/{id}`               | admin  |         | Change a database server                                             |
| DELETE | `/settings/db-servers/{id}`               | admin  |         | Remove a database server                                             |
| GET    | `/settings/workspaces`                    | admin  |         | List the workspace clone slots                                       |
| POST   | `/settings/workspaces/{slot}/reset-setup` | admin  |         | Forget an idle slot’s install fingerprints                           |
| POST   | `/settings/workspaces/{slot}/clean`       | admin  |         | Remove an idle slot’s dependency trees                               |
| GET    | `/settings/ssh/servers`                   | admin  |         | List SSH servers, with the defaults a new one starts from            |
| POST   | `/settings/ssh/servers`                   | admin  |         | Add a SSH server                                                     |
| PUT    | `/settings/ssh/servers/{id}`              | admin  |         | Change a SSH server                                                  |
| DELETE | `/settings/ssh/servers/{id}`              | admin  |         | Remove a SSH server                                                  |

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

## What is not in this API

- Issuing, listing and revoking tokens, and the ChatGPT connection settings:
  dashboard only, behind the password.
- `/api/agent/*`: the calls an agent makes from inside its own session.
- `/webhooks/*`: deliveries from GitHub and from systems that wake a session.

The dashboard's own routes (`/api/dev/*`, `/api/projects`, …) still exist for
the built-in pages and take only the login cookie. They are not a contract;
build against `/api/v1`.
