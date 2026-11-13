// @ts-check
// A pull request now gets 10 review rounds by default instead of 3. The column default
// follows, and every project still at the old default of 3 moves to 10: the setting
// shipped three days earlier with 3 written into every existing row, so a 3 is the old
// default rather than a choice. Other values, including 0 (no limit), are kept.
//
// The way down restores the old default and moves projects at 10 back to 3.

/** @param {import('mysql2/promise').Pool} p */
async function hasColumn(p) {
  const [rows] = await p.query(
    'SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?',
    ['projects', 'review_round_limit'],
  );
  return /** @type {any[]} */ (rows).length > 0;
}

/** @param {import('mysql2/promise').Pool} p @param {number} from @param {number} to */
async function moveDefault(p, from, to) {
  if (!(await hasColumn(p))) return;
  await p.query(
    `ALTER TABLE \`projects\` MODIFY COLUMN \`review_round_limit\` TINYINT UNSIGNED NOT NULL DEFAULT ${to}`,
  );
  await p.query('UPDATE `projects` SET `review_round_limit` = ? WHERE `review_round_limit` = ?', [to, from]);
}

/** @param {{ context: import('mysql2/promise').Pool }} ctx */
export async function up({ context: p }) {
  await moveDefault(p, 3, 10);
}

/** @param {{ context: import('mysql2/promise').Pool }} ctx */
export async function down({ context: p }) {
  await moveDefault(p, 10, 3);
}
