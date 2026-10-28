// @ts-check
// One user turn can write several ledger rows (a dsh turn whose sub-agents ran on other models
// books each model apart); they share this key so they still read as one turn.
/** @param {{ context: import('mysql2/promise').Pool }} ctx */
export async function up({ context: p }) {
  const [columns] = await p.query("SHOW COLUMNS FROM turn_usage LIKE 'turn_key'");
  if (!columns.length) await p.query('ALTER TABLE turn_usage ADD COLUMN turn_key VARCHAR(36) NULL');
}

/** @param {{ context: import('mysql2/promise').Pool }} ctx */
export async function down({ context: p }) {
  const [columns] = await p.query("SHOW COLUMNS FROM turn_usage LIKE 'turn_key'");
  if (columns.length) await p.query('ALTER TABLE turn_usage DROP COLUMN turn_key');
}
