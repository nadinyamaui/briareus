// @ts-check
// One row per code review a session runs, and the findings its agent registers.
// A review session deletes itself when done (autoClose), so job_id carries no
// foreign key: the review and its findings must outlive the session.
/** @param {{ context: import('mysql2/promise').Pool }} ctx */
export async function up({ context: p }) {
  await p.query(`CREATE TABLE IF NOT EXISTS code_reviews (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    job_id VARCHAR(64) NOT NULL,
    project_id INT UNSIGNED NULL,
    repo VARCHAR(255) NOT NULL,
    pr_number INT UNSIGNED NULL,
    branch VARCHAR(255) NOT NULL,
    -- The commit actually reviewed, known once the checkout is verified.
    head_sha VARCHAR(64) NULL,
    user_id INT UNSIGNED NULL,
    provider_id INT UNSIGNED NULL,
    model VARCHAR(128) NOT NULL DEFAULT '',
    effort VARCHAR(32) NOT NULL DEFAULT '',
    created_at BIGINT UNSIGNED NOT NULL,
    updated_at BIGINT UNSIGNED NOT NULL,
    UNIQUE KEY code_reviews_job (job_id),
    KEY code_reviews_pr (repo, pr_number, created_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  await p.query(`CREATE TABLE IF NOT EXISTS code_review_findings (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    code_review_id INT UNSIGNED NOT NULL,
    -- critical | high | medium | low
    severity VARCHAR(16) NOT NULL,
    -- What kind of defect: correctness, security, efficiency, …
    type VARCHAR(40) NOT NULL DEFAULT '',
    -- The verdict on whether the PR must change before it merges.
    should_fix ENUM('fix', 'optional', 'dismiss') NOT NULL,
    title TEXT NOT NULL,
    body LONGTEXT NULL,
    file_path TEXT NULL,
    start_line INT UNSIGNED NULL,
    end_line INT UNSIGNED NULL,
    -- Why the verdict is what it is, e.g. the reason a finding is not worth fixing.
    comments TEXT NULL,
    created_at BIGINT UNSIGNED NOT NULL,
    updated_at BIGINT UNSIGNED NOT NULL,
    KEY code_review_findings_review (code_review_id),
    FOREIGN KEY (code_review_id) REFERENCES code_reviews(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
}
/** @param {{ context: import('mysql2/promise').Pool }} ctx */
export async function down({ context: p }) {
  await p.query('DROP TABLE IF EXISTS code_review_findings');
  await p.query('DROP TABLE IF EXISTS code_reviews');
}
