// @ts-check
// What a code review amounts to, kept apart from whether its session ran to the end.
//
// code_review_stages holds what the server itself saw each step of a review do, per
// review and bound to the head it ran on: a review passes on these records and its
// findings, never on its agent's exit code or on a label. One row per required stage,
// written when discovery starts, so the rows also say which stages that review needs
// (Codex's delegation receipt today, further required passes later) without a schema
// change. They belong to the review row and go with it.
//
// code_review_outcomes holds the pull request's current outcome and what GitHub was
// last told about it. Per pull request rather than per review, like the decisions and
// the rounds: the commit status belongs to the PR's head, a head nobody has reviewed
// yet has an outcome (pending, or incomplete at the round limit) and no review row, and
// the record has to outlive the reviews and sessions it was computed from.
//
// Reviews stored before this migration have no stage rows. Nothing is back-filled: what
// their steps did was never recorded, so their outcome reads as incomplete, not passed.
//
// code_review_decisions (an earlier migration's table) gains the verification a verdict
// was recorded with. A decision outlives the finding that gave it, and the outcome asks
// of a decision what it asks of a finding: an Optional needs a recorded verification, a
// Dismissed a confirmed one. A decision already stored takes the verification of the
// finding that gave it where that finding still exists and still carries the same
// verdict, since that is the record of how the verdict was established. Every other row
// keeps none and so does not count as verified: a verdict read from GitHub's history
// among them, because what its reply proved was never recorded here, and assuming it was
// proven would let exactly the unproven dismissals through that this migration exists to
// stop. Such a claim is ruled on again, by a review or by a person through the API.
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

