// @ts-check
// The PR babysitter is gone: nothing starts conflict fixes, CI fixes or code reviews
// on a timer any more. Its project switch (projects.babysit_prs) and the errands it
// remembered per pull request head (the `babysitter` app_settings row) would otherwise
// stay behind with nothing reading them.
//
// Review rounds it started keep their `babysitter` source: they are history, and they
// still count toward their pull request's limit.
//
// The way down brings the switch back, off for every project; the remembered errands
// are not restored, and a babysitter started again would only try each errand once more.

/** @param {import('mysql2/promise').Pool} p */
async function hasColumn(p) {
  const [rows] = await p.query(
    'SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?',
    ['projects', 'babysit_prs'],
  );
  return /** @type {any[]} */ (rows).length > 0;
}

/** @param {{ context: import('mysql2/promise').Pool }} ctx */
export async function up({ context: p }) {
  if (await hasColumn(p)) await p.query('ALTER TABLE `projects` DROP COLUMN `babysit_prs`');
  await p.query('DELETE FROM `app_settings` WHERE `name` = ?', ['babysitter']);
}

/** @param {{ context: import('mysql2/promise').Pool }} ctx */
export async function down({ context: p }) {
  if (!(await hasColumn(p)))
    await p.query('ALTER TABLE `projects` ADD COLUMN `babysit_prs` TINYINT(1) NOT NULL DEFAULT 0');
}
