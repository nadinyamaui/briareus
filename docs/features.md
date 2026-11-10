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
using the project's action runtime and respecting author filters and retry limits. Reviews of one pull
request are bounded by the project's `reviewRoundLimit` (see [Review rounds](#review-rounds)).

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

**Who asked.** The PR babysitter and an orchestrator's `start_pr_action` are
automation; a review started through `POST /api/v1/actions` is a person's
request. Every round counts, whoever asked. The difference is in what each may
do at the limit and with a head that was already reviewed:

| Request                         | Babysitter, orchestrator     | Person (`POST /actions`)        |
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

- The babysitter is refused before any session starts. It remembers the answer
  for that head and that limit, so it asks once per push, not every 15 minutes,
  and asks again when the project's limit changes. Conflict and CI errands on
  the same pull request carry on.
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
  repository's own rule.
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
webhook, in a session's sync of its pull request, or in the babysitter's pass
over the board. That last one is what makes a retarget count, which moves no
commit: a pull request reviewed against `main` and retargeted to `release`
keeps its head, and the `success` on it, until the outcome is computed again
and `pending` is posted on that same commit. Nothing polls for it; a
repository with no webhook, no session on the pull request and no babysitter
is seen at its next review.

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
  no longer enforces, and a failing status of a pull request that has closed
  (the first attempt is always made). A status GitHub answers 422 to, because
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

Turning `enforceReviewOutcome` on publishes nothing retroactively: a pull
request gets its status the next time its outcome is computed (a review, a
changed verdict, a refusal at the limit, a push or retarget the server sees),
and until then carries none, which a required check reads as not met. Turning it off stops the updates and leaves
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
session or the babysitter; a review whose session vanished without being
settled stays `running` and so `pending`; the pull request board still
recommends actions from labels alone; and the server cannot judge the quality
of evidence, only that it was recorded. The status write and read-back, the
dismissal of an approval and the behaviour of a required check were exercised
against stand-ins, not against GitHub itself.

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
- Code reviews of one pull request are bounded by a per-project round limit
  (`reviewRoundLimit`, 3 by default); later rounds review what changed, and a
  person continues past the limit explicitly.
- A pull request's review outcome (pending, incomplete, changes required or
  passed) is computed by the server from recorded stages, findings and
  evidence, apart from whether the session finished; a project can publish it
  as the `briareus/code-review` commit status (`enforceReviewOutcome`).

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
