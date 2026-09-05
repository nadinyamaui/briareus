// @ts-check
import { loadDbServerRows, saveDbServer, deleteDbServer, getDbServerRow } from './db.js';

// The session database pool: each entry is one MySQL server (host, port and
// credentials) that a session can claim for itself while it runs, so parallel
// sessions never share a database. Entries live in the `db_servers` table and
// are edited from /settings; which projects claim one, and which database a
// session points at on it, is per project.
//
// Like projects, the table is read into memory at boot and refreshed on every
// write: the call sites (claiming a server, building a session's environment)
// are synchronous-adjacent and the rows change far more rarely than they are
// read.

let cache = [];

export const DB_SERVER_DEFAULTS = {
  label: '',
  host: '127.0.0.1',
  port: 3306,
  username: 'root',
  password: '',
  enabled: true,
  sortOrder: 0,
};

export async function initDbServers() {
  return reload();
}

async function reload() {
  try {
    cache = await loadDbServerRows();
  } catch (e) {
    console.error('Could not load database servers:', e.message);
  }
  return cache;
}

// Every server, including disabled ones: what /settings edits.
export function listDbServers() {
  return cache;
}

// The ones a session may claim.
export function activeDbServers() {
  return cache.filter((s) => s.enabled);
}

export function getDbServer(id) {
  return cache.find((s) => s.id === Number(id)) || null;
}

function normalizeServer(input, existing = null) {
  const base = existing || DB_SERVER_DEFAULTS;
  const s = { ...base };
  const has = (k) => Object.prototype.hasOwnProperty.call(input, k);

  if (has('host')) s.host = String(input.host || '').trim();
  if (!s.host) throw new Error('A database server needs a host');
  if (has('port')) s.port = Number(input.port);
  if (!Number.isInteger(s.port) || s.port < 1 || s.port > 65535) {
    throw new Error(`"${input.port}" is not a valid port`);
  }
  if (has('username')) s.username = String(input.username || '').trim();
  if (!s.username) throw new Error('A database server needs a username');
  if (has('password')) s.password = String(input.password ?? '');
  if (has('label')) s.label = String(input.label || '').trim();
  if (!s.label) s.label = `${s.host}:${s.port}`;
  if (has('enabled')) s.enabled = !!input.enabled;
  if (has('sortOrder')) s.sortOrder = Number(input.sortOrder) || 0;
  return s;
}

// Two entries for the same server would hand two sessions the same database,
// which is exactly what the pool exists to prevent.
function findClash(server, exceptId = null) {
  return (
    cache.find(
      (s) =>
        s.id !== exceptId && s.host.toLowerCase() === server.host.toLowerCase() && s.port === server.port,
    ) || null
  );
}

export async function createDbServer(input) {
  const server = normalizeServer(input);
  if (findClash(server)) throw new Error(`${server.host}:${server.port} is already in the pool`);
  if (!input.sortOrder) {
    server.sortOrder = cache.reduce((max, s) => Math.max(max, s.sortOrder), 0) + 1;
  }
  const saved = await saveDbServer(server);
  await reload();
  return saved;
}

export async function updateDbServer(id, input) {
  const existing = await getDbServerRow(id);
  if (!existing) throw new Error('Database server not found');
  const server = normalizeServer(input, existing);
  if (findClash(server, existing.id)) throw new Error(`${server.host}:${server.port} is already in the pool`);
  const saved = await saveDbServer({ ...server, id: existing.id });
  await reload();
  return saved;
}

export async function removeDbServer(id) {
  const removed = await deleteDbServer(id);
  await reload();
  return removed;
}
