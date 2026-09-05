// @ts-check
import mysql from 'mysql2/promise';
import { getConfig } from './config.js';
import { ensureDatabase, runMigrations } from './migrator.js';

// Dev sessions and their logs live in MySQL and only in MySQL. There is no
// copy on disk to fall back on, so lib/jobs.js queues writes and retries the
// ones that fail rather than dropping them.
class DbError extends Error {
  constructor(message) {
    super(message);
    this.status = 503;
  }
}

let poolRef = null;
let connecting = null;
let lastError = null;
let lastAttemptAt = 0;
const RETRY_MS = 3000; // a dead database must not be dialled on every request

function dbSettings() {
  return getConfig().db;
}

function unavailable() {
  const { host, port, database } = dbSettings();
  return new DbError(
    `Database unavailable (${host}:${port}/${database}): ${lastError ? lastError.message : 'not connected'}`,
  );
}

async function connect() {
  const { host, port, database, user, password } = dbSettings();
  await ensureDatabase({ host, port, database, user, password });
  const p = mysql.createPool({
    host,
    port,
    user,
    password,
    database,
    waitForConnections: true,
    connectionLimit: 5,
    connectTimeout: 10000,
    charset: 'utf8mb4_unicode_ci',
  });
  try {
    await runMigrations(p);
  } catch (e) {
    await p.end().catch(() => {});
    throw e;
  }
  return p;
}

// Kicked off at boot so a misconfigured database shows up in the log rather
// than on the first session load. Safe to call more than once.
export function initDb() {
  if (poolRef || connecting) return connecting || Promise.resolve(poolRef);
  lastAttemptAt = Date.now();
  connecting = connect()
    .then((p) => {
      poolRef = p;
      lastError = null;
      return p;
    })
    .catch((e) => {
      lastError = e;
      throw e;
    })
    .finally(() => {
      connecting = null;
    });
  return connecting;
}

async function pool() {
  if (poolRef) return poolRef;
  if (!connecting && lastError && Date.now() - lastAttemptAt < RETRY_MS) throw unavailable();
  try {
    return await initDb();
  } catch {
    throw unavailable();
  }
}

// One round trip, for the health endpoint: does the app's own database answer
// right now. Never throws: a health check that crashes is a worse signal
// than "down".
export async function dbHealthy() {
  try {
    const p = await pool();
    await p.query('SELECT 1');
    return true;
  } catch {
    return false;
  }
}

// ---- mapping ----

function toJson(value) {
  return JSON.stringify(value ?? null);
}

function fromJson(text, fallback) {
  if (text == null) return fallback;
  try {
    const parsed = JSON.parse(text);
    return parsed == null ? fallback : parsed;
  } catch {
    return fallback;
  }
}

const iso = (ms) => (ms == null ? null : new Date(Number(ms)).toISOString());

// ---- projects ----

// Columns are snake_case for SQL's sake and camelCase everywhere above it; the
// two mappers below are the only place that seam exists.
function rowToProject(r) {
  return {
    id: Number(r.id),
    repo: r.repo,
    label: r.label,
    enabled: !!r.enabled,
    sortOrder: Number(r.sort_order),
    setupCommands: fromJson(r.setup_commands, []),
    phpBinDir: r.php_bin_dir || '',
    localDir: r.local_dir || '',
    dbPoolEnabled: !!r.db_pool_enabled,
    dbPoolDatabase: r.db_pool_database || '',
    dbRestoreSql: r.db_restore_sql || '',
    dbExtensions: fromJson(r.db_extensions, []),
    envTemplate: r.env_template || '',
    runCommands: fromJson(r.run_commands, []),
    reviewPublishInstructions: r.review_publish_instructions || '',
    reviewTestSheet: !!r.review_test_sheet,
    reviewTestRun: !!r.review_test_run,
    qaNotes: r.qa_notes || '',
    feedbackInstructions: r.feedback_instructions || '',
    testSheetInstructions: r.test_sheet_instructions || '',
    reviewAuthor: r.auto_review_author || '',
    reviewProviderId: r.auto_review_provider_id == null ? null : Number(r.auto_review_provider_id),
    reviewModel: r.auto_review_model || '',
    reviewEffort: r.auto_review_effort || '',
    workerProviderId: r.worker_provider_id == null ? null : Number(r.worker_provider_id),
    workerModel: r.worker_model || '',
    workerEffort: r.worker_effort || '',
    workerBudgetUsd: r.worker_budget_usd == null ? null : Number(r.worker_budget_usd),
    isSelf: !!r.is_self,
    stepRuntimes: fromJson(r.step_runtimes, {}),
    promptTemplates: fromJson(r.prompt_templates, {}),
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
  };
}

