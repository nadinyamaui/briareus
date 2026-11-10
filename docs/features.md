# Server features and recent additions

This repository contains the Briareus server. Its `/api/v1` API supports
[Windows](https://github.com/okanetsolutions/briareus-windows),
[iOS (Swift)](https://github.com/okanetsolutions/briareus-swift), and
[Meta Quest](https://github.com/okanetsolutions/briareus-quest) clients.
There is no built-in dashboard. Server support does not imply that every
client has implemented a feature.

## Users and tokens

Several people can share one server. Every `/api/v1` token belongs to a user,
an admin or a member, and the server acts as that user; disabling a user
stops all their tokens. Users and tokens are managed on the machine
(`npm run users`, `npm run create-token`), and admins can list users with
`GET /users`. Admins share projects and servers with members
(`PUT /settings/shares`): a member's tokens reach only the projects shared
with them, and Envoyer accounts only once shared. Sessions belong to the
user who started them: members see their own (and ownerless system work),
their sessions use only the database, SSH and MCP servers shared with them,
they approve their own sessions' SSH commands, and usage breaks down by user.
Each user can connect their own GitHub account (`PUT /me/github`) so their
API changes and their sessions' commits and pushes are made as them. Mailboxes
belong to the user who connected them, and sessions reach their owner's.
Slack workspaces likewise belong to whoever connected them, for the inbox,
approvals and sessions, and each user connects their own Home Assistant
(`PUT /me/home-assistant`). WhatsApp accounts belong to one user each (a
second user needs WAHA Plus to link a phone). See
[users](api-v1.md#users).

## Coding sessions

Sessions run Claude Code, Codex, Grok, opencode, DeepSeek Harness, Qwen Code or Z.AI in their own workspace
clones, each with a database of its own on the project's server, or in a
local checkout. An admin's interactive session can edit its project's `.env`
template, the file every checkout is seeded from, with MCP tools. Clients can
stream transcripts, send or queue messages, cancel turns, compact context,
pin sessions to the top of the list, close and reopen sessions, and attach files
or transcribed voice notes. Claude `/btw` questions use a separate fork of
the conversation. Orchestrators coordinate worker sessions and their
PR actions and QA work. `reopen_worker` (session-token HTTP fallback:
`POST /api/agent/sessions/<id>/reopen`) prepares an owned, fully closed task worker
through the existing reopen lifecycle, preserving history and target-project configuration.
It requests no new agent turn and returns HTTP 202 with `preparing`, `qaReady` and
`messageSent: false`; buffered deliveries retain normal reopen behavior.
For QA required after review, close implementation, run the official review, verify
code approval at the current PR head, reopen implementation, poll until idle without
an unanswered question, then arm `set_worker_qa_loop`. Reopening does not arm QA;
worker limits and current project access still apply.
For a stacked PR, `spawn_worker` takes `stack_on` (HTTP `stackOn`): the worker cuts
its own branch off that branch and opens its PR against it, without checking it out
or holding its PR, so review and solve-conflicts on the lower PR stay available.
Whether a session mid-turn holds a branch or its PR is read from the branch it has
checked out at that moment, so a worker that moves to a branch of its own stops
blocking the PR it was spawned on, and `list_workers` shows the branch it is actually on.
CI verdict wakes are deduplicated per orchestrator and PR head across workers;
empty, skipped-only and neutral-only check rollups do not wake it or claim merge readiness.

See [how sessions run](../README.md#how-a-session-runs) and the
[session API reference](api-v1-reference.md#sessions).

## GitHub and QA

The server reads pull requests, diffs, commits, checks, comments, issues,
issue timelines, sub-issues and Projects v2 boards. Manage clients can update
pull requests and issues, move board cards, update PR branches and merge.
Repository routes expose trees, files and gzipped archives at a revision.

QA loops create and execute test sheets when a task settles on an open pull request.
Each QA run posts its own sheet tagged with a run identity (run id, PR, head and base branch), leaving
earlier sheets as history. Verdicts read only that run's sheet once it is marked executed and its head
and base branch still match the live PR. Missing or stale execution is incomplete,
while actual current-run failures still stop the loop for human judgment.
With `babysitPrs` enabled, conflict resolution, CI fixes and recommended code reviews run every 15 minutes,
using the project's action runtime and respecting author filters and retry limits.

Each code review session is recorded in the `code_reviews` table: its PR,
branch, the reviewed head, its provider, model and effort, its tokens and cost
(estimated for providers that report none, with a count of turns no price
covered) and whether it completed or failed, with the published summary. A
review whose session fails to start, or is closed or deleted before its review
turn ends, is marked failed; it completes when its labelling step ends.
A review runs on Claude (`/code-review`) or Codex (`codex exec review`), then
publishes, verifies and labels the PR in the same conversation. When nothing is
left to fix on a PR another account opened, the labelling step also approves the
reviewed commit on GitHub. Through MCP tools mounted
only on review sessions (`review_finding_add`, `review_finding_update`,
`review_summary_set`, `review_findings_list`), the publish step registers each
finding in `code_review_findings` (severity, type, location) and stores the
summary comment; the verify step records each `fix`/`optional`/`dismiss`
verdict, its verification and the evidence. Review sessions close when done and retain their history. Review
records and findings also survive explicit session deletion.
Clients read a pull request's latest stored reviews, with their findings and
verdicts, through `GET /api/v1/pulls/{number}/code-reviews`.
With a manage token they can update one through
`PATCH /api/v1/pulls/{number}/code-reviews/{reviewId}/findings/{findingId}`,
sending `repo` and the fields to change. For example,
`{"repo":"acme/shop","shouldFix":"optional","comments":"Low impact; defer this change."}`
records a decision not to fix a real issue; `dismiss` rejects a refuted finding,
`fix` requires a fix, and `null` clears the verdict. Omitted fields stay unchanged.

Each review also carries `handlingStatus`: `pending` until someone has addressed
its findings or decided not to fix them, then `handled`. Clients set this explicitly
with `PATCH /api/v1/pulls/{number}/code-reviews/{reviewId}` and a body such as
`{"repo":"acme/shop","handlingStatus":"handled"}`; sending `pending` reopens it.
It is independent of the agent's `running`/`completed`/`failed` execution status
and the individual findings' verdicts. Existing and new reviews start as `pending`,
and rerunning a review in the same session resets it to `pending`.

### Earlier review decisions

A review does not repeat what earlier reviews of the same pull request already
decided. The flow stays discover, publish, verify, label; between discovery and
publication the server itself reads the pull request's review threads from
GitHub, every thread and every reply however many pages that takes, and hands
them to the publish step as a data file. A passing GitHub failure is tried
again twice; if the read still fails or comes back incomplete, or the pull
request's head moved, the review stops there: it fails like any other failed
step and publishes nothing.

Each thread gets a disposition from the verdict reply standing on it (the bold
**Fix**, **Optional** or **Dismissed** the verify step writes; the latest one
wins):

| Disposition | Meaning                                                                            |
| ----------- | ---------------------------------------------------------------------------------- |
| `dismissed` | Refuted, with the reason given. A dismissal with no reason does not count.         |
| `addressed` | A **Fix** verdict whose thread was then resolved.                                  |
| `optional`  | Confirmed but not required. It stays distinct from a dismissal.                    |
| `fix`       | A required fix still open.                                                         |
| `open`      | No verdict yet.                                                                    |
| `resolved`  | Resolved with no verdict. This decides nothing: people resolve threads to tidy up. |

Only two kinds of verdict count: a reply written by the account the server reads
GitHub as or by the account the review's agent posts as (the session owner's
connected GitHub account, when there is one), and a decision Briareus stored,
from a review's verify step or from a client through the API. A reply by
anybody else is passed along as context and possible new evidence, never as a
decision, however it is worded: on a public repository anyone can type
`**Dismissed**`. Between a counted reply and a stored decision, the later one
stands.

The publish step then gives every finding one reconciliation, and the server
checks it against the history it read before storing the finding:

- `suppressed`: the same claim was dismissed and the reason still holds, was
  addressed and is still fixed, or was optional in a thread since resolved. It
  is not posted again. It is still registered, with the earlier decision as its
  verdict and `priorUrl`, `priorDisposition` and `priorReason` naming the
  thread and its reason, so repeats stay countable. A suppression naming a
  thread that is not in the pull request's history, or one that does not carry
  such a decision, is refused.
- `adopted`: the same claim already has an unresolved thread, including a
  comment an interrupted run already posted. No duplicate is posted; the
  finding continues in that thread and gets its verdict there.
- `revisit`: a decided claim whose decision changed code or new evidence
  invalidates. It is posted as a new comment that links the earlier thread, and
  `revisitReason` must say what changed; a revisit without it is refused.
- `new`: everything else, including an unrelated problem in the same file or on
  the same line and a claim whose thread was merely resolved.

The verify step leaves suppressed findings alone and rules on adopted and
revisited ones like any other. A dismissal stays on GitHub as before: the
**Dismissed** reply with its reason, the thread resolved, nothing deleted. A
decision that so far exists only in Briareus's records is replied into its
thread when a later review relies on it.

Findings carry `findingRef` (the same for one claim across every review of the
pull request), `commentId` and `threadId` (the GitHub comment and thread it is
published as; the thread is matched by the server once publication ends) and
`headSha` (the head it was raised on). The decisions themselves are kept per
pull request in `code_review_decisions`, one row per thread, or per finding that
had no inline thread: the verdict, its reason, what recorded it (`github`,
`review` or `api`), who, the head it was given on and whether the thread was
resolved. Each review refreshes them from GitHub, and recording a verdict, from
the verify step or `PATCH …/findings/{findingId}`, updates them at once. They
reference no session and no review, so they survive a rerun in the same session
(which replaces that review's findings), the session's deletion and every later
review. Clients read them through
`GET /api/v1/pulls/{number}/code-review-decisions`.

Publication is safe to retry: a rerun or a recovered publish step reads the
history again, so comments the interrupted attempt already posted are adopted
rather than posted twice, and the summary comment ends with an invisible
`<!-- reviewer:code-review <head> -->` line so the retry updates it instead of
adding another.

**Migration.** `2026_11_10_120000_add_code_review_decisions` adds the table and
the finding columns at boot; there are no settings. Existing findings keep
their data, get `reconciliation` `new` and a reference of their own (`f<id>`),
and have no comment or thread ids. Nothing is back-filled from GitHub: a pull
request's earlier threads are read the first time it is reviewed after the
upgrade, and their verdict replies count when one of the accounts above wrote
them. A verdict an earlier review posted as some other account is context
until a review or a client records the decision again. The existing responses
and requests are unchanged apart from the added fields; the fields describing
a finding's reconciliation are read-only for clients.

See [PR actions and QA](../README.md#pull-request-actions-and-qa) and the
[GitHub API reference](api-v1-reference.md#pull-requests-and-issues).

## Previews and browser access

Run profiles serve session checkouts, branches and pull requests. A shared
Chromium browser lets the agent and a client interact with the same tabs.
Clients can stream the browser, send input, capture screenshots and submit
annotated preview feedback. QA runs can record downloadable videos.

See [the shared browser](api-v1.md#the-shared-browser) and
[visual preview feedback](../README.md#visual-preview-feedback).

## Business inboxes and session tools

| Service           | Client API                                                                                                     | Interactive session tools                                                                                                                                |
| ----------------- | -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Slack             | Channels, DMs, threads, replies, read positions and live events as the connected user                          | Read permitted channels and the user's DMs; send with the project's approval rules                                                                       |
| Gmail and Outlook | Connect and sync mailboxes, search messages, read bodies, reply and move individual messages to provider trash | Opt-in projects can search, read, connect, sync, send, reply, mark read/unread, archive and trash                                                        |
| WhatsApp          | Link through WAHA, read chats, send text replies, mark read and download attachments                           | Opt-in projects read, open or transcribe media, reply with text, voice, photos, videos or files, mark read, open groups; replies (voice as text) wake it |

These client inbox routes require admin tokens and work independently of
coding sessions. Session tools enforce their own project and turn access
rules. Mail management also requires provider consent; trash actions do not
permanently delete messages.

See [Slack setup](../README.md#slack), [mailbox setup](../README.md#mail),
[session email access](email-mcp.md), and [WhatsApp setup](whatsapp.md).

Projects with `printToolsEnabled` (off by default) also give their interactive
sessions print tools: list the core machine's CUPS printers, print a session
file with copies, pages, sides, color and paper size, and follow or cancel the
jobs the session sent. See [printing from a session](printing.md).

Projects with `homeAssistantToolsEnabled` (off by default) give their
interactive sessions Home Assistant tools on the session owner's connected
home: find entities, read their state, list actions, call a service and fire
an event. See [Home Assistant from a session](home-assistant.md#home-assistant-from-a-session).

## Operations, integrations and memory

The attention API reports unanswered questions, held findings, failed work
and pending approvals. Recovery reports inspect interrupted sessions before
resuming them. Maintenance draining blocks new work while existing work
settles. Registered SSH servers support explicit approval or immediate
execution according to their configured permissions.
Linux servers can opt into [resource monitoring](ssh-resource-monitoring.md)
through a separate outbound HTTPS service: CPU, memory, disks and network sampled once a minute, with a persistent
rolling 24-hour history exposed through the API.

Deployment planning and dispatch use GitHub workflows and immutable source
revisions. Laravel Forge and Envoyer expose their configured accounts through
the server. Claude and Codex can use project-scoped remote or stdio MCP
servers, with OAuth sign-in and encrypted credentials. Project memories,
saved prompts, providers and workspace settings are also available through
the API.

See [operations and integration details](../README.md#registered-ssh-servers)
and the [API reference](api-v1-reference.md).

## Usage and provider availability

A per-turn ledger keeps token counts, agent time and reported costs even
after sessions are deleted. Usage views group spending by project, account,
session and model. When a CLI reports no cost, the server estimates a list-price
equivalent from token usage. Subscription estimates are not invoices.
Claude accounts can fail over when quota is exhausted, and a runtime whose
provider was switched off runs on the closest active provider of the same CLI.

See [session costs](../README.md#what-a-session-costs) and
[Claude account failover](../README.md#claude-account-failover).

## Resource stats

CI/CD check history and dashboard metrics are also available through
`GET /stats/ci` and `GET /ci/runs`, including time per runner group and runner and
its cost at admin-set hourly rates; see [CI/CD statistics](ci-stats.md).

The server samples every open session every ten seconds: the CPU, resident
memory and process count of everything it spawned (the agent's turn or a setup
step, the ▶ Run server, the shared browser), split by kind, plus the disk its
workspace clone takes, re-measured every five minutes. Alongside, it samples
the machine (CPU, memory, load), the Briareus process itself and the disks
sessions write to. The last hour is kept in memory for charts and starts over
on restart. Session figures need Linux's `/proc`.

See `GET /stats/server`, `GET /stats/sessions` and `GET /sessions/{id}/stats`
in the [API reference](api-v1-reference.md#operations).

## Recent additions

These additions are present in the server revision documented here:

- Users: every token belongs to an admin or member, and changes made through
  the API are signed with the user's name.
- Sharing: projects and servers can be shared with several users; members
  reach only what is shared with them.
- Sessions belong to users, with per-user visibility, server access, SSH
  approvals and spend.
- Per-user GitHub identity for API changes and session commits.
- Per-user mailboxes, for the API and for sessions' mail tools.
- Per-user Slack workspaces, inbox and approvals.
- Per-user Home Assistant connections, for the API and for sessions' Home Assistant tools.
- Per-user WhatsApp accounts for the inbox, session tools and watches.
- Per-user attention feed and task history.
- Sessions can edit their project's `.env` template through MCP (admins'
  interactive sessions only).
- Code reviews and their findings are stored in the database; review sessions
  register findings through their own MCP tools.; clients read them per
  pull request through the API. What the reviews of a pull request decided is
  kept per pull request and outlives the reviews and their sessions.

- Slack's core inbox has live events and operator replies; eligible sessions
  can now read their project's channels, DMs and threads too.
- Gmail and Outlook sync into the core; opted-in projects receive email
  tools, including sending, filing and moving mail to recoverable trash.
  Read-only mailbox deletion returns a reconnect conflict, and Outlook
  mailbox access is validated before a connection is saved.
- WhatsApp has a local WAHA installer and inbox API, plus opt-in session
  tools. Installer reruns preserve engine selection, and NOWEB history
  storage is enabled for accounts created by the core. Replies in a chat a
  session watches wake it, with voice notes transcribed by the core first.
  `WAHA_ACCOUNTS` limits a shared WAHA to the accounts the core may use.
- Opt-in projects can print session files on the core machine's CUPS
  printers through the internal print MCP.
- Open sessions recover automatically after server restarts, retaining
  queued instructions and workflow stages. Workspace cleanup preserves
  checkouts for inspection and recovery instead of deleting them.
- Provider quota readings and retry deadlines persist across restarts;
  manual refreshes have a five-minute minimum interval.
- Codex cost estimates use measured cached-input counts and request token
  usage for long-context pricing. Resumed Claude turns book their own cost
  rather than the conversation's cumulative cost.
- Failed app runs report stdout diagnostics as well as stderr. Shared-browser
  instructions stay active when browser startup fails.
- Repository trees, files and tarball downloads are available through the
  client API. Configured MCP servers support OAuth sign-in at setup.
- Orchestrators can run code review or resolve conflicts on existing PRs through
  `start_pr_action`
  and control worker QA independently.
  Concurrent PR actions remain blocked; HTTP and MCP errors identify the blocking
  session's ID, status, activity, title and provider/model only for the same explicit
  owner with current project access. Other blockers remain anonymous, and diagnostics
  grant no transcript or session control access.
- Pull request reads share cached work and return a retryable 429 when the
  GitHub allowance is exhausted.

For the complete change history, see [GitHub releases](https://github.com/nadinyamaui/briareus/releases).
