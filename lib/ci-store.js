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
  MAX(observed_at) AS lastObservedAt`;

function metrics(row) {
  const result = Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      key,
      ['repo', 'name', 'app', 'day'].includes(key)
        ? value
        : value == null
          ? ['avgDurationMs', 'maxDurationMs', 'lastObservedAt'].includes(key)
            ? null
            : 0
          : Number(value),
    ]),
  );
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
    for (const key of ['branch', 'name', 'status', 'conclusion'])
      if (filters[key] != null) {
        clauses.push(`${key} = ?`);
        values.push(filters[key]);
      }
    return { sql: clauses.join(' AND '), values };
  }

  async function stats(filters) {
    const c = await connection();
    try {
      // A consistent snapshot keeps totals and chart groups in agreement while
      // webhook writes continue on another connection.
      await c.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
      await c.beginTransaction();
      const { sql, values } = where(filters);
      const [[total]] = await c.query(`SELECT ${METRICS} FROM ci_checks WHERE ${sql}`, values);
      const groups = {};
      for (const [key, select, group] of [
        ['daily', 'FLOOR(run_at / 86400000) * 86400000 AS day', 'day'],
        ['repositories', 'repo', 'repo'],
        ['checks', 'name, app', 'name, app'],
      ]) {
        const [rows] = await c.query(
          `SELECT ${select}, ${METRICS} FROM ci_checks WHERE ${sql} GROUP BY ${group} ORDER BY ${group}`,
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

  async function runs(filters, { limit = 50, offset = 0 } = {}) {
    const c = await connection();
    try {
      const { sql, values } = where(filters);
      const [rows] = await c.query(
        `SELECT * FROM ci_checks WHERE ${sql} ORDER BY run_at DESC, repo, external_key LIMIT ? OFFSET ?`,
        [...values, limit + 1, offset],
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

  return { save, stats, runs, pendingCommits, markPendingAttempt };
}

export const ciStore = createCiStore();
