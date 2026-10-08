// @ts-check
const columns = ['long_input_tokens', 'long_cached_input_tokens', 'long_output_tokens'];

/** @param {{ context: import('mysql2/promise').Pool }} ctx */
export async function up({ context: p }) {
  const [rows] = await p.query(
    'SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?',
    ['turn_usage'],
  );
  const found = new Set(rows.map((row) => row.COLUMN_NAME));
  for (const column of columns) {
    if (!found.has(column)) await p.query(`ALTER TABLE turn_usage ADD COLUMN ${column} BIGINT UNSIGNED NULL`);
  }
}

/** @param {{ context: import('mysql2/promise').Pool }} ctx */
export async function down({ context: p }) {
  const [rows] = await p.query(
    'SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?',
    ['turn_usage'],
  );
  const found = new Set(rows.map((row) => row.COLUMN_NAME));
  for (const column of columns) {
    if (found.has(column)) await p.query(`ALTER TABLE turn_usage DROP COLUMN ${column}`);
  }
}
