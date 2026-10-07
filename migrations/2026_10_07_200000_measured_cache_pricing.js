// @ts-check
import { loadCatalog, priceFor, withEstimates } from '../lib/prices.js';

// Reproduce the share used before measured-cache pricing. This must stay
// frozen: it describes stored dollar snapshots, not today's pricing policy.
function oldShare(rows, catalog) {
  let reported = 0;
  let full = 0;
  let spread = 0;
  let tokens = 0;
  for (const row of rows) {
    const price = priceFor(catalog, row.provider, row.model);
    const input = row.inputTokens || 0;
    if (!(row.costUsd > 0) || !input || !price) continue;
    reported += row.costUsd - ((row.outputTokens || 0) * price.output) / 1e6;
    full += (input * price.input) / 1e6;
    spread += (input * (price.cacheRead - price.input)) / 1e6;
    tokens += input;
  }
  return tokens < 1e6 || spread >= 0 ? 0.7 : Math.min(1, Math.max(0, (reported - full) / spread));
}

// Follow retained task links to the first living parent, stopping at missing
// links and cycles. Never infer ownership from a title or repository.
export function absorbedOwners(ids, living, parentOf) {
  const owners = new Map();
  for (const id of ids) {
    if (living.has(id)) continue;
    const seen = new Set([id]);
    let at = parentOf.get(id);
    while (at && !living.has(at) && !seen.has(at)) {
      seen.add(at);
      at = parentOf.get(at);
    }
    if (at && living.has(at)) owners.set(id, at);
  }
  return owners;
}

// Only replace a snapshot when the retained rows reproduce the entire held
// estimate. Partial transfers, missing rows and catalog gaps are left alone.
// An explicit marker also makes a retry after a committed migration safe.
export function absorbedRepricing(rows, owners, parents, catalog) {
  const before = withEstimates(rows, catalog, [], oldShare(rows, catalog));
  const after = withEstimates(rows, catalog);
  const totals = new Map();
  rows.forEach((row, i) => {
    const owner = owners.get(row.jobId);
    if (!owner || row.costUsd != null) return;
    const total = totals.get(owner) || { old: 0, next: 0, turns: 0, incomplete: false };
    if (!before[i].costEstimated || !after[i].costEstimated) total.incomplete = true;
    else {
      total.old += before[i].costUsd;
      total.next += after[i].costUsd;
      total.turns++;
    }
    totals.set(owner, total);
  });
  const changes = new Map();
  for (const [id, total] of totals) {
    const meta = parents.get(id);
    const held = meta?.absorbedEstimatedCostUsd;
    if (
      !meta ||
      meta.absorbedPricingVersion === 'measured-cache-v1' ||
      typeof held !== 'number' ||
      total.incomplete ||
      total.turns !== meta.absorbedEstimatedTurns ||
      Math.abs(held - total.old) > 0.01 ||
      Math.abs(held - total.next) <= 0.01
    )
      continue;
    changes.set(id, { held, next: total.next });
  }
  return changes;
}

export async function up({ context: p }) {
  const [columns] = await p.query(
    'SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?',
    ['turn_usage', 'cache_measured'],
  );
  if (!columns.length)
    await p.query('ALTER TABLE turn_usage ADD COLUMN cache_measured TINYINT(1) NOT NULL DEFAULT 0');
  // The backfill discarded row provenance. Counts already present are only
  // trusted after that conversion completed; older ambiguous counts retain
  // their pricing but cannot calibrate anybody else's estimate.
  await p.query(
    `UPDATE \`turn_usage\` SET \`cache_measured\` = 1
      WHERE \`cached_input_tokens\` IS NOT NULL AND \`at\` >
        (SELECT \`ran_at\` FROM \`migrations\` WHERE \`migration\` = '2026_09_30_000000_backfill_codex_usage_deltas')`,
  );
  const [stored] = await p.query('SELECT `id`, `meta` FROM `jobs`');
  const parents = new Map();
  for (const row of stored) {
    try {
      parents.set(row.id, JSON.parse(row.meta));
    } catch {
      /* invalid metadata cannot receive a correction */
    }
  }
  if (![...parents.values()].some((meta) => meta?.absorbedEstimatedCostUsd > 0)) return;
  const [ledger] = await p.query(
    'SELECT `job_id`, `provider`, `model`, `input_tokens`, `cached_input_tokens`, `cache_measured`, `output_tokens`, `cost_usd` FROM `turn_usage`',
  );
  const number = (v) => (v == null ? null : Number(v));
  const rows = ledger.map((row) => ({
    jobId: row.job_id,
    provider: row.provider,
    model: row.model,
    inputTokens: number(row.input_tokens),
    cachedInputTokens: number(row.cached_input_tokens),
    cacheMeasured: row.cache_measured === 1,
    outputTokens: number(row.output_tokens),
    costUsd: number(row.cost_usd),
  }));
  const [tasks] = await p.query('SELECT `id`, `meta` FROM `task_sessions`');
  const parentOf = new Map();
  for (const task of tasks) {
    try {
      const parentId = JSON.parse(task.meta)?.parentId;
      if (typeof parentId === 'string' && parentId) parentOf.set(task.id, parentId);
    } catch {
      /* missing attribution must not move another parent's dollars */
    }
  }
  const owners = absorbedOwners(new Set(rows.map((row) => row.jobId)), new Set(parents.keys()), parentOf);
  const catalog = await loadCatalog();
  const changes = absorbedRepricing(rows, owners, parents, catalog);
  const conn = await p.getConnection();
  try {
    await conn.beginTransaction();
    for (const [id, { held, next }] of changes) {
      await conn.query(
        `UPDATE \`jobs\` SET \`meta\` = JSON_SET(\`meta\`,
           '$.absorbedEstimatedCostUsd', ?, '$.absorbedPricingVersion', 'measured-cache-v1')
         WHERE \`id\` = ? AND JSON_VALID(\`meta\`)
           AND CAST(JSON_UNQUOTE(JSON_EXTRACT(\`meta\`, '$.absorbedEstimatedCostUsd')) AS DECIMAL(12,4)) = ?
           AND COALESCE(JSON_UNQUOTE(JSON_EXTRACT(\`meta\`, '$.absorbedPricingVersion')), '') <> 'measured-cache-v1'`,
        [next, id, held],
      );
    }
    await conn.commit();
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }
  for (const [id, meta] of parents) {
    if (
      meta?.absorbedEstimatedCostUsd > 0 &&
      !changes.has(id) &&
      meta.absorbedPricingVersion !== 'measured-cache-v1'
    )
      console.warn(
        `Measured-cache pricing: absorbed estimate for ${id} left unchanged; retained history could not safely reproduce it.`,
      );
  }
}

export async function down() {
  throw new Error('Measured-cache pricing cannot be rolled back: absorbed estimates have been reconciled');
}
