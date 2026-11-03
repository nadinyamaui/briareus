// @ts-check
// The per-session database server pool is gone: sessions now always get their own
// database on the server the project's .env template names (lib/dbpool.js). Its
// servers, the projects' switch into it, the dump it restored on each claim and the
// shares of its servers have nothing left to read them.

const COLUMNS = {
  db_pool_enabled: 'TINYINT(1) NOT NULL DEFAULT 0 AFTER `update_commands`',
  db_restore_sql: "VARCHAR(512) NOT NULL DEFAULT '' AFTER `db_pool_database`",
};

/**
 * @param {import('mysql2/promise').Pool} p
 * @param {string} column
 */
async function hasColumn(p, column) {
  const [rows] = await p.query(
    'SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?',
    ['projects', column],
  );
  return /** @type {any[]} */ (rows).length > 0;
}

/** @param {{ context: import('mysql2/promise').Pool }} ctx */
export async function up({ context: p }) {
  await p.query("DELETE FROM `shares` WHERE `kind` = 'dbServer'");
  await p.query('DROP TABLE IF EXISTS `db_servers`');
  for (const column of Object.keys(COLUMNS)) {
    if (await hasColumn(p, column)) await p.query(`ALTER TABLE \`projects\` DROP COLUMN \`${column}\``);
  }
}

// Brings the schema back, empty: the servers and settings `up` dropped are not restored.
/** @param {{ context: import('mysql2/promise').Pool }} ctx */
export async function down({ context: p }) {
  await p.query(`CREATE TABLE IF NOT EXISTS \`db_servers\` (
    \`id\`         INT UNSIGNED    NOT NULL AUTO_INCREMENT,
    \`label\`      VARCHAR(255)    NOT NULL,
    \`host\`       VARCHAR(255)    NOT NULL,
    \`port\`       INT UNSIGNED    NOT NULL,
    \`username\`   VARCHAR(255)    NOT NULL,
    \`password\`   VARCHAR(255)    NOT NULL DEFAULT '',
    \`enabled\`    TINYINT(1)      NOT NULL DEFAULT 1,
    \`sort_order\` INT             NOT NULL DEFAULT 0,
    \`created_at\` BIGINT UNSIGNED NOT NULL,
    \`updated_at\` BIGINT UNSIGNED NOT NULL,
    PRIMARY KEY (\`id\`)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  for (const [column, ddl] of Object.entries(COLUMNS)) {
    if (!(await hasColumn(p, column)))
      await p.query(`ALTER TABLE \`projects\` ADD COLUMN \`${column}\` ${ddl}`);
  }
}
