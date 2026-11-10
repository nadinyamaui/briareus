// @ts-check
// A code review's security pass, tracked apart from the rest of the review.
//
// projects.security_review is the project's policy: `off` (no pass runs, the default
// and what every existing project keeps), `advisory` (the pass runs and its result is
// kept, and an incomplete pass does not hold the review outcome back) or `required` (a
// pass that did not run, did not complete or failed blocks the outcome).
//
// The pass itself needs no table of its own: it is one more row in code_review_stages
// (stage `security`), whose detail keeps the coverage record the server accepted, so it
// belongs to its review and starts over with it like every other stage.
//
// That detail grows from TEXT to MEDIUMTEXT with it: beside six assessments it now holds
// one entry per finding the pass recorded, and a record of a hundred findings in wide
// characters does not fit in 64 KB.
//
// code_review_findings.security marks a finding as part of the security result. Only
// the server sets it, on registration, for a review whose security pass completed (or
// from the earlier decision a finding is reconciled with); the free-text `type` beside
// it stays what the agent calls the defect. security_entry says which finding of the
// pass's record the row publishes, by the id the server gave it when it accepted the
// record: every recorded finding has to be published by exactly one row. code_review_decisions.security carries the
// same mark on the pull request's decision about the claim, which outlives the finding:
// a later round has to know that a fix still owed, or a dismissal, was a security one.
// Once set it stays.
//
// code_review_security holds the pull request's security result as last computed, per
// pull request like the outcome beside it, and written in the same transaction: the
// policy it was computed under (so a change of policy is noticed the next time the
// server sees the pull request), the result, why, and the coverage it rests on.
//
// Nothing is back-filled. A finding or a decision stored before this migration is not a
// security one, and a review stored before it has no `security` stage: under `advisory`
// or `required` its security result reads as not run, never as passed.
//
// Guarded on what already exists: ADD COLUMN is not idempotent.

/** @param {import('mysql2/promise').Pool} p @param {string} table @param {string} column */
async function hasColumn(p, table, column) {
  const [rows] = await p.query(
    'SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?',
    [table, column],
  );
  return /** @type {any[]} */ (rows).length > 0;
}

/** @param {import('mysql2/promise').Pool} p @param {string} table @param {string} column */
async function columnType(p, table, column) {
  const [rows] = await p.query(
    'SELECT DATA_TYPE AS type FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?',
    [table, column],
  );
  return String(/** @type {any[]} */ (rows)[0]?.type || '').toLowerCase();
}

/** @param {{ context: import('mysql2/promise').Pool }} ctx */
export async function up({ context: p }) {
  await p.query(`CREATE TABLE IF NOT EXISTS code_review_security (
    repo VARCHAR(255) NOT NULL,
    pr_number INT UNSIGNED NOT NULL,
    -- The review the result is computed from, as on code_review_outcomes. No foreign
    -- key: it may be gone.
    code_review_id INT UNSIGNED NULL,
    -- The pull request's head the result is for, and the head the pass ran on.
    head_sha VARCHAR(64) NULL,
    reviewed_sha VARCHAR(64) NULL,
    -- The project's policy when the result was computed.
    policy ENUM('off', 'advisory', 'required') NOT NULL DEFAULT 'off',
    result ENUM('not_required', 'not_run', 'pending', 'incomplete', 'failed', 'passed') NOT NULL DEFAULT 'not_required',
    -- Whether that result held the review outcome back: only under the required policy.
    blocking TINYINT(1) NOT NULL DEFAULT 0,
    stale TINYINT(1) NOT NULL DEFAULT 0,
    -- JSON: the machine-readable reasons, and the coverage record the result rests on.
    reasons MEDIUMTEXT NULL,
    coverage MEDIUMTEXT NULL,
    computed_at BIGINT UNSIGNED NULL,
    created_at BIGINT UNSIGNED NOT NULL,
    updated_at BIGINT UNSIGNED NOT NULL,
    PRIMARY KEY (repo, pr_number)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  if (!(await hasColumn(p, 'projects', 'security_review')))
    await p.query(
      "ALTER TABLE `projects` ADD COLUMN `security_review` ENUM('off', 'advisory', 'required') NOT NULL DEFAULT 'off' AFTER `enforce_review_outcome`",
    );
  if (!(await hasColumn(p, 'code_review_findings', 'security')))
    await p.query(
      'ALTER TABLE `code_review_findings` ADD COLUMN `security` TINYINT(1) NOT NULL DEFAULT 0 AFTER `type`',
    );
  if (!(await hasColumn(p, 'code_review_findings', 'security_entry')))
    await p.query(
      'ALTER TABLE `code_review_findings` ADD COLUMN `security_entry` INT UNSIGNED NULL AFTER `security`',
    );
  if ((await columnType(p, 'code_review_stages', 'detail')) === 'text')
    await p.query('ALTER TABLE `code_review_stages` MODIFY `detail` MEDIUMTEXT NULL');
  if (!(await hasColumn(p, 'code_review_decisions', 'security')))
    await p.query(
      'ALTER TABLE `code_review_decisions` ADD COLUMN `security` TINYINT(1) NOT NULL DEFAULT 0 AFTER `verification`',
    );
}

/** @param {{ context: import('mysql2/promise').Pool }} ctx */
export async function down({ context: p }) {
  if (await hasColumn(p, 'code_review_decisions', 'security'))
    await p.query('ALTER TABLE `code_review_decisions` DROP COLUMN `security`');
  if (await hasColumn(p, 'code_review_findings', 'security_entry'))
    await p.query('ALTER TABLE `code_review_findings` DROP COLUMN `security_entry`');
  if (await hasColumn(p, 'code_review_findings', 'security'))
    await p.query('ALTER TABLE `code_review_findings` DROP COLUMN `security`');
  if (await hasColumn(p, 'projects', 'security_review'))
    await p.query('ALTER TABLE `projects` DROP COLUMN `security_review`');
  // The passes recorded as stages go with it: without the policy and the mark there is
  // nothing left that reads them, and the outcome requires every stage row it finds.
  if (await hasColumn(p, 'code_review_stages', 'stage')) {
    await p.query("DELETE FROM `code_review_stages` WHERE `stage` = 'security'");
    // Back to the column it was, unless a row that stays would no longer fit.
    const [rows] = await p.query('SELECT MAX(LENGTH(`detail`)) AS longest FROM `code_review_stages`');
    const longest = Number(/** @type {any[]} */ (rows)[0]?.longest || 0);
    if ((await columnType(p, 'code_review_stages', 'detail')) === 'mediumtext' && longest <= 65535)
      await p.query('ALTER TABLE `code_review_stages` MODIFY `detail` TEXT NULL');
  }
  await p.query('DROP TABLE IF EXISTS code_review_security');
}
