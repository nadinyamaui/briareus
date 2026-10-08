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

The installer accepts `WAHA_INSTALL_DIR`, `WAHA_PORT` and `WAHA_IMAGE` on its
first run. An existing install keeps its saved configuration. To upgrade,
change `WAHA_IMAGE` in the private file to a reviewed image tag/digest and run
`docker compose --project-directory ~/.config/briareus/waha up -d`.

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
