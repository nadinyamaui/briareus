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

## Pull requests

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

### `POST /pulls/{number}/merge`

Merge a pull request on GitHub, at the head and into the base it was read with. Needs `manage`, held to `repo`.

**Body**

| Field                  | Type                    |                                                                     |
| ---------------------- | ----------------------- | ------------------------------------------------------------------- |
| `repo` **required**    | `string`                | A project, as `owner/name`                                          |
| `headSha` **required** | `string`                | The `pr.headSha` that was read; a push since then refuses the merge |
| `baseRef` **required** | `string`                | The base branch the pull request was read with                      |
| `method`               | `squash\|merge\|rebase` | How to merge; `squash` when absent                                  |

**Returns** `{ merged: boolean, sha: string?, message: string }`

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
| `budgetUsd`     | `number`  | What those turns may spend in 24 hours; 0 is no cap                                         |
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
| `pricing`  | `string`                                   | Only turns priced this way                                                  |

**Returns** `object`. Totals, `buckets` over time, breakdowns by `projects`, `providers`, `models` and `activities`, `topSessions`, a `comparison` with the window before, and the `options` each filter accepts.

### `GET /attention`

List what is waiting on the operator: questions, findings to rule on, failures, SSH approvals. Needs `admin`.

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

### `GET /notifications`

Read the web push status. Needs `admin`.

**Returns** `{ configured: boolean, publicKey: string?, contact: string, subscriptions: integer }`

### `POST /notifications/config`

Set the contact address web push is sent on behalf of. Needs `admin`.

**Body**

| Field                  | Type     |                                 |
| ---------------------- | -------- | ------------------------------- |
| `contact` **required** | `string` | A `mailto:` or `https:` address |

**Returns** `{ publicKey: string }`

### `POST /notifications/subscribe`

Subscribe a browser to web push for some projects. Needs `admin`.

**Body**

| Field                       | Type       |                                           |
| --------------------------- | ---------- | ----------------------------------------- |
| `subscription` **required** | `object`   | The browser’s `PushSubscription`, as JSON |
| `repos` **required**        | `string[]` | Projects, as `owner/name`                 |

**Returns** `{ id: string }`

### `POST /notifications/unsubscribe`

Remove a web push subscription. Needs `admin`.

**Body**

| Field                   | Type     |                               |
| ----------------------- | -------- | ----------------------------- |
| `endpoint` **required** | `string` | The subscription’s `endpoint` |

**Returns** `{ ok: boolean }`

### `GET /videos/{file}`

Download a video a test run recorded. Needs `admin`.

**Returns** the file.

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

## Tokens

### `GET /settings/devices`

List the tokens issued, and the projects one can be limited to. Needs `admin`.

**Returns** `{ devices: Client[], projects: object[] }`

### `POST /settings/devices`

Issue a token; its secret is in this answer and nowhere afterwards. Needs `admin`.

**Body**

| Field                     | Type                  |                                                    |
| ------------------------- | --------------------- | -------------------------------------------------- |
| `label` **required**      | `string`              | A name to show                                     |
| `permission` **required** | `read\|manage\|admin` | What the token may do                              |
| `repos`                   | `string[]`            | The projects it is held to; not needed for `admin` |
| `days` **required**       | `integer`             | Days until it expires, 1–365                       |

**Returns** 201 `{ device: Client, token: string }`

### `DELETE /settings/devices/{id}`

Revoke a token. Needs `admin`.

**Returns** `{ ok: boolean }`

## Objects

### Client

A token’s own record. The token itself is shown once, when it is created.

| Field        | Type                  |                                                                             |
| ------------ | --------------------- | --------------------------------------------------------------------------- |
| `id`         | `string`              | Its id                                                                      |
| `label`      | `string`              | The name it was given                                                       |
| `permission` | `read\|manage\|admin` | What it may do                                                              |
| `repos`      | `string[]`            | The projects it is held to; empty for an admin token, which is held to none |
| `createdAt`  | `integer`             | When it was issued, epoch milliseconds                                      |
| `expiresAt`  | `integer`             | When it stops working, epoch milliseconds                                   |

### ProjectSummary

