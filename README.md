# Briareus

The core of a system for running coding agents against a project: a server
with no UI of its own, driven by clients through one API, [`/api/v1`](#client-api).
Each session is a conversation with one agent, **Claude Code**, **Codex**,
**Grok**, **opencode** or **Z.AI** (GLM through the codex CLI), inside a workspace clone of
its own, with a database server of its
own, so parallel sessions never share a working tree or a database. You
describe what to build; the agent edits, runs the app and its tests, and can
push a feature branch / open a PR when asked.

> **Briareus is now a core app: you need a client to use it.** The built-in
> dashboard and everything else that ran in a browser have been removed, so
> opening the server in a browser shows nothing. The clients, **Briareus
> Windows** and **Briareus iOS**, live in repositories of their own and talk to
> this server through [`/api/v1`](#client-api) with a token from
> `npm run create-token`. Where this README names a chip, a button or a screen,
> it is describing what a client offers on top of the API.

> **This app runs shell commands as you.** A session edits files, runs the
> project's setup and run commands, and pushes to GitHub with the credentials
> the machine already has, so a client holding an admin token can do all of
> that. The server listens on `127.0.0.1` only, and the API answers nothing
> until `npm run create-token` has set its signing secret (the boot log says
> `api: OFF` until then). Before you put a hostname in front of it, read
> [Reaching it from anywhere](#reaching-it-from-anywhere) and
> [SECURITY.md](SECURITY.md).

## WhatsApp inbox

The core’s operator inbox can read and reply to WhatsApp through a locally
installed WAHA service, independently of coding sessions. Run
`npm run install:waha` on the core machine, set the printed `WAHA_CONFIG_FILE`
path, and restart the core after deploying the integration. Account linking,
chat history, text replies, read receipts and attachment downloads are exposed
through admin-only `/api/v1/whatsapp` endpoints for clients to use; client inbox
screens are separate work. See [WhatsApp setup and client flow](docs/whatsapp.md).

## How a session runs

1. **Claim resources.** The session takes an idle workspace clone from the
   pool (`<owner>__<repo>`, then `…__2`, `…__3` as concurrency demands) and,
   if its project asks for one, claims one of the configured database servers,
   exclusively for as long as it stays open. The project's
   database is created on the claimed server if it does not exist yet. A
   session that already knows its branch prefers the idle slot that is still
   on that branch: the one whose dependencies, build output and framework
   caches are already the right ones. Idle slots are quarantined when Briareus
   starts and once every 24 hours; slots claimed by open or recoverable sessions
   are skipped. Whole checkouts move into `WORKSPACE_DIR/.briareus-recovery/`
   without deleting files, so Docker-owned artifacts cannot cause partial
   cleanup or destroy Git history. Logs name each preserved checkout; recover
   any unpushed work before manually removing it. Quarantine stops at 100
   preserved checkouts and reports an actionable error rather than deleting
   old backups. New sessions skip slots missing `.git`; reopening such a slot
   still requires inspection.
   The pool itself is listed at `GET /api/v1/settings/workspaces`: every slot's
   branch, HEAD, dirty state, size, dependency trees and which open session
   holds it, with two actions for idle slots: _Reset setup_ forgets the
   install fingerprints, _Clean_ also removes `vendor/` and `node_modules/`.
2. **Say it started** (code reviews only). As soon as the clone is claimed
   (before the minutes the checkout takes) the session comments on the pull
   request being reviewed: which agent is reviewing which branch, and that the
   findings land there when it is done. It is one anchored comment per PR
   (`<!-- reviewer:review-started -->`), so a project reviewing every push edits
   the notice already there instead of stacking one per push. Best effort: no
   token, no PR number or a GitHub that will not answer leaves a line in the
   session's log and the review runs anyway.
3. **Prepare the checkout.** The repo's default branch is fetched and checked
   out onto a session branch (`dev-<id>`), the project's `.env` template is
   written in, and its setup commands (composer/yarn installs, builds) are run.
   `vendor/` and `node_modules/` survive between sessions, so only the first
   run on a fresh clone pays the full cost. Beyond that, a dependency install
   (`composer install`, `yarn`/`npm`/`pnpm install`) is skipped outright when
   its manifests are byte-for-byte what they were the last time it succeeded in
   that slot and what it installs is still on disk; the fingerprints live in
   the clone's `.git/reviewer-setup.json`. Builds and anything touching the
   database run every time.
4. **Chat.** Every message spawns one headless provider run that resumes the
   provider's own session state. Output streams to the client live (SSE). The
   session keeps its clone and database server between turns, for as long as
   it stays open. On a Claude session, a message starting with `/btw` (or
   `POST /api/v1/sessions/{id}/btw`) is a side question instead: it is
   answered from a fork of the conversation that is never saved, without
   tools, even while a turn runs, and neither it nor its answer reaches the
   agent. Both show in the transcript as `btw` / `btw_answer` lines.
5. **▶ Run** serves the session's checkout with the project's run commands
   against the session's own database, on an app port of its own (one per
   pool entry: 8101, 8102, …).
6. If the session's branch gets a PR on GitHub, its state and CI checks are
   mirrored into the header and the right panel, synced at the end of every
   turn, every 20s while a turn is running, and once a minute otherwise. The
   panel redraws from a pushed session record, so it never waits for a poll.
   **🔗 Link PR** recovers one automatic discovery missed: enter its number or
   URL, and the server verifies that its repository and head branch match
   the session before attaching it.
7. **Close** releases the clone slot and the database server; the conversation
   stays readable. **Delete** also trashes the record and its log.
8. The **✎** beside a conversation's heading edits its title without sending a
   message to the agent.

### Who the board is about

⌕ Code review is always somebody pressing a button, on this app's board or in a
session composer. Nothing on GitHub starts a session by itself: no push, no
label and no webhook delivery ever opens one.

What a project configures (`/api/v1/settings/projects`) is who its board is about and
what its errands run on: a **PR author** (a GitHub username, the filter the
pull request board applies) plus the provider, model and effort a review opens
on unless the composer picks another. A review session started from a pull
request row closes itself once the findings are posted, so it hands its
workspace clone and its database server straight back, and its record goes
with them, rather than leaving one dead conversation per review in the sidebar.
What the review found is on the pull request, which is where it gets read and
answered. A review that stopped to ask something is the exception: it stays open
until somebody answers it.

Clicking a project in the sidebar opens its own view, with three tabs: **📊
Dashboard** (what it spent this month), **⇅ Pull requests** (the board) and **⊙
Issues**, which lists the repository's open issues with who reported them, who
holds them, their labels and the open pull requests that say they close them.
The issues ride on the board's own query rather than a request of their own, and
each row carries a **▶ Start** button: it opens a session that reads the issue,
implements it on a branch of its own and opens a pull request closing it.

A project can also name a GitHub Projects v2 board in its settings
(`projectBoard`: the organization or user that owns it, the project's number, and
optionally a view). Clients draw it as a tab after the issues, from
`GET /api/v1/project-board`: the view's filter applied by GitHub, the cards in
columns by the view's group-by field (Status by default), each column with its
count and its Story Points (every number field) totalled. It needs Projects: read
on the token (see below); with Projects: write a client can also move a card to
another column (`POST /api/v1/project-board/move`).

Epics are GitHub's own sub-issues, not a label or a title prefix: a sub-issue is
drawn nested under its parent, an epic says how many of its children are done
(counting the closed ones and any the tab never listed) and folds them away,
and starting an epic starts one session on its open sub-issues rather than on
the epic itself.

Each fix commit ends with a `[reviewer-fix]` line so the server can tell a
push it made from one a human made.

### The review loop

The composer's 🔁 chip arms a **review loop** on the next from-scratch session,
and 🛠 Implement feedback, started from the board, arms the same loop so the
fixes it pushes get reviewed. A review, a QA run, any other board errand or a
local session is never a loop. An armed session works its task as usual; every
time it settles idle with new commits on its open pull request, the app starts
a review session for it (the same auto-closing kind the board starts, on the
session's own provider, model and effort — a loop's sessions run where the
session they work for runs, so a worker moved onto another provider takes its
reviews with it), and when that review closes, whatever
findings it declared wait on the **⚑ Findings** screen (the flag beside 📊 in
the sidebar header, one card per round across every project) until you mark
each one _fix_, _optional_ or _dismissed_ and send the round. What you marked
fix is handed to a **fix session** of its own (the same auto-closing
implement-feedback errand the board starts, on the session's branch and
provider), whose pushes, once it closes, trigger the next review.
The session itself is the durable half: it is the loop's anchor, it keeps its
clone, its database server and its conversation, and you can keep chatting in
it undisturbed while the reviews and the fix sessions come and go around it.

Nothing a review found is fixed until you say so. Each card on ⚑ Findings
shows the round's findings with the loop's own advice on each (what the rules
below would have parked, and why); mark what the fix session should implement
and press **Send**. Anything left unmarked stays on the pull request as
_optional_. Sending records every verdict: what you marked fix goes on the
pull request's **Required fixes** checklist and to the fix session, which
ticks the ones it actually fixed, replies on the threads it addressed and
resolves them; _dismissed_ and _optional_ are recorded like verdicts given by
hand in the findings panel and said on the pull request with the reason, so
no later round offers them again. A round with nothing marked fix converges
the loop, adds the pull request's `code-approved` label and removes its
`feedback-given` label. A standalone review sent with nothing marked fix makes
the same label transition as it closes its findings card. The loop holds until
you send (the session shows _findings waiting
in ⚑ Findings_), across restarts too.

A worker's loop stops there just the same: its orchestrator is told the round
is waiting for you and that the task is not done, and it does not rule on the
round itself unless you ask it to (`triage_findings` is there for that).

A round that could not run at all — its provider exited non-zero or was out of
quota, automatic recovery after a server restart failed, or its
review closed having published nothing — is not a review that found nothing:
the loop records the round as failed and approves nothing.
Turning the 🔁 chip off and on again re-runs it, and an orchestrator retries its
worker's round with `retry_review`, naming another provider or model when the
one it ran on is the problem (the loop keeps that runtime for its later rounds).
For an interrupted worker, that tool reopens the session and queues the review
without spending a chat turn.
That matters because the loop otherwise waits for the next push, which a worker
whose work is finished has none left to make.

The loop runs until it converges: it stops on its own when a review declares no
findings, and the 🔁 chip stops it whenever you decide the rounds are no longer
paying for themselves. Three gates keep it from reviewing the code its own fixes
introduced, which is the runaway a stall gate cannot see (every round finds
something genuine and something new, so it neither runs dry nor repeats itself):

- **A round cap**, `REVIEW_LOOP_MAX_ROUNDS`, 10 by default. The last round still
  reviews and still lists what it found; it just does not start the fix session
  that would open the next round. `0` removes the cap.
- **A severity floor that tightens by round.** From the round after
  `REVIEW_LOOP_LOW_UNTIL_ROUND` (1 by default), a low is recorded rather than
  implemented: a low found late is nearly always a note on the previous round's
  fix rather than on the change under review. `0` never tightens.
- **Findings about files the pull request does not change are parked.** A review
  reading the whole repository occasionally reports something real about code
  the branch never touched. This fails open when the diff cannot be listed:
  withholding a real finding is the worse half of that trade.

A finding held back by either of the last two is recorded as **optional**, so it
stays in the findings panel and in the review's own comment on the pull request,
stays off the required-fixes checklist, and is not offered again next round. A
verdict you gave by hand wins over all of it: a dismissed finding never comes
back, and one you marked _fix_ is kept however low it is or wherever it points.

Then there is the **stall gate**. A
round that hands back exactly the findings the round before it did means the
fix session between them did not move the review, and implementing them again
would push another commit, open the commit gate and start the same round over,
so the loop stops there and says so instead of ping-ponging on a session
nobody is watching. What it found stays on the pull request, and the next
push you make yourself picks the loop back up.

Between rounds a commit gate keeps a session with nothing new pushed from
being reviewed again, so chatting never re-triggers a review, and a failed or
stopped review pauses the loop until the next push instead of retrying itself
in a circle. The button-press rule above still holds: nothing on GitHub starts
any of it: the one trigger is the session's own turn ending, on a loop its
user armed.

The composer's 🎬 chip queues a **QA loop** behind an armed review loop. It is
one run, not another series of rounds: when the review loop converges by
declaring no findings, the app starts the same kind of auto-closing QA session
the board's 🎬 button starts. That session's first turn writes the test sheet;
as soon as that turn settles, its second turn executes the sheet and records
the evidence. If every executed scenario passes, the QA loop stops. Failed
scenarios are reported back to the task session as QA feedback, and the loop
stops there too, since acting on that feedback stays a human decision for now.
Turning the review loop off also cancels the QA run waiting behind it.
An orchestrator can toggle QA on its own open task workers independently with
`set_worker_qa_loop({ id, on })`, or `POST /api/agent/sessions/:id/qa-loop`
with `{ "on": false }` using its session bearer token; `on` must be a boolean.
This preserves reviews, findings, fixes and CI and follows the existing QA
eligibility rules (arming requires an armed review loop).
Disarming removes queued QA; an active QA session finishes on its own and
reports nothing back. The response includes `session`, `qaStillRunning` and
`qaSessionId` so an active run is not mistaken for a cancelled one.
If the QA provider fails or its session is interrupted, the run is shown as
failed/interrupted and **not running**, never as queued. For an orchestrated
worker, `send_to_worker` with a follow-up retries QA after that worker turn
settles; no QA result is approved until a replacement run reaches a verdict.

Arming is not only a decision for the composer: the same 🔁 chip stays live
over an open session and turns its loop on or off there and then, which is
usually when you know you want it: the task turned out bigger than it looked,
or the pull request is up and there is no reason to press ⌕ by hand every
push. Arming mid-session reviews what is already pushed rather than waiting
for the next push. Turning it off stops any further rounds; a review already
running still finishes and publishes on the pull request, it just reports
nothing back. Re-arming starts the round count over, except that a review
still running from the arm you turned off is adopted as the new loop's first
round, rather than a second review of the same pull request being started
alongside it.

A session finds its pull request by itself. Being handed a branch that already
has one open is the normal way to continue somebody's work, and an agent
typically reports back "pushed to `dev-x` (PR #51)": a number, never the URL
the app watches the stream for. So a session on a branch of its own asks GitHub
which pull request is open from exactly that branch: when its workspace is
prepared, before any review round it would otherwise skip for want of one, and
on the sync tick while it has none, the last of those on a few minutes'
cooldown, since a session can work for an hour before it opens anything and the
token is shared with the board and the webhooks.

Nothing is guessed. The match is on the head ref, never on a local session or
the repository's default branch (where a branch is nobody's in particular), and
when a branch has several pull requests open at once (GitHub allows that when
their bases differ), only the one that targets the branch the workspace was cut
from is taken. Anything still ambiguous is left unattached, with a line in the
session saying which pull requests it could not tell apart.

A pull request found this way is a weaker claim than one somebody handed the
session, in one place: merging it does not close the session. An errand pointed
at a pull request (a review, a QA run) still ends the moment it merges, but a
session opened to keep iterating on a branch is told and left alone rather than
stopped mid-work by a teammate's merge.

### QA, once the code is approved

QA is not part of the review, and it is not started by the `code-approved`
label either: the board shows a 🎬 QA button on an approved pull request and
somebody presses it. It runs in a **session of its own**: a review session would
otherwise have to sit on its clone and its database server for however long the
sign-off took.

Switch **Write a test sheet** on for a project and that session's first turn
derives the manual test sheet from the diff and posts it as one editable
comment; with **Execute the test sheet** on, a second turn serves the app
against the session's own database, drives every ⬜ scenario with Playwright,
records a video of each and writes the results back into the sheet. Nothing
follows the run: the ❌ rows are there to be read, and ⚙ Implement feedback is
the errand that acts on them.

### The shared browser

A session can be given a headless Chromium of its own that its agent and its
user drive together, on the same tabs. `POST /api/v1/sessions/{id}/browser`
starts it; from the next turn the agent drives it (Claude and Codex through the
Playwright MCP server mounted as `browser`, Grok and opencode through
Playwright's `connectOverCDP`), and a client watches it as a stream of JPEG
frames and clicks, types and navigates in it through the API. So a client can
follow the agent through a flow, log in for it, or do a step by hand and tell it
to carry on from there. The browser outlives every turn and the profile
outlives a close, so a login stays logged in until the session is deleted.
[docs/api-v1.md](docs/api-v1.md#the-shared-browser) has the routes.

Chromium is found by itself when Playwright has downloaded one (any QA run
does) or one is on PATH; `BROWSER_BIN` overrides it.

### What a session costs

Every finished turn is written to a project-owned `turn_usage` ledger (agent
time, tokens in and out, and the provider's own cost figure when its CLI
reports one: claude and opencode do, codex does not, and the ledger stores no
number nobody charged). The ledger is independent of the session record, so deleting a session
removes its transcript but keeps its statistics. The session header shows the
session's tokens and cost as a chip, each turn's footer in the transcript shows
its own, and a project's board header shows the calendar month so far:
sessions, agent time, tokens and priced cost
(`GET /api/v1/usage?repo=owner/name` returns the same numbers).

The 📊 button beside **＋ New session** opens the same ledger with no project
filter: headline tiles, tokens over time, a row per project and a breakdown per
model, over this month, last month or all time (a month charts a bar per
calendar day, all time a bar per month). Projects switched off since are still
listed: one disabled mid-month spent what it spent, and leaving it out would
stop the rows adding up to the totals. A cost wears a `+` when some of the turns
behind it were never priced, so an unpriced turn never reads as a free one.
`GET /api/v1/usage/all?period=month|prev|all` returns it as JSON.

The server puts a figure on the turns their CLI never priced: their tokens at
the model's published list price, from the [models.dev](https://models.dev)
catalog (fetched once a day and cached; an install with no reach keeps whatever
copy it has, or shows those turns as unpriced). Those costs are shown as one
price with the reported ones, in the session header, turn footer, tiles and
tooltips alike. They are arithmetic over tokens, not an invoice: what the ledger
stores is still only what the providers themselves reported.

### Claude account failover

Sessions start on the interchangeable account with the most available quota.
When a Claude subscription account reaches its usage limit, Briareus resumes
the saved conversation on the least-used eligible account in the same provider
group, keeping the workspace, model, and pending requests. The transcript says
which account took over. Each account is tried at most once per turn; if none
has quota, the turn stops and can be retried after an account resets. Tool
errors, authentication failures, and temporary API errors do not switch accounts.

### Merged pull requests

A merge ends every errand on a pull request. As soon as any session mirroring it
sees `merged`, every open session working on that pull request (review, errand,
QA) is closed: its turn is killed and its clone and database server go back to the
pool. The conversations stay readable, as they do after any close.

### Local mode

The composer's workspace chip switches a session from **⌗ Worktree** (all of
the above) to **⌂ Local**: the agent works directly in the project's existing
checkout on this machine: the path configured as _Local checkout_ in the
project's settings. Nothing is prepared: no clone, no branch juggling, no
`.env` seeding, no setup steps, and no pooled database. The tree, whatever
branch it has checked out, and its real local database are used as they stand.
One local session at a time per checkout; the branch picker and ⌕ Code review
only apply to worktree sessions.

Session history and logs live in MySQL (`jobs` / `job_events`) and nowhere
else, so they survive restarts and nothing is capped or trimmed. Writes are
batched and retried while the database is unreachable, and flushed on
shutdown. The only files the app writes are the scratch prompt files each turn
hands to the CLI, kept in the OS temp dir and deleted when the turn ends.

## Database migrations

The app's own schema lives in `migrations/`, Laravel-style: one timestamped
file per change, each exporting `up` and `down`, run once in name order and
recorded in the `migrations` table with the batch that applied it
([umzug](https://github.com/sequelize/umzug) underneath, mysql2 as the only
driver). The server applies pending migrations at boot, so a fresh checkout
still only needs a running MySQL; the same thing is available from the shell:

```
npm run migrate                   # apply every pending migration
npm run migrate:rollback          # undo the last batch
npm run migrate:status            # what has run, what is pending
npm run make:migration add_x_to_y # write migrations/YYYY_MM_DD_HHMMSS_add_x_to_y.js
```

`2026_08_27_000000_baseline.js` is the schema as it stood when this started,
written idempotently so a database from before then just gets its row in
`migrations`. Never edit a migration that has shipped; add a new one.

## Requirements

- Linux (developed and run on Ubuntu, including under WSL2)
- Node.js 24 (server), the only version supported or tested, and what
  `.nvmrc` pins; `git` on PATH
- MySQL 5.7+ / MariaDB 10.2+ for session history (created on first run).
  The schema is a set of migrations in `migrations/`, applied automatically
  at boot and by `npm run migrate`; see [Database migrations](#database-migrations)
- The Claude Code CLI, with a provider login or API token configured as a
  provider entry. Each provider entry has an isolated login, so spawned sessions
  do not share the desktop app's login
- Optionally the Codex, Grok and opencode CLIs (auto-discovered; `CODEX_BIN` /
  `GROK_BIN` / `OPENCODE_BIN` to override). A Z.AI entry is configured
  with the codex binary, its endpoint and API key; it runs GLM
  models in its own `CODEX_HOME`, so the codex login is untouched. An opencode
  entry authenticates with an API key and nothing else, since there is no login
  flow to drive: it names its model the way opencode does (`<service>/<model>`, say
  `anthropic/claude-sonnet-4-5`), the key is filed under that service (and so
  is an optional base URL, for a proxy or a compatible gateway), and it runs
  with the XDG directories pointed at `~/.opencode-provider-<id>` so the
  machine's own opencode credentials are untouched too
- A GitHub token in `.env` (`GITHUB_TOKEN`) for the sessions' `gh` CLI and the
  PR/CI sync. A classic `repo` PAT covers everything; a fine-grained token wants
  Pull requests: read/write and Contents: read, plus Issues: read for the
  project view's ⊙ Issues tab, which says what it is missing without it
  (read/write to close issues from a client), and Projects: read (a classic
  token's `read:project`) for an issue's project fields and the project board
  (read/write, a classic token's `project`, to move its cards from a client)
- Git pushes/fetches authenticate through the machine's own credential helper
  (`gh auth setup-git`, `git-credential-libsecret`, or whatever `credential.helper`
  points at); the app injects no git credentials
- Or none of the above: [In Docker](#in-docker) is an image that already carries
  the runtime, the CLIs and a MySQL, and asks only for the token

## Setup

```
npm install
cp .env.example .env                       # then fill it in
npm run create-token -- --label Desktop    # sets AUTH_SECRET and prints an admin token
npm start                                  # http://localhost:4300/api/v1
```

Then point a client at the server and give it that token: the server has no
pages of its own, so a client is the only way to start and follow sessions.

`--port 4301` (or `PORT` in `.env`) moves the server; `--port` wins so a test
instance can run alongside the real one.

`.env` has to be complete: every setting in the required half of
`.env.example` names something about this machine (its database, its port, what
it is called from outside, which model to run), so none of them has a default to
fall back on. A missing one stops the boot with its name in the message rather
than coming up on a guess. The optional half is behavior that reads the same on
every install, and those do keep their defaults.

## In Docker

`docker compose up -d --build` brings up the core and a MySQL of its own on
<http://localhost:4300>. What it needs from you is a `GITHUB_TOKEN` in the
environment, or in the `.env` next to `compose.yaml`, which docker compose
reads by itself, so an install that already has one is configured:

```bash
GITHUB_TOKEN=ghp_… docker compose up -d --build
docker compose exec app npm run create-token -- --label Desktop   # then: docker compose restart app
```

`HOST_PORT` moves the published port, `PUBLIC_BASE_URL` names the hostname a
tunnel puts in front of it, and `DB_PASSWORD` is used by both the app and the
MySQL beside it. The published port stays on `127.0.0.1` for the same reason the
server binds it there: the way in from outside is a tunnel, not an open port.

**Configuration still arrives as `.env`.** `lib/config.js` reads that file and
nothing else, so the entrypoint writes one from the environment on every boot
(`docker/entrypoint.sh`). It lives on a volume, not in the image, and the keys
the environment does not name (the secret `create-token` writes, anything
added by hand) are carried across each rewrite. Mounting your own file over
`/app/.env` switches all of that off and uses the file as it is.

**The volumes are the install.** `home` holds the provider CLIs' logins, so
`claude`/`codex`/`grok`/`opencode` stay signed in across a rebuild; `state` holds the
`.env`; `workspaces` the session clones; `dbdata` the session history. Removing
them is what starting over means.

**The pool**, the extra MySQL servers a session claims so parallel sessions
never share a database, is the `pool` profile:
`docker compose --profile pool up -d`. Add them through
`POST /api/v1/settings/db-servers` as `db-pool-1:3306` and `db-pool-2:3306`; the app reaches them by service name, and
their datadir is tmpfs for the reason [deploy/README.md](deploy/README.md) gives.

**What the image does not carry is any project's toolchain.** It has node, git,
the `gh` CLI, the four agent CLIs and the `mysql`/`psql` clients, enough to run
a session, but a project's setup steps run whatever is on `PATH`, so reviewing
a PHP repository means adding php and composer to the `Dockerfile`. One more
thing behaves differently in here than on a machine: pushes authenticate through
`gh` as the credential helper (the entrypoint configures it from the same
token).

## Reaching it from anywhere

The server listens on `127.0.0.1` only; `BIND_HOST` moves it, and a container
is the only install that has a reason to. For a client on another machine,
put a tunnel in front of it rather than opening the port; a Cloudflare tunnel
(`cloudflared`) pointed at `localhost:4300` is what this is set up for. Then
set `PUBLIC_BASE_URL` to the public hostname. That one setting is what the
test-run video links point at (without an R2 bucket) _and_ what turns the
webhooks below on.

**Every way in authenticates itself.** A client calls `/api/v1` with a token
(issued, listed and revoked on the machine with `npm run create-token`; see the
[client API guide](docs/api-v1.md)), an agent calls `/api/agent/` with its
session's token, and a webhook delivery carries an HMAC. Nothing else is
answered: `/healthz` says whether the app and its database are up, and every
other path is a JSON 404, or a 410 for a retired `/api` route. A Cloudflare
Access application on the hostname is still worth having in front of it; the
[guide](docs/api-v1.md) says which paths need a bypass.

### Webhooks

With a public https hostname, the PR state an open session mirrors is delivered
instead of polled for:

| Route                                     | Sender                                | Authenticated by                                                                                        |
| ----------------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `POST /webhooks/github`                   | GitHub                                | `X-Hub-Signature-256`, HMAC-SHA256 over the raw body                                                    |
| `POST /webhooks/session/:id`              | anything you point it                 | `X-Briareus-Signature-256` (HMAC-SHA256 over the time sent and the raw body) or `Authorization: Bearer` |
| `POST /webhooks/session/:id/instructions` | a bridge relaying only your own words | The same, with the session's instructions key                                                           |

The secret is generated on first boot and kept in the `app_settings` table;
there is nothing to paste anywhere. The app installs its own repository hook on
every project it works on (the `repo` scope the token already needs
covers it), recognising its own by URL so an existing deploy hook is never
touched, and re-pointing it if the hostname changes.

What each delivery does: nothing is started by one. The hook subscribes to
`pull_request`, `pull_request_review`, `issue_comment`, `check_suite` and `status`
(not `check_run`: a repository hook hears a suite finish, not a run start), and each
refreshes the PR panel of any open session on that branch as the event lands rather
than on the next twenty-second tick (a commit status still `pending` refreshes
nothing). A repository whose hook has delivered within the last hour, and which
this boot found or left carrying every one of those events, is polled only every
fifteen minutes as a safety net (the minute cadence stays while check runs are
going, or a fresh push has none registered yet). A session on a merged or closed pull
request is polled only while a turn is running, or while its checks are still
awaited within an hour of its head first being seen, and every poll is a
conditional request (a 304 costs nothing against the rate limit). Delete the `webhooks` row in `app_settings` to
rotate the secrets; the hook is rewritten at the next boot, and every session webhook key changes. One session's
key is rotated from its **⚡ Webhook** dialog, without touching the row.

### Session webhooks

A session's webhook is the one delivery that starts work: it is how a system outside Briareus (a support
platform relaying what a customer wrote, an alert, a CI) wakes one conversation with a message.

**It is off until you arm it.** Arming it (`PUT /api/v1/sessions/:id/webhook`, a client's **⚡ Webhook** dialog) shows the URL and the key, and sets
the caps its turns run under. The key is derived from a master secret, the session id and an epoch, so it opens
that one session and no other, and **Rotate key** ends it without touching any other session's. Only a session
somebody talks to can be armed: not a worker, not a review, fix or QA session.

**What arrives is information, never your word.** Whoever wrote a delivery is not the operator, so:

- It answers no question. While the agent stands on a question, a delivery is held until you have answered.
- It joins no turn. It waits for the turn under way to end (and after **■ Stop**, for your next message), then
  everything held goes to the agent as **one** turn of its own. A closed session is woken for it.
- The agent is told so, in the briefing of an armed session and in the first lines of every delivery, and the text
  sits between two lines carrying a mark drawn for that message. No `<` in it opens a tag, so a sender cannot write
  the app's own context tags or a question card.
- A server registered in **allow** mode under SSH asks for approval in a turn a delivery started, unless the
  session's webhook is set to let it run.

The prompt is the last of those defences, not the first: what holds is that the approval the agent asked you for
cannot be given by anybody else.

**Caps**, per session, set in the dialog:

| Cap                | Default | What happens past it                                                          |
| ------------------ | ------- | ----------------------------------------------------------------------------- |
| Deliveries an hour | 30      | `429` with `Retry-After`                                                      |
| Turns in a row     | 10      | The webhook pauses until you say anything in the session (or save the dialog) |

A turn that a delivery started and that failed pauses the webhook until you have looked. A pause is said once in the transcript and listed in **/attention**, so it reaches
your phone with the other items.

**Sending.** JSON `{"text": "…", "source": "ci", "id": "run-4711"}`, plain text, or any other JSON (handed over as
it came), up to 20,000 characters. `source` is a label the transcript shows, not an identity: whoever holds the key
can write any name. `id` (or `X-Briareus-Delivery`) names the delivery, so a retry after a timeout is answered as
the duplicate it is instead of running the agent twice.

```sh
curl -X POST "$URL" -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{"text":"The nightly build failed","source":"ci","id":"run-4711"}'
# or signed, so the key never travels and a captured request is worth nothing five minutes later:
BODY='{"text":"The nightly build failed","source":"ci","id":"run-4711"}'
TS=$(date +%s)
SIG=$(printf '%s.%s' "$TS" "$BODY" | openssl dgst -sha256 -hmac "$KEY" -hex | sed 's/^.* //')
curl -X POST "$URL" -H "X-Briareus-Timestamp: $TS" -H "X-Briareus-Signature-256: sha256=$SIG" \
  -H 'Content-Type: application/json' -d "$BODY"
```

| Answer | Meaning                                                                                                      |
| ------ | ------------------------------------------------------------------------------------------------------------ |
| `202`  | Taken: `{"ok": true, "status": "running"}`, or `"held"` with how many are waiting                            |
| `200`  | `{"ok": true, "status": "duplicate"}`: this delivery had been taken already                                  |
| `401`  | Bad key or signature, or a signed timestamp more than five minutes off (the same whether the session exists) |
| `404`  | The session was deleted                                                                                      |
| `409`  | The webhook is off, the session failed, or it cannot be woken now (a drain for a restart, no free slot)      |
| `413`  | The message is longer than 20,000 characters                                                                 |
| `429`  | A cap was reached, or 30 deliveries are already waiting; `Retry-After` says when, where there is a when      |

**Instructions: the second route, and your word.** Tick **Take instructions too** in the dialog and the session
also takes `POST /webhooks/session/:id/instructions`, with a key of its own: the messages key never opens it, nor
the other way round, and **Rotate key** ends both. It is for a bridge that decides by who wrote a message where it
goes (a WhatsApp relay sending your own number's messages there and everybody else's to the first route), so what
it delivers reaches the agent the way a message typed in a client does:

- It answers the question the agent stands on, and queues behind a turn under way instead of waiting to be a turn
  of its own.
- It is the word from you that lifts the turns-in-a-row pause.
- The hourly cap holds for it as for deliveries, and a retry with the same `id` is taken once.
- A server in **allow** mode under SSH still asks for approval in a turn an instruction started, since nobody is at
  a client to see it, unless the session's webhook is set to let it run.

The request is the same as a delivery's; the answer is `202` with `"running"` or `"queued"`, `200` for a
duplicate, and `409` while instructions are off.

A delivery that was taken is kept on the session's record, which is written within half a second and on shutdown,
so one held for a session a restart interrupted is delivered afterwards. Only a crash inside that half second loses
one.

The sync timer remains as the fallback. Nothing about a laptop-only install
changes: no public hostname means no hook, and the timer keeps the panels
fresh.

## Configuration

Key `.env` settings, with `.env.example` holding the full list:

- `DEV_MAX_SESSIONS`: how many sessions of the projects that claim a database
  server may be open at once, when the pool cannot answer for it (claiming off,
  or no servers configured yet). Otherwise the pool size is the cap. A project
  with its database switched off holds nothing exclusive and is never capped
- `DB_*`: where projects and session history are stored
- `DB_POOL_*`: switches the per-session database pool off, and tunes how long
  a session waits for a server to free up. The servers themselves live in the
  database and are managed through `/api/v1/settings/db-servers`

## Projects

Everything about a repository a session can run against lives in one `projects`
row, edited through **`/api/v1/settings/projects`**:

- **Repository** and label
- **Setup**: the install/build commands run in the checkout before the agent
  starts, their per-step timeout, and the PHP version to run them with
- **Database**: whether the session claims a database server of its own from
  the pool, which database it points at there (created if missing), and the
  line logged when a server is claimed (`{host}`, `{port}`, `{database}`)
- **Code review**: extra publish steps for the agent after a ⌕ Code review
  (label moves, issue updates, whatever the team's workflow asks for), and
  whether the session goes on to **fix** what it found
- **Checkout .env**: written into the clone as `.env` before setup runs
- **Prompts**: this repository's own wording for any of the prompts below;
  anything left empty uses the shared text
- **Run**: the shell commands ▶ Run executes in the checkout (`{port}`,
  `{dir}`), chained so the last one is the server that stays up

## Prompts

What this app sends out is a setting, not a string in the source: the pull
request description ✎ PR Body Summary writes, and the errand behind every other
action and review step (test sheet, test run, fix findings, implement feedback,
give feedback, solve conflicts, fix failing checks, fix test failures, delete
own comments).

Each resolves in three steps: **the built-in text** this app ships with, **the
shared text** (`/api/v1/settings/templates`), then **the project's own**, in the
project's settings. The first non-empty one wins, so configuring nothing
behaves exactly as it always did.

A prompt is plain text with `{{TOKEN}}` placeholders: `{{REPO}}`,
`{{PR_REF}}`, `{{BRANCH}}` and whatever else that particular one is composed
from; the editor lists them under each field. A token nobody recognises is left
in the text exactly as written, which is how the deploy links' own
`@{{PULL_BRANCH}}` survives untouched. `↧ Load the text it falls back on` fills
a field with what is being sent today, so editing one line does not mean
retyping the whole prompt.

Three strings are deliberately _not_ editable: the test sheet's anchor, the
required-fixes anchor and the `[reviewer-fix]` commit line (`lib/markers.js`).
They are a contract with pull requests that already exist, and changing one makes
every PR written before the change unreadable.

**Saved prompts** are a different, simpler thing: a library of reusable kickoff
texts for the composer. The 📋 Prompts menu next to the composer's chips lists
them: the current project's own first, then the ones offered on every project.
A click drops the text into the message box; _Save current text as
prompt…_ in the same menu adds what is typed there. They are kept at
`/api/v1/prompts`. No `{{TOKEN}}`s: they are
inserted exactly as written.

**Memory** is what the agents keep between sessions on a project: Briareus's
stand-in for Claude Code's own memory directory, which the headless
runs it spawns never see (every session is a fresh clone with a fresh config
dir). Memories live in the database, one row per fact, scoped to the
repository: a kebab-case name, a type (`user`, `feedback`, `project`,
`reference`), a one-line description and a body. Every turn's briefing carries
the project's memories (newest first, whole until a size budget, then by
headline), and every turn can add to them: Claude and Codex get a `memory_save`
/ `memory_list` / `memory_read` / `memory_delete` tool (a tiny MCP server,
`lib/memory-mcp.js`, mounted per turn), and Grok and opencode, which take no MCP
server headless, are told the same thing over HTTP (`$REVIEWER_MEMORY_URL/api/agent/memories`
with `$REVIEWER_MEMORY_TOKEN` as a bearer token, both in the turn's
environment). The token is the session's own, minted per process and never
stored, and it only reaches that session's project. Read, correct or prune what
was remembered through `/api/v1/memories`.

The **database pool** (`/api/v1/settings/db-servers`) holds the servers sessions can
claim: label, host, port, username and password per entry. One session holds a
server at a time, so add as many entries as sessions you want to run in parallel
with a database. Migrations and seeding belong in the project's setup
commands, which run on every session against the claimed server.

## Client API

`/api/v1` is the server's one API, for clients that live outside this
repository: Briareus Windows and Briareus iOS. It puts a bearer token in
front of every handler, so it covers sessions, transcripts, pull requests
(files, commits, checks, comments, reviews), findings, settings and two event
streams. `npm run create-token -- --label Desktop` issues the first token, an
admin one; restart the server once if that run wrote `AUTH_SECRET`, and later
tokens need no restart. The same command issues the rest (read or manage on
chosen projects, or admin for everything), lists them and revokes them; the
API itself cannot issue or list tokens.

The routes the removed dashboard called with its login cookie, and the earlier
`/api/mobile/v1`, are retired and answer 410. The API refuses a request that
carries an `Origin` header: a client calls it from a server or a native app,
never from browser script, so a web client keeps its token on its own server.

See the [client API guide](docs/api-v1.md) for tokens, permissions, the event
streams and the Cloudflare Access exception, and the
[reference](docs/api-v1-reference.md) for every route's fields and answer.
`GET /api/v1/openapi.json` is the same catalog as an OpenAPI document. All
three come from `lib/api-v1-catalog.js`; after changing a route there, run
`npm run build:api-docs`. `npm test` fails when a handler is added without a
route, since nothing else can reach it.

## Deploying

Nothing here deploys itself: no poller watches `main` and nothing restarts the
server on its own, so a commit never picks the moment the live checkout changes
under whoever is using it. [deploy/README.md](deploy/README.md) has the pull-and-restart
steps, and the systemd units for running the MySQL pool's datadirs in RAM.

## Contributing

Issues and pull requests are welcome. [CONTRIBUTING.md](CONTRIBUTING.md) has
the setup, the checks CI runs, and the conventions this codebase keeps (plain
ESM, no build step, no defaults for machine-describing settings). Everyone
taking part is asked to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

Security problems go through [private reporting](SECURITY.md), never a public
issue.

## License

[MIT](LICENSE).

### Registered SSH servers

Register a server (`POST /api/v1/settings/ssh/servers`) for a project with its host, port,
username and optional absolute private-key path on the machine running Briareus.
The key must be readable by the operating-system account running Briareus. An empty
key path uses that account's default keys or SSH agent; encrypted keys need to be unlocked
in its agent. Password authentication, SSH config aliases, jump hosts and interactive
terminals are not supported.

Verify the host key independently and establish trust in that account's `~/.ssh/known_hosts`
before using the tool. Connections use OpenSSH with `BatchMode=yes` and
`StrictHostKeyChecking=yes`: unknown or changed host keys fail without connecting to a
remote shell ([OpenSSH configuration reference](https://man.openbsd.org/ssh_config.5)).

Each server has one permission mode:

- **Ask for all commands** (default): the exact command, destination, project and session
  wait in `GET /api/v1/ssh/requests` and the attention inbox; approving
  (`POST /api/v1/ssh/requests/:id/decision`) executes it once, and denying returns the denial to the agent.
- **Don't ask anything**: every command submitted through the SSH tool starts immediately.

Claude and Codex sessions receive `ssh_list_servers`, `ssh_execute` and `ssh_result` MCP
tools. Providers without headless MCP configuration use the equivalent session-authenticated
HTTP routes described in their briefing. Only enabled servers assigned to the session's
project are available. Each command runs in a fresh noninteractive shell, so include `cd`
in the command when a working directory is needed. Execution defaults to a 60-second timeout
(maximum 300 seconds) and 256 KiB per output stream; timeout or excess output terminates the
local SSH client, but cannot guarantee that a remote process has stopped.

Approvals expire after ten minutes and are cancelled when the session turn ends or the
server registration changes. Switching to “Don't ask anything” does not execute already
queued commands. Registrations persist in the existing `app_settings` database table;
requests and results are held in memory for up to an hour, with at most 100 requests retained
(old completed results are evicted first).
A restart discards requests and never replays them. These permissions govern the SSH tool;
Briareus's coding agents still run with their existing local shell access, so this is not an
operating-system sandbox restricting every possible way to reach a server.

### Slack

The core has a Slack inbox for native clients, independent of coding agents:
list channels and DMs, read history and threads, reply, and mark conversations
read through `/api/v1/slack/workspaces`. New messages, edits and deletions arrive
on a live event stream, including messages nobody has previously contacted
from an agent session. Messages go out **as you**: the workspace is a Slack
user token, not a bot. The core serves the API; clients build their inbox UI
on [the client integration guide](docs/api-v1.md#slack-inbox).

1. Create a Slack app at api.slack.com/apps. Under _OAuth & Permissions_, give it these
   **user token** scopes: `chat:write`, `users:read`, `channels:read`, `groups:read`,
   `im:read`, `mpim:read`, `im:write`, `mpim:write`, `im:history`, `mpim:history`,
   `channels:history` and `groups:history`; to sync read positions also grant
   `channels:write` and `groups:write`. Install it to the
   workspace and copy the _User OAuth Token_ (`xoxp-…`).
2. Add the workspace (`POST /api/v1/settings/slack/workspaces`) with that `token`, the
   app's `signingSecret` (from _Basic Information_), and optionally the `projects` whose sessions may use it,
   each `{ repo, channels, directMessages, permissionMode }`. The token is checked with
   Slack and stored encrypted under `CREDENTIALS_KEY`, as is the secret. A project sends
   through one workspace at most. Use `projects: []` for an operator-only inbox.
   Existing installations need the added scopes and a reinstall for the new inbox calls.
3. For live messages and session replies, turn on the app's _Event Subscriptions_ with the workspace's `eventsUrl`
   (`PUBLIC_BASE_URL/webhooks/slack/<id>`) as the Request URL, and subscribe **on behalf of
   users** to `message.im`, `message.mpim`, `message.channels` and `message.groups`. Like the other webhooks,
   that path must bypass Cloudflare Access.

The inbox requires an admin API token because it contains the connected account's
business conversations, including private messages outside any project. It
reads history directly from Slack and streams signed Slack events; on reconnect,
clients reload history to recover missed updates. Sending from the inbox is a
human action and takes effect immediately, without launching an agent or an approval.

Separately, sessions whose project has a workspace receive the `slack_destinations`, `slack_find_people`,
`slack_send` and `slack_result` MCP tools; reviews, QA, loop sessions and workers do not.
A project may post only to the channels it lists, and to people only with `directMessages`.
In **ask** mode (the default) each message waits in `GET /api/v1/slack/requests` and the
attention inbox until approved (`POST /api/v1/slack/requests/:id/decision`), for a day at most;
in **allow** mode it is sent at once, except in a turn a webhook delivery or a Slack reply
started, which always asks. Approvals are held in memory, so a restart sends nothing.

A reply reaches the session when it answers in a direct message the session wrote in during
the last 14 days, or in the thread of a message the session sent. It arrives as a delivery
("Slack reply", between marked lines): the other person's word, never yours. It starts a turn
under the session's webhook caps (or their defaults), without the webhook having to be armed.
Nothing else that happens in the workspace reaches any session.

### MCP servers

Claude and Codex sessions can use MCP servers you add, beside Briareus's own tools
(`POST /api/v1/settings/mcp/servers`). A server is either remote (`transport: http`, a
Streamable HTTP `url`) or a command run beside each session (`transport: stdio`, with
`command`, `args` and `env`). `repos` limits it to some projects; empty means every project.
Headers, env, OAuth clients and tokens are stored encrypted under `CREDENTIALS_KEY`.

Signing in is part of adding a server. Briareus checks a remote server at once. If the server
answers 401 with OAuth details, Briareus follows the MCP authorization spec: it reads the
protected resource and authorization server metadata, registers itself as a client, and replies
with `status: needs-sign-in` and a `signInUrl`. Open that link on any device and sign in. The
provider sends the browser to `PUBLIC_BASE_URL/webhooks/mcp-oauth/callback`, which completes
the setup. Like the other webhooks, that path must bypass Cloudflare Access. If a server does
not let clients register themselves, create an OAuth app with it, give its `oauthClientId` (and
`oauthClientSecret`), and register that callback URL as the app's redirect. Some servers only let clients they already know register, and only with a loopback redirect.
Meta's is one: it accepts names starting with `Claude Code`. For those, set `oauthClientName`
(for example `Claude Code (Briareus)`) and `oauthRedirect: loopback`. The sign-in then ends on
a `http://127.0.0.1:<port>/callback?code=…` page that won't load (`signInNeedsPaste` is true).
Copy that address and send it to `POST …/servers/:id/finish-sign-in` as `url` to complete the
setup. A server that takes an API key gets it as `headers` instead. `POST …/servers/:id/connect` checks a server again
(`{ "signIn": true }` starts a new sign-in, for example to use another account).

One sign-in covers every provider account. Sessions never see a remote server's credentials:
a turn reaches the server through `/api/agent/mcp/<id>` with its own session token, and Briareus
adds the server's token there, refreshing it when it is about to expire. Remote servers that
still need a sign-in are not mounted. Grok and opencode sessions don't get these servers,
because they take no MCP configuration headless.

### Operator attention

`GET /api/v1/attention` is the operator's inbox: unanswered agent
questions, held findings, interrupted sessions, review/QA failures and pending
SSH commands and Slack messages across projects. It is a live projection, read on every request,
and does not dismiss unresolved work.

### Recovery and maintenance

An interrupted or failed session has a recovery report
(`GET /api/v1/sessions/:id/recovery`): expected and actual
branch, HEAD, working-file changes and the pending phase. Resume checks that
report again and refuses missing, recycled or busy workspaces, and a session
whose provider conversation never started. Reopening a
session in its own clone slot preserves commits and working files and
refreshes the origin refs before running setup; a clean branch that is only
behind origin is fast-forwarded, and otherwise the next turn is told the branch
differs from origin. A new agent turn inspects what
already happened before continuing. A slot another session has used since (each
session records itself in the slot's `.git/briareus-owner`, so this holds after
that session is deleted), or
one whose checkout is off the session's branch or unreadable, is never reset in
its place: the first gets a different clone, the others fail the reopen until
someone inspects them. The clone pool does not hand out, and the daily workspace
cleanup does not delete, a slot a failed session, or one a restart interrupted
mid-turn, left work in (except loop review, fix and QA children, which their
parent retries, and sessions whose agent never started).

After a server restart, sessions that were open recover automatically once the
API is listening. Active turns continue in their saved provider conversation,
queued instructions are retained, and review, publishing and QA steps continue
from their saved stage. Completed turns are skipped. Idle sessions reopen their
workspaces without starting a turn, and standing questions still wait for the
operator's answer. Recovery reserves workspace slots and reclaims each session's
previous database server without restoring seed SQL or dropping profile
databases. If that server is unavailable, recovery fails visibly instead of
moving the session onto different data. Sessions already closed, failed or
interrupted before this restart stay as they were.
An explicit Stop stays stopped, including when the canceled process was still
exiting at shutdown.

`POST /api/v1/maintenance` drains work: new top-level sessions, messages that would start
a turn on a settled session, reopening, compaction, arming the review or QA
loop, review retries, triage that marks findings to fix, orchestrator worker
spawns and sends, and ▶ Run previews are refused, while answers to questions, messages to running
turns and the loops' automatic reviews, fixes and QA runs still go through. The ready state
also waits for running SSH commands. Resume accepting work cancels draining.
This is an in-process gate, reset on restart; it does not deploy or restart the
server. Wait for ready before the normal deployment procedure.

### Relevant memory and maintenance

Briefings prioritize user/feedback memories and matches against the session
title and latest user message, then recency, within the existing body budget.
Selection is local lexical matching, with no model call or embedding service.
`GET /api/v1/memories/health` lists possible duplicates and memories needing verification:
mark facts checked, archive/restore them, or review a combined text before
merging. Merging saves the edited target and archives the source without
removing its text. Verification applies to the exact content and expires after
90 days for maintenance purposes; it never automatically invalidates a fact.
Archived memories remain readable through the API and the memory tools,
but are omitted from briefings. Metadata persists in `app_settings`.

### Visual preview feedback

`POST /api/v1/sessions/:id/preview/feedback` takes a screenshot of a running
session's preview (an uploaded PNG), the point marked on it and a comment, and
sends the annotated PNG, exact page URL and image coordinates to the same agent
conversation. Preview origins are checked against that session's Run links.
Capture dimensions are image pixels, not an inferred CSS viewport.

### Task history

A task's history (`GET /api/v1/tasks/:id`) is its implementation, review, fix and QA
sessions together, including independent errands linked to the same PR. It
shows their times/statuses, review rounds, QA outcome, PR evidence link and
combined ledger cost (estimated and unpriced turns stay marked). Workers remain
separate from sibling tasks under the same orchestrator.

The `task_sessions` migration stores small audit snapshots alongside session
writes and before deletion. Deleting a conversation still deletes its transcript;
the title, branch, relationships, lifecycle and PR/QA metadata survive with its
usage ledger. Records deleted before this feature cannot be reconstructed. The
migration rollback drops this audit history, without touching conversations or
usage. A task remains readable after its conversation is deleted.

### Deployment state and actions

`GET /api/v1/deployments` reads the latest 20 GitHub deployments, their latest status and
active successful revision per environment, with a 30-second cache. Failed or
requested deployments never count as the currently published commit. An optional
configured HTTP(S) health URL is probed with a five-second timeout and no redirects;
health alone does not prove which commit is deployed.

Configure each project's environment, workflow filename/ID, workflow branch/tag,
source branch/tag and SHA input name. None of these machine/project choices is
guessed. Planning a deployment resolves the source revision and CI; dispatching
it rechecks CI and dispatches the workflow with that immutable SHA input.
The workflow must accept that input, check out that SHA, perform the project's
deploy procedure and report deployment status for the configured environment.
For example its `workflow_dispatch.inputs.revision` is a required string and
`actions/checkout` uses `ref: ${{ inputs.revision }}`. Configure GitHub environment
protection and the actual deployment steps in that workflow. Briareus does not
invent a shell command or change a server registration's SSH permissions.

The workflow must publish its deployment record for the supplied SHA, since an
automatic environment record can otherwise name the workflow branch revision.
Projects marked as Briareus itself must be drained in Maintenance before dispatch.

The existing GitHub token needs Actions write access to dispatch. The operator
must check/acknowledge the previous request before another dispatch, including an
ambiguous network failure; requests persist across server restarts. A dispatch
is reported as requested, never deployed, until GitHub reports its outcome.
See [workflow dispatch](https://docs.github.com/en/rest/actions/workflows#create-a-workflow-dispatch-event)
and [deployment statuses](https://docs.github.com/en/rest/deployments/statuses).

### Laravel Forge

Forge accounts are kept in the database, added and edited through
`/api/v1/settings/forge/accounts`: each is an organization (the slug in
`forge.laravel.com/<organization>/…`), an API token for it, and the projects it
is available to, so a client working on a project offers that project's
accounts (`?repo=owner/name`). The token is stored encrypted under
`CREDENTIALS_KEY` and never sent back. Through
`/api/v1/forge/accounts/:account`, an admin token lists the account's servers
and each server's sites, reads a site, and reads or replaces a site's
deployment script and `.env`; the server makes every call with the account's
token, so no client holds it. Forge allows 60 calls
a minute per token; past that the routes answer 429. Replacing a `.env` is
accepted by Forge and written to the server shortly after; it does not deploy,
clear the config cache or restart queue workers.

### Laravel Envoyer

Envoyer is reached per account rather than with one server-wide token. An
admin token keeps the list at `/api/v1/settings/envoyer/accounts`: each account
is a name, an Envoyer API token and the one project it is available to. The
token is stored encrypted under `CREDENTIALS_KEY` and never returned. Any token
of that project lists the accounts it may use (`GET /api/v1/envoyer/accounts`);
a manage token reads an account's Envoyer projects, their servers and
deployments, and deploys a branch or tag through
`/api/v1/envoyer/accounts/:id/projects/…`, always naming the project in `repo`.
An account another project was given answers 404. Deploying needs the
`deployments:create` scope on the Envoyer token.

### Mail

Briareus can keep a copy of Gmail and Outlook mailboxes so a client reads them
through `/api/v1` without talking to Google or Microsoft itself. It only reads:
the sign-in asks for `gmail.readonly` or `Mail.Read`, and nothing marks, moves,
sends or deletes a message. All of it is admin-only, since it is the operator's
own mail.

The sign-in is the providers' own OAuth flow with PKCE. Its simplest form ends
on this server: register `PUBLIC_BASE_URL/oauth/mail/callback` (an https
address) as the OAuth client's redirect URI and the server finishes the
sign-in as the browser arrives there, whatever device signed in.

1. Register an OAuth client and put it in the server's environment (see
   `.env.example`):
   - **Gmail**: in Google Cloud, enable the Gmail API, set up the OAuth consent
     screen with the `gmail.readonly` scope, and create an OAuth client of type
     _Web application_ whose authorized redirect URI is exactly
     `PUBLIC_BASE_URL/oauth/mail/callback`. Set `GOOGLE_OAUTH_CLIENT_ID`,
     `GOOGLE_OAUTH_CLIENT_SECRET` and `GOOGLE_OAUTH_REDIRECT_URI` (that same
     address). The consent screen decides how long a connection lasts:
     - in _Testing_ (an external one), Google expires refresh tokens after 7
       days, so the mailbox has to be connected again every week;
     - in _Production_ without verification, sign-in shows Google's
       unverified-app warning and at most 100 users can connect, which is
       enough for your own mailboxes;
     - _Internal_ needs a project owned by a Google Workspace organization, and
       only that organization's accounts can connect.

     A Gmail token also stops working when the account's password changes, or
     after six months without use.

   - **Outlook**: in Microsoft Entra, register an app with the delegated Graph
     permissions `Mail.Read`, `User.Read` and `offline_access`, add a _Web_
     platform with the redirect URI `PUBLIC_BASE_URL/oauth/mail/callback`, and
     create a client secret. Set `MICROSOFT_OAUTH_CLIENT_ID`,
     `MICROSOFT_OAUTH_CLIENT_SECRET` and `MICROSOFT_OAUTH_REDIRECT_URI`. Match
     `MICROSOFT_OAUTH_TENANT` to the registration's supported account types:
     `common` (the default) for any organization plus personal accounts,
     `consumers` for personal accounts only, or your tenant's id or domain for
     a single-tenant app.

   `CREDENTIALS_KEY` must be set too: the tokens are stored encrypted with it.
   Behind Cloudflare Access, give `/oauth/mail/callback` the same _Bypass_ as
   `/api/v1`, so a browser that has not passed Access still reaches it; the
   route takes nothing but a pending sign-in's single-use `state`.

2. `POST /api/v1/settings/mail/accounts/connect` with `{ "provider": "gmail" }`
   (or `outlook`) answers with a `url`. Open it in a browser (Google refuses
   sign-ins in an embedded web view) and sign in. The browser ends on the
   callback, which says which mailbox it connected, and the first sync starts
   right away.
3. Read with `GET /api/v1/mail/messages` (newest first, filtered by `account`,
   `q`, `unread`, `inbox`, `starred`, `label` or `thread`, paged with
   `cursor`) and `GET /api/v1/mail/accounts/{account}/messages/{id}` for one
   message with its body.

A client can also receive the redirect itself, with a redirect URI of its own
registered instead: a loopback listener on a Google _Desktop app_ client's
`http://127.0.0.1:<port>`, or a web view watching Microsoft's
`https://login.microsoftonline.com/common/oauth2/nativeclient` (a _Mobile and
desktop_ platform, with no secret). It then sends the address it landed on to
`POST …/connect/finish` as `{ "url": "…" }`, at once: a Microsoft code lasts
about a minute.

Every enabled mailbox is synced every `MAIL_SYNC_MINUTES` (5 by default; `0`
leaves it to `POST …/settings/mail/accounts/{id}/sync`). The server keeps the
last `syncDays` days (30 by default, up to 365).

- **Gmail** syncs everything except trash, spam and drafts, through its
  history. A first pass takes the newest 2,000 messages in the window, paced
  to Gmail's quota of 6,000 units a minute per user (a message read costs 20),
  so it takes up to about eight minutes.
- **Outlook** syncs every folder except Deleted Items, Junk Email, Drafts,
  Outbox, search folders and their subfolders, through Graph's per-folder
  delta, at most four requests at a time. A folder's first pass takes at most
  5,000 messages, Graph's limit for a filtered delta.

Bodies are kept up to 500,000 characters. Attachments are listed but their
content is not synced. When a provider stops honouring a sign-in (revoked,
expired, password changed, new consent required), the account shows
`status: "reauth"` and stops syncing until it is connected again with its
`accountId`. Removing an account deletes its tokens and messages here; also
remove the app's access at Google or Microsoft.
