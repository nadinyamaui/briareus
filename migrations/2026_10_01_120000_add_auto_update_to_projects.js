// @ts-check
// Auto-update: whether a merged pull request fast-forwards the project's local
// checkout, and the commands run there afterwards (composer install, restart
// Horizon, …); lib/local-update.js does the work.
//
// Guarded on the columns already existing, for the same reason as the worker
// runtime migration: ADD COLUMN is not idempotent.

/** @param {import('mysql2/promise').Pool} p @param {string} column */
async function hasColumn(p, column) {
  const [rows] = await p.query(
    'SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?',
    ['projects', column],
  );
  return /** @type {any[]} */ (rows).length > 0;
}

/** @param {{ context: import('mysql2/promise').Pool }} ctx */
export async function up({ context: p }) {
  if (!(await hasColumn(p, 'auto_update'))) {
    await p.query(
      'ALTER TABLE `projects` ADD COLUMN `auto_update` TINYINT(1) NOT NULL DEFAULT 0 AFTER `local_dir`',
    );
  }
  if (!(await hasColumn(p, 'update_commands'))) {
    await p.query('ALTER TABLE `projects` ADD COLUMN `update_commands` TEXT NULL AFTER `auto_update`');
  }
}

/** @param {{ context: import('mysql2/promise').Pool }} ctx */
export async function down({ context: p }) {
  if (await hasColumn(p, 'update_commands'))
    await p.query('ALTER TABLE `projects` DROP COLUMN `update_commands`');
  if (await hasColumn(p, 'auto_update')) await p.query('ALTER TABLE `projects` DROP COLUMN `auto_update`');
}
