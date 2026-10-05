# Client API v1 reference

<!-- Written by `npm run build:api-docs` from lib/api-v1-catalog.js. Edit the catalog, not this file. -->

Every route of `/api/v1`, what it takes and what it answers. Read the [guide](api-v1.md) first: it covers tokens, permissions, errors and the event streams. Paths are relative to `/api/v1`.

A type followed by `[]` is a list and by `?` may be null. `a|b` is one of those strings. A capitalised type is an [object](#objects) described at the end. Responses may carry more fields than are listed; ignore what you do not know.

## The token

### `GET /`

The token’s own record, the API version and what this server can do. Needs `read`.

**Returns** `{ version: integer, client: Client, transcribe: boolean }`

### `GET /openapi.json`

This API as an OpenAPI 3.1 document. Needs `read`.

**Returns** `object`

### `DELETE /token`

Revoke the token used for this request. Needs `read`.

**Returns** `{ ok: boolean }`

### `GET /events`

Follow every session of this token’s projects on one connection: `session` on each record change, `session.deleted`, and `transcript` lines when asked. Needs `read`.

**Query**

| Field         | Type   |                                                               |
| ------------- | ------ | ------------------------------------------------------------- |
| `transcripts` | `0\|1` | `1` also sends a `transcript` event for every transcript line |

**Returns** a server-sent event stream; see the guide’s Events section.

## Projects

### `GET /projects`

List the enabled projects this token can use. Needs `read`.

**Returns** `{ projects: ProjectSummary[] }`

### `GET /branches`

List a project’s branches, the default one first. Needs `read`, held to `repo`.

**Query**

| Field               | Type     |                            |
| ------------------- | -------- | -------------------------- |
| `repo` **required** | `string` | A project, as `owner/name` |

**Returns** `{ defaultBranch: string?, branches: string[] }`

### `POST /branches/serve`

Prepare a workspace on a branch with no pull request, the default one unless named, and serve it with the project’s run commands, without an agent turn. Needs `manage`, held to `repo`.

**Body**

| Field               | Type      |                                                                                  |
| ------------------- | --------- | -------------------------------------------------------------------------------- |
| `repo` **required** | `string`  | A project, as `owner/name`                                                       |
| `branch`            | `string`  | An existing branch to serve; the default branch when absent                      |
| `provider`          | `integer` | A provider id from `GET /runtimes`; the project’s configured runtime when absent |
| `model`             | `string`  | A model of that provider; its default when absent                                |
| `effort`            | `string`  | An effort that model offers; its default when absent                             |

**Returns** 201 `{ session: Session, url: string, profile: string? }`. Another call for the same branch replaces the session the last one left, as long as nobody has chatted in it. An untouched session closes and deletes itself ten minutes after the last call, as a pull request’s does.

### `GET /runtimes`

List the providers, models and efforts a session can start on, and the project’s default. Needs `read`, held to `repo`.

**Query**

| Field               | Type     |                            |
| ------------------- | -------- | -------------------------- |
| `repo` **required** | `string` | A project, as `owner/name` |

**Returns** `{ default: object?, providers: object[] }`. `default` is `{ providerId, model, effort }`. A provider is `{ id, label, available, models, defaultModel }` and a model `{ id, label, efforts, defaultEffort }`. No account data.

### `GET /usage`

Read what a project spent this calendar month. Needs `read`, held to `repo`.

**Query**

| Field               | Type     |                            |
| ------------------- | -------- | -------------------------- |
| `repo` **required** | `string` | A project, as `owner/name` |

**Returns** `object`. Totals (`turns`, `sessions`, `inputTokens`, `outputTokens`, `totalTokens`, `durationMs`, `costUsd`), `daily` buckets, and breakdowns by `providers`, `models` and `activities`.

### `GET /actions`

List the errands that can be run on a pull request. Needs `read`.

**Returns** `{ actions: object[] }`. An errand is `{ id, label, icon, hint, input }`; `input` is null or `{ label, required }` when it asks the user something.

### `POST /actions`

Start an errand on a pull request; starts a paid session. Needs `manage`, held to `repo`.

**Body**

| Field                   | Type      |                                                                                  |
| ----------------------- | --------- | -------------------------------------------------------------------------------- |
| `repo` **required**     | `string`  | A project, as `owner/name`                                                       |
| `action` **required**   | `string`  | An errand id from `GET /actions`                                                 |
| `prNumber` **required** | `integer` | The pull request the work is about                                               |
| `input`                 | `string`  | The answer to what the errand asks, when it asks something                       |
| `provider`              | `integer` | A provider id from `GET /runtimes`; the project’s configured runtime when absent |
| `model`                 | `string`  | A model of that provider; its default when absent                                |
| `effort`                | `string`  | An effort that model offers; its default when absent                             |

**Returns** 201 `{ session: Session }`

## Pull requests and issues

### `GET /pulls`

Read a project’s board: its open pull requests and open issues. Needs `read`, held to `repo`.

**Query**

| Field               | Type     |                                                    |
| ------------------- | -------- | -------------------------------------------------- |
| `repo` **required** | `string` | A project, as `owner/name`                         |
| `fresh`             | `0\|1`   | `1` skips the server’s short cache and reads again |

**Returns** `{ repo: string, pulls: object[], issues: object[], stacks: object, syncedAt: string }`. A pull request row carries `number`, `title`, `url`, `draft`, `author`, `assignees`, `reviewers`, `issues`, `branch`, `baseBranch`, `updatedAt`, `labels`, `mergeable`, `checks`, `reviewDecision`, `recommended` and `stack`. An issue row carries `number`, `title`, `url`, `author`, `assignees`, `labels`, `comments`, `milestone`, `createdAt`, `updatedAt` and the `pulls` that close it.

### `GET /pulls/{number}`

Read a pull request’s standing: state, size, commit headlines, linked issues, review verdicts and a checks summary. Needs `read`, held to `repo`.

**Query**

| Field               | Type     |                            |
| ------------------- | -------- | -------------------------- |
| `repo` **required** | `string` | A project, as `owner/name` |

**Returns** `{ pr: PullOverview }`

### `GET /pulls/{number}/description`

Read a pull request’s body, mergeability and allowed merge methods. Needs `read`, held to `repo`.

**Query**

| Field               | Type     |                                                                              |
| ------------------- | -------- | ---------------------------------------------------------------------------- |
| `repo` **required** | `string` | A project, as `owner/name`                                                   |
| `headSha`           | `string` | The `pr.headSha` of an earlier page; 409 if the pull request has moved since |
| `baseSha`           | `string` | The `pr.baseSha` of an earlier page; 409 if the pull request has moved since |

**Returns** `{ pr: PullRequest }`

### `GET /pulls/{number}/files`

Read one page of a pull request’s changed files with their patches. Needs `read`, held to `repo`.

**Query**

| Field               | Type      |                                                                              |
| ------------------- | --------- | ---------------------------------------------------------------------------- |
| `repo` **required** | `string`  | A project, as `owner/name`                                                   |
| `page`              | `integer` | Which page of 100 rows, 1–30; 1 when absent                                  |
| `headSha`           | `string`  | The `pr.headSha` of an earlier page; 409 if the pull request has moved since |
| `baseSha`           | `string`  | The `pr.baseSha` of an earlier page; 409 if the pull request has moved since |

**Returns** `{ pr: PullRequest, files: File[], nextPage: integer?, truncated: boolean }`

### `GET /pulls/{number}/commits`

Read one page of a pull request’s commits. Needs `read`, held to `repo`.

**Query**

| Field               | Type      |                                                                              |
| ------------------- | --------- | ---------------------------------------------------------------------------- |
| `repo` **required** | `string`  | A project, as `owner/name`                                                   |
| `page`              | `integer` | Which page of 100 rows, 1–30; 1 when absent                                  |
| `headSha`           | `string`  | The `pr.headSha` of an earlier page; 409 if the pull request has moved since |
| `baseSha`           | `string`  | The `pr.baseSha` of an earlier page; 409 if the pull request has moved since |

**Returns** `{ pr: PullRequest, commits: Commit[], nextPage: integer? }`

### `GET /pulls/{number}/checks`

Read every check run and commit status on a pull request’s head. Needs `read`, held to `repo`.

**Query**

| Field               | Type     |                                                                              |
| ------------------- | -------- | ---------------------------------------------------------------------------- |
| `repo` **required** | `string` | A project, as `owner/name`                                                   |
| `headSha`           | `string` | The `pr.headSha` of an earlier page; 409 if the pull request has moved since |
| `baseSha`           | `string` | The `pr.baseSha` of an earlier page; 409 if the pull request has moved since |

**Returns** `{ pr: PullRequest, checks: Check[], warnings: string[] }`

### `GET /pulls/{number}/comments`

Read one page of a pull request’s conversation comments. Needs `read`, held to `repo`.

**Query**

| Field               | Type      |                                                                              |
| ------------------- | --------- | ---------------------------------------------------------------------------- |
| `repo` **required** | `string`  | A project, as `owner/name`                                                   |
| `page`              | `integer` | Which page of 100 rows, 1–30; 1 when absent                                  |
| `headSha`           | `string`  | The `pr.headSha` of an earlier page; 409 if the pull request has moved since |
| `baseSha`           | `string`  | The `pr.baseSha` of an earlier page; 409 if the pull request has moved since |

**Returns** `{ pr: PullRequest, comments: Comment[], nextPage: integer? }`

### `GET /pulls/{number}/reviews`

Read one page of a pull request’s reviews. Needs `read`, held to `repo`.

**Query**

| Field               | Type      |                                                                              |
| ------------------- | --------- | ---------------------------------------------------------------------------- |
| `repo` **required** | `string`  | A project, as `owner/name`                                                   |
| `page`              | `integer` | Which page of 100 rows, 1–30; 1 when absent                                  |
| `headSha`           | `string`  | The `pr.headSha` of an earlier page; 409 if the pull request has moved since |
| `baseSha`           | `string`  | The `pr.baseSha` of an earlier page; 409 if the pull request has moved since |

**Returns** `{ pr: PullRequest, reviews: Review[], nextPage: integer? }`

### `GET /pulls/{number}/review-comments`

Read one page of a pull request’s inline review comments. Needs `read`, held to `repo`.

**Query**

| Field               | Type      |                                                                              |
| ------------------- | --------- | ---------------------------------------------------------------------------- |
| `repo` **required** | `string`  | A project, as `owner/name`                                                   |
| `page`              | `integer` | Which page of 100 rows, 1–30; 1 when absent                                  |
| `headSha`           | `string`  | The `pr.headSha` of an earlier page; 409 if the pull request has moved since |
| `baseSha`           | `string`  | The `pr.baseSha` of an earlier page; 409 if the pull request has moved since |

**Returns** `{ pr: PullRequest, reviewComments: ReviewComment[], nextPage: integer? }`

### `GET /pulls/{number}/findings`

Read the findings Briareus’s reviews declared on a pull request, with their verdicts. Needs `read`, held to `repo`.

**Query**

| Field               | Type     |                            |
| ------------------- | -------- | -------------------------- |
| `repo` **required** | `string` | A project, as `owner/name` |

**Returns** `{ findings: Finding[], fixesUrl: string? }`

### `POST /pulls/{number}/findings/decision`

Record a verdict on a finding; `fix` updates the Required fixes comment on GitHub. Needs `manage`, held to `repo`.

**Body**

| Field               | Type                        |                             |
| ------------------- | --------------------------- | --------------------------- |
| `repo` **required** | `string`                    | A project, as `owner/name`  |
| `key` **required**  | `string`                    | The finding’s `key`         |
| `decision`          | `fix\|optional\|dismissed?` | The verdict; null clears it |

**Returns** `{ findings: Finding[], fixesUrl: string? }`

### `PATCH /pulls/{number}`

Update a pull request on GitHub. Needs `manage`, held to `repo`.

**Body**

| Field               | Type       |                                                                      |
| ------------------- | ---------- | -------------------------------------------------------------------- |
| `repo` **required** | `string`   | A project, as `owner/name`                                           |
| `title`             | `string`   | The new title; cannot be blank                                       |
| `body`              | `string`   | The new Markdown description; empty clears it                        |
| `labels`            | `string[]` | Replace all labels with these names; [] clears them                  |
| `assignees`         | `string[]` | Replace all assignees with these logins, at most ten; [] clears them |

**Returns** `{ pr: UpdatedGithubItem }`. Supply at least one update field; omitted fields stay as they are. Unknown fields and invalid values get 400. A number of the other resource type gets 422 before any write. The board cache is cleared after a successful update.

### `PATCH /issues/{number}`

Update an issue on GitHub. Needs `manage`, held to `repo`.

**Body**

| Field               | Type                                |                                                                      |
| ------------------- | ----------------------------------- | -------------------------------------------------------------------- |
| `repo` **required** | `string`                            | A project, as `owner/name`                                           |
| `title`             | `string`                            | The new title; cannot be blank                                       |
| `body`              | `string`                            | The new Markdown description; empty clears it                        |
| `labels`            | `string[]`                          | Replace all labels with these names; [] clears them                  |
| `assignees`         | `string[]`                          | Replace all assignees with these logins, at most ten; [] clears them |
| `state`             | `open\|closed`                      | Reopen or close the issue                                            |
| `stateReason`       | `completed\|not_planned\|reopened?` | Its state reason; null clears it                                     |

**Returns** `{ issue: UpdatedGithubItem }`. Supply at least one update field; omitted fields stay as they are. Unknown fields and invalid values get 400. A number of the other resource type gets 422 before any write. The board cache is cleared after a successful update.

### `POST /pulls/{number}/update-branch`

Update a pull request branch with the latest changes from its base branch on GitHub. Needs `manage`, held to `repo`.

**Body**

| Field                  | Type     |                                                                      |
| ---------------------- | -------- | -------------------------------------------------------------------- |
| `repo` **required**    | `string` | A project, as `owner/name`                                           |
| `headSha` **required** | `string` | The `pr.headSha` that was read; a push since then refuses the update |
| `baseRef` **required** | `string` | The base branch the pull request was read with                       |

**Returns** 202 `{ status: string, message: string }`. `status` is `accepted`: GitHub updates the branch asynchronously; read the pull request and checks again to track completion. A changed head or base branch returns 409; GitHub refusals, including conflicts, may return 422. This updates the PR branch without merging the PR into its base.

### `POST /pulls/{number}/merge`

Merge a pull request on GitHub, at the head and into the base it was read with. Needs `manage`, held to `repo`.

**Body**

| Field                  | Type                    |                                                                     |
| ---------------------- | ----------------------- | ------------------------------------------------------------------- |
| `repo` **required**    | `string`                | A project, as `owner/name`                                          |
| `headSha` **required** | `string`                | The `pr.headSha` that was read; a push since then refuses the merge |
| `baseRef` **required** | `string`                | The base branch the pull request was read with                      |
| `method`               | `squash\|merge\|rebase` | How to merge; `squash` when absent                                  |

**Returns** `{ merged: boolean, status: string, sha: string?, message: string }`. `status` is `merged`, `enqueued` or `pending`. A pull request in a GitHub stack merges through GitHub's asynchronous merge, which also lands every pull request below it; one GitHub has not finished within about ten seconds comes back `pending` and finishes on its own.

### `POST /pulls/{number}/serve`

Prepare a workspace for a pull request and serve it with the project’s run commands, without an agent turn. Needs `manage`, held to `repo`.

**Body**

| Field               | Type      |                                                                                  |
| ------------------- | --------- | -------------------------------------------------------------------------------- |
| `repo` **required** | `string`  | A project, as `owner/name`                                                       |
| `provider`          | `integer` | A provider id from `GET /runtimes`; the project’s configured runtime when absent |
| `model`             | `string`  | A model of that provider; its default when absent                                |
| `effort`            | `string`  | An effort that model offers; its default when absent                             |

**Returns** 201 `{ session: Session, url: string, profile: string? }`

### `GET /issues/{number}`

Read an issue in full: body, type, parent and sub-issues, linked pull requests and its Projects v2 fields. Needs `read`, held to `repo`.

**Query**

| Field               | Type     |                            |
| ------------------- | -------- | -------------------------- |
| `repo` **required** | `string` | A project, as `owner/name` |

**Returns** `{ issue: Issue }`. A pull request’s number is refused with 422, as closing one is; a number that is neither gets 404. The project fields need Projects: read on the server’s token; without it the issue is still read, with `projects` empty and `projectsError` saying why.

### `GET /issues/{number}/timeline`

Read one page of an issue’s timeline: its comments and events, oldest first. Needs `read`, held to `repo`.

**Query**

| Field               | Type      |                                             |
| ------------------- | --------- | ------------------------------------------- |
| `repo` **required** | `string`  | A project, as `owner/name`                  |
| `page`              | `integer` | Which page of 100 rows, 1–30; 1 when absent |

**Returns** `{ issue: object, events: TimelineEvent[], nextPage: integer? }`. `issue` is `{ number, title, state, url }`. Only the kinds `TimelineEvent` lists are read, so every page but the last holds 100 of them; GitHub’s other kinds (subscriptions, mentions, pins, …) are left out. A pull request’s number gets 422, an unknown one 404. Without Projects: read on the server’s token, the project kinds come with `project` null and the answer carries `projectsError`.

### `POST /issues/{number}/close`

Close an issue on GitHub, with an optional comment posted just before. Needs `manage`, held to `repo`.

**Body**

| Field               | Type                     |                                                  |
| ------------------- | ------------------------ | ------------------------------------------------ |
| `repo` **required** | `string`                 | A project, as `owner/name`                       |
| `reason`            | `completed\|not_planned` | Why it is closed; `completed` when absent        |
| `comment`           | `string`                 | A comment to post on the issue before closing it |

**Returns** `{ issue: ClosedIssue }`. A pull request’s number is refused with 422: GitHub would close it through the same endpoint, and this route closes issues only. Closing one that is already closed updates its reason.

### `GET /project-board`

Read the project’s GitHub Projects v2 board, filtered and grouped into columns the way its view is on GitHub. Needs `read`, held to `repo`.

**Query**

| Field               | Type     |                                                    |
| ------------------- | -------- | -------------------------------------------------- |
| `repo` **required** | `string` | A project, as `owner/name`                         |
| `fresh`             | `0\|1`   | `1` skips the server’s short cache and reads again |

**Returns** `{ project: object?, view: object?, groupBy: string?, columns: BoardColumn[], truncated: boolean, unsupportedFilters: string[], projectsError: string? }`. The board is the one named by the project’s `projectBoard` setting; a project without one gets 404 (`hasBoard` on `GET /projects` says which do). `project` is `{ title, url }` and `view` `{ name, number, filter, url }`, null when the setting names no view. The view’s filter is applied by GitHub itself, every qualifier included (`iteration:@current`, `-status:`, `repo:` lists, …), so `unsupportedFilters` is empty. Columns follow the view’s group-by field (Status when it names none, or one that is not a single-select or an iteration), in that field’s order, with a `No <field>` column first when items lack a value; a column the filter excludes on that field (`-status:Backlog`) is left out, as GitHub’s page does. Archived items are left out. A board spans repositories, so a token held to some projects gets only the cards of their repositories (no drafts), with each column’s `count` and `sums` over those, and a parent in another repository comes back null. `truncated` says the board stopped at 2,000 items. Reading a board needs Projects: read on the server’s token (a classic token’s `read:project`); without it, or for a project or view GitHub cannot resolve, the answer has no columns and `projectsError` says why. Cached for 45 seconds; `fresh=1` reads again. Read-only: cards cannot be moved yet.

### `GET /commits/{sha}`

Read one commit with the files it changed and their patches. Needs `read`, held to `repo`.

**Query**

| Field               | Type     |                            |
| ------------------- | -------- | -------------------------- |
| `repo` **required** | `string` | A project, as `owner/name` |

**Returns** `{ commit: CommitDetail, files: File[], truncated: boolean }`

## Sessions

### `GET /sessions`

List the sessions of this token’s projects, newest first. Needs `read`.

**Returns** `{ sessions: Session[] }`

### `POST /sessions`

Start a session; starts a paid agent. Needs `manage`, held to `repo`.

**Body**

| Field               | Type       |                                                                                  |
| ------------------- | ---------- | -------------------------------------------------------------------------------- |
| `repo` **required** | `string`   | A project, as `owner/name`                                                       |
| `prompt`            | `string`   | The first message to the agent                                                   |
| `provider`          | `integer`  | A provider id from `GET /runtimes`; the project’s configured runtime when absent |
| `model`             | `string`   | A model of that provider; its default when absent                                |
| `effort`            | `string`   | An effort that model offers; its default when absent                             |
| `branch`            | `string`   | An existing branch to work on; a fresh branch off the default one when absent    |
| `prNumber`          | `integer`  | The pull request the work is about                                               |
| `attachments`       | `string[]` | Upload ids from `POST /uploads`                                                  |
| `review`            | `boolean`  | Start a code review of `branch`                                                  |
| `qa`                | `boolean`  | Start a QA run on `branch`: a test sheet, then its execution                     |
| `reviewLoop`        | `boolean`  | Review every push the session settles with and send the findings back            |
| `qaLoop`            | `boolean`  | Run QA after the review loop passes                                              |
| `local`             | `boolean`  | Work in the project’s local checkout instead of a workspace clone                |
| `orchestrator`      | `boolean`  | Start a supervisor that runs worker sessions instead of editing code             |
| `zeus`              | `boolean`  | Start a supervisor that turns the prompt into a GitHub epic through analysts     |
| `workerRuntime`     | `object`   | `{ providerId, model, effort }` an orchestrator’s workers default to             |
| `zeusRoles`         | `object`   | The runtime each analyst role runs on, keyed by role                             |
| `activity`          | `string`   | What to file the spend under; `issue` is the only value taken                    |

**Returns** 201 `{ session: Session }`. A plain session needs `prompt` or `attachments`; a `review` or `qa` needs `branch`.

### `GET /sessions/{id}`

Read a session and its transcript. Needs `read`, held to the session’s project.

**Query**

| Field   | Type      |                                                                |
| ------- | --------- | -------------------------------------------------------------- |
| `since` | `integer` | Only transcript lines whose `seq` is above this; 0 when absent |
| `all`   | `0\|1`    | `1` includes the lines a Clear or a compaction hid             |

**Returns** `{ session: Session, events: TranscriptEvent[] }`

### `GET /sessions/{id}/events`

Follow one session: transcript lines as unnamed events whose `id:` is their `seq`, and the record as `session` events. Needs `read`, held to the session’s project.

**Query**

| Field   | Type      |                                                                |
| ------- | --------- | -------------------------------------------------------------- |
| `since` | `integer` | Only transcript lines whose `seq` is above this; 0 when absent |

**Returns** a server-sent event stream; see the guide’s Events section.

### `PATCH /sessions/{id}`

Edit a session’s title or compaction settings; one field per request. Needs `manage`, held to the session’s project.

**Body**

| Field                 | Type      |                                                                  |
| --------------------- | --------- | ---------------------------------------------------------------- |
| `title`               | `string`  | The new title                                                    |
| `autoCompact`         | `boolean` | Whether the session compacts itself when its context fills       |
| `compactInstructions` | `string`  | What every compaction of this session must keep; empty clears it |

**Returns** `{ session: Session }`

### `DELETE /sessions/{id}`

Close a session and delete its record and transcript. Needs `manage`, held to the session’s project.

**Returns** `{ ok: boolean }`

### `POST /sessions/{id}/messages`

Send a message; it starts a turn, joins the running one or waits in the queue. Needs `manage`, held to the session’s project.

**Body**

| Field         | Type       |                                                      |
| ------------- | ---------- | ---------------------------------------------------- |
| `text`        | `string`   | The text                                             |
| `attachments` | `string[]` | Upload ids from `POST /uploads`                      |
| `zeusRoles`   | `object`   | The runtime each analyst role runs on, keyed by role |

**Returns** `{ session: Session }`

### `DELETE /sessions/{id}/queue/{index}`

Take back a queued message, by its place in `session.queued`. Needs `manage`, held to the session’s project.

**Returns** `{ ok: boolean, dropped: object, session: Session }`

### `POST /sessions/{id}/cancel`

Stop the running turn. Needs `manage`, held to the session’s project.

**Returns** `{ session: Session }`

### `POST /sessions/{id}/close`

Close a session, releasing its workspace and database server. Needs `manage`, held to the session’s project.

**Returns** `{ session: Session }`

### `POST /sessions/{id}/reopen`

Reopen a closed, failed or interrupted session without messaging the agent. Needs `manage`, held to the session’s project.

**Returns** `{ session: Session }`

### `POST /sessions/{id}/serve`

Serve the session’s checkout with one of the project’s run profiles. Needs `manage`, held to the session’s project.

**Body**

| Field     | Type     |                                                                    |
| --------- | -------- | ------------------------------------------------------------------ |
| `profile` | `string` | One of the project’s run profiles; the one served last when absent |

**Returns** `{ url: string, profile: string? }`

### `GET /sessions/{id}/browser`

Read the state of the session’s shared browser. Needs `read`, held to the session’s project.

**Returns** `{ browser: Browser }`

### `POST /sessions/{id}/browser`

Switch the shared browser on and start it; the agent drives it from its next turn. Needs `manage`, held to the session’s project.

**Returns** `{ session: Session, browser: Browser }`. 409 when the session is closed; reopen it first. 503 when the server has no Chromium. The profile (cookies, logins) lasts as long as the session.

### `DELETE /sessions/{id}/browser`

Switch the shared browser off and stop it; its profile is kept until the session is deleted. Needs `manage`, held to the session’s project.

**Returns** `{ session: Session }`

### `GET /sessions/{id}/browser/stream`

Watch the shared browser: `tabs` events `{ tabs, active }` on every tab change, `frame` events (a BrowserFrame) as the tab in view repaints, and `closed` when it stops, which ends the stream. Needs `read`, held to the session’s project.

**Returns** a server-sent event stream; see the guide’s Events section.

### `GET /sessions/{id}/browser/screenshot`

A PNG of the tab in view, for a client that does not hold a stream open. Needs `read`, held to the session’s project.

**Returns** the file.

### `POST /sessions/{id}/browser/input`

Act in the shared browser: click, type, press a key, scroll, navigate or change tabs. Needs `manage`, held to the session’s project.

**Body**

| Field               | Type                                                                                              |                                                                                                                                                                         |
| ------------------- | ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `type` **required** | `click\|down\|up\|move\|wheel\|type\|key\|navigate\|back\|forward\|reload\|tab\|newTab\|closeTab` | What to do. `click`, `down`, `up`, `move` and `wheel` take `x` and `y`; `type` takes `text`; `key` takes `key`; `navigate` takes `url`; `tab` and `closeTab` take `tab` |
| `x`                 | `number`                                                                                          | From the viewport’s left edge, in the CSS pixels of a frame’s `width`                                                                                                   |
| `y`                 | `number`                                                                                          | From the viewport’s top edge, in the CSS pixels of a frame’s `height`                                                                                                   |
| `button`            | `left\|right\|middle`                                                                             | The mouse button; `left` when absent                                                                                                                                    |
| `clickCount`        | `integer`                                                                                         | 2 for a double click; 1 when absent                                                                                                                                     |
| `deltaX`            | `number`                                                                                          | On `wheel`: pixels to scroll right                                                                                                                                      |
| `deltaY`            | `number`                                                                                          | On `wheel`: pixels to scroll down                                                                                                                                       |
| `text`              | `string`                                                                                          | On `type`: the text to insert where the focus is                                                                                                                        |
| `key`               | `string`                                                                                          | On `key`: one character, or Enter, Tab, Backspace, Delete, Escape, ArrowLeft, ArrowUp, ArrowRight, ArrowDown, Home, End, PageUp, PageDown                               |
| `modifiers`         | `string[]`                                                                                        | Keys held down: `alt`, `ctrl`, `meta`, `shift`                                                                                                                          |
| `url`               | `string`                                                                                          | On `navigate` and `newTab`: an http or https URL                                                                                                                        |
| `tab`               | `string`                                                                                          | On `tab`: the tab to bring into view; on `closeTab`: the tab to close, the one in view when absent                                                                      |

**Returns** `{ ok: boolean }`. 409 when the browser is not running. The agent drives the same tabs, so what it does mid-turn and what you do interleave.

### `POST /sessions/{id}/compact`

Compact the session’s context now. Needs `manage`, held to the session’s project.

**Returns** `{ session: Session }`

### `POST /sessions/{id}/clear`

Hide the transcript so far; the stored log keeps it. Needs `manage`, held to the session’s project.

**Returns** `{ session: Session, hidden: integer }`

### `POST /sessions/{id}/review-loop`

Arm or disarm automatic review rounds. Needs `manage`, held to the session’s project.

**Body**

| Field             | Type      |              |
| ----------------- | --------- | ------------ |
| `on` **required** | `boolean` | Armed or not |

**Returns** `{ session: Session }`

### `POST /sessions/{id}/qa-loop`

Arm or disarm automatic QA. Needs `manage`, held to the session’s project.

**Body**

| Field             | Type      |              |
| ----------------- | --------- | ------------ |
| `on` **required** | `boolean` | Armed or not |

**Returns** `{ session: Session }`

### `POST /sessions/{id}/link-pr`

Attach a pull request to the session after checking it is this session’s branch. Needs `manage`, held to the session’s project.

**Body**

| Field             | Type     |                              |
| ----------------- | -------- | ---------------------------- |
| `pr` **required** | `string` | A pull request number or URL |

**Returns** `{ session: Session }`

### `POST /sessions/{id}/findings/triage`

Complete findings triage; `fix` verdicts may start paid agents and post to GitHub. Needs `manage`, held to the session’s project.

**Body**

| Field      | Type       |                                                                                                 |
| ---------- | ---------- | ----------------------------------------------------------------------------------------------- |
| `verdicts` | `object[]` | One `{ key, decision, reason }` per finding; decision is `fix`, `optional`, `dismissed` or null |
| `note`     | `string`   | A note to post with the verdicts                                                                |

**Returns** `object`

### `POST /sessions/{id}/findings/save`

Save the verdicts so far and post them on the pull request; rules nothing. Needs `manage`, held to the session’s project.

**Body**

| Field                   | Type       |                                                                                                 |
| ----------------------- | ---------- | ----------------------------------------------------------------------------------------------- |
| `verdicts` **required** | `object[]` | One `{ key, decision, reason }` per finding; decision is `fix`, `optional`, `dismissed` or null |
| `note`                  | `string`   | A note to post with the verdicts                                                                |

**Returns** `{ drafts: object, url: string?, warning: string? }`

### `POST /sessions/{id}/findings/reply`

Reply on a finding’s thread on GitHub. Needs `manage`, held to the session’s project.

**Body**

| Field               | Type     |                     |
| ------------------- | -------- | ------------------- |
| `key` **required**  | `string` | The finding’s `key` |
| `text` **required** | `string` | The text            |

**Returns** `{ replied: object, url: string? }`

### `POST /sessions/{id}/findings/delete`

Delete a finding and its comment on GitHub. Needs `manage`, held to the session’s project.

**Body**

| Field              | Type     |                     |
| ------------------ | -------- | ------------------- |
| `key` **required** | `string` | The finding’s `key` |

**Returns** `{ deleted: object, remaining: integer }`

### `GET /sessions/{id}/preview`

Read where a session’s preview is being served. Needs `read`, held to the session’s project.

**Returns** `{ title: string, links: object[] }`

### `POST /sessions/{id}/preview/feedback`

Send feedback on a preview page as a message with an annotated screenshot. Needs `manage`, held to the session’s project.

**Body**

| Field                   | Type      |                                                   |
| ----------------------- | --------- | ------------------------------------------------- |
| `url` **required**      | `string`  | The preview page the feedback is about            |
| `text` **required**     | `string`  | The feedback, up to 12,000 characters             |
| `uploadId` **required** | `string`  | The annotated screenshot, from `POST /uploads`    |
| `width` **required**    | `integer` | Screenshot width in image pixels                  |
| `height` **required**   | `integer` | Screenshot height in image pixels                 |
| `x` **required**        | `number`  | The marked point, from the screenshot’s left edge |
| `y` **required**        | `number`  | The marked point, from the screenshot’s top edge  |

**Returns** `{ session: Session }`

### `GET /preview/access`

The Cloudflare Access service token a client sends to ▶ Run preview hostnames. Needs `manage`.

**Returns** `{ clientId: string, clientSecret: string, hostSuffix: string }`. Send `CF-Access-Client-Id` and `CF-Access-Client-Secret` only to hosts ending in `.` + `hostSuffix`. 404 when the server has no tunnel or no service token configured.

### `GET /sessions/{id}/webhook`

Read a session’s webhook: its settings, URLs and signing keys. Needs `admin`.

**Returns** `Webhook`

### `PUT /sessions/{id}/webhook`

Change a session’s webhook settings. Needs `admin`.

**Body**

| Field           | Type      |                                                                                             |
| --------------- | --------- | ------------------------------------------------------------------------------------------- |
| `armed`         | `boolean` | Whether deliveries are accepted                                                             |
| `perHour`       | `integer` | Deliveries taken in any one hour                                                            |
| `maxTurns`      | `integer` | Turns deliveries may start in a row with no word from the operator                          |
| `sshUnattended` | `boolean` | Whether an SSH server in `allow` mode runs commands unapproved in a turn a delivery started |
| `instructions`  | `boolean` | Whether the second, instructions webhook is on                                              |

**Returns** `Webhook`

### `POST /sessions/{id}/webhook/rotate`

Replace a session’s webhook keys; the old ones stop working. Needs `admin`.

**Returns** `Webhook`

### `GET /sessions/{id}/recovery`

Inspect what an interrupted session left in its workspace. Needs `admin`.

**Returns** `object`. `{ id, status, expectedBranch, branch, head, changes, available, canResume, reason, phase, fingerprint }`.

### `POST /sessions/{id}/recovery`

Resume an interrupted session from the recovery report just read. Needs `admin`.

**Body**

| Field                      | Type     |                                                            |
| -------------------------- | -------- | ---------------------------------------------------------- |
| `fingerprint` **required** | `string` | The `fingerprint` of the recovery report this resumes from |

**Returns** `{ session: Session }`

### `GET /tasks/{id}`

Read a task’s history: every session filed under it and what they cost together. Needs `admin`.

**Returns** `{ root: object, sessions: object[], usage: object, prUrl: string? }`

## Composer

### `GET /prompts`

List the saved prompts a project offers; without `repo`, the whole library. Needs `read`, held to `repo` (an admin token may leave it out).

**Query**

| Field  | Type     |                            |
| ------ | -------- | -------------------------- |
| `repo` | `string` | A project, as `owner/name` |

**Returns** `{ prompts: SavedPrompt[] }`

### `POST /prompts`

Add a prompt. Needs `admin`.

**Body**: a [SavedPrompt](#savedprompt), whole or in part.

**Returns** 201 `{ prompt: SavedPrompt }`

### `PUT /prompts/{id}`

Change a prompt. Needs `admin`.

**Body**: a [SavedPrompt](#savedprompt), whole or in part.

**Returns** `{ prompt: SavedPrompt }`

### `DELETE /prompts/{id}`

Remove a prompt. Needs `admin`.

**Returns** `{ ok: boolean }`

### `POST /uploads`

Upload one attachment; send the returned id in a message’s `attachments`. Needs `manage`.

**Query**

| Field               | Type     |                 |
| ------------------- | -------- | --------------- |
| `name` **required** | `string` | The file’s name |

**Body**: the raw bytes, up to 25 MiB, with any content type other than JSON.

**Returns** 201 `{ file: object }`. The file is `{ id, name, size }`.

### `GET /transcribe`

Whether this server can transcribe voice notes. Needs `read`.

**Returns** `{ available: boolean }`

### `POST /transcribe`

Turn a recorded voice note into text; the recording is not kept. Needs `manage`.

**Body**: the raw bytes, up to 25 MiB, with any content type other than JSON.

**Returns** `{ text: string }`. Send the recording with the `Content-Type` it was recorded in, such as `audio/mp4` or `audio/webm`.

### `GET /providers`

List the providers a session can start on, with every account’s login state and quota. Needs `admin`.

**Query**

| Field   | Type   |                                                    |
| ------- | ------ | -------------------------------------------------- |
| `fresh` | `0\|1` | `1` skips the server’s short cache and reads again |

**Returns** `{ providers: object[] }`. An entry is `{ id, label, binary, available, models, defaultModel, efforts, modelEfforts, defaultEffort, auth, usage, accounts }`. Several logins to one service come back as one entry.

## Memory

### `GET /memories`

List a project’s memories; without `repo`, every project’s. Needs `read`, held to `repo` (an admin token may leave it out).

**Query**

| Field  | Type     |                            |
| ------ | -------- | -------------------------- |
| `repo` | `string` | A project, as `owner/name` |

**Returns** `{ memories: Memory[] }`

### `GET /memories/health`

Read the memory health report: what needs verifying and what looks duplicated. Needs `admin`.

**Query**

| Field  | Type     |                            |
| ------ | -------- | -------------------------- |
| `repo` | `string` | A project, as `owner/name` |

**Returns** `{ memories: object[], duplicates: object[] }`. Each memory adds `archived`, `verifiedAt`, `revision` and `needsVerification`. A duplicate is `{ ids, similarity }`.

### `POST /memories/merge`

Merge two memories of one project: save the merged text on one and archive the other. Needs `admin`.

**Body**

| Field                    | Type       |                                                              |
| ------------------------ | ---------- | ------------------------------------------------------------ |
| `targetId` **required**  | `integer`  | The memory that keeps the merged text                        |
| `sourceId` **required**  | `integer`  | The memory to archive                                        |
| `body` **required**      | `string`   | The merged text                                              |
| `revisions` **required** | `string[]` | The `revision` of the target and of the source, as last read |

**Returns** `{ memory: Memory }`

### `POST /memories/{id}/policy`

Mark a memory verified, archive it or restore it. Needs `admin`.

**Body**

| Field                   | Type                       |                                                          |
| ----------------------- | -------------------------- | -------------------------------------------------------- |
| `action` **required**   | `verify\|archive\|restore` | What to do                                               |
| `revision` **required** | `string`                   | The memory’s `revision`, as last read; 409 if it changed |

**Returns** `{ policy: object }`

### `POST /memories`

Add a memory. Needs `admin`.

**Body**: a [Memory](#memory), whole or in part.

**Returns** 201 `{ memory: Memory }`

### `PUT /memories/{id}`

Change a memory. Needs `admin`.

**Body**: a [Memory](#memory), whole or in part.

**Returns** `{ memory: Memory }`

### `DELETE /memories/{id}`

Remove a memory. Needs `admin`.

**Returns** `{ ok: boolean }`

## Operations

### `GET /usage/all`

Read usage and costs across every project. Needs `admin`.

**Query**

| Field      | Type                                       |                                                                             |
| ---------- | ------------------------------------------ | --------------------------------------------------------------------------- |
| `period`   | `today\|7d\|30d\|month\|prev\|all\|custom` | The window; `month` when absent                                             |
| `from`     | `string`                                   | First day, `YYYY-MM-DD`, with `period=custom`                               |
| `to`       | `string`                                   | Last day, `YYYY-MM-DD`, with `period=custom`                                |
| `project`  | `string`                                   | Only this project; a key from the response’s `options.projects`. Repeatable |
| `model`    | `string`                                   | Only this model. Repeatable                                                 |
| `provider` | `string`                                   | Only this provider. Repeatable                                              |
| `activity` | `string`                                   | Only this kind of work. Repeatable                                          |
| `account`  | `string`                                   | Only this account; a key from `options.accounts`. Repeatable                |
| `session`  | `string`                                   | Only this session; a key from `options.sessions`. Repeatable                |

**Returns** `object`. Totals, `buckets` over time, breakdowns by `projects`, `providers`, `models` and `activities`, `topSessions`, a `comparison` with the window before, and the `options` each filter accepts.

### `GET /attention`

List what is waiting on the operator: questions, findings to rule on, failures, SSH and Slack approvals. Needs `admin`.

**Returns** `{ items: object[] }`. An item is `{ id, sessionId, taskId, revision, repo, title, kind, summary, href, at }`.

### `GET /maintenance`

Read whether the server is draining work and what is still running. Needs `admin`.

**Returns** `{ draining: boolean, ready: boolean, active: object[], sshRunning: integer }`

### `POST /maintenance`

Start or stop draining work. Needs `admin`.

**Body**

| Field                   | Type      |                                    |
| ----------------------- | --------- | ---------------------------------- |
| `draining` **required** | `boolean` | Whether to stop accepting new work |

**Returns** `{ draining: boolean, ready: boolean, active: object[], sshRunning: integer }`

### `GET /ssh/requests`

List the SSH commands agents are waiting for approval to run. Needs `admin`.

**Returns** `{ requests: object[] }`

### `POST /ssh/requests/{id}/decision`

Approve or deny an SSH command. Needs `admin`.

**Body**

| Field                   | Type            |            |
| ----------------------- | --------------- | ---------- |
| `decision` **required** | `approve\|deny` | The ruling |

**Returns** `{ request: object }`

### `GET /slack/requests`

List the Slack messages agents are waiting for approval to send. Needs `admin`.

**Returns** `{ requests: object[] }`. A request is `{ id, workspaceLabel, sendsAs, repo, jobId, sessionTitle, to: { kind, id, label }, text, threadTs, status, createdAt, expiresAt, unattended }`. One waits a day at most.

### `POST /slack/requests/{id}/decision`

Approve or deny a Slack message; approving sends it. Needs `admin`.

**Body**

| Field                   | Type            |            |
| ----------------------- | --------------- | ---------- |
| `decision` **required** | `approve\|deny` | The ruling |

**Returns** `{ request: object }`. The request comes back `sent` or `failed`, with `error` saying why.

### `GET /deployments`

Read a project’s deployments: its settings, the last attempt and recent history. Needs `admin`.

**Query**

| Field               | Type     |                            |
| ------------------- | -------- | -------------------------- |
| `repo` **required** | `string` | A project, as `owner/name` |

**Returns** `{ config: object?, attempt: object?, history: object[], active: object[], health: object, checkedAt: string }`

### `GET /deployments/config`

Read a project’s deployment settings. Needs `admin`.

**Query**

| Field               | Type     |                            |
| ------------------- | -------- | -------------------------- |
| `repo` **required** | `string` | A project, as `owner/name` |

**Returns** `{ config: object?, attempt: object? }`

### `POST /deployments/config`

Set which workflow deploys a project. Needs `admin`.

**Query**

| Field               | Type     |                            |
| ------------------- | -------- | -------------------------- |
| `repo` **required** | `string` | A project, as `owner/name` |

**Body**

| Field                        | Type      |                                                                   |
| ---------------------------- | --------- | ----------------------------------------------------------------- |
| `environment` **required**   | `string`  | The GitHub environment deployed to                                |
| `workflow` **required**      | `string`  | The workflow file name                                            |
| `workflowRef` **required**   | `string`  | The ref the workflow is run from                                  |
| `sourceRef` **required**     | `string`  | The ref that gets deployed                                        |
| `revisionInput` **required** | `string`  | The workflow input that takes the commit                          |
| `requireChecks`              | `boolean` | Refuse to deploy a commit whose CI is not green; true when absent |
| `healthUrl`                  | `string`  | A URL to check after deploying                                    |

**Returns** `object`

### `POST /deployments/plan`

Plan a deployment: resolve the commit and check it can go. Needs `admin`.

**Query**

| Field               | Type     |                            |
| ------------------- | -------- | -------------------------- |
| `repo` **required** | `string` | A project, as `owner/name` |

**Returns** `object`

### `POST /deployments/dispatch`

Run a planned deployment. Needs `admin`.

**Query**

| Field               | Type     |                            |
| ------------------- | -------- | -------------------------- |
| `repo` **required** | `string` | A project, as `owner/name` |

**Body**

| Field                 | Type     |                                                    |
| --------------------- | -------- | -------------------------------------------------- |
| `planId` **required** | `string` | The `id` of the plan from `POST /deployments/plan` |

**Returns** `object`

### `POST /deployments/acknowledge`

Acknowledge the last deployment so another can be requested. Needs `admin`.

**Query**

| Field               | Type     |                            |
| ------------------- | -------- | -------------------------- |
| `repo` **required** | `string` | A project, as `owner/name` |

**Returns** `object`

### `GET /videos/{file}`

Download a video a test run recorded. Needs `admin`.

**Returns** the file.

## Laravel Forge

### `GET /forge/accounts/{account}/servers`

List a Forge account’s servers. Needs `admin`.

**Query**

| Field    | Type     |                                                                 |
| -------- | -------- | --------------------------------------------------------------- |
| `cursor` | `string` | The `nextCursor` of the page before; the first page when absent |

**Returns** `{ servers: ForgeServer[], nextCursor: string? }`. 100 to a page. 404 when the account is not there, 502 when Forge refuses its token, 429 when Forge is rate limiting it (60 calls a minute).

### `GET /forge/accounts/{account}/servers/{server}/sites`

List a Forge server’s sites. Needs `admin`.

**Query**

| Field    | Type     |                                                                 |
| -------- | -------- | --------------------------------------------------------------- |
| `cursor` | `string` | The `nextCursor` of the page before; the first page when absent |

**Returns** `{ sites: ForgeSite[], nextCursor: string? }`. 100 to a page. 404 when the account is not there, 502 when Forge refuses its token, 429 when Forge is rate limiting it (60 calls a minute).

### `GET /forge/accounts/{account}/servers/{server}/sites/{site}`

Read one Forge site. Needs `admin`.

**Returns** `{ site: ForgeSite }`

### `GET /forge/accounts/{account}/servers/{server}/sites/{site}/deployment-script`

Read a Forge site’s deployment script. Needs `admin`.

**Returns** `{ content: string, autoSource: boolean }`

### `PUT /forge/accounts/{account}/servers/{server}/sites/{site}/deployment-script`

Replace a Forge site’s deployment script. Needs `admin`.

**Body**

| Field                  | Type      |                                                                            |
| ---------------------- | --------- | -------------------------------------------------------------------------- |
| `content` **required** | `string`  | The whole script                                                           |
| `autoSource`           | `boolean` | Whether the script runs with the site’s .env loaded; unchanged when absent |

**Returns** `{ content: string, autoSource: boolean }`

### `GET /forge/accounts/{account}/servers/{server}/sites/{site}/env`

Read a Forge site’s .env. Needs `admin`.

**Returns** `{ content: string }`

### `PUT /forge/accounts/{account}/servers/{server}/sites/{site}/env`

Replace a Forge site’s .env. Needs `admin`.

**Body**

| Field                  | Type     |                |
| ---------------------- | -------- | -------------- |
| `content` **required** | `string` | The whole file |

**Returns** `{ ok: boolean }`. Forge accepts the file and writes it to the server shortly after, so `ok` means accepted. It does not clear the config cache or restart queue workers.

## Laravel Envoyer

### `GET /envoyer/accounts`

List the Envoyer accounts available to a project. Needs `read`, held to `repo`.

**Query**

| Field               | Type     |                            |
| ------------------- | -------- | -------------------------- |
| `repo` **required** | `string` | A project, as `owner/name` |

**Returns** `{ accounts: EnvoyerAccount[] }`

### `GET /envoyer/accounts/{id}/projects`

List the account’s Envoyer projects. Needs `manage`, held to `repo`.

**Query**

| Field               | Type     |                            |
| ------------------- | -------- | -------------------------- |
| `repo` **required** | `string` | A project, as `owner/name` |

**Returns** `{ projects: object[] }`. Runs as the account, which must be available to `repo`; 404 when it is not. 502 when Envoyer refuses the account’s token, 429 when it is rate limiting it. Envoyer’s objects come back as Envoyer shapes them.

### `GET /envoyer/accounts/{id}/projects/{project}`

Read one Envoyer project. Needs `manage`, held to `repo`.

**Query**

| Field               | Type     |                            |
| ------------------- | -------- | -------------------------- |
| `repo` **required** | `string` | A project, as `owner/name` |

**Returns** `{ project: object }`. Runs as the account, which must be available to `repo`; 404 when it is not. 502 when Envoyer refuses the account’s token, 429 when it is rate limiting it. Envoyer’s objects come back as Envoyer shapes them.

### `GET /envoyer/accounts/{id}/projects/{project}/servers`

List an Envoyer project’s servers. Needs `manage`, held to `repo`.

**Query**

| Field               | Type     |                            |
| ------------------- | -------- | -------------------------- |
| `repo` **required** | `string` | A project, as `owner/name` |

**Returns** `{ servers: object[] }`. Runs as the account, which must be available to `repo`; 404 when it is not. 502 when Envoyer refuses the account’s token, 429 when it is rate limiting it. Envoyer’s objects come back as Envoyer shapes them.

### `GET /envoyer/accounts/{id}/projects/{project}/deployments`

List an Envoyer project’s deployments. Needs `manage`, held to `repo`.

**Query**

| Field               | Type     |                            |
| ------------------- | -------- | -------------------------- |
| `repo` **required** | `string` | A project, as `owner/name` |

**Returns** `{ deployments: object[] }`. Runs as the account, which must be available to `repo`; 404 when it is not. 502 when Envoyer refuses the account’s token, 429 when it is rate limiting it. Envoyer’s objects come back as Envoyer shapes them.

### `GET /envoyer/accounts/{id}/projects/{project}/deployments/{deployment}`

Read one Envoyer deployment. Needs `manage`, held to `repo`.

**Query**

| Field               | Type     |                            |
| ------------------- | -------- | -------------------------- |
| `repo` **required** | `string` | A project, as `owner/name` |

**Returns** `{ deployment: object }`. Runs as the account, which must be available to `repo`; 404 when it is not. 502 when Envoyer refuses the account’s token, 429 when it is rate limiting it. Envoyer’s objects come back as Envoyer shapes them.

### `POST /envoyer/accounts/{id}/projects/{project}/deployments`

Deploy an Envoyer project. Needs `manage`, held to `repo`.

**Body**

| Field               | Type     |                                                                                    |
| ------------------- | -------- | ---------------------------------------------------------------------------------- |
| `repo` **required** | `string` | A project, as `owner/name`                                                         |
| `branch`            | `string` | The branch to deploy; the project’s own branch when neither this nor `tag` is sent |
| `tag`               | `string` | The tag to deploy, instead of a branch                                             |

**Returns** `{ ok: boolean }`. Runs as the account, which must be available to `repo`; 404 when it is not. 502 when Envoyer refuses the account’s token, 429 when it is rate limiting it. Envoyer’s objects come back as Envoyer shapes them. `ok` means Envoyer queued it; the deployments list shows it run. The account’s token needs the `deployments:create` scope.

## Settings

### `PUT /settings/projects/order`

Put the projects in a new order. Needs `admin`.

**Body**

| Field              | Type        |                            |
| ------------------ | ----------- | -------------------------- |
| `ids` **required** | `integer[]` | Every id, in the new order |

**Returns** `{ projects: Project[] }`

### `GET /settings/projects`

List every project, with the values a new one starts from. Needs `admin`.

**Returns** `{ projects: Project[], defaults: Project }`

### `POST /settings/projects`

Add a project. Needs `admin`.

**Body**: a [Project](#project), whole or in part.

**Returns** 201 `{ project: Project }`

### `PUT /settings/projects/{id}`

Change a project. Needs `admin`.

**Body**: a [Project](#project), whole or in part.

**Returns** `{ project: Project }`

### `DELETE /settings/projects/{id}`

Remove a project. Needs `admin`.

**Returns** `{ ok: boolean }`

### `GET /settings/projects/{id}/update`

Read how the project’s local checkout last updated itself. Needs `admin`.

**Returns** `{ status: object? }`. `status` is null before the first update. Otherwise `{ state, trigger, startedAt, finishedAt, branch, from, to, reason, steps, output }`, where `state` is waiting, running, updated, skipped, failed or interrupted.

### `POST /settings/projects/{id}/update`

Pull the project’s local checkout and run its update commands now. Needs `admin`.

**Returns** 202 `{ status: object? }`. Answers once the update has started; read the status to follow it.

### `GET /settings/templates`

Read the prompt templates: the overrides in force and the catalog of what can be overridden. Needs `admin`.

**Returns** `{ templates: object[], defaults: object, catalog: object[] }`. `templates` is one row, `{ id: 1, values }`. A catalog entry is `{ id, label, hint, vars, builtIn }`.

### `PUT /settings/templates`

Change the prompt templates. Needs `admin`.

**Body**

| Field                 | Type     |                                                                           |
| --------------------- | -------- | ------------------------------------------------------------------------- |
| `values` **required** | `object` | Template text keyed by template id; an empty string restores the built-in |

**Returns** `{ templates: object }`

### `POST /settings/providers/test`

Probe a provider endpoint and key as a form holds them, before saving. Needs `admin`.

**Body**

| Field          | Type                            |                                                         |
| -------------- | ------------------------------- | ------------------------------------------------------- |
| `binary`       | `claude\|codex\|grok\|opencode` | Which CLI runs it                                       |
| `baseUrl`      | `string`                        | A custom endpoint, or empty                             |
| `apiKey`       | `string`                        | The key for that endpoint, or empty. Returned as stored |
| `defaultModel` | `string`                        | The model to probe with when the endpoint lists none    |
| `models`       | `string[]`                      | The models the form lists                               |
| `id`           | `integer`                       | The saved row being edited, if any                      |

**Returns** `{ models: string[], probedModel: string }`. `probedModel` is present only when the endpoint has no model list and was probed with a chat call instead.

### `GET /settings/providers`

List every provider, with the values a new one starts from. Needs `admin`.

**Returns** `{ providers: Provider[], defaults: Provider }`

### `POST /settings/providers`

Add a provider. Needs `admin`.

**Body**: a [Provider](#provider), whole or in part.

**Returns** 201 `{ provider: Provider }`

### `PUT /settings/providers/{id}`

Change a provider. Needs `admin`.

**Body**: a [Provider](#provider), whole or in part.

**Returns** `{ provider: Provider }`

### `DELETE /settings/providers/{id}`

Remove a provider. Needs `admin`.

**Returns** `{ ok: boolean }`

### `GET /settings/providers/{id}/status`

Read one provider’s connection: CLI found, login state, account and quota. Needs `admin`.

**Query**

| Field   | Type   |                                                    |
| ------- | ------ | -------------------------------------------------- |
| `fresh` | `0\|1` | `1` skips the server’s short cache and reads again |

**Returns** `{ status: object }`. `status` is `{ available, binSource, loginDir, auth, usage }`.

### `POST /settings/providers/{id}/login`

Start a codex or grok device login. Needs `admin`.

**Returns** `{ url: string, deviceCode: string? }`. Open `url` in a browser and approve; codex also shows `deviceCode` to type in. Answers `{ ok: true }` when the entry is already logged in.

### `POST /settings/providers/{id}/login/start`

Start a claude login. Needs `admin`.

**Returns** `{ url: string }`. Open `url`, approve, and send the code it shows to `…/login/finish`.

### `POST /settings/providers/{id}/login/finish`

Finish a claude login with the code the authorization page showed. Needs `admin`.

**Body**

| Field               | Type     |                                        |
| ------------------- | -------- | -------------------------------------- |
| `code` **required** | `string` | The code the authorization page showed |

**Returns** `{ provider: Provider }`

### `POST /settings/db-servers/test`

Probe a database server as a form holds it, before saving. Needs `admin`.

**Body**

| Field      | Type      |                                    |
| ---------- | --------- | ---------------------------------- |
| `host`     | `string`  | Its host                           |
| `port`     | `integer` | Its port                           |
| `username` | `string`  | The user sessions connect as       |
| `password` | `string`  | That user’s password               |
| `id`       | `integer` | The saved row being edited, if any |

**Returns** `{ version: string, databases: integer, claimedBy: object?, capacity: integer, poolSize: integer }`

### `GET /settings/db-servers`

List every server, with the values a new one starts from. Needs `admin`.

**Returns** `{ servers: DbServer[], defaults: DbServer }`

### `POST /settings/db-servers`

Add a server. Needs `admin`.

**Body**: a [DbServer](#dbserver), whole or in part.

**Returns** 201 `{ server: DbServer }`

### `PUT /settings/db-servers/{id}`

Change a server. Needs `admin`.

**Body**: a [DbServer](#dbserver), whole or in part.

**Returns** `{ server: DbServer }`

### `DELETE /settings/db-servers/{id}`

Remove a server. Needs `admin`.

**Returns** `{ ok: boolean }`

### `GET /settings/workspaces`

List the workspace clone slots and what holds each. Needs `admin`.

**Returns** `{ workspaces: Workspace[] }`

### `POST /settings/workspaces/{slot}/reset-setup`

Forget an idle slot’s install fingerprints, so its next session installs everything. Needs `admin`.

**Returns** `{ slot: string }`

### `POST /settings/workspaces/{slot}/clean`

Remove an idle slot’s dependency trees. Needs `admin`.

**Returns** `{ slot: string, removed: string[] }`

### `GET /settings/forge/accounts`

List every account, with the values a new one starts from. Needs `admin`.

**Query**

| Field  | Type     |                                                              |
| ------ | -------- | ------------------------------------------------------------ |
| `repo` | `string` | Only the accounts available to this project, as `owner/name` |

**Returns** `{ accounts: ForgeAccount[], defaults: ForgeAccount }`

### `POST /settings/forge/accounts`

Add a account. Needs `admin`.

**Body**: a [ForgeAccount](#forgeaccount), whole or in part.

**Returns** 201 `{ account: ForgeAccount }`

### `PUT /settings/forge/accounts/{id}`

Change a account. Needs `admin`.

**Body**: a [ForgeAccount](#forgeaccount), whole or in part.

**Returns** `{ account: ForgeAccount }`

### `DELETE /settings/forge/accounts/{id}`

Remove a account. Needs `admin`.

**Returns** `{ ok: boolean }`

### `GET /settings/ssh/servers`

List every server, with the values a new one starts from. Needs `admin`.

**Returns** `{ servers: SshServer[], defaults: SshServer }`

### `POST /settings/ssh/servers`

Add a server. Needs `admin`.

**Body**: a [SshServer](#sshserver), whole or in part.

**Returns** 201 `{ server: SshServer }`

### `PUT /settings/ssh/servers/{id}`

Change a server. Needs `admin`.

**Body**: a [SshServer](#sshserver), whole or in part.

**Returns** `{ server: SshServer }`

### `DELETE /settings/ssh/servers/{id}`

Remove a server. Needs `admin`.

**Returns** `{ ok: boolean }`

### `GET /settings/ssh/servers/{id}/db-credentials`

Read the server’s database login, decrypted, to connect through an SSH tunnel to `host`:`port` on it. 404 when none is stored. Needs `admin`.

**Returns** `{ credentials: DbCredentials }`

### `GET /settings/slack/workspaces`

List every workspace, with the values a new one starts from. Needs `admin`.

**Query**

| Field  | Type     |                                                                |
| ------ | -------- | -------------------------------------------------------------- |
| `repo` | `string` | Only the workspace this project sends through, as `owner/name` |

**Returns** `{ workspaces: SlackWorkspace[], defaults: SlackWorkspace }`

### `POST /settings/slack/workspaces`

Add a workspace. Needs `admin`.

**Body**: a [SlackWorkspace](#slackworkspace), whole or in part.

**Returns** 201 `{ workspace: SlackWorkspace }`

### `PUT /settings/slack/workspaces/{id}`

Change a workspace. Needs `admin`.

**Body**: a [SlackWorkspace](#slackworkspace), whole or in part.

**Returns** `{ workspace: SlackWorkspace }`

### `DELETE /settings/slack/workspaces/{id}`

Remove a workspace. Needs `admin`.

**Returns** `{ ok: boolean }`

### `GET /settings/envoyer/accounts`

List every account, with the values a new one starts from. Needs `admin`.

**Returns** `{ accounts: EnvoyerAccount[], defaults: EnvoyerAccount }`

### `POST /settings/envoyer/accounts`

Add a account. Needs `admin`.

**Body**: a [EnvoyerAccount](#envoyeraccount), whole or in part.

**Returns** 201 `{ account: EnvoyerAccount }`

### `PUT /settings/envoyer/accounts/{id}`

Change a account. Needs `admin`.

**Body**: a [EnvoyerAccount](#envoyeraccount), whole or in part.

**Returns** `{ account: EnvoyerAccount }`

### `DELETE /settings/envoyer/accounts/{id}`

Remove a account. Needs `admin`.

**Returns** `{ ok: boolean }`

## Objects

### Client

A token’s own record. The token itself is shown once, when it is created.

| Field        | Type                  |                                                                                                             |
| ------------ | --------------------- | ----------------------------------------------------------------------------------------------------------- |
| `id`         | `string`              | Its id                                                                                                      |
| `label`      | `string`              | The name it was given                                                                                       |
| `permission` | `read\|manage\|admin` | What it may do                                                                                              |
| `repos`      | `string[]`            | The projects it is held to; empty for an admin token, which is held to none                                 |
| `createdAt`  | `integer`             | When it was issued, epoch milliseconds                                                                      |
| `expiresAt`  | `integer`             | When it stops working, epoch milliseconds                                                                   |
| `lastUsedAt` | `integer?`            | Last recorded authenticated request, epoch milliseconds; saved at most once per minute, null until recorded |

### ProjectSummary

A project as a session picker needs it.

| Field              | Type       |                                                                      |
| ------------------ | ---------- | -------------------------------------------------------------------- |
| `repo`             | `string`   | `owner/name`                                                         |
| `label`            | `string`   | Its display name                                                     |
| `hasLocal`         | `boolean`  | Whether it has a local checkout a session can work in                |
| `reviewProviderId` | `integer?` | The provider its reviews and errands run on                          |
| `reviewModel`      | `string`   | That runtime’s model, or empty                                       |
| `reviewEffort`     | `string`   | That runtime’s effort, or empty                                      |
| `runProfiles`      | `string[]` | The names ▶ Run offers, the default first                            |
| `hasBoard`         | `boolean`  | Whether it names a Projects v2 board, read with `GET /project-board` |

### Session

A conversation with an agent. The record is pushed whole on every change, so replace your copy rather than merging.

| Field            | Type                                                            |                                                                                                                                |
| ---------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `id`             | `string`                                                        | Its id                                                                                                                         |
| `title`          | `string`                                                        | Its title                                                                                                                      |
| `repo`           | `string`                                                        | The project it belongs to                                                                                                      |
| `status`         | `queued\|preparing\|running\|idle\|closed\|failed\|interrupted` | `idle` is waiting for a message; `closed` has released its workspace and can be reopened                                       |
| `error`          | `string?`                                                       | Why it failed                                                                                                                  |
| `activity`       | `string`                                                        | What its spend is filed under: `chat`, `code-review`, `qa`, `orchestrator`, an errand id, …                                    |
| `provider`       | `string`                                                        | The provider’s label                                                                                                           |
| `providerId`     | `integer`                                                       | The provider’s id                                                                                                              |
| `model`          | `string`                                                        | The model it runs on                                                                                                           |
| `effort`         | `string`                                                        | The effort it runs at                                                                                                          |
| `branch`         | `string?`                                                       | The branch its workspace is on                                                                                                 |
| `baseBranch`     | `string?`                                                       | The branch that one was cut from                                                                                               |
| `startBranch`    | `string?`                                                       | The existing branch it was started on, if any                                                                                  |
| `local`          | `boolean`                                                       | Whether it works in the project’s local checkout                                                                               |
| `createdAt`      | `string`                                                        | ISO time it was created                                                                                                        |
| `startedAt`      | `string?`                                                       | ISO time its current turn started                                                                                              |
| `endedAt`        | `string?`                                                       | ISO time it last settled                                                                                                       |
| `turns`          | `integer`                                                       | Turns run so far                                                                                                               |
| `costUsd`        | `number?`                                                       | What this conversation spent, when its provider prices turns                                                                   |
| `inputTokens`    | `integer?`                                                      | Input tokens consumed                                                                                                          |
| `outputTokens`   | `integer?`                                                      | Output tokens consumed                                                                                                         |
| `contextTokens`  | `integer?`                                                      | The live context size                                                                                                          |
| `contextWindow`  | `integer?`                                                      | The model’s context window                                                                                                     |
| `usage`          | `object`                                                        | Spend including every session it ordered: `sessions`, `costUsd`, `estimatedCostUsd`, tokens, `durationMs`                      |
| `awaitingAnswer` | `boolean`                                                       | Whether the agent asked a question and is waiting                                                                              |
| `queued`         | `object[]`                                                      | Messages waiting for the turn to end, each `{ text }`; absent when none                                                        |
| `liveInput`      | `boolean`                                                       | Whether a message sent now goes into the running turn rather than the queue                                                    |
| `lastText`       | `string?`                                                       | The opening of the agent’s latest message                                                                                      |
| `lastTool`       | `string?`                                                       | The tool the running turn is on                                                                                                |
| `subagents`      | `object[]`                                                      | The sub-agents working right now, each `{ id, name, summary, startedAt }`                                                      |
| `prStatus`       | `object?`                                                       | Its pull request, once it has one: number, URL, state, checks and reviews                                                      |
| `serveLinks`     | `object[]?`                                                     | Where ▶ Run is serving its checkout, each `{ url }`; null when not running                                                     |
| `browser`        | `object?`                                                       | The shared browser, `{ running }`, when it is switched on; null when off. Switched on and not running, the next turn starts it |
| `reviewLoop`     | `object?`                                                       | The review loop’s state when armed                                                                                             |
| `qaLoop`         | `object?`                                                       | The QA loop’s state when armed                                                                                                 |
| `reviewTriage`   | `object?`                                                       | Review findings held for the user’s verdicts                                                                                   |
| `orchestrator`   | `boolean`                                                       | Whether it is a supervisor of worker sessions                                                                                  |
| `parentId`       | `string?`                                                       | The orchestrator it works for                                                                                                  |
| `canCompact`     | `boolean`                                                       | Whether `POST /sessions/{id}/compact` would run now                                                                            |
| `compacting`     | `boolean`                                                       | Whether a compaction is running                                                                                                |
| `autoCompactAt`  | `integer?`                                                      | The context size at which it compacts itself                                                                                   |
| `hiddenLines`    | `integer`                                                       | How many transcript lines a Clear or compaction hid; absent when none                                                          |

### Browser

A session’s shared browser: the Chromium its agent drives and a client watches and drives too, at the same time and on the same tabs.

| Field     | Type           |                                                                                         |
| --------- | -------------- | --------------------------------------------------------------------------------------- |
| `on`      | `boolean`      | Whether it is switched on for the session; the next turn starts one that is on and down |
| `running` | `boolean`      | Whether it is up right now                                                              |
| `tabs`    | `BrowserTab[]` | Its open tabs, oldest first                                                             |
| `active`  | `string?`      | The `id` of the tab in view: the one frames show and input goes to                      |

### BrowserTab

A tab of the shared browser.

| Field   | Type     |                |
| ------- | -------- | -------------- |
| `id`    | `string` | Its id         |
| `url`   | `string` | What it shows  |
| `title` | `string` | Its page title |

### BrowserFrame

One picture of the tab in view. `width` × `height` is the page’s viewport in CSS pixels, the space input coordinates are in; a client showing the image at another size scales its pointer back to it.

| Field    | Type      |                       |
| -------- | --------- | --------------------- |
| `data`   | `string`  | A JPEG, base64        |
| `width`  | `integer` | The viewport’s width  |
| `height` | `integer` | The viewport’s height |
| `tab`    | `string`  | The tab it shows      |

### TranscriptEvent

One line of a session’s transcript. `kind` says how to read the rest; ignore kinds you do not know.

| Field          | Type       |                                                                                                                                                                                                                                                |
| -------------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `seq`          | `integer`  | Its position in the session’s log; the cursor for `since` and `Last-Event-ID`                                                                                                                                                                  |
| `t`            | `string`   | ISO time                                                                                                                                                                                                                                       |
| `kind`         | `string`   | `user` a message sent in; `text` the agent speaking; `ask` a question to answer; `tool` and `tool_error` a tool call; `result` the end of a turn; `status` a status change; `info`, `cmd`, `git`, `setup`, `stderr` and `claude` are log lines |
| `text`         | `string`   | The line’s text, on most kinds                                                                                                                                                                                                                 |
| `status`       | `string`   | On `status`: the session’s new status                                                                                                                                                                                                          |
| `attachments`  | `object[]` | On `user`: the files sent, each `{ name }`                                                                                                                                                                                                     |
| `via`          | `string`   | On `user`: `webhook` or `instruction` when it was not typed                                                                                                                                                                                    |
| `name`         | `string`   | On `tool`: the tool’s name                                                                                                                                                                                                                     |
| `links`        | `object[]` | On `info`: links ▶ Run published                                                                                                                                                                                                               |
| `hidden`       | `boolean`  | On `info`: this line stands in for lines a Clear or compaction hid                                                                                                                                                                             |
| `isError`      | `boolean`  | On `result`: the turn failed                                                                                                                                                                                                                   |
| `costUsd`      | `number?`  | On `result`: what the turn cost                                                                                                                                                                                                                |
| `durationMs`   | `integer`  | On `result`: how long the turn ran                                                                                                                                                                                                             |
| `inputTokens`  | `integer`  | On `result`                                                                                                                                                                                                                                    |
| `outputTokens` | `integer`  | On `result`                                                                                                                                                                                                                                    |

### PullRequest

A pull request as GitHub has it right now.

| Field            | Type                          |                                                                                |
| ---------------- | ----------------------------- | ------------------------------------------------------------------------------ |
| `number`         | `integer`                     | Its number                                                                     |
| `title`          | `string`                      | Its title                                                                      |
| `body`           | `string`                      | Its description, markdown                                                      |
| `url`            | `string`                      | Its page on GitHub                                                             |
| `author`         | `string`                      | Who opened it                                                                  |
| `state`          | `open\|draft\|closed\|merged` | Where it stands                                                                |
| `headRef`        | `string`                      | The branch it merges from                                                      |
| `baseRef`        | `string`                      | The branch it merges into                                                      |
| `headSha`        | `string`                      | The head commit; pass it back to pin later reads and to merge                  |
| `baseSha`        | `string`                      | The base commit                                                                |
| `additions`      | `integer`                     | Lines added                                                                    |
| `deletions`      | `integer`                     | Lines removed                                                                  |
| `changedFiles`   | `integer`                     | Files changed                                                                  |
| `updatedAt`      | `string`                      | ISO time of its last change                                                    |
| `mergeable`      | `boolean?`                    | null while GitHub is still working it out; false means conflicts               |
| `mergeableState` | `string`                      | GitHub’s `mergeable_state`                                                     |
| `mergeMethods`   | `string[]`                    | The merge methods the repository allows; absent on reads pinned with `headSha` |

### PullOverview

A pull request’s standing, in one read.

| Field          | Type                   |                                                                                |
| -------------- | ---------------------- | ------------------------------------------------------------------------------ |
| `number`       | `integer`              | Its number                                                                     |
| `title`        | `string`               | Its title                                                                      |
| `url`          | `string`               | Its page on GitHub                                                             |
| `state`        | `open\|closed\|merged` | Where it stands                                                                |
| `draft`        | `boolean`              | Whether it is a draft                                                          |
| `headSha`      | `string`               | The head commit                                                                |
| `headRef`      | `string`               | The branch it merges from                                                      |
| `baseRef`      | `string`               | The branch it merges into                                                      |
| `additions`    | `integer`              | Lines added                                                                    |
| `deletions`    | `integer`              | Lines removed                                                                  |
| `changedFiles` | `integer`              | Files changed                                                                  |
| `commits`      | `integer?`             | How many commits it has                                                        |
| `commitList`   | `object[]`             | Up to 100 of them, each `{ sha, message, url }`, message cut to its first line |
| `issues`       | `object[]`             | The issues it closes, each `{ number, title, state, url }`                     |
| `reviews`      | `object[]`             | The latest verdict per reviewer, each `{ user, state, url }`                   |
| `checks`       | `object`               | `{ total, passed, failed, pending, runs }`                                     |
| `syncedAt`     | `string`               | ISO time this was read                                                         |

### File

A changed file.

| Field              | Type      |                                                                            |
| ------------------ | --------- | -------------------------------------------------------------------------- |
| `filename`         | `string`  | Its path                                                                   |
| `previousFilename` | `string?` | Its old path, when renamed                                                 |
| `status`           | `string`  | `added`, `modified`, `removed`, `renamed`, …                               |
| `additions`        | `integer` | Lines added                                                                |
| `deletions`        | `integer` | Lines removed                                                              |
| `patch`            | `string?` | The unified diff; null for a binary file or a diff GitHub would not render |
| `url`              | `string`  | The file on GitHub at this revision                                        |

### Commit

A commit.

| Field     | Type      |                                                                         |
| --------- | --------- | ----------------------------------------------------------------------- |
| `sha`     | `string`  | Its SHA                                                                 |
| `message` | `string`  | Its full message                                                        |
| `author`  | `string`  | The author’s GitHub login, or the name on the commit when there is none |
| `date`    | `string?` | ISO time it was authored                                                |
| `url`     | `string`  | Its page on GitHub                                                      |

### CommitDetail

A commit with what it changed.

| Field       | Type       |                                                      |
| ----------- | ---------- | ---------------------------------------------------- |
| `sha`       | `string`   | Its SHA                                              |
| `message`   | `string`   | Its full message                                     |
| `author`    | `string`   | The author’s GitHub login, or the name on the commit |
| `date`      | `string?`  | ISO time it was authored                             |
| `url`       | `string`   | Its page on GitHub                                   |
| `parents`   | `string[]` | Its parents’ SHAs                                    |
| `additions` | `integer?` | Lines added                                          |
| `deletions` | `integer?` | Lines removed                                        |

### Check

A check run or commit status on a pull request’s head.

| Field         | Type      |                                                     |
| ------------- | --------- | --------------------------------------------------- |
| `name`        | `string`  | Its name                                            |
| `status`      | `string`  | `queued`, `in_progress` or `completed`              |
| `conclusion`  | `string?` | `success`, `failure`, `cancelled`, … once completed |
| `failed`      | `boolean` | Whether the conclusion counts as a failure          |
| `url`         | `string?` | Its details page                                    |
| `app`         | `string`  | What ran it                                         |
| `description` | `string`  | Its one-line summary                                |
| `startedAt`   | `string?` | ISO time                                            |
| `completedAt` | `string?` | ISO time                                            |

### Comment

A comment in a pull request’s conversation.

| Field       | Type      |                     |
| ----------- | --------- | ------------------- |
| `id`        | `integer` | Its id              |
| `author`    | `string`  | Who wrote it        |
| `body`      | `string`  | Its text, markdown  |
| `createdAt` | `string`  | ISO time            |
| `updatedAt` | `string`  | ISO time            |
| `url`       | `string`  | Its place on GitHub |

### Review

A submitted review.

| Field         | Type      |                                                                        |
| ------------- | --------- | ---------------------------------------------------------------------- |
| `id`          | `integer` | Its id                                                                 |
| `author`      | `string`  | The reviewer                                                           |
| `state`       | `string`  | `approved`, `changes_requested`, `commented`, `dismissed` or `pending` |
| `body`        | `string`  | Its summary, markdown                                                  |
| `commitSha`   | `string?` | The commit it was made on                                              |
| `submittedAt` | `string?` | ISO time                                                               |
| `url`         | `string`  | Its place on GitHub                                                    |

### ReviewComment

A comment on a line of a pull request’s diff.

| Field          | Type       |                                                          |
| -------------- | ---------- | -------------------------------------------------------- |
| `id`           | `integer`  | Its id                                                   |
| `reviewId`     | `integer?` | The review it belongs to                                 |
| `inReplyTo`    | `integer?` | The comment it answers                                   |
| `author`       | `string`   | Who wrote it                                             |
| `body`         | `string`   | Its text, markdown                                       |
| `path`         | `string`   | The file                                                 |
| `line`         | `integer?` | The line; null once a later push moved the code          |
| `originalLine` | `integer?` | The line when it was written                             |
| `side`         | `string?`  | `LEFT` for the old side of the diff, `RIGHT` for the new |
| `diffHunk`     | `string`   | The diff around it                                       |
| `commitSha`    | `string?`  | The commit it was made on                                |
| `createdAt`    | `string`   | ISO time                                                 |
| `updatedAt`    | `string`   | ISO time                                                 |
| `url`          | `string`   | Its place on GitHub                                      |

### Finding

Something a Briareus review declared on a pull request.

| Field      | Type                          |                                           |
| ---------- | ----------------------------- | ----------------------------------------- |
| `key`      | `string`                      | Its stable key                            |
| `severity` | `critical\|high\|medium\|low` | How bad                                   |
| `title`    | `string`                      | What it is                                |
| `file`     | `string?`                     | Where                                     |
| `line`     | `integer?`                    | Which line                                |
| `url`      | `string?`                     | That line on GitHub                       |
| `decision` | `fix\|optional\|dismissed?`   | The verdict recorded for it               |
| `fixed`    | `boolean`                     | Whether a later review ticked it as fixed |

### ClosedIssue

An issue as closing it left it.

| Field         | Type                      |                     |
| ------------- | ------------------------- | ------------------- |
| `number`      | `integer`                 | Its number          |
| `state`       | `closed`                  | Always `closed`     |
| `stateReason` | `completed\|not_planned?` | Why it was closed   |
| `closedAt`    | `string?`                 | When, ISO 8601      |
| `url`         | `string`                  | The issue on GitHub |

### UpdatedGithubItem

The fields returned after editing an issue or pull request; read the resource again for its full detail.

| Field         | Type                                |                                                            |
| ------------- | ----------------------------------- | ---------------------------------------------------------- |
| `number`      | `integer`                           | Its number                                                 |
| `title`       | `string`                            | Its title                                                  |
| `body`        | `string`                            | Its description, markdown; empty when it has none          |
| `state`       | `open\|closed`                      | Its issue state; a merged pull request is also closed here |
| `stateReason` | `completed\|not_planned\|reopened?` | Why it was closed or reopened, when available              |
| `url`         | `string`                            | Its page on GitHub                                         |
| `labels`      | `object[]`                          | Each `{ name, color }`                                     |
| `assignees`   | `string[]`                          | Their logins                                               |

### Issue

An issue as GitHub has it right now, with what its page on GitHub shows beside the body.

| Field           | Type                                           |                                                                                                                                                                                                                                                          |
| --------------- | ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `number`        | `integer`                                      | Its number                                                                                                                                                                                                                                               |
| `title`         | `string`                                       | Its title                                                                                                                                                                                                                                                |
| `url`           | `string`                                       | Its page on GitHub                                                                                                                                                                                                                                       |
| `state`         | `open\|closed`                                 | Where it stands                                                                                                                                                                                                                                          |
| `stateReason`   | `completed\|not_planned\|duplicate\|reopened?` | Why it was last closed or reopened                                                                                                                                                                                                                       |
| `body`          | `string`                                       | Its description, markdown; empty when it has none                                                                                                                                                                                                        |
| `author`        | `string?`                                      | Who opened it; null for a deleted account                                                                                                                                                                                                                |
| `authorAvatar`  | `string?`                                      | Their avatar’s URL                                                                                                                                                                                                                                       |
| `assignees`     | `string[]`                                     | Their logins                                                                                                                                                                                                                                             |
| `labels`        | `object[]`                                     | Each `{ name, color }`, as on the board’s rows                                                                                                                                                                                                           |
| `milestone`     | `string?`                                      | Its milestone’s title                                                                                                                                                                                                                                    |
| `comments`      | `integer`                                      | How many comments it has                                                                                                                                                                                                                                 |
| `createdAt`     | `string`                                       | ISO time                                                                                                                                                                                                                                                 |
| `updatedAt`     | `string`                                       | ISO time                                                                                                                                                                                                                                                 |
| `closedAt`      | `string?`                                      | ISO time it was last closed                                                                                                                                                                                                                              |
| `type`          | `string?`                                      | Its GitHub issue type, such as `Bug` or `Feature`                                                                                                                                                                                                        |
| `parent`        | `IssueRef?`                                    | The issue it is a sub-issue of, in whatever repository                                                                                                                                                                                                   |
| `subIssues`     | `object`                                       | `{ total, completed, items }`: counts of every sub-issue, and up to 100 of them as `IssueRef`s                                                                                                                                                           |
| `pulls`         | `object[]`                                     | Up to 25 pull requests linked to close it (GitHub’s Development box), each an `IssueRef` with `draft`                                                                                                                                                    |
| `projects`      | `object[]`                                     | One `{ title, url, status, fields }` per Projects v2 board it is on. `status` is its Status, or null; `fields` is every other set single-select, text, number, date and iteration field as `{ name, value }`. Empty when the token may not read projects |
| `projectsError` | `string`                                       | Present only when GitHub refused the project read, which needs Projects: read on the server’s token: GitHub’s reason. Everything else is still read                                                                                                      |

### BoardColumn

One column of a Projects v2 board: one value of the field the view groups by.

| Field   | Type          |                                                                                                                                        |
| ------- | ------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `id`    | `string?`     | The single-select option or iteration it stands for; null for the “No …” column                                                        |
| `name`  | `string`      | Its heading, such as `In Progress`, or `No Status` for the items without a value                                                       |
| `color` | `string?`     | A single-select option’s colour as GitHub names it: `GRAY`, `BLUE`, `GREEN`, `YELLOW`, `ORANGE`, `RED`, `PINK` or `PURPLE`             |
| `count` | `integer`     | How many items it holds                                                                                                                |
| `sums`  | `object`      | Every number field of the board totalled over its items, keyed by field name, such as `{ "Story Points": 21 }`; 0 where nothing is set |
| `items` | `BoardItem[]` | Its cards, in the board’s own order                                                                                                    |

### BoardItem

One card of a Projects v2 board.

| Field       | Type                           |                                                                                                                                                                                                                             |
| ----------- | ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`        | `string`                       | The project item’s node id                                                                                                                                                                                                  |
| `type`      | `issue\|pull\|draft\|redacted` | What it is; `redacted` is an item the token may not see                                                                                                                                                                     |
| `repo`      | `string?`                      | Its repository, `owner/name`; null for a draft                                                                                                                                                                              |
| `number`    | `integer?`                     | Its number; null for a draft                                                                                                                                                                                                |
| `title`     | `string?`                      | Its title                                                                                                                                                                                                                   |
| `url`       | `string?`                      | Its page on GitHub; null for a draft                                                                                                                                                                                        |
| `state`     | `string?`                      | `open` or `closed`, and `merged` for a pull request; null for a draft                                                                                                                                                       |
| `createdAt` | `string?`                      | ISO time                                                                                                                                                                                                                    |
| `author`    | `string?`                      | Who opened it, or created the draft                                                                                                                                                                                         |
| `assignees` | `object[]`                     | Each `{ login, avatarUrl }`                                                                                                                                                                                                 |
| `labels`    | `object[]`                     | Each `{ name, color }`, colour as hex                                                                                                                                                                                       |
| `parent`    | `object?`                      | The issue it is a sub-issue of (its epic): `{ repo, number, title, url }`                                                                                                                                                   |
| `fields`    | `object[]`                     | Its set single-select, text, number, date and iteration fields as `{ name, value }`, single-selects with the option’s `color`; the issue’s GitHub issue type comes as `Type`. The Title and the group-by field are left out |

### IssueRef

An issue or pull request another one points to.

| Field    | Type      |                                                         |
| -------- | --------- | ------------------------------------------------------- |
| `number` | `integer` | Its number                                              |
| `title`  | `string`  | Its title                                               |
| `state`  | `string`  | `open` or `closed`; for a pull request also `merged`    |
| `url`    | `string`  | Its page on GitHub                                      |
| `repo`   | `string?` | Its repository, `owner/name`: not always this project’s |

### TimelineEvent

One entry of an issue’s timeline: a comment or an event. `kind` says which fields beside the first five it carries; ignore kinds you do not know. The kinds read are `commented`, `labeled`, `unlabeled`, `assigned`, `unassigned`, `milestoned`, `demilestoned`, `renamed`, `closed`, `reopened`, `cross-referenced`, `referenced`, `connected`, `disconnected`, `parent_issue_added`, `parent_issue_removed`, `sub_issue_added`, `sub_issue_removed`, `issue_type_added`, `issue_type_changed`, `issue_type_removed`, `added_to_project_v2`, `removed_from_project_v2` and `project_v2_item_status_changed`.

| Field               | Type      |                                                                                                                   |
| ------------------- | --------- | ----------------------------------------------------------------------------------------------------------------- |
| `id`                | `string`  | Its GitHub node id                                                                                                |
| `kind`              | `string`  | What happened, named as GitHub’s REST timeline names it                                                           |
| `actor`             | `string?` | Who did it, or wrote it; null for a deleted account                                                               |
| `actorAvatar`       | `string?` | Their avatar’s URL                                                                                                |
| `createdAt`         | `string`  | ISO time                                                                                                          |
| `body`              | `string`  | On `commented`: the comment, markdown                                                                             |
| `url`               | `string`  | On `commented`: its place on GitHub                                                                               |
| `updatedAt`         | `string`  | On `commented`: ISO time of its last edit                                                                         |
| `authorAssociation` | `string`  | On `commented`: `OWNER`, `MEMBER`, `CONTRIBUTOR`, `NONE`, …                                                       |
| `label`             | `object?` | On `labeled`, `unlabeled`: `{ name, color }`                                                                      |
| `assignee`          | `string?` | On `assigned`, `unassigned`: their login                                                                          |
| `milestone`         | `string?` | On `milestoned`, `demilestoned`: its title                                                                        |
| `from`              | `string`  | On `renamed`: the old title                                                                                       |
| `to`                | `string`  | On `renamed`: the new title                                                                                       |
| `stateReason`       | `string?` | On `closed`, `reopened`: `completed`, `not_planned`, `duplicate` or `reopened`                                    |
| `source`            | `object?` | On `cross-referenced`, `connected`, `disconnected`: what points here, an `IssueRef` with `kind` `issue` or `pull` |
| `commit`            | `object?` | On `referenced`: the commit that mentions the issue, `{ sha, message, url, repo }`, message cut to its first line |
| `issue`             | `object?` | On `parent_issue_*`: the parent; on `sub_issue_*`: the sub-issue. `{ number, title, url, repo }`                  |
| `type`              | `string?` | On `issue_type_*`: the type set, or removed                                                                       |
| `previousType`      | `string?` | On `issue_type_changed`: the type before                                                                          |
| `project`           | `string?` | On the `*_project_v2` kinds: the board’s title; null when the token may not read projects                         |
| `status`            | `string?` | On `project_v2_item_status_changed`: the new Status                                                               |
| `previousStatus`    | `string?` | On `project_v2_item_status_changed`: the Status before                                                            |

### Project

A project’s full settings. A body may carry any of these; what it leaves out keeps its value.

| Field                       | Type       |                                                                                                                                                                                                                                                                                                                                                                    |
| --------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `id`                        | `integer`  | Its id; not in `defaults` or a create body                                                                                                                                                                                                                                                                                                                         |
| `repo`                      | `string`   | `owner/name`                                                                                                                                                                                                                                                                                                                                                       |
| `label`                     | `string`   | Its display name                                                                                                                                                                                                                                                                                                                                                   |
| `enabled`                   | `boolean`  | Whether sessions can start on it                                                                                                                                                                                                                                                                                                                                   |
| `sortOrder`                 | `integer`  | Its place in the list                                                                                                                                                                                                                                                                                                                                              |
| `setupCommands`             | `string[]` | Run to prepare a checkout                                                                                                                                                                                                                                                                                                                                          |
| `phpBinDir`                 | `string`   |                                                                                                                                                                                                                                                                                                                                                                    |
| `localDir`                  | `string`   | Its local checkout, if any                                                                                                                                                                                                                                                                                                                                         |
| `autoUpdate`                | `boolean`  | Whether a merged pull request updates the local checkout                                                                                                                                                                                                                                                                                                           |
| `updateCommands`            | `string[]` | Run in the local checkout after it updates                                                                                                                                                                                                                                                                                                                         |
| `dbPoolEnabled`             | `boolean`  | Whether its sessions claim a database server                                                                                                                                                                                                                                                                                                                       |
| `dbPoolDatabase`            | `string`   |                                                                                                                                                                                                                                                                                                                                                                    |
| `dbRestoreSql`              | `string`   |                                                                                                                                                                                                                                                                                                                                                                    |
| `dbExtensions`              | `string[]` |                                                                                                                                                                                                                                                                                                                                                                    |
| `envTemplate`               | `string`   | The `.env` written into a checkout                                                                                                                                                                                                                                                                                                                                 |
| `runCommands`               | `string[]` | What ▶ Run runs                                                                                                                                                                                                                                                                                                                                                    |
| `runProfiles`               | `string`   |                                                                                                                                                                                                                                                                                                                                                                    |
| `reviewPublishInstructions` | `string`   |                                                                                                                                                                                                                                                                                                                                                                    |
| `autonomousReviewLoop`      | `boolean`  | Automatically mark every review-loop finding Fix and continue fixing and reviewing; defaults to false, with existing round and stall limits                                                                                                                                                                                                                        |
| `reviewTestSheet`           | `boolean`  |                                                                                                                                                                                                                                                                                                                                                                    |
| `reviewTestRun`             | `boolean`  |                                                                                                                                                                                                                                                                                                                                                                    |
| `qaNotes`                   | `string`   |                                                                                                                                                                                                                                                                                                                                                                    |
| `feedbackInstructions`      | `string`   |                                                                                                                                                                                                                                                                                                                                                                    |
| `testSheetInstructions`     | `string`   |                                                                                                                                                                                                                                                                                                                                                                    |
| `reviewAuthor`              | `string`   |                                                                                                                                                                                                                                                                                                                                                                    |
| `reviewProviderId`          | `integer?` | The provider reviews and errands run on                                                                                                                                                                                                                                                                                                                            |
| `reviewModel`               | `string`   |                                                                                                                                                                                                                                                                                                                                                                    |
| `reviewEffort`              | `string`   |                                                                                                                                                                                                                                                                                                                                                                    |
| `workerProviderId`          | `integer?` |                                                                                                                                                                                                                                                                                                                                                                    |
| `workerModel`               | `string`   |                                                                                                                                                                                                                                                                                                                                                                    |
| `workerEffort`              | `string`   |                                                                                                                                                                                                                                                                                                                                                                    |
| `isSelf`                    | `boolean`  | Whether this project is Briareus itself                                                                                                                                                                                                                                                                                                                            |
| `stepRuntimes`              | `object`   | A runtime per errand step                                                                                                                                                                                                                                                                                                                                          |
| `promptTemplates`           | `object`   | Per-project prompt overrides                                                                                                                                                                                                                                                                                                                                       |
| `projectBoard`              | `object?`  | The GitHub Projects v2 board `GET /project-board` draws: `{ owner, ownerType, number, view }`, where `owner` is an organization or user login, `ownerType` is `organization` (the default) or `user`, `number` is the project’s number and `view` an optional view number whose filter and grouping the board follows. Null, or a blank owner and number, for none |
| `createdAt`                 | `string`   | ISO time; set by the server                                                                                                                                                                                                                                                                                                                                        |
| `updatedAt`                 | `string`   | ISO time; set by the server                                                                                                                                                                                                                                                                                                                                        |

### Provider

A provider row: one login or endpoint of one CLI. A body may carry any of the first nine fields.

| Field           | Type                            |                                                                            |
| --------------- | ------------------------------- | -------------------------------------------------------------------------- |
| `id`            | `integer`                       | Its id; set by the server                                                  |
| `label`         | `string`                        | Its display name                                                           |
| `binary`        | `claude\|codex\|grok\|opencode` | Which CLI runs it                                                          |
| `active`        | `boolean`                       | Whether sessions can start on it                                           |
| `baseUrl`       | `string`                        | A custom endpoint, or empty                                                |
| `apiKey`        | `string`                        | The key for that endpoint, or empty. Returned as stored                    |
| `models`        | `string[]`                      | Models to offer; the CLI’s own list when empty                             |
| `efforts`       | `string[]`                      | Efforts to offer; the CLI’s own when empty                                 |
| `defaultModel`  | `string`                        |                                                                            |
| `defaultEffort` | `string`                        |                                                                            |
| `sortOrder`     | `integer`                       | Its place in the list                                                      |
| `hasLogin`      | `boolean`                       | Whether a login is stored for it; the login itself never leaves the server |
| `loginDir`      | `string`                        | Where its CLI keeps its login on the server                                |
| `createdAt`     | `string`                        | ISO time                                                                   |
| `updatedAt`     | `string`                        | ISO time                                                                   |

### DbServer

A database server sessions can claim, one session at a time.

| Field       | Type      |                                          |
| ----------- | --------- | ---------------------------------------- |
| `id`        | `integer` | Its id; set by the server                |
| `label`     | `string`  | Its display name                         |
| `host`      | `string`  | Its host                                 |
| `port`      | `integer` | Its port                                 |
| `username`  | `string`  | The user sessions connect as             |
| `password`  | `string`  | That user’s password. Returned as stored |
| `enabled`   | `boolean` | Whether it is in the pool                |
| `sortOrder` | `integer` | Its place in the list                    |

### ForgeAccount

A Laravel Forge organization the server calls Forge for, with the token it calls with.

| Field          | Type       |                                                                                                                  |
| -------------- | ---------- | ---------------------------------------------------------------------------------------------------------------- |
| `id`           | `integer`  | Its id; set by the server                                                                                        |
| `label`        | `string`   | Its display name; the organization when left empty                                                               |
| `organization` | `string`   | The organization’s slug, from `forge.laravel.com/<organization>/…`                                               |
| `token`        | `string`   | A Forge API token for it. Write-only: stored encrypted and never sent back; empty or absent keeps the stored one |
| `hasToken`     | `boolean`  | Whether a token is stored; read-only                                                                             |
| `repos`        | `string[]` | The projects it is available to, as `owner/name`, each an existing project                                       |

### ForgeServer

A server in a Laravel Forge account’s organization. The rest of Forge’s attributes come along, named as Forge names them.

| Field         | Type      |                                            |
| ------------- | --------- | ------------------------------------------ |
| `id`          | `integer` | Its Forge id                               |
| `name`        | `string`  | Its name                                   |
| `ip_address`  | `string`  | Its public address                         |
| `provider`    | `string`  | The cloud it runs on                       |
| `region`      | `string`  | Its region                                 |
| `php_version` | `string`  | Its default PHP                            |
| `is_ready`    | `boolean` | Whether Forge has finished provisioning it |

### ForgeSite

A site on a Forge server, with the rest of Forge’s attributes named as Forge names them.

| Field               | Type      |                                                  |
| ------------------- | --------- | ------------------------------------------------ |
| `id`                | `integer` | Its Forge id                                     |
| `name`              | `string`  | Its domain                                       |
| `status`            | `string`  | Forge’s state for it                             |
| `url`               | `string`  | Where it answers                                 |
| `repository`        | `object?` | The repository it deploys, as Forge describes it |
| `deployment_status` | `string?` | The deployment under way, if any                 |
| `quick_deploy`      | `boolean` | Whether a push deploys it                        |

### EnvoyerAccount

A Laravel Envoyer account, and the one project whose clients may use it.

| Field   | Type      |                                                                                                                     |
| ------- | --------- | ------------------------------------------------------------------------------------------------------------------- |
| `id`    | `integer` | Its id; set by the server                                                                                           |
| `label` | `string`  | Its display name                                                                                                    |
| `repo`  | `string`  | The project it is available to                                                                                      |
| `token` | `string`  | Its Envoyer API token. Write-only: stored encrypted and never returned; left out of an update, the stored one stays |

### SshServer

A server an agent may run commands on, with approval.

| Field              | Type         |                                                                                                                      |
| ------------------ | ------------ | -------------------------------------------------------------------------------------------------------------------- |
| `id`               | `integer`    | Its id; set by the server                                                                                            |
| `label`            | `string`     | Its display name                                                                                                     |
| `repo`             | `string`     | The project whose sessions may use it                                                                                |
| `host`             | `string`     | Its host                                                                                                             |
| `port`             | `integer`    | Its port                                                                                                             |
| `username`         | `string`     | The user to connect as                                                                                               |
| `identityFile`     | `string`     | The private key file on the Briareus server                                                                          |
| `permissionMode`   | `ask\|allow` | `ask` waits for approval of every command; `allow` runs them                                                         |
| `enabled`          | `boolean`    | Whether agents may use it                                                                                            |
| `dbHost`           | `string`     | Where its database listens, as seen from the server itself; `127.0.0.1` by default                                   |
| `dbPort`           | `integer`    | Its database’s port; 3306 by default                                                                                 |
| `dbUsername`       | `string`     | The database user. Write-only: stored encrypted and read back through `GET …/db-credentials`. Empty clears the login |
| `dbPassword`       | `string`     | That user’s password. Write-only, stored encrypted; left out, the stored one stays                                   |
| `hasDbCredentials` | `boolean`    | Whether a database login is stored; set by the server                                                                |

### SlackWorkspace

A Slack workspace sessions send messages in, as the user who installed the Slack app, and the projects that may use it.

| Field              | Type       |                                                                                                                                                                                                                                                                                                                                                   |
| ------------------ | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`               | `integer`  | Its id; set by the server                                                                                                                                                                                                                                                                                                                         |
| `label`            | `string`   | Its display name; the workspace’s name when left empty                                                                                                                                                                                                                                                                                            |
| `token`            | `string`   | A Slack user token (`xoxp-…`) with the scopes chat:write, users:read, channels:read, groups:read, im:write, im:history, channels:history and groups:history. Write-only: checked with Slack, stored encrypted and never returned; empty or absent keeps the stored one                                                                            |
| `signingSecret`    | `string`   | The Slack app’s signing secret, which lets replies reach sessions through `eventsUrl`. Write-only, stored encrypted; empty or absent keeps the stored one                                                                                                                                                                                         |
| `projects`         | `object[]` | The projects that may send through it, each `{ repo, channels, directMessages, permissionMode }`: `channels` the channel names or ids it may post to, `directMessages` whether it may write to people (true when absent), `permissionMode` `ask` (each message waits for approval, the default) or `allow`. A project is in one workspace at most |
| `team`             | `string`   | The workspace’s name, from Slack; read-only                                                                                                                                                                                                                                                                                                       |
| `teamId`           | `string`   | The workspace’s Slack id; read-only                                                                                                                                                                                                                                                                                                               |
| `user`             | `string`   | Whose account the messages go out as; read-only                                                                                                                                                                                                                                                                                                   |
| `userId`           | `string`   | That user’s Slack id; read-only                                                                                                                                                                                                                                                                                                                   |
| `url`              | `string`   | The workspace’s address; read-only                                                                                                                                                                                                                                                                                                                |
| `hasToken`         | `boolean`  | Whether a token is stored; read-only                                                                                                                                                                                                                                                                                                              |
| `hasSigningSecret` | `boolean`  | Whether a signing secret is stored, so replies reach sessions; read-only                                                                                                                                                                                                                                                                          |
| `eventsUrl`        | `string`   | The Request URL to give the Slack app’s Event Subscriptions, subscribed on behalf of users to message.im, message.channels and message.groups; read-only                                                                                                                                                                                          |

### DbCredentials

An SSH server’s database login, opened. Reach `host`:`port` through a tunnel over that server.

| Field      | Type      |                                                     |
| ---------- | --------- | --------------------------------------------------- |
| `host`     | `string`  | Where the database listens, as seen from the server |
| `port`     | `integer` | Its port                                            |
| `username` | `string`  | The database user                                   |
| `password` | `string`  | That user’s password                                |

### Workspace

A workspace clone slot.

| Field         | Type       |                                       |
| ------------- | ---------- | ------------------------------------- |
| `slot`        | `string`   | Its name                              |
| `repo`        | `string`   | The project it is a clone of          |
| `index`       | `integer`  | Its number among that project’s slots |
| `dir`         | `string`   | Its directory on the server           |
| `branch`      | `string?`  | The branch checked out                |
| `head`        | `string?`  | The commit checked out                |
| `dirty`       | `boolean`  | Whether it has uncommitted changes    |
| `sizeKb`      | `integer?` | Its size on disk                      |
| `setup`       | `object?`  | What its last setup installed         |
| `vendor`      | `boolean`  | Whether it has a `vendor/` tree       |
| `nodeModules` | `boolean`  | Whether it has a `node_modules/` tree |
| `claimedBy`   | `object?`  | The session holding it                |
| `error`       | `string?`  | Why it could not be read              |

### Memory

Something a project’s agents remember between sessions.

| Field         | Type                                 |                                                          |
| ------------- | ------------------------------------ | -------------------------------------------------------- |
| `id`          | `integer`                            | Its id; set by the server                                |
| `repo`        | `string`                             | The project it belongs to                                |
| `name`        | `string`                             | Its name, a slug unique within the project               |
| `type`        | `user\|feedback\|project\|reference` | What kind of fact it is; `project` when absent           |
| `description` | `string`                             | One line saying what it holds                            |
| `body`        | `string`                             | The memory itself                                        |
| `jobId`       | `string?`                            | The session that last wrote it; null when edited by hand |
| `createdAt`   | `string`                             | ISO time                                                 |
| `updatedAt`   | `string`                             | ISO time                                                 |

### SavedPrompt

A prompt kept for the composer.

| Field       | Type       |                                                       |
| ----------- | ---------- | ----------------------------------------------------- |
| `id`        | `integer`  | Its id; set by the server                             |
| `title`     | `string`   | Its title                                             |
| `body`      | `string`   | The prompt                                            |
| `repo`      | `string?`  | The project that offers it; null offers it everywhere |
| `sortOrder` | `integer?` | Its place in the list; last when absent               |

### Webhook

A session’s webhook: where an outside system posts to wake it, and the limits its turns run under.

| Field             | Type      |                                                                                             |
| ----------------- | --------- | ------------------------------------------------------------------------------------------- |
| `armed`           | `boolean` | Whether deliveries are accepted                                                             |
| `perHour`         | `integer` | Deliveries taken in any one hour                                                            |
| `maxTurns`        | `integer` | Turns deliveries may start in a row with no word from the operator                          |
| `sshUnattended`   | `boolean` | Whether an SSH server in `allow` mode runs commands unapproved in a turn a delivery started |
| `instructions`    | `boolean` | Whether the second, instructions webhook is on                                              |
| `url`             | `string`  | Where a sender posts; not in a body                                                         |
| `key`             | `string?` | The key a sender signs with; null while unarmed; not in a body                              |
| `instructionsUrl` | `string`  | Where instructions are posted; not in a body                                                |
| `instructionsKey` | `string?` | The instructions webhook’s key; not in a body                                               |
| `held`            | `integer` | Deliveries waiting; not in a body                                                           |
| `paused`          | `object?` | Why deliveries are paused; not in a body                                                    |

## Coming from the dashboard’s routes

The built-in dashboard, since removed, called its handlers by the paths on the left, with a login cookie. Those paths are retired and answer 410; each has the route on the right, for a client ported from the old pages.

| Dashboard                                                                        | API                                                                             |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `GET /api/dev/projects`                                                          | `GET /projects`                                                                 |
| `GET /api/dev/branches`                                                          | `GET /branches`                                                                 |
| `POST /api/dev/branches/serve`                                                   | `POST /branches/serve`                                                          |
| `GET /api/dev/runtimes`                                                          | `GET /runtimes`                                                                 |
| `GET /api/dev/usage`                                                             | `GET /usage`                                                                    |
| `GET /api/dev/actions`                                                           | `GET /actions`                                                                  |
| `POST /api/dev/actions`                                                          | `POST /actions`                                                                 |
| `GET /api/dev/pulls`                                                             | `GET /pulls`                                                                    |
| `GET /api/dev/pull`                                                              | `GET /pulls/{number}`                                                           |
| `GET /api/pr/view?section=description`                                           | `GET /pulls/{number}/description`                                               |
| `GET /api/pr/view?section=files`                                                 | `GET /pulls/{number}/files`                                                     |
| `GET /api/pr/view?section=commits`                                               | `GET /pulls/{number}/commits`                                                   |
| `GET /api/pr/view?section=checks`                                                | `GET /pulls/{number}/checks`                                                    |
| `GET /api/pr/view?section=comments`                                              | `GET /pulls/{number}/comments`                                                  |
| `GET /api/pr/view?section=reviews`                                               | `GET /pulls/{number}/reviews`                                                   |
| `GET /api/pr/view?section=review-comments`                                       | `GET /pulls/{number}/review-comments`                                           |
| `GET /api/pr/findings`                                                           | `GET /pulls/{number}/findings`                                                  |
| `POST /api/pr/findings/decision`                                                 | `POST /pulls/{number}/findings/decision`                                        |
| `PATCH /api/pr/update`                                                           | `PATCH /pulls/{number}`                                                         |
| `PATCH /api/issues/update`                                                       | `PATCH /issues/{number}`                                                        |
| `POST /api/pr/update-branch`                                                     | `POST /pulls/{number}/update-branch`                                            |
| `POST /api/pr/merge`                                                             | `POST /pulls/{number}/merge`                                                    |
| `POST /api/dev/pulls/:number/serve`                                              | `POST /pulls/{number}/serve`                                                    |
| `GET /api/issues/view`                                                           | `GET /issues/{number}`                                                          |
| `GET /api/issues/timeline`                                                       | `GET /issues/{number}/timeline`                                                 |
| `POST /api/issues/close`                                                         | `POST /issues/{number}/close`                                                   |
| `GET /api/dev/project-board`                                                     | `GET /project-board`                                                            |
| `GET /api/pr/commit`                                                             | `GET /commits/{sha}`                                                            |
| `GET /api/dev/sessions`                                                          | `GET /sessions`                                                                 |
| `POST /api/dev/sessions`                                                         | `POST /sessions`                                                                |
| `GET /api/dev/sessions/:id`                                                      | `GET /sessions/{id}`                                                            |
| `GET /api/dev/sessions/:id/events`                                               | `GET /sessions/{id}/events`                                                     |
| `PATCH /api/dev/sessions/:id`                                                    | `PATCH /sessions/{id}`                                                          |
| `DELETE /api/dev/sessions/:id`                                                   | `DELETE /sessions/{id}`                                                         |
| `POST /api/dev/sessions/:id/message`                                             | `POST /sessions/{id}/messages`                                                  |
| `DELETE /api/dev/sessions/:id/queue/:index`                                      | `DELETE /sessions/{id}/queue/{index}`                                           |
| `POST /api/dev/sessions/:id/cancel`                                              | `POST /sessions/{id}/cancel`                                                    |
| `POST /api/dev/sessions/:id/close`                                               | `POST /sessions/{id}/close`                                                     |
| `POST /api/dev/sessions/:id/reopen`                                              | `POST /sessions/{id}/reopen`                                                    |
| `POST /api/dev/sessions/:id/serve`                                               | `POST /sessions/{id}/serve`                                                     |
| `GET /api/dev/sessions/:id/browser`                                              | `GET /sessions/{id}/browser`                                                    |
| `POST /api/dev/sessions/:id/browser`                                             | `POST /sessions/{id}/browser`                                                   |
| `DELETE /api/dev/sessions/:id/browser`                                           | `DELETE /sessions/{id}/browser`                                                 |
| `GET /api/dev/sessions/:id/browser/stream`                                       | `GET /sessions/{id}/browser/stream`                                             |
| `GET /api/dev/sessions/:id/browser/screenshot`                                   | `GET /sessions/{id}/browser/screenshot`                                         |
| `POST /api/dev/sessions/:id/browser/input`                                       | `POST /sessions/{id}/browser/input`                                             |
| `POST /api/dev/sessions/:id/compact`                                             | `POST /sessions/{id}/compact`                                                   |
| `POST /api/dev/sessions/:id/clear`                                               | `POST /sessions/{id}/clear`                                                     |
| `POST /api/dev/sessions/:id/loop`                                                | `POST /sessions/{id}/review-loop`                                               |
| `POST /api/dev/sessions/:id/qa-loop`                                             | `POST /sessions/{id}/qa-loop`                                                   |
| `POST /api/dev/sessions/:id/link-pr`                                             | `POST /sessions/{id}/link-pr`                                                   |
| `POST /api/dev/sessions/:id/triage`                                              | `POST /sessions/{id}/findings/triage`                                           |
| `POST /api/dev/sessions/:id/triage/save`                                         | `POST /sessions/{id}/findings/save`                                             |
| `POST /api/dev/sessions/:id/findings/reply`                                      | `POST /sessions/{id}/findings/reply`                                            |
| `POST /api/dev/sessions/:id/findings/delete`                                     | `POST /sessions/{id}/findings/delete`                                           |
| `GET /api/operations/preview/:id`                                                | `GET /sessions/{id}/preview`                                                    |
| `POST /api/operations/preview/:id`                                               | `POST /sessions/{id}/preview/feedback`                                          |
| `GET /api/dev/sessions/:id/webhook`                                              | `GET /sessions/{id}/webhook`                                                    |
| `PUT /api/dev/sessions/:id/webhook`                                              | `PUT /sessions/{id}/webhook`                                                    |
| `POST /api/dev/sessions/:id/webhook/rotate`                                      | `POST /sessions/{id}/webhook/rotate`                                            |
| `GET /api/operations/recovery/:id`                                               | `GET /sessions/{id}/recovery`                                                   |
| `POST /api/operations/recovery/:id`                                              | `POST /sessions/{id}/recovery`                                                  |
| `GET /api/operations/tasks/:id`                                                  | `GET /tasks/{id}`                                                               |
| `GET /api/dev/prompts`                                                           | `GET /prompts`                                                                  |
| `POST /api/dev/prompts`                                                          | `POST /prompts`                                                                 |
| `PUT /api/dev/prompts/:id`                                                       | `PUT /prompts/{id}`                                                             |
| `DELETE /api/dev/prompts/:id`                                                    | `DELETE /prompts/{id}`                                                          |
| `POST /api/dev/uploads`                                                          | `POST /uploads`                                                                 |
| `GET /api/dev/transcribe`                                                        | `GET /transcribe`                                                               |
| `POST /api/dev/transcribe`                                                       | `POST /transcribe`                                                              |
| `GET /api/dev/providers`                                                         | `GET /providers`                                                                |
| `GET /api/memories`                                                              | `GET /memories`                                                                 |
| `GET /api/operations/memories`                                                   | `GET /memories/health`                                                          |
| `POST /api/operations/memories/merge/apply`                                      | `POST /memories/merge`                                                          |
| `POST /api/operations/memories/:id`                                              | `POST /memories/{id}/policy`                                                    |
| `POST /api/memories`                                                             | `POST /memories`                                                                |
| `PUT /api/memories/:id`                                                          | `PUT /memories/{id}`                                                            |
| `DELETE /api/memories/:id`                                                       | `DELETE /memories/{id}`                                                         |
| `GET /api/dev/usage/all`                                                         | `GET /usage/all`                                                                |
| `GET /api/operations/attention`                                                  | `GET /attention`                                                                |
| `GET /api/operations/maintenance`                                                | `GET /maintenance`                                                              |
| `POST /api/operations/maintenance`                                               | `POST /maintenance`                                                             |
| `GET /api/ssh/requests`                                                          | `GET /ssh/requests`                                                             |
| `POST /api/ssh/requests/:id/decision`                                            | `POST /ssh/requests/{id}/decision`                                              |
| `GET /api/slack/requests`                                                        | `GET /slack/requests`                                                           |
| `POST /api/slack/requests/:id/decision`                                          | `POST /slack/requests/{id}/decision`                                            |
| `GET /api/operations/deployments`                                                | `GET /deployments`                                                              |
| `GET /api/operations/deployments/config`                                         | `GET /deployments/config`                                                       |
| `POST /api/operations/deployments/config`                                        | `POST /deployments/config`                                                      |
| `POST /api/operations/deployments/plan`                                          | `POST /deployments/plan`                                                        |
| `POST /api/operations/deployments/dispatch`                                      | `POST /deployments/dispatch`                                                    |
| `POST /api/operations/deployments/acknowledge`                                   | `POST /deployments/acknowledge`                                                 |
| `GET /api/forge/accounts/:account/servers`                                       | `GET /forge/accounts/{account}/servers`                                         |
| `GET /api/forge/accounts/:account/servers/:server/sites`                         | `GET /forge/accounts/{account}/servers/{server}/sites`                          |
| `GET /api/forge/accounts/:account/servers/:server/sites/:site`                   | `GET /forge/accounts/{account}/servers/{server}/sites/{site}`                   |
| `GET /api/forge/accounts/:account/servers/:server/sites/:site/deployment-script` | `GET /forge/accounts/{account}/servers/{server}/sites/{site}/deployment-script` |
| `PUT /api/forge/accounts/:account/servers/:server/sites/:site/deployment-script` | `PUT /forge/accounts/{account}/servers/{server}/sites/{site}/deployment-script` |
| `GET /api/forge/accounts/:account/servers/:server/sites/:site/env`               | `GET /forge/accounts/{account}/servers/{server}/sites/{site}/env`               |
| `PUT /api/forge/accounts/:account/servers/:server/sites/:site/env`               | `PUT /forge/accounts/{account}/servers/{server}/sites/{site}/env`               |
| `GET /api/envoyer/available`                                                     | `GET /envoyer/accounts`                                                         |
| `GET /api/envoyer/accounts/:id/projects`                                         | `GET /envoyer/accounts/{id}/projects`                                           |
| `GET /api/envoyer/accounts/:id/projects/:project`                                | `GET /envoyer/accounts/{id}/projects/{project}`                                 |
| `GET /api/envoyer/accounts/:id/projects/:project/servers`                        | `GET /envoyer/accounts/{id}/projects/{project}/servers`                         |
| `GET /api/envoyer/accounts/:id/projects/:project/deployments`                    | `GET /envoyer/accounts/{id}/projects/{project}/deployments`                     |
| `GET /api/envoyer/accounts/:id/projects/:project/deployments/:deployment`        | `GET /envoyer/accounts/{id}/projects/{project}/deployments/{deployment}`        |
| `POST /api/envoyer/accounts/:id/projects/:project/deployments`                   | `POST /envoyer/accounts/{id}/projects/{project}/deployments`                    |
| `GET /videos/*file`                                                              | `GET /videos/{file}`                                                            |
| `PUT /api/projects/order`                                                        | `PUT /settings/projects/order`                                                  |
| `GET /api/projects`                                                              | `GET /settings/projects`                                                        |
| `POST /api/projects`                                                             | `POST /settings/projects`                                                       |
| `PUT /api/projects/:id`                                                          | `PUT /settings/projects/{id}`                                                   |
| `DELETE /api/projects/:id`                                                       | `DELETE /settings/projects/{id}`                                                |
| `GET /api/projects/:id/update`                                                   | `GET /settings/projects/{id}/update`                                            |
| `POST /api/projects/:id/update`                                                  | `POST /settings/projects/{id}/update`                                           |
| `GET /api/templates`                                                             | `GET /settings/templates`                                                       |
| `PUT /api/templates/1`                                                           | `PUT /settings/templates`                                                       |
| `POST /api/providers/test`                                                       | `POST /settings/providers/test`                                                 |
| `GET /api/providers`                                                             | `GET /settings/providers`                                                       |
| `POST /api/providers`                                                            | `POST /settings/providers`                                                      |
| `PUT /api/providers/:id`                                                         | `PUT /settings/providers/{id}`                                                  |
| `DELETE /api/providers/:id`                                                      | `DELETE /settings/providers/{id}`                                               |
| `GET /api/providers/:id/status`                                                  | `GET /settings/providers/{id}/status`                                           |
| `POST /api/providers/:id/login`                                                  | `POST /settings/providers/{id}/login`                                           |
| `POST /api/providers/:id/login/start`                                            | `POST /settings/providers/{id}/login/start`                                     |
| `POST /api/providers/:id/login/finish`                                           | `POST /settings/providers/{id}/login/finish`                                    |
| `POST /api/dbservers/test`                                                       | `POST /settings/db-servers/test`                                                |
| `GET /api/dbservers`                                                             | `GET /settings/db-servers`                                                      |
| `POST /api/dbservers`                                                            | `POST /settings/db-servers`                                                     |
| `PUT /api/dbservers/:id`                                                         | `PUT /settings/db-servers/{id}`                                                 |
| `DELETE /api/dbservers/:id`                                                      | `DELETE /settings/db-servers/{id}`                                              |
| `GET /api/workspaces`                                                            | `GET /settings/workspaces`                                                      |
| `POST /api/workspaces/:slot/reset-setup`                                         | `POST /settings/workspaces/{slot}/reset-setup`                                  |
| `POST /api/workspaces/:slot/clean`                                               | `POST /settings/workspaces/{slot}/clean`                                        |
| `GET /api/forge/accounts`                                                        | `GET /settings/forge/accounts`                                                  |
| `POST /api/forge/accounts`                                                       | `POST /settings/forge/accounts`                                                 |
| `PUT /api/forge/accounts/:id`                                                    | `PUT /settings/forge/accounts/{id}`                                             |
| `DELETE /api/forge/accounts/:id`                                                 | `DELETE /settings/forge/accounts/{id}`                                          |
| `GET /api/ssh/servers`                                                           | `GET /settings/ssh/servers`                                                     |
| `POST /api/ssh/servers`                                                          | `POST /settings/ssh/servers`                                                    |
| `PUT /api/ssh/servers/:id`                                                       | `PUT /settings/ssh/servers/{id}`                                                |
| `DELETE /api/ssh/servers/:id`                                                    | `DELETE /settings/ssh/servers/{id}`                                             |
| `GET /api/ssh/servers/:id/db-credentials`                                        | `GET /settings/ssh/servers/{id}/db-credentials`                                 |
| `GET /api/slack/workspaces`                                                      | `GET /settings/slack/workspaces`                                                |
| `POST /api/slack/workspaces`                                                     | `POST /settings/slack/workspaces`                                               |
| `PUT /api/slack/workspaces/:id`                                                  | `PUT /settings/slack/workspaces/{id}`                                           |
| `DELETE /api/slack/workspaces/:id`                                               | `DELETE /settings/slack/workspaces/{id}`                                        |
| `GET /api/envoyer/accounts`                                                      | `GET /settings/envoyer/accounts`                                                |
| `POST /api/envoyer/accounts`                                                     | `POST /settings/envoyer/accounts`                                               |
| `PUT /api/envoyer/accounts/:id`                                                  | `PUT /settings/envoyer/accounts/{id}`                                           |
| `DELETE /api/envoyer/accounts/:id`                                               | `DELETE /settings/envoyer/accounts/{id}`                                        |
| `GET /api/mobile-devices`                                                        | Not in the API: `npm run create-token -- --list` on the server                  |
| `POST /api/mobile-devices`                                                       | Not in the API: `npm run create-token` on the server                            |
| `DELETE /api/mobile-devices/:id`                                                 | Not in the API: `npm run create-token -- --revoke <id>` on the server           |
