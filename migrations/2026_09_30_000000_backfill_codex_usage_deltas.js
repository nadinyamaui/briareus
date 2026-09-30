// @ts-check
// Rewrite the Codex ledger rows written before usage_is_delta existed, once, so
// every read can take the ledger as it is. Those turn rows hold the CLI's
// lifetime thread counters, so each one becomes its thread's total minus the
// thread's previous row; a compaction row was always written as a delta and
// only moves that total on.
//
// Which thread a row belongs to comes from the session's log: the turn's
// "Starting …" line (a native code review, or a turn that did not resume,
// opens a fresh thread), the "Codex session started: thread <id>" line the CLI
// printed, and "Compacting Codex context…". Rows logged before those lines
// existed fall back to the counters alone, where a drop means a new thread and
// a new thread that starts above the old total cannot be told apart.
//
// The cached share of each row is the session's own measured share (its last
// Codex context reading), where it has one; otherwise it stays NULL and the
// price keeps the calibrated estimate.
//
// Two copies of the old counters live outside the ledger, and are repaired in
// the same transaction:
//  - each turn's `result` event echoed them, so the footer that carries
//    exactly a row's old counters is given the row's new ones;
//  - a worker, review or fix session deleted before this ran paid its ledger
//    estimate into its parent's `absorbedEstimatedCostUsd`, priced from the
//    inflated rows. The parent is found through the deleted session's
//    task_sessions record (up to the nearest session still there, which is
//    where the estimate ended up), and the difference between the old and
//    new rows' estimates comes off, both priced at today's catalog and the
//    default cache share, since the one used then is not kept. A session
//    deleted before task_sessions existed has no record, and its parent keeps
//    the figure it was given. The absorbed token counts came from the CLI's
//    own thread totals, not from these rows, and are left alone.

import { loadCatalog, withEstimates } from '../lib/prices.js';

/**
 * @typedef {{ id: number, jobId: string, accountId: number | null, at: number,
 *   inputTokens: number | null, outputTokens: number | null,
 *   model?: string | null, costUsd?: number | null }} LegacyRow
 * @typedef {{ jobId: string, at: number, text: string }} LogLine
 * @typedef {{ inputTokens: number | null, outputTokens: number | null,
 *   cachedInputTokens: number | null }} Usage
 */

const THREAD = /^Codex session started: thread (\S+)/;

/** @param {string} text */
function marker(text) {
  if (/^Compacting Codex context/.test(text)) return 'compact';
  if (/^Starting .+ code review \(/.test(text)) return 'fresh';
  // The model can carry parentheses of its own ("gpt-5 (872k)").
  if (/^Starting .+ \(.+, effort [^)]*\)/.test(text))
    return /, resuming session/.test(text) ? 'resume' : 'fresh';
  return null;
}

/**
 * One row's own usage from its thread's counters and the thread's last total.
 * Whether the thread started again is decided once, from input (from output
 * when input was not recorded): then every counter is the row's in full,
 * otherwise every counter is reduced, so one never reads a reset another does
 * not.
 * @param {{ inputTokens: number | null, outputTokens: number | null }} row
 * @param {{ inputTokens: number | null, outputTokens: number | null } | undefined} prior
 */
function delta(row, prior) {
  const by = row.inputTokens != null && prior?.inputTokens != null ? 'inputTokens' : 'outputTokens';
  const reset = prior?.[by] == null || row[by] == null || row[by] < prior[by];
  /** @param {'inputTokens' | 'outputTokens'} key */
  const own = (key) =>
    row[key] == null ? null : reset || prior?.[key] == null ? row[key] : Math.max(0, row[key] - prior[key]);
  return { inputTokens: own('inputTokens'), outputTokens: own('outputTokens') };
}

/**
 * @param {number | null | undefined} a
 * @param {number | null} b
 */
function add(a, b) {
  return a == null ? a : a + (b || 0);
}

/**
 * Each legacy row's own usage, by row id. `rows` in id order, `log` in the
 * order it was written.
 * @param {LegacyRow[]} rows
 * @param {LogLine[]} log
 * @param {Map<string, number>} [shares] a session's cached share of its input
 * @returns {Map<number, Usage>}
 */
