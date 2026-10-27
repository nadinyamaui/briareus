# Printing from a session

Interactive Briareus sessions receive the internal `reviewer_print` MCP only when
their project explicitly enables print tools. It prints on the printers set up
in CUPS on the machine that runs the core, through CUPS's own `lp`, `lpstat` and
`cancel` commands; the core needs no other configuration. After deploying this
change, the tools appear on the next session turn.

Ask the agent, for example:

- “Print the invoice PDF you just generated.”
- “Print pages 1 to 3 of the report, double-sided, in black and white.”
- “Which printers are there?”
- “Cancel that print job.”

The tools are `print_printers` (each printer, its state and the default),
`print_file` (a file, with optional printer, copies up to 20, pages, sides,
color mode, paper size, landscape and fit-to-page), `print_jobs` (this session's
jobs and their state) and `print_cancel` (one of this session's jobs). The
internal HTTP endpoints live under `/api/agent/print`.

## Select projects

Print tools default to **off** for both existing and new projects. An operator
with an admin API token opts a project in through
`PUT /api/v1/settings/projects/{id}` with `{ "printToolsEnabled": true }`
and revokes it with `false`. The projects list and defaults expose this boolean
so clients can offer a switch. The setting is independent of the email and
WhatsApp tools.

The tools and printing instructions appear on the next turn of eligible
sessions in that project. Revocation takes effect on every internal print HTTP
request, including tools loaded earlier and direct API fallback calls.

## What a session can print

Paper comes out of a physical printer, so the tools follow the same rules as the
operator's inboxes: only interactive chats in an enabled project get them, never
review, QA, worker, read-only or preview sessions, nor a turn that a webhook or
other delivery started.

A session prints only a non-hidden regular file in its own workspace or an
attachment delivered to it, at most 25 MiB: the same rule as SSH uploads. The
core reads the file and hands its bytes to `lp` on standard input, so `lp` never
opens a path the session named. PDF, plain text and common image formats print
directly; the agent is told to convert other formats to PDF first.

A session sees and cancels only the jobs it sent. That list is kept in memory,
so it starts empty after the core restarts or the session closes or is deleted.
At most four file reads/submissions run at once across sessions. Each session
retains up to 100 jobs; only confirmed terminal jobs are pruned to make room.
If all retained jobs are active or uncertain, new submissions are refused.

Every submission has a unique marker in its CUPS title. If `lp` loses its
acknowledgement, `print_jobs` retains an `uncertain` entry and uses CUPS's
`ipptool` to recover the job ID by marker and printer, including completed jobs.
After recovery the session can cancel a pending job normally. No match still
means uncertain, never permission to print again. Recovery requires `ipptool`
(usually the `cups-ipp-utils` package) and retained CUPS job names/history; the
query identifies itself as the core's user, who owns the job, so default CUPS
job privacy still shows its name. A missing tool or failed query is reported as
`recoveryError` next to the other jobs without discarding the submission, and
canceling a confirmed job does not depend on it. Standard local socket configurations are queried through localhost
port 631; that HTTP listener must reach the same scheduler as the socket.

## Set up a printer

Install CUPS on the core machine and add the printer there (for example with
`lpadmin` or the CUPS web interface on port 631), then make it the default with
`lpoptions -d <name>` if sessions should use it when nobody names one.
`lpstat -p -d` run as the core's user should list it. Without CUPS,
`print_printers` answers that printing is unavailable on the server.
