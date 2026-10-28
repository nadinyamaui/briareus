// @ts-check
const columns = [
  ['github_repositories', 'board_observed_at'],
  ['github_pull_requests', 'draft_observed_at'],
];

async function hasColumn(p, table, column) {
  const [rows] = await p.query(
    'SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?',
    [table, column],
  );
  return rows.length > 0;
}

export async function up({ context: p }) {
  for (const [table, column] of columns)
    if (!(await hasColumn(p, table, column)))
      await p.query(`ALTER TABLE ${table} ADD COLUMN ${column} BIGINT UNSIGNED NOT NULL DEFAULT 0`);
}

export async function down({ context: p }) {
  for (const [table, column] of [...columns].reverse())
    if (await hasColumn(p, table, column)) await p.query(`ALTER TABLE ${table} DROP COLUMN ${column}`);
}
