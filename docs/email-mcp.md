# Email from a session

Interactive Briareus sessions receive the internal `reviewer_mail` MCP only when
their project explicitly enables email tools, including Claude sessions. It uses the existing Gmail/Outlook service, with the
session's token; provider credentials remain encrypted on the core server.
After deploying this change, the tools appear on the next session turn.

Ask the agent, for example:

- “Show my unread inbox emails.”
- “Find emails about the October invoice.”
- “Reply to this email saying I can meet on Tuesday.”
- “Mark this message read and archive it.”
- “Move this week’s marketing emails to the trash.”

The nine tools are `mail_accounts`, `mail_search`, `mail_read`, `mail_sync`,
`mail_connect`, `mail_finish_connect`, `mail_send`, `mail_reply`, and `mail_update`
(read, unread, archive, or trash: moved to the provider’s recoverable trash).
The internal HTTP endpoints live under `/api/agent/mail`; this is a session tool,
not an external dashboard-control MCP.

## Select projects

Email tools default to **off** for both existing and new projects. An operator
with an admin API token opts a project in through
`PUT /api/v1/settings/projects/{id}` with `{ "mailToolsEnabled": true }`.
The projects list and defaults expose this boolean so clients can offer a switch.
To revoke access, send `{ "mailToolsEnabled": false }` to the same endpoint.

The tools and email instructions appear on the next turn of eligible sessions in
that project. Revocation takes effect on every internal email HTTP request,
including tools loaded earlier and direct API fallback calls. Disabled or removed
projects have no session email access. This setting is independent of mailbox
OAuth access: selecting a project allows its sessions to use the connected
mailboxes; sending/filing still needs each mailbox's management consent.

## Connect a mailbox

The core needs its existing `GOOGLE_OAUTH_*` or `MICROSOFT_OAUTH_*` configuration
and `CREDENTIALS_KEY`. Configure the provider redirect URI as
`PUBLIC_BASE_URL/oauth/mail/callback` for automatic completion in the browser.
See the [mail API reference](api-v1-reference.md#post-settingsmailaccountsconnect).

Ask “Connect my Gmail for sending and managing email.” The agent calls
`mail_connect` with `provider: gmail` and `access: manage`, then provides the
provider's sign-in URL. Sign in yourself and consent; the agent never needs your
password. For an existing connection it also passes the `accountId` from
`mail_accounts` to reconnect that mailbox. If the configured redirect ends on
this server, `mail_accounts` shows completion; otherwise pass the final redirect
URL to `mail_finish_connect` promptly.

Connections default to `access: read`. Existing mailboxes keep their current
read-only grant until reconnected with `access: manage`. Management requests
[Gmail's gmail.modify permission](https://developers.google.com/workspace/gmail/api/auth/scopes)
or Outlook's Mail.ReadWrite and
[Mail.Send permission](https://learn.microsoft.com/en-us/graph/api/user-sendmail?view=graph-rest-1.0).
The admin API also accepts `access` on `POST /api/v1/settings/mail/accounts/connect`.

## Behavior and access

Email is the operator's own data: eligible interactive chats in opted-in projects can access all
connected mailboxes. Other projects have no access. Worker, review, QA, read-only analyst,
preview, closed and failed sessions are refused, as are unattended delivery turns.
These checks run at every HTTP request, even if a turn already loaded the tools.
No tools disconnect mailboxes or permanently delete messages.

Search reads the server's synced copy within each account's `syncDays` window,
not the entire historical mailbox. `q` is a text search rather than Gmail query
syntax. `mail_search` pages using `nextCursor`; `mail_read` returns the body and
attachment metadata and does not mark the email read. `mail_sync` starts a refresh;
follow `syncing` and `lastSyncAt` in `mail_accounts` before searching again.
Attachment downloads and uploads are not included.

Sending and replying use plain text. Replies go to the original email's Reply-To
address (or sender) and keep Gmail threading. `mail_update` supports `read`,
`unread` and `archive`; Outlook archive moves the email to the Archive folder.
After an action, the core syncs the provider's authoritative state, so the cached
message list may briefly show the previous state. A send response reports
provider acceptance, not confirmed delivery. An ambiguous timeout or server error
is never automatically retried: check Sent mail before requesting another send.

Agents are instructed to act only on the user's requests, ask about ambiguous
recipients/mailboxes, and treat email content as untrusted data rather than
instructions or authorization to act.
