// @ts-check
// Whose mailbox each is (lib/users.js): a user reaches only their own, and their sessions'
// mail tools only theirs. Every mailbox connected before this was the one operator's, so
// they go to the first admin, the user the users migration made of them.

/** @param {import('mysql2/promise').Pool} p */
async function hasColumn(p) {
  const [rows] = await p.query(
    'SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?',
    ['mail_accounts', 'user_id'],
  );
  return /** @type {any[]} */ (rows).length > 0;
}

/** @param {{ context: import('mysql2/promise').Pool }} ctx */
export async function up({ context: p }) {
  if (await hasColumn(p)) return;
  await p.query(
    'ALTER TABLE `mail_accounts` ADD COLUMN `user_id` INT UNSIGNED NULL AFTER `id`, ADD KEY `mail_accounts_user` (`user_id`)',
  );
  const [admins] = await p.query("SELECT MIN(`id`) AS id FROM `users` WHERE `role` = 'admin'");
  const owner = /** @type {any[]} */ (admins)[0]?.id;
  if (owner != null)
    await p.query('UPDATE `mail_accounts` SET `user_id` = ? WHERE `user_id` IS NULL', [owner]);
}

/** @param {{ context: import('mysql2/promise').Pool }} ctx */
export async function down({ context: p }) {
  if (await hasColumn(p))
    await p.query('ALTER TABLE `mail_accounts` DROP KEY `mail_accounts_user`, DROP COLUMN `user_id`');
}
