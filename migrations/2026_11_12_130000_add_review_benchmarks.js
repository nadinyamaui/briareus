// The review benchmark (lib/review-benchmark.js): curated changes with answers people
// adjudicated, runs that put them through the real code review, and what people said
// about the findings those reviews made.
//
// projects.review_benchmark sets a project aside for it. A run opens pull requests and
// branches in the project's repository and closes them again, so it is refused on any
// project that was not switched on for that explicitly. Off for every existing project.
//
// review_benchmark_cases holds a case: the change (two commits of the repository), what
// the reviewer is shown of it (title, description) and the answer (kind, defects,
// reference fix), which never leaves this table but to score. answer_hash fingerprints
// the change and the answer; an adjudication is of one fingerprint, so editing a case
// leaves its earlier adjudications about something else. A case is retired, never
// deleted: runs were scored against it.
//
// review_benchmark_runs is one evaluation: who started it, the runtime and review
// configuration it ran under, and how many reviews it runs at once.
// review_benchmark_results is one case in it: the answer as it was when the run started
// (answer), the pull request and session it went through, and what the review left when
// it ended (review), kept here because review sessions delete themselves and a rerun of
// one deletes its findings. review_benchmark_judgments is what people said about one of
// those findings, by the finding's id in that snapshot.
//
// Nothing is back-filled.

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
  if (!(await hasColumn(p, 'projects', 'review_benchmark'))) {
    const after = (await hasColumn(p, 'projects', 'approval_policy')) ? ' AFTER `approval_policy`' : '';
    await p.query(
      `ALTER TABLE \`projects\` ADD COLUMN \`review_benchmark\` TINYINT(1) NOT NULL DEFAULT 0${after}`,
    );
  }
  await p.query(`CREATE TABLE IF NOT EXISTS review_benchmark_cases (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    repo VARCHAR(255) NOT NULL,
    -- The case's name in its project. Case-sensitive, hence the binary collation.
    case_key VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    -- What the reviewer is shown: the pull request's title and description.
    title VARCHAR(255) NOT NULL,
    description MEDIUMTEXT NULL,
    base_sha VARCHAR(64) NOT NULL,
    head_sha VARCHAR(64) NOT NULL,
    -- The answer.
    kind ENUM('defective', 'clean') NOT NULL,
    defects MEDIUMTEXT NOT NULL,
    reference_fix MEDIUMTEXT NULL,
    origin ENUM('constructed', 'historical') NOT NULL,
    provenance TEXT NULL,
    answer_hash VARCHAR(64) NOT NULL,
    authored_by INT UNSIGNED NULL,
    retired_at BIGINT UNSIGNED NULL,
    created_at BIGINT UNSIGNED NOT NULL,
    updated_at BIGINT UNSIGNED NOT NULL,
    UNIQUE KEY review_benchmark_cases_key (repo, case_key)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  await p.query(`CREATE TABLE IF NOT EXISTS review_benchmark_adjudications (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    case_id INT UNSIGNED NOT NULL,
    user_id INT UNSIGNED NOT NULL,
    -- The case's answer_hash when they ruled: what they agreed or disagreed with.
    answer_hash VARCHAR(64) NOT NULL,
    verdict ENUM('agree', 'disagree') NOT NULL,
    note TEXT NULL,
    created_at BIGINT UNSIGNED NOT NULL,
    updated_at BIGINT UNSIGNED NOT NULL,
    UNIQUE KEY review_benchmark_adjudications_one (case_id, user_id, answer_hash),
    FOREIGN KEY (case_id) REFERENCES review_benchmark_cases(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  await p.query(`CREATE TABLE IF NOT EXISTS review_benchmark_runs (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    repo VARCHAR(255) NOT NULL,
    label VARCHAR(255) NULL,
    note TEXT NULL,
    status ENUM('running', 'completed', 'cancelled') NOT NULL DEFAULT 'running',
    requested_by INT UNSIGNED NULL,
    concurrency TINYINT UNSIGNED NOT NULL DEFAULT 1,
    -- JSON: the project's review runtime when the run started, and the review settings
    -- and core revision it ran under, so that two runs can be told apart.
    runtime TEXT NULL,
    configuration TEXT NULL,
    ended_at BIGINT UNSIGNED NULL,
    created_at BIGINT UNSIGNED NOT NULL,
    updated_at BIGINT UNSIGNED NOT NULL,
    KEY review_benchmark_runs_repo (repo, created_at),
    KEY review_benchmark_runs_status (status)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  await p.query(`CREATE TABLE IF NOT EXISTS review_benchmark_results (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    run_id INT UNSIGNED NOT NULL,
    -- No foreign key: the case is retired, not deleted, and the answer it was scored
    -- against is kept here anyway.
    case_id INT UNSIGNED NOT NULL,
    case_key VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    answer MEDIUMTEXT NOT NULL,
    state ENUM('queued', 'opening', 'reviewing', 'done', 'failed', 'cancelled') NOT NULL DEFAULT 'queued',
    -- The branches and pull request the case went through, named before they are made
    -- so a run picked up after a restart finds what it already made.
    head_branch VARCHAR(255) NULL,
    base_branch VARCHAR(255) NULL,
    pr_number INT UNSIGNED NULL,
    job_id VARCHAR(64) NULL,
    code_review_id INT UNSIGNED NULL,
    -- JSON: the review as it ended (status, outcome, findings, cost).
    review MEDIUMTEXT NULL,
    error TEXT NULL,
    started_at BIGINT UNSIGNED NULL,
    ended_at BIGINT UNSIGNED NULL,
    -- When the pull request was closed and its branches deleted; the last failure to.
    cleaned_at BIGINT UNSIGNED NULL,
    cleanup_error TEXT NULL,
    created_at BIGINT UNSIGNED NOT NULL,
    updated_at BIGINT UNSIGNED NOT NULL,
    UNIQUE KEY review_benchmark_results_case (run_id, case_id),
    FOREIGN KEY (run_id) REFERENCES review_benchmark_runs(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  await p.query(`CREATE TABLE IF NOT EXISTS review_benchmark_judgments (
    result_id INT UNSIGNED NOT NULL,
    finding_id INT UNSIGNED NOT NULL,
    assessment ENUM('matches', 'false_positive', 'valid_unlisted') NOT NULL,
    defect_id VARCHAR(40) NULL,
    -- Whether the fix the finding suggests would do harm: break behaviour, weaken a
    -- check, or hide the defect rather than mend it.
    harmful_fix TINYINT(1) NOT NULL DEFAULT 0,
    note TEXT NULL,
    user_id INT UNSIGNED NULL,
    created_at BIGINT UNSIGNED NOT NULL,
    updated_at BIGINT UNSIGNED NOT NULL,
    PRIMARY KEY (result_id, finding_id),
    FOREIGN KEY (result_id) REFERENCES review_benchmark_results(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
}

/** @param {{ context: import('mysql2/promise').Pool }} ctx */
export async function down({ context: p }) {
  await p.query('DROP TABLE IF EXISTS review_benchmark_judgments');
  await p.query('DROP TABLE IF EXISTS review_benchmark_results');
  await p.query('DROP TABLE IF EXISTS review_benchmark_runs');
  await p.query('DROP TABLE IF EXISTS review_benchmark_adjudications');
  await p.query('DROP TABLE IF EXISTS review_benchmark_cases');
  if (await hasColumn(p, 'projects', 'review_benchmark'))
    await p.query('ALTER TABLE `projects` DROP COLUMN `review_benchmark`');
}
