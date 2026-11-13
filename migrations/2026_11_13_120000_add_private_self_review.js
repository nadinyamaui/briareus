// @ts-check
// A project can keep the code review of its own pull requests off GitHub
// (projects.private_self_review): the review registers and verifies its findings on the
// server and posts only one collapsed summary once nothing is left to fix, the way a
// team that reviews its own work before asking a colleague expects it. Off for every
// project, so reviews stay exactly what they were until somebody switches it on.

/** @param {import('mysql2/promise').Pool} p */
async function hasColumn(p) {
  const [rows] = await p.query(
    'SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?',
    ['projects', 'private_self_review'],
  );
  return /** @type {any[]} */ (rows).length > 0;
}

/** @param {{ context: import('mysql2/promise').Pool }} ctx */
export async function up({ context: p }) {
  if (!(await hasColumn(p)))
    await p.query(
      'ALTER TABLE `projects` ADD COLUMN `private_self_review` TINYINT(1) NOT NULL DEFAULT 0 AFTER `security_review`',
    );
}

/** @param {{ context: import('mysql2/promise').Pool }} ctx */
export async function down({ context: p }) {
  if (await hasColumn(p)) await p.query('ALTER TABLE `projects` DROP COLUMN `private_self_review`');
}
