// @ts-check
// The main dashboard's month and last-month windows filter on `at` alone;
// there is no project to narrow by first. The ledger's existing keys both lead
// with something else (`project_id`, `repo`), so neither can seek into a time
// range for that query and it reads the whole table instead. This is the index
// that access pattern wants.
//
// Guarded on the key already existing: `CREATE INDEX` is not idempotent, and a
// database restored from a dump taken after this shipped would already have it.

const KEY = 'turn_usage_at';

/** @param {import('mysql2/promise').Pool} p */
async function hasKey(p) {
  const [rows] = await p.query(
    'SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?',
    ['turn_usage', KEY],
  );
  return /** @type {any[]} */ (rows).length > 0;
}

/** @param {{ context: import('mysql2/promise').Pool }} ctx */
export async function up({ context: p }) {
  if (await hasKey(p)) return;
  await p.query(`ALTER TABLE \`turn_usage\` ADD KEY \`${KEY}\` (\`at\`)`);
}

/** @param {{ context: import('mysql2/promise').Pool }} ctx */
export async function down({ context: p }) {
  if (!(await hasKey(p))) return;
  await p.query(`ALTER TABLE \`turn_usage\` DROP KEY \`${KEY}\``);
}
