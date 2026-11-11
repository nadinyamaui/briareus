// @ts-check
// How many automated review rounds a pull request has used, and what each round
// reviewed. Counted per PR rather than per review: a review row is one session's, a
// rerun rewrites it and a session can be deleted, while the bound has to hold across
// every commit the PR ever gets. Like code_review_decisions, nothing here references a
// session or a review row, so the count survives both.
//
// Counting starts when this migration runs: reviews stored before it are history
// (code_reviews) and are not turned into rounds, since they did not record the base
// they reviewed against.
//
// Guarded on what already exists: ADD COLUMN is not idempotent.
const REVIEW_COLUMNS = [
  // Which of the PR's rounds this review ran as, what it covered and why.
  ['round', 'INT UNSIGNED NULL'],
  ['scope', "ENUM('full', 'incremental') NULL"],
  ['scope_reason', 'VARCHAR(32) NULL'],
  // The previously reviewed head an incremental round starts from.
  ['scope_base_sha', 'VARCHAR(64) NULL'],
];

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
  // One row per pull request: the count itself, and the lock every claim of a round
  // takes, so two starters can never both take the last round.
  await p.query(`CREATE TABLE IF NOT EXISTS code_review_round_counts (
    repo VARCHAR(255) NOT NULL,
    pr_number INT UNSIGNED NOT NULL,
    -- Rounds used so far. Only ever grows: a new push does not reset it.
    rounds INT UNSIGNED NOT NULL DEFAULT 0,
    -- How many of them a person granted past the limit.
    continuations INT UNSIGNED NOT NULL DEFAULT 0,
    -- The first review request refused at the limit since the last round started, and
    -- the latest head one was refused for: what waits on a person. Cleared when a new
    -- round starts.
    refused_at BIGINT UNSIGNED NULL,
    refused_head_sha VARCHAR(64) NULL,
    refused_source VARCHAR(16) NULL,
    created_at BIGINT UNSIGNED NOT NULL,
    updated_at BIGINT UNSIGNED NOT NULL,
    PRIMARY KEY (repo, pr_number)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  await p.query(`CREATE TABLE IF NOT EXISTS code_review_rounds (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    repo VARCHAR(255) NOT NULL,
    pr_number INT UNSIGNED NOT NULL,
    -- 1 for the PR's first counted review.
    round INT UNSIGNED NOT NULL,
    -- The revision the round reviews: the PR head and the branch it targets. One
    -- revision is one round however often its review is retried. Branch names
    -- are case-sensitive, hence the binary collation.
    head_sha VARCHAR(64) NOT NULL,
    base_ref VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    -- The base branch's tip and the merge base when discovery ran, which the next
    -- round compares with to tell whether the branch took in its base since.
    base_sha VARCHAR(64) NULL,
    merge_base_sha VARCHAR(64) NULL,
    -- The latest attempt's state.
    status ENUM('running', 'completed', 'failed') NOT NULL DEFAULT 'running',
    -- The session running (or that last ran) the round. No foreign key: it may be gone.
    job_id VARCHAR(64) NULL,
    -- Discovery runs started on this round: retries and recoveries add to it, not to
    -- the PR's count.
    attempts INT UNSIGNED NOT NULL DEFAULT 1,
    -- Who asked: the PR babysitter, an orchestrator session, or a person through the API.
    source ENUM('babysitter', 'orchestrator', 'user') NOT NULL,
    -- user:<id> or session:<id>, by source; NULL for the babysitter.
    requested_by VARCHAR(255) NULL,
    -- Set on a round a person explicitly granted past the limit: who, and when.
    continued_by VARCHAR(255) NULL,
    continued_at BIGINT UNSIGNED NULL,
    scope ENUM('full', 'incremental') NULL,
    scope_reason VARCHAR(32) NULL,
    scope_base_sha VARCHAR(64) NULL,
    -- When a publish step first started on it: from then on its findings may be on
    -- GitHub, so the round can no longer be handed to another revision.
    published_at BIGINT UNSIGNED NULL,
    -- When a review of it last ran to its end.
    reviewed_at BIGINT UNSIGNED NULL,
    created_at BIGINT UNSIGNED NOT NULL,
    updated_at BIGINT UNSIGNED NOT NULL,
    UNIQUE KEY code_review_rounds_number (repo, pr_number, round),
    UNIQUE KEY code_review_rounds_revision (repo, pr_number, head_sha, base_ref),
    KEY code_review_rounds_job (job_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  let after = 'head_sha';
  for (const [column, definition] of REVIEW_COLUMNS) {
    if (!(await hasColumn(p, 'code_reviews', column)))
      await p.query(`ALTER TABLE \`code_reviews\` ADD COLUMN \`${column}\` ${definition} AFTER \`${after}\``);
    after = column;
  }
  // How many review rounds a pull request of the project gets before a person has to
  // continue it; 0 switches the limit off (rounds are still counted).
  if (!(await hasColumn(p, 'projects', 'review_round_limit')))
    await p.query(
      'ALTER TABLE `projects` ADD COLUMN `review_round_limit` TINYINT UNSIGNED NOT NULL DEFAULT 3 AFTER `babysit_prs`',
    );
}

/** @param {{ context: import('mysql2/promise').Pool }} ctx */
export async function down({ context: p }) {
  if (await hasColumn(p, 'projects', 'review_round_limit'))
    await p.query('ALTER TABLE `projects` DROP COLUMN `review_round_limit`');
  for (const [column] of [...REVIEW_COLUMNS].reverse()) {
    if (await hasColumn(p, 'code_reviews', column))
      await p.query(`ALTER TABLE \`code_reviews\` DROP COLUMN \`${column}\``);
  }
  await p.query('DROP TABLE IF EXISTS code_review_rounds');
  await p.query('DROP TABLE IF EXISTS code_review_round_counts');
}
