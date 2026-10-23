// @ts-check
import { loadUserRows } from './db.js';

// The people who share this server. Every client token belongs to one of them
// (lib/mobile-auth.js), and the gateway (lib/api-v1.js) answers a request as that
// person. An admin runs the server: its settings, and every project; a member
// reaches only what they were given. Users are added and changed from the
// machine (`npm run users`), as tokens are, so a leaked token cannot make
// itself a new person; the server reloads the list on the token's cadence.

export const ROLES = ['admin', 'member'];
const fail = (status, message) => Object.assign(new Error(message), { status });

/** @typedef {{ id: number, name: string, role: string, createdAt: number, disabledAt: number | null }} User */

/** @param {unknown} name */
export function checkUserName(name) {
  const trimmed = typeof name === 'string' ? name.trim() : '';
  if (!trimmed || trimmed.length > 100) throw fail(400, 'Enter a name for the user (up to 100 characters)');
  return trimmed;
}

/** @param {unknown} role */
export function checkRole(role) {
  if (typeof role !== 'string' || !ROLES.includes(role)) throw fail(400, 'Choose admin or member');
  return role;
}

// The admins still able to act, the ones a demotion or disable must not leave at zero.
/** @param {User[]} users */
export function activeAdmins(users) {
  return users.filter((u) => u.role === 'admin' && u.disabledAt == null);
}

/** @param {{ load?: () => Promise<User[]> }} [options] */
export function createUsers({ load = () => loadUserRows() } = {}) {
  /** @type {User[]} */
  let users = [];
  let ready = false;
  function requireReady() {
    if (!ready) throw fail(503, 'User accounts are unavailable');
  }
  return {
    async init() {
      users = await load();
      ready = true;
    },
    // A failed reload keeps the last good list.
    async refresh() {
      users = await load();
      ready = true;
    },
    list() {
      requireReady();
      return users;
    },
    // Null for an unknown id. Before the list loads it throws 503 like the token store,
    // since a 401 for a good token could make a client drop it.
    /** @param {unknown} id */
    get(id) {
      requireReady();
      return users.find((u) => u.id === id) || null;
    },
  };
}
