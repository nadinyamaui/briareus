# WhatsApp inbox through WAHA

Briareus core exposes the operator’s WhatsApp inbox at `/api/v1/whatsapp`.
It uses the same admin token as the other business inboxes, independently of
projects and agent sessions. WAHA keeps the phone link and chat history;
Briareus does not copy messages into its database or agent transcripts.

The core has no UI. Windows, iOS or a server-side client can use the endpoints
below to implement an inbox; this change adds the core API, not client screens.

## Install on the core’s machine

With Docker, Docker Compose and Node installed, run:

```sh
npm run install:waha
```

The installer selects the x86 or ARM image, pins its resolved digest, generates
an API key, and runs WAHA at `http://127.0.0.1:8203` with `unless-stopped` restart
policy. It stores configuration in `~/.config/briareus/waha/.env` with mode 600,
outside the disposable checkout. Session and media data use the named Docker
volumes `briareus-whatsapp_sessions` and `briareus-whatsapp_media`. Re-running
keeps the key, image version and volumes. Do not use `docker compose down -v`
unless you intend to remove the WhatsApp link and stored data.

Set this in the core’s `.env` or service environment, using the absolute path
printed by the installer, then restart the core after deploying the code:

```dotenv
WAHA_CONFIG_FILE=/home/your-user/.config/briareus/waha/.env
```

The installer accepts `WAHA_INSTALL_DIR`, `WAHA_PORT`, `WAHA_IMAGE` and
`WAHA_ENGINE` on its first run (the engine defaults to `WEBJS`).
An existing install keeps its saved configuration. To upgrade,
change `WAHA_IMAGE` in the private file to a reviewed image tag/digest and run
`docker compose --project-directory ~/.config/briareus/waha up -d`.

