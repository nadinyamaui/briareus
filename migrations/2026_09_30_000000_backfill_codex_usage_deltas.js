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

/**
 * @typedef {{ id: number, jobId: string, accountId: number | null, at: number,
 *   inputTokens: number | null, outputTokens: number | null }} LegacyRow
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
 * @param {number | null} current
 * @param {number | null | undefined} prior
 */
function delta(current, prior) {
  if (current == null) return null;
  // A counter below the thread's last total means it started again.
  return prior != null && current >= prior ? current - prior : current;
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
      usage = {
        inputTokens: delta(row.inputTokens, prior?.inputTokens),
        outputTokens: delta(row.outputTokens, prior?.outputTokens),
      };
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

/** @param {unknown} v a JSON_UNQUOTE'd number, 'null', or SQL NULL */
function num(v) {
  if (v == null || v === 'null') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** @param {{ context: import('mysql2/promise').Pool }} ctx */
export async function up({ context: p }) {
  const [found] = await p.query(
    "SELECT `id`, `job_id`, `account_id`, `at`, `input_tokens`, `output_tokens` FROM `turn_usage` WHERE `provider` = 'codex' AND `usage_is_delta` = 0 ORDER BY `id`",
  );
  /** @type {LegacyRow[]} */
  const rows = /** @type {any[]} */ (found).map((r) => ({
    id: Number(r.id),
    jobId: r.job_id,
    accountId: r.account_id == null ? null : Number(r.account_id),
    at: Number(r.at),
    inputTokens: num(r.input_tokens),
    outputTokens: num(r.output_tokens),
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
  // All or nothing: a half-applied run would leave the rest of a chain
  // without the rows it is measured from.
  const conn = await p.getConnection();
  try {
    await conn.beginTransaction();
    for (const [id, usage] of deltas) {
      await conn.query(
        'UPDATE `turn_usage` SET `input_tokens` = ?, `output_tokens` = ?, `cached_input_tokens` = ?, `usage_is_delta` = 1 WHERE `id` = ?',
        [usage.inputTokens, usage.outputTokens, usage.cachedInputTokens, id],
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

// The lifetime counters the rows held before are not kept, so there is
// nothing to put back.
export async function down() {}
