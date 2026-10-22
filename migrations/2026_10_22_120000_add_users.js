// @ts-check
// The people who share this server. Until now there was one, "the operator", and
// a token stood for them without saying so; every token issued before this
// change is handed to the first admin created here, so each keeps working as
// the same person it always meant.

/** @param {{ context: import('mysql2/promise').Pool }} ctx */
export async function up({ context: p }) {
  await p.query(`CREATE TABLE IF NOT EXISTS users (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    role VARCHAR(16) NOT NULL,
    created_at BIGINT NOT NULL,
    disabled_at BIGINT NULL,
    UNIQUE KEY users_name (name)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  const [users] = await p.query('SELECT id FROM users ORDER BY id LIMIT 1');
  let ownerId = /** @type {any[]} */ (users)[0]?.id;
  if (ownerId == null) {
    const [result] = await p.query('INSERT INTO users (name, role, created_at) VALUES (?, ?, ?)', [
      'Owner',
      'admin',
      Date.now(),
    ]);
    ownerId = /** @type {any} */ (result).insertId;
  }
  // A token whose user is not here belongs to Owner too: after a rollback and re-run the
  // table starts over, and a token left naming an old id would pass to whoever takes it next.
  const [idRows] = await p.query('SELECT id FROM users');
  const ids = new Set(/** @type {any[]} */ (idRows).map((u) => Number(u.id)));
  const [rows] = await p.query("SELECT `value` FROM app_settings WHERE `name` = 'mobile_devices'");
  const stored = /** @type {any[]} */ (rows)[0]?.value;
  const devices = stored ? JSON.parse(stored) : null;
  const orphan = (d) => d.userId == null || !ids.has(Number(d.userId));
  if (Array.isArray(devices) && devices.some(orphan)) {
    for (const d of devices) if (orphan(d)) d.userId = Number(ownerId);
    await p.query("UPDATE app_settings SET `value` = ?, updated_at = ? WHERE `name` = 'mobile_devices'", [
      JSON.stringify(devices),
      Date.now(),
    ]);
  }
}

// Tokens keep their userId: older code ignores the field, and a re-run hands any
// whose user is gone back to the first admin.
/** @param {{ context: import('mysql2/promise').Pool }} ctx */
export async function down({ context: p }) {
  await p.query('DROP TABLE IF EXISTS users');
}
