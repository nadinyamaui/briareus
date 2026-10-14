// @ts-check
// Written with the message, cleared only after the session wake has been saved.
/** @param {{ context: import('mysql2/promise').Pool }} ctx */
export async function up({ context: p }) {
  await p.query(`ALTER TABLE mail_messages
    ADD COLUMN wake_pending TINYINT(1) NOT NULL DEFAULT 0,
    ADD KEY mail_messages_pending_wakes (account_id, wake_pending)`);
}
/** @param {{ context: import('mysql2/promise').Pool }} ctx */
export async function down({ context: p }) {
  await p.query('ALTER TABLE mail_messages DROP KEY mail_messages_pending_wakes, DROP COLUMN wake_pending');
}
