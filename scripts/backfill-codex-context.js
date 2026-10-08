// Recover request tiers without replacing reported dollars or token totals.
// Usage: node scripts/backfill-codex-context.js [--env=/path/.env] [--apply]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import mysql from 'mysql2/promise';
import { parseEnvFile } from '../lib/config.js';
import { codexPricingCounter } from '../lib/codex-pricing.js';
import { loadCatalog, withEstimates } from '../lib/prices.js';

const args = process.argv.slice(2);
const envFile = args.find((a) => a.startsWith('--env='))?.slice(6) || '.env';
const env = parseEnvFile(fs.readFileSync(envFile, 'utf8'));
const apply = args.includes('--apply');
const fields = ['input_tokens', 'cached_input_tokens', 'output_tokens'];
const key = (row) => fields.map((k) => Number(row[k])).join('/');
const segments = new Map();

async function scan(file) {
  let previous = Object.fromEntries(fields.map((k) => [k, 0]));
  let baseline;
  let counter;
  let model;
  let mixedModel = false;
  let cwd;
  let ended = false;
  let at;
  const input = fs.createReadStream(file);
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  const finish = () => {
    if (!counter) return;
    const own = Object.fromEntries(fields.map((k) => [k, previous[k] - baseline[k]]));
    const pricing = counter.result(own);
    if (pricing && !mixedModel && own.input_tokens > 0 && model && cwd && Number.isFinite(at)) {
      const k = key(own);
      if (!segments.has(k)) segments.set(k, []);
      segments.get(k).push({ ...pricing, at, model, cwd, file });
    }
    counter = null;
  };
  try {
    for await (const line of lines) {
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      const p = event.payload;
      if (!p) continue;
      if (event.type === 'session_meta') {
        // Subagent usage is not the main thread's ledger row.
        if (typeof p.source === 'object' && p.source?.subagent) return;
        cwd = p.cwd;
      }
      if (p.type === 'task_started') {
        finish();
        baseline = { ...previous };
        counter = codexPricingCounter(baseline);
        ended = false;
        model = null;
        mixedModel = false;
        at = undefined;
      }
      if (event.type === 'turn_context') {
        if (model && model !== p.model) mixedModel = true;
        model = p.model;
      }
      if (p.type === 'token_count' && p.info) {
        counter?.feed(p.info);
        previous = p.info.total_token_usage;
        at = Date.parse(event.timestamp);
      }
      if (p.type === 'task_complete' || p.type === 'turn_aborted') {
        // The ledger is booked at process close, after any final tool wait.
        at = Date.parse(event.timestamp);
        finish();
        ended = true;
      }
    }
    // Stopped turns also have a ledger row; matching requires all three totals.
    if (!ended) finish();
  } finally {
    lines.close();
    input.destroy();
  }
}

async function walk(dir) {
  let entries;
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(file);
    else if (entry.name.startsWith('rollout-') && entry.name.endsWith('.jsonl')) await scan(file);
  }
}

for (const entry of await fs.promises.readdir(os.homedir(), { withFileTypes: true })) {
  if (entry.isDirectory() && /^\.codex(?:-provider-\d+)?$/.test(entry.name)) {
    await walk(path.join(os.homedir(), entry.name, 'sessions'));
  }
}

