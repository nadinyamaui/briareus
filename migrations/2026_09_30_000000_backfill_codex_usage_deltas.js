// @ts-check
// Rewrite the Codex ledger rows written before usage_is_delta existed, once, so
// every read can take the ledger as it is. Those turn rows hold the CLI's
// lifetime thread counters, so each one becomes its thread's total minus the
// thread's previous row; a compaction row was always written as a delta and
// only moves that total on. Then usage_is_delta, which only this read, goes.
//
// Which thread a row belongs to comes from the session's log: the turn's
// "Starting …" line (a native code review, or a turn that did not resume,
// opens a fresh thread), the "Codex session started: thread <id>" line the CLI
// printed, and "Compacting <provider> context…" (the provider's label, which
// can be renamed, so any label counts). Rows logged before those lines
// existed fall back to the counters alone, where a drop means a new thread and
// a new thread that starts above the old total cannot be told apart. Rows
// from before 2026_09_23 name no account; they are taken as the session's
// first one, so a thread that ran on both sides of it stays one chain.
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
//    cache share calibrated from the ledger's priced rows (the same aggregate
//    the estimate was priced with; this backfill touches none of those rows).
//    A deleted row cannot show whether its estimate was really paid over (a
//    session deleted while not restored in memory, or whose estimate could
//    not be read, paid nothing), so a parent is corrected only when its
//    absorbed estimate covers the old estimate of every row attributed to it;
//    any other keeps the figure it has, as does the parent of a session
//    deleted before task_sessions existed, which has no record. The absorbed
//    token counts came from the CLI's own thread totals, not from these rows,
//    and are left alone.

import { loadCatalog, priceFor, withEstimates } from '../lib/prices.js';
import { codexTurnUsage } from '../lib/providers.js';

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
  if (/^Compacting .+ context/.test(text)) return 'compact';
  if (/^Starting .+ code review \(/.test(text)) return 'fresh';
  // The model can carry parentheses of its own ("gpt-5 (872k)").
  if (/^Starting .+ \(.+, effort [^)]*\)/.test(text))
    return /, resuming session/.test(text) ? 'resume' : 'fresh';
  return null;
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
  // The chains keyed by a thread id the CLI printed.
  /** @type {Set<string>} */
  const named = new Set();
  // Rows written before 2026_09_23 carry no account, and the rest of the
  // same thread does: those count as the session's first account.
  /** @type {Map<string, number>} */
  const accounts = new Map();
  for (const row of rows)
    if (row.accountId != null && !accounts.has(row.jobId)) accounts.set(row.jobId, row.accountId);
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
    const owner = `${row.jobId}\n${row.accountId ?? accounts.get(row.jobId) ?? ''}`;
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
      // A thread id is the CLI's own, unique whichever account ran it.
      const chain = cursor.thread
        ? `${row.jobId}\n${cursor.thread}`
        : cursor.marker === 'fresh'
          ? `${owner}\n#${row.id}`
          : (current.get(owner) ?? owner);
      // A resume that names its thread for the first time goes on from the
      // chain the session was last on, when that one had no id of its own
      // (its rows were logged before the thread line, or the CLI printed
      // "thread ?"): it is the same thread, now named. One named otherwise
      // is another thread, which counts from zero as the live parser's does.
      const was = current.get(owner);
      const from = was && !named.has(was) ? totals.get(was) : undefined;
      if (cursor.thread && cursor.marker === 'resume' && !totals.has(chain) && from) totals.set(chain, from);
      if (cursor.thread) named.add(chain);
      const prior = totals.get(chain);
      // The live parser's rule, so history is rewritten the way turns are
      // booked now.
      const own = codexTurnUsage(row, prior);
      usage = { inputTokens: own.inputTokens, outputTokens: own.outputTokens };
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

// The cache share the absorbed estimates were priced with when this was
// written: solved from what the provider-priced rows cost. lib/prices.js has
// since moved to measuring it from Codex's own cache counts, but these figures
// were frozen at the old share, so they are reproduced with a copy of it.
/** @param {any[]} calibration @param {object} catalog */
function pricedCacheShare(calibration, catalog) {
  let reported = 0;
  let atFullPrice = 0;
  let spread = 0;
  let tokens = 0;
  for (const r of calibration) {
    if (!(r.costUsd > 0)) continue;
    const price = priceFor(catalog, r.provider, r.model);
    const input = r.inputTokens || 0;
    if (!price || !input) continue;
    reported += r.costUsd - ((r.outputTokens || 0) * price.output) / 1e6;
    atFullPrice += (input * price.input) / 1e6;
    spread += (input * (price.cacheRead - price.input)) / 1e6;
    tokens += input;
  }
  if (tokens < 1e6 || spread >= 0) return 0.7;
  return Math.min(1, Math.max(0, (reported - atFullPrice) / spread));
}

/**
 * What to take off each living parent's absorbedEstimatedCostUsd: the old
 * rows' estimate minus the new rows', over the rows of deleted sessions that
 * folded into it. A parent whose absorbed estimate is below the old estimate
 * of its rows never received all of them, and is left alone: what it holds
 * may be other children's.
 * @param {LegacyRow[]} rows
 * @param {Map<number, Usage>} deltas
 * @param {Map<string, string>} owners deleted session id -> the session holding its estimate
 * @param {Map<string, number>} held each parent's absorbedEstimatedCostUsd
 * @param {object} catalog
 * @param {object[]} [calibration] the ledger aggregate the estimates were priced with
 * @returns {Map<string, number>}
 */
