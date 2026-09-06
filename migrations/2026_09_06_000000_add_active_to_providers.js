// @ts-check
// Providers could only be offered or deleted. An active flag lets an operator
// keep a configured login or endpoint around without letting new sessions use it.

/** @param {{ context: import('mysql2/promise').Pool }} ctx */
export async function up({ context: p }) {
  await p.query('ALTER TABLE `providers` ADD COLUMN `active` TINYINT(1) NOT NULL DEFAULT 1 AFTER `binary`');
}

/** @param {{ context: import('mysql2/promise').Pool }} ctx */
export async function down({ context: p }) {
  await p.query('ALTER TABLE `providers` DROP COLUMN `active`');
}
