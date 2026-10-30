// @ts-check
import { createHash } from 'node:crypto';
import { githubStoreConnection } from './db.js';

export const CI_MAX_OFFSET = 100000;

const timestamp = (value) => {
  const ms = Date.parse(value);
  return Number.isFinite(ms) && ms >= 0 ? ms : null;
};

export function ciCheck(raw, { sha = '', branch = null, observedAt = Date.now() } = {}) {
  const kind = raw.context ? 'status' : 'check_run';
  const headSha = raw.head_sha || raw.sha || sha;
  const name = raw.context || raw.name;
  if (!raw.id || !headSha || !name) throw new Error('Incomplete CI check');
  const startedAt = kind === 'check_run' ? timestamp(raw.started_at) : null;
  const completedAt = kind === 'check_run' ? timestamp(raw.completed_at) : null;
  return {
    kind,
    // Legacy statuses describe transitions, not executions. Keep the latest state
    // per SHA/case-insensitive context; counting transitions inflates totals.
    external_key:
      kind === 'status'
        ? createHash('sha256').update(`${headSha}\0${name.toLowerCase()}`).digest('hex')
        : String(raw.id),
    github_id: raw.id,
    name,
    app: raw.app?.slug || null,
    head_sha: headSha,
    branch: raw.check_suite?.head_branch || branch,
    status: kind === 'check_run' ? raw.status : raw.state === 'pending' ? 'in_progress' : 'completed',
    conclusion: kind === 'check_run' ? raw.conclusion || null : raw.state === 'pending' ? null : raw.state,
    url: raw.details_url || raw.target_url || raw.html_url || null,
    started_at: startedAt,
    completed_at: completedAt,
    duration_ms:
      raw.status === 'completed' && startedAt != null && completedAt != null && completedAt >= startedAt
        ? completedAt - startedAt
        : null,
    run_at: startedAt ?? timestamp(raw.created_at) ?? observedAt,
    observed_at: observedAt,
  };
}

// A GitHub Actions job, from the workflow_job webhook or the run's jobs list.
// Queued jobs have no runner yet; a completed job without one never got a
// runner (cancelled while queued) and is recorded so it is not fetched again.
export function ciRunner(job, recordedAt = Date.now()) {
  if (!job?.id) throw new Error('Incomplete CI job');
  if (!job.runner_name && job.status !== 'completed') return null;
  const labels = Array.isArray(job.labels) ? job.labels.filter((l) => typeof l === 'string') : [];
  return {
    job_id: String(job.id),
    run_id: Number.isSafeInteger(job.run_id) ? job.run_id : null,
    runner_name: job.runner_name || null,
    runner_group: job.runner_group_name || null,
    runner_labels: labels.length ? JSON.stringify(labels) : null,
    recorded_at: recordedAt,
  };
}

// The Actions run behind a check run, from its details URL.
export function ciRunId(url) {
  const match = /\/actions\/runs\/(\d+)\/job\/\d+/.exec(url || '');
  return match ? match[1] : null;
}

// Hourly rate per runner group, bound into the query so a rate change applies
// to the whole history. Unpriced rows (no runner, or a group without a rate)
// stay NULL and are kept out of cost rather than counted as free. Compared as
// binary: the column's PAD SPACE collation would match "Default " to "Default".
function rateSql(rates = {}) {
  const entries = Object.entries(rates);
  if (!entries.length) return { sql: 'NULL', values: [] };
  return {
    sql: `CASE CAST(r.runner_group AS BINARY) ${entries.map(() => 'WHEN CAST(? AS BINARY) THEN ?').join(' ')} END`,
    values: entries.flat(),
  };
}

// Checks with their runner. MySQL merges this derived table into the outer
// query, so the window indexes on ci_checks still apply.
function source(rates) {
  const rate = rateSql(rates);
  return {
    sql: `(SELECT c.*, r.run_id, r.runner_name, r.runner_group, r.runner_labels, ${rate.sql} AS rate
      FROM ci_checks c LEFT JOIN ci_runners r
        ON c.kind = 'check_run' AND r.repo = c.repo AND r.job_id = c.external_key) t`,
    values: rate.values,
  };
}

const METRICS = `COUNT(*) AS total,
  SUM(status <> 'completed') AS pending,
  SUM(status = 'completed' AND conclusion = 'success') AS succeeded,
  SUM(status = 'completed' AND conclusion IN ('failure','error','timed_out','startup_failure','action_required')) AS failed,
  SUM(status = 'completed' AND conclusion = 'cancelled') AS cancelled,
  SUM(status = 'completed' AND conclusion IN ('neutral','skipped')) AS skipped,
  SUM(status = 'completed' AND (conclusion IS NULL OR conclusion NOT IN
    ('success','failure','error','timed_out','startup_failure','action_required','cancelled','neutral','skipped'))) AS other,
  COUNT(duration_ms) AS timed,
  AVG(duration_ms) AS avgDurationMs,
  MAX(duration_ms) AS maxDurationMs,
  COALESCE(SUM(duration_ms), 0) AS totalDurationMs,
  COALESCE(SUM(IF(rate IS NULL, NULL, duration_ms)), 0) AS pricedDurationMs,
  SUM(duration_ms * rate) / 3600000 AS cost,
  MAX(observed_at) AS lastObservedAt`;