export function codexUsageDeltas(rows, log, shares = new Map()) {
  /** @type {Map<string, LogLine[]>} */
  const lines = new Map();
  for (const line of log) {
    if (!lines.has(line.jobId)) lines.set(line.jobId, []);
    lines.get(line.jobId)?.push(line);
  }
  // Where each session's log has been read up to, and what it said last.
  /** @type {Map<string, { i: number, marker: string | null, thread: string | null }>} */
  const cursors = new Map();
  // A thread's lifetime counters as of its last row, and the thread each
  // session's account last ran on (what a compaction or a resume refers to).
  /** @type {Map<string, { inputTokens: number | null, outputTokens: number | null }>} */
  const totals = new Map();
  /** @type {Map<string, string>} */
  const current = new Map();
  /** @type {Map<number, Usage>} */
  const out = new Map();
  for (const row of rows) {
    const own = lines.get(row.jobId) || [];
    const cursor = cursors.get(row.jobId) || { i: 0, marker: null, thread: null };
    cursors.set(row.jobId, cursor);
    while (cursor.i < own.length && own[cursor.i].at <= row.at) {
      const text = own[cursor.i++].text;
      const thread = THREAD.exec(text)?.[1];
      const kind = thread ? null : marker(text);
      if (thread && thread !== '?') cursor.thread = thread;
      else if (kind) {
        cursor.marker = kind;
        cursor.thread = null;
      }
    }
    const owner = `${row.jobId}\n${row.accountId ?? ''}`;
    let usage;
    if (cursor.marker === 'compact') {
      usage = { inputTokens: row.inputTokens, outputTokens: row.outputTokens };
      const chain = current.get(owner);
      const prior = chain && totals.get(chain);
      if (chain && prior)
        totals.set(chain, {
          inputTokens: add(prior.inputTokens, row.inputTokens),
          outputTokens: add(prior.outputTokens, row.outputTokens),
        });
    } else {
      const chain = cursor.thread
        ? `${owner}\n${cursor.thread}`
        : cursor.marker === 'fresh'
          ? `${owner}\n#${row.id}`
          : (current.get(owner) ?? owner);
      const prior = totals.get(chain);
      usage = delta(row, prior);
      totals.set(chain, { inputTokens: row.inputTokens, outputTokens: row.outputTokens });
      current.set(owner, chain);
      // A fresh thread's later turns carry no marker of their own when the
      // CLI printed no thread id: they resume this chain.
      if (cursor.marker === 'fresh') cursor.marker = 'resume';
    }
    const share = shares.get(row.jobId);
    out.set(row.id, {
      ...usage,
      cachedInputTokens:
        usage.inputTokens != null && share != null && Number.isFinite(share)
          ? Math.round(usage.inputTokens * Math.max(0, Math.min(1, share)))
          : null,
    });
  }
  return out;
}

/**
 * The legacy `result` events to rewrite: for each row whose counts changed, the
 * nearest footer in its session that still carries exactly the row's old
 * counters, each footer used once.
 * @param {LegacyRow[]} rows
 * @param {Map<number, Usage>} deltas
 * @param {Array<{ jobId: string, seq: number, at: number, data: Record<string, any> }>} events
 * @returns {Array<{ jobId: string, seq: number, data: string }>}
 */
export function codexResultRewrites(rows, deltas, events) {
  /** @type {Map<string, typeof events>} */
  const byJob = new Map();
  for (const event of events) {
    if (!byJob.has(event.jobId)) byJob.set(event.jobId, []);
    byJob.get(event.jobId)?.push(event);
  }
  const out = [];
  for (const row of rows) {
    const usage = deltas.get(row.id);
    if (!usage || row.inputTokens == null || row.outputTokens == null) continue;
    if (usage.inputTokens === row.inputTokens && usage.outputTokens === row.outputTokens) continue;
    const own = byJob.get(row.jobId) || [];
    let best = -1;
    for (let i = 0; i < own.length; i++) {
      const { data, at } = own[i];
      if (data.inputTokens !== row.inputTokens || data.outputTokens !== row.outputTokens) continue;
      if (best < 0 || Math.abs(at - row.at) < Math.abs(own[best].at - row.at)) best = i;
    }
    if (best < 0) continue;
    const [event] = own.splice(best, 1);
    out.push({
      jobId: event.jobId,
      seq: event.seq,
      data: JSON.stringify({
        ...event.data,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
      }),
    });
  }
  return out;
}

/**
 * What to take off each living parent's absorbedEstimatedCostUsd: the old
 * rows' estimate minus the new rows', over the rows of deleted sessions that
 * folded into it.
 * @param {LegacyRow[]} rows
 * @param {Map<number, Usage>} deltas
 * @param {Map<string, string>} owners deleted session id -> the session holding its estimate
 * @param {object} catalog
 * @returns {Map<string, number>}
 */