/** @param {{ context: import('mysql2/promise').Pool }} ctx */
export async function up({ context: p }) {
  await p.query(`CREATE TABLE IF NOT EXISTS code_review_stages (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    code_review_id INT UNSIGNED NOT NULL,
    -- discover | publish | delegation | verify | label today. Not an ENUM, so a later
    -- required pass is a new row, not a new schema.
    stage VARCHAR(32) NOT NULL,
    -- The head the stage ran on. A record for another head completes nothing.
    head_sha VARCHAR(64) NOT NULL,
    -- pending: required, not started. running: started, and interrupted if the review
    -- is no longer running. completed and failed are what the server observed.
    status ENUM('pending', 'running', 'completed', 'failed') NOT NULL DEFAULT 'pending',
    -- JSON: why it failed, or what the server found when it ended.
    detail TEXT NULL,
    started_at BIGINT UNSIGNED NULL,
    ended_at BIGINT UNSIGNED NULL,
    created_at BIGINT UNSIGNED NOT NULL,
    updated_at BIGINT UNSIGNED NOT NULL,
    UNIQUE KEY code_review_stages_stage (code_review_id, stage),
    FOREIGN KEY (code_review_id) REFERENCES code_reviews(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  await p.query(`CREATE TABLE IF NOT EXISTS code_review_outcomes (
    repo VARCHAR(255) NOT NULL,
    pr_number INT UNSIGNED NOT NULL,
    -- The review the outcome is computed from: the one that last started discovery on
    -- the pull request. No foreign key: it may be gone, and the latest one stands in.
    code_review_id INT UNSIGNED NULL,
    -- The revision the outcome is for: the pull request's head and base branch as the
    -- server last saw them. When that is not what the review reviewed, the outcome is
    -- stale and cannot be passed.
    head_sha VARCHAR(64) NULL,
    base_ref VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL,
    outcome ENUM('pending', 'incomplete', 'changes_required', 'passed') NOT NULL DEFAULT 'pending',
    stale TINYINT(1) NOT NULL DEFAULT 0,
    -- JSON: the machine-readable reasons for the outcome.
    reasons MEDIUMTEXT NULL,
    computed_at BIGINT UNSIGNED NULL,
    -- The commit status that outcome maps to, whether or not the project publishes it.
    status_state ENUM('pending', 'success', 'failure', 'error') NULL,
    status_description VARCHAR(140) NULL,
    -- What GitHub last accepted. The status is published when these equal the three
    -- above for head_sha; anything else is a status GitHub does not carry.
    published_sha VARCHAR(64) NULL,
    published_state ENUM('pending', 'success', 'failure', 'error') NULL,
    published_description VARCHAR(140) NULL,
    -- 0 from the moment a write is sent until GitHub's answer says it was taken: a
    -- write whose answer was lost may have landed, so what the commit carries is then
    -- unknown and the next publication always posts.
    published_confirmed TINYINT(1) NOT NULL DEFAULT 0,
    published_at BIGINT UNSIGNED NULL,
    -- The last attempt that failed, until one succeeds: why, GitHub's answer, how many
    -- in a row, and when the next one is due.
    publish_error TEXT NULL,
    publish_error_status SMALLINT UNSIGNED NULL,
    publish_attempts INT UNSIGNED NOT NULL DEFAULT 0,
    publish_failed_at BIGINT UNSIGNED NULL,
    publish_retry_at BIGINT UNSIGNED NULL,
    -- Since when GitHub is owed the status above: set with the outcome, in its
    -- transaction, for a project that publishes it, and cleared when GitHub carries it.
    -- An outcome stored and never posted is found by this, failure recorded or not.
    publish_owed_at BIGINT UNSIGNED NULL,
    -- Since when the outcome itself is owed a recomputation: evidence changed and the
    -- computation that should have followed did not land.
    recompute_at BIGINT UNSIGNED NULL,
    created_at BIGINT UNSIGNED NOT NULL,
    updated_at BIGINT UNSIGNED NOT NULL,
    PRIMARY KEY (repo, pr_number),
    KEY code_review_outcomes_failed (publish_failed_at),
    KEY code_review_outcomes_owed (publish_owed_at, publish_retry_at),
    KEY code_review_outcomes_recompute (recompute_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  // The base branch the review reviewed against, beside the head it already records:
  // the outcome is bound to both. Branch names are case-sensitive.
  if (!(await hasColumn(p, 'code_reviews', 'base_ref')))
    await p.query(
      'ALTER TABLE `code_reviews` ADD COLUMN `base_ref` VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL AFTER `branch`',
    );
  // Whether the project publishes the outcome as a commit status and holds the review's
  // labelling to it. Off for every existing project: turning it on is a decision.
  if (!(await hasColumn(p, 'projects', 'enforce_review_outcome')))
    await p.query(
      'ALTER TABLE `projects` ADD COLUMN `enforce_review_outcome` TINYINT(1) NOT NULL DEFAULT 0 AFTER `review_round_limit`',
    );
  if (!(await hasColumn(p, 'code_review_decisions', 'verification'))) {
    await p.query(
      "ALTER TABLE `code_review_decisions` ADD COLUMN `verification` ENUM('confirmed', 'plausible') NULL AFTER `rationale`",
    );
    await p.query(
      `UPDATE \`code_review_decisions\` d
         JOIN \`code_review_findings\` f ON f.\`id\` = d.\`finding_id\`
         JOIN \`code_reviews\` r ON r.\`id\` = f.\`code_review_id\` AND r.\`repo\` = d.\`repo\` AND r.\`pr_number\` = d.\`pr_number\`
          SET d.\`verification\` = f.\`verification\`
        WHERE d.\`source\` IN ('review', 'api') AND d.\`verdict\` IS NOT NULL AND d.\`verdict\` = f.\`should_fix\`
          AND f.\`finding_ref\` = d.\`finding_ref\``,
    );
  }
}

/** @param {{ context: import('mysql2/promise').Pool }} ctx */
export async function down({ context: p }) {
  if (await hasColumn(p, 'code_review_decisions', 'verification'))
    await p.query('ALTER TABLE `code_review_decisions` DROP COLUMN `verification`');
  if (await hasColumn(p, 'projects', 'enforce_review_outcome'))
    await p.query('ALTER TABLE `projects` DROP COLUMN `enforce_review_outcome`');
  if (await hasColumn(p, 'code_reviews', 'base_ref'))
    await p.query('ALTER TABLE `code_reviews` DROP COLUMN `base_ref`');
  await p.query('DROP TABLE IF EXISTS code_review_outcomes');
  await p.query('DROP TABLE IF EXISTS code_review_stages');
}
