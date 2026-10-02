// @ts-check
// Laravel Envoyer, proxied per account: the operator keeps a list of Envoyer
// accounts, each an API token and the one project it is available to, and a
// client of that project lists the account's Envoyer projects, their servers
// and deployments, and starts a deployment through /api/v1. The server makes
// the call with the account's token, which is stored sealed (lib/secretbox.js)
// and never leaves the server: an Envoyer token reaches every project of its
// account, not only the one Briareus project it was given to.
//
// The list lives in app_settings under `envoyer_accounts`, like the SSH
// servers: a handful of rows, read whole and written whole.

import { loadAppSetting, saveAppSetting } from './db.js';
import { seal, open } from './secretbox.js';

const BASE = 'https://envoyer.io/api';

export const ENVOYER_DEFAULTS = { label: '', repo: '' };

/** @param {string} message @param {number} status */
function httpError(message, status) {
  return Object.assign(new Error(message), { status });
}

// The ids go into Envoyer's path as they are, so anything but a plain number
// is refused here rather than handed on as a path segment.
/** @param {unknown} value @param {string} name */
function envoyerId(value, name) {
  const text = String(value ?? '');
  if (!/^[1-9]\d{0,17}$/.test(text)) throw httpError(`Invalid ${name} id`, 400);
  return text;
}

/** @param {Record<string, any>} input @param {Record<string, any>} [existing] */
export function normalizeEnvoyerAccount(input, existing = ENVOYER_DEFAULTS) {
  const a = { ...existing };
  for (const key of ['label', 'repo']) {
    if (Object.hasOwn(input, key)) a[key] = String(input[key] ?? '').trim();
  }
  if (!/^[\w.-]+\/[\w.-]+$/.test(a.repo)) throw new Error('Choose the project the account is available to');
  if (!a.label) throw new Error('Name the account');
  if (a.label.length > 200) throw new Error('Account name too long');
  // The token is write-only: a body without it keeps the stored one, so a
  // form can move the account to another project without retyping it.
  if (Object.hasOwn(input, 'token')) {
    const token = String(input.token ?? '').trim();
    if (!token) throw new Error('Paste the account’s Envoyer API token');
    if (token.length > 4096 || /\s/.test(token)) throw new Error('That is not an Envoyer API token');
    a.token = seal(token);
  }
  if (!a.token) throw new Error('Paste the account’s Envoyer API token');
  return a;
}

// What leaves the service: the sealed token stays behind.
/** @param {Record<string, any>} account */
function publicAccount({ token, ...a }) {
  return a;
}

// What Envoyer's refusal means for the client that asked. Its 401 and 403
// are about the stored token, not the client's, and passing them on as they
// are would read as the client's own token being refused, so they become a
// 502 naming the account. A 404 or a 422 is about what the client sent.
/** @param {Response} res @param {string} label */
async function refusal(res, label) {
  const body = await res.json().catch(() => ({}));
  if (res.status === 401 || res.status === 403)
    return httpError(
      `Envoyer refused the token of “${label}” (${res.status}): check it and its scopes in Settings`,
      502,
    );
  if (res.status === 429) return httpError('Envoyer is rate limiting this account; try again shortly', 429);
  if (res.status === 404) return httpError('Not found on Envoyer', 404);
  if (res.status === 400 || res.status === 422) {
    const detail =
      body.message ||
      Object.values(body.errors || {})
        .flat()
        .find((e) => typeof e === 'string');
    return httpError(detail || 'Envoyer rejected the request', 422);
  }
  return httpError(`Envoyer answered ${res.status}`, 502);
}

/**
 * @param {{ load?: typeof loadAppSetting, save?: typeof saveAppSetting, request?: typeof fetch }} [deps]
 */
