// @ts-check
// Which runner executed a GitHub Actions job. A separate table because the job
// webhook can arrive before its check run is collected, and the check ledger's
// ordering rules must not decide what is kept here. An Actions job ID equals its
// check-run ID, which joins this to ci_checks.external_key.
export async function up({ context: p }) {
  await p.query(`CREATE TABLE IF NOT EXISTS ci_runners (
    repo VARCHAR(255) NOT NULL,
    job_id VARCHAR(64) NOT NULL,
    run_id BIGINT UNSIGNED NULL,
    runner_name VARCHAR(255) NULL,
    runner_group VARCHAR(255) NULL,
    runner_labels TEXT NULL,
    recorded_at BIGINT UNSIGNED NOT NULL,
    PRIMARY KEY (repo, job_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`);
}

export async function down({ context: p }) {
  await p.query('DROP TABLE IF EXISTS ci_runners');
}
