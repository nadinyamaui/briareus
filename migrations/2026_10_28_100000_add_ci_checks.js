// @ts-check
// Independent of PR snapshots: old heads and checks on deployment branches survive.
export async function up({ context: p }) {
  await p.query(`CREATE TABLE IF NOT EXISTS ci_checks (
    repo VARCHAR(255) NOT NULL,
    kind VARCHAR(16) NOT NULL,
    external_key VARCHAR(64) NOT NULL,
    github_id BIGINT UNSIGNED NOT NULL,
    name TEXT NOT NULL,
    app TEXT NULL,
    head_sha VARCHAR(64) NOT NULL,
    branch TEXT NULL,
    status VARCHAR(32) NOT NULL,
    conclusion VARCHAR(32) NULL,
    url TEXT NULL,
    started_at BIGINT UNSIGNED NULL,
    completed_at BIGINT UNSIGNED NULL,
    duration_ms BIGINT UNSIGNED NULL,
    run_at BIGINT UNSIGNED NOT NULL,
    observed_at BIGINT UNSIGNED NOT NULL,
    PRIMARY KEY (repo, kind, external_key),
    KEY ci_window (kind, run_at),
    KEY ci_repo_window (repo, kind, run_at),
    KEY ci_pending (repo, status, observed_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`);
}

export async function down({ context: p }) {
  await p.query('DROP TABLE IF EXISTS ci_checks');
}
