// @ts-check
// The GitHub Projects v2 board a project shows as a tab after its issues:
// `{ owner, ownerType, number, view }` as JSON, null for none. lib/projects.js
// validates it and lib/projectboard.js reads the board it names.
//
// Guarded on the column already existing, for the same reason as the worker
// runtime migration: ADD COLUMN is not idempotent.

/** @param {import('mysql2/promise').Pool} p */
async function hasColumn(p) {
  const [rows] = await p.query(
    'SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?',
    ['projects', 'project_board'],
  );
  return /** @type {any[]} */ (rows).length > 0;
}

/** @param {{ context: import('mysql2/promise').Pool }} ctx */
export async function up({ context: p }) {
  if (await hasColumn(p)) return;
  await p.query('ALTER TABLE `projects` ADD COLUMN `project_board` TEXT NULL AFTER `prompt_templates`');
}

/** @param {{ context: import('mysql2/promise').Pool }} ctx */
export async function down({ context: p }) {
  if (!(await hasColumn(p))) return;
  await p.query('ALTER TABLE `projects` DROP COLUMN `project_board`');
}
