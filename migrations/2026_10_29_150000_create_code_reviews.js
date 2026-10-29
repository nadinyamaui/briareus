// @ts-check
// Review runs own their findings; neither record depends on a session surviving.
export async function up({ context: p }) {
  await p.query(`CREATE TABLE IF NOT EXISTS code_reviews (
    id CHAR(32) NOT NULL PRIMARY KEY,
    repo VARCHAR(255) NOT NULL,
    pr_number INT UNSIGNED NOT NULL,
    branch VARCHAR(255) NOT NULL,
    base_sha VARCHAR(64) NOT NULL,
    head_sha VARCHAR(64) NOT NULL,
    owner_id INT UNSIGNED NULL,
    provider_id INT UNSIGNED NOT NULL,
    model VARCHAR(255) NOT NULL,
    effort VARCHAR(32) NOT NULL,
    session_id VARCHAR(64) NULL,
    status VARCHAR(32) NOT NULL DEFAULT 'queued',
    summary TEXT NULL,
    raw_output MEDIUMTEXT NULL,
    error TEXT NULL,
    summary_comment_id BIGINT UNSIGNED NULL,
    summary_comment_url TEXT NULL,
    created_at BIGINT UNSIGNED NOT NULL,
    updated_at BIGINT UNSIGNED NOT NULL,
    KEY code_reviews_pr (repo, pr_number, created_at),
    KEY code_reviews_active (status, created_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`);
  await p.query(`CREATE TABLE IF NOT EXISTS code_review_findings (
    id CHAR(32) NOT NULL PRIMARY KEY,
    review_id CHAR(32) NOT NULL,
    position INT UNSIGNED NOT NULL,
    title TEXT NOT NULL,
    severity VARCHAR(16) NOT NULL,
    details TEXT NOT NULL,
    proof TEXT NOT NULL,
    comments TEXT NOT NULL,
    path TEXT NULL,
    start_line INT UNSIGNED NULL,
    end_line INT UNSIGNED NULL,
    side VARCHAR(8) NULL,
    reviewer_should_fix BOOLEAN NULL,
    should_fix BOOLEAN NULL,
    fix_reason TEXT NULL,
    verification_status VARCHAR(32) NOT NULL DEFAULT 'pending',
    verification_proof TEXT NULL,
    verification_sha VARCHAR(64) NULL,
    verification_session_id VARCHAR(64) NULL,
    verification_output MEDIUMTEXT NULL,
    verification_error TEXT NULL,
    inline_comment_id BIGINT UNSIGNED NULL,
    inline_comment_url TEXT NULL,
    UNIQUE KEY code_review_finding_position (review_id, position),
    CONSTRAINT code_review_findings_review FOREIGN KEY (review_id)
      REFERENCES code_reviews(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`);
}

export async function down({ context: p }) {
  await p.query('DROP TABLE IF EXISTS code_review_findings');
  await p.query('DROP TABLE IF EXISTS code_reviews');
}
