// @ts-check
import { loadAppSetting, updateAppSetting } from './db.js';

// Whose each WhatsApp account is (lib/users.js). An account is a WAHA session that a phone
// is linked to, so it reads and writes as that person: only its owner reaches it through
// /api/v1, and only their sessions get its chats. The `default` session, the one WAHA Core
// allows and the operator linked before users, belongs to the original operator. Existing
// WAHA sessions do too; a new account belongs to whoever starts it first. WAHA keeps
// the sessions; this keeps only who owns which.

const LEGACY = 'default';
const fail = (status, message) => Object.assign(new Error(message), { status });

/**
 * @param {{
 *   load?: typeof loadAppSetting,
 *   update?: typeof updateAppSetting,
 *   legacyOwner?: () => number | null,
 *   lookupAccount?: (account: string) => Promise<unknown>,
 *   listAccounts?: () => Promise<{ accounts: { id: string }[] }>,
 * }} [deps]
 */
export function createWhatsAppOwners({
  load = loadAppSetting,
  update = updateAppSetting,
  legacyOwner = () => null,
  lookupAccount = async () => null,
  listAccounts = async () => ({ accounts: [] }),
} = {}) {
  /** @type {Record<string, number>} */
  let owners = {};
  let loaded = false;
  let writes = Promise.resolve();
  const ownerIn = (map, account) =>
    Object.hasOwn(map, account) ? map[account] : account === LEGACY ? legacyOwner() : null;
  const ownerOf = (/** @type {string} */ account) => (loaded ? ownerIn(owners, account) : null);
  async function changeOwners(fn) {
    // Concurrent INSERT IGNORE/row-lock upgrades can deadlock; MySQL rolls the loser back.
    for (let attempt = 0; ; attempt++) {
      try {
        return await update('whatsapp_owners', {}, fn);
      } catch (e) {
        if (e.code !== 'ER_LOCK_DEADLOCK' || attempt === 2) throw e;
      }
    }
  }
  return {
    ready: () => loaded,
    init() {
      const task = writes.then(async () => {
        try {
          const stored = await load('whatsapp_owners', {});
          let next = stored && typeof stored === 'object' ? stored : {};
          if (!loaded) {
            const { accounts } = await listAccounts();
            if (accounts.length) {
              // Discovery must merge into the locked map, not a startup snapshot.
              const { value } = await changeOwners((current) => {
                for (const { id } of accounts) {
                  if (Object.hasOwn(current, id)) continue;
                  const owner = legacyOwner();
                  if (owner == null) throw fail(503, 'Legacy WhatsApp owner is unavailable');
                  Object.defineProperty(current, id, { value: owner, enumerable: true });
                }
              });
              next = value;
            }
          }
          owners = next;
          loaded = true;
        } catch (e) {
          loaded = false;
          throw e;
        }
      });
      writes = task.catch(() => {});
      return task;
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
        if (!loaded) throw fail(503, 'WhatsApp ownership could not be loaded; try again shortly');
        const { value } = await changeOwners(async (current) => {
          if (ownerIn(current, account) != null) return;
          // A pre-existing WAHA session may already be linked, even when stopped.
          let assigned = userId;
          try {
            if (await lookupAccount(account)) {
              assigned = legacyOwner();
              if (assigned == null) throw fail(503, 'Legacy WhatsApp owner is unavailable');
            }
          } catch (e) {
            // Local allowlist rejection does not prove the WAHA session is missing.
            if (e.status !== 404 || e.code === 'WHATSAPP_ACCOUNT_EXCLUDED') throw e;
          }
          Object.defineProperty(current, account, { value: assigned, enumerable: true });
        });
        owners = value;
        if (ownerOf(account) !== userId) throw fail(404, 'WhatsApp account not found');
      });
      writes = task.catch(() => {});
      return task;
    },
  };
}
