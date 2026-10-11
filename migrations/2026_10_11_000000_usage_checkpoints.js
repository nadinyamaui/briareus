// @ts-check
/** @param {{ context: import('mysql2/promise').Pool }} ctx */
export async function up({ context: p }) {
  const [columns] = await p.query("SHOW COLUMNS FROM turn_usage LIKE 'usage_key'");
  if (!columns.length)
    await p.query(
      'ALTER TABLE turn_usage ADD COLUMN usage_key VARCHAR(36) NULL, ADD UNIQUE KEY turn_usage_checkpoint (usage_key)',
    );
}

/** @param {{ context: import('mysql2/promise').Pool }} ctx */
export async function down({ context: p }) {
  const [columns] = await p.query("SHOW COLUMNS FROM turn_usage LIKE 'usage_key'");
  if (columns.length)
    await p.query('ALTER TABLE turn_usage DROP INDEX turn_usage_checkpoint, DROP COLUMN usage_key');
}
