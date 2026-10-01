// @ts-check
// Browser push notifications went with the web UI, and their app_settings row
// would otherwise stay behind for good: the VAPID key pair, including its
// private half, and every browser's push subscription, with nothing left that
// sends to them.
//
// Nothing to bring back on the way down: a subscription is only good to the
// service worker that made it, and that is gone too.

/** @param {{ context: import('mysql2/promise').Pool }} ctx */
export async function up({ context: p }) {
  await p.query('DELETE FROM `app_settings` WHERE `name` = ?', ['web_push']);
}

export async function down() {}