A project as a session picker needs it.

| Field              | Type       |                                                       |
| ------------------ | ---------- | ----------------------------------------------------- |
| `repo`             | `string`   | `owner/name`                                          |
| `label`            | `string`   | Its display name                                      |
| `hasLocal`         | `boolean`  | Whether it has a local checkout a session can work in |
| `reviewProviderId` | `integer?` | The provider its reviews and errands run on           |
| `reviewModel`      | `string`   | That runtime’s model, or empty                        |
| `reviewEffort`     | `string`   | That runtime’s effort, or empty                       |
| `runProfiles`      | `string[]` | The names ▶ Run offers, the default first             |

### Session

A conversation with an agent. The record is pushed whole on every change, so replace your copy rather than merging.

| Field            | Type                                                            |                                                                                                           |
| ---------------- | --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `id`             | `string`                                                        | Its id                                                                                                    |
| `title`          | `string`                                                        | Its title                                                                                                 |
| `repo`           | `string`                                                        | The project it belongs to                                                                                 |
| `status`         | `queued\|preparing\|running\|idle\|closed\|failed\|interrupted` | `idle` is waiting for a message; `closed` has released its workspace and can be reopened                  |
| `error`          | `string?`                                                       | Why it failed                                                                                             |
| `activity`       | `string`                                                        | What its spend is filed under: `chat`, `code-review`, `qa`, `orchestrator`, an errand id, …               |
| `provider`       | `string`                                                        | The provider’s label                                                                                      |
| `providerId`     | `integer`                                                       | The provider’s id                                                                                         |
| `model`          | `string`                                                        | The model it runs on                                                                                      |
| `effort`         | `string`                                                        | The effort it runs at                                                                                     |
| `branch`         | `string?`                                                       | The branch its workspace is on                                                                            |
| `baseBranch`     | `string?`                                                       | The branch that one was cut from                                                                          |
| `startBranch`    | `string?`                                                       | The existing branch it was started on, if any                                                             |
| `local`          | `boolean`                                                       | Whether it works in the project’s local checkout                                                          |
| `createdAt`      | `string`                                                        | ISO time it was created                                                                                   |
| `startedAt`      | `string?`                                                       | ISO time its current turn started                                                                         |
| `endedAt`        | `string?`                                                       | ISO time it last settled                                                                                  |
| `turns`          | `integer`                                                       | Turns run so far                                                                                          |
| `costUsd`        | `number?`                                                       | What this conversation spent, when its provider prices turns                                              |
| `inputTokens`    | `integer?`                                                      | Input tokens consumed                                                                                     |
| `outputTokens`   | `integer?`                                                      | Output tokens consumed                                                                                    |
| `contextTokens`  | `integer?`                                                      | The live context size                                                                                     |
| `contextWindow`  | `integer?`                                                      | The model’s context window                                                                                |
| `usage`          | `object`                                                        | Spend including every session it ordered: `sessions`, `costUsd`, `estimatedCostUsd`, tokens, `durationMs` |
| `awaitingAnswer` | `boolean`                                                       | Whether the agent asked a question and is waiting                                                         |
| `queued`         | `object[]`                                                      | Messages waiting for the turn to end, each `{ text }`; absent when none                                   |
| `liveInput`      | `boolean`                                                       | Whether a message sent now goes into the running turn rather than the queue                               |
| `lastText`       | `string?`                                                       | The opening of the agent’s latest message                                                                 |
| `lastTool`       | `string?`                                                       | The tool the running turn is on                                                                           |
| `subagents`      | `object[]`                                                      | The sub-agents working right now, each `{ id, name, summary, startedAt }`                                 |
| `prStatus`       | `object?`                                                       | Its pull request, once it has one: number, URL, state, checks and reviews                                 |
| `serveLinks`     | `object[]?`                                                     | Where ▶ Run is serving its checkout, each `{ url }`; null when not running                                |
| `reviewLoop`     | `object?`                                                       | The review loop’s state when armed                                                                        |
| `qaLoop`         | `object?`                                                       | The QA loop’s state when armed                                                                            |
| `reviewTriage`   | `object?`                                                       | Review findings held for the user’s verdicts                                                              |
| `orchestrator`   | `boolean`                                                       | Whether it is a supervisor of worker sessions                                                             |
| `parentId`       | `string?`                                                       | The orchestrator it works for                                                                             |
| `canCompact`     | `boolean`                                                       | Whether `POST /sessions/{id}/compact` would run now                                                       |
| `compacting`     | `boolean`                                                       | Whether a compaction is running                                                                           |
| `autoCompactAt`  | `integer?`                                                      | The context size at which it compacts itself                                                              |
| `hiddenLines`    | `integer`                                                       | How many transcript lines a Clear or compaction hid; absent when none                                     |

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

