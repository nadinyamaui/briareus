// Keep Codex's cached input separately from total input, and distinguish new
// per-turn rows from older rows written with the CLI's lifetime counters.
/** @param {{ context: import('mysql2/promise').Pool }} ctx */
export async function up({ context: p }) {
  const [rows] = await p.query(
    'SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?',
    ['turn_usage'],
  );
  const found = new Set(rows.map((row) => row.COLUMN_NAME));
  if (!found.has('cached_input_tokens'))
    await p.query(
      'ALTER TABLE turn_usage ADD COLUMN cached_input_tokens BIGINT UNSIGNED NULL AFTER input_tokens',
    );
  if (!found.has('usage_is_delta'))
    await p.query(
      'ALTER TABLE turn_usage ADD COLUMN usage_is_delta TINYINT(1) NOT NULL DEFAULT 0 AFTER cached_input_tokens',
    );
}

/** @param {{ context: import('mysql2/promise').Pool }} ctx */
export async function down({ context: p }) {
  const [rows] = await p.query(
    'SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?',
    ['turn_usage'],
  );
  const found = new Set(rows.map((row) => row.COLUMN_NAME));
  if (found.has('usage_is_delta')) await p.query('ALTER TABLE turn_usage DROP COLUMN usage_is_delta');
  if (found.has('cached_input_tokens'))
    await p.query('ALTER TABLE turn_usage DROP COLUMN cached_input_tokens');
}
