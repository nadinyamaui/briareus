// @ts-check
// The orchestration budget is gone: nothing caps what an orchestrator and its
// workers spend any more, so the project's cap has nothing left to read it.
//
// The way down brings the column back empty; the caps it held are not kept.

/** @param {{ context: import('mysql2/promise').Pool }} ctx */
export async function up({ context: p }) {
  await p.query('ALTER TABLE `projects` DROP COLUMN `worker_budget_usd`');
}

/** @param {{ context: import('mysql2/promise').Pool }} ctx */
export async function down({ context: p }) {
  await p.query(
    'ALTER TABLE `projects` ADD COLUMN `worker_budget_usd` DECIMAL(10,2) NULL AFTER `worker_effort`',
  );
}
