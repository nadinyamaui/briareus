// @ts-check
// The 🧭 orchestrator's per-project configuration: the runtime its workers
// start on when a spawn names no provider (mirroring the auto_review_* trio),
// and the spending cap one orchestration may reach — the supervisor's turns
// plus every worker's — before spawning and steering pause for the user.
//
// Guarded on the first column already existing: ADD COLUMN is not idempotent,
// and a database restored from a dump taken after this shipped already has
// them.

/** @param {import('mysql2/promise').Pool} p */
async function hasColumn(p) {
  const [rows] = await p.query(
    'SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?',
    ['projects', 'worker_provider_id'],
  );
  return /** @type {any[]} */ (rows).length > 0;
}

/** @param {{ context: import('mysql2/promise').Pool }} ctx */
export async function up({ context: p }) {
  if (await hasColumn(p)) return;
  await p.query(`ALTER TABLE \`projects\`
    ADD COLUMN \`worker_provider_id\` INT UNSIGNED NULL AFTER \`auto_review_effort\`,
    ADD COLUMN \`worker_model\`       VARCHAR(128)  NOT NULL DEFAULT '' AFTER \`worker_provider_id\`,
    ADD COLUMN \`worker_effort\`      VARCHAR(32)   NOT NULL DEFAULT '' AFTER \`worker_model\`,
    ADD COLUMN \`worker_budget_usd\`  DECIMAL(10,2) NULL AFTER \`worker_effort\``);
}

/** @param {{ context: import('mysql2/promise').Pool }} ctx */
export async function down({ context: p }) {
  if (!(await hasColumn(p))) return;
  await p.query(`ALTER TABLE \`projects\`
    DROP COLUMN \`worker_provider_id\`,
    DROP COLUMN \`worker_model\`,
    DROP COLUMN \`worker_effort\`,
    DROP COLUMN \`worker_budget_usd\``);
}