export function createEnvoyerService({ load = loadAppSetting, save = saveAppSetting, request = fetch } = {}) {
  /** @type {Record<string, any>[]} */
  let accounts = [];
  let writes = Promise.resolve();

  /** @param {(rows: Record<string, any>[]) => Record<string, any>[]} fn */
  function mutate(fn) {
    const task = writes.then(async () => {
      const next = fn(accounts);
      await save('envoyer_accounts', next);
      accounts = next;
    });
    writes = task.catch(() => {});
    return task;
  }

  // The account a proxied call runs as. It must be the one named and be
  // given to the project the request names: the gateway has already held a
  // project-scoped token to that project, so this is what keeps it to its
  // own accounts. Another project's account answers as one that is not there.
  /** @param {unknown} id @param {unknown} repo */
  function accountFor(id, repo) {
    const a = accounts.find((a) => a.id === Number(id));
    if (!a || typeof repo !== 'string' || a.repo !== repo) throw httpError('Envoyer account not found', 404);
    return a;
  }

  /** @param {Record<string, any>} account @param {string} method @param {string} path @param {object} [body] */
  async function call(account, method, path, body) {
    let res;
    try {
      res = await request(`${BASE}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${open(account.token)}`,
          Accept: 'application/json',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      throw httpError('Envoyer did not answer', 502);
    }
    if (!res.ok) throw await refusal(res, account.label);
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }

  /** @param {unknown} id @param {unknown} repo @param {string} path */
  const get = (id, repo, path) => call(accountFor(id, repo), 'GET', path);
  const project = (projectId) => `/projects/${envoyerId(projectId, 'project')}`;

  return {
    async init() {
      accounts = await load('envoyer_accounts', []);
    },
    // Every account, or, given a project, the ones available to it.
    /** @param {string} [repo] */
    list(repo) {
      return accounts.filter((a) => repo === undefined || a.repo === repo).map(publicAccount);
    },
    /** @param {Record<string, any>} input */
    async create(input) {
      const a = { ...normalizeEnvoyerAccount(input), id: 0 };
      await mutate((rows) => {
        a.id = Math.max(Date.now(), ...rows.map((r) => r.id + 1));
        return [...rows, a];
      });
      return publicAccount(a);
    },
    /** @param {number} id @param {Record<string, any>} input */
    async update(id, input) {
      let updated;
      await mutate((rows) => {
        const old = rows.find((a) => a.id === id);
        if (!old) throw httpError('Envoyer account not found', 404);
        updated = { ...normalizeEnvoyerAccount(input, old), id };
        return rows.map((a) => (a.id === id ? updated : a));
      });
      return publicAccount(updated);
    },
    /** @param {number} id */
    async remove(id) {
      await mutate((rows) => {
        if (!rows.some((a) => a.id === id)) throw httpError('Envoyer account not found', 404);
        return rows.filter((a) => a.id !== id);
      });
    },

    /** @param {unknown} id @param {unknown} repo */
    async projects(id, repo) {
      const doc = await get(id, repo, '/projects');
      return { projects: doc?.projects ?? [] };
    },
    /** @param {unknown} id @param {unknown} repo @param {unknown} projectId */
    async project(id, repo, projectId) {
      const doc = await get(id, repo, project(projectId));
      return { project: doc?.project ?? null };
    },
    /** @param {unknown} id @param {unknown} repo @param {unknown} projectId */
    async servers(id, repo, projectId) {
      const doc = await get(id, repo, `${project(projectId)}/servers`);
      return { servers: doc?.servers ?? [] };
    },
    /** @param {unknown} id @param {unknown} repo @param {unknown} projectId */
    async deployments(id, repo, projectId) {
      const doc = await get(id, repo, `${project(projectId)}/deployments`);
      return { deployments: doc?.deployments ?? [] };
    },
    /** @param {unknown} id @param {unknown} repo @param {unknown} projectId @param {unknown} deploymentId */
    async deployment(id, repo, projectId, deploymentId) {
      const path = `${project(projectId)}/deployments/${envoyerId(deploymentId, 'deployment')}`;
      const doc = await get(id, repo, path);
      return { deployment: doc?.deployment ?? null };
    },
    // Envoyer queues the deployment and answers with nothing, so `ok` means
    // queued; the deployments list shows it running. With no branch or tag
    // named, Envoyer deploys the project's own default branch.
    /** @param {unknown} id @param {Record<string, any>} input @param {unknown} projectId */
    async deploy(id, input, projectId) {
      const account = accountFor(id, input.repo);
      const path = `${project(projectId)}/deployments`;
      let body = {};
      if (input.branch != null && input.tag != null) throw httpError('Name a branch or a tag, not both', 400);
      for (const from of ['branch', 'tag']) {
        if (input[from] == null) continue;
        const ref = String(input[from]).trim();
        if (!ref || ref.length > 255) throw httpError(`Name the ${from} to deploy`, 400);
        body = { from, [from]: ref };
      }
      await call(account, 'POST', path, body);
      return { ok: true };
    },
  };
}
