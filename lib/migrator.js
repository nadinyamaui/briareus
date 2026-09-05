// @ts-check
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import mysql from 'mysql2/promise';
import { Umzug } from 'umzug';

// Schema changes are files in migrations/, Laravel-style: one timestamped
// module per change, each exporting `up` and `down`, applied once in name
// order and recorded in the `migrations` table with the batch that ran them so
// a rollback undoes exactly the last `migrate`. The server runs pending ones
// at boot (a fresh checkout still only needs a running MySQL); `npm run
// migrate` and friends drive the same thing from the shell.

// Create the database itself if it is missing, so a fresh checkout only needs
// a running MySQL, with no manual CREATE DATABASE step, whether the server or the
// migrate CLI is the first to connect.
/** @param {{ host: string, port: number, database: string, user: string, password: string }} db */
export async function ensureDatabase({ host, port, database, user, password }) {
  // The name goes into DDL as an identifier, where placeholders cannot be used.
  if (!/^[A-Za-z0-9_$]+$/.test(database)) {
    throw new Error(`DB_DATABASE must be a plain identifier, got "${database}"`);
  }
  const bootstrap = await mysql.createConnection({ host, port, user, password, connectTimeout: 10000 });
  try {
    await bootstrap.query(
      `CREATE DATABASE IF NOT EXISTS \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
    );
  } finally {
    await bootstrap.end().catch(() => {});
  }
}

export const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

/**
 * Umzug wants a storage adapter; this is the `migrations` table, kept as
 * Laravel lays it out (`migration`, `batch`) so the rollback unit is a batch.
 * @param {import('mysql2/promise').Pool} p
 */
function tableStorage(p) {
  const ensure = () =>
    p.query(`CREATE TABLE IF NOT EXISTS \`migrations\` (
      \`id\`        INT UNSIGNED    NOT NULL AUTO_INCREMENT,
      \`migration\` VARCHAR(255)    NOT NULL,
      \`batch\`     INT UNSIGNED    NOT NULL,
      \`ran_at\`    BIGINT UNSIGNED NOT NULL,
      PRIMARY KEY (\`id\`),
      UNIQUE KEY \`migrations_name\` (\`migration\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  // Every `up` in one run shares a batch number, fixed the first time the
  // storage is asked to log something in this run.
  /** @type {number | null} */
  let batch = null;
  return {
    async executed() {
      await ensure();
      const [rows] = await p.query('SELECT `migration` FROM `migrations` ORDER BY `id`');
      return /** @type {any[]} */ (rows).map((r) => r.migration);
    },
    /** @param {{ name: string }} m */
    async logMigration({ name }) {
      if (batch === null) {
        const [rows] = await p.query('SELECT COALESCE(MAX(`batch`), 0) AS b FROM `migrations`');
        batch = Number(/** @type {any[]} */ (rows)[0].b) + 1;
      }
      await p.query('INSERT INTO `migrations` (`migration`, `batch`, `ran_at`) VALUES (?, ?, ?)', [
        name,
        batch,
        Date.now(),
      ]);
    },
    /** @param {{ name: string }} m */
    async unlogMigration({ name }) {
      await p.query('DELETE FROM `migrations` WHERE `migration` = ?', [name]);
    },
    async lastBatch() {
      await ensure();
      const [rows] = await p.query(
        'SELECT `migration` FROM `migrations` WHERE `batch` = (SELECT MAX(`batch`) FROM `migrations`) ORDER BY `id` DESC',
      );
      return /** @type {any[]} */ (rows).map((r) => r.migration);
    },
  };
}

/**
 * @param {import('mysql2/promise').Pool} p
 * @param {{ log?: (msg: string) => void }} [opts]
 */
export function createMigrator(p, opts = {}) {
  const storage = tableStorage(p);
  const umzug = new Umzug({
    migrations: async () => {
      const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.js')).sort();
      return files.map((file) => ({
        name: file.replace(/\.js$/, ''),
        path: path.join(MIGRATIONS_DIR, file),
        up: async (params) => (await load(file)).up(params),
        down: async (params) => (await load(file)).down(params),
      }));
    },
    context: p,
    storage,
    logger: opts.log
      ? {
          info: (e) => opts.log?.(`${e.event} ${e.name}`),
          warn: (e) => opts.log?.(`${e.event} ${e.name}`),
          error: (e) => opts.log?.(`${e.event} ${e.name}`),
          debug: () => {},
        }
      : undefined,
  });
  return { umzug, storage };
}

/** @param {string} file */
function load(file) {
  return import(pathToFileURL(path.join(MIGRATIONS_DIR, file)).href);
}

// Two runners against one database (two server processes booting, or the
// server and `npm run migrate`) would both read the same pending list and
// both try to apply it; the loser dies on duplicate DDL. A server-side
// advisory lock (GET_LOCK, so nothing schema-level and nothing left behind if
// the process dies) serialises them: the second waits, then finds nothing
// pending. Held on a connection of its own, since the lock belongs to the
// session that took it and the pool hands out whichever is free.
const LOCK_NAME = 'reviewer_migrations';
const LOCK_WAIT_S = 120;

/**
 * @template T
 * @param {import('mysql2/promise').Pool} p
 * @param {() => Promise<T>} fn
 */
async function withMigrationLock(p, fn) {
  const conn = await p.getConnection();
  try {
    const [rows] = await conn.query('SELECT GET_LOCK(?, ?) AS ok', [LOCK_NAME, LOCK_WAIT_S]);
    if (Number(/** @type {any[]} */ (rows)[0].ok) !== 1) {
      throw new Error(`Another migration run is still holding the lock after ${LOCK_WAIT_S}s`);
    }
    try {
      return await fn();
    } finally {
      await conn.query('SELECT RELEASE_LOCK(?)', [LOCK_NAME]).catch(() => {});
    }
  } finally {
    conn.release();
  }
}

// What the server calls at boot: apply whatever has not run yet.
/** @param {import('mysql2/promise').Pool} p */
export function runMigrations(p, opts = {}) {
  return withMigrationLock(p, () => createMigrator(p, opts).umzug.up());
}

// Undo the most recent batch, newest file first, as Laravel's `migrate:rollback` does.
/** @param {import('mysql2/promise').Pool} p */
export function rollbackLastBatch(p, opts = {}) {
  return withMigrationLock(p, async () => {
    const { umzug, storage } = createMigrator(p, opts);
    const names = await storage.lastBatch();
    if (!names.length) return [];
    return umzug.down({ migrations: names });
  });
}

// A new, empty migration file named like Laravel names them:
// YYYY_MM_DD_HHMMSS_<snake_name>.js. Returns the path written.
/** @param {string} name */
export function migrationFileName(name, now = new Date()) {
  const slug = String(name)
    .trim()
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
  if (!slug) throw new Error('A migration needs a name, e.g. add_notes_to_projects');
  const pad = (/** @type {number} */ n) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}_${pad(now.getMonth() + 1)}_${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `${stamp}_${slug}.js`;
}

export const MIGRATION_TEMPLATE = `// @ts-check
// Why this change is needed goes here.

/** @param {{ context: import('mysql2/promise').Pool }} ctx */
export async function up({ context: p }) {
  await p.query(\`ALTER TABLE \\\`projects\\\` ADD COLUMN \\\`example\\\` VARCHAR(255) NOT NULL DEFAULT ''\`);
}

/** @param {{ context: import('mysql2/promise').Pool }} ctx */
export async function down({ context: p }) {
  await p.query(\`ALTER TABLE \\\`projects\\\` DROP COLUMN \\\`example\\\`\`);
}
`;