export function absorbedCorrections(rows, deltas, owners, catalog) {
  const mine = rows.filter((row) => owners.has(row.jobId) && row.costUsd == null && deltas.has(row.id));
  /** @param {LegacyRow} row @param {{ inputTokens: number | null, outputTokens: number | null }} usage */
  const priced = (row, { inputTokens, outputTokens }) => ({
    provider: 'codex',
    model: row.model ?? null,
    costUsd: null,
    inputTokens,
    outputTokens,
  });
  const before = withEstimates(
    mine.map((row) => priced(row, row)),
    catalog,
    [],
  );
  const after = withEstimates(
    mine.map((row) => priced(row, /** @type {Usage} */ (deltas.get(row.id)))),
    catalog,
    [],
  );
  /** @type {Map<string, number>} */
  const out = new Map();
  mine.forEach((row, i) => {
    if (!before[i].costEstimated || !after[i].costEstimated) return;
    const owner = /** @type {string} */ (owners.get(row.jobId));
    out.set(owner, (out.get(owner) || 0) + before[i].costUsd - after[i].costUsd);
  });
  for (const [owner, less] of out) if (!(less > 0)) out.delete(owner);
  return out;
}

// Rows per UPDATE: a few statements for a long history, each well under any
// max_allowed_packet (a footer's text is capped at 4000 characters).
const CHUNK = 200;

/**
 * @template T
 * @param {T[]} items
 * @returns {T[][]}
 */
function chunks(items) {
  const out = [];
  for (let i = 0; i < items.length; i += CHUNK) out.push(items.slice(i, i + CHUNK));
  return out;
}