const PROJECT_COLUMNS = [
  'repo',
  'label',
  'enabled',
  'sort_order',
  'setup_commands',
  'php_bin_dir',
  'local_dir',
  'db_pool_enabled',
  'db_pool_database',
  'db_restore_sql',
  'db_extensions',
  'env_template',
  'run_commands',
  'review_publish_instructions',
  'review_test_sheet',
  'review_test_run',
  'qa_notes',
  'feedback_instructions',
  'test_sheet_instructions',
  'auto_review_author',
  'auto_review_provider_id',
  'auto_review_model',
  'auto_review_effort',
  'worker_provider_id',
  'worker_model',
  'worker_effort',
  'worker_budget_usd',
  'is_self',
  'step_runtimes',
  'prompt_templates',
];

function projectValues(p) {
  return [
    p.repo,
    p.label,
    p.enabled ? 1 : 0,
    p.sortOrder || 0,
    toJson(p.setupCommands || []),
    p.phpBinDir || '',
    p.localDir || '',
    p.dbPoolEnabled ? 1 : 0,
    p.dbPoolDatabase || '',
    p.dbRestoreSql || '',
    toJson(p.dbExtensions || []),
    p.envTemplate || '',
    toJson(p.runCommands || []),
    p.reviewPublishInstructions || '',
    p.reviewTestSheet ? 1 : 0,
    p.reviewTestRun ? 1 : 0,
    p.qaNotes || '',
    p.feedbackInstructions || '',
    p.testSheetInstructions || '',
    p.reviewAuthor || '',
    p.reviewProviderId || null,
    p.reviewModel || '',
    p.reviewEffort || '',
    p.workerProviderId || null,
    p.workerModel || '',
    p.workerEffort || '',
    p.workerBudgetUsd ?? null,
    p.isSelf ? 1 : 0,
    toJson(p.stepRuntimes || {}),
    toJson(p.promptTemplates || {}),
  ];
}

export async function loadProjectRows() {
  const p = await pool();
  const [rows] = await p.query('SELECT * FROM `projects` ORDER BY `sort_order`, `id`');
  return rows.map(rowToProject);
}

// Insert or update by id, and hand back the stored row so the caller sees the
// server-assigned id and timestamps rather than guessing at them.
export async function saveProject(project) {
  const p = await pool();
  const now = Date.now();
  if (project.id) {
    const sets = PROJECT_COLUMNS.map((c) => `\`${c}\` = ?`).join(', ');
    const [res] = await p.query(`UPDATE \`projects\` SET ${sets}, \`updated_at\` = ? WHERE \`id\` = ?`, [
      ...projectValues(project),
      now,
      project.id,
    ]);
    if (!res.affectedRows) throw new Error(`No project with id ${project.id}`);
    return getProjectRow(project.id);
  }
  const placeholders = PROJECT_COLUMNS.map(() => '?').join(', ');
  const [res] = await p.query(
    `INSERT INTO \`projects\` (${PROJECT_COLUMNS.map((c) => `\`${c}\``).join(', ')}, \`created_at\`, \`updated_at\`)
     VALUES (${placeholders}, ?, ?)`,
    [...projectValues(project), now, now],
  );
  return getProjectRow(res.insertId);
}

export async function getProjectRow(id) {
  const p = await pool();
  const [rows] = await p.query('SELECT * FROM `projects` WHERE `id` = ?', [id]);
  return rows.length ? rowToProject(rows[0]) : null;
}

export async function deleteProject(id) {
  const p = await pool();
  const [res] = await p.query('DELETE FROM `projects` WHERE `id` = ?', [id]);
  return res.affectedRows;
}

// ---- review finding decisions ----