To switch to NOWEB when browser-engine pairing codes fail, set
`WAHA_ENGINE=NOWEB` in the private installation’s `.env` and run
`npm run install:waha` from the updated checkout. For a custom installation
directory, set `WAHA_INSTALL_DIR` to that same directory. This refreshes the
installed Compose template while retaining the saved image, key and volumes.
NOWEB protocol auto-updates (`WAHA_NOWEB_WA_VERSION=auto-web`) require WAHA
2026.8.1 or newer. If the saved image is older, first update `WAHA_IMAGE` in the
private `.env` to a reviewed tag/digest for a supported version, following the
upgrade instructions above; rerunning the installer preserves the saved image.
On supported versions, NOWEB fetches the current WhatsApp protocol version on
startup by default. Override `WAHA_NOWEB_WA_VERSION` in the private `.env` if a
fixed version is required; also set `WAHA_NOWEB_WA_VERSION_FORCE=True` to use a
version lower than WAHA’s built-in version. The force flag defaults to `False`.
After changing these protocol settings, rerun `npm run install:waha` to apply
them. See the [NOWEB configuration guide](https://waha.devlike.pro/docs/engines/noweb/#configuration).
The core enables NOWEB’s history store and
full sync when creating an account, so chat/history endpoints remain usable.
For an existing NOWEB account created outside Briareus, enable its store
before linking a phone, following the [NOWEB guide](https://waha.devlike.pro/docs/engines/noweb/#enable-store).
Engines keep authentication in separate storage namespaces, so switching can
require linking the phone again; existing session volumes are retained.

For a core running in Docker, pass `WAHA_URL` and `WAHA_API_KEY` in the app’s
environment instead. `127.0.0.1` inside that app container is the container
itself: put WAHA on a reachable private Docker network and use its service name,
for example `http://waha:3000`. Both values are required. Never expose WAHA’s
port or put its key in a client. The core strips all `WAHA_*` variables from
child-process environments.

WAHA Dashboard and Swagger are disabled in this installation; pairing and
inbox access go through Briareus’s authenticated API. Inspect the service with:

```sh
docker compose --project-directory ~/.config/briareus/waha ps
docker compose --project-directory ~/.config/briareus/waha logs --tail 100
```

## Link a phone and use the inbox

Every call needs `Authorization: Bearer <admin-token>`; read/manage tokens
cannot access the inbox. Paths below are relative to `/api/v1`.

1. `GET /whatsapp/accounts` returns `{ configured, accounts }`; each account
   has `{ id, status, me: { id, name } | null }`.
2. `POST /whatsapp/accounts/default/start` creates and starts the free WAHA
   Core account, or reconnects it when stopped/failed. Existing Plus accounts
   are available by their own IDs.
3. Poll `GET /whatsapp/accounts/default` until `status` is `SCAN_QR_CODE`.
4. `GET /whatsapp/accounts/default/qr` returns `{ mimetype: "image/png", data }`
   with base64 PNG data. Display the QR and refresh it periodically while the
   account is waiting for a scan; do not persist it. On the phone, choose
   WhatsApp → Linked devices → Link a device. Continue polling status until
   `WORKING`.
5. `GET /whatsapp/accounts/default/conversations?limit=50&offset=0` returns
   `{ conversations, nextOffset }`. Each chat has `{ id, name, unreadCount,
lastMessage }`; `unreadCount` can be null when WAHA omits it.
6. `GET /whatsapp/accounts/default/conversations/{chat}/messages` returns
   `{ messages, nextOffset }`, newest first. Use the chat ID returned by WAHA
   and URL-encode path parameters. Chats can be phone IDs, groups or LIDs.
7. `POST /whatsapp/accounts/default/conversations/{chat}/messages` with
   `{ "text": "Hello" }` sends immediately as the linked account and returns
   201 with `{ message }`. Add `replyTo` with an existing message ID to quote
   it. New direct chats can use an international number without `+`, followed
   by `@c.us`, such as `49123456789@c.us`.
8. `POST /whatsapp/accounts/default/conversations/{chat}/read` marks unread
   messages read; call it when the operator chooses to read the chat.
9. `GET /whatsapp/accounts/default/conversations/{chat}/messages/{message}/media`
   downloads an attachment through the core. The response carries the media
   type and `Content-Disposition: attachment`; clients can save it and open an
   appropriate viewer. WAHA local file storage is required. Availability
   depends on the installed edition/engine (501 when unsupported).
10. `POST /whatsapp/accounts/default/logout` unlinks the phone. Require an
    explicit operator action for this in clients.

Refresh connection status, chats and the visible chat’s first history page
every five seconds while the inbox is visible, and reload after reconnecting.
Merge refreshed messages by `id`. History and chat pagination accept `limit`
(1–100) and `offset` (0–100000); `nextOffset: null` ends pagination. Message
history advances by the requested limit even for short or empty pages, because
WAHA can filter out protocol records after paging. It has no reliable end-of-history
indicator; message `nextOffset` becomes null at the supported offset bound.
New arrivals can shift offsets, so discard cached page positions on a full refresh.

Message `replyTo` is null or quoted context `{ id, participant, text, hasMedia }`.
Use that context to display a quote even when the original is outside loaded
history. Its `id` is WAHA's engine quote identifier (often a raw stanza ID),
which can differ from the full message `id` and is null when unavailable.
For outgoing quoted replies, pass the original full message `id` from history
as the POST body's `replyTo`, rather than this quote identifier.

Never automatically retry a failed send: WAHA may have accepted the message
before a connection or receipt failed. Check the conversation first. Errors
are 503 when disabled, 404 for missing accounts/messages, 409 for refused
operations or invalid connection state, 429 for rate limits, and 502 for WAHA
connection/authentication failures. WAHA credentials, raw engine data, session
configuration and machine-local attachment URLs are omitted from responses.

The catalog and [API reference](api-v1-reference.md) document every endpoint
and message field. Installation and endpoints follow WAHA’s official
[installation guide](https://waha.devlike.pro/docs/how-to/install/),
[session API](https://waha.devlike.pro/docs/how-to/sessions/) and
[chat API](https://waha.devlike.pro/docs/how-to/chats/).

## WhatsApp from a session

Interactive sessions receive the internal `reviewer_whatsapp` MCP only when
their project enables WhatsApp tools. It defaults to **off** for existing and
new projects; an operator with an admin token opts a project in through
`PUT /api/v1/settings/projects/{id}` with `{ "whatsappToolsEnabled": true }`
and revokes it with `false`. The setting is independent of `mailToolsEnabled`
and of the project’s Slack workspace, so each channel is enabled per project.

The tools are `whatsapp_accounts`, `whatsapp_conversations`,
`whatsapp_messages`, `whatsapp_media`, `whatsapp_send`,
`whatsapp_create_group`, `whatsapp_watches`, `whatsapp_watch`,
`whatsapp_unwatch` and `whatsapp_mark_read`, served under
`/api/agent/whatsapp` with the session’s
own token. They use the same WAHA service as the admin inbox; linking, the
pairing QR and logout stay admin-only. `whatsapp_media` downloads one message’s
media (up to 25 MiB, like mail attachments) to a private temporary file and
returns its path, so the agent can open images and documents with its file
tools. `whatsapp_create_group` opens a group with the given contacts, the
operator as its admin. The tools and instructions appear on the next turn of
an eligible session, and revocation applies to every request at once,
including tools loaded earlier and direct HTTP fallback calls.

As with email, review, QA, worker, read-only and preview sessions never get
them. Messages go out as the operator, so the agent sends only what the user
asked for.

### Replies come back to the session

Sending in a chat, or opening a group, leaves a **watch** on it for 24 hours
from the session’s last message there (`watch: false` skips it). While it
lasts, what other people write in that chat reaches the session as a delivery,
labelled as a WhatsApp reply and never as the operator’s word, and starts a
turn when the session is free. So a session asked to “ask Guillo whether he
wants a group” can take his answer, follow up and report back on its own. A
watch nobody answers lapses; `whatsapp_watch` extends one (at most 72 hours
from now) and `whatsapp_unwatch` ends it. A session keeps at most 20.

A turn started by a delivery is one nobody is watching, so it gets the
WhatsApp tools only for the chats this session is watching: it can read,
open media, mark read and answer there, and cannot list the accounts or the
inbox, open a group or start a watch on another chat. Such replies share the
webhook caps: 30 deliveries an hour and 10 automatic turns in a row before the
session waits for a word from the operator.

Voice notes arrive already transcribed, the way an email wake carries its body:
before the delivery, the core downloads the recording from WAHA and sends it
to OpenAI with the same `OPENAI_TRANSCRIBE_API_KEY` and
`OPENAI_TRANSCRIBE_MODEL` as the composer’s voice notes, so the session never
has to download or transcribe audio itself. The delivery shows the text and
still names the message, for `whatsapp_media` if the recording is wanted. A
voice note is transcribed once, even while its delivery waits for the session;
when the transcription fails, the note is delivered with the reason and a
pointer to `whatsapp_media`. Without those keys, or for an audio format OpenAI
does not accept, voice notes arrive as before, as media to open. Neither the
recording nor its text is kept by the core.

The core reads the watched chats from WAHA every 15 seconds (nothing else of
the inbox), so no WAHA webhook has to reach it. Watches and the ids of the
messages already delivered are kept in `app_settings` (`whatsapp_watches`), so
a restart neither loses nor repeats a reply. Only the 20 newest messages of a
chat are read per poll. A reply the session cannot take just then (a restart
drain, no free slot, or a cap until the operator speaks, noted once in the
transcript) is read again on the next poll, even once its watch has lapsed:
such a watch stays until those replies are taken, and writing there again
renews it with them. Watches end with their
session, or when the project turns WhatsApp tools off, which also drops the
replies still waiting for the session.
