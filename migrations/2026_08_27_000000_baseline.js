// @ts-check
// The schema as it stood when migrations became files. Everything in here is
// idempotent (CREATE TABLE IF NOT EXISTS, and ALTERs guarded by a column
// check) because a database that predates this file already has all of it
// and only needs the row in `migrations` that says so. Every later change is
// its own file in this directory (`npm run make:migration <name>`); this one
// is never edited again.

const SCHEMA = [
  // Every session that has run, kept past the restart that used to lose it.
  // `meta` is the whole job record; the columns beside it are the ones worth
  // sorting and filtering on without parsing it.
  `CREATE TABLE IF NOT EXISTS \`jobs\` (
    \`id\`             VARCHAR(64)     NOT NULL,
    \`kind\`           VARCHAR(16)     NOT NULL,
    \`status\`         VARCHAR(32)     NOT NULL,
    \`repo\`           VARCHAR(255)    NULL,
    \`title\`          TEXT            NULL,
    \`meta\`           LONGTEXT        NULL,
    \`created_at\`     BIGINT UNSIGNED NOT NULL,
    \`ended_at\`       BIGINT UNSIGNED NULL,
    -- Mirrors of fields inside meta, so SQL can find and aggregate sessions
    -- (the PR a session worked on, what it cost, what it consumed) without
    -- parsing the blob.
    \`pr_number\`      INT UNSIGNED    NULL,
    \`cost_usd\`       DECIMAL(12,4)   NULL,
    \`input_tokens\`   BIGINT UNSIGNED NULL,
    \`output_tokens\`  BIGINT UNSIGNED NULL,
    \`context_tokens\` BIGINT UNSIGNED NULL,
    PRIMARY KEY (\`id\`),
    KEY \`jobs_created_at\` (\`created_at\`),
    KEY \`jobs_repo_pr\` (\`repo\`, \`pr_number\`)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  // The projects a session can be started against, edited at /settings.
  `CREATE TABLE IF NOT EXISTS \`projects\` (
    \`id\`                 INT UNSIGNED    NOT NULL AUTO_INCREMENT,
    \`repo\`               VARCHAR(255)    NOT NULL,
    \`label\`              VARCHAR(255)    NOT NULL,
    \`enabled\`            TINYINT(1)      NOT NULL DEFAULT 1,
    \`sort_order\`         INT             NOT NULL DEFAULT 0,
    -- Dependency install / build steps, a JSON array of shell commands.
    \`setup_commands\`     LONGTEXT        NULL,
    \`php_bin_dir\`        VARCHAR(512)    NOT NULL DEFAULT '',
    -- The machine's own checkout of the repo, for sessions started in Local
    -- mode: they work directly in this directory instead of a workspace clone.
    \`local_dir\`          VARCHAR(512)    NOT NULL DEFAULT '',
    -- Whether a session claims a database server of its own from the pool,
    -- and which database it points at there.
    \`db_pool_enabled\`    TINYINT(1)      NOT NULL DEFAULT 0,
    \`db_pool_database\`   VARCHAR(64)     NOT NULL DEFAULT '',
    -- A dump on this machine, restored into the database on every claim.
    \`db_restore_sql\`     VARCHAR(512)    NOT NULL DEFAULT '',
    -- Postgres extensions created in the session's database, a JSON array of
    -- names (pgvector's \`vector\`, say); a fresh database carries none.
    \`db_extensions\`      LONGTEXT        NULL,
    -- Seeded into the checkout as .env before the setup steps run.
    \`env_template\`       LONGTEXT        NULL,
    -- ▶ Run: the shell commands that serve the checkout, a JSON array.
    \`run_commands\`       LONGTEXT        NULL,
    -- Extra steps appended to the publish prompt after a ⌕ Code review:
    -- label moves, issue updates, whatever the team's workflow asks for.
    \`review_publish_instructions\` TEXT   NULL,
    -- QA chain after a review: whether the session goes on to post a test
    -- sheet on the PR, and whether it then executes that sheet with Playwright
    -- and records a video per scenario. \`qa_notes\` rides along on both
    -- prompts: logins, tenants, URLs, whatever a tester needs to know.
    \`review_test_sheet\`   TINYINT(1)      NOT NULL DEFAULT 0,
    \`review_test_run\`     TINYINT(1)      NOT NULL DEFAULT 0,
    \`qa_notes\`            TEXT            NULL,
    -- Appended to the ⚙ Implement feedback prompt as its closing steps: what
    -- this project wants done once the review comments are implemented.
    \`feedback_instructions\` TEXT          NULL,
    -- Appended to the 📋 Test sheet prompt as its closing steps: what this
    -- project wants done once the sheet is on the pull request.
    \`test_sheet_instructions\` TEXT        NULL,
    -- What this project's errands are about: the GitHub user whose pull
    -- requests the board shows, and the provider/model/effort a review
    -- opens on unless the composer picks otherwise. The columns keep their
    -- original \`auto_review_\` names, since renaming them would be a migration that
    -- buys nothing.
    \`auto_review_author\`      VARCHAR(255) NOT NULL DEFAULT '',
    \`auto_review_provider_id\` INT UNSIGNED NULL,
    \`auto_review_model\`       VARCHAR(128) NOT NULL DEFAULT '',
    \`auto_review_effort\`      VARCHAR(32)  NOT NULL DEFAULT '',
    -- What each step after the review itself runs on, a JSON object keyed by
    -- step: {"publish":{"providerId":3,"model":"…","effort":"…"}, …}. A step
    -- that is missing (or carries no provider) runs on the session's own
    -- provider, which is what every project did before this existed.
    \`step_runtimes\`      LONGTEXT        NULL,
    -- This project's own wording for the prompts it sends, a JSON object keyed
    -- by template id: {"prBody":"…","testSheet":"…"}. Only the ones it
    -- overrides; anything missing falls back to the global setting and then to
    -- the built-in text (lib/templates.js).
    \`prompt_templates\`   LONGTEXT        NULL,
    \`created_at\`         BIGINT UNSIGNED NOT NULL,
    \`updated_at\`         BIGINT UNSIGNED NOT NULL,
    PRIMARY KEY (\`id\`),
    UNIQUE KEY \`projects_repo\` (\`repo\`)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  // The providers sessions can be started on, edited at /settings: each row
  // links a label to one of the three hardcoded binaries (claude / codex /
  // grok, opencode) plus whatever that entry needs: a custom endpoint with its key,
  // model and effort overrides. The entry's config dir is derived from its id.
  `CREATE TABLE IF NOT EXISTS \`providers\` (
    \`id\`             INT UNSIGNED    NOT NULL AUTO_INCREMENT,
    \`label\`          VARCHAR(255)    NOT NULL,
    \`binary\`         VARCHAR(16)     NOT NULL,
    -- A custom API endpoint (codex only) and the key that authenticates it.
    \`base_url\`       VARCHAR(512)    NOT NULL DEFAULT '',
    \`api_key\`        VARCHAR(512)    NOT NULL DEFAULT '',
    -- JSON arrays; empty = the binary's own defaults.
    \`models\`         LONGTEXT        NULL,
    \`efforts\`        LONGTEXT        NULL,
    \`default_model\`  VARCHAR(128)    NOT NULL DEFAULT '',
    \`default_effort\` VARCHAR(32)     NOT NULL DEFAULT '',
    -- The claude login registered for this entry, mirrored from its config
    -- dir (OAuth credentials + account identity) so the database carries it.
    \`auth_data\`      LONGTEXT        NULL,
    \`sort_order\`     INT             NOT NULL DEFAULT 0,
    \`created_at\`     BIGINT UNSIGNED NOT NULL,
    \`updated_at\`     BIGINT UNSIGNED NOT NULL,
    PRIMARY KEY (\`id\`)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  // The session database pool, edited at /settings: each row is one database
  // server a session can claim for itself while it runs.
  `CREATE TABLE IF NOT EXISTS \`db_servers\` (
    \`id\`         INT UNSIGNED    NOT NULL AUTO_INCREMENT,
    \`label\`      VARCHAR(255)    NOT NULL,
    \`host\`       VARCHAR(255)    NOT NULL,
    \`port\`       INT UNSIGNED    NOT NULL,
    \`username\`   VARCHAR(255)    NOT NULL,
    \`password\`   VARCHAR(255)    NOT NULL DEFAULT '',
    \`enabled\`    TINYINT(1)      NOT NULL DEFAULT 1,
    \`sort_order\` INT             NOT NULL DEFAULT 0,
    \`created_at\` BIGINT UNSIGNED NOT NULL,
    \`updated_at\` BIGINT UNSIGNED NOT NULL,
    PRIMARY KEY (\`id\`)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  // The operator's library of reusable kickoff prompts, picked from the
  // composer's Prompts menu. A row bound to a repo is offered on that project
  // only; a NULL repo is offered everywhere.
  `CREATE TABLE IF NOT EXISTS \`saved_prompts\` (
    \`id\`         INT UNSIGNED    NOT NULL AUTO_INCREMENT,
    \`title\`      VARCHAR(255)    NOT NULL,
    \`body\`       LONGTEXT        NOT NULL,
    \`repo\`       VARCHAR(255)    NULL,
    \`sort_order\` INT             NOT NULL DEFAULT 0,
    \`created_at\` BIGINT UNSIGNED NOT NULL,
    \`updated_at\` BIGINT UNSIGNED NOT NULL,
    PRIMARY KEY (\`id\`)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  // What the agent learns about a project and keeps between sessions: the
  // dashboard's counterpart to Claude Code's own memory directory, which the
  // per-turn headless runs never see. One row per fact, named like a memory
  // file (a slug), scoped to the repo it is about. The agent writes them
  // through the memory tool during a turn; every later turn on that project
  // gets them in its briefing.
  `CREATE TABLE IF NOT EXISTS \`project_memories\` (
    \`id\`          INT UNSIGNED    NOT NULL AUTO_INCREMENT,
    \`repo\`        VARCHAR(255)    NOT NULL,
    \`name\`        VARCHAR(120)    NOT NULL,
    -- user | feedback | project | reference
    \`type\`        VARCHAR(16)     NOT NULL DEFAULT 'project',
    \`description\` VARCHAR(255)    NOT NULL DEFAULT '',
    \`body\`        LONGTEXT        NOT NULL,
    -- The session that wrote it last, for the trail; NULL when edited by hand.
    \`job_id\`      VARCHAR(64)     NULL,
    \`created_at\`  BIGINT UNSIGNED NOT NULL,
    \`updated_at\`  BIGINT UNSIGNED NOT NULL,
    PRIMARY KEY (\`id\`),
    UNIQUE KEY \`project_memories_name\` (\`repo\`, \`name\`)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  // The operator's verdict per review finding: whether a critical / high /
  // medium (or low) finding must be fixed before the PR merges, is optional,
  // or was dismissed. The findings themselves live on the PR (each review's
  // summary comment carries a machine-readable block) so this table only
  // stores the decision, keyed by a hash of the finding's title.
  `CREATE TABLE IF NOT EXISTS \`review_findings\` (
    \`id\`          INT UNSIGNED    NOT NULL AUTO_INCREMENT,
    \`repo\`        VARCHAR(255)    NOT NULL,
    \`pr_number\`   INT UNSIGNED    NOT NULL,
    \`finding_key\` VARCHAR(32)     NOT NULL,
    \`severity\`    VARCHAR(16)     NOT NULL DEFAULT '',
    \`title\`       TEXT            NULL,
    -- fix | optional | dismissed
    \`decision\`    VARCHAR(16)     NOT NULL,
    \`created_at\`  BIGINT UNSIGNED NOT NULL,
    \`updated_at\`  BIGINT UNSIGNED NOT NULL,
    PRIMARY KEY (\`id\`),
    UNIQUE KEY \`review_findings_key\` (\`repo\`, \`pr_number\`, \`finding_key\`)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  // Singleton app settings that are edited on the settings page but do not
  // deserve a table of their own: one JSON value per name (e.g. the shared
  // prompt templates, the webhook secret).
  `CREATE TABLE IF NOT EXISTS \`app_settings\` (
    \`name\`       VARCHAR(64)     NOT NULL,
    \`value\`      LONGTEXT        NULL,
    \`updated_at\` BIGINT UNSIGNED NOT NULL,
    PRIMARY KEY (\`name\`)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  // The session's log, one row per streamed event. Keyed by (job, seq) so a
  // re-sent batch cannot duplicate a line.
  `CREATE TABLE IF NOT EXISTS \`job_events\` (
    \`job_id\` VARCHAR(64)     NOT NULL,
    \`seq\`    INT UNSIGNED    NOT NULL,
    \`at\`     BIGINT UNSIGNED NOT NULL,
    \`kind\`   VARCHAR(32)     NOT NULL,
    \`data\`   LONGTEXT        NULL,
    PRIMARY KEY (\`job_id\`, \`seq\`)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  // One row per finished turn, as the provider reported it. The jobs table
  // carries the running totals; this is the ledger behind them, so spend can
  // be bucketed by project, month, provider or model after the fact. cost_usd
  // stays NULL when the CLI did not report one; no pricing is invented.
  `CREATE TABLE IF NOT EXISTS \`turn_usage\` (
    \`id\`            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    -- Project ownership is independent of the session row. Deliberately no
    -- foreign key: deleting a session must leave its project's history here.
    \`project_id\`    INT UNSIGNED    NULL,
    \`job_id\`        VARCHAR(64)     NOT NULL,
    \`repo\`          VARCHAR(255)    NULL,
    \`provider\`      VARCHAR(64)     NULL,
    \`model\`         VARCHAR(128)    NULL,
    \`input_tokens\`  BIGINT UNSIGNED NULL,
    \`output_tokens\` BIGINT UNSIGNED NULL,
    \`cost_usd\`      DECIMAL(12,6)   NULL,
    \`duration_ms\`   BIGINT UNSIGNED NULL,
    \`at\`            BIGINT UNSIGNED NOT NULL,
    PRIMARY KEY (\`id\`),
    KEY \`turn_usage_project_at\` (\`project_id\`, \`at\`),
    KEY \`turn_usage_repo_at\` (\`repo\`, \`at\`),
    KEY \`turn_usage_job\` (\`job_id\`)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
];

// Columns added or removed after a table first shipped: CREATE TABLE IF NOT
// EXISTS leaves an existing table alone, so each late change is applied here
// once. `drop: true` inverts the check: the statement runs while the column
// is still there, rather than while it is missing.
const MIGRATIONS = [
  {
    table: 'projects',
    column: 'local_dir',
    ddl: "ALTER TABLE `projects` ADD COLUMN `local_dir` VARCHAR(512) NOT NULL DEFAULT '' AFTER `php_bin_dir`",
  },
  {
    table: 'projects',
    column: 'review_publish_instructions',
    ddl: 'ALTER TABLE `projects` ADD COLUMN `review_publish_instructions` TEXT NULL AFTER `run_commands`',
  },
  {
    table: 'projects',
    column: 'db_restore_sql',
    ddl: "ALTER TABLE `projects` ADD COLUMN `db_restore_sql` VARCHAR(512) NOT NULL DEFAULT '' AFTER `db_pool_database`",
  },
  {
    table: 'projects',
    column: 'db_extensions',
    ddl: 'ALTER TABLE `projects` ADD COLUMN `db_extensions` LONGTEXT NULL AFTER `db_restore_sql`',
  },
  // Keyed on the author column rather than the `auto_review_enabled` one this
  // originally added: that switch is gone, so a database created after it was
  // removed must not have the ALTER run for it.
  {
    table: 'projects',
    column: 'auto_review_author',
    ddl: `ALTER TABLE \`projects\`
      ADD COLUMN \`auto_review_author\`      VARCHAR(255) NOT NULL DEFAULT '' AFTER \`review_publish_instructions\`,
      ADD COLUMN \`auto_review_provider_id\` INT UNSIGNED NULL AFTER \`auto_review_author\`,
      ADD COLUMN \`auto_review_model\`       VARCHAR(128) NOT NULL DEFAULT '' AFTER \`auto_review_provider_id\``,
  },
  {
    table: 'projects',
    column: 'auto_review_effort',
    ddl: "ALTER TABLE `projects` ADD COLUMN `auto_review_effort` VARCHAR(32) NOT NULL DEFAULT '' AFTER `auto_review_model`",
  },
  {
    table: 'projects',
    column: 'review_test_sheet',
    ddl: `ALTER TABLE \`projects\`
      ADD COLUMN \`review_test_sheet\` TINYINT(1) NOT NULL DEFAULT 0 AFTER \`review_publish_instructions\`,
      ADD COLUMN \`review_test_run\`   TINYINT(1) NOT NULL DEFAULT 0 AFTER \`review_test_sheet\`,
      ADD COLUMN \`qa_notes\`          TEXT       NULL AFTER \`review_test_run\``,
  },
  {
    table: 'projects',
    column: 'step_runtimes',
    ddl: 'ALTER TABLE `projects` ADD COLUMN `step_runtimes` LONGTEXT NULL AFTER `auto_review_effort`',
  },
  {
    table: 'projects',
    column: 'prompt_templates',
    ddl: 'ALTER TABLE `projects` ADD COLUMN `prompt_templates` LONGTEXT NULL AFTER `step_runtimes`',
  },
  {
    table: 'providers',
    column: 'auth_data',
    ddl: 'ALTER TABLE `providers` ADD COLUMN `auth_data` LONGTEXT NULL AFTER `default_effort`',
  },
  {
    table: 'jobs',
    column: 'pr_number',
    ddl: `ALTER TABLE \`jobs\`
      ADD COLUMN \`pr_number\`      INT UNSIGNED    NULL AFTER \`ended_at\`,
      ADD COLUMN \`cost_usd\`       DECIMAL(12,4)   NULL AFTER \`pr_number\`,
      ADD COLUMN \`input_tokens\`   BIGINT UNSIGNED NULL AFTER \`cost_usd\`,
      ADD COLUMN \`output_tokens\`  BIGINT UNSIGNED NULL AFTER \`input_tokens\`,
      ADD COLUMN \`context_tokens\` BIGINT UNSIGNED NULL AFTER \`output_tokens\`,
      ADD KEY \`jobs_repo_pr\` (\`repo\`, \`pr_number\`)`,
  },
  // Every entry's config dir is derived from its id, and a provider that
  // should not be offered is deleted rather than hidden, so neither column
  // was ever read back.
  {
    table: 'providers',
    column: 'config_dir',
    drop: true,
    ddl: 'ALTER TABLE `providers` DROP COLUMN `config_dir`',
  },
  {
    table: 'providers',
    column: 'enabled',
    drop: true,
    ddl: 'ALTER TABLE `providers` DROP COLUMN `enabled`',
  },
  {
    table: 'projects',
    column: 'feedback_instructions',
    ddl: 'ALTER TABLE `projects` ADD COLUMN `feedback_instructions` TEXT NULL AFTER `qa_notes`',
  },
  {
    table: 'projects',
    column: 'test_sheet_instructions',
    ddl: 'ALTER TABLE `projects` ADD COLUMN `test_sheet_instructions` TEXT NULL AFTER `feedback_instructions`',
  },
  {
    table: 'turn_usage',
    column: 'project_id',
    ddl: `ALTER TABLE \`turn_usage\`
      ADD COLUMN \`project_id\` INT UNSIGNED NULL AFTER \`id\`,
      ADD KEY \`turn_usage_project_at\` (\`project_id\`, \`at\`)`,
  },
  {
    table: 'turn_usage',
    column: 'duration_ms',
    ddl: 'ALTER TABLE `turn_usage` ADD COLUMN `duration_ms` BIGINT UNSIGNED NULL AFTER `cost_usd`',
  },
];

/** @param { context: import('mysql2/promise').Pool } ctx */
export async function up({ context: p }) {
  for (const stmt of SCHEMA) await p.query(stmt);
  for (const m of MIGRATIONS) {
    const [rows] = await p.query(
      'SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?',
      [m.table, m.column],
    );
    if (m.drop ? /** @type {any[]} */ (rows).length : !(/** @type {any[]} */ (rows).length))
      await p.query(m.ddl);
  }
  // Rows written before project_id existed were already project-owned by
  // repository. Attach them to the stable project row once, so a later repo
  // rename does not make that history disappear from the project dashboard.
  await p.query(`UPDATE \`turn_usage\` AS u
    JOIN \`projects\` AS p ON LOWER(p.\`repo\`) = LOWER(u.\`repo\`)
    SET u.\`project_id\` = p.\`id\`
    WHERE u.\`project_id\` IS NULL`);
}

// The baseline is the whole database; rolling it back would drop every table
// and all session history with them. That is a deliberate act, not a
// `migrate:rollback` away.
export async function down() {
  throw new Error(
    'The baseline migration cannot be rolled back; drop the database by hand if that is what you want',
  );
}