// Every stored verdict for one PR's findings, as a map keyed the same way the
// findings themselves are (a hash of the title).
export async function loadFindingDecisions(repo, prNumber) {
  const p = await pool();
  const [rows] = await p.query(
    'SELECT `finding_key`, `severity`, `title`, `decision` FROM `review_findings` WHERE `repo` = ? AND `pr_number` = ?',
    [repo, prNumber],
  );
  return new Map(
    rows.map((r) => [r.finding_key, { severity: r.severity, title: r.title, decision: r.decision }]),
  );
}

// Set or clear one finding's verdict. A null decision deletes the row, and the
// finding goes back to undecided.
export async function saveFindingDecision({ repo, prNumber, key, severity, title, decision }) {
  const p = await pool();
  if (!decision) {
    await p.query(
      'DELETE FROM `review_findings` WHERE `repo` = ? AND `pr_number` = ? AND `finding_key` = ?',
      [repo, prNumber, key],
    );
    return;
  }
  const now = Date.now();
  await p.query(
    `INSERT INTO \`review_findings\`
       (\`repo\`, \`pr_number\`, \`finding_key\`, \`severity\`, \`title\`, \`decision\`, \`created_at\`, \`updated_at\`)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       \`severity\` = VALUES(\`severity\`), \`title\` = VALUES(\`title\`),
       \`decision\` = VALUES(\`decision\`), \`updated_at\` = VALUES(\`updated_at\`)`,
    [repo, prNumber, key, severity || '', title || '', decision, now, now],
  );
}

// ---- app settings ----

export async function loadAppSetting(name, fallback = null) {
  const p = await pool();
  const [rows] = await p.query('SELECT `value` FROM `app_settings` WHERE `name` = ?', [name]);
  return rows.length ? fromJson(rows[0].value, fallback) : fallback;
}

export async function saveAppSetting(name, value) {
  const p = await pool();
  await p.query(
    'INSERT INTO `app_settings` (`name`, `value`, `updated_at`) VALUES (?, ?, ?)' +
      ' ON DUPLICATE KEY UPDATE `value` = VALUES(`value`), `updated_at` = VALUES(`updated_at`)',
    [name, toJson(value), Date.now()],
  );
}

// ---- providers ----

function rowToProvider(r) {
  return {
    id: Number(r.id),
    label: r.label,
    binary: r.binary,
    baseUrl: r.base_url || '',
    apiKey: r.api_key || '',
    models: fromJson(r.models, []),
    efforts: fromJson(r.efforts, []),
    defaultModel: r.default_model || '',
    defaultEffort: r.default_effort || '',
    authData: fromJson(r.auth_data, null),
    sortOrder: Number(r.sort_order),
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
  };
}

const PROVIDER_COLUMNS = [
  'label',
  'binary',
  'base_url',
  'api_key',
  'models',
  'efforts',
  'default_model',
  'default_effort',
  'auth_data',
  'sort_order',
];

function providerValues(p) {
  return [
    p.label,
    p.binary,
    p.baseUrl || '',
    p.apiKey || '',
    toJson(p.models || []),
    toJson(p.efforts || []),
    p.defaultModel || '',
    p.defaultEffort || '',
    p.authData ? toJson(p.authData) : null,
    p.sortOrder || 0,
  ];
}

export async function loadProviderRows() {
  const p = await pool();
  const [rows] = await p.query('SELECT * FROM `providers` ORDER BY `sort_order`, `id`');
  return rows.map(rowToProvider);
}

export async function saveProviderRow(provider) {
  const p = await pool();
  const now = Date.now();
  if (provider.id) {
    const sets = PROVIDER_COLUMNS.map((c) => `\`${c}\` = ?`).join(', ');
    const [res] = await p.query(`UPDATE \`providers\` SET ${sets}, \`updated_at\` = ? WHERE \`id\` = ?`, [
      ...providerValues(provider),
      now,
      provider.id,
    ]);
    if (!res.affectedRows) throw new Error(`No provider with id ${provider.id}`);
    return getProviderRow(provider.id);
  }
  const placeholders = PROVIDER_COLUMNS.map(() => '?').join(', ');
  const [res] = await p.query(
    `INSERT INTO \`providers\` (${PROVIDER_COLUMNS.map((c) => `\`${c}\``).join(', ')}, \`created_at\`, \`updated_at\`)
     VALUES (${placeholders}, ?, ?)`,
    [...providerValues(provider), now, now],
  );
  return getProviderRow(res.insertId);
}