### Project

A project’s full settings. A body may carry any of these; what it leaves out keeps its value. docs/projects.html explains each.

| Field                       | Type       |                                              |
| --------------------------- | ---------- | -------------------------------------------- |
| `id`                        | `integer`  | Its id; not in `defaults` or a create body   |
| `repo`                      | `string`   | `owner/name`                                 |
| `label`                     | `string`   | Its display name                             |
| `enabled`                   | `boolean`  | Whether sessions can start on it             |
| `sortOrder`                 | `integer`  | Its place in the list                        |
| `setupCommands`             | `string[]` | Run to prepare a checkout                    |
| `phpBinDir`                 | `string`   |                                              |
| `localDir`                  | `string`   | Its local checkout, if any                   |
| `dbPoolEnabled`             | `boolean`  | Whether its sessions claim a database server |
| `dbPoolDatabase`            | `string`   |                                              |
| `dbRestoreSql`              | `string`   |                                              |
| `dbExtensions`              | `string[]` |                                              |
| `envTemplate`               | `string`   | The `.env` written into a checkout           |
| `runCommands`               | `string[]` | What ▶ Run runs                              |
| `runProfiles`               | `string`   |                                              |
| `reviewPublishInstructions` | `string`   |                                              |
| `reviewTestSheet`           | `boolean`  |                                              |
| `reviewTestRun`             | `boolean`  |                                              |
| `qaNotes`                   | `string`   |                                              |
| `feedbackInstructions`      | `string`   |                                              |
| `testSheetInstructions`     | `string`   |                                              |
| `reviewAuthor`              | `string`   |                                              |
| `reviewProviderId`          | `integer?` | The provider reviews and errands run on      |
| `reviewModel`               | `string`   |                                              |
| `reviewEffort`              | `string`   |                                              |
| `workerProviderId`          | `integer?` |                                              |
| `workerModel`               | `string`   |                                              |
| `workerEffort`              | `string`   |                                              |
| `workerBudgetUsd`           | `number?`  |                                              |
| `isSelf`                    | `boolean`  | Whether this project is Briareus itself      |
| `stepRuntimes`              | `object`   | A runtime per errand step                    |
| `promptTemplates`           | `object`   | Per-project prompt overrides                 |
| `createdAt`                 | `string`   | ISO time; set by the server                  |
| `updatedAt`                 | `string`   | ISO time; set by the server                  |

### Provider

A provider row: one login or endpoint of one CLI. A body may carry any of the first nine fields; docs/providers.html explains each.

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

### SshServer

A server an agent may run commands on, with approval.

| Field            | Type         |                                                              |
| ---------------- | ------------ | ------------------------------------------------------------ |
| `id`             | `integer`    | Its id; set by the server                                    |
| `label`          | `string`     | Its display name                                             |
| `repo`           | `string`     | The project whose sessions may use it                        |
| `host`           | `string`     | Its host                                                     |
| `port`           | `integer`    | Its port                                                     |
| `username`       | `string`     | The user to connect as                                       |
| `identityFile`   | `string`     | The private key file on the Briareus server                  |
| `permissionMode` | `ask\|allow` | `ask` waits for approval of every command; `allow` runs them |
| `enabled`        | `boolean`    | Whether agents may use it                                    |

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
| `budgetUsd`       | `number`  | What those turns may spend in 24 hours; 0 is no cap                                         |
| `sshUnattended`   | `boolean` | Whether an SSH server in `allow` mode runs commands unapproved in a turn a delivery started |
| `instructions`    | `boolean` | Whether the second, instructions webhook is on                                              |
| `url`             | `string`  | Where a sender posts; not in a body                                                         |
| `key`             | `string?` | The key a sender signs with; null while unarmed; not in a body                              |
| `instructionsUrl` | `string`  | Where instructions are posted; not in a body                                                |
| `instructionsKey` | `string?` | The instructions webhook’s key; not in a body                                               |
| `spentUsd`        | `number`  | Spent in the current 24 hours; not in a body                                                |
| `held`            | `integer` | Deliveries waiting; not in a body                                                           |
| `paused`          | `object?` | Why deliveries are paused; not in a body                                                    |

