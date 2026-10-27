# Server resource monitoring

The separate [Briareus Monitor](https://github.com/nadinyamaui/briareus-monitor)
service runs on each **Linux server with Python 3.10+ and systemd 247+** and sends
CPU, memory, local disks and per-interface network counters to the core over
**outbound HTTPS once a minute**. It is a small monitoring process, independent
of AI sessions, with no AI runtime, tokens billed by a model, third-party Python
packages or inbound ports. SSH is used only for initial installation and later
administration; the core never polls servers over SSH.

## Provision a server

Register the server in SSH settings, then call as an admin:

```http
POST /api/v1/settings/ssh/servers/123/monitor-token
Authorization: Bearer <admin-token>
```

The response contains `serverId`, `endpoint`, `token`, `intervalSeconds: 60` and
`retentionHours: 24`. Save that JSON as the service's **private configuration**,
transfer it through the normal approved SSH upload flow, and follow the monitor
repository's installer. Never commit or publish the config. The endpoint uses the
core's configured HTTPS `PUBLIC_BASE_URL`, not a hostname supplied by the caller.
The service runs under a restricted systemd dynamic user, using a credential file
and its own persistent state directory, with CPU and memory limits.

Issuing a credential enables `monitoringEnabled` and revokes its previous token.
The core stores only a SHA-256 hash, omits it from all server responses, and shows
the plaintext token only once. The credential grants **only sample ingestion for
one server**, never SSH commands or access to operator/session APIs. Existing and
new servers default to monitoring off. Agent SSH permission modes remain unchanged.

`DELETE /api/v1/settings/ssh/servers/123/monitor-token` revokes the credential and
disables ingestion. Setting `monitoringEnabled: false`, disabling or removing the
server also rejects uploads immediately. Changing its host, port, username or
project revokes its token and disables monitoring; issue and install a new token
for the new target. To stop the remote process itself, disable its systemd service.

## Machine ingress

The monitor posts to `/api/v1/telemetry/ssh/:id/samples` with its dedicated bearer
credential and a JSON body `{samples:[{at,raw}]}`. This machine route is authenticated
before the operator API gateway, under the existing native API Cloudflare Access
bypass; neither operator/device tokens nor agent tokens work here. Its credential
also cannot authenticate any operator or session endpoint. TLS verification stays
on and the monitor refuses redirects.

A request accepts 1–10 snapshots, at most 1 MiB total and 64 KiB per snapshot. The
core validates every sample before writing, sorts buffered samples by capture time,
computes CPU/network rates against persisted counters, and stores one sample per
minute. It acknowledges `{received, accepted}`; duplicate/older samples are
acknowledged without overwriting newer data. Concurrent uploads for the same host
receive 429. Retries after partial persistence remain safe. Clocks must be synced:
capture times more than 30 seconds in the future are rejected, and samples older
than 24 hours are acknowledged and discarded.

## Read current resources and history

`GET /api/v1/ssh/servers` returns summaries with `latest`, `stale`, interval and
retention metadata, without SSH keys or credentials. `GET
/api/v1/ssh/servers/123/resources` returns the rolling history as `samples` ordered
oldest first. Optional `?since=<Unix milliseconds>` supports incremental reads and
is clamped to the last 24 hours. Both endpoints require an ordinary `read` token.
Members see only shared SSH servers within their token's projects; project-limited
admin tokens stay within that limit. An inaccessible server returns 404.

Each sample contains a minute bucket `at` (Unix milliseconds), `metrics`, and
`error` (reserved, null for received samples). Metrics include:

- CPU: cores, aggregate usage percent from 0–100, and 1/5/15 minute load.
- Memory: total, available, used and swap bytes and used percent, using `MemAvailable`.
- Disk: total, used, available bytes and used percent per local mounted filesystem;
  reserved blocks are unavailable, network/automount and pseudo mounts are excluded,
  and bind mounts are deduplicated.
- Network: receive/transmit counters and bytes per second per interface, excluding
  loopback; summing virtual and physical interfaces can double count traffic.

Rates are null until two valid samples on the same boot exist, and reset when
counters reset. Raw counters and boot identity stay private in storage, restoring
baselines after core restarts. Missing samples remain gaps rather than fabricated
zero usage. `stale` is true for absent or more-than-two-minute-old samples.

## Retention and outages

The core persists samples in MySQL's `ssh_resource_samples`. Reads exclude anything
older than 24 hours; a global cleanup deletes expired rows every minute, even with
no enabled hosts. Cleanup resumes after core/database downtime. A changed target
has a separate history so its new project cannot read the previous target's data.

The remote service also keeps a durable SQLite spool of up to 24 hours, 1440 samples
and 16 MiB of payload while the network/core is unavailable; large snapshots may
shorten that buffered window. On recovery it drains oldest first, up to six batches
per minute, continuing collection. It survives service and host restarts, but cannot
sample while the host is powered off. No recurring SSH connection is involved.

The native client repositories are outside this change; these endpoints provide
resource summaries and histories for a client to display.
