// @ts-check
// Handling a review's findings is separate from the review agent finishing its run.
// Existing and new reviews wait for an explicit client decision to mark them handled.
/** @param {import('mysql2/promise').Pool} p */
async function hasColumn(p) {
  const [rows] = await p.query(
    'SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?',
    ['code_reviews', 'handling_status'],
  );
  return /** @type {any[]} */ (rows).length > 0;
}

/** @param {{ context: import('mysql2/promise').Pool }} ctx */
export async function up({ context: p }) {
  if (!(await hasColumn(p)))
    await p.query(
      "ALTER TABLE `code_reviews` ADD COLUMN `handling_status` ENUM('pending', 'handled') NOT NULL DEFAULT 'pending' AFTER `status`",
    );
}

/** @param {{ context: import('mysql2/promise').Pool }} ctx */
export async function down({ context: p }) {
  if (await hasColumn(p)) await p.query('ALTER TABLE `code_reviews` DROP COLUMN `handling_status`');
}
