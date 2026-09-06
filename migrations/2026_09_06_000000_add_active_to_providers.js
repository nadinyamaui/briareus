// @ts-check
// Providers could only be offered or deleted. An active flag lets an operator
// keep a configured login or endpoint around without letting new sessions use it.

/** @param {import('mysql2/promise').Pool} p */
async function hasColumn(p) {
  const [rows] = await p.query(
    'SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?',
    ['providers', 'active'],
  );
  return /** @type {any[]} */ (rows).length > 0;
}

/** @param {{ context: import('mysql2/promise').Pool }} ctx */
export async function up({ context: p }) {
  if (await hasColumn(p)) return;
  await p.query('ALTER TABLE `providers` ADD COLUMN `active` TINYINT(1) NOT NULL DEFAULT 1 AFTER `binary`');
}

/** @param {{ context: import('mysql2/promise').Pool }} ctx */
export async function down({ context: p }) {
  if (!(await hasColumn(p))) return;
  await p.query('ALTER TABLE `providers` DROP COLUMN `active`');
}
