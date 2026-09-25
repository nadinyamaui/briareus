// @ts-check
// Run profiles: named configurations ▶ Run can serve (env overrides, commands
// to run first, tenant hostnames), for a multi-tenant app whose vertical and
// tenant the one fixed run command chain could not choose. Stored as the text
// typed in Settings, so comments and layout survive a save; lib/runprofiles.js
// reads it.
//
// Guarded on the column already existing, for the same reason as the worker
// runtime migration: ADD COLUMN is not idempotent.

/** @param {import('mysql2/promise').Pool} p */
async function hasColumn(p) {
  const [rows] = await p.query(
    'SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?',
    ['projects', 'run_profiles'],
  );
  return /** @type {any[]} */ (rows).length > 0;
}

/** @param {{ context: import('mysql2/promise').Pool }} ctx */
export async function up({ context: p }) {
  if (await hasColumn(p)) return;
  await p.query('ALTER TABLE `projects` ADD COLUMN `run_profiles` TEXT NULL AFTER `run_commands`');
}

/** @param {{ context: import('mysql2/promise').Pool }} ctx */
export async function down({ context: p }) {
  if (!(await hasColumn(p))) return;
  await p.query('ALTER TABLE `projects` DROP COLUMN `run_profiles`');
}
