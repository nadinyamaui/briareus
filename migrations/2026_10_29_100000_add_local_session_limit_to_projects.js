// @ts-check
// How many Local mode sessions may share a project's local checkout at once
// (lib/jobs.js, acquireLocalDir). One, the default, is the old behaviour.
//
// Guarded on the column already existing: ADD COLUMN is not idempotent.

/** @param {import('mysql2/promise').Pool} p */
async function hasColumn(p) {
  const [rows] = await p.query(
    'SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?',
    ['projects', 'local_session_limit'],
  );
  return /** @type {any[]} */ (rows).length > 0;
}

/** @param {{ context: import('mysql2/promise').Pool }} ctx */
export async function up({ context: p }) {
  if (!(await hasColumn(p)))
    await p.query(
      'ALTER TABLE `projects` ADD COLUMN `local_session_limit` TINYINT UNSIGNED NOT NULL DEFAULT 1 AFTER `local_dir`',
    );
}

/** @param {{ context: import('mysql2/promise').Pool }} ctx */
export async function down({ context: p }) {
  if (await hasColumn(p)) await p.query('ALTER TABLE `projects` DROP COLUMN `local_session_limit`');
}
