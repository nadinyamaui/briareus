// @ts-check
// Adds, lists and changes the people who share this server, from the machine itself.
//
//   npm run users
//   npm run users -- --add Ana                 a member; --role admin for an admin
//   npm run users -- --user Ana --role admin   change a role
//   npm run users -- --disable Ana             her tokens stop working; --enable undoes it
//
// The API has no route to add a user or change a role, for the reason it has none to issue
// a token: a leaked token must not be able to make itself someone. A new user needs a
// token to do anything: `npm run create-token -- --user Ana …`.
//
// The server reloads the list every 15 seconds, so a disabled user's tokens stop within
// that. The last enabled admin cannot be demoted or disabled, or nobody could run the
// server's settings any more.
//
// Uses its own pool for the reason create-token does: this is not the moment to migrate.
import { parseArgs } from 'node:util';
import mysql from 'mysql2/promise';
import { getConfig } from '../lib/config.js';
import { insertUser, loadUserRows, updateUser } from '../lib/db.js';
import { activeAdmins, checkRole, checkUserName } from '../lib/users.js';

const { values } = parseArgs({
  options: {
    add: { type: 'string' },
    user: { type: 'string' },
    role: { type: 'string' },
    disable: { type: 'string' },
    enable: { type: 'string' },
  },
});

const { host, port, database, user, password } = getConfig().db;
const pool = mysql.createPool({ host, port, user, password, database, connectionLimit: 1 });
const day = (ms) => new Date(ms).toISOString().slice(0, 10);

/** @param {import('../lib/users.js').User[]} users @param {string} name */
function find(users, name) {
  const found = users.find((u) => u.name.toLowerCase() === name.toLowerCase());
  if (!found) throw new Error(`No user named ${name}: \`npm run users\` lists them`);
  return found;
}

/** @param {import('../lib/users.js').User[]} users @param {import('../lib/users.js').User} target */
function keepAnAdmin(users, target) {
  const admins = activeAdmins(users);
  if (admins.length === 1 && admins[0].id === target.id)
    throw new Error(`${target.name} is the last enabled admin: make another admin first`);
}

async function run() {
  const users = await loadUserRows(pool);
  if (values.add != null) {
    const name = checkUserName(values.add);
    if (users.some((u) => u.name.toLowerCase() === name.toLowerCase()))
      throw new Error(`There is already a user named ${name}`);
    const role = checkRole(values.role ?? 'member');
    await insertUser({ name, role }, pool);
    console.log(
      `Added ${name} (${role}). Give them a token: npm run create-token -- --user "${name}" --label …`,
    );
  } else if (values.user != null) {
    const target = find(users, values.user);
    if (values.role == null) throw new Error('Say what to change: --role admin|member');
    const role = checkRole(values.role);
    if (role !== 'admin') keepAnAdmin(users, target);
    await updateUser(target.id, { role }, pool);
    console.log(`${target.name} is now ${role === 'admin' ? 'an admin' : 'a member'}.`);
  } else if (values.disable != null) {
    const target = find(users, values.disable);
    keepAnAdmin(users, target);
    await updateUser(target.id, { disabledAt: Date.now() }, pool);
    console.log(`Disabled ${target.name}. The running server refuses their tokens within 15 seconds.`);
  } else if (values.enable != null) {
    const target = find(users, values.enable);
    await updateUser(target.id, { disabledAt: null }, pool);
    console.log(`Enabled ${target.name}.`);
  } else {
    for (const u of users) {
      const state = u.disabledAt == null ? `since ${day(u.createdAt)}` : `disabled ${day(u.disabledAt)}`;
      console.log(`${String(u.id).padStart(4)}  ${u.role.padEnd(6)}  ${state.padEnd(20)}  ${u.name}`);
    }
  }
}

try {
  await run();
} catch (e) {
  console.error(
    e.code === 'ER_NO_SUCH_TABLE'
      ? 'The database has no users table yet. Run `npm run migrate` first.'
      : e.message,
  );
  process.exitCode = 1;
} finally {
  await pool.end();
}
