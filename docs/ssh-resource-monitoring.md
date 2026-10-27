# SSH resource monitoring

Briareus can install a small resource collector on registered **Linux servers
with Python 3** and poll it over the existing SSH connection once a minute.
Collection belongs to the core, so it continues independently of agent sessions
and connected clients. No root access, package manager, open port, remote daemon,
third-party monitoring service or extra credentials are required.

## Enable a server

An admin opts each server in with:

```http
PUT /api/v1/settings/ssh/servers/123
Authorization: Bearer <admin-token>
Content-Type: application/json

{"monitoringEnabled": true}
```

Existing and newly registered servers default to `false`. An enabled server
with `monitoringEnabled: true` authorizes the core to install and invoke **only
the fixed collector**, even if agent commands require approval (`ask` mode).
This does not authorize agent commands or change their approval policy.
The first collection happens on the next minute tick, or immediately at boot.

The file is `~/.local/share/briareus/resource-monitor-v1.py`, installed as the
SSH user with mode 0600 and replaced atomically when the bundled collector changes.
Python itself must already be installed. Set `monitoringEnabled: false` to stop
polling; disabling or removing the SSH server stops it too. The inactive script
can remain on disk: it has no timer or background process.

## Read current resources and history

`GET /api/v1/ssh/servers` returns server summaries, each with `latest` and `stale`,
plus `intervalSeconds: 60` and `retentionHours: 24`. It omits SSH keys and passwords.
`GET /api/v1/ssh/servers/123/resources` returns the rolling history as `samples`
ordered oldest first. Optional `?since=<Unix milliseconds>` supports incremental
reads and is always clamped to the last 24 hours. Both endpoints require `read`.
Members can read only shared SSH servers in their token's projects; admin tokens
limited to projects stay within that limit. An inaccessible server answers 404.

Each sample contains a minute bucket `at` (Unix milliseconds), `metrics`, and
`error`. Metrics include:

- CPU: number of cores, aggregate usage percent from 0–100, and 1/5/15 minute load.
- Memory: total, available, used and swap bytes, plus used percent; reclaimable
  cache is available memory, using Linux `MemAvailable`.
- Disk: total, used, available bytes and used percent per local mounted filesystem;
  reserved blocks are excluded from the available space. Network/automount and
  pseudo filesystems are excluded, and bind mounts are deduplicated.
- Network: receive/transmit byte counters and bytes per second **per interface**,
  excluding loopback. Virtual interfaces remain separate; summing them with their
  physical interfaces can double count traffic.

CPU and network rates average the interval between valid samples; they are null
on the first sample, after a reboot or counter reset, or without a baseline.
Raw counters and boot identity are stored privately to restore baselines after a
core restart. The response never exposes them. A failed collection has
`metrics: null` and a safe `error`, never zero-filled resource usage or raw SSH
output. `stale` is true for absent, failed or more-than-two-minute-old samples.

Clients can build a server list from the summaries and charts from each server's
history, refresh once a minute while visible, merge samples by `at`, remove points
outside the window, and leave gaps for failed/missing samples. Native client
screens are maintained in their separate repositories; this core change provides
the collection and API, without adding a screen to those clients.

## Retention and operation

Samples persist in MySQL in `ssh_resource_samples`. Reads always exclude data
older than 24 hours; a global cleanup deletes expired rows every minute even if
all servers are disabled, removed or unreachable. Cleanup resumes at boot. The
core cannot delete rows while it or MySQL is offline, and cannot backfill missed
samples. A changed host, port, username or project starts a separate history so
metrics from an old target are not disclosed with the new one.

Up to four SSH collections run concurrently, with a 30-second timeout each and
no overlapping collection cycles. Database failures prevent collection until
storage recovers. Large registries or slow hosts can produce gaps; the interval
is a sampling target rather than a guarantee. Stopping the core stops the timer.
No server-side change to `permissionMode` or sudo credentials is needed.
