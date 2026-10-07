// @ts-check
// The mailboxes Briareus syncs (lib/mail.js) and the messages it keeps from
// them. Message and thread ids are the provider's own: Gmail's are hex, but
// Microsoft Graph's are case-sensitive base64, so they are stored ascii_bin
// rather than under the table's case-insensitive collation, where two of them
// could collide.
/** @param {{ context: import('mysql2/promise').Pool }} ctx */
export async function up({ context: p }) {
  await p.query(`CREATE TABLE IF NOT EXISTS mail_accounts (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    provider VARCHAR(16) NOT NULL,
    email VARCHAR(320) NOT NULL,
    label VARCHAR(200) NOT NULL DEFAULT '',
    enabled TINYINT(1) NOT NULL DEFAULT 1,
    sync_days INT NOT NULL,
    credentials TEXT NOT NULL,
    sync_state LONGTEXT NULL,
    status VARCHAR(16) NOT NULL DEFAULT 'connected',
    last_sync_at BIGINT NULL,
    last_sync_error TEXT NULL,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL,
    UNIQUE KEY mail_accounts_address (provider, email)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  await p.query(`CREATE TABLE IF NOT EXISTS mail_messages (
    account_id BIGINT UNSIGNED NOT NULL,
    id VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    thread_id VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT '',
    folder_id VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT '',
    received_at BIGINT NOT NULL,
    from_name VARCHAR(500) NOT NULL DEFAULT '',
    from_address VARCHAR(320) NOT NULL DEFAULT '',
    recipients LONGTEXT NOT NULL,
    subject TEXT NOT NULL,
    snippet TEXT NOT NULL,
    labels TEXT NOT NULL,
    in_inbox TINYINT(1) NOT NULL DEFAULT 0,
    is_read TINYINT(1) NOT NULL DEFAULT 0,
    is_starred TINYINT(1) NOT NULL DEFAULT 0,
    attachments TEXT NOT NULL,
    body_text MEDIUMTEXT NULL,
    body_html MEDIUMTEXT NULL,
    body_truncated TINYINT(1) NOT NULL DEFAULT 0,
    message_id TEXT NULL,
    web_url TEXT NULL,
    synced_at BIGINT NOT NULL,
    PRIMARY KEY (account_id, id),
    KEY mail_messages_account_received (account_id, received_at),
    KEY mail_messages_thread (account_id, thread_id),
    KEY mail_messages_received (received_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
}
/** @param {{ context: import('mysql2/promise').Pool }} ctx */
export async function down({ context: p }) {
  await p.query('DROP TABLE IF EXISTS mail_messages');
  await p.query('DROP TABLE IF EXISTS mail_accounts');
}
