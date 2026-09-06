# Briareus

A local chat dashboard for running coding agents against a project. Each
session is a conversation with one agent, **Claude Code**, **Codex**,
**Grok**, **opencode** or **Z.AI** (GLM through the codex CLI), inside a workspace clone of
its own, with a database server of its
own, so parallel sessions never share a working tree or a database. You
describe what to build; the agent edits, runs the app and its tests, and can
push a feature branch / open a PR when asked.

Served at `/`; projects and the database pool are managed at
`/settings/projects`.

📖 **[Documentation](https://nadinyamaui.github.io/briareus/)**: installing it,
creating a project field by field, registering database servers and providers,
the review and QA loops, and the full `.env` reference. This README is the short
version of the same thing.

> **This app runs shell commands as you.** A session edits files, runs the
> project's setup and run commands, and pushes to GitHub with the credentials
> the machine already has, so anything that can reach the port can do all of
> that. The server listens on `127.0.0.1` only, and the login is **off** until
> `npm run set-password` has been run (the boot log says `login: OFF` when it
> is). Before you put a hostname in front of it, read
> [Reaching it from anywhere](#reaching-it-from-anywhere) and
> [SECURITY.md](SECURITY.md).

## How a session runs

1. **Claim resources.** The session takes an idle workspace clone from the
   pool (`<owner>__<repo>`, then `…__2`, `…__3` as concurrency demands) and,
   if its project asks for one, claims one of the database servers configured
   in Settings, exclusively for as long as it stays open. The project's
   database is created on the claimed server if it does not exist yet. Slots
   are never deleted, and a session that already knows its branch prefers the
   idle slot that is still on that branch: the one whose dependencies, build
   output and framework caches are already the right ones.
   The pool itself is visible under **Settings → Workspaces**: every slot's
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
   provider's own session state. Output streams into the page live (SSE). The
   session keeps its clone and database server between turns, for as long as
   it stays open.
5. **▶ Run** serves the session's checkout with the project's run commands
   against the session's own database, on an app port of its own (one per
   pool entry: 8101, 8102, …).
6. If the session's branch gets a PR on GitHub, its state and CI checks are
   mirrored into the header and the right panel, synced at the end of every
   turn, every 20s while a turn is running, and once a minute otherwise. The
   panel redraws from a pushed session record, so it never waits for a poll.
   **🔗 Link PR** recovers one automatic discovery missed: enter its number or
   URL, and the dashboard verifies that its repository and head branch match
   the session before attaching it.
7. **Close** releases the clone slot and the database server; the conversation
   stays readable. **Delete** also trashes the record and its log.
8. The **✎** beside a conversation's heading edits its title without sending a
   message to the agent.

### Who the board is about

⌕ Code review is always somebody pressing a button, on this app's board or in a
session composer. Nothing on GitHub starts a session by itself: no push, no
label and no webhook delivery ever opens one.

What a project configures at `/settings/projects` is who its board is about and
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

Epics are GitHub's own sub-issues, not a label or a title prefix: a sub-issue is
drawn nested under its parent, an epic says how many of its children are done
(counting the closed ones and any the tab never listed) and folds them away,
and starting an epic starts one session on its open sub-issues rather than on
the epic itself.

Each fix commit ends with a `[reviewer-fix]` line so the dashboard can tell a
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
findings it declared are handed to a **fix session** of their own (the same
auto-closing implement-feedback errand the board starts, on the session's
branch and provider), whose pushes, once it closes, trigger the next review.
The session itself is the durable half: it is the loop's anchor, it keeps its
clone, its database server and its conversation, and you can keep chatting in
it undisturbed while the reviews and the fix sessions come and go around it.

Each round's findings are listed on the pull request's **Required fixes**
checklist before the fix session starts, exactly as if you had decided them
by hand in the findings panel: handing them over to be implemented is that
decision. The fix session then ticks the ones it actually fixed, replies on the
threads it addressed and resolves them, so the pull request and the panel both
show what is solved and what is still open. A finding you had already
dismissed or marked optional is left off that list and is not sent back to be
fixed: your verdict on it stands, however often a later review re-declares it.

A worker's loop is different in one respect: **its orchestrator triages every
round first.** The findings reach the orchestrator as an update, each with the
loop's own advice on it (what the rules below would have parked, and why), and
nothing is implemented until it rules on every one with `triage_findings`:
_fix_ goes to the fix session, _dismissed_ is recorded like a verdict given by
hand in the findings panel and said on the pull request with the reason, so
no later round offers it again, and _optional_ keeps it on the pull request
without spending a round. The orchestrator has the task's whole context, which
the review did not; a finding it knows to be beside the point costs nothing
when it never reaches a fix session. The loop holds until it rules (the
worker shows _awaiting triage_), and a loop whose orchestrator was closed
meanwhile runs the round the way a loop with no orchestrator does.

A round that could not run at all — its provider exited non-zero or was out of
quota, a dashboard restart interrupted its review or fix session, or its
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

### What a session costs

Every finished turn is written to a project-owned `turn_usage` ledger (agent
time, tokens in and out, and the provider's own cost figure when its CLI
reports one: claude and opencode do, codex does not, and the ledger stores no
number nobody charged). The ledger is independent of the session record, so deleting a session
removes its transcript but keeps its statistics. The session header shows the
session's tokens and cost as a chip, each turn's footer in the transcript shows
its own, and a project's board header shows the calendar month so far:
sessions, agent time, tokens and priced cost
(`GET /api/dev/usage?repo=owner/name` returns the same numbers).

The 📊 button beside **＋ New session** opens the same ledger with no project
filter: headline tiles, tokens over time, a row per project and a breakdown per
model, over this month, last month or all time (a month charts a bar per
calendar day, all time a bar per month). Projects switched off since are still
listed: one disabled mid-month spent what it spent, and leaving it out would
stop the rows adding up to the totals. A cost wears a `+` when some of the turns
behind it were never priced, so an unpriced turn never reads as a free one.
`GET /api/dev/usage/all?period=month|prev|all` returns it as JSON.

The dashboard puts a figure on the turns their CLI never priced: their tokens at
the model's published list price, from the [models.dev](https://models.dev)
catalog (fetched once a day and cached; an install with no reach keeps whatever
copy it has, or shows those turns as unpriced). Those costs read `~$12.34`, and
the tile and every tooltip say how many turns of the total were estimated. They
are arithmetic over tokens, not an invoice: what the ledger stores is still only
what the providers themselves reported.

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

### Zeus mode

The same chip's **⚡ Zeus** turns a session into an epic writer: you give it a
brief, it hands back a GitHub epic. It is a 🧭 orchestrator in its machinery
(no branch, no loops, the worker tools) with two differences: it gets a
read-only shallow clone of the default branch to investigate and verify against,
and every worker it starts is a read-only **analyst** that reports instead of
pushing (the spawn refuses loops and branches for them). Selecting **⚡ Zeus**
opens the model picker immediately: choose two models for the same task.
The session model selected in the composer is ZEUS, the summarizer.
New Zeus sessions require both choices; resuming an older session without
complete choices opens the picker before sending the next message.

Both models receive the same complete prompt, independently investigate the
repository and produce a complete epic. The server refuses a different proposal
prompt within the same user brief, including after a restart. ZEUS combines the
two outputs into one document, preserving useful unique findings, checking
contradictions against evidence and keeping unresolved decisions explicit.
There are no specialist assignments or separate validator. ZEUS publishes the
combined epic as a parent issue with linked sub-issues for implementation.
The document's shape is the _Zeus epic_ template under Settings → Prompts,
overridable per project.

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
- The Claude Code CLI, authenticated. The spawned CLI does **not** share the
  desktop app's login (`claude auth login`, or `claude setup-token` /
  `ANTHROPIC_API_KEY` in `.env`)