export async function getProviderRow(id) {
  const p = await pool();
  const [rows] = await p.query('SELECT * FROM `providers` WHERE `id` = ?', [id]);
  return rows.length ? rowToProvider(rows[0]) : null;
}

export async function deleteProviderRow(id) {
  const p = await pool();
  const [res] = await p.query('DELETE FROM `providers` WHERE `id` = ?', [id]);
  return res.affectedRows;
}

// ---- database pool ----

function rowToDbServer(r) {
  return {
    id: Number(r.id),
    label: r.label,
    host: r.host,
    port: Number(r.port),
    username: r.username,
    password: r.password || '',
    enabled: !!r.enabled,
    sortOrder: Number(r.sort_order),
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
  };
}

const DB_SERVER_COLUMNS = ['label', 'host', 'port', 'username', 'password', 'enabled', 'sort_order'];

function dbServerValues(s) {
  return [s.label, s.host, s.port, s.username, s.password || '', s.enabled ? 1 : 0, s.sortOrder || 0];
}

export async function loadDbServerRows() {
  const p = await pool();
  const [rows] = await p.query('SELECT * FROM `db_servers` ORDER BY `sort_order`, `id`');
  return rows.map(rowToDbServer);
}

export async function saveDbServer(server) {
  const p = await pool();
  const now = Date.now();
  if (server.id) {
    const sets = DB_SERVER_COLUMNS.map((c) => `\`${c}\` = ?`).join(', ');
    const [res] = await p.query(`UPDATE \`db_servers\` SET ${sets}, \`updated_at\` = ? WHERE \`id\` = ?`, [
      ...dbServerValues(server),
      now,
      server.id,
    ]);
    if (!res.affectedRows) throw new Error(`No database server with id ${server.id}`);
    return getDbServerRow(server.id);
  }
  const placeholders = DB_SERVER_COLUMNS.map(() => '?').join(', ');
  const [res] = await p.query(
    `INSERT INTO \`db_servers\` (${DB_SERVER_COLUMNS.map((c) => `\`${c}\``).join(', ')}, \`created_at\`, \`updated_at\`)
     VALUES (${placeholders}, ?, ?)`,
    [...dbServerValues(server), now, now],
  );
  return getDbServerRow(res.insertId);
}

export async function getDbServerRow(id) {
  const p = await pool();
  const [rows] = await p.query('SELECT * FROM `db_servers` WHERE `id` = ?', [id]);
  return rows.length ? rowToDbServer(rows[0]) : null;
}

export async function deleteDbServer(id) {
  const p = await pool();
  const [res] = await p.query('DELETE FROM `db_servers` WHERE `id` = ?', [id]);
  return res.affectedRows;
}

// ---- saved prompts ----

function rowToSavedPrompt(r) {
  return {
    id: Number(r.id),
    title: r.title,
    body: r.body,
    repo: r.repo || null,
    sortOrder: Number(r.sort_order),
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
  };
}

const SAVED_PROMPT_COLUMNS = ['title', 'body', 'repo', 'sort_order'];

function savedPromptValues(s) {
  return [s.title, s.body, s.repo || null, s.sortOrder || 0];
}

export async function loadSavedPromptRows() {
  const p = await pool();
  const [rows] = await p.query('SELECT * FROM `saved_prompts` ORDER BY `sort_order`, `id`');
  return rows.map(rowToSavedPrompt);
}

export async function saveSavedPrompt(prompt) {
  const p = await pool();
  const now = Date.now();
  if (prompt.id) {
    const sets = SAVED_PROMPT_COLUMNS.map((c) => `\`${c}\` = ?`).join(', ');
    const [res] = await p.query(`UPDATE \`saved_prompts\` SET ${sets}, \`updated_at\` = ? WHERE \`id\` = ?`, [
      ...savedPromptValues(prompt),
      now,
      prompt.id,
    ]);
    if (!res.affectedRows) throw new Error(`No saved prompt with id ${prompt.id}`);
    return getSavedPromptRow(prompt.id);
  }
  const placeholders = SAVED_PROMPT_COLUMNS.map(() => '?').join(', ');
  const [res] = await p.query(
    `INSERT INTO \`saved_prompts\` (${SAVED_PROMPT_COLUMNS.map((c) => `\`${c}\``).join(', ')}, \`created_at\`, \`updated_at\`)
     VALUES (${placeholders}, ?, ?)`,
    [...savedPromptValues(prompt), now, now],
  );
  return getSavedPromptRow(res.insertId);
}

