// @ts-check
import { loadShareRows, replaceShares } from './db.js';

// What is shared with whom. A project, a database server, an SSH or MCP server, a Forge
// or Envoyer account can each be shared with any number of users (lib/users.js). An admin
// reaches every one of them whether or not it is shared; a member reaches only what is
// shared with them, so a resource nobody shared stays the admins'. Ids are strings, since
// some kinds are numbered rows and others ids an app_settings list gave out.

export const SHARE_KINDS = [
  'project',
  'dbServer',
  'sshServer',
  'mcpServer',
  'forgeAccount',
  'envoyerAccount',
];
const fail = (status, message) => Object.assign(new Error(message), { status });

/** @typedef {{ kind: string, id: string, userId: number }} Share */
/** @typedef {{ id: number, role: string }} Holder */

/**
 * @param {{ load?: () => Promise<Share[]>, replace?: (kind: string, id: string, userIds: number[]) => Promise<void> }} [options]
 */
export function createShares({ load = () => loadShareRows(), replace = replaceShares } = {}) {
  /** @type {Share[]} */
  let rows = [];
  let ready = false;
  let writes = Promise.resolve();
  function requireReady() {
    if (!ready) throw fail(503, 'Sharing is unavailable');
  }
  // Reads share the write queue so a delayed snapshot cannot undo a newer save.
  // A successful refresh also recovers a store whose initial load failed.
  function refresh() {
    const operation = writes.then(async () => {
      rows = await load();
      ready = true;
    });
    writes = operation.catch(() => {});
    return operation;
  }
  return {
    init() {
      const operation = writes.then(async () => {
        if (ready) return;
        rows = await load();
        ready = true;
      });
      writes = operation.catch(() => {});
      return operation;
    },
    refresh,
    /** @param {{ kind?: string, id?: string, userId?: number }} [filter] */
    list({ kind, id, userId } = {}) {
      requireReady();
      return rows.filter(
        (r) =>
          (kind === undefined || r.kind === kind) &&
          (id === undefined || r.id === id) &&
          (userId === undefined || r.userId === userId),
      );
    },
    // The ids of one kind shared with a user.
    /** @param {number} userId @param {string} kind */
    idsFor(userId, kind) {
      requireReady();
      return rows.filter((r) => r.kind === kind && r.userId === userId).map((r) => r.id);
    },
    // Whether a user may use a resource: always for an admin, otherwise only if shared.
    /** @param {Holder | null | undefined} user @param {string} kind @param {unknown} id */
    allows(user, kind, id) {
      if (!user) return false;
      if (user.role === 'admin') return true;
      requireReady();
      return rows.some((r) => r.kind === kind && r.id === String(id) && r.userId === user.id);
    },
    // Replaces who one resource is shared with. Queued so two saves land in order, and
    // the cache is reloaded from the table rather than patched, so it shows what stuck.
    /** @param {string} kind @param {string} id @param {number[]} userIds */
    set(kind, id, userIds) {
      const operation = writes.then(async () => {
        requireReady();
        await replace(kind, id, [...new Set(userIds)]);
        rows = await load();
      });
      writes = operation.catch(() => {});
      return operation;
    },
  };
}
