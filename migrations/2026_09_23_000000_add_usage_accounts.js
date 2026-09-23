// @ts-check
// Snapshot the actual account used on each turn; session/provider settings can
// change later. Older turns remain unattributed rather than inferred incorrectly.
const columns = {
  account_id: 'INT NULL',
  account_label: 'VARCHAR(255) NULL',
  session_title: 'TEXT NULL',
};

/** @param {import('mysql2/promise').Pool} p */
async function existing(p) {
  const [rows] = await p.query(
    'SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?',
    ['turn_usage'],
  );
  return new Set(/** @type {any[]} */ (rows).map((r) => r.COLUMN_NAME));
}

/** @param {{ context: import('mysql2/promise').Pool }} ctx */
export async function up({ context: p }) {
  const found = await existing(p);
  for (const [name, type] of Object.entries(columns)) {
    if (!found.has(name)) await p.query(`ALTER TABLE turn_usage ADD COLUMN \`${name}\` ${type}`);
  }
}

/** @param {{ context: import('mysql2/promise').Pool }} ctx */
export async function down({ context: p }) {
  const found = await existing(p);
  for (const name of Object.keys(columns)) {
    if (found.has(name)) await p.query(`ALTER TABLE turn_usage DROP COLUMN \`${name}\``);
  }
}