export async function getSavedPromptRow(id) {
  const p = await pool();
  const [rows] = await p.query('SELECT * FROM `saved_prompts` WHERE `id` = ?', [id]);
  return rows.length ? rowToSavedPrompt(rows[0]) : null;
}

export async function deleteSavedPrompt(id) {
  const p = await pool();
  const [res] = await p.query('DELETE FROM `saved_prompts` WHERE `id` = ?', [id]);
  return res.affectedRows;
}

// ---- project memories ----

function rowToMemory(r) {
  return {
    id: Number(r.id),
    repo: r.repo,
    name: r.name,
    type: r.type,
    description: r.description || '',
    body: r.body,
    jobId: r.job_id || null,
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
  };
}

const MEMORY_COLUMNS = ['repo', 'name', 'type', 'description', 'body', 'job_id'];

function memoryValues(m) {
  return [m.repo, m.name, m.type, m.description || '', m.body, m.jobId || null];
}

export async function loadMemoryRows() {
  const p = await pool();
  const [rows] = await p.query('SELECT * FROM `project_memories` ORDER BY `repo`, `name`');
  return rows.map(rowToMemory);
}

export async function saveMemory(memory) {
  const p = await pool();
  const now = Date.now();
  if (memory.id) {
    const sets = MEMORY_COLUMNS.map((c) => `\`${c}\` = ?`).join(', ');
    const [res] = await p.query(
      `UPDATE \`project_memories\` SET ${sets}, \`updated_at\` = ? WHERE \`id\` = ?`,
      [...memoryValues(memory), now, memory.id],
    );
    if (!res.affectedRows) throw new Error(`No memory with id ${memory.id}`);
    return getMemoryRow(memory.id);
  }
  const placeholders = MEMORY_COLUMNS.map(() => '?').join(', ');
  const [res] = await p.query(
    `INSERT INTO \`project_memories\` (${MEMORY_COLUMNS.map((c) => `\`${c}\``).join(', ')}, \`created_at\`, \`updated_at\`)
     VALUES (${placeholders}, ?, ?)`,
    [...memoryValues(memory), now, now],
  );
  return getMemoryRow(res.insertId);
}

export async function getMemoryRow(id) {
  const p = await pool();
  const [rows] = await p.query('SELECT * FROM `project_memories` WHERE `id` = ?', [id]);
  return rows.length ? rowToMemory(rows[0]) : null;
}

export async function deleteMemory(id) {
  const p = await pool();
  const [res] = await p.query('DELETE FROM `project_memories` WHERE `id` = ?', [id]);
  return res.affectedRows;
}

// ---- sessions ----

export async function saveJob(job) {
  const p = await pool();
  await p.query(
    `INSERT INTO \`jobs\`
       (\`id\`, \`kind\`, \`status\`, \`repo\`, \`title\`, \`meta\`, \`created_at\`, \`ended_at\`,
        \`pr_number\`, \`cost_usd\`, \`input_tokens\`, \`output_tokens\`, \`context_tokens\`)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       \`kind\` = VALUES(\`kind\`), \`status\` = VALUES(\`status\`),
       \`repo\` = VALUES(\`repo\`),
       \`title\` = VALUES(\`title\`), \`meta\` = VALUES(\`meta\`),
       \`ended_at\` = VALUES(\`ended_at\`),
       \`pr_number\` = VALUES(\`pr_number\`), \`cost_usd\` = VALUES(\`cost_usd\`),
       \`input_tokens\` = VALUES(\`input_tokens\`), \`output_tokens\` = VALUES(\`output_tokens\`),
       \`context_tokens\` = VALUES(\`context_tokens\`)`,
    [
      job.id,
      job.kind,
      job.status,
      job.repo ?? null,
      job.title ?? null,
      toJson(job),
      Date.parse(job.createdAt || '') || Date.now(),
      job.endedAt ? Date.parse(job.endedAt) : null,
      job.prStatus?.number ?? null,
      job.costUsd ?? null,
      job.inputTokens ?? null,
      job.outputTokens ?? null,
      job.contextTokens ?? null,
    ],
  );
}