const connection = await mysql.createConnection({
  host: env.DB_HOST,
  port: env.DB_PORT,
  user: env.DB_USERNAME,
  password: env.DB_PASSWORD,
  database: env.DB_DATABASE,
});
try {
  const [rows] = await connection.query(
    "SELECT * FROM turn_usage WHERE provider = 'codex' AND cost_usd IS NULL",
  );
  const changes = [];
  let ambiguous = 0;
  for (const row of rows) {
    if (fields.some((k) => row[k] == null) || !row.repo) continue;
    const model = String(row.model || '').replace(/ \(\d+k\)$/, '');
    const repo = String(row.repo).toLowerCase().split('/');
    if (repo.length !== 2 || repo.some((part) => !part)) continue;
    const worktree = repo.join('__');
    const candidates = (segments.get(key(row)) || []).filter(
      (s) =>
        s.model === model &&
        s.cwd
          .toLowerCase()
          .split(path.sep)
          .some(
            (part) =>
              part === worktree ||
              (part.startsWith(`${worktree}__`) && /^\d+$/.test(part.slice(worktree.length + 2))),
          ) &&
        Number(row.at) >= s.at - 5000 &&
        Number(row.at) <= s.at + 300000,
    );
    // An account transfer may copy a rollout verbatim; identical copies agree.
    const unique = new Map(
      candidates.map((s) => [
        JSON.stringify([s.at, s.longInputTokens, s.longCachedInputTokens, s.longOutputTokens]),
        s,
      ]),
    );
    if (unique.size > 1) {
      ambiguous++;
      continue;
    }
    if (unique.size !== 1) continue;
    const s = unique.values().next().value;
    if (
      Number(row.long_input_tokens) === s.longInputTokens &&
      row.long_input_tokens != null &&
      Number(row.long_cached_input_tokens) === s.longCachedInputTokens &&
      Number(row.long_output_tokens) === s.longOutputTokens
    )
      continue;
    changes.push({ row, s });
  }
  console.log({
    mode: apply ? 'apply' : 'dry-run',
    examined: rows.length,
    matched: changes.length,
    longTurns: changes.filter(({ s }) => s.longInputTokens > 0).length,
    ambiguous,
  });
  const catalog = await loadCatalog();
  const asUsage = (row) => ({
    provider: row.provider,
    model: row.model,
    costUsd: null,
    inputTokens: Number(row.input_tokens),
    cachedInputTokens: Number(row.cached_input_tokens),
    outputTokens: Number(row.output_tokens),
    longInputTokens: row.long_input_tokens == null ? null : Number(row.long_input_tokens),
    longCachedInputTokens: row.long_cached_input_tokens == null ? null : Number(row.long_cached_input_tokens),
    longOutputTokens: row.long_output_tokens == null ? null : Number(row.long_output_tokens),
  });
  const before = withEstimates(
    changes.map(({ row }) => asUsage(row)),
    catalog,
  );
  const after = withEstimates(
    changes.map(({ row, s }) => ({ ...asUsage(row), ...s })),
    catalog,
  );
  const diff = changes.map(({ row }, i) => ({
    at: Number(row.at),
    dollars: (after[i].costUsd || 0) - (before[i].costUsd || 0),
  }));
  const october = diff.filter((d) => d.at >= +new Date(2026, 9, 1) && d.at < +new Date(2026, 10, 1));
  console.log({
    additionalApiEstimateUsd: diff.reduce((sum, d) => sum + d.dollars, 0),
    octoberMatched: october.length,
    octoberAdditionalApiEstimateUsd: october.reduce((sum, d) => sum + d.dollars, 0),
  });
  if (apply && changes.length) {
    // Originals and attribution survive reruns; snapshots cover only changed rows.
    await connection.query(`CREATE TABLE IF NOT EXISTS turn_usage_context_fix_20261008 (
      id BIGINT UNSIGNED PRIMARY KEY, original LONGTEXT NOT NULL, source_file TEXT NOT NULL, fixed_at BIGINT UNSIGNED NOT NULL)`);
    await connection.beginTransaction();
    try {
      for (const { row, s } of changes) {
        await connection.query('INSERT IGNORE INTO turn_usage_context_fix_20261008 VALUES (?, ?, ?, ?)', [
          row.id,
          JSON.stringify(row),
          s.file,
          Date.now(),
        ]);
        const [result] = await connection.query(
          `UPDATE turn_usage
          SET long_input_tokens=?, long_cached_input_tokens=?, long_output_tokens=?
          WHERE id=? AND input_tokens=? AND cached_input_tokens=? AND output_tokens=? AND cost_usd IS NULL`,
          [
            s.longInputTokens,
            s.longCachedInputTokens,
            s.longOutputTokens,
            row.id,
            row.input_tokens,
            row.cached_input_tokens,
            row.output_tokens,
          ],
        );
        if (result.affectedRows !== 1) throw new Error(`Concurrent change on row ${row.id}`);
      }
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    }
  }
} finally {
  await connection.end();
}
