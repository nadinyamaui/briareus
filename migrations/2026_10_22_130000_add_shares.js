// @ts-check
// Which users a project or a server is shared with (lib/shares.js). One table for every
// kind, since a resource's id is a projects/db_servers row id or the id an app_settings
// list gave it (SSH, MCP, Forge, Envoyer), and the rule is the same for all: an admin
// reaches everything, a member what is shared with them.

/** @param {{ context: import('mysql2/promise').Pool }} ctx */
export async function up({ context: p }) {
  await p.query(`CREATE TABLE IF NOT EXISTS shares (
    kind VARCHAR(32) NOT NULL,
    resource_id VARCHAR(64) NOT NULL,
    user_id INT UNSIGNED NOT NULL,
    created_at BIGINT NOT NULL,
    PRIMARY KEY (kind, resource_id, user_id),
    KEY shares_user (user_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
}

/** @param {{ context: import('mysql2/promise').Pool }} ctx */
export async function down({ context: p }) {
  await p.query('DROP TABLE IF EXISTS shares');
}
