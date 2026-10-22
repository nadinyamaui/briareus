// @ts-check
import { loadAppSetting, saveAppSetting } from './db.js';

// Whose each WhatsApp account is (lib/users.js). An account is a WAHA session that a phone
// is linked to, so it reads and writes as that person: only its owner reaches it through
// /api/v1, and only their sessions get its chats. The `default` session, the one WAHA Core
// allows and the operator linked before users, belongs to the first admin; any other belongs
// to whoever starts it first. WAHA keeps the sessions; this keeps only who owns which.

const LEGACY = 'default';
const fail = (status, message) => Object.assign(new Error(message), { status });

/**
 * @param {{
 *   load?: typeof loadAppSetting,
 *   save?: typeof saveAppSetting,
 *   legacyOwner?: () => number | null,
 * }} [deps]
 */
export function createWhatsAppOwners({
  load = loadAppSetting,
  save = saveAppSetting,
  legacyOwner = () => null,
} = {}) {
  /** @type {Record<string, number>} */
  let owners = {};
  let writes = Promise.resolve();
  const ownerOf = (/** @type {string} */ account) =>
    owners[account] ?? (account === LEGACY ? legacyOwner() : null);
  return {
    async init() {
      const stored = await load('whatsapp_owners', {});
      owners = stored && typeof stored === 'object' ? stored : {};
    },
    ownerOf,
    /** @param {number | null | undefined} userId @param {string} account */
    owns(userId, account) {
      return userId != null && ownerOf(account) === userId;
    },
    // Makes an unowned account the user's, before its phone is linked; another user's
    // answers as missing.
    /** @param {number} userId @param {string} account */
    claim(userId, account) {
      const task = writes.then(async () => {
        const owner = ownerOf(account);
        if (owner === userId) return;
        if (owner != null) throw fail(404, 'WhatsApp account not found');
        const next = { ...owners, [account]: userId };
        await save('whatsapp_owners', next);
        owners = next;
      });
      writes = task.catch(() => {});
      return task;
    },
  };
}
