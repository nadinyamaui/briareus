// @ts-check
// Risk-based human approvals of a reviewed pull request.
//
// projects.approval_policy is the project's policy as JSON (lib/review-risk.js): its
// sensitive-path rules and size thresholds, how many approvals each risk tier asks for,
// which tiers require the security pass, and whose approvals count. NULL, the default
// and what every existing project keeps, is no policy: nothing is assessed, nothing is
// required, and none of the tables below gets a row.
//
// code_review_risk holds what the server read from GitHub about the revision a pull
// request is at, per pull request like the outcome: the assessment of its changed files
// under the policy it was made with (so one made under other rules is recognised), who
// wrote the change (the pull request's author and its commits' accounts), and how
// current the approvals read from GitHub are. A read that failed is kept with when to
// try again; an assessment that could not be made stands as the highest tier.
//
// code_review_approvals is every approval the server knows of, kept as history. One
// recorded through the client API names the user and is bound to the head and the base
// branch it approves; one read from GitHub names the review and the account, with why
// the server takes it for automation's when it does. `active` is 1 while an approval
// recorded here stands and NULL once it is withdrawn, so the unique key holds a person
// to one standing approval per revision while leaving withdrawn ones on record.
//
// code_review_readiness is the approval requirement as last computed, written in the
// outcome's transaction, with the commit status it maps to and what GitHub was last
// told: the same record of a publication code_review_outcomes keeps, under the same
// column names, because the same publisher works both (lib/review-enforcement.js).
//
// code_review_commit_owners says which user's session made which commit, written when
// a session's turn ends with commits it did not have before. It outlives the session:
// it is what ties a person to a change their sessions wrote under the server's account,
// whatever those sessions were started for.
//
// user_github_links keeps every GitHub account a user has linked, by GitHub's user id
// and the login it had, after they unlink it: a commit made as that account stays that
// person's, and an approval on GitHub from it stays one a session may have made. An
// account linked when the server starts is entered then, so the history begins with
// what is linked at this migration.
//
// Nothing else is back-filled: approvals given on GitHub before this migration are read
// in when a project that accepts them is next computed, and commits sessions made before
// a project had an approval policy have no owner on record.
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
  if (!(await hasColumn(p, 'projects', 'approval_policy')))
    await p.query(
      'ALTER TABLE `projects` ADD COLUMN `approval_policy` MEDIUMTEXT NULL AFTER `security_review`',
    );
  await p.query(`CREATE TABLE IF NOT EXISTS code_review_risk (
    repo VARCHAR(255) NOT NULL,
    pr_number INT UNSIGNED NOT NULL,
    -- The revision that was read. Anything stored here says nothing about another one.
    head_sha VARCHAR(64) NOT NULL,
    base_ref VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL,
    -- The fingerprint of the policy the assessment was made under.
    policy_hash VARCHAR(64) NOT NULL,
    tier VARCHAR(16) NOT NULL,
    -- 0 when the file list could not be read completely: the tier is then the highest.
    complete TINYINT(1) NOT NULL DEFAULT 0,
    -- JSON: the assessment (tier, reasons, counts), and who wrote the change.
    assessment MEDIUMTEXT NULL,
    authors MEDIUMTEXT NULL,
    -- When the pull request's reviews were last read from GitHub for this revision, for
    -- a project that accepts approvals given there.
    reviews_synced_at BIGINT UNSIGNED NULL,
    -- The last read that failed, until one succeeds: why, how many in a row, and when
    -- the next one is due (NULL once it is no longer tried by itself).
    error TEXT NULL,
    attempts INT UNSIGNED NOT NULL DEFAULT 0,
    retry_at BIGINT UNSIGNED NULL,
    -- When the files and the commits were last asked for.
    observed_at BIGINT UNSIGNED NOT NULL,
    created_at BIGINT UNSIGNED NOT NULL,
    updated_at BIGINT UNSIGNED NOT NULL,
    PRIMARY KEY (repo, pr_number),
    KEY code_review_risk_retry (retry_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  await p.query(`CREATE TABLE IF NOT EXISTS code_review_approvals (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    repo VARCHAR(255) NOT NULL,
    pr_number INT UNSIGNED NOT NULL,
    source ENUM('briareus', 'github') NOT NULL,
    -- Who: the Briareus user of an approval recorded here, with their name as it was;
    -- the GitHub account and review of one read from GitHub. No foreign key: the record
    -- outlives the user.
    user_id INT UNSIGNED NULL,
    approver VARCHAR(255) NULL,
    -- The GitHub account: of a review read from GitHub, or the one the approver had
    -- linked when they approved here. The id is GitHub's, which a rename keeps.
    github_login VARCHAR(100) NULL,
    github_user_id BIGINT UNSIGNED NULL,
    github_review_id BIGINT UNSIGNED NULL,
    status ENUM('approved', 'withdrawn', 'dismissed', 'superseded') NOT NULL DEFAULT 'approved',
    active TINYINT(1) NULL DEFAULT 1,
    -- The revision it approves: valid for exactly this head against this base branch.
    head_sha VARCHAR(64) NOT NULL,
    base_ref VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL,
    -- The review that covered that revision then and what it amounted to: context.
    code_review_id INT UNSIGNED NULL,
    review_outcome VARCHAR(32) NULL,
    note TEXT NULL,
    -- author | commits | session when the approver wrote (part of) the change.
    authorship VARCHAR(32) NULL,
    -- Why an approval read from GitHub is automation's, once the server saw that it is.
    automation VARCHAR(32) NULL,
    association VARCHAR(32) NULL,
    approved_at BIGINT UNSIGNED NULL,
    -- When the list this row's standing on GitHub was last taken from was asked for: an
    -- older read finishing later does not overwrite a newer one.
    seen_at BIGINT UNSIGNED NULL,
    withdrawn_at BIGINT UNSIGNED NULL,
    withdraw_note TEXT NULL,
    created_at BIGINT UNSIGNED NOT NULL,
    updated_at BIGINT UNSIGNED NOT NULL,
    UNIQUE KEY code_review_approvals_review (repo, pr_number, github_review_id),
    UNIQUE KEY code_review_approvals_standing (repo, pr_number, user_id, head_sha, base_ref, active),
    KEY code_review_approvals_pull (repo, pr_number, id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  await p.query(`CREATE TABLE IF NOT EXISTS code_review_readiness (
    repo VARCHAR(255) NOT NULL,
    pr_number INT UNSIGNED NOT NULL,
    head_sha VARCHAR(64) NULL,
    base_ref VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL,
    result ENUM('not_required', 'pending', 'satisfied') NOT NULL DEFAULT 'not_required',
    tier VARCHAR(16) NULL,
    required INT UNSIGNED NOT NULL DEFAULT 0,
    valid INT UNSIGNED NOT NULL DEFAULT 0,
    -- JSON: the machine-readable reasons for the result.
    reasons MEDIUMTEXT NULL,
    -- Since when the pull request has waited on people alone: its review passed, covers
    -- this revision, and approvals are missing. NULL whenever that is not so.
    waiting_since BIGINT UNSIGNED NULL,
    computed_at BIGINT UNSIGNED NULL,
    -- The commit status and its publication, as on code_review_outcomes.
    status_state ENUM('pending', 'success', 'failure', 'error') NULL,
    status_description VARCHAR(140) NULL,
    published_sha VARCHAR(64) NULL,
    published_state ENUM('pending', 'success', 'failure', 'error') NULL,
    published_description VARCHAR(140) NULL,
    published_confirmed TINYINT(1) NOT NULL DEFAULT 0,
    published_at BIGINT UNSIGNED NULL,
    publish_error TEXT NULL,
    publish_error_status SMALLINT UNSIGNED NULL,
    publish_attempts INT UNSIGNED NOT NULL DEFAULT 0,
    publish_failed_at BIGINT UNSIGNED NULL,
    publish_retry_at BIGINT UNSIGNED NULL,
    publish_owed_at BIGINT UNSIGNED NULL,
    created_at BIGINT UNSIGNED NOT NULL,
    updated_at BIGINT UNSIGNED NOT NULL,
    PRIMARY KEY (repo, pr_number),
    KEY code_review_readiness_failed (publish_failed_at),
    KEY code_review_readiness_owed (publish_owed_at, publish_retry_at),
    KEY code_review_readiness_waiting (waiting_since)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  await p.query(`CREATE TABLE IF NOT EXISTS code_review_commit_owners (
    repo VARCHAR(255) NOT NULL,
    commit_sha VARCHAR(64) NOT NULL,
    user_id INT UNSIGNED NOT NULL,
    -- The session that made it and the branch it was on, for whoever asks why.
    job_id VARCHAR(64) NULL,
    branch VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL,
    created_at BIGINT UNSIGNED NOT NULL,
    PRIMARY KEY (repo, commit_sha, user_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  await p.query(`CREATE TABLE IF NOT EXISTS user_github_links (
    user_id INT UNSIGNED NOT NULL,
    -- GitHub's user id; 0 for a link stored before the id was kept.
    github_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
    login VARCHAR(100) NOT NULL,
    first_linked_at BIGINT UNSIGNED NOT NULL,
    last_linked_at BIGINT UNSIGNED NOT NULL,
    PRIMARY KEY (user_id, github_id, login)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
}

/** @param {{ context: import('mysql2/promise').Pool }} ctx */
export async function down({ context: p }) {
  await p.query('DROP TABLE IF EXISTS user_github_links');
  await p.query('DROP TABLE IF EXISTS code_review_commit_owners');
  await p.query('DROP TABLE IF EXISTS code_review_readiness');
  await p.query('DROP TABLE IF EXISTS code_review_approvals');
  await p.query('DROP TABLE IF EXISTS code_review_risk');
  if (await hasColumn(p, 'projects', 'approval_policy'))
    await p.query('ALTER TABLE `projects` DROP COLUMN `approval_policy`');
}