- Optionally the Codex, Grok and opencode CLIs (auto-discovered; `CODEX_BIN` /
  `GROK_BIN` / `OPENCODE_BIN` to override). A `ZAI_API_KEY` in `.env` adds a
  Z.AI entry that runs GLM models through the codex CLI (own `CODEX_HOME`, so
  the codex login is untouched). An opencode entry authenticates with an API
  key and nothing else, since there is no login flow to drive: it names its model
  the way opencode does (`<service>/<model>`, say
  `anthropic/claude-sonnet-4-5`), the key is filed under that service (and so
  is an optional base URL, for a proxy or a compatible gateway), and it runs
  with the XDG directories pointed at `~/.opencode-provider-<id>` so the
  machine's own opencode credentials are untouched too
- A GitHub token in `.env` (`GITHUB_TOKEN`) for the sessions' `gh` CLI and the
  PR/CI sync. A classic `repo` PAT covers everything; a fine-grained token wants
  Pull requests: read/write and Contents: read, plus Issues: read for the
  project view's ⊙ Issues tab, which says what it is missing without it
- Git pushes/fetches authenticate through the machine's own credential helper
  (`gh auth setup-git`, `git-credential-libsecret`, or whatever `credential.helper`
  points at); the app injects no git credentials
- Or none of the above: [In Docker](#in-docker) is an image that already carries
  the runtime, the CLIs and a MySQL, and asks only for the token

## Setup

```
npm install
npm run build:css        # not committed; the pages are unstyled without it
cp .env.example .env     # then fill it in
npm start                # http://localhost:4300
```

`--port 4301` (or `PORT` in `.env`) moves the server; `--port` wins so a test
instance can run alongside the real one.

`.env` has to be complete: every setting in the required half of
`.env.example` names something about this machine (its database, its port, what
it is called from outside, which model to run), so none of them has a default to
fall back on. A missing one stops the boot with its name in the message rather
than coming up on a guess. The optional half is behavior that reads the same on
every install, and those do keep their defaults.

## In Docker

`docker compose up -d --build` brings up the dashboard and a MySQL of its own on
<http://localhost:4300>. What it needs from you is a `GITHUB_TOKEN` in the
environment, or in the `.env` next to `compose.yaml`, which docker compose
reads by itself, so an install that already has one is configured:

```bash
GITHUB_TOKEN=ghp_… docker compose up -d --build
docker compose exec app npm run set-password   # then: docker compose restart app
```

`HOST_PORT` moves the published port, `PUBLIC_BASE_URL` names the hostname a
tunnel puts in front of it, and `DB_PASSWORD` is used by both the app and the
MySQL beside it. The published port stays on `127.0.0.1` for the same reason the
server binds it there: the way in from outside is a tunnel, not an open port.

**Configuration still arrives as `.env`.** `lib/config.js` reads that file and
nothing else, so the entrypoint writes one from the environment on every boot
(`docker/entrypoint.sh`). It lives on a volume, not in the image, and the keys
the environment does not name (the login `set-password` writes, anything added
by hand) are carried across each rewrite. Mounting your own file over
`/app/.env` switches all of that off and uses the file as it is.

**The volumes are the install.** `home` holds the provider CLIs' logins, so
`claude`/`codex`/`grok`/`opencode` stay signed in across a rebuild; `state` holds the
`.env`; `workspaces` the session clones; `dbdata` the session history. Removing
them is what starting over means.

**The pool**, the extra MySQL servers a session claims so parallel sessions
never share a database, is the `pool` profile:
`docker compose --profile pool up -d`. Add them at `/settings` as
`db-pool-1:3306` and `db-pool-2:3306`; the app reaches them by service name, and
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
is the only install that has a reason to. To use the dashboard from a phone,
put a tunnel in front of it rather than opening the port; a Cloudflare tunnel
(`cloudflared`) pointed at `localhost:4300` is what this is set up for. Then
set `PUBLIC_BASE_URL` to the public hostname. That one setting is what the
test-run video links point at _and_ what turns the webhooks below on.

**Two gates, because this app runs shell commands as you.** Anything that
reaches it can start a session, which means running coding agents on this
machine with its git and GitHub credentials:

1. **At the edge.** A Cloudflare Access application on the hostname, with a
   policy that allows only your own email. Add a second application for
   `<hostname>/webhooks` with a **Bypass** policy: GitHub cannot sign into
   your Access account, and its deliveries authenticate themselves (below).
2. **In the app.** `npm run set-password` writes a username, a scrypt hash of
   the password and a cookie signing secret into `.env`; every request then
   needs the login (see `lib/auth.js`). Restart for it to take effect. Until
   both keys are set the boot log says `login: OFF`, and do not leave it that way
   while the hostname is reachable.

### Webhooks

With a public https hostname, the PR state an open session mirrors is delivered
instead of polled for:

| Route                   | Sender | Authenticated by                                     |
| ----------------------- | ------ | ---------------------------------------------------- |
| `POST /webhooks/github` | GitHub | `X-Hub-Signature-256`, HMAC-SHA256 over the raw body |

The secret is generated on first boot and kept in the `app_settings` table;
there is nothing to paste anywhere. The app installs its own repository hook on
every project it works on (the `repo` scope the token already needs
covers it), recognising its own by URL so an existing deploy hook is never
touched, and re-pointing it if the hostname changes.

What each delivery does: nothing is started by one. `pull_request`,
`pull_request_review`, `issue_comment`, `check_suite` and `check_run` refresh
the PR panel of any open session on that branch as the event lands rather than
on the next twenty-second tick. Delete the `webhooks` row in `app_settings` to
rotate the secret; the hook is rewritten at the next boot.

The sync timer remains as the fallback. Nothing about a laptop-only install
changes: no public hostname means no hook, and the timer keeps the panels
fresh.

## Styling

The UI is Tailwind (v4). Source lives in `src/app.css`, and the palette is
declared there as `@theme` tokens (`bg-raise`, `text-muted`, `border-line`,
`text-accent`…) and everything else is utilities in `public/developer.html`
and in the markup `public/developer.js` generates. The compiled
`public/app.css` is not committed and `npm start` does not build it, so a fresh
clone builds it once and every class you add rebuilds it (the deploy builds its
own copy, so there is nothing to commit):

```
npm run build:css        # once, minified
npm run watch:css        # while editing
```

Key `.env` settings, with `.env.example` holding the full list:

- `DEV_MAX_SESSIONS`: how many sessions of the projects that claim a database
  server may be open at once, when the pool cannot answer for it (claiming off,
  or no servers configured yet). Otherwise the pool size is the cap. A project
  with its database switched off holds nothing exclusive and is never capped
- `DB_*`: where projects and session history are stored
- `DB_POOL_*`: switches the per-session database pool off, and tunes how long
  a session waits for a server to free up. The servers themselves live in the
  database and are managed at `/settings/projects`

## Projects

Everything about a repository a session can run against lives in one `projects`
row, edited at **`/settings/projects`**:

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
shared text** under _Prompts_ in `/settings`, then **the project's own** under
_Prompts_ in its form. The first non-empty one wins, so configuring nothing
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
prompt…_ in the same menu adds what is typed there. Edit, re-scope to a project
or delete them under _Saved prompts_ in `/settings`. No `{{TOKEN}}`s: they are
inserted exactly as written.

**Memory** is what the agents keep between sessions on a project: the
dashboard's stand-in for Claude Code's own memory directory, which the headless
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
was remembered under _Memory_ in `/settings`.

The **Database pool** section on the same page holds the servers sessions can
claim: label, host, port, username and password per entry. One session holds a
server at a time, so add as many entries as sessions you want to run in parallel
with a database. Migrations and seeding belong in the project's setup
commands, which run on every session against the claimed server.

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
