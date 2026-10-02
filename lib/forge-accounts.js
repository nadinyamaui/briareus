// @ts-check
// The Laravel Forge accounts the proxy (lib/forge.js) calls with: each is one
// Forge organization and an API token for it, and names the projects it is
// available to, so a client offers a project's Forge servers and not every
// organization the operator has. Added and edited through /api/v1 rather
// than .env, so a second organization needs no restart.
//
// Like SSH servers, the list lives in `app_settings` and is held in memory;
// the token is stored sealed under CREDENTIALS_KEY (lib/secretbox.js) and
// never leaves the server: a client sees only that one is set.

import { loadAppSetting, saveAppSetting } from './db.js';
import { seal, open } from './secretbox.js';

export const FORGE_ACCOUNT_DEFAULTS = { label: '', organization: '', repos: [] };

/** @param {string} message @param {number} status */
function httpError(message, status) {
  return Object.assign(new Error(message), { status });
}

/** @param {Record<string, any>} input @param {Record<string, any>} [existing] */
function normalizeAccount(input, existing = { ...FORGE_ACCOUNT_DEFAULTS, token: '' }) {
  const a = { ...existing };
  if (Object.hasOwn(input, 'label')) a.label = String(input.label ?? '').trim();
  if (Object.hasOwn(input, 'organization')) a.organization = String(input.organization ?? '').trim();
  // The slug in forge.laravel.com/<organization>/…; it goes into Forge's paths.
  if (!/^[a-z0-9][a-z0-9_-]{0,99}$/i.test(a.organization))
    throw new Error('Enter the organization slug from your Forge URLs');
  if (Object.hasOwn(input, 'repos')) {
    if (!Array.isArray(input.repos) || input.repos.some((r) => typeof r !== 'string'))
      throw new Error('`repos` is a list of projects');
    a.repos = [...new Set(input.repos.map((r) => r.trim()).filter(Boolean))];
  }
  if (a.repos.some((r) => !/^[\w.-]+\/[\w.-]+$/.test(r))) throw new Error('Choose projects as owner/name');
  // A blank or absent token keeps the stored one, so a form can be saved
  // without retyping it.
  const token = Object.hasOwn(input, 'token') ? String(input.token ?? '').trim() : '';
  if (token) {
    if (token.length > 4096) throw new Error('Forge token too long');
    a.token = seal(token);
  }
  if (!a.token) throw new Error('Enter a Forge API token');
  if (!a.label) a.label = a.organization;
  if (a.label.length > 200) throw new Error('Label too long');
  return a;
}

// What leaves the service: the sealed token stays behind, its presence does not.
/** @param {Record<string, any>} a */
function publicAccount({ token, ...a }) {
  return { ...a, hasToken: !!token };
}

export function createForgeAccounts({ load = loadAppSetting, save = saveAppSetting } = {}) {
  /** @type {Record<string, any>[]} */
  let accounts = [];
  let writes = Promise.resolve();
  /** @param {(rows: Record<string, any>[]) => Record<string, any>[]} fn */
  function mutate(fn) {
    const task = writes.then(async () => {
      const next = fn(accounts);
      await save('forge_accounts', next);
      accounts = next;
    });
    writes = task.catch(() => {});
    return task;
  }
  return {
    async init() {
      accounts = (await load('forge_accounts', [])) || [];
    },
    // Every account, or with a project those available to it: the choice a
    // client offers while working on that project.
    /** @param {string} [repo] */
    list(repo) {
      return accounts.filter((a) => repo === undefined || a.repos.includes(repo)).map(publicAccount);
    },
    /** @param {Record<string, any>} input */
    async create(input) {
      const a = { ...normalizeAccount(input), id: 0 };
      await mutate((rows) => {
        a.id = Math.max(Date.now(), ...rows.map((r) => r.id + 1));
        return [...rows, a];
      });
      return publicAccount(a);
    },
    /** @param {number} id @param {Record<string, any>} input */
    async update(id, input) {
      /** @type {Record<string, any>} */
      let updated = {};
      await mutate((rows) => {
        const old = rows.find((a) => a.id === id);
        if (!old) throw httpError('Forge account not found', 404);
        updated = normalizeAccount(input, old);
        return rows.map((a) => (a.id === id ? updated : a));
      });
      return publicAccount(updated);
    },
    /** @param {number} id */
    async remove(id) {
      await mutate((rows) => {
        if (!rows.some((a) => a.id === id)) throw httpError('Forge account not found', 404);
        return rows.filter((a) => a.id !== id);
      });
    },
    // The opened token and organization, for the proxy's call and nothing else.
    /** @param {unknown} id */
    credentials(id) {
      const a = accounts.find((a) => String(a.id) === String(id));
      if (!a) throw httpError('Forge account not found', 404);
      return { label: a.label, organization: a.organization, token: open(a.token) };
    },
  };
}