## Coming from the dashboard’s routes

The built-in dashboard calls its handlers by the paths on the left, with the login cookie. Each has the route on the right; a client ported from the dashboard’s pages swaps one for the other.

| Dashboard                                        | API                                                                                                |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| `GET /api/dev/projects`                          | `GET /projects`                                                                                    |
| `GET /api/dev/branches`                          | `GET /branches`                                                                                    |
| `GET /api/dev/runtimes`                          | `GET /runtimes`                                                                                    |
| `GET /api/dev/usage`                             | `GET /usage`                                                                                       |
| `GET /api/dev/actions`                           | `GET /actions`                                                                                     |
| `POST /api/dev/actions`                          | `POST /actions`                                                                                    |
| `GET /api/dev/pulls`                             | `GET /pulls`                                                                                       |
| `GET /api/dev/pull`                              | `GET /pulls/{number}`                                                                              |
| `GET /api/pr/view?section=description`           | `GET /pulls/{number}/description`                                                                  |
| `GET /api/pr/view?section=files`                 | `GET /pulls/{number}/files`                                                                        |
| `GET /api/pr/view?section=commits`               | `GET /pulls/{number}/commits`                                                                      |
| `GET /api/pr/view?section=checks`                | `GET /pulls/{number}/checks`                                                                       |
| `GET /api/pr/view?section=comments`              | `GET /pulls/{number}/comments`                                                                     |
| `GET /api/pr/view?section=reviews`               | `GET /pulls/{number}/reviews`                                                                      |
| `GET /api/pr/view?section=review-comments`       | `GET /pulls/{number}/review-comments`                                                              |
| `GET /api/pr/findings`                           | `GET /pulls/{number}/findings`                                                                     |
| `POST /api/pr/findings/decision`                 | `POST /pulls/{number}/findings/decision`                                                           |
| `POST /api/pr/merge`                             | `POST /pulls/{number}/merge`                                                                       |
| `POST /api/dev/pulls/:number/serve`              | `POST /pulls/{number}/serve`                                                                       |
| `GET /api/pr/commit`                             | `GET /commits/{sha}`                                                                               |
| `GET /api/dev/sessions`                          | `GET /sessions`                                                                                    |
| `POST /api/dev/sessions`                         | `POST /sessions`                                                                                   |
| `GET /api/dev/sessions/:id`                      | `GET /sessions/{id}`                                                                               |
| `GET /api/dev/sessions/:id/events`               | `GET /sessions/{id}/events`                                                                        |
| `PATCH /api/dev/sessions/:id`                    | `PATCH /sessions/{id}`                                                                             |
| `DELETE /api/dev/sessions/:id`                   | `DELETE /sessions/{id}`                                                                            |
| `POST /api/dev/sessions/:id/message`             | `POST /sessions/{id}/messages`                                                                     |
| `DELETE /api/dev/sessions/:id/queue/:index`      | `DELETE /sessions/{id}/queue/{index}`                                                              |
| `POST /api/dev/sessions/:id/cancel`              | `POST /sessions/{id}/cancel`                                                                       |
| `POST /api/dev/sessions/:id/close`               | `POST /sessions/{id}/close`                                                                        |
| `POST /api/dev/sessions/:id/reopen`              | `POST /sessions/{id}/reopen`                                                                       |
| `POST /api/dev/sessions/:id/serve`               | `POST /sessions/{id}/serve`                                                                        |
| `POST /api/dev/sessions/:id/compact`             | `POST /sessions/{id}/compact`                                                                      |
| `POST /api/dev/sessions/:id/clear`               | `POST /sessions/{id}/clear`                                                                        |
| `POST /api/dev/sessions/:id/loop`                | `POST /sessions/{id}/review-loop`                                                                  |
| `POST /api/dev/sessions/:id/qa-loop`             | `POST /sessions/{id}/qa-loop`                                                                      |
| `POST /api/dev/sessions/:id/link-pr`             | `POST /sessions/{id}/link-pr`                                                                      |
| `POST /api/dev/sessions/:id/triage`              | `POST /sessions/{id}/findings/triage`                                                              |
| `POST /api/dev/sessions/:id/triage/save`         | `POST /sessions/{id}/findings/save`                                                                |
| `POST /api/dev/sessions/:id/findings/reply`      | `POST /sessions/{id}/findings/reply`                                                               |
| `POST /api/dev/sessions/:id/findings/delete`     | `POST /sessions/{id}/findings/delete`                                                              |
| `GET /api/operations/preview/:id`                | `GET /sessions/{id}/preview`                                                                       |
| `POST /api/operations/preview/:id`               | `POST /sessions/{id}/preview/feedback`                                                             |
| `GET /api/dev/sessions/:id/webhook`              | `GET /sessions/{id}/webhook`                                                                       |
| `PUT /api/dev/sessions/:id/webhook`              | `PUT /sessions/{id}/webhook`                                                                       |
| `POST /api/dev/sessions/:id/webhook/rotate`      | `POST /sessions/{id}/webhook/rotate`                                                               |
| `GET /api/operations/recovery/:id`               | `GET /sessions/{id}/recovery`                                                                      |
| `POST /api/operations/recovery/:id`              | `POST /sessions/{id}/recovery`                                                                     |
| `GET /api/operations/tasks/:id`                  | `GET /tasks/{id}`                                                                                  |
| `GET /api/dev/prompts`                           | `GET /prompts`                                                                                     |
| `POST /api/dev/prompts`                          | `POST /prompts`                                                                                    |
| `PUT /api/dev/prompts/:id`                       | `PUT /prompts/{id}`                                                                                |
| `DELETE /api/dev/prompts/:id`                    | `DELETE /prompts/{id}`                                                                             |
| `POST /api/dev/uploads`                          | `POST /uploads`                                                                                    |
| `GET /api/dev/transcribe`                        | `GET /transcribe`                                                                                  |
| `POST /api/dev/transcribe`                       | `POST /transcribe`                                                                                 |
| `GET /api/dev/providers`                         | `GET /providers`                                                                                   |
| `GET /api/memories`                              | `GET /memories`                                                                                    |
| `GET /api/operations/memories`                   | `GET /memories/health`                                                                             |
| `POST /api/operations/memories/merge/apply`      | `POST /memories/merge`                                                                             |
| `POST /api/operations/memories/:id`              | `POST /memories/{id}/policy`                                                                       |
| `POST /api/memories`                             | `POST /memories`                                                                                   |
| `PUT /api/memories/:id`                          | `PUT /memories/{id}`                                                                               |
| `DELETE /api/memories/:id`                       | `DELETE /memories/{id}`                                                                            |
| `GET /api/dev/usage/all`                         | `GET /usage/all`                                                                                   |
| `GET /api/operations/attention`                  | `GET /attention`                                                                                   |
| `GET /api/operations/maintenance`                | `GET /maintenance`                                                                                 |
| `POST /api/operations/maintenance`               | `POST /maintenance`                                                                                |
| `GET /api/ssh/requests`                          | `GET /ssh/requests`                                                                                |
| `POST /api/ssh/requests/:id/decision`            | `POST /ssh/requests/{id}/decision`                                                                 |
| `GET /api/operations/deployments`                | `GET /deployments`                                                                                 |
| `GET /api/operations/deployments/config`         | `GET /deployments/config`                                                                          |
| `POST /api/operations/deployments/config`        | `POST /deployments/config`                                                                         |
| `POST /api/operations/deployments/plan`          | `POST /deployments/plan`                                                                           |
| `POST /api/operations/deployments/dispatch`      | `POST /deployments/dispatch`                                                                       |
| `POST /api/operations/deployments/acknowledge`   | `POST /deployments/acknowledge`                                                                    |
| `GET /api/operations/notifications`              | `GET /notifications`                                                                               |
| `POST /api/operations/notifications/config`      | `POST /notifications/config`                                                                       |
| `POST /api/operations/notifications/subscribe`   | `POST /notifications/subscribe`                                                                    |
| `POST /api/operations/notifications/unsubscribe` | `POST /notifications/unsubscribe`                                                                  |
| `GET /videos/*file`                              | `GET /videos/{file}`                                                                               |
| `PUT /api/projects/order`                        | `PUT /settings/projects/order`                                                                     |
| `GET /api/projects`                              | `GET /settings/projects`                                                                           |
| `POST /api/projects`                             | `POST /settings/projects`                                                                          |
| `PUT /api/projects/:id`                          | `PUT /settings/projects/{id}`                                                                      |
| `DELETE /api/projects/:id`                       | `DELETE /settings/projects/{id}`                                                                   |
| `GET /api/templates`                             | `GET /settings/templates`                                                                          |
| `PUT /api/templates/1`                           | `PUT /settings/templates`                                                                          |
| `POST /api/providers/test`                       | `POST /settings/providers/test`                                                                    |
| `GET /api/providers`                             | `GET /settings/providers`                                                                          |
| `POST /api/providers`                            | `POST /settings/providers`                                                                         |
| `PUT /api/providers/:id`                         | `PUT /settings/providers/{id}`                                                                     |
| `DELETE /api/providers/:id`                      | `DELETE /settings/providers/{id}`                                                                  |
| `GET /api/providers/:id/status`                  | `GET /settings/providers/{id}/status`                                                              |
| `POST /api/providers/:id/login`                  | `POST /settings/providers/{id}/login`                                                              |
| `POST /api/providers/:id/login/start`            | `POST /settings/providers/{id}/login/start`                                                        |
| `POST /api/providers/:id/login/finish`           | `POST /settings/providers/{id}/login/finish`                                                       |
| `POST /api/dbservers/test`                       | `POST /settings/db-servers/test`                                                                   |
| `GET /api/dbservers`                             | `GET /settings/db-servers`                                                                         |
| `POST /api/dbservers`                            | `POST /settings/db-servers`                                                                        |
| `PUT /api/dbservers/:id`                         | `PUT /settings/db-servers/{id}`                                                                    |
| `DELETE /api/dbservers/:id`                      | `DELETE /settings/db-servers/{id}`                                                                 |
| `GET /api/workspaces`                            | `GET /settings/workspaces`                                                                         |
| `POST /api/workspaces/:slot/reset-setup`         | `POST /settings/workspaces/{slot}/reset-setup`                                                     |
| `POST /api/workspaces/:slot/clean`               | `POST /settings/workspaces/{slot}/clean`                                                           |
| `GET /api/ssh/servers`                           | `GET /settings/ssh/servers`                                                                        |
| `POST /api/ssh/servers`                          | `POST /settings/ssh/servers`                                                                       |
| `PUT /api/ssh/servers/:id`                       | `PUT /settings/ssh/servers/{id}`                                                                   |
| `DELETE /api/ssh/servers/:id`                    | `DELETE /settings/ssh/servers/{id}`                                                                |
| `POST /api/login`                                | The dashboard’s own cookie login; a client authenticates its users itself and calls with its token |
| `POST /api/logout`                               | The dashboard’s own cookie login                                                                   |
| `GET /api/auth/state`                            | Whether the cookie login is on; with a token, `GET /` answers instead                              |
| `GET /api/dev/office/events`                     | Superseded by `GET /events`, which sends the whole session record                                  |
| `GET /api/mobile-devices`                        | Answered by the gateway as `GET /settings/devices`                                                 |
| `POST /api/mobile-devices`                       | Answered by the gateway as `POST /settings/devices`                                                |
| `DELETE /api/mobile-devices/:id`                 | Answered by the gateway as `DELETE /settings/devices/{id}`                                         |
