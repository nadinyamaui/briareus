// @ts-check
// The migration CLI, driven from package.json:
//   npm run migrate                 apply every pending migration
//   npm run migrate:rollback        undo the last batch
//   npm run migrate:status          list ran / pending
//   npm run make:migration <name>   write an empty migration file
// Uses the same .env the server does.
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import mysql from 'mysql2/promise';
import { getConfig } from '../lib/config.js';
import {
  createMigrator,
  ensureDatabase,
  runMigrations,
  rollbackLastBatch,
  migrationFileName,
  MIGRATION_TEMPLATE,
  MIGRATIONS_DIR,
} from '../lib/migrator.js';

const [command = 'up', ...rest] = process.argv.slice(2);
const log = (/** @type {string} */ m) => console.log(m);

if (command === 'make') {
  const file = migrationFileName(rest.join(' '));
  const full = path.join(MIGRATIONS_DIR, file);
  await writeFile(full, MIGRATION_TEMPLATE, { flag: 'wx' });
  log(`Created migrations/${file}`);
  process.exit(0);
}

const { host, port, database, user, password } = getConfig().db;
await ensureDatabase({ host, port, database, user, password });
const pool = mysql.createPool({ host, port, user, password, database, connectionLimit: 2 });
try {
  if (command === 'up') {
    const done = await runMigrations(pool, { log });
    log(done.length ? `Ran ${done.length} migration(s)` : 'Nothing to migrate');
  } else if (command === 'rollback') {
    const done = await rollbackLastBatch(pool, { log });
    log(done.length ? `Rolled back ${done.length} migration(s)` : 'Nothing to roll back');
  } else if (command === 'status') {
    const { umzug } = createMigrator(pool);
    for (const m of await umzug.executed()) log(`  ran      ${m.name}`);
    for (const m of await umzug.pending()) log(`  pending  ${m.name}`);
  } else {
    console.error(`Unknown command "${command}": use up, rollback, status or make <name>`);
    process.exitCode = 2;
  }
} finally {
  await pool.end();
}