export function absorbedCorrections(rows, deltas, owners, held, catalog, calibration = []) {
  const share = pricedCacheShare(calibration, catalog);
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
    share,
  );
  const after = withEstimates(
    mine.map((row) => priced(row, /** @type {Usage} */ (deltas.get(row.id)))),
    catalog,
    [],
    share,
  );
  /** @type {Map<string, { old: number, less: number }>} */
  const sums = new Map();
  mine.forEach((row, i) => {
    if (!before[i].costEstimated || !after[i].costEstimated) return;
    const owner = /** @type {string} */ (owners.get(row.jobId));
    const sum = sums.get(owner) || { old: 0, less: 0 };
    sum.old += before[i].costUsd;
    sum.less += before[i].costUsd - after[i].costUsd;
    sums.set(owner, sum);
  });
  /** @type {Map<string, number>} */
  const out = new Map();
  for (const [owner, { old, less }] of sums) {
    const has = held.get(owner);
    // A cent (or 1%) of slack: the figure was stored to four places, and the
    // calibration has moved a little with every priced turn since.
    if (!(less > 0) || has == null || has < old - Math.max(0.01, old * 0.01)) continue;
    out.set(owner, less);
  }
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
  // The flag only tells this backfill which rows came before 2026_09_28, and
  // nothing writes or reads it after, so it goes once they are converted. A
  // run that stopped after the drop has nothing left to convert; one that
  // stopped before it set each converted row to 1, and finds none of them.
  const [columns] = await p.query(
    'SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?',
    ['turn_usage', 'usage_is_delta'],
  );
  if (!(/** @type {any[]} */ (columns).length)) return;
  await backfill(p);
  await p.query('ALTER TABLE turn_usage DROP COLUMN usage_is_delta');
}

/** @param {import('mysql2/promise').Pool} p */
async function backfill(p) {
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
        AND (\`data\` LIKE '%"text":"Starting %' OR \`data\` LIKE '%"text":"Compacting %'
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

  // Only footers that can match: those of sessions with a row whose counts
  // changed, and that carry counts at all.
  const changed = [
    ...new Set(
      rows
        .filter((row) => {
          const usage = deltas.get(row.id);
          return usage?.inputTokens !== row.inputTokens || usage?.outputTokens !== row.outputTokens;
        })
        .map((row) => row.jobId),
    ),
  ];
  const [results] = changed.length
    ? await p.query(
        `SELECT \`job_id\`, \`seq\`, \`at\`, \`data\` FROM \`job_events\`
          WHERE \`job_id\` IN (?) AND \`kind\` = 'result' AND \`data\` REGEXP '"inputTokens":[0-9]'`,
        [changed],
      )
    : [[]];
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
  const [parents] = await p.query(
    `SELECT \`id\`, JSON_UNQUOTE(JSON_EXTRACT(\`meta\`, '$.absorbedEstimatedCostUsd')) AS \`absorbed\`
       FROM \`jobs\` WHERE \`id\` IN (?) AND JSON_VALID(\`meta\`)`,
    [[...new Set(owners.values())]],
  );
  /** @type {Map<string, number>} */
  const held = new Map();
  for (const job of /** @type {any[]} */ (parents)) {
    const absorbed = num(job.absorbed);
    if (absorbed != null) held.set(job.id, absorbed);
  }
  if (!held.size) return new Map();
  // lib/db.js's loadTurnUsageCalibration, which priced the estimates at
  // deletion; copied rather than imported, as a migration runs on its own pool.
  const [calibration] = await p.query(
    `SELECT \`provider\`, \`model\`, SUM(\`input_tokens\`) AS \`input_tokens\`,
            SUM(\`output_tokens\`) AS \`output_tokens\`, SUM(\`cost_usd\`) AS \`cost_usd\`
       FROM \`turn_usage\`
      WHERE \`cost_usd\` > 0 AND \`input_tokens\` > 0
      GROUP BY \`provider\`, \`model\``,
  );
  // A catalog that could not be fetched, with no copy on disk, prices nothing,
  // so no parent can be corrected. The run still goes ahead (migrations run at
  // boot, and a throw would keep an install with no network from starting),
  // and says which figures it left.
  const catalog = await loadCatalog();
  if (!Object.keys(catalog).length) {
    console.warn(
      `Codex usage backfill: no price catalog could be loaded, so the absorbed estimates of ${held.size} session(s) were left inflated: ${[...held.keys()].join(', ')}`,
    );
    return new Map();
  }
  return absorbedCorrections(
    rows,
    deltas,
    owners,
    held,
    catalog,
    /** @type {any[]} */ (calibration).map((row) => ({
      provider: row.provider,
      model: row.model,
      inputTokens: Number(row.input_tokens),
      outputTokens: row.output_tokens == null ? null : Number(row.output_tokens),
      costUsd: Number(row.cost_usd),
    })),
  );
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