function eventRow(jobId, e) {
  const { seq, t, kind, ...data } = e;
  return [jobId, seq, Date.parse(t || '') || Date.now(), kind || 'info', toJson(data)];
}

const EVENT_INSERT = 'INSERT IGNORE INTO `job_events` (`job_id`, `seq`, `at`, `kind`, `data`) VALUES ?';

// Bulk-append log lines. INSERT IGNORE so a retried flush is harmless.
export async function saveJobEvents(jobId, events) {
  if (!events.length) return;
  const p = await pool();
  await p.query(EVENT_INSERT, [events.map((e) => eventRow(jobId, e))]);
}

// The last line each session has stored, for restoring its counter at boot
// without a query per session. One row per session that has ever logged.
export async function jobEventMaxSeqs() {
  const p = await pool();
  const [rows] = await p.query(
    'SELECT `job_id`, MAX(`seq`) AS `max_seq` FROM `job_events` GROUP BY `job_id`',
  );
  return new Map(rows.map((r) => [r.job_id, Number(r.max_seq)]));
}

export async function loadJobs(limit = 500) {
  const p = await pool();
  const [rows] = await p.query('SELECT `meta` FROM `jobs` ORDER BY `created_at` DESC LIMIT ?', [limit]);
  return rows.map((r) => fromJson(r.meta, null)).filter(Boolean);
}

export async function loadJobEvents(jobId, since = 0) {
  const p = await pool();
  const [rows] = await p.query(
    'SELECT `seq`, `at`, `kind`, `data` FROM `job_events` WHERE `job_id` = ? AND `seq` > ? ORDER BY `seq`',
    [jobId, since],
  );
  return rows.map((r) => ({
    seq: Number(r.seq),
    t: iso(r.at),
    kind: r.kind,
    ...fromJson(r.data, {}),
  }));
}

// ---- usage ledger ----

export async function saveTurnUsage(row) {
  const p = await pool();
  await p.query(
    `INSERT INTO \`turn_usage\`
       (\`project_id\`, \`job_id\`, \`repo\`, \`provider\`, \`model\`, \`activity\`, \`input_tokens\`, \`output_tokens\`, \`cost_usd\`, \`duration_ms\`, \`at\`)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      row.projectId ?? null,
      row.jobId,
      row.repo ?? null,
      row.provider ?? null,
      row.model ?? null,
      row.activity ?? null,
      row.inputTokens ?? null,
      row.outputTokens ?? null,
      row.costUsd ?? null,
      row.durationMs ?? null,
      row.at,
    ],
  );
}

// One ledger row as lib/usage.js reads it. Numbers come back as JS numbers
// (DECIMAL and BIGINT arrive as strings from mysql2) so the aggregation there
// can add them without caring where they came from.
function turnUsageRow(r) {
  return {
    projectId: r.project_id == null ? null : Number(r.project_id),
    jobId: r.job_id,
    repo: r.repo,
    provider: r.provider,
    model: r.model,
    activity: r.activity,
    inputTokens: r.input_tokens == null ? null : Number(r.input_tokens),
    outputTokens: r.output_tokens == null ? null : Number(r.output_tokens),
    costUsd: r.cost_usd == null ? null : Number(r.cost_usd),
    durationMs: r.duration_ms == null ? null : Number(r.duration_ms),
    at: Number(r.at),
  };
}

const TURN_USAGE_COLUMNS =
  '`project_id`, `job_id`, `repo`, `provider`, `model`, `activity`, `input_tokens`, `output_tokens`, `cost_usd`, `duration_ms`, `at`';

// The turns a project ran inside [from, to).
export async function loadTurnUsage(projectId, repo, from, to) {
  const p = await pool();
  const [rows] = await p.query(
    `SELECT ${TURN_USAGE_COLUMNS}
       FROM \`turn_usage\`
      WHERE (\`project_id\` = ? OR (\`project_id\` IS NULL AND LOWER(\`repo\`) = LOWER(?)))
        AND \`at\` >= ? AND \`at\` < ?`,
    [projectId, repo, from, to],
  );
  return rows.map(turnUsageRow);
}

