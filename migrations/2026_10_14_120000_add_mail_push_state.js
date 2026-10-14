// @ts-check
/** @param {{ context: import('mysql2/promise').Pool }} ctx */
export async function up({ context: p }) {
  await p.query('ALTER TABLE mail_accounts ADD COLUMN push_state LONGTEXT NULL');
}
/** @param {{ context: import('mysql2/promise').Pool }} ctx */
export async function down({ context: p }) {
  await p.query('ALTER TABLE mail_accounts DROP COLUMN push_state');
}