function metrics(row) {
  const result = Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      key,
      ['repo', 'name', 'app', 'day', 'runnerGroup', 'runnerName'].includes(key)
        ? value
        : value == null
          ? ['avgDurationMs', 'maxDurationMs', 'lastObservedAt', 'cost'].includes(key)
            ? null
            : 0
          : Number(value),
    ]),
  );
  result.unpricedDurationMs = (result.totalDurationMs || 0) - (result.pricedDurationMs || 0);
  result.successRate =
    Number(result.succeeded) + Number(result.failed)
      ? Number(result.succeeded) / (Number(result.succeeded) + Number(result.failed))
      : null;
  return result;
}

// All query values are bound; grouping and ordering identifiers are fixed here.
export function createCiStore({ connection = () => githubStoreConnection() } = {}) {
  const pendingCursors = new Map();

  async function save(repo, rows, hints = {}) {
    if (!rows.length) return;
    const checks = rows.map((raw) => ({ repo: repo.toLowerCase(), ...ciCheck(raw, hints) }));
    const c = await connection();
    try {
      await c.beginTransaction();
      for (const check of checks) {
        const keys = Object.keys(check);
        // Refetches and duplicate webhooks are idempotent. Check runs come from
        // authoritative reads (a provider may reset an existing ID to queued).
        // Legacy transition IDs order updates even within the same second.
        const newer = `VALUES(observed_at) >= observed_at
          AND (kind <> 'status' OR VALUES(github_id) >= github_id)`;
        // MySQL evaluates assignments left to right: update ordering fields last.
        const updates = [
          ...keys.filter(
            (key) => !['repo', 'kind', 'external_key', 'github_id', 'observed_at'].includes(key),
          ),
          'github_id',
          'observed_at',
        ];
        const valueOf = (key) => {
          if (key === 'branch') return 'COALESCE(branch, VALUES(branch))';
          if (key === 'run_at') return 'COALESCE(VALUES(started_at), LEAST(run_at, VALUES(run_at)))';
          return `VALUES(${key})`;
        };
        await c.query(
          `INSERT INTO ci_checks (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})
           ON DUPLICATE KEY UPDATE ${updates
             .map((key) =>
               key === 'run_at' && check.kind === 'status'
                 ? 'run_at = LEAST(run_at, VALUES(run_at))'
                 : `${key} = IF(${newer}, ${valueOf(key)}, ${key})`,
             )
             .join(',')}`,
          keys.map((key) => check[key]),
        );
      }
      await c.commit();
    } catch (e) {
      await c.rollback();
      throw e;
    } finally {
      c.release();
    }
  }

  async function saveRunners(repo, jobs, recordedAt = Date.now()) {
    const rows = jobs.map((job) => ciRunner(job, recordedAt)).filter(Boolean);
    if (!rows.length) return;
    const c = await connection();
    try {
      for (const row of rows)
        // A job keeps its runner for life (a re-run is a new job), so a later
        // read without one never erases what an earlier read recorded.
        await c.query(
          `INSERT INTO ci_runners (repo, job_id, run_id, runner_name, runner_group, runner_labels, recorded_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE run_id = COALESCE(VALUES(run_id), run_id),
             runner_name = COALESCE(VALUES(runner_name), runner_name),
             runner_group = COALESCE(VALUES(runner_group), runner_group),
             runner_labels = COALESCE(VALUES(runner_labels), runner_labels),
             recorded_at = GREATEST(recorded_at, VALUES(recorded_at))`,
          [
            repo.toLowerCase(),
            row.job_id,
            row.run_id,
            row.runner_name,
            row.runner_group,
            row.runner_labels,
            row.recorded_at,
          ],
        );
    } finally {
      c.release();
    }
  }

  // The job IDs among `ids` whose runner is not recorded yet.
  async function missingRunners(repo, ids) {
    if (!ids.length) return [];
    const c = await connection();
    try {
      const [rows] = await c.query(
        `SELECT job_id FROM ci_runners WHERE repo = ? AND job_id IN (${ids.map(() => '?').join(',')})`,
        [repo.toLowerCase(), ...ids],
      );
      const known = new Set(rows.map((row) => row.job_id));
      return ids.filter((id) => !known.has(id));
    } finally {
      c.release();
    }
  }

  function where(filters) {
    const clauses = ['kind = ?', 'run_at >= ?', 'run_at < ?'];
    const values = [filters.kind, filters.since, filters.until];
    if (filters.repos != null) {
      if (!filters.repos.length) clauses.push('FALSE');
      else {
        clauses.push(`repo IN (${filters.repos.map(() => '?').join(',')})`);
        values.push(...filters.repos.map((repo) => repo.toLowerCase()));
      }
    }
    for (const [key, column] of [
      ['branch', 'branch'],
      ['name', 'BINARY name'],
      ['status', 'status'],
      ['conclusion', 'conclusion'],
      ['runnerGroup', 'runner_group'],
      ['runner', 'runner_name'],
    ])
      if (filters[key] != null) {
        clauses.push(`${column} = ?`);
        values.push(filters[key]);
      }
    return { sql: clauses.join(' AND '), values };
  }

  async function stats(filters, rates = {}) {
    const c = await connection();
    try {
      // A consistent snapshot keeps totals and chart groups in agreement while
      // webhook writes continue on another connection.
      await c.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
      await c.beginTransaction();
      const from = source(rates);
      const { sql, values: filtered } = where(filters);
      const values = [...from.values, ...filtered];
      const [[total]] = await c.query(`SELECT ${METRICS} FROM ${from.sql} WHERE ${sql}`, values);
      const groups = {};
      for (const [key, select, group, order = group] of [
        ['daily', 'FLOOR(run_at / 86400000) * 86400000 AS day', 'day'],
        ['repositories', 'repo', 'repo'],
        // TEXT sorting can truncate at MySQL's max_sort_length. Group full
        // byte identities, including trailing spaces, using fixed-size hashes.
        [
          'checks',
          'MIN(name) AS name, MIN(app) AS app',
          'SHA2(name, 256), SHA2(app, 256)',
          'MIN(BINARY name), MIN(BINARY app)',
        ],
        // A null group holds checks without a recorded runner: other GitHub
        // Apps' checks and Actions jobs not attributed yet.
        ['runnerGroups', 'runner_group AS runnerGroup', 'runner_group'],
        ['runners', 'runner_group AS runnerGroup, runner_name AS runnerName', 'runner_group, runner_name'],
      ]) {
        const [rows] = await c.query(
          `SELECT ${select}, ${METRICS} FROM ${from.sql} WHERE ${sql} GROUP BY ${group} ORDER BY ${order}`,
          values,
        );
        groups[key] = rows.map((row) =>
          metrics(
            key === 'daily' ? { ...row, day: new Date(Number(row.day)).toISOString().slice(0, 10) } : row,
          ),
        );
      }
      await c.commit();
      return { totals: metrics(total), ...groups };
    } catch (e) {
      await c.rollback();
      throw e;
    } finally {
      c.release();
    }
  }

  async function runs(filters, { limit = 50, offset = 0, rates = {} } = {}) {
    const c = await connection();
    try {
      const from = source(rates);
      const { sql, values } = where(filters);
      const [rows] = await c.query(
        `SELECT * FROM ${from.sql} WHERE ${sql} ORDER BY run_at DESC, repo, external_key LIMIT ? OFFSET ?`,
        [...from.values, ...values, limit + 1, offset],
      );
      return {
        runs: rows.slice(0, limit).map((row) => ({
          repo: row.repo,
          kind: row.kind,
          id: String(row.github_id),
          name: row.name,
          app: row.app,
          headSha: row.head_sha,
          branch: row.branch,
          status: row.status,
          conclusion: row.conclusion,
          url: row.url,
          startedAt: row.started_at == null ? null : Number(row.started_at),
          completedAt: row.completed_at == null ? null : Number(row.completed_at),
          durationMs: row.duration_ms == null ? null : Number(row.duration_ms),
          runner:
            row.runner_name || row.runner_group
              ? {
                  name: row.runner_name || null,
                  group: row.runner_group || null,
                  labels: row.runner_labels ? JSON.parse(row.runner_labels) : [],
                }
              : null,
          cost:
            row.rate == null || row.duration_ms == null
              ? null
              : (Number(row.duration_ms) * Number(row.rate)) / 3600000,
          runAt: Number(row.run_at),
          observedAt: Number(row.observed_at),
        })),
        nextOffset: rows.length > limit && offset + limit <= CI_MAX_OFFSET ? offset + limit : null,
        truncated: rows.length > limit && offset + limit > CI_MAX_OFFSET,
      };
    } finally {
      c.release();
    }
  }

  async function pendingCommits(repo) {
    repo = repo.toLowerCase();
    const c = await connection();
    try {
      const read = (after) =>
        c.query(
          `SELECT head_sha AS sha, MIN(branch) AS branch FROM ci_checks
         WHERE repo = ? AND status <> 'completed' AND head_sha > ?
         GROUP BY head_sha ORDER BY head_sha LIMIT 100`,
          [repo, after],
        );
      const cursor = pendingCursors.get(repo) || '';
      let [rows] = await read(cursor);
      if (!rows.length && cursor) {
        pendingCursors.delete(repo);
        [rows] = await read('');
      }
      return rows;
    } finally {
      c.release();
    }
  }

  // Selection alone must not skip the rest of a batch when a rate limit aborts
  // collection. Advance before each attempt, including failed or empty reads.
  function markPendingAttempt(repo, sha) {
    pendingCursors.set(repo.toLowerCase(), sha);
  }

  return { save, saveRunners, missingRunners, stats, runs, pendingCommits, markPendingAttempt };
}

export const ciStore = createCiStore();
