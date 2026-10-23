// @ts-check
// Credentials a user keeps for themselves (lib/user-credentials.js): their GitHub token
// first, so the changes they make and their sessions push are theirs. One row per user
// and kind, the value sealed with CREDENTIALS_KEY (lib/secretbox.js).

/** @param {{ context: import('mysql2/promise').Pool }} ctx */
export async function up({ context: p }) {
  await p.query(`CREATE TABLE IF NOT EXISTS user_credentials (
    user_id INT UNSIGNED NOT NULL,
    kind VARCHAR(32) NOT NULL,
    value TEXT NOT NULL,
    updated_at BIGINT NOT NULL,
    PRIMARY KEY (user_id, kind)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
}

/** @param {{ context: import('mysql2/promise').Pool }} ctx */
export async function down({ context: p }) {
  await p.query('DROP TABLE IF EXISTS user_credentials');
}
