// @ts-check
/** @param {{ context: import('mysql2/promise').Pool }} ctx */
export async function up({ context: p }) {
  await p.query(`CREATE TABLE IF NOT EXISTS task_sessions (
    id VARCHAR(64) NOT NULL PRIMARY KEY,
    repo VARCHAR(255) NOT NULL,
    meta LONGTEXT NOT NULL,
    updated_at BIGINT NOT NULL,
    KEY task_sessions_repo (repo)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
}
/** @param {{ context: import('mysql2/promise').Pool }} ctx */
export async function down({ context: p }) {
  await p.query('DROP TABLE IF EXISTS task_sessions');
}
