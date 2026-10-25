// @ts-check
async function hasColumn(p) {
  const [rows] = await p.query(
    'SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?',
    ['projects', 'database_backup_enabled'],
  );
  return rows.length > 0;
}

export async function up({ context: p }) {
  if (await hasColumn(p)) return;
  await p.query('ALTER TABLE `projects` ADD COLUMN `database_backup_enabled` TINYINT(1) NOT NULL DEFAULT 0');
  // Existing projects opt in, except HQ and Heedly (now OkaCore).
  await p.query(`UPDATE projects SET database_backup_enabled = 1
    WHERE LOWER(repo) NOT LIKE 'hqrentalsoftware/%'
      AND LOWER(repo) NOT LIKE '%heedly%'
      AND LOWER(repo) <> 'okanetsolutions/oka-core'`);
}

export async function down({ context: p }) {
  if (await hasColumn(p)) await p.query('ALTER TABLE `projects` DROP COLUMN `database_backup_enabled`');
}
