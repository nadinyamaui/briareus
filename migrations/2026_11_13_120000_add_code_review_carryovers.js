// @ts-check
// code_review_carryovers records that a pull request which moved on from its reviewed
// revision still makes the same change (lib/review-carryover.js): GitHub rebased it onto
// a merged stack, or somebody rebased it, and the review carries over to the new head.
//
// One row per review and revision it carries over to. The outcome reads the rows of the
// review that governs, so a later review starts with none, and a carry-over is never
// taken for anything but the exact head and base branch it was established for.
// `digest` is the change both revisions were found to make.

/** @param {{ context: import('mysql2/promise').Pool }} ctx */
export async function up({ context: p }) {
  await p.query(`CREATE TABLE IF NOT EXISTS code_review_carryovers (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT,
    repo VARCHAR(255) NOT NULL,
    pr_number INT UNSIGNED NOT NULL,
    -- The review that carries over. No foreign key: it may be gone, as on the outcome.
    code_review_id INT UNSIGNED NOT NULL,
    -- What it reviewed, and what it now stands for.
    reviewed_sha VARCHAR(64) NOT NULL,
    reviewed_base_ref VARCHAR(255) NULL,
    head_sha VARCHAR(64) NOT NULL,
    base_ref VARCHAR(255) NOT NULL,
    digest CHAR(64) NOT NULL,
    created_at BIGINT UNSIGNED NOT NULL,
    PRIMARY KEY (id),
    UNIQUE KEY code_review_carryovers_revision (code_review_id, head_sha, base_ref),
    KEY code_review_carryovers_pr (repo, pr_number)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
}

/** @param {{ context: import('mysql2/promise').Pool }} ctx */
export async function down({ context: p }) {
  await p.query('DROP TABLE IF EXISTS code_review_carryovers');
}
