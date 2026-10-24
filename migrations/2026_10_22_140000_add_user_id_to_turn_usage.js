// @ts-check
// Who each turn was spent for: the user who owns the session (lib/users.js), so spend can
// be read per user. Every turn before this ran for the server's one operator, so they are
// filed under the earliest user, the original operator, regardless of their current role;
// later turns of sessions nobody started have none.

/** @param {import('mysql2/promise').Pool} p */
async function hasColumn(p) {
  const [rows] = await p.query(
    'SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?',
    ['turn_usage', 'user_id'],
  );
  return /** @type {any[]} */ (rows).length > 0;
}

/** @param {{ context: import('mysql2/promise').Pool }} ctx */
export async function up({ context: p }) {
  if (!(await hasColumn(p))) {
    await p.query(
      'ALTER TABLE `turn_usage` ADD COLUMN `user_id` INT UNSIGNED NULL AFTER `job_id`, ADD KEY `turn_usage_user_at` (`user_id`, `at`)',
    );
  }
  const [users] = await p.query('SELECT MIN(`id`) AS id FROM `users`');
  const owner = /** @type {any[]} */ (users)[0]?.id;
  if (owner != null) await p.query('UPDATE `turn_usage` SET `user_id` = ? WHERE `user_id` IS NULL', [owner]);
}

/** @param {{ context: import('mysql2/promise').Pool }} ctx */
export async function down({ context: p }) {
  if (await hasColumn(p))
    await p.query('ALTER TABLE `turn_usage` DROP KEY `turn_usage_user_at`, DROP COLUMN `user_id`');
}
