// @ts-check
// Which project is the dashboard itself. A 🧭 orchestrator that finds a flaw
// in the tooling that runs it (a briefing, a worker tool, a loop) can hand the
// fix to a worker on that project, so the flag is what makes the fix_tooling
// tool point somewhere. One project at most carries it; lib/projects.js keeps
// that on save.
//
// Guarded on the column already existing, for the same reason as the worker
// runtime migration: ADD COLUMN is not idempotent.

/** @param {import('mysql2/promise').Pool} p */
async function hasColumn(p) {
  const [rows] = await p.query(
    'SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?',
    ['projects', 'is_self'],
  );
  return /** @type {any[]} */ (rows).length > 0;
}

/** @param {{ context: import('mysql2/promise').Pool }} ctx */
export async function up({ context: p }) {
  if (await hasColumn(p)) return;
  await p.query(`ALTER TABLE \`projects\`
    ADD COLUMN \`is_self\` TINYINT(1) NOT NULL DEFAULT 0 AFTER \`worker_budget_usd\``);
}

/** @param {{ context: import('mysql2/promise').Pool }} ctx */
export async function down({ context: p }) {
  if (!(await hasColumn(p))) return;
  await p.query('ALTER TABLE `projects` DROP COLUMN `is_self`');
}
