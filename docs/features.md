# Server features and recent additions

This repository contains the Briareus server. Its `/api/v1` API supports
[Windows](https://github.com/okanetsolutions/briareus-windows),
[iOS (Swift)](https://github.com/okanetsolutions/briareus-swift), and
[Meta Quest](https://github.com/okanetsolutions/briareus-quest) clients.
There is no built-in dashboard. Server support does not imply that every
client has implemented a feature.

## Coding sessions

Sessions run Claude Code, Codex, Grok, opencode or Z.AI in their own workspace
clones. Projects can reserve a database server per open session or use a
local checkout. Clients can stream transcripts, send or queue messages,
cancel turns, compact context, close and reopen sessions, and attach files
or transcribed voice notes. Claude `/btw` questions use a separate fork of
the conversation. Orchestrators coordinate worker sessions and their
review, fix and QA work.

See [how sessions run](../README.md#how-a-session-runs) and the
[session API reference](api-v1-reference.md#sessions).

## GitHub, reviews and QA

The server reads pull requests, diffs, commits, checks, comments, issues,
issue timelines, sub-issues and Projects v2 boards. Manage clients can update
pull requests and issues, move board cards, update PR branches and merge.
Repository routes expose trees, files and gzipped archives at a revision.

Reviews require independent verification and an assessment of whether each
finding is worth fixing. Findings normally wait for operator decisions. With
`autonomousReviewLoop` enabled, active review loops automatically fix verified,
worthwhile findings with complete assessments without an operator decision.
Review loops run reviews and fixes on the session's branch; optional QA loops create and
execute test sheets after review passes. Feedback left unfixed gets a visible
PR note explaining the decision.

See [review loops](../README.md#the-review-loop),
[QA](../README.md#qa-once-the-code-is-approved), and the
[GitHub API reference](api-v1-reference.md#pull-requests-and-issues).

## Previews and browser access

Run profiles serve session checkouts, branches and pull requests. A shared
Chromium browser lets the agent and a client interact with the same tabs.
Clients can stream the browser, send input, capture screenshots and submit
annotated preview feedback. QA runs can record downloadable videos.

See [the shared browser](api-v1.md#the-shared-browser) and
[visual preview feedback](../README.md#visual-preview-feedback).

## Business inboxes and session tools

| Service           | Client API                                                                                                     | Interactive session tools                                                                         |
| ----------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Slack             | Channels, DMs, threads, replies, read positions and live events as the connected user                          | Read permitted channels and the user's DMs; send with the project's approval rules                |
| Gmail and Outlook | Connect and sync mailboxes, search messages, read bodies, reply and move individual messages to provider trash | Opt-in projects can search, read, connect, sync, send, reply, mark read/unread, archive and trash |
| WhatsApp          | Link through WAHA, read chats, send text replies, mark read and download attachments                           | Opt-in projects can read, open media, reply and mark read through the internal WhatsApp MCP       |

These client inbox routes require admin tokens and work independently of
coding sessions. Session tools enforce their own project and turn access
rules. Mail management also requires provider consent; trash actions do not
permanently delete messages.

See [Slack setup](../README.md#slack), [mailbox setup](../README.md#mail),
[session email access](email-mcp.md), and [WhatsApp setup](whatsapp.md).

## Operations, integrations and memory

The attention API reports unanswered questions, held findings, failed work
and pending approvals. Recovery reports inspect interrupted sessions before
resuming them. Maintenance draining blocks new work while existing work
settles. Registered SSH servers support explicit approval or immediate
execution according to their configured permissions.

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
Claude accounts can fail over when quota is exhausted.

See [session costs](../README.md#what-a-session-costs) and
[Claude account failover](../README.md#claude-account-failover).

## Recent additions

These additions are present in the server revision documented here:

- Slack's core inbox has live events and operator replies; eligible sessions
  can now read their project's channels, DMs and threads too.
- Gmail and Outlook sync into the core; opted-in projects receive email
  tools, including sending, filing and moving mail to recoverable trash.
  Read-only mailbox deletion returns a reconnect conflict, and Outlook
  mailbox access is validated before a connection is saved.
- WhatsApp has a local WAHA installer and inbox API, plus opt-in session
  tools. Installer reruns preserve engine selection, and NOWEB history
  storage is enabled for accounts created by the core.
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
- Reviews assess verification and fix value independently, leave notes for
  feedback not fixed, and let orchestrators reach pending worker review/fix
  questions. Worker QA can be controlled independently.
- Pull request reads share cached work and return a retryable 429 when the
  GitHub allowance is exhausted.

For the complete change history, see [GitHub releases](https://github.com/nadinyamaui/briareus/releases).
