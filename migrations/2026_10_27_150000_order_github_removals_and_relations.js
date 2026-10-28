// @ts-check
const columns = [
  ['github_items', 'removed_observed_at'],
  ['github_item_links', 'observed_at'],
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
  await p.query(`CREATE TABLE IF NOT EXISTS github_relation_observations (
    item_id BIGINT UNSIGNED NOT NULL,
    relation VARCHAR(16) NOT NULL,
    observed_at BIGINT UNSIGNED NOT NULL,
    PRIMARY KEY (item_id, relation),
    FOREIGN KEY (item_id) REFERENCES github_items(id) ON DELETE CASCADE
  ) ENGINE=InnoDB`);
}

export async function down({ context: p }) {
  await p.query('DROP TABLE IF EXISTS github_relation_observations');
  for (const [table, column] of [...columns].reverse())
    if (await hasColumn(p, table, column)) await p.query(`ALTER TABLE ${table} DROP COLUMN ${column}`);
}
