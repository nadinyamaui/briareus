// projects.post_review_to_github: whether a code review of the project writes to GitHub
// at all (its summary comment, inline findings, verdict replies, labels and approval) or
// keeps everything on the server, read through the API. On for every existing project, so
// their reviews stay exactly as they were.

/** @param {import('mysql2/promise').Pool} p @param {string} table @param {string} column */
async function hasColumn(p, table, column) {
  const [rows] = await p.query(
    'SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?',
    [table, column],
  );
  return /** @type {any[]} */ (rows).length > 0;
}

/** @param {{ context: import('mysql2/promise').Pool }} ctx */
export async function up({ context: p }) {
  if (await hasColumn(p, 'projects', 'post_review_to_github')) return;
  const after = (await hasColumn(p, 'projects', 'review_benchmark')) ? ' AFTER `review_benchmark`' : '';
  await p.query(
    `ALTER TABLE \`projects\` ADD COLUMN \`post_review_to_github\` TINYINT(1) NOT NULL DEFAULT 1${after}`,
  );
}

/** @param {{ context: import('mysql2/promise').Pool }} ctx */
export async function down({ context: p }) {
  if (await hasColumn(p, 'projects', 'post_review_to_github'))
    await p.query('ALTER TABLE `projects` DROP COLUMN `post_review_to_github`');
}
