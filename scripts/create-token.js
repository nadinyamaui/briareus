// @ts-check
// Issues, lists and revokes client API (/api/v1) tokens from the machine itself.
//
//   npm run create-token -- --label Desktop
//   npm run create-token -- --label iPhone --permission manage --repo owner/name --days 90
//   npm run create-token -- --list
//   npm run create-token -- --revoke <id>
//
// The API has no route to issue or list tokens, so a leaked token cannot mint more; a
// client can still revoke its own with `DELETE /token`.
//
// Tokens are signed with AUTH_SECRET, which the first run writes into .env if missing.
// Delete that line and rerun to revoke every token at once.
//
// The token is printed once and stored as a hash, written under a lock on the token row
// so it cannot cross a concurrent server change. The server reloads the list every 15
// seconds, so no restart is needed unless AUTH_SECRET was just written (read at boot).
//
// Uses its own pool rather than lib/db.js's, which would apply pending migrations:
// issuing a token is not the moment to change the schema.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import mysql from 'mysql2/promise';
import { getConfig, ROOT } from '../lib/config.js';
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

if (!values.label && !values.list && !values.revoke) {
  console.error('Name the token: npm run create-token -- --label Desktop');
  console.error('  --permission read|manage|admin   admin when absent');
  console.error('  --repo owner/name                a project it may use, repeatable; not for admin');
  console.error('  --days 1-365                     365 when absent');
  console.error('Or see and revoke the ones there are: --list, --revoke <id>');
  process.exit(2);
}

const config = getConfig();
let secret = config.auth.secret;
let wroteSecret = false;
// Only issuing needs a secret: listing and revoking must not switch the API on.
if (!secret && !values.list && !values.revoke) {
  // Appended rather than edited in, so the rest of .env stays untouched. A leftover empty
  // `AUTH_SECRET=` reads as unset, and this later line wins.
  secret = crypto.randomBytes(32).toString('base64url');
  const envPath = path.join(ROOT, '.env');
  const text = fs.readFileSync(envPath, 'utf8');
  fs.writeFileSync(envPath, `${text.replace(/\n*$/, '\n')}AUTH_SECRET=${secret}\n`, 'utf8');
  wroteSecret = true;
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
    secret,
  );
  const scope = device.permission === 'admin' ? 'every project' : device.repos.join(', ');
  console.log(`\n${token}\n`);
  console.log(`"${device.label}": ${device.permission} on ${scope}, good for ${values.days} days.`);
  console.log(
    wroteSecret
      ? 'It is shown this once. Restart the server to load the new AUTH_SECRET:  pm2 restart reviewer'
      : 'It is shown this once. The running server accepts it within 15 seconds.',
  );
}

function list() {
  const devices = auth.list();
  if (!devices.length) console.log('No tokens.');
  for (const d of devices) {
    const scope = d.permission === 'admin' ? 'every project' : d.repos.join(', ');
    const state = d.expiresAt <= Date.now() ? 'expired' : `until ${day(d.expiresAt)}`;
    const lastUsed = d.lastUsedAt == null ? 'never recorded' : new Date(d.lastUsedAt).toISOString();
    console.log(
      `${d.id}  ${d.permission.padEnd(6)}  ${state.padEnd(16)}  ${d.label} (${scope})  last used: ${lastUsed}`,
    );
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