/** @param {unknown} v a JSON_UNQUOTE'd number, 'null', or SQL NULL */
function num(v) {
  if (v == null || v === 'null') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** @param {{ context: import('mysql2/promise').Pool }} ctx */
export async function up({ context: p }) {
  const [found] = await p.query(
    "SELECT `id`, `job_id`, `account_id`, `model`, `at`, `input_tokens`, `output_tokens`, `cost_usd` FROM `turn_usage` WHERE `provider` = 'codex' AND `usage_is_delta` = 0 ORDER BY `id`",
  );
  /** @type {LegacyRow[]} */
  const rows = /** @type {any[]} */ (found).map((r) => ({
    id: Number(r.id),
    jobId: r.job_id,
    accountId: r.account_id == null ? null : Number(r.account_id),
    at: Number(r.at),
    inputTokens: num(r.input_tokens),
    outputTokens: num(r.output_tokens),
    model: r.model ?? null,
    costUsd: num(r.cost_usd),
  }));
  if (!rows.length) return;
  const ids = [...new Set(rows.map((r) => r.jobId))];
  const [logged] = await p.query(
    `SELECT \`job_id\`, \`at\`, \`data\` FROM \`job_events\`
      WHERE \`job_id\` IN (?) AND \`kind\` = 'info'
        AND (\`data\` LIKE '%"text":"Starting %' OR \`data\` LIKE '%"text":"Compacting Codex%'
          OR \`data\` LIKE '%"text":"Codex session started%')
      ORDER BY \`job_id\`, \`seq\``,
    [ids],
  );
  /** @type {LogLine[]} */
  const log = [];
  for (const e of /** @type {any[]} */ (logged)) {
    try {
      const text = JSON.parse(e.data)?.text;
      if (typeof text === 'string') log.push({ jobId: e.job_id, at: Number(e.at), text });
    } catch {
      /* a line that does not parse says nothing about threads */
    }
  }
  // Only the three numbers, not the whole session record.
  const [jobs] = await p.query(
    `SELECT \`id\`,
            JSON_UNQUOTE(JSON_EXTRACT(\`meta\`, '$.contextUsage.source')) AS \`source\`,
            JSON_UNQUOTE(JSON_EXTRACT(\`meta\`, '$.contextUsage.inputTokens')) AS \`input_tokens\`,
            JSON_UNQUOTE(JSON_EXTRACT(\`meta\`, '$.contextUsage.cachedInputTokens')) AS \`cached_input_tokens\`
       FROM \`jobs\` WHERE \`id\` IN (?) AND JSON_VALID(\`meta\`)`,
    [ids],
  );
  /** @type {Map<string, number>} */
  const shares = new Map();
  for (const job of /** @type {any[]} */ (jobs)) {
    const input = num(job.input_tokens);
    const cached = num(job.cached_input_tokens);
    if (job.source === 'codex' && input != null && input > 0 && cached != null)
      shares.set(job.id, cached / input);
  }
  const deltas = codexUsageDeltas(rows, log, shares);

  const [results] = await p.query(
    "SELECT `job_id`, `seq`, `at`, `data` FROM `job_events` WHERE `job_id` IN (?) AND `kind` = 'result'",
    [ids],
  );
  const footers = [];
  for (const e of /** @type {any[]} */ (results)) {
    try {
      const data = JSON.parse(e.data);
      if (data && typeof data === 'object')
        footers.push({ jobId: e.job_id, seq: Number(e.seq), at: Number(e.at), data });
    } catch {
      /* a footer that does not parse is left as it is */
    }
  }
  const rewrites = codexResultRewrites(rows, deltas, footers);

  const corrections = await absorbedByParents(p, rows, deltas, ids);

  // All or nothing: a half-applied run would leave the rest of a chain
  // without the rows it is measured from.
  const conn = await p.getConnection();
  try {
    await conn.beginTransaction();
    for (const part of chunks([...deltas])) {
      /** @param {keyof Usage} key */
      const pick = (key) => part.flatMap(([id, usage]) => [id, usage[key]]);
      const when = `CASE \`id\` ${part.map(() => 'WHEN ? THEN ?').join(' ')} END`;
      await conn.query(
        `UPDATE \`turn_usage\`
            SET \`input_tokens\` = ${when}, \`output_tokens\` = ${when}, \`cached_input_tokens\` = ${when},
                \`usage_is_delta\` = 1
          WHERE \`id\` IN (?)`,
        [
          ...pick('inputTokens'),
          ...pick('outputTokens'),
          ...pick('cachedInputTokens'),
          part.map(([id]) => id),
        ],
      );
    }
    for (const part of chunks(rewrites)) {
      await conn.query(
        `UPDATE \`job_events\`
            SET \`data\` = CASE ${part.map(() => 'WHEN `job_id` = ? AND `seq` = ? THEN ?').join(' ')} ELSE \`data\` END
          WHERE (\`job_id\`, \`seq\`) IN (?)`,
        [...part.flatMap((r) => [r.jobId, r.seq, r.data]), part.map((r) => [r.jobId, r.seq])],
      );
    }
    // One per parent, and there are few: only sessions that had Codex
    // children deleted from under them.
    for (const [jobId, less] of corrections) {
      await conn.query(
        `UPDATE \`jobs\`
            SET \`meta\` = JSON_SET(\`meta\`, '$.absorbedEstimatedCostUsd',
              GREATEST(0, CAST(JSON_UNQUOTE(JSON_EXTRACT(\`meta\`, '$.absorbedEstimatedCostUsd')) AS DECIMAL(12, 4)) - ?))
          WHERE \`id\` = ? AND JSON_VALID(\`meta\`)
            AND NULLIF(JSON_UNQUOTE(JSON_EXTRACT(\`meta\`, '$.absorbedEstimatedCostUsd')), 'null') IS NOT NULL`,
        [less, jobId],
      );
    }
    await conn.commit();
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }
}

/**
 * Which living session holds each deleted session's absorbed estimate, and
 * what to take off it. Walks task_sessions up from the deleted sessions until
 * it reaches one still in `jobs`.
 * @param {import('mysql2/promise').Pool} p
 * @param {LegacyRow[]} rows
 * @param {Map<number, Usage>} deltas
 * @param {string[]} ids every session with a legacy row
 */
async function absorbedByParents(p, rows, deltas, ids) {
  const [present] = await p.query('SELECT `id` FROM `jobs` WHERE `id` IN (?)', [ids]);
  const living = new Set(/** @type {any[]} */ (present).map((j) => j.id));
  let ask = ids.filter((id) => !living.has(id));
  if (!ask.length) return new Map();
  /** @type {Map<string, string>} */
  const parentOf = new Map();
  const seen = new Set(ids);
  while (ask.length) {
    const [links] = await p.query('SELECT `id`, `meta` FROM `task_sessions` WHERE `id` IN (?)', [ask]);
    const next = [];
    for (const link of /** @type {any[]} */ (links)) {
      let parentId = null;
      try {
        parentId = JSON.parse(link.meta)?.parentId;
      } catch {
        /* no parent to be read */
      }
      if (typeof parentId !== 'string' || !parentId) continue;
      parentOf.set(link.id, parentId);
      if (!seen.has(parentId)) {
        seen.add(parentId);
        next.push(parentId);
      }
    }
    if (!next.length) break;
    const [found] = await p.query('SELECT `id` FROM `jobs` WHERE `id` IN (?)', [next]);
    for (const j of /** @type {any[]} */ (found)) living.add(j.id);
    ask = next.filter((id) => !living.has(id));
  }
  /** @type {Map<string, string>} */
  const owners = new Map();
  for (const id of ids) {
    if (living.has(id)) continue;
    let at = parentOf.get(id);
    const path = new Set([id]);
    while (at && !living.has(at) && !path.has(at)) {
      path.add(at);
      at = parentOf.get(at);
    }
    if (at && living.has(at)) owners.set(id, at);
  }
  if (!owners.size) return new Map();
  return absorbedCorrections(rows, deltas, owners, await loadCatalog());
}

// The rows' lifetime counters are not kept, so this cannot be undone; and
// rolling back past 2026_09_28 drops usage_is_delta, so a re-run would read
// every converted row as legacy and subtract from deltas a second time. A
// rollback stops here instead.
export async function down() {
  throw new Error(
    'The Codex usage backfill cannot be rolled back: the lifetime counters it replaced are gone, and re-running it would subtract them twice',
  );
}
