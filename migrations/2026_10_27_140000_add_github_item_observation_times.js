// @ts-check
const columns = ['reference_observed_at', 'full_observed_at'];

async function hasColumn(p, column) {
  const [rows] = await p.query(
    "SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'github_items' AND COLUMN_NAME = ?",
    [column],
  );
  return rows.length > 0;
}

export async function up({ context: p }) {
  for (const column of columns)
    if (!(await hasColumn(p, column))) {
      await p.query(`ALTER TABLE github_items ADD COLUMN ${column} BIGINT UNSIGNED NOT NULL DEFAULT 0`);
      if (column === 'full_observed_at')
        await p.query(
          'UPDATE github_items SET full_observed_at = observed_at WHERE source_updated_at IS NOT NULL',
        );
    }
}

export async function down({ context: p }) {
  for (const column of [...columns].reverse())
    if (await hasColumn(p, column)) await p.query(`ALTER TABLE github_items DROP COLUMN ${column}`);
}
