// @ts-check
// Issues, lists and revokes tokens for the client API (/api/v1) from the
// machine itself.
//
//   npm run create-token -- --label Desktop
//   npm run create-token -- --label iPhone --permission manage --repo owner/name --days 90
//   npm run create-token -- --list
//   npm run create-token -- --revoke <id>
//
// This is how the first token comes to exist: the API takes nothing else, so
// the first one cannot come from the API. After that an admin token issues
// and revokes the rest (`/settings/devices`), and this is only needed again
// once every admin token has been lost or has expired, or to revoke one
// without an admin token at hand.
//
// The token is printed once and stored as a hash. The change is written under
// a lock on the token row, so it cannot cross a change the server makes at the
// same moment, and the running server reloads the list every 15 seconds: no
// restart.
//
// Uses the same .env the server does, and talks to the database through a pool
// of its own rather than lib/db.js's, which would apply pending migrations on
// the way in: issuing a token is not the moment to change the schema.
import { parseArgs } from 'node:util';
import mysql from 'mysql2/promise';
import { getConfig } from '../lib/config.js';
import { updateAppSetting } from '../lib/db.js';
import { createMobileAuth } from '../lib/mobile-auth.js';

const { values } = parseArgs({
  options: {
    label: { type: 'string' },
    permission: { type: 'string', default: 'admin' },
    repo: { type: 'string', multiple: true, default: [] },
    days: { type: 'string', default: '365' },
    list: { type: 'boolean' },
    revoke: { type: 'string' },
  },
});

const config = getConfig();
if (!config.auth.passwordHash || !config.auth.secret) {
  console.error('The login is off, and the API answers nothing while it is.');
  console.error('Run `npm run set-password` first: a token is tied to the AUTH_SECRET it writes.');
  process.exit(1);
}
if (!values.label && !values.list && !values.revoke) {
  console.error('Name the token: npm run create-token -- --label Desktop');
  console.error('  --permission read|manage|admin   admin when absent');
  console.error('  --repo owner/name                a project it may use, repeatable; not for admin');
  console.error('  --days 1-365                     365 when absent');
  console.error('Or see and revoke the ones there are: --list, --revoke <id>');
  process.exit(2);
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
  update: (name, fallback, fn) => updateAppSetting(name, fallback, fn, pool),
});
const day = (ms) => new Date(ms).toISOString().slice(0, 10);

async function issue() {
  if (values.permission !== 'admin') {
    const [rows] = /** @type {any} */ (await pool.query('SELECT `repo` FROM `projects`'));
    const known = new Set(rows.map((row) => row.repo));
    const unknown = values.repo.filter((repo) => !known.has(repo));
    if (unknown.length) throw new Error(`No such project: ${unknown.join(', ')}`);
  }
  const { device, token } = await auth.create(
    { label: values.label, permission: values.permission, repos: values.repo, days: Number(values.days) },
    config.auth.secret,
  );
  const scope = device.permission === 'admin' ? 'every project' : device.repos.join(', ');
  console.log(`\n${token}\n`);
  console.log(`"${device.label}": ${device.permission} on ${scope}, good for ${values.days} days.`);
  console.log('It is shown this once. The running server accepts it within 15 seconds.');
}

function list() {
  const devices = auth.list();
  if (!devices.length) console.log('No tokens.');
  for (const d of devices) {
    const scope = d.permission === 'admin' ? 'every project' : d.repos.join(', ');
    const state = d.expiresAt <= Date.now() ? 'expired' : `until ${day(d.expiresAt)}`;
    console.log(`${d.id}  ${d.permission.padEnd(6)}  ${state.padEnd(16)}  ${d.label} (${scope})`);
  }
}

async function revoke(id) {
  if (!auth.list().some((d) => d.id === id)) throw new Error(`No token with id ${id}: --list shows them.`);
  await auth.revoke(id);
  console.log(
    `Revoked ${id}. The running server refuses it within 15 seconds, and ends its open streams within 30.`,
  );
}

try {
  await auth.init();
  if (values.list) list();
  else if (values.revoke) await revoke(values.revoke);
  else await issue();
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
