// @ts-check
import { deleteUserCredential, loadUserCredentialRows, saveUserCredential } from './db.js';
import { open, seal } from './secretbox.js';

// What each user keeps for themselves, apart from what the server is given: their GitHub
// token (lib/github-identity.js) and, later, their own integrations. Stored sealed and
// opened only when used, so a cached row or a dump holds no plaintext. A value is any
// JSON the kind defines.

/**
 * @param {{
 *   load?: () => Promise<{ userId: number, kind: string, value: string }[]>,
 *   save?: (userId: number, kind: string, value: string) => Promise<void>,
 *   remove?: (userId: number, kind: string) => Promise<void>,
 * }} [options]
 */
export function createUserCredentials({
  load = loadUserCredentialRows,
  save = saveUserCredential,
  remove = deleteUserCredential,
} = {}) {
  /** @type {Map<string, string>} `${userId}:${kind}` -> sealed JSON */
  let rows = new Map();
  let writes = Promise.resolve();
  const key = (/** @type {number} */ userId, /** @type {string} */ kind) => `${userId}:${kind}`;
  return {
    async init() {
      rows = new Map((await load()).map((r) => [key(r.userId, r.kind), r.value]));
    },
    // The opened value, or null when the user keeps none of this kind.
    /** @param {number | null | undefined} userId @param {string} kind */
    get(userId, kind) {
      if (userId == null) return null;
      const sealed = rows.get(key(userId, kind));
      return sealed ? JSON.parse(open(sealed)) : null;
    },
    /** @param {number} userId @param {string} kind @param {unknown} value */
    async set(userId, kind, value) {
      const sealed = seal(JSON.stringify(value));
      const operation = writes.then(async () => {
        await save(userId, kind, sealed);
        rows.set(key(userId, kind), sealed);
      });
      writes = operation.catch(() => {});
      return operation;
    },
    /** @param {number} userId @param {string} kind */
    async remove(userId, kind) {
      const operation = writes.then(async () => {
        await remove(userId, kind);
        rows.delete(key(userId, kind));
      });
      writes = operation.catch(() => {});
      return operation;
    },
  };
}