// Every project's turns inside [from, to): what the main dashboard groups. A
// null bound is left off the query, which is how "all time" asks for the whole
// ledger. `project_id` and `repo` both travel: a turn written before its
// project row existed carries only the repo, and one whose project has since
// been deleted from Settings carries an id nothing resolves any more.
export async function loadAllTurnUsage(from = null, to = null) {
  const p = await pool();
  const where = [];
  const args = [];
  if (from != null) {
    where.push('`at` >= ?');
    args.push(from);
  }
  if (to != null) {
    where.push('`at` < ?');
    args.push(to);
  }
  const [rows] = await p.query(
    `SELECT ${TURN_USAGE_COLUMNS} FROM \`turn_usage\`${where.length ? ` WHERE ${where.join(' AND ')}` : ''}`,
    args,
  );
  return rows.map(turnUsageRow);
}

// Trashing a run takes its log with it. Its turn_usage rows are project
// history, not session children, so they intentionally stay behind.
//
// `absorb` pays the deleted run's spend into another job's row inside the
// same transaction: the receiving parent may exist only in this database (the
// restore window is bounded), and a crash between a committed delete and a
// deferred save must not lose the spend. Applied only when the delete really
// removed the row, so a second delete racing this one transfers nothing.
//
// It lands in the record's absorbed* fields, beside its own figures rather
// than in them: a session's own tokens are rewritten from the provider's
// accounting after every turn (jobs.js's probeContextUsage), and a fold added
// into them would not survive the next reply. A measure the deleted session
// never had (an unpriced provider's cost) is left out, so the parent's
// absorbed cost stays null rather than becoming a zero someone reads as free.
/** @type {Array<[keyof AbsorbedUsage, string, string]>} */
const ABSORBED = [
  ['sessions', '$.absorbedSessions', 'UNSIGNED'],
  ['costUsd', '$.absorbedCostUsd', 'DECIMAL(12, 4)'],
  ['inputTokens', '$.absorbedInputTokens', 'UNSIGNED'],
  ['outputTokens', '$.absorbedOutputTokens', 'UNSIGNED'],
  ['durationMs', '$.absorbedDurationMs', 'UNSIGNED'],
];

/**
 * @typedef {{ sessions: number, costUsd: number | null, inputTokens: number | null,
 *   outputTokens: number | null, durationMs: number | null }} AbsorbedUsage
 */

/** @param {string} jobId @param {(AbsorbedUsage & { intoJobId: string }) | null} [absorb] */
export async function deleteJob(jobId, absorb = null) {
  const p = await pool();
  const conn = await p.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query('DELETE FROM `job_events` WHERE `job_id` = ?', [jobId]);
    const [res] = await conn.query('DELETE FROM `jobs` WHERE `id` = ?', [jobId]);
    if (res.affectedRows && absorb) {
      // `meta` is the authoritative record loadJobs restores from (the
      // columns beside it mirror the session's own spend only, and saveJob
      // keeps those). Spelled JSON_UNQUOTE(JSON_EXTRACT(...)) rather than
      // `->>`, which MariaDB does not accept. The extraction answers SQL NULL
      // for a missing path but the string 'null' for a JSON null, and NULLIF
      // folds that second shape into the first.
      const sets = [];
      const params = [];
      for (const [key, path, type] of ABSORBED) {
        if (absorb[key] == null) continue;
        sets.push(
          `'${path}', COALESCE(CAST(NULLIF(JSON_UNQUOTE(JSON_EXTRACT(\`meta\`, '${path}')), 'null') AS ${type}), 0) + ?`,
        );
        params.push(absorb[key]);
      }
      await conn.query(
        `UPDATE \`jobs\` SET \`meta\` = JSON_SET(\`meta\`, ${sets.join(', ')})
          WHERE \`id\` = ? AND \`meta\` IS NOT NULL`,
        [...params, absorb.intoJobId],
      );
    }
    await conn.commit();
    return res.affectedRows;
  } catch (e) {
    await conn.rollback().catch(() => {});
    throw e;
  } finally {
    conn.release();
  }
}
