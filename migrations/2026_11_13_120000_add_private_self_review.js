// @ts-check
// A project can keep the code review of its own pull requests off GitHub
// (projects.private_self_review): the review registers and verifies its findings on the
// server and posts only one collapsed summary once nothing is left to fix, the way a
// team that reviews its own work before asking a colleague expects it. Off for every
// project, so reviews stay exactly what they were until somebody switches it on.
//
// Each review also keeps whether it ran as one (code_reviews.private_self_review): the
// commit status the outcome is published as must not quote a private finding, and it is
// computed long after the session that decided it.
//
// Both go last in their tables: earlier migrations place their own columns after named
// ones, and a column put between them would move when one of those is rolled back.

/** @param {import('mysql2/promise').Pool} p @param {string} table */
async function hasColumn(p, table) {
  const [rows] = await p.query(
    'SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?',
    [table, 'private_self_review'],
  );
  return /** @type {any[]} */ (rows).length > 0;
}

/** @param {{ context: import('mysql2/promise').Pool }} ctx */
export async function up({ context: p }) {
  if (!(await hasColumn(p, 'projects')))
    await p.query('ALTER TABLE `projects` ADD COLUMN `private_self_review` TINYINT(1) NOT NULL DEFAULT 0');
  if (!(await hasColumn(p, 'code_reviews')))
    await p.query(
      'ALTER TABLE `code_reviews` ADD COLUMN `private_self_review` TINYINT(1) NOT NULL DEFAULT 0',
    );
}

/** @param {{ context: import('mysql2/promise').Pool }} ctx */
export async function down({ context: p }) {
  if (await hasColumn(p, 'code_reviews'))
    await p.query('ALTER TABLE `code_reviews` DROP COLUMN `private_self_review`');
  if (await hasColumn(p, 'projects'))
    await p.query('ALTER TABLE `projects` DROP COLUMN `private_self_review`');
}
