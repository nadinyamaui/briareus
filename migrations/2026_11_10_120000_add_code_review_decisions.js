// @ts-check
// What earlier reviews of a pull request decided, kept per PR rather than per review:
// a rerun in the same session deletes that review's findings, and a later review must
// still know which claims were dismissed or fixed. Like code_reviews, nothing here
// references a session, so the decisions survive its deletion.
const FINDING_COLUMNS = [
  // The claim's reference, the same across every review of the PR that raises it.
  ['finding_ref', 'VARCHAR(64) NULL'],
  // How the publish step reconciled the finding with the PR's earlier threads.
  ['reconciliation', "ENUM('new', 'adopted', 'suppressed', 'revisit') NOT NULL DEFAULT 'new'"],
  // The inline comment and review thread the finding is published as on GitHub.
  ['comment_id', 'BIGINT UNSIGNED NULL'],
  ['thread_id', 'VARCHAR(128) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL'],
  // The PR head the finding was raised on.
  ['head_sha', 'VARCHAR(64) NULL'],
  // The earlier thread an adopted, suppressed or revisited finding answers to, and
  // what that thread had decided when this review read it.
  ['prior_thread_id', 'VARCHAR(128) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL'],
  ['prior_disposition', 'VARCHAR(16) NULL'],
  ['prior_reason', 'TEXT NULL'],
  ['prior_url', 'TEXT NULL'],
  // Why a revisited finding's earlier decision no longer holds.
  ['revisit_reason', 'TEXT NULL'],
];

/** @param {import('mysql2/promise').Pool} p @param {string} column */
async function hasColumn(p, column) {
  const [rows] = await p.query(
    'SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?',
    ['code_review_findings', column],
  );
  return /** @type {any[]} */ (rows).length > 0;
}

/** @param {{ context: import('mysql2/promise').Pool }} ctx */
export async function up({ context: p }) {
  await p.query(`CREATE TABLE IF NOT EXISTS code_review_decisions (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    repo VARCHAR(255) NOT NULL,
    pr_number INT UNSIGNED NOT NULL,
    -- What the row is keyed by within its PR: the GitHub review thread's node id, or
    -- ref:<finding_ref> for a finding that had no inline thread. Node ids are
    -- case-sensitive, hence the binary collation.
    anchor VARCHAR(190) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    thread_id VARCHAR(128) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL,
    -- The thread's first comment, the one REST replies are addressed to.
    comment_id BIGINT UNSIGNED NULL,
    finding_ref VARCHAR(64) NOT NULL,
    title TEXT NULL,
    file_path TEXT NULL,
    line INT UNSIGNED NULL,
    -- NULL while the claim is published and nobody has ruled on it, or after a
    -- verdict was cleared.
    verdict ENUM('fix', 'optional', 'dismiss') NULL,
    rationale TEXT NULL,
    -- What recorded the verdict: a verdict reply read from GitHub, a review session's
    -- verification step, or a client through the API.
    source ENUM('github', 'review', 'api') NULL,
    -- A GitHub login, session:<id> or user:<id>, by source.
    decided_by VARCHAR(255) NULL,
    -- The PR head the verdict was given on, and the commit the claim was raised on.
    head_sha VARCHAR(64) NULL,
    raised_sha VARCHAR(64) NULL,
    -- Whether the thread was resolved the last time a review read it.
    resolved TINYINT(1) NOT NULL DEFAULT 0,
    decided_at BIGINT UNSIGNED NULL,
    created_at BIGINT UNSIGNED NOT NULL,
    updated_at BIGINT UNSIGNED NOT NULL,
    UNIQUE KEY code_review_decisions_anchor (repo, pr_number, anchor),
    KEY code_review_decisions_ref (repo, pr_number, finding_ref)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  let after = 'comments';
  for (const [column, definition] of FINDING_COLUMNS) {
    if (!(await hasColumn(p, column)))
      await p.query(
        `ALTER TABLE \`code_review_findings\` ADD COLUMN \`${column}\` ${definition} AFTER \`${after}\``,
      );
    after = column;
  }
  // A finding from before references existed is a claim of its own: nothing says which
  // earlier finding it repeated, so its reference is its id.
  await p.query(
    "UPDATE `code_review_findings` SET `finding_ref` = CONCAT('f', `id`) WHERE `finding_ref` IS NULL",
  );
}

/** @param {{ context: import('mysql2/promise').Pool }} ctx */
export async function down({ context: p }) {
  for (const [column] of [...FINDING_COLUMNS].reverse()) {
    if (await hasColumn(p, column))
      await p.query(`ALTER TABLE \`code_review_findings\` DROP COLUMN \`${column}\``);
  }
  await p.query('DROP TABLE IF EXISTS code_review_decisions');
}
