// @ts-check
// What kind of work each ledger turn paid for: 'code-review', 'qa', a board
// action's id ('solve-conflicts', 'implement-feedback', …), 'orchestrator',
// 'worker' or 'chat', so the dashboards can say where the money went, not just
// which model took it. Rows written before this shipped stay NULL and the UI
// shows them as unattributed rather than guessing.
//
// Guarded on the column already existing: ADD COLUMN is not idempotent, and a
// database restored from a dump taken after this shipped already has it.

/** @param {import('mysql2/promise').Pool} p */
async function hasColumn(p) {
  const [rows] = await p.query(
    'SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?',
    ['turn_usage', 'activity'],
  );
  return /** @type {any[]} */ (rows).length > 0;
}

/** @param {{ context: import('mysql2/promise').Pool }} ctx */
export async function up({ context: p }) {
  if (await hasColumn(p)) return;
  await p.query('ALTER TABLE `turn_usage` ADD COLUMN `activity` VARCHAR(32) NULL AFTER `model`');
}

/** @param {{ context: import('mysql2/promise').Pool }} ctx */
export async function down({ context: p }) {
  if (!(await hasColumn(p))) return;
  await p.query('ALTER TABLE `turn_usage` DROP COLUMN `activity`');
}
