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

The mailbox tools are `mail_accounts`, `mail_search`, `mail_read`, `mail_attachment`, `mail_sync`,
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
`mail_attachment` fetches one attachment (up to 25 MiB) live from the provider and
saves it to a private temporary file whose path it returns. Attachment uploads are not included.

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

## Faster sync with provider notifications

After deployment, enabled Outlook accounts automatically register Microsoft Graph
subscriptions to `me/messages` when `PUBLIC_BASE_URL` is HTTPS. Briareus registers
`/webhooks/mail/outlook` as both the change and lifecycle callback, echoes Graph’s
validation token, and checks each notification’s subscription id and secret
`clientState`. It renews subscriptions a day before their three-day expiry and
recovers lifecycle events with registration and a fresh delta sync.
See [Microsoft’s webhook contract](https://learn.microsoft.com/en-us/graph/change-notifications-delivery-webhooks).
The callback must be reachable without an interactive sign-in; allow provider
requests through any Cloudflare Access policy on `/webhooks/mail/*`.

Gmail requires a Google Cloud Pub/Sub topic and push subscription:

1. Enable Pub/Sub in the same Google Cloud project as the Gmail OAuth client.
2. Create a topic such as `projects/YOUR_PROJECT/topics/briareus-mail`.
3. Grant `gmail-api-push@system.gserviceaccount.com` the Pub/Sub Publisher role on that topic.
4. Generate a private random token (`openssl rand -hex 32`) and set `GMAIL_PUSH_TOPIC` and `GMAIL_PUSH_TOKEN` on the core server.
5. Create a wrapped JSON push subscription to `PUBLIC_BASE_URL/webhooks/mail/gmail?token=YOUR_TOKEN`, keeping that complete URL private.
6. Reload the core configuration after deployment; inspect `push` in the mailbox list for registration status.

The core registers each enabled Gmail mailbox with `users.watch` and renews it
daily. Topic/subscription creation happens in Google Cloud, not through the mailbox
OAuth grant. Gmail’s returned watch `historyId` never overwrites the sync cursor;
notifications only request another sync from the last saved cursor.
See [Google’s Gmail push setup](https://developers.google.com/workspace/gmail/api/guides/push).

Mailbox responses include `push: { active, expiresAt, lastError }`; subscription
secrets and credentials stay on the server. Registration errors appear in
`push.lastError` and retry after an hour while normal mail sync keeps working.
Disabling or disconnecting a mailbox stops its watch/subscription. Maintenance
continues every minute even with `MAIL_SYNC_MINUTES=0`, but retain polling for
recovery from delayed or dropped notifications. No additional mail write consent
is required for watches.

## Wake a session on incoming email

Ask a session, for example: “Wake up when a new email arrives in my Outlook
account addressed to alerts@example.com, from support@example.com, with outage
in the subject.” It can use `mail_wake_rules` to inspect its own rules and
`mail_set_wake_rules` to replace them. Each session keeps its own rules across
restarts; other sessions’ rules cannot be changed through these tools.

```json
{
  "rules": [
    {
      "account": 7,
      "to": "alerts@example.com",
      "from": "support@example.com",
      "subject": "outage"
    }
  ],
  "perHour": 30,
  "maxTurns": 10
}
```

`account` is required and comes from `mail_accounts`; optional `to` matches an
exact To/Cc address, `from` matches an exact sender, and `subject` matches a
substring. All comparisons ignore case. Filters in one rule combine with AND;
rules combine with OR. Up to 20 rules are allowed. `enabled: false` disables an
individual rule; `{ "rules": [] }` disables all email wakes. Preserve the returned
rule `id` when keeping a rule unchanged; changing a filter or reenabling a rule
starts its activation time again.

An admin client can read or replace the same configuration through
`GET/PUT /api/v1/sessions/{id}/mail-wake`. Project email access must be enabled.
Existing cached messages, messages older than rule activation, outgoing mail,
and read/label updates do not wake sessions. Only newly cached incoming inbox
messages qualify, through either push-triggered or periodic sync.

A wake includes the message id, addresses, subject and up to 6,000 characters of
plain-text body. It starts an unattended turn when the session is free and waits
behind running work, unanswered questions, or a turn stopped by the operator.
Duplicate emails do not create additional wakes. The hourly and automatic-turn
limits bound activity; messages refused by those limits wait in a bounded queue.
Closed and failed sessions are never reopened by email. Disabling a rule,
mailbox, or project access cancels its queued wakes before they can run.

Email contents remain untrusted information, and the session acts only within
instructions already given by the operator. Existing unattended restrictions
still apply: email management tools are unavailable during an automatic wake.
