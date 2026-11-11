// @ts-check
import { loadGithubLinkRows, saveGithubLink } from './db.js';

// Every GitHub account a user has ever linked (lib/me-routes.js), kept after they
// unlink it. A user's token is theirs to remove; what was done under it is not: commits
// made as that account are still that person's, and an approval on GitHub from it is
// still one a session of theirs may have made. The approval requirement of a pull
// request reads both from here (lib/review-approvals.js).
//
// Accounts are kept by GitHub's user id with the login they had: a renamed account is
// the same account, and its old login, which somebody else may take, is not.

/**
 * @param {{
 *   load?: () => Promise<{ userId: number, id: number | null, login: string }[]>,
 *   save?: (userId: number, account: { id: number | null, login: string }) => Promise<void>,
 * }} [options]
 */
export function createGithubLinks({ load = loadGithubLinkRows, save = saveGithubLink } = {}) {
  /** @type {{ userId: number, id: number | null, login: string }[]} */
  let rows = [];
  let ready = false;
  const requireReady = () => {
    if (!ready) throw Object.assign(new Error('Linked GitHub accounts are unavailable'), { status: 503 });
  };
  const has = (userId, account) =>
    rows.some(
      (r) => r.userId === userId && (r.id ?? null) === (account.id ?? null) && r.login === account.login,
    );
  return {
    async init() {
      const loaded = await load();
      // History is append-only. A link saved during this load must survive its snapshot.
      for (const entry of rows)
        if (!loaded.some((r) => r.userId === entry.userId && r.id === entry.id && r.login === entry.login))
          loaded.push(entry);
      rows = loaded;
      ready = true;
    },
    // Enter an account as linked by this user. Awaited where the link is made, so that
    // linking and unlinking at once still leaves the account on record.
    /** @param {number} userId @param {{ id?: number | null, login?: string | null } | null | undefined} account */
    async remember(userId, account) {
      if (!account?.login) return;
      const entry = {
        id: Number.isInteger(account.id) ? /** @type {number} */ (account.id) : null,
        login: account.login,
      };
      // Saving a new link does not need the old history loaded. Reads still fail
      // closed until init succeeds, and the write must succeed before credentials change.
      if (ready && has(userId, entry)) return;
      await save(userId, entry);
      if (!has(userId, entry)) rows.push({ userId, ...entry });
    },
    // Every account this user ever linked. Throws 503 before the list is loaded: an
    // empty answer would read as "never linked any".
    /** @param {number} userId */
    of(userId) {
      requireReady();
      return rows.filter((r) => r.userId === userId).map(({ id, login }) => ({ id, login }));
    },
    all() {
      requireReady();
      return rows.map(({ id, login }) => ({ id, login }));
    },
  };
}
