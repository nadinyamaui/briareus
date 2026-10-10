// @ts-check

/** @param {import('mysql2/promise').Pool} p */
async function hasColumn(p) {
  const [rows] = await p.query(
    'SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?',
    ['projects', 'whatsapp_tools_enabled'],
  );
  return /** @type {any[]} */ (rows).length > 0;
}

/** @param {{ context: import('mysql2/promise').Pool }} ctx */
export async function up({ context: p }) {
  if (!(await hasColumn(p))) {
    await p.query(
      'ALTER TABLE `projects` ADD COLUMN `whatsapp_tools_enabled` TINYINT(1) NOT NULL DEFAULT 0 AFTER `mail_tools_enabled`',
    );
  }
}

/** @param {{ context: import('mysql2/promise').Pool }} ctx */
export async function down({ context: p }) {
  if (await hasColumn(p)) await p.query('ALTER TABLE `projects` DROP COLUMN `whatsapp_tools_enabled`');
}
