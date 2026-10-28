# CI/CD statistics

The core retains observed GitHub Checks and legacy commit statuses in MySQL,
independently of the PR board. A PR head change, retry or core restart does not
erase earlier executions. No client changes are required to start collection.

Collection uses the existing GitHub token and signed repository webhooks:

- PR synchronization records checks on the current head, including available
  older attempts, and all legacy status transitions.
- `check_run`, `check_suite`, `status` and `push` deliveries refresh authoritative
  checks for the affected commit, including checks without a PR; bursts of matrix
  job notifications are coalesced by commit.
- The hourly GitHub sync also reads the default branch's current commit and
  revisits up to 100 commits with pending checks per repository in rotating SHA
  order, to recover completions missed by webhooks. Failed webhook discoveries
  remain queued in memory for hourly retry, up to 100 per repository per pass.
  Restarting the core clears these discovery retries.
  Recovery alternates turns ahead of bulk PR downloads and rotates its first
  source so repeated quota exhaustion cannot always exclude the same work.
  Delivered check and suite IDs are fetched directly when the commit list omits
  them. Each fully paginated source is saved independently; incomplete pages
  are never published. Permission denials are reported and retained for retry.
  Validated PR snapshots can save while failed history remains queued separately.

The GitHub credential needs read access to checks and commit statuses on the
repositories being tracked. Unreadable lists never delete stored observations.
Collection errors appear in the existing GitHub sync error reporting. The ledger
starts with checks observed after deployment; it does not crawl every historical
commit. A non-default branch without a PR relies on webhook delivery for discovery.
No workflows are triggered by collection, and no logs or artifacts are downloaded.

## Dashboard API

Both endpoints accept a Briareus bearer token with `read` permission. They filter
every query to the token's projects and the member's current project shares.
An explicit inaccessible `repo` returns 403. Use the API from a native client or
the dashboard's backend; the API's existing browser Origin restriction applies.

```http
GET /api/v1/stats/ci?repo=acme/shop
Authorization: Bearer <token>

GET /api/v1/ci/runs?repo=acme/shop&branch=main&limit=50
Authorization: Bearer <token>
```

`/stats/ci` returns `totals`, `daily`, `repositories` and `checks`. Each group
includes counts for success, failure, pending, cancelled, skipped and other
terminal results, a success rate, and mean/maximum/total duration in milliseconds.
`lastObservedAt` indicates the most recent accepted observation in that group;
it is not a guarantee that GitHub has no newer results. Daily series use UTC dates,
are ordered oldest first and omit empty days; a dashboard may fill those gaps.

`/ci/runs` returns individual executions with commit SHA, branch hint, GitHub App,
status, conclusion, details URL and timestamps. Use `nextOffset` for pagination
until null, keeping the same `since` and `until`. Concurrent collection can shift
offset pages, so refresh the list when exact reconciliation is needed. If more
results exist beyond the supported offset range, `nextOffset` is null and
`truncated` is true; narrow the time window or filters to retrieve those results.

Shared optional filters are `repo`, `branch`, `name`, `kind`, `status`, `conclusion`,
`since` and `until`. `since` is inclusive and `until` exclusive, both epoch
milliseconds; the default is the last 30 days, with a maximum window of 366 days.
The window applies to execution start time, falling back to legacy creation time
or first observation when no start is available. `limit` (1–100, default 50) and
`offset` (0–100000, default 0) apply only to `/ci/runs`.

## Counting and timing

- The default `kind=check_run` counts distinct GitHub check-run IDs per repository.
  Polls, duplicate deliveries and a check shared by multiple PRs count once;
  retries with new IDs count separately. Overall workflow runs and individual
  jobs are not combined into a single pipeline count.
  Providers that reset an existing check ID update that record instead of
  adding an inferred attempt.
- `kind=status` reports legacy statuses separately, keeping the latest transition
  per commit SHA and case-insensitive context. Pending and success notifications count as
  one result. Legacy statuses do not provide execution duration or reliable
  attempt identity, so retry counts and durations are not inferred.
- `successRate = succeeded / (succeeded + failed)`, or null without decided results.
  Failed includes `failure`, `error`, `timed_out`, `startup_failure` and
  `action_required`; cancelled, skipped/neutral, pending and unknown terminal
  conclusions are reported separately and excluded from that denominator.
- `timed` counts records with valid start/completion timestamps. Unknown or reversed
  timestamps do not enter duration averages; absent duration is null rather than
  zero. Total duration sums executions, including parallel jobs; it is neither
  elapsed pipeline time nor billed runner usage.
- Branch is a hint from the check or its first known context; one SHA may exist
  on multiple branches. A check without a known branch is still counted in
  unfiltered results.

The generated [API reference](api-v1-reference.md) and `/api/v1/openapi.json`
describe the response fields. The additive `ci_checks` migration runs during normal
core startup; it does not modify the existing PR snapshot tables. There is no
automatic pruning of this ledger.

## Verification

The normal unit suite covers normalization, permissions through the API gateway,
webhook collection and periodic recovery. To verify SQL, migrations, aggregation,
rollback and persistence against a real MySQL server using the checkout's DB
credentials, run:

```sh
PREVIEW_HOSTNAME= PREVIEW_ACCESS_EMAILS= CI_STORE_MYSQL=1 npm test -- test/ci-store.mysql.test.js
```

This creates and drops only a randomly named scratch database; it requires database
creation privileges and does not use the configured application database.
