// @ts-check
async function hasColumn(p) {
  const [rows] = await p.query(
    "SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'github_repositories' AND COLUMN_NAME = 'issues_board_observed_at'",
  );
  return rows.length > 0;
}

export async function up({ context: p }) {
  if (!(await hasColumn(p))) {
    await p.query(
      'ALTER TABLE github_repositories ADD COLUMN issues_board_observed_at BIGINT UNSIGNED NOT NULL DEFAULT 0',
    );
    await p.query(`UPDATE github_repositories SET issues_board_observed_at = board_observed_at
      WHERE issues_error IS NULL AND issues_truncated = FALSE`);
  }
}

export async function down({ context: p }) {
  if (await hasColumn(p))
    await p.query('ALTER TABLE github_repositories DROP COLUMN issues_board_observed_at');
}
