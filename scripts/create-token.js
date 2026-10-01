// @ts-check
// Issues a token for the client API (/api/v1) from the machine itself.
//
//   npm run create-token -- --label Desktop
//   npm run create-token -- --label iPhone --permission manage --repo owner/name --days 90
//
// This is how the first token comes to exist: the API takes nothing else, so
// the first one cannot come from the API. After that an admin token issues
// and revokes the rest (`/settings/devices`), and this is only needed again
// once every admin token has been lost or has expired.
//
// It is also how the API comes to be switched on: every token is signed with
// AUTH_SECRET, and the first run writes a random one into .env when there is
// none. Delete that line and run this again to revoke every token at once.
//
// The token is printed once and stored as a hash. The running server keeps
// the token list in memory, so it has to be restarted to learn of this one;
// the script says so when it is done.
//
// Uses the same .env the server does, and talks to the database directly
// rather than through lib/db.js, which would apply pending migrations on the
// way in: issuing a token is not the moment to change the schema.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import mysql from 'mysql2/promise';
import { getConfig, ROOT } from '../lib/config.js';
import { createMobileAuth } from '../lib/mobile-auth.js';

const { values } = parseArgs({
  options: {
    label: { type: 'string' },
    permission: { type: 'string', default: 'admin' },
    repo: { type: 'string', multiple: true, default: [] },
    days: { type: 'string', default: '365' },
  },
});

if (!values.label) {
  console.error('Name the token: npm run create-token -- --label Desktop');
  console.error('  --permission read|manage|admin   admin when absent');
  console.error('  --repo owner/name                a project it may use, repeatable; not for admin');
  console.error('  --days 1-365                     365 when absent');
  process.exit(2);
}

const config = getConfig();
let secret = config.auth.secret;
if (!secret) {
  // Appended rather than edited in, so every other line of .env (and every
  // comment) stays exactly where it was. An empty `AUTH_SECRET=` left over
  // from an older install reads as unset, and this line, coming later, wins.
  secret = crypto.randomBytes(32).toString('base64url');
  const envPath = path.join(ROOT, '.env');
  const text = fs.readFileSync(envPath, 'utf8');
  fs.writeFileSync(envPath, `${text.replace(/\n*$/, '\n')}AUTH_SECRET=${secret}\n`, 'utf8');
  console.log('AUTH_SECRET was not set: wrote a new one to .env. It signs every token.');
}

const { host, port, database, user, password } = config.db;
const pool = mysql.createPool({ host, port, user, password, database, connectionLimit: 1 });
const auth = createMobileAuth({
  load: async (name, fallback) => {
    const [rows] = /** @type {any} */ (
      await pool.query('SELECT `value` FROM `app_settings` WHERE `name` = ?', [name])
    );
    return (rows.length && JSON.parse(rows[0].value)) || fallback;
  },
  save: async (name, value) => {
    await pool.query(
      'INSERT INTO `app_settings` (`name`, `value`, `updated_at`) VALUES (?, ?, ?)' +
        ' ON DUPLICATE KEY UPDATE `value` = VALUES(`value`), `updated_at` = VALUES(`updated_at`)',
      [name, JSON.stringify(value), Date.now()],
    );
  },
});

try {
  await auth.init();
  if (values.permission !== 'admin') {
    const [rows] = /** @type {any} */ (await pool.query('SELECT `repo` FROM `projects`'));
    const known = new Set(rows.map((row) => row.repo));
    const unknown = values.repo.filter((repo) => !known.has(repo));
    if (unknown.length) throw new Error(`No such project: ${unknown.join(', ')}`);
  }
  const { device, token } = await auth.create(
    { label: values.label, permission: values.permission, repos: values.repo, days: Number(values.days) },
    secret,
  );
  const scope = device.permission === 'admin' ? 'every project' : device.repos.join(', ');
  console.log(`\n${token}\n`);
  console.log(`"${device.label}": ${device.permission} on ${scope}, good for ${values.days} days.`);
  console.log('It is shown this once. Restart the server for it to take effect:  pm2 restart reviewer');
} catch (e) {
  console.error(
    e.code === 'ER_NO_SUCH_TABLE'
      ? 'The database has no schema yet. Run `npm run migrate` first.'
      : e.message,
  );
  process.exitCode = 1;
} finally {
  await pool.end();
}
