// @ts-check
/** @param {{ context: import('mysql2/promise').Pool }} ctx */
export async function up({ context: p }) {
  await p.query(`CREATE TABLE IF NOT EXISTS ssh_resource_samples (
    server_id BIGINT UNSIGNED NOT NULL,
    target CHAR(64) NOT NULL,
    at BIGINT NOT NULL,
    payload MEDIUMTEXT NOT NULL,
    PRIMARY KEY (server_id, target, at),
    KEY resource_samples_expiry (at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
}
/** @param {{ context: import('mysql2/promise').Pool }} ctx */
export async function down({ context: p }) {
  await p.query('DROP TABLE IF EXISTS ssh_resource_samples');
}
