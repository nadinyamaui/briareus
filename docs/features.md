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
`close_session` (the same `POST /api/agent/sessions/<id>/close` as `close_worker`) lets an
orchestrator close a session of its own project that it did not start, such as the one
holding a pull request it was asked to review: only sessions its owner could close from
a client, never an unattended (auto-closing) session or another orchestrator, noted in the
closed session's transcript, and with no access beyond closing. `close_worker` closes the
orchestrator's own workers only.
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
Reviews of one pull request are bounded by the project's `reviewRoundLimit` (see
[Review rounds](#review-rounds)).

Each code review session is recorded in the `code_reviews` table: its PR,
branch, the reviewed head, its provider, model and effort, its tokens and cost
(estimated for providers that report none, with a count of turns no price
covered) and whether it completed or failed, with the published summary. A
review whose session fails to start, or is closed or deleted before its review
turn ends, is marked failed; it completes when its labelling step ends.
A review runs on Claude (`/code-review`) or Codex (`codex exec review`), then
publishes, verifies and labels the PR in the same conversation; a project can add
a security pass between discovery and publication (see
[Security review](#security-review)). When nothing is
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

### Keeping reviews off GitHub

`postReviewToGithub` on the project, on by default, says whether a code review
writes to GitHub at all. Switched off, the review runs the same steps
(discovery, any security pass, publication, verification and the last step)
and posts nothing: no summary comment, inline comments, verdict replies or
resolved threads, no labels and no approval. Its findings, verdicts and
summary are kept on the server and read through
`GET /api/v1/pulls/{number}/code-reviews`. The setting is read when a review
starts, so a review already running finishes the way it began.

Later rounds still reconcile with what earlier reviews decided: a required or
optional fix kept without a thread is adopted by its reference and ruled on
again at the new head, so a fix that was made is dismissed as fixed instead of
standing as owed. The implement-feedback action is given the required fixes
still owed as data, since they are not on the pull request, and keeps them out
of the comments it posts. A project that also has `enforceReviewOutcome` still
gets its `briareus/code-review` commit status, whose description then names how
many reasons an incomplete review has but not what they say.

### Earlier review decisions

A review does not repeat what earlier reviews of the same pull request already
decided. The flow stays discover, publish, verify, label; between discovery and
publication the server itself reads the pull request's review threads from
GitHub, every thread and every reply however many pages that takes, and hands
them to the publish step as a data file. A passing GitHub failure is tried
again twice; if the read still fails or comes back incomplete, or the pull
request's head moved, the review stops there: it fails like any other failed
step and publishes nothing.

Each thread gets a disposition from the verdict standing on it:

| Disposition | Meaning                                                                                       |
| ----------- | --------------------------------------------------------------------------------------------- |
| `dismissed` | Refuted, with the reason given.                                                               |
| `addressed` | A required fix whose thread was resolved after the fix was required.                          |
| `optional`  | Confirmed but not required. It stays distinct from a dismissal.                               |
| `fix`       | A required fix still owed. Its thread may be resolved, if it was before the fix was required. |
| `open`      | No verdict yet.                                                                               |
| `resolved`  | Resolved with no verdict. This decides nothing: people resolve threads to tidy up.            |

**Whose verdict counts.** A verdict is what Briareus stored: the review's verify
step records each one as it replies on GitHub, and a client records one through
`PATCH …/findings/{findingId}`. A stored verdict is the authority on its thread,
and among stored verdicts the later one stands. Text on GitHub is not a verdict,
whoever wrote it and however it is worded: the account a review posts as is the
account the agents working on the pull request's branch post as, and on a public
repository anyone can type `**Dismissed**`. Every reply reaches the review as
context and possible new evidence. There is one exception, for history: a bold
verdict reply (**Fix**, **Optional**, **Dismissed**) counts when it is older than
the server's decision records (the moment the migration below ran), was written
by the account the server reads GitHub as or the account the review's agent
posts as, and sits on a thread with no stored verdict. That is how the verdicts
of reviews run before the upgrade are honoured. The implement-feedback action is
also told never to open a reply with a bold verdict word.

Three rules keep a decision from being read as more than it is:

- A dismissal with no reason decides nothing. The verdict before it stands, on
  GitHub and in the stored records, until the reason is given.
- A required fix is `addressed` only when its thread was resolved after the fix
  was required. A fix required on a thread that was already resolved, or that
  overturns the dismissal which resolved it, is still owed. Who resolved a
  thread (`resolvedBy`) is passed to the review, which must check that the code
  is still fixed before it relies on an `addressed` thread.
- When a claim was reopened in a later thread (a revisit), that thread rules on
  the claim and the earlier one is superseded: it cannot be suppressed against,
  adopted or revisited again. A verdict stored under a finding's reference,
  because its thread was never matched or was deleted since, is read as the
  verdict of the claim's latest thread when it is the later one.

The publish step then gives every finding one reconciliation, and the server
checks it against the history it read before storing the finding:

- `suppressed`: the same claim was dismissed and the reason still holds, was
  addressed and is still fixed, or was optional in a thread since resolved. It
  is not posted again. It is still registered, so repeats stay countable, with
  `priorDisposition`, `priorReason` and `priorUrl` naming the earlier decision.
  Its `shouldFix` is set by the server as what that decision leaves to do:
  `dismiss` when nothing is, and `optional` when the claim was optional.
  `priorDisposition` tells a claim that was refuted (`dismissed`) from a fix
  that was made (`addressed`), which `dismiss` alone does not. A suppression
  naming a thread that is not in the pull request's history, or one that does
  not carry such a decision, is refused.
- `adopted`: the same claim already has an unresolved thread, including a
  comment an interrupted run already posted. No duplicate is posted; the
  finding continues in that thread and gets its verdict there.
- `revisit`: a decided claim whose decision changed code or new evidence
  invalidates. It is posted as a new comment that links the earlier thread, and
  `revisitReason` must say what changed; a revisit without it is refused.
- `new`: everything else, including an unrelated problem in the same file or on
  the same line, a claim whose thread was merely resolved, and a fix still owed
  on a resolved thread.

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
had no inline thread: the verdict, its reason, what recorded it (`review`, `api`
or, for history, `github`), who, the head it was given on and whether the thread
was resolved. A finding's verdict and the decision it amounts to are written in
one transaction. Only a verdict is a decision: saving `comments` alone rewords
the reason of the decision that same finding gave, while it still stands, and
changes nothing else. Decisions reference no session and no review, so they
survive a rerun in the same session (which replaces that review's findings),
the session's deletion and every later review. Clients read them through
`GET /api/v1/pulls/{number}/code-review-decisions`.

Publication is safe to retry. A recovered publish step reads the history again
and is given a prompt built from that read, not the one saved before the
interruption, so comments the interrupted attempt already posted are there to
adopt. Every publish prompt, on a first review too, names the history file and
tells the agent to look for comments it already posted before posting one.
Registering a comment, an adopted thread or a suppressed decision the review
already registered answers the stored finding instead of adding another. The
summary comment ends with an invisible `<!-- reviewer:code-review <head> -->`
line so the retry updates it instead of adding another.

What this does not rule out: a verdict reply written before the upgrade by
anything holding the reviewing account counts as history; whoever can resolve a
thread can make an open **Fix** read as `addressed`, which is why the review
must find the code fixed before suppressing against it; whether two findings are
the same claim is the review agent's judgement; and a retried step that posts a
second comment for a claim despite its instructions is registered as a second
finding, because nothing on the server can tell that two comments say the same.

**Migration.** `2026_11_10_120000_add_code_review_decisions` adds the table and
the finding columns at boot; there are no settings. Existing findings keep
their data, get `reconciliation` `new` and a reference of their own (`f<id>`),
and have no comment or thread ids. Nothing is back-filled from GitHub: a pull
request's earlier threads are read the first time it is reviewed after the
upgrade, and their verdict replies count as history under the rule above. A
verdict an earlier review posted as some other account is context until a
review or a client records the decision again, and so is any verdict reply
written after the upgrade without a stored decision behind it. The existing
responses and requests are unchanged apart from the added fields; the fields
describing a finding's reconciliation are read-only for clients.

### Review rounds

Reviewing a pull request again after every push is bounded. Each review of a
new revision is a **round**, counted per pull request across all its commits,
and a project allows `reviewRoundLimit` of them (3 by default). The flow of a
review stays discover, publish, verify, label, the discovery is still the
provider's own review command, and the project's provider, model and effort are
used as configured; rounds only decide whether a review starts and what it
covers.

**What a round is.** One review of one revision: the pull request's head commit
and the branch it targets. The session claims its round when discovery has
checked that its checkout is the pull request's current head, so a round is
never held for a session that did not start. The same revision is always the
same round, however often its review runs:

- a review recovered after a server restart continues its round;
- a review that failed and is run again on the same head uses the round it had
  (`attempts` on the round counts those runs);
- a round that failed before its publish step started reviewed nothing anybody
  received, so the next revision takes that round over instead of using a new
  one. A review that goes stale because the pull request's head or base moved
  during discovery is such a round, and so is one whose publish step never
  began because the pull request's thread history could not be read or the
  review was stopped first. Once a publish step has started, the round stays
  what it is;
- a push never resets the count, and neither does deleting the review's session
  or its stored review: the count is kept per pull request, in tables that
  reference neither.

Claims for one pull request run one at a time under a row lock, so two starters
can never both take the last round. A second session asking for a revision that
another session is reviewing right now is refused. A review and its round are
settled in one transaction, by the round the review row names, so a finished or
failed review never marks any other round. A round still marked running that no
session is running any more (its settling write was lost) is recorded as failed
when the next round on the pull request is claimed.

**Who asked.** An orchestrator's `start_pr_action` is automation (as were
rounds the retired PR babysitter started, stored with source `babysitter`); a review started through `POST /api/v1/actions` or a person's typed
`/review` is that person's request, even in an automation-created session.
Every round counts, whoever asked. The difference is in what each may
do at the limit and with a head that was already reviewed:

| Request                         | Orchestrator                 | Person (`POST /actions`)        |
| ------------------------------- | ---------------------------- | ------------------------------- |
| New revision, rounds left       | Starts                       | Starts                          |
| New revision, limit used        | Refused                      | Refused unless `continueReview` |
| Revision already reviewed       | Refused, it is not run twice | Runs again, on the round it had |
| Revision under review elsewhere | Refused                      | Refused                         |

**At the limit** no further review starts by itself. Nothing is labelled,
approved or reported as passed because the rounds ran out: the review simply
does not run, and what the earlier rounds left unresolved (required fixes not
yet addressed, findings without a verified verdict, which includes one ruled
Optional or Dismissed without the evidence the [review outcome](#review-outcome)
asks of such a verdict) is listed for a person to judge. The refusal says so and
how to go on:

- An orchestrator's `start_pr_action` answers 409 with the reason and what to
  tell its user. An agent has no way to continue past the limit.
- A plain `POST /api/v1/actions` review answers 409 with
  `{ error, code: "review_round_limit", reviewRounds }`.
- The pull request appears in `GET /api/v1/attention` as a `review-limit` item
  for whoever may see the project, until a round is continued, the limit is
  raised or the pull request closes.
- The last round the limit allows says so in the first line of its summary
  comment on the pull request. No label is added and no other comment is
  posted.

**Continuing on purpose.** A person sends the review again with
`"continueReview": true`. That grants exactly one more round, for that request
and for the head the pull request had when it was made: it is recorded on the
round with the user and the time (`continuation`), the count goes up rather than
back, and the next new revision is at the limit again. A continuation whose
review fails before it claims its round, or finds another head checked out, is
spent and has to be asked for again. The flag changes nothing while rounds are left and is refused on any
other action. Raising `reviewRoundLimit` in the project's settings is the other
deliberate way: rounds are allowed again up to the new limit.

**What a round covers.** The first round reviews the whole pull request, exactly
as before. A later round is `incremental`: the changes since the head the last
completed round reviewed, the findings still outstanding, and the behaviour
those changes affect. The server works the scope out from the review's own
checkout and widens it to the whole pull request when the change is not a
follow-up to what was reviewed:

| `scopeReason`          | Scope       | When                                                                                   |
| ---------------------- | ----------- | -------------------------------------------------------------------------------------- |
| `first_review`         | full        | The pull request's first round.                                                        |
| `no_completed_review`  | full        | No earlier round ran to its end.                                                       |
| `base_changed`         | full        | The pull request now targets another branch.                                           |
| `history_rewritten`    | full        | The reviewed head is not an ancestor of this one (a rebase, a force-push), or is gone. |
| `base_updated`         | full        | The merge base moved: the branch merged or rebased onto its base since.                |
| `base_unknown`         | full        | A merge base could not be established.                                                 |
| `large_delta`          | full        | More than 30 files or 1000 changed lines since the reviewed head.                      |
| `most_of_pr`           | full        | The delta is at least half of the whole pull request's diff.                           |
| `delta_unknown`        | full        | The delta could not be measured, or a probe of the checkout did not finish in time.    |
| `changes_since_review` | incremental | None of the above.                                                                     |

Every doubt widens; a narrow review is chosen only on facts the server
established. The facts come from git in the review's checkout, run without
blocking the server and given 30 seconds each (measuring a diff in a blobless
clone fetches from origin); one that does not finish is `delta_unknown`.

The provider's review command is not rewritten for a later round.
Its scope reaches it as instructions beside the command (an appended system
prompt for Claude, developer instructions for Codex) and a data file with the
round, the commit range and the outstanding findings, whose text was written on
GitHub and is never prompt text. The agent may still widen the review when it
finds the change reaches further than its diff. Publication reconciles with the
pull request's earlier threads exactly as described above, whatever the scope.
Each review records its `round`, `scope`, `scopeReason` and `scopeBaseSha`.

**Reading it.** `GET /api/v1/pulls/{number}/code-review-rounds` answers the
limit, the rounds used and left, `limitReached`, any refusal still waiting, each
round (its revision, status, who asked, its scope and any continuation) and
`unresolved`. `GET /api/v1/pulls/{number}/code-reviews` carries the same object
as `reviewRounds`. `limitReached` says the reviewing stopped; it is never a
verdict on the pull request.

`unresolved` says how current it is, in `asOf`. Whether a thread is resolved is
stored only when a review reads the pull request's threads, at its publish step,
so the stored state is as of the last round that got that far: a fix made and
resolved since, or a thread reopened on GitHub, is not in it. The dedicated read
therefore reads the threads from GitHub when it is asked (cached for a minute,
nothing is written) and answers `asOf.source` `github`; when GitHub cannot be
read it answers the stored state with `asOf.source` `stored`, the round, head and
time it dates from and the reason in `asOf.error`. The 409 of a refused review,
the attention item and `reviewRounds` on the code-reviews read never call GitHub:
they give the stored state and name the round it is as of.

**Setting.** `reviewRoundLimit` on the project: a whole number from 1 to 20, or
0 for no limit, in which case rounds are still counted and scoped but never
refused. Null or an empty value on a write resets it to 3; it never means "no
limit".

**Migration.** `2026_11_10_130000_add_code_review_rounds` adds
`code_review_round_counts` (one row per pull request: the count, the
continuations and the refusal that waits), `code_review_rounds` (one row per
round), the `round`, `scope`, `scope_reason` and `scope_base_sha` columns on
`code_reviews`, and `review_round_limit` on `projects`, 3 for every existing
project. Counting starts when it runs: reviews stored before it are not turned
into rounds, so an open pull request's next review is its round one and reviews
the whole pull request. A review session in flight during the upgrade claims its
round at its next discovery; one already past discovery finishes without one.
Existing responses and requests are unchanged apart from the added fields, the
added `continueReview` parameter and the 409 a review at the limit now answers.

What this does not do: a claim fails closed, so a review does not start while
the database cannot be reached; the pull request board still recommends a
review from labels alone, and the refusal is what tells an at-limit pull request
apart; and the attention item is listed for pull requests the board mirror
knows as open. That the provider's review command honours the scope it is
handed (Claude's appended system prompt, Codex's developer instructions) has not
been verified against a live review: where it is not honoured the round reviews
the whole pull request while recorded as `incremental`, which errs on the side
of reviewing more.

### Review outcome

Whether a review session ran to its end and what the review amounts to are two
things. `status` on a stored review (`running`, `completed`, `failed`) is the
first and nothing else: a `completed` review is not a passed one. The second is
the pull request's **review outcome**, which the server computes from its own
records. A label, an approval and a clean exit of the last turn are not inputs.
The flow of a review stays discover, publish, verify, label, and the project's
provider, model and effort are used as configured.

| Outcome            | Meaning                                                                                                                                             |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pending`          | Nothing to judge yet: no review covers the pull request, one is running, or the pull request moved on from the reviewed revision and awaits review. |
| `incomplete`       | A review ran and no verdict can be drawn from it. Never passed.                                                                                     |
| `changes_required` | The review is complete and a required fix stands.                                                                                                   |
| `passed`           | Every required stage completed on the head the pull request still has, and every finding is properly verified as Optional or Dismissed.             |

**What it is computed from.**

- _Stages._ The server records what it saw each step do, per review and bound
  to the head (`code_review_stages`): discovery left a report and the pull
  request had not moved, publication ended and its findings were tied to their
  threads, the Codex delegation receipt was verified (a required stage only for
  a review on Codex), verification ended, labelling ended. The rows are written
  when discovery starts, one per stage that review must complete, so they also
  say which stages are required; a stage is complete only as `completed` for the
  reviewed head. A stage still `running` after the review stopped was
  interrupted, a `failed` one keeps why, and a review with no rows at all has no
  record. Each of those is `incomplete`. The rows survive a restart: a recovered
  step runs again and is recorded when it ends, and a discovery run starts them
  over together with the review's findings.
- _Findings and their evidence._ A finding needs evidence to stop blocking,
  never to block:
  - **Fix** always stands, `confirmed`, `plausible` or with no verification at
    all: a defect the verification could not rule out is the author's to answer.
  - **Optional** lets the finding through with `verification` set (`confirmed`
    or `plausible`) and `comments` saying why it does not block. Whether the
    claim was proven changes nothing about its not blocking, and its thread
    stays open on GitHub.
  - **Dismissed** lets the finding through only with `verification`
    `confirmed` and its reason in `comments`. A `plausible` dismissal is a
    refutation nobody proved, and a dismissal takes the claim out of later
    reviews, so it is `incomplete` (`dismissal_unproven`) until it is proven,
    recorded as Optional, or decided by a person through the API.
  - No verdict, or a verdict missing those, is `incomplete`. So is a finding
    registered with an inline comment the server did not find on the pull
    request (`finding_unlinked`).
  - A suppressed duplicate carries an earlier decision instead of a verdict of
    its own, so it is cleared by that decision and only while the decision is
    itself established by the rules above. Against one that is not, it is
    `incomplete` (`prior_decision_unverified`): carrying an unproven dismissal
    over proves nothing. Confirmed Optional findings and refuted ones stay
    distinct: they are different verdicts, counted separately in the status
    description.
- _What the decisions leave._ A verdict is also the pull request's decision on
  its claim (`code_review_decisions`), which outlives the finding: a `/review`
  sent again in the same session deletes that review's findings, and the next
  round is another review. The decision is therefore stored with the
  `verification` its verdict was recorded with, and the same evidence rules are
  applied to it wherever decisions are read. A required fix still owed
  (`fix_owed`, including a fix whose thread was resolved before the verdict) is
  `changes_required`. A claim without a verified verdict
  (`earlier_finding_unverified`) is `incomplete`: one published and never ruled
  on, and equally one ruled Optional or Dismissed without the evidence that
  takes, whichever review, client or GitHub history gave the verdict and
  whether or not this review raised the claim again. So a dismissal nobody
  proved does not turn into a pass by running the review again or by pushing a
  commit. The same reading feeds `unresolved` on the rounds read and what a
  later round is told is outstanding. Thread state is as of the last review
  that read the pull request's threads.

  Such a claim is settled by ruling on it with the evidence: the verification
  step of a review that raises it in a thread again; a person changing the
  finding, where one is left (recording `verification` on a suppressed
  duplicate rules on the claim again, under their name); or a person ruling on
  the decision itself,
  `PATCH /api/v1/pulls/{number}/code-review-decisions/{decisionId}`, which
  needs no finding at all.

- _The reviewed revision._ The outcome is bound to the head and the base branch
  the review covered. Once the pull request's head moves, or it targets another
  branch, the outcome is `stale` and reads `pending` for the new revision. The
  base branch gaining commits under an unchanged head is not stale: the reviewed
  commits are what they were, and whether a branch must be up to date is the
  repository's own rule. A rebase is held to the same rule: when the server sees
  a new head (GitHub's own rebase as the pull request below it in a stack is
  merged and it is retargeted, or anybody's) whose change is the one the review
  read, the review carries over to it instead of turning stale. The change is
  what the pull request adds to its merge base, compared file by file through
  GitHub's comparison: same status, name and hunks, hunk line numbers aside,
  context lines included; a file without a patch by its blob; 300 or more
  files, or a review whose round has no recorded merge base, never carries
  over. Whatever the review concluded carries over with it, and the outcome
  says so with a `carried_over` note. A comparison GitHub does not answer
  leaves the outcome stale.
- _The round limit._ An unreviewed revision of a pull request that has used its
  rounds is `incomplete`, not `pending`: no review of it starts by itself, so it
  waits on a person. On the reviewed head the limit changes nothing about the
  outcome and is listed as a note; reaching it never passes anything.

`incomplete` outranks `changes_required`, and every reason is listed either way.
`reasons` is machine-readable: `{ code, effect, message, … }`, where `effect` is
the outcome that reason alone leads to, or `note`.

**When it is computed.** When a review starts (it becomes the review the outcome
is computed from, and reads `pending`), when its execution settles, when a
client changes a finding or rules on a decision through the API, when a review
request is refused at the round limit, and when the server sees the pull request
at another head or base branch than the outcome is for: in a `pull_request`
webhook or in a session's sync of its pull request. That is what makes a
retarget count, which moves no
commit: a pull request reviewed against `main` and retargeted to `release`
keeps its head, and the `success` on it, until the outcome is computed again
and `pending` is posted on that same commit. Nothing polls for it; a
repository with no webhook and no session on the pull request is seen at its
next review.

It is stored per pull request in `code_review_outcomes`, beside what GitHub was
last told, and every read computes it again from the stored records, so an
answer is never older than those. Recomputations for one pull request run one
at a time under a row lock. A client's write marks the stored outcome as out of
date in its own transaction, and a recomputation that fails stays owed: the
server's sweep (below) computes it again, so a failure there never leaves the
older outcome, or its status, standing for good.

**Reading it.** `GET /api/v1/pulls/{number}/code-reviews` and
`GET /api/v1/pulls/{number}/code-review-rounds` carry `reviewOutcome`: the
outcome, its reasons, `stale`, the head and base it is for, the reviewed
revision, the stage records, `enforced` and `status`. Each stored review lists
its own `stages` and `baseRef`. The finding `PATCH` answers the outcome it led
to. The rounds read computes it against the head GitHub has at that moment.

**Enforcing it.** `enforceReviewOutcome` on the project, off by default and
accepted only as `true` or `false`. Off, the outcome is computed, stored and
readable, nothing is written to GitHub, and a review's steps and prompts are
what they were; that is the state to watch outcomes in before requiring them.
On:

- The server publishes the outcome as the commit status **`briareus/code-review`**
  on the pull request's head. Require that context in the repository's branch
  protection or ruleset to block merging on it. `passed` is `success`,
  `changes_required` is `failure`, `incomplete` is `error` (the review did not
  reach a verdict, as opposed to the code having to change; GitHub blocks on
  both) and `pending` is `pending`. The description says why in at most 140
  characters. There is no target URL: this server has no page to link.
- The server writes it with its own GitHub token, also when a client's request
  led to the change, and never through the agent. The token must be allowed to
  write commit statuses (`repo:status` on a classic token, "Commit statuses:
  write" on a fine-grained one).
- A review posts `pending` on its head when it starts, so a `success` an
  earlier review left on the same commit stops counting while it runs.
  `success` is written last, after every stage and after the label step was
  checked. A head the server has not judged carries no status from Briareus,
  which a required check reads as not met; a `success` on an older head is
  harmless for the same reason.
- A status is posted unless GitHub is known to carry exactly that one for that
  head, and only GitHub's own word makes it known. The record of what was
  published is marked unconfirmed before a write goes out and confirmed by the
  answer, so a write GitHub took while its answer was lost is not mistaken for
  one it did not take: the next publication posts again whatever the record
  says. And before the server concludes that nothing needs posting, it reads the
  commit's statuses back; a status under this context that something else wrote
  (anything holding a token that may write statuses can) is written over. A
  read that fails posts. Sending the same status again is harmless.
- Writes for one pull request go out one at a time, in the order the outcomes
  were stored. A write that fails in passing is retried at once (three
  attempts); what still fails is recorded with GitHub's answer and retried
  every minute at first, doubling to an hour, or when a rate limit ends.
- What a stored outcome owes GitHub is a debt on its row, written in the same
  transaction as the outcome. A sweep, at boot and every minute, pays what is
  due: a write that failed, one that was never made because the server stopped
  between storing and sending, and an outcome whose recomputation did not land.
  It drops what nobody is owed any more: the debt of a project that is gone or
  no longer enforces, and any status of a pull request that has closed
  (checked before the first attempt too; there the board's word that it closed
  is confirmed with GitHub, since the board can omit an open pull request). A status GitHub answers 422 to, because
  the commit is gone or holds all the statuses a context may have, is tried
  five times and then left with its error.
- While GitHub is not known to carry the stored outcome, `status.published` is
  false and `status.error` says why; `status.publishedSha` and `publishedState`
  say what it last confirmed, and `publishedConfirmed` whether a write went out
  since. An outcome is enforced on GitHub only when `enforced` and
  `status.published` are both true. A pull request whose status failed to
  write is listed in `GET /api/v1/attention` as a `review-status` item until a
  write lands.
- The verification step is told what its record is read as, and from the label
  step on the review can no longer add or change its own findings (409): the
  step that is told the outcome cannot write itself a better one. That is read
  from the stage record and from the session, either being enough, and a label
  step whose start cannot be recorded is not run at all. A person can still
  change a finding, through the API, under their own user.
- The label step keeps the project's `reviewLabels` rules and the approval,
  under the server's outcome. Before the step the server reads the pull request
  from GitHub, computes the outcome without that step, and puts it first in the
  prompt as the authority: with `passed` the rules apply and the approval is
  allowed; with `changes_required` the rules apply but nothing that marks the
  code approved; with `incomplete` or a moved pull request the labels are left
  alone. After the step the server computes it again and, unless it is `passed`,
  reads the pull request's labels and reviews. That also happens when the step
  did not reach its end, because its turn failed or somebody stopped it: such a
  review is `incomplete`, and what the step did before that is held against it
  all the same. An approval the reviewing account submitted since the step
  started, of the reviewed commit or of one pushed meanwhile, is dismissed
  through GitHub's API with the outcome as the reason (`approval_dismissed`, or
  `approval_not_dismissed` when GitHub refuses). "Since the step started" is
  exact: the approvals the pull request carried just before the step are
  listed then, and one that is there afterwards and was not is the step's. (If
  that list could not be read, the step's start time is used, with a minute of
  slack for the two clocks.) An approval from before, or by anybody else, is
  never touched. An approved label (`code-approved`) is noted
  (`approved_label_ignored`) and left: a project's label rules are its own and
  the label may predate the review. What blocks the merge is the status. These
  are notes on an outcome that already does not pass.

**Migration.** `2026_11_10_140000_add_code_review_outcomes` adds
`code_review_stages`, `code_review_outcomes`, `base_ref` on `code_reviews`,
`verification` on `code_review_decisions` and `enforce_review_outcome` on
`projects`, off for every existing project. No stage record is back-filled. A
review stored before it has none, so the outcome of a pull request whose latest
review is such a one is `incomplete` (`stages_not_recorded`) until it is
reviewed again; a pull request never reviewed is `pending`. A review session in
flight during the upgrade gets its records at its next discovery run; one
already past discovery finishes without them and is `incomplete`. Existing
responses and requests are unchanged apart from the added fields.

A decision stored before the migration takes the verification of the finding
that gave it, where that finding still exists and still carries the same
verdict. Every other decision has none and so is not verified, a verdict read
from GitHub's history included: what such a reply proved was never recorded
here, and reading it as proven would let through exactly the dismissals the
evidence rules exist to stop. For a pull request that was open across the
upgrade this means an earlier **Optional** or **Dismissed** thread is listed
as `earlier_finding_unverified` until it is ruled on again, by a review that
raises it or by a person through the decision `PATCH`. Nothing changes for
required fixes, and nothing blocks anywhere until a project enforces the
outcome.

Turning `enforceReviewOutcome` on publishes the outcomes already stored for the
project's open pull requests: saving the setting marks them as owed, and the
sweep computes them again and writes their statuses within about a minute (the
same happens when `reviewRoundLimit` or `securityReview` changes). A pull
request with no stored outcome gets its status the next time one is computed (a
review, a changed verdict, a refusal at the limit, a push or retarget the server
sees), and until then carries none, which a required check reads as not met. Turning it off stops the updates and leaves
the statuses on GitHub as they were, so remove the requirement from branch
protection first.

What this does not do: it cannot withdraw a status GitHub will not let it
replace, so if a write fails for good an older status stays on that commit
while the API reports the outcome as not published; a status somebody else
writes under `briareus/code-review` stands until the server next computes or
publishes that pull request's outcome, which is when it reads the commit back
(it does not poll for it, and a commit status cannot be reserved to one
writer); an outcome that turns from passed to something else after its review
ended (a verdict changed through the API) flips the status, but the labels and
any approval from that review are checked only when the label step ends; an
approval the reviewing account submits by hand while a label step runs cannot
be told from the step's own and is dismissed with it when the outcome does not
pass, which matters where reviews post as their owner's own GitHub account; a
thread resolved on GitHub without a new review is not seen until the next
review reads the threads; a retarget or push is only seen through a webhook, a
session; a review whose session vanished without being
settled stays `running` and so `pending`; the pull request board still
recommends actions from labels alone; and the server cannot judge the quality
of evidence, only that it was recorded. The status write and read-back, the
dismissal of an approval and the behaviour of a required check were exercised
against stand-ins, not against GitHub itself.

### Security review

A project can have every code review run a **security pass** and track what it
amounts to apart from the rest of the review. The flow stays discover, publish,
verify, label: the pass is a second, security-only discovery inside it, after
the provider's own review command and before anything is published. It is one
more turn of the same conversation, on the same account, model and effort, in
the same round; nothing is switched and nothing loops. The review's stored
tokens and cost include it, like every turn of the session.

**Why not the provider's own command.** Discovery remains `/code-review` on
Claude and `codex exec review` on Codex, untouched. The security pass is a
prompt the server writes, the same for both providers. Claude Code's built-in
`/security-review` is not used: it always compares against the repository's
default branch (`origin/HEAD`), so a stacked pull request would be reviewed
against the wrong base; it takes no scope for a later round; it leaves no
record of what it looked at; and Codex has no counterpart.

**What it covers.** The reviewed head against the reviewed base, with the scope
of the round: the whole pull request on a first round, and on a later one what
changed since the last reviewed head, the pull request's earlier security claims
and the behaviour those changes affect, or the whole pull request again
whenever the provider's review is widened to that (see
[Review rounds](#review-rounds)). The pass assesses six risk categories against
what the change actually touches:

| Category          | What it covers                                                                                                   |
| ----------------- | ---------------------------------------------------------------------------------------------------------------- |
| `permissions`     | Authorization and permission checks, privilege escalation, trust placed in something the caller controls.        |
| `secrets`         | Tokens, keys and passwords stored, logged, returned, committed, put on a command line or sent elsewhere.         |
| `isolation`       | User and tenant isolation: data access boundaries, lookups by a caller-chosen id, unscoped queries and caches.   |
| `execution`       | Command execution and injection: shell, SQL, path traversal, SSRF, deserialization, template injection.          |
| `untrusted_input` | Other unsafe use of untrusted input, including output that reaches a browser or a prompt.                        |
| `dependencies`    | Dependency and supply-chain changes: packages, lockfiles, install and build scripts, CI workflows, fetched code. |

The pull request's content is data to the pass, never instructions, and it
posts nothing: it only discovers.

**The coverage record.** "No findings" has to be told apart from "did not look".
The pass therefore writes a record, a JSON file outside the checkout, for the
head it reviewed: every category, whether the change touches it, and what was
examined and concluded, or why it does not apply; and the findings it made, each
under a category it recorded as applicable. The server reads that file once,
when the turn ends, and only if it is at most 1 MB. It completes the pass only
on a valid record: the right head, exactly one entry per category with an
assessment of at least 20 characters, at most 100 findings, each with a
category the record has as applicable, a severity and a title, every earlier
security claim it was given accounted for (below), and not a record that says
it was blocked. Every one of those rules is stated in the pass's prompt.

A record the server cannot accept gets **one correction**: one more turn of the
same conversation, in the same stage and round, that states what was wrong and
asks for the record again, not for the pass. A record that is still not
acceptable is a failed pass, and so is one the pass itself reports as blocked,
which gets no correction. There is never a second one, also not across a
restart.

When the server accepts a record it gives each finding an id (its place in the
record, from 1), keeps the coverage with the pass's stage record (`security` in
`code_review_stages`): the categories, one entry per recorded finding with its
id, and what it said of each earlier claim; and writes the record back as it
accepted it, ids included, for the publish step to read. From then on the file
is the agent's and is never read by the server again: every later step is told
of the pass from what the server recorded when it settled it, and a pass the
store could not record as completed did not complete. Zero findings never
completes anything.

**Earlier security claims.** A security fix that an earlier review required
stops being owed, like any required fix, once its GitHub thread is resolved.
For a security claim that is not the end of it, because resolving a thread is
something the pull request's author does. Before the pass starts, the server
writes the pull request's security claims that are still owed, never verified,
or resolved since a fix was required to a file, and the pass checks each against
the current code, whatever else the round covers. Its record has to account for
every one: `fixed`, with where the fix is, or `stands`, in which case it lists
the claim again as a finding. In the security result, a security fix whose
thread was resolved is settled only by a pass of the governing review that
recorded it as fixed; otherwise the result is `incomplete`
(`security_fix_unchecked`). What `addressed` means for a finding that is not a
security one is unchanged.

**Same rules as every finding.** The publish step is given the accepted record
and publishes its findings with the report's: the same summary comment (a
security finding's entry starts with **Security:**, and one line under the
counts says how many the pass found and which categories it assessed), the same
inline comments, the same reconciliation with the pull request's earlier threads
before anything is posted, the same registration. A security finding an earlier
review dismissed is therefore suppressed, not posted again, and its dismissal
stays on GitHub with its reason and in `code_review_decisions`. The verify step
rules on security findings refutation first, like the others, and the label
step is the review's last.

A review whose pass failed still publishes and verifies what the provider's
report found. What the failed pass reported is still in the conversation; the
publish step is told that it is discovery output like the rest, to be published
as ordinary findings and judged on their merits, and that nothing may be marked
as a security finding. Such a finding blocks as any finding does if it is
verified as a fix; it does not count towards the security result, which is
incomplete either way.

**The mark, and which recorded finding a registration publishes.** A finding
counts towards the security result when the server marked it (`security` on
the finding), which is not the free-text `type`. There are three ways to it:

- A registration names the finding of the record it publishes
  (`securityEntry`, that finding's id). The server checks that the review's
  pass completed on the reviewed head, that its coverage lists that id, and
  that no other finding of the review already publishes it. This is what
  accounts for the record: each recorded finding by exactly one registered
  finding, whatever its reconciliation (new, adopted, suppressed, revisit).
- A registration states `security` for a finding the record does not hold: a
  security defect the provider's report made. It needs a completed pass too,
  counts as a security finding, and stands in for none of the record's.
- A finding reconciled with an earlier claim that was a security one inherits
  the mark from the pull request's decision on it. That needs no pass, and
  again accounts for nothing the pass recorded.

Nothing can take a mark back or move a `securityEntry`, and the pull request's
decision on the claim carries the mark, so a later round still counts a
security fix that is owed.

**The security result.** Computed by the server from those records, per review
and per pull request (`SecurityReview` in the API):

| Result         | Meaning                                                                                                                                                                                                                        |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `not_required` | The policy is off and the review ran no pass.                                                                                                                                                                                  |
| `not_run`      | The policy asks for a pass and the review that governs the pull request ran without one. Never read as passed.                                                                                                                 |
| `pending`      | No review yet, one is running, or the pull request moved on from the reviewed revision (`stale`).                                                                                                                              |
| `incomplete`   | The pass failed or was interrupted, left no coverage record, the review's publication did not complete, a recorded finding was not registered, a resolved security fix was not confirmed, or a security finding is unverified. |
| `failed`       | The pass is complete and a security finding stands as a required fix, from this review or owed from an earlier round.                                                                                                          |
| `passed`       | The pass completed with its coverage on the head the pull request still has, the review published, every recorded finding is registered, and every security finding is a verified Optional or Dismissed.                       |

The evidence rule is the outcome's, applied to the marked findings and claims:
a `fix` stands, an Optional needs a recorded verification and its reason, a
Dismissed a confirmed verification and its reason, and a suppressed duplicate
rests on a decision that is itself established. Beside it:

- The review's publish step has to have completed, also for a pass that
  recorded nothing (`publication_incomplete`; `findings_unpublished` when it
  recorded findings).
- Every finding of the record has to be published by the registered finding
  that names it (`findings_missing`, with the ids and titles of the ones that
  are not). Another marked finding does not make up for it: not one that
  inherited its mark, not one the publish step marked itself, not a second
  registration of a different recorded finding.
- A security fix whose thread was resolved has to have been confirmed by the
  pass (`security_fix_unchecked`), as above.

**The policy.** `securityReview` on the project: `off`, `advisory` or
`required`, by name, `off` by default.

- `off`: no pass runs. Reviews, their prompts and the tools they are offered are
  exactly what they were, and the result reads `not_required`.
- `advisory`: every review runs the pass. Its findings are published and
  verified with the rest and the result is computed and shown. A pass that did
  not run or did not complete never holds the review outcome back: not when its
  record is refused, and not when its turn fails, in which case the pass is
  recorded as failed and the review goes on to publish the provider's report.
- `required`: also, any result other than `passed` keeps the review outcome from
  passing. It reaches the outcome as a requirement (`requirement_unmet` with
  `requirement` `security`): `changes_required` for a failed pass, `incomplete`
  for one that did not run or did not complete. The commit status of an
  enforcing project and the label step's instructions follow from the outcome,
  with no rule of their own; for a project that does not enforce the outcome,
  the label step is told directly, with the server's reasons, whenever the
  server's own reading of the pass before that step is not `passed`. A security
  turn that fails ends a required project's review there, before publication,
  as any step's failure does: the outcome cannot pass without the pass, and the
  review has to be run again either way.

Under every policy, a security finding verified as a required fix blocks the
review outcome, exactly as any required fix does. `advisory` and `required`
differ only in whether a pass that did not run or did not complete blocks: it
does under `required` and does not under `advisory`. So `advisory` makes the
pass itself optional, not its verified findings: `fix` means the pull request
must change before it merges, whichever pass found the defect, and a real issue
that should not block is ruled Optional, by the verify step or by a person.
There is a second reason, which is why the mark can only ever add to what
blocks: it is asked for by the review's own publish step, and the two reviews'
findings overlap. If a marked finding stopped blocking under `advisory`, an
agent's classification would decide which required fixes count, which is what
computing the outcome on the server exists to prevent.

Whatever the policy, some failures of the security turn end the review as they
always did, because the next turn would only meet them again: somebody stopping
or closing the session, the account's usage limit with no other account to
continue on, a provider that is gone or a CLI that cannot start.

**When the policy changes.** The pass is decided when a review's discovery
starts, so a change applies to reviews that start after it; a review in flight
finishes as it began. A review that ran without the pass is never read as
having passed it: under `advisory` or `required` its result is `not_run`, and
under `required` the outcome of an open pull request reviewed before the switch
is `incomplete` until it is reviewed again (reviewing the same revision again
uses no new round). Saving the project with another `securityReview` marks the
stored outcomes of its open pull requests as owed, and the server's sweep
computes them again and replaces their commit statuses within about a minute,
so a pull request nothing happens to does not keep a `success` the policy no
longer supports. The same now holds for the two other settings an outcome is
computed from, `enforceReviewOutcome` and `reviewRoundLimit`. Only open pull
requests are marked (when they cannot be listed, every outcome of the
repository is). As a second line, an outcome stored under another policy is
also computed again the next time the server sees its pull request, and every
API read computes with the policy as it stands. Switching to `off` stops the
result from counting and leaves what a pass found readable; verified required
fixes still block.

**Reading it.** `reviewOutcome.security` is the pull request's result, with its
reasons, the coverage, counts and the pass's stage status; each stored review
carries its own under `security`, each finding says whether it is a security
one and which recorded finding it publishes (`securityEntry`), and each
decision whether its claim is a security one. The result is also stored per
pull request (`code_review_security`), in the outcome's transaction, so it
outlives the reviews and sessions it was computed from. It adds no attention
item: a pull request it blocks already shows through its outcome.

**Migration.** `2026_11_10_150000_add_code_review_security` adds
`code_review_security`, `security_review` on `projects` (`off` for every
existing project), `security` and `security_entry` on `code_review_findings`
and `security` on `code_review_decisions` (false or null for every existing
row), and widens `detail` on `code_review_stages` from `TEXT` to `MEDIUMTEXT`,
since it now holds a whole coverage record. Nothing is back-filled: a review
stored before it has no `security` stage, so it reads `not_required` while the
policy is off and `not_run` once it is not. Existing responses and requests are
unchanged apart from the added fields.

What this does not do: the server checks that the record is complete and
well-formed, not that an assessment is right, that a claim recorded as `fixed`
really is, or that the pass read the code it says it read; it checks that every
recorded finding is published by a registration that names it, not that the
registered finding says what the recorded one said; the mark on a finding of
the provider's report is the publish step's classification, checked only for a
completed pass behind it; two findings a pass records for one defect have to
be registered as two, so a pass is told to list each defect once; the claims a
pass re-checks are the ones the stored decisions hold when it starts, which
are as current as the last review's read of the threads; after a change of
settings, GitHub keeps the old status for up to a minute, longer if the sweep
cannot reach it; a security pass is not a penetration test or a dependency
audit, and it sees only what the checkout holds; and the pass was exercised
here against stand-in provider processes, not by running a real review.

See [PR actions and QA](../README.md#pull-request-actions-and-qa) and the
[GitHub API reference](api-v1-reference.md#pull-requests-and-issues).

### Risk-based human approvals

A project can require that people approve a pull request before it counts as
ready, and how many depends on how risky the change is. The flow stays
discover, (security,) publish, verify, label: nothing is added to a review but,
on the tiers a project says so, the security pass it already knows. **Risk
changes which checks and how many approvals a pull request needs, and nothing
else. It never selects a provider, a model or an effort**: every review, and
the pass a tier makes required, runs on the runtime the project configured.

Off by default (`approvalPolicy` is null): nothing is assessed, nothing is
required, nothing is read from GitHub about a pull request's files, commits or
reviews, and reviews, their prompts and their outcome are exactly what they
were. One thing below holds for every project that publishes statuses, with a
policy or without: a commit several pull requests share carries one status for
all of them, which costs a read of GitHub before each status write.

**The policy.** `approvalPolicy` on a project (admin, `PUT
/settings/projects/{id}`) is one object, checked in full when saved:

```json
{
  "enabled": true,
  "tiers": {
    "low": { "approvals": 0 },
    "medium": { "approvals": 1 },
    "high": { "approvals": 2, "requireSecurity": true }
  },
  "rules": [
    { "pattern": "/migrations/", "tier": "high", "label": "Schema" },
    { "pattern": "*.pem", "tier": "high", "label": "Keys", "approvals": 3 },
    { "pattern": "/config/**/*.yml", "tier": "medium" }
  ],
  "thresholds": { "medium": { "files": 30 }, "high": { "files": 100, "lines": 3000 } },
  "acceptGithubApprovals": false,
  "allowSelfApproval": false,
  "securitySignalTier": null
}
```

| Field                   | Meaning                                                                                                                                                                           |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `enabled`               | Only `true` switches the policy on. A policy kept with `false` is stored and asks for nothing.                                                                                    |
| `tiers`                 | Per tier (`low`, `medium`, `high`): how many human approvals (0 to 10; 0, 1 and 2 by default) and whether the security pass is required (`requireSecurity`).                      |
| `rules`                 | Up to 50 sensitive-path rules: a glob `pattern`, the `tier` it puts a change in, an optional `label`, and optionally its own `approvals` count, which can only exceed its tier's. |
| `thresholds`            | For `medium` and `high`: a change with at least `files` changed files, or `lines` added and deleted lines, is at least that tier.                                                 |
| `acceptGithubApprovals` | Whether an approval given on GitHub can count at all. False by default: only approvals recorded through Briareus do.                                                              |
| `allowSelfApproval`     | Whether somebody who wrote the change may approve it. False by default.                                                                                                           |
| `securitySignalTier`    | The least tier of a change whose security result is not clean; null by default. See below.                                                                                        |

A higher tier cannot ask for fewer approvals, or require less, than a lower
one, so raising a tier can only add. Unknown fields are refused, not ignored: a
misspelt setting would be a requirement nobody is held to.

**The glob syntax.** A pattern is matched against a changed file's path as
GitHub reports it: relative to the repository root, `/` between segments,
case-sensitive.

- `?` is exactly one character of a segment and `*` any run of them, none
  included; neither crosses a `/`.
- `**` is a segment of its own and stands for any number of whole segments,
  none included (`a/**/b` matches `a/b`); as the last segment it stands for at
  least one, so `a/**` is everything under `a`.
- A leading `/` anchors the pattern at the repository root, and so does a `/`
  inside it. A pattern with no `/` inside (`*.pem`, `secrets/`) matches at any
  depth.
- A pattern matches the path it names and everything beneath it: `/config`
  covers `config/app.yml`. A trailing `/` says the name is a directory, so only
  what is beneath it matches.

Everything else is refused when the policy is saved, rather than matched as
something it is not: negation (`!`), character classes (`[a-z]`), braces
(`{a,b}`), escapes (`\`), a `**` glued to other characters (`**.js`), `.` and
`..` segments, and patterns over 200 characters. Matching is worked out as a
table over the pattern's and the path's segments, so no pattern can make it
backtrack.

**The assessment.** The server reads the pull request's changed files from
GitHub with its own token (`GET /pulls/{n}/files`, every page) and tries every
rule against every file, and against the path a renamed file had before: a file
moved out of a sensitive directory touches it as much as one moved in. The tier
is the highest any matched rule or size threshold names, `low` when none
applies; the approvals required are the tier's, or a matched rule's own count
when that is higher. The result is kept per pull request for the head and base
branch it was made for and the rules it was made under, with its reasons: which
rule matched which files, which threshold was reached.

Nothing an agent says is an input, so nothing an agent says can lower a tier.
The agent's own view of the risk is not recorded at all.

**When the files cannot be read.** A GitHub error, a pull request with more
files than GitHub lists (3,000), a list shorter than the pull request's own
count, a push while the pages were being read, or an assessment made under an
earlier version of the policy: the assessment is `unknown`, and an unknown
assessment is the highest tier, never a low one. It is not a dead end either.
A read that failed, came back short or was crossed by a push is made again by
the server: by its sweep, a minute later at first and doubling, up to six
attempts in a row; after that whenever the outcome is computed and the last
attempt is an hour old; and when a person is waiting on it (an approval), at
most every 15 seconds. An assessment made under earlier rules is made again
when the outcome is next computed, which saving the policy brings about. Only
the 3,000-file case stays as it is: asking again changes nothing. The files and
the commits are read apart, so that one failing does not unsay what the other
gave, and a complete assessment of a head under the same rules is never
replaced by a worse one: a later read that fails leaves it standing.

**Paths too long to match.** A changed file whose path, or whose previous path,
is over 1,024 characters or 64 segments is not held against the rules, because
matching costs the pattern's length times the path's, per rule. It is not
ignored either: the change is then the highest tier, with the file listed
(`path_unassessable`). An assessment of the files read from GitHub lets the
event loop through every few milliseconds, so a large pull request cannot stall
the server.

**Security signals.** With `securitySignalTier` set, a change whose security
result is not clean is at least that tier: a security pass that failed, is
incomplete or did not run although asked for, or security findings on the
review. It is off unless configured, because a project that runs the pass as
advisory has decided its findings inform rather than gate; a project that sets
it says a change the pass had something to say about deserves the people a
sensitive path would get. It raises the approvals needed and never lowers a
tier.

**Risk-required checks.** A tier with `requireSecurity` makes the security
pass required for the pull requests in it, whatever the project's
`securityReview` says: an `advisory` pass is held to as `required`, and a
project that otherwise runs no pass runs one. That is explicit configuration;
no tier requires anything by default. The tier has to be known before
discovery, because that is where a review's steps are chosen, so the changed
files are read as the review starts. When they cannot be read then, the tier is
unknown, which is the highest: the pass runs, and is required, if the highest
tier requires it. The outcome computes the same thing from the stored
assessment, and `security.requiredByRisk` names the tier. The pass itself is
the one described under [Security review](#security-review), on the same
provider, model and effort as the rest of the review.

**What counts as a person approving.** This is decided by the server from what
it can itself establish, and an approval it cannot attribute to a person does
not count.

- **An approval recorded through Briareus** (`POST /pulls/{n}/approvals`) is a
  human approval. It is made with a person's own client token, with a manage
  permission and the project in its scope, and is stored with who, when, an
  optional note, the GitHub account they had linked, and the exact head and
  base branch it approves. Agent sessions cannot reach it: a session's token
  opens the agent routes only, the client API does not know it, no agent or
  orchestrator tool records an approval, and the handler refuses a request
  that did not come through the gateway.
- **An approval on GitHub** counts only when the project sets
  `acceptGithubApprovals`, and only from an account nothing automated acts as.
  The server's own account never counts. Neither does an account a Briareus
  user linked: sessions run `gh` with those credentials, and a review's label
  step approves that way, so GitHub cannot say whether the person or a session
  of theirs approved. The read model says so: _"Approval by ada-dev not counted:
  the account is used by Briareus sessions, so an approval from it on GitHub may
  be automation's; its owner can record the approval through the Briareus
  API."_ A bot never counts, nor an account GitHub does not report as an owner,
  member or collaborator of the repository. An approval a review's own label
  step submitted is recorded as such when the review ends and never counts,
  whatever account it used and whether or not that account is still linked
  later (for a project that had an approval policy when the review ran). A
  person's verdict on GitHub is their latest: an approval they followed with a
  request for changes, or one that was dismissed, stops counting. While GitHub
  cannot be read, no approval given there counts.

**Whose account is whose.** GitHub accounts are told apart by GitHub's own user
id, by login only where no id is known: a renamed account is the same account,
and whoever takes its old login is not. Every account a user links is kept on
record after they unlink it (`user_github_links`): the token is theirs to
remove, what was done under it is not. So "an account a Briareus user linked"
above means ever linked (`linked_account`), and a person's own change stays
theirs.

**One person, once.** Both kinds of approval are keyed on the GitHub account,
so that one person is not counted once here and once on GitHub. A project that
accepts GitHub approvals takes an approval through the API only from somebody
with a GitHub account linked (403 `github_account_required` otherwise), and one
already on record from a user with no account on record does not count
(`no_linked_account`). An approval on GitHub from any account a user ever
linked does not count beside it (`linked_account`), nor does one from the
account an API approval was recorded with, whichever of the two is met first
(`duplicate`). What remains is a person with two real GitHub accounts, one of
which they never linked here: the server cannot know those are one person.

**Approving one's own change.** Unless the policy sets `allowSelfApproval`,
nobody's approval of a change they wrote counts (`own_change`). Who wrote a
pull request is read from GitHub for the head it is at: the account that opened
it and the accounts on its commits. An approver is tied to it when:

- one of the GitHub accounts they ever linked opened the pull request or is on
  its commits, which is also how a session of theirs commits once they linked
  one. Unlinking or renaming the account changes nothing;
- a session they own made commits of it. For a project with an approval
  policy, the server notes the checkout's `HEAD` when a turn of an owned
  session starts and again when it ends, and records the commits that came in
  between as that user's (`code_review_commit_owners`), conservatively and
  independent of their commit dates or reflog messages. Only commits in GitHub's
  PR commit list can tie that user to its approvals, so merged base-only commits
  do not count. That holds whatever the session was started for (a review session
  told to commit is a session that committed), wherever it goes afterwards, and
  after it is deleted. Workers an orchestrator starts
  belong to the orchestrator's owner. For work from before commits were
  recorded, the session whose own branch became the pull request ties its
  owner when an approval is recorded, while the server still has that session.

So an approver needs a GitHub account linked (403 `github_account_required`):
without one nothing on GitHub could be tied to them, and removing the account
would remove the rule. The tie is not only checked when an approval is
recorded: it is judged again every time the requirement is computed, against
every account the approver ever linked and the commits their sessions made, so
a commit a session makes later, or an account that turns out to be on the
commits, stops an approval counting.

While who wrote the pull request is not known, no approval of it counts
(`authorship_unknown`), from the API or from GitHub. That is so when the
commits could not be read from GitHub: recording an approval then answers 503
`authorship_unknown` with `retryAfter`, and means it, since the commits are
read again when the approval is next asked for, at most every 15 seconds. And
it is so when the pull request has more commits than the 250 GitHub lists,
since who wrote the rest cannot be known: recording answers 409
`authorship_incomplete`, and the way out is a smaller pull request or
`allowSelfApproval`. Asking for a review, a QA run or a preview is not writing
the change: somebody who asked for the review may approve it, and so may the
person whose account the review's label step posted as, because the
independence that matters is between who wrote the change and who approves it.

What the server cannot see, it does not claim to enforce: commits pushed under
a GitHub account never linked here, and commits sessions made before the
project had an approval policy, once those sessions are gone. A commit a
session's checkout merely fetched is not counted as its own; one that somebody
else pushed while the session's turn ran, and that the session pulled, is. On a
server only one person uses, the requirement cannot be met without
`allowSelfApproval`.

**Bound to the revision.** An approval is for one head against one base
branch, and it has to name that head: `headSha` must be the pull request's head
as GitHub has it when the approval is recorded, or the request is refused with
the current head. It is also for a _reviewed_ revision: it is refused until a
code review covers that head and has ended. From then on:

| What happens                                      | The approval                                               |
| ------------------------------------------------- | ---------------------------------------------------------- |
| A new commit is pushed                            | stops counting (`head_moved`)                              |
| The pull request is retargeted to another branch  | stops counting (`base_changed`), on the same head too      |
| The base branch gains commits under the same head | still counts, as the review outcome stays current          |
| Its approver withdraws it                         | stops counting (`withdrawn`), with when and why            |
| Its approver is disabled or loses the project     | stops counting (`approver_disabled`, `approver_no_access`) |
| Its approver turns out to have written the change | stops counting (`own_change`), unless the policy allows it |

An approval that stops counting stays on record, listed with its reason.
Withdrawing (`POST /pulls/{n}/approvals/{id}/withdraw`) is the approver's own
to do, and nobody else's.

**The requirement and its status.** The result is `not_required` (no policy,
or the tier asks for no approval), `pending` or `satisfied`. `satisfied` needs
enough approvals that count for the head and base branch the pull request has
now, each person once, _and_ a review of that revision that has ended:
approvals of a revision nobody finished reviewing make nothing ready, a review
that is still running has concluded nothing (`review_running`), and when the
review turns stale so does the readiness.

It is a result of its own, beside the review outcome and never inside it. "The
review passed" is what the server concluded from the review's evidence; "the
required people approved" is what persons did afterwards. A missing approval is
not a finding and not a change to make: it never turns the outcome into
`changes_required` or into anything else, and the review's label step, which
runs before anybody could have approved, is not held to it. So the two are two
commit statuses, and a repository requires either or both in its branch
protection:

| Status context         | Says                                                  | States                                   |
| ---------------------- | ----------------------------------------------------- | ---------------------------------------- |
| `briareus/code-review` | what the review amounts to ([above](#review-outcome)) | `pending`, `success`, `failure`, `error` |
| `briareus/approvals`   | whether the required people approved this revision    | `pending`, `success`                     |

`briareus/approvals` is written for a project with `enforceReviewOutcome`, by
the same publication as the outcome's status and with the same guarantees: on
the head it is for, as the server, recorded as unconfirmed from the moment a
write is sent until GitHub answers, read back before a status is taken as
carried, owed on its own record in the outcome's transaction, and retried by
the sweep after a failure, so a write that failed or was lost cannot leave a
`success` standing for something that is not. It is `success` only for a
revision a review has ended on, whatever the tier asks: a change that needs no
approval still has no `success` before it was reviewed. A head nobody has
computed carries no status, which a required check reads as not met. In the
API, `reviewOutcome.outcome` is the review, `reviewOutcome.approvals` the
people, and `reviewOutcome.ready` both.

**A commit several pull requests share.** A commit status belongs to the
commit, not to a pull request. Two open pull requests with the same head (the
same branch against two bases, say) read the same statuses, so a `success`
written for one would let the other merge: a trivial second pull request could
clear a high-risk first one. Both statuses are therefore written for the
commit. Before every write the server asks GitHub which open pull requests
have that head, and gives the commit the most restrictive status among them:
any that does not pass over one that does, and once more than one shares the
commit, worded as the pull request it is of, `PR #40: 0 of 2 human approvals at
3f2c1ab (high risk)`. A pull request at that commit the server holds no status
for counts as not passed. When GitHub cannot say which pull requests are there,
a status that does not pass is written as it is and a `success` is not written
at all: the publication fails like any write and is tried again. Every pull
request at the commit works out the same status, so they do not overwrite one
another; when one of them changes, comes to the commit, leaves it or closes,
the others look at the commit again within about a minute. In the API each
pull request keeps its own status (`status.state`), and
`status.publishedDescription` says whose the commit shows. This holds for
`briareus/code-review` as for `briareus/approvals`, and usually costs one more
read of GitHub per status write. If the commit lookup omits the current pull
request (as it does for heads already on the default branch), the server scans
open pull requests instead, up to 3,000; an incomplete or failed scan withholds
`success` too.

The requirement explains itself in plain words (`approvals.explanation`, and
`approvals.reasons` for machines): _"This change is high risk, which asks for 2
human approvals of 3f2c1ab against main. 1 approval counts (Ada); 1 more is
needed."_, with the rules that matched and their files under `approvals.risk`,
and every approval on record with whether it counts and why not.

**When it is computed again.** With the outcome, always, and so whenever the
outcome is: a review starts or ends, a verdict changes. And besides: when an
approval is recorded or withdrawn (at once, in the request); when the server
sees the pull request at another head or base branch (a webhook, a session's
sync, the babysitter); when a review is submitted or dismissed on GitHub, for a
project that accepts those (a webhook); when the policy is saved with a change
(the open pull requests' outcomes are marked owed and the sweep computes them
within about a minute); and when a read of the revision that failed is due
again. Two reads of a pull request's reviews can finish in either order: how a
review stands on GitHub is taken only from a read that started no earlier than
the one already stored, so a slower, older read cannot turn a superseded
approval back into a standing one.

**Waiting on people.** A pull request whose review passed for the revision it
is at, and whose approvals are missing, is listed in `GET /attention` as a
`review-approval` item for whoever may see the project, dated from when it
began to wait (`approvals.waitingSince`). It leaves the list when it closes or
merges, and when its project drops the policy: its mark is taken off then, so
that closed pull requests cannot fill the list ahead of the ones that wait.

**API.** `GET /pulls/{n}/approvals` reads the requirement; `POST
/pulls/{n}/approvals` records the caller's approval of `headSha`; `POST
/pulls/{n}/approvals/{id}/withdraw` withdraws it. `reviewOutcome` on the
code-review reads carries `approvals` and `ready`.

**Migration.** `2026_11_10_160000_add_code_review_approvals` adds
`projects.approval_policy` (null for every existing project) and five tables:
`code_review_risk` (what the server read about the revision),
`code_review_approvals` (every approval, kept as history),
`code_review_readiness` (the requirement as last computed, with the publication
of its status), `code_review_commit_owners` (whose session made which commit)
and `user_github_links` (every GitHub account a user linked). The accounts
linked when the server starts are entered in the last one then; nothing else is
back-filled, and nothing changes for a project that does not set a policy:
none of the review tables gets a row for it. Rolling back drops the tables and
the column and leaves every earlier record as it was.

What this does not do. The server cannot tell who holds a client: a script
given a person's token approves as that person, which is why an approval has to
name the head and why tokens are issued from the machine, not through the API.
An agent with a shell on the server's own machine is inside that boundary, as
it is for SSH approvals. An approval on GitHub from an account no Briareus user
ever linked is taken for a person's when the project accepts those; whether a
person or their own tooling used that account is not something the server can
see, nor that it belongs to somebody who also approved through the API under
another account. GitHub reports org membership, not write access, as `MEMBER`,
and outside collaborators at any access level, read and triage included, as
`COLLABORATOR`: these reviewers count only after the server verifies their
repository push permission; a failed permission read counts no GitHub approvals
until retried, and so does a refresh whose pull request read failed, since the
reviews were then not read again.
A GitHub approval is bound to the base branch the pull request had when the
server first saw the approval, not when it was submitted.
An approver who loses access stops counting in the API at once and on GitHub at
the next computation. The published status follows a change within about a
minute, longer if the sweep cannot reach GitHub; a second pull request opened
at a commit is noticed when its webhook arrives or the first one's status is
next written. And approvals, shared commits and statuses on real GitHub pull
requests were exercised here against a stand-in for GitHub's API, not against
GitHub.

### Review benchmark and quality

Two ways to see how well the code review does its job, both in the core and its
API. Neither touches production incidents: no incident is read, counted or
turned into a case.

**The benchmark** measures the review against answers people settled
beforehand. It lives in a project set aside for it (`reviewBenchmark` on the
project, admin, `PUT /settings/projects/{id}`; off for every project), whose
repository holds the curated changes. A run opens pull requests and branches
there and closes them again, so it is refused on any other project.

- **A case** (`POST /review-benchmarks/cases`) is a change, two commits of that
  repository (`baseSha`, `headSha`), what the reviewer is shown of it (`title`,
  `description`) and its answer: `kind` (`defective` or `clean`), the `defects`
  (file, lines, severity, summary) and a `referenceFix`. `origin` is
  `constructed` (built for the benchmark) or `historical` (taken from a past
  change); there is no incident origin. The answer stays in Briareus's
  database: a run opens the pull request from the title, the description and the
  two commits alone, the answer is never written to a workspace or a prompt, and
  no agent session can reach these routes. A title or description that quotes a
  defect's summary or the reference fix is refused. The rest is the curator's to
  keep out of the repository: commit the case's commits under neutral branch
  names and messages, and never commit the reference fix or the answer, since
  the reviewer reads the repository.
- **Adjudication.** A case is run only once somebody other than its author
  agreed with its answer (`POST /review-benchmarks/cases/{id}/adjudications`,
  `agree` or `disagree`), and while nobody disagrees: `standing.status`
  `adjudicated`. An adjudication is of the case's `answerHash`, the fingerprint
  of the change and the answer, so editing the case (`PUT`) leaves the earlier
  verdicts about another answer, makes the editor its author, and the case is a
  `draft` again. Cases are retired, never deleted.
- **A run** (`POST /review-benchmarks/runs`) takes every adjudicated case, or
  the ones named, and puts each through the real review, a few at once
  (`concurrency`, 1 to 5): two branches at its commits under neutral names
  (`review/<random>`), a pull request between them, and a code review started as
  the run's requester's own, exactly as `POST /actions` would, on the project's
  configured review runtime, with discovery, publication, verification and the
  label step as for any pull request. When the review ends, what it left (its
  status, findings and verdicts, its outcome, its cost) is kept with the result,
  the pull request is closed and the branches deleted. Each step is recorded
  before the next, so a run the server picks up after a restart neither opens a
  second pull request nor starts a second review; a review that has not ended
  within six hours is given up on. A run records the runtime it started under
  and the review configuration (the server's commit, null when it cannot be
  read, as in the container image, which has no `.git`; `securityReview`,
  `enforceReviewOutcome`, `reviewRoundLimit`, fingerprints of the approval
  policy and the label template). To evaluate a
  prompt, tool or runtime change, run once before it and once after: a run takes
  no runtime of its own, so the comparison is of the project's settings as they
  are, not of a silent switch.
- **Scoring** holds each review against the answer as it was when the run
  started. A review that did not end, or ended without completing what it owed
  (outcome `pending` or `incomplete`), is no result, never a pass. A finding is
  tied to a defect by a person's judgment, else by its location (the same file,
  within 3 lines), which stays `provisional` until somebody judges it
  (`PUT …/judgments/{findingId}`: `matches` a defect, `false_positive`,
  or `valid_unlisted`, a real problem the answer misses; with `harmfulFix` when
  the fix it suggests would do harm). A defect is `caught` when the finding
  that stands for it (one a person matched to it, if any, before a location
  match; then the strongest verdict) was ruled a required fix,
  `caught_nonblocking` when only Optional, `dismissed` when verification
  refuted it, else `missed`; a required fix that
  matches no defect is a false positive, and a second finding about a defect a
  duplicate. The summary gives recall (blocking, and with any verdict), blocking
  precision, false positives, harmful fixes, duplicates, outcomes against the
  expected ones (`changes_required` for a defective case, `passed` for a clean
  one), cost with whether it is estimated and how many turns had no price, and
  its caveats. An empty report on a defective change is every defect missed; the
  number of findings is never a score.
- **Comparing** (`GET /review-benchmarks/compare?a=&b=`) puts two runs side by
  side on the cases both ran against the same answer, with the defects each
  caught that the other did not. It calls two runs alike only when both
  recorded the server's commit.

**Review quality** (`GET /review-quality?repo=&days=`) describes a project's
reviews over a window from what the server already keeps, and is not a verdict
on whether they were right: the claims and how they were ruled, telling
verdicts people gave (through the API or on GitHub) from those review sessions
gave; pull requests by the rounds they took and the rounds continued past the
limit; findings by how they related to earlier threads (`suppressed` and
`adopted` are repeats caught); cost per runtime, with its estimation and
unpriced caveats; and how long reviews waited on people: a verdict from when
its claim was stored, a revision's first human approval from when its review
ended, a continued round from when the round before it ended, and what waits at
the limit or for approval now.

**Migration.** `2026_11_12_130000_add_review_benchmarks` adds
`projects.review_benchmark` (off for every existing project) and five tables:
`review_benchmark_cases`, `review_benchmark_adjudications`,
`review_benchmark_runs`, `review_benchmark_results` (with the answer and the
review kept as they were) and `review_benchmark_judgments`. Nothing is
back-filled; rolling back drops them and the column. Review quality needs no
schema of its own.

What this does not do. The benchmark is as good as its cases: Briareus ships
none, and adjudication says that a second person agreed, not that the answer is
right. A location match says where a finding is, not what it says, which is
why it stays provisional. Reviews vary from run to run, so a difference between
two runs of the same configuration is noise. And the runner was exercised here
against a stand-in for GitHub's API, not against GitHub.

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
- Code reviews of one pull request are bounded by a per-project round limit
  (`reviewRoundLimit`, 3 by default); later rounds review what changed, and a
  person continues past the limit explicitly.
- A pull request's review outcome (pending, incomplete, changes required or
  passed) is computed by the server from recorded stages, findings and
  evidence, apart from whether the session finished; a project can publish it
  as the `briareus/code-review` commit status (`enforceReviewOutcome`).
- A project can keep its code reviews off GitHub (`postReviewToGithub` off):
  the same review runs and its findings and verdicts stay on the server.
- A project can have every code review run a security pass (`securityReview`:
  off, advisory or required): a second discovery whose findings are published
  and verified with the rest, with a separately tracked security result and a
  coverage record of the risk categories it assessed.
- A project can require human approvals by risk (`approvalPolicy`): the server
  assesses each reviewed pull request from its changed files and the project's
  sensitive-path rules, requires as many approvals as the tier asks for, counts
  only approvals it can attribute to a person for the exact reviewed revision,
  and publishes the result as the `briareus/approvals` commit status, apart
  from the review outcome. A tier can make the security pass required.

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
