// @ts-check
import { taskSnapshot } from './task-snapshot.js';
import mysql from 'mysql2/promise';
import { getConfig } from './config.js';
import { ensureDatabase, runMigrations } from './migrator.js';

// Sessions and logs live only in MySQL, with no disk copy, so lib/jobs.js queues
// and retries failed writes rather than dropping them.
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

// For the health endpoint. Never throws: a crashing health check is a worse
// signal than "down".
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
    mailToolsEnabled: !!r.mail_tools_enabled,
    whatsappToolsEnabled: !!r.whatsapp_tools_enabled,
    sortOrder: Number(r.sort_order),
    setupCommands: fromJson(r.setup_commands, []),
    phpBinDir: r.php_bin_dir || '',
    localDir: r.local_dir || '',
    autoUpdate: !!r.auto_update,
    updateCommands: fromJson(r.update_commands, []),
    dbPoolEnabled: !!r.db_pool_enabled,
    dbPoolDatabase: r.db_pool_database || '',
    dbRestoreSql: r.db_restore_sql || '',
    dbExtensions: fromJson(r.db_extensions, []),
    envTemplate: r.env_template || '',
    runCommands: fromJson(r.run_commands, []),
    runProfiles: r.run_profiles || '',
    reviewPublishInstructions: r.review_publish_instructions || '',
    autonomousReviewLoop: !!r.autonomous_review_loop,
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
    isSelf: !!r.is_self,
    stepRuntimes: fromJson(r.step_runtimes, {}),
    promptTemplates: fromJson(r.prompt_templates, {}),
    projectBoard: fromJson(r.project_board, null),
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
  };
}

const PROJECT_COLUMNS = [
  'repo',
  'label',
  'enabled',
  'mail_tools_enabled',
  'whatsapp_tools_enabled',
  'sort_order',
  'setup_commands',
  'php_bin_dir',
  'local_dir',
  'auto_update',
  'update_commands',
  'db_pool_enabled',
  'db_pool_database',
  'db_restore_sql',
  'db_extensions',
  'env_template',
  'run_commands',
  'run_profiles',
  'review_publish_instructions',
  'autonomous_review_loop',
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
  'is_self',
  'step_runtimes',
  'prompt_templates',
  'project_board',
];

function projectValues(p) {
  return [
    p.repo,
    p.label,
    p.enabled ? 1 : 0,
    p.mailToolsEnabled === true ? 1 : 0,
    p.whatsappToolsEnabled === true ? 1 : 0,
    p.sortOrder || 0,
    toJson(p.setupCommands || []),
    p.phpBinDir || '',
    p.localDir || '',
    p.autoUpdate ? 1 : 0,
    toJson(p.updateCommands || []),
    p.dbPoolEnabled ? 1 : 0,
    p.dbPoolDatabase || '',
    p.dbRestoreSql || '',
    toJson(p.dbExtensions || []),
    p.envTemplate || '',
    toJson(p.runCommands || []),
    p.runProfiles || '',
    p.reviewPublishInstructions || '',
    p.autonomousReviewLoop ? 1 : 0,
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
    p.isSelf ? 1 : 0,
    toJson(p.stepRuntimes || {}),
    toJson(p.promptTemplates || {}),
    p.projectBoard ? toJson(p.projectBoard) : null,
  ];
}

export async function loadProjectRows() {
  const p = await pool();
  const [rows] = await p.query('SELECT * FROM `projects` ORDER BY `sort_order`, `id`');
  return rows.map(rowToProject);
}

// Insert or update by id; returns the stored row with server-assigned id and times.
export async function saveProject(project) {
  const p = await pool();
  const now = Date.now();
  if (project.id) {
    // sort_order has its own writer (saveProjectOrder), so an update that names
    // no position must not overwrite a reorder that landed since the read.
    const keep = project.sortOrder === undefined ? 'sort_order' : null;
    const values = projectValues(project).filter((_, i) => PROJECT_COLUMNS[i] !== keep);
    const sets = PROJECT_COLUMNS.filter((c) => c !== keep)
      .map((c) => `\`${c}\` = ?`)
      .join(', ');
    const [res] = await p.query(`UPDATE \`projects\` SET ${sets}, \`updated_at\` = ? WHERE \`id\` = ?`, [
      ...values,
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

// One statement so a reorder never lands half-applied; sort_order is the 1-based
// list position. updated_at is untouched since moving is not an edit.
export async function saveProjectOrder(ids) {
  if (!ids.length) return;
  const p = await pool();
  await p.query(`UPDATE \`projects\` SET \`sort_order\` = FIELD(\`id\`, ?) WHERE \`id\` IN (?)`, [ids, ids]);
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

// Read-modify-write of a setting under a row lock, for settings several processes
// write (the server and `npm run create-token` both change `mobile_devices`). The
// row is created first since locking a missing row guards nothing. If fn throws,
// nothing is written. Scripts with their own pool pass it as `via`.
export async function updateAppSetting(name, fallback, fn, via = null) {
  const p = via || (await pool());
  const conn = await p.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query('INSERT IGNORE INTO `app_settings` (`name`, `value`, `updated_at`) VALUES (?, ?, ?)', [
      name,
      toJson(fallback),
      Date.now(),
    ]);
    const [rows] = await conn.query('SELECT `value` FROM `app_settings` WHERE `name` = ? FOR UPDATE', [name]);
    const value = fromJson(/** @type {any[]} */ (rows)[0]?.value, fallback);
    const result = fn(value);
    await conn.query('UPDATE `app_settings` SET `value` = ?, `updated_at` = ? WHERE `name` = ?', [
      toJson(value),
      Date.now(),
      name,
    ]);
    await conn.commit();
    return { value, result };
  } catch (e) {
    await conn.rollback().catch(() => {});
    throw e;
  } finally {
    conn.release();
  }
}

// ---- providers ----

function rowToProvider(r) {
  return {
    id: Number(r.id),
    label: r.label,
    binary: r.binary,
    active: !!r.active,
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
  'active',
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
    p.active ? 1 : 0,
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

// ---- mail ----

// An account row keeps its OAuth tokens sealed (lib/secretbox.js); this layer
// hands the sealed text up as it is and never opens it.
function rowToMailAccount(r) {
  return {
    id: Number(r.id),
    provider: r.provider,
    email: r.email,
    label: r.label || '',
    enabled: !!r.enabled,
    syncDays: Number(r.sync_days),
    credentials: r.credentials,
    syncState: fromJson(r.sync_state, null),
    status: r.status,
    lastSyncAt: r.last_sync_at == null ? null : Number(r.last_sync_at),
    lastSyncError: r.last_sync_error || null,
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  };
}

// What an update may change, camelCase above to its column; the JSON one is
// written as JSON.
const MAIL_ACCOUNT_COLUMNS = {
  label: 'label',
  enabled: 'enabled',
  syncDays: 'sync_days',
  credentials: 'credentials',
  syncState: 'sync_state',
  status: 'status',
  lastSyncAt: 'last_sync_at',
  lastSyncError: 'last_sync_error',
};

function mailAccountValue(key, value) {
  if (key === 'enabled') return value ? 1 : 0;
  if (key === 'syncState') return value == null ? null : toJson(value);
  return value ?? null;
}

export async function loadMailAccountRows() {
  const p = await pool();
  const [rows] = await p.query('SELECT * FROM `mail_accounts` ORDER BY `id`');
  return rows.map(rowToMailAccount);
}

export async function getMailAccountRow(id) {
  const p = await pool();
  const [rows] = await p.query('SELECT * FROM `mail_accounts` WHERE `id` = ?', [id]);
  return rows.length ? rowToMailAccount(rows[0]) : null;
}

export async function insertMailAccount(a) {
  const p = await pool();
  const now = Date.now();
  const [res] = await p.query(
    `INSERT INTO \`mail_accounts\`
       (\`provider\`, \`email\`, \`label\`, \`enabled\`, \`sync_days\`, \`credentials\`, \`status\`, \`created_at\`, \`updated_at\`)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      a.provider,
      a.email,
      a.label || '',
      a.enabled === false ? 0 : 1,
      a.syncDays,
      a.credentials,
      a.status,
      now,
      now,
    ],
  );
  return getMailAccountRow(res.insertId);
}

// On the pool, or on the connection of a transaction the change is part of.
function writeMailAccount(db, id, changes) {
  const keys = Object.keys(changes).filter((k) => Object.hasOwn(MAIL_ACCOUNT_COLUMNS, k));
  const sets = keys.map((k) => `\`${MAIL_ACCOUNT_COLUMNS[k]}\` = ?`);
  return db.query(
    `UPDATE \`mail_accounts\` SET ${[...sets, '`updated_at` = ?'].join(', ')} WHERE \`id\` = ?`,
    [...keys.map((k) => mailAccountValue(k, changes[k])), Date.now(), id],
  );
}

export async function updateMailAccount(id, changes) {
  const [res] = await writeMailAccount(await pool(), id, changes);
  return res.affectedRows;
}

// The account and everything synced from it, together: messages left behind
// would belong to nobody and could not be listed or removed again.
export async function deleteMailAccount(id) {
  const p = await pool();
  const conn = await p.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query('DELETE FROM `mail_messages` WHERE `account_id` = ?', [id]);
    const [res] = await conn.query('DELETE FROM `mail_accounts` WHERE `id` = ?', [id]);
    await conn.commit();
    return res.affectedRows;
  } catch (e) {
    await conn.rollback().catch(() => {});
    throw e;
  } finally {
    conn.release();
  }
}

const MAIL_SUMMARY_COLUMNS =
  '`account_id`, `id`, `thread_id`, `folder_id`, `received_at`, `from_name`, `from_address`, `recipients`,' +
  ' `subject`, `snippet`, `labels`, `in_inbox`, `is_read`, `is_starred`, `attachments`, `web_url`';

function rowToMailMessage(r) {
  const recipients = fromJson(r.recipients, {});
  const message = {
    accountId: Number(r.account_id),
    id: r.id,
    threadId: r.thread_id,
    receivedAt: Number(r.received_at),
    from: { name: r.from_name, address: r.from_address },
    to: recipients.to || [],
    cc: recipients.cc || [],
    replyTo: recipients.replyTo || [],
    subject: r.subject,
    snippet: r.snippet,
    labels: fromJson(r.labels, []),
    inInbox: !!r.in_inbox,
    isRead: !!r.is_read,
    isStarred: !!r.is_starred,
    attachments: fromJson(r.attachments, []),
    webUrl: r.web_url || null,
  };
  if (!Object.hasOwn(r, 'body_text')) return message;
  return {
    ...message,
    messageId: r.message_id || null,
    body: { text: r.body_text ?? null, html: r.body_html ?? null, truncated: !!r.body_truncated },
  };
}

// A string cut to what a VARCHAR(n) column holds, n characters rather than
// UTF-16 units, so no character is split. The sender is whatever a stranger
// put in the From header, and one longer than its column would fail the
// insert under strict mode and stop every pass at the same message.
function fitColumn(text, n) {
  const s = String(text || '');
  return s.length <= n ? s : [...s].slice(0, n).join('');
}

// One statement per message rather than a multi-row insert: a body may run
// to megabytes, and a batch of them would outgrow the server's packet limit.
export async function upsertMailMessages(accountId, messages, syncedAt) {
  if (!messages.length) return;
  const p = await pool();
  for (const m of messages) {
    await p.query(
      `INSERT INTO \`mail_messages\`
         (\`account_id\`, \`id\`, \`thread_id\`, \`folder_id\`, \`received_at\`, \`from_name\`, \`from_address\`,
          \`recipients\`, \`subject\`, \`snippet\`, \`labels\`, \`in_inbox\`, \`is_read\`, \`is_starred\`,
          \`attachments\`, \`body_text\`, \`body_html\`, \`body_truncated\`, \`message_id\`, \`web_url\`, \`synced_at\`)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         \`thread_id\` = VALUES(\`thread_id\`), \`folder_id\` = VALUES(\`folder_id\`),
         \`received_at\` = VALUES(\`received_at\`), \`from_name\` = VALUES(\`from_name\`),
         \`from_address\` = VALUES(\`from_address\`), \`recipients\` = VALUES(\`recipients\`),
         \`subject\` = VALUES(\`subject\`), \`snippet\` = VALUES(\`snippet\`), \`labels\` = VALUES(\`labels\`),
         \`in_inbox\` = VALUES(\`in_inbox\`), \`is_read\` = VALUES(\`is_read\`), \`is_starred\` = VALUES(\`is_starred\`),
         \`attachments\` = VALUES(\`attachments\`), \`body_text\` = VALUES(\`body_text\`),
         \`body_html\` = VALUES(\`body_html\`), \`body_truncated\` = VALUES(\`body_truncated\`),
         \`message_id\` = VALUES(\`message_id\`), \`web_url\` = VALUES(\`web_url\`), \`synced_at\` = VALUES(\`synced_at\`)`,
      [
        accountId,
        m.id,
        m.threadId || '',
        m.folderId || '',
        m.receivedAt,
        fitColumn(m.from?.name, 500),
        fitColumn(m.from?.address, 320),
        toJson({ to: m.to || [], cc: m.cc || [], replyTo: m.replyTo || [] }),
        m.subject || '',
        m.snippet || '',
        toJson(m.labels || []),
        m.inInbox ? 1 : 0,
        m.isRead ? 1 : 0,
        m.isStarred ? 1 : 0,
        toJson(m.attachments || []),
        m.bodyText ?? null,
        m.bodyHtml ?? null,
        m.bodyTruncated ? 1 : 0,
        m.messageId || null,
        m.webUrl || null,
        syncedAt,
      ],
    );
  }
}

// The flags a provider reports changing on a message without resending it.
export async function updateMailMessageFlags(
  accountId,
  id,
  { labels, inInbox, isRead, isStarred },
  syncedAt,
) {
  const p = await pool();
  const [res] = await p.query(
    'UPDATE `mail_messages` SET `labels` = ?, `in_inbox` = ?, `is_read` = ?, `is_starred` = ?, `synced_at` = ?' +
      ' WHERE `account_id` = ? AND `id` = ?',
    [toJson(labels || []), inInbox ? 1 : 0, isRead ? 1 : 0, isStarred ? 1 : 0, syncedAt, accountId, id],
  );
  return res.affectedRows;
}

// Labels renamed at the provider (Gmail's), on every message of the account
// that carries one: the rows keep label names, not the provider's ids. Each
// row's labels are mapped once, so two names swapped in one go do not run
// into each other. The account's `changes` (its sync state, holding the new
// names) land in the same transaction: a pass that failed after the rename
// must not find the old names again and map the rows a second time.
export async function renameMailLabels(accountId, renames, changes) {
  const names = new Map(renames);
  const p = await pool();
  const conn = await p.getConnection();
  try {
    await conn.beginTransaction();
    let rows = [];
    if (names.size)
      [rows] = await conn.query(
        `SELECT \`id\`, \`labels\` FROM \`mail_messages\` WHERE \`account_id\` = ? AND (${[...names.keys()]
          .map(() => 'JSON_CONTAINS(`labels`, JSON_QUOTE(?))')
          .join(' OR ')})`,
        [accountId, ...names.keys()],
      );
    for (const r of rows) {
      const labels = fromJson(r.labels, []).map((l) => (names.has(l) ? names.get(l) : l));
      await conn.query('UPDATE `mail_messages` SET `labels` = ? WHERE `account_id` = ? AND `id` = ?', [
        toJson(labels),
        accountId,
        r.id,
      ]);
    }
    await writeMailAccount(conn, accountId, changes);
    await conn.commit();
    return rows.length;
  } catch (e) {
    await conn.rollback().catch(() => {});
    throw e;
  } finally {
    conn.release();
  }
}

// A folder renamed at the provider (Outlook's), on the messages filed in it:
// their first label is their folder's name.
export async function renameMailFolder(accountId, folderId, name) {
  const p = await pool();
  const [res] = await p.query(
    "UPDATE `mail_messages` SET `labels` = JSON_SET(`labels`, '$[0]', ?)" +
      ' WHERE `account_id` = ? AND `folder_id` = ? AND JSON_LENGTH(`labels`) > 0',
    [name, accountId, folderId],
  );
  return res.affectedRows;
}

// `folderId` deletes a message only while it is still filed there: a move
// between two folders reaches the sync as a removal from one and an addition
// to the other, in either order, and the removal must not undo the addition.
export async function deleteMailMessages(accountId, ids, folderId = null) {
  if (!ids.length) return 0;
  const p = await pool();
  const [res] = await p.query(
    `DELETE FROM \`mail_messages\` WHERE \`account_id\` = ? AND \`id\` IN (?)${folderId == null ? '' : ' AND `folder_id` = ?'}`,
    folderId == null ? [accountId, ids] : [accountId, ids, folderId],
  );
  return res.affectedRows;
}

// What fell out of the account's window.
export async function deleteMailMessagesReceivedBefore(accountId, receivedBefore) {
  const p = await pool();
  const [res] = await p.query('DELETE FROM `mail_messages` WHERE `account_id` = ? AND `received_at` < ?', [
    accountId,
    receivedBefore,
  ]);
  return res.affectedRows;
}

// What a full pass (of the account, or of one folder) did not see again: the
// pass wrote every message it saw at `syncedAt`, so anything older is gone
// from the mailbox.
export async function deleteMailMessagesSyncedBefore(accountId, syncedAt, folderId = null) {
  const p = await pool();
  const [res] = await p.query(
    `DELETE FROM \`mail_messages\` WHERE \`account_id\` = ? AND \`synced_at\` < ?${folderId == null ? '' : ' AND `folder_id` = ?'}`,
    folderId == null ? [accountId, syncedAt] : [accountId, syncedAt, folderId],
  );
  return res.affectedRows;
}

// What is filed in a folder the sync no longer follows (one removed, or one
// it now skips).
export async function deleteMailMessagesOutsideFolders(accountId, folderIds) {
  const p = await pool();
  const [res] = await p.query(
    `DELETE FROM \`mail_messages\` WHERE \`account_id\` = ?${folderIds.length ? ' AND `folder_id` NOT IN (?)' : ''}`,
    folderIds.length ? [accountId, folderIds] : [accountId],
  );
  return res.affectedRows;
}

// Newest first, across the accounts named, after `cursor` (the last row of the
// page before, as `[receivedAt, accountId, id]`). Bodies stay behind: a list
// is for choosing which message to read.
export async function listMailMessages({
  accountIds,
  q,
  unread,
  inbox,
  starred,
  label,
  threadId,
  cursor,
  limit,
}) {
  if (!accountIds.length) return [];
  const p = await pool();
  const where = ['`account_id` IN (?)'];
  const params = [accountIds];
  if (q) {
    const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    where.push('(`subject` LIKE ? OR `from_address` LIKE ? OR `from_name` LIKE ? OR `snippet` LIKE ?)');
    params.push(like, like, like, like);
  }
  if (unread != null) {
    where.push('`is_read` = ?');
    params.push(unread ? 0 : 1);
  }
  if (inbox != null) {
    where.push('`in_inbox` = ?');
    params.push(inbox ? 1 : 0);
  }
  if (starred != null) {
    where.push('`is_starred` = ?');
    params.push(starred ? 1 : 0);
  }
  if (label) {
    where.push('JSON_CONTAINS(`labels`, JSON_QUOTE(?))');
    params.push(label);
  }
  if (threadId) {
    where.push('`thread_id` = ?');
    params.push(threadId);
  }
  if (cursor) {
    where.push('(`received_at`, `account_id`, `id`) < (?, ?, ?)');
    params.push(...cursor);
  }
  const [rows] = await p.query(
    `SELECT ${MAIL_SUMMARY_COLUMNS} FROM \`mail_messages\` WHERE ${where.join(' AND ')}
      ORDER BY \`received_at\` DESC, \`account_id\` DESC, \`id\` DESC LIMIT ?`,
    [...params, limit],
  );
  return rows.map(rowToMailMessage);
}

export async function getMailMessage(accountId, id) {
  const p = await pool();
  const [rows] = await p.query('SELECT * FROM `mail_messages` WHERE `account_id` = ? AND `id` = ?', [
    accountId,
    id,
  ]);
  return rows.length ? rowToMailMessage(rows[0]) : null;
}

export async function countMailMessages() {
  const p = await pool();
  const [rows] = await p.query(
    'SELECT `account_id`, COUNT(*) AS `n`, SUM(`is_read` = 0 AND `in_inbox` = 1) AS `unread` FROM `mail_messages` GROUP BY `account_id`',
  );
  return new Map(
    rows.map((r) => [Number(r.account_id), { messages: Number(r.n), unread: Number(r.unread || 0) }]),
  );
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
  await saveTaskSession(job);
}

export async function saveTaskSession(job) {
  if (job.kind !== 'devchat' || !job.repo) return;
  const p = await pool();
  await p.query(
    'INSERT INTO task_sessions (id, repo, meta, updated_at) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE meta = VALUES(meta), updated_at = VALUES(updated_at)',
    [job.id, job.repo, toJson(taskSnapshot(job)), Date.now()],
  );
}

export async function loadTaskSessions(id) {
  const p = await pool();
  let [owners] = await p.query('SELECT repo FROM task_sessions WHERE id = ?', [id]);
  if (!owners.length) [owners] = await p.query('SELECT repo FROM jobs WHERE id = ?', [id]);
  if (!owners.length) return [];
  const repo = owners[0].repo;
  const [history] = await p.query('SELECT meta FROM task_sessions WHERE repo = ?', [repo]);
  const [current] = await p.query('SELECT meta FROM jobs WHERE repo = ?', [repo]);
  const records = new Map(
    history.map((r) => {
      const m = fromJson(r.meta, {});
      return [m.id, m];
    }),
  );
  for (const row of current) {
    const job = fromJson(row.meta, {});
    if (job.kind === 'devchat') records.set(job.id, taskSnapshot(job));
  }
  return [...records.values()];
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

// Each session's last stored line, to restore counters at boot in one query.
export async function jobEventMaxSeqs() {
  const p = await pool();
  const [rows] = await p.query(
    'SELECT `job_id`, MAX(`seq`) AS `max_seq` FROM `job_events` GROUP BY `job_id`',
  );
  return new Map(rows.map((r) => [r.job_id, Number(r.max_seq)]));
}

export async function loadJobs(limit = 500) {
  const p = await pool();
  // Boot recovery requests all rows so older resource owners cannot be omitted.
  const [rows] =
    limit == null
      ? await p.query('SELECT `meta` FROM `jobs` ORDER BY `created_at` DESC')
      : await p.query('SELECT `meta` FROM `jobs` ORDER BY `created_at` DESC LIMIT ?', [limit]);
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
  await p.query({
    sql: `INSERT INTO \`turn_usage\`
       (\`project_id\`, \`job_id\`, \`repo\`, \`provider\`, \`model\`, \`activity\`, \`account_id\`, \`account_label\`, \`session_title\`, \`input_tokens\`, \`cached_input_tokens\`, \`cache_measured\`, \`output_tokens\`, \`cost_usd\`, \`duration_ms\`, \`at\`, \`long_input_tokens\`, \`long_cached_input_tokens\`, \`long_output_tokens\`)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    values: [
      row.projectId ?? null,
      row.jobId,
      row.repo ?? null,
      row.provider ?? null,
      row.model ?? null,
      row.activity ?? null,
      row.accountId ?? null,
      row.accountLabel ?? null,
      row.sessionTitle ?? null,
      row.inputTokens ?? null,
      row.cachedInputTokens ?? null,
      row.cachedInputTokens != null ? 1 : 0,
      row.outputTokens ?? null,
      row.costUsd ?? null,
      row.durationMs ?? null,
      row.at,
      row.longInputTokens ?? null,
      row.longCachedInputTokens ?? null,
      row.longOutputTokens ?? null,
    ],
    // A usage write must not occupy one of the shared pool's five connections
    // forever. recordTurnUsage also bounds time spent waiting to acquire one.
    timeout: 1000,
  });
}

// One ledger row for lib/usage.js, with DECIMAL and BIGINT (strings from mysql2)
// converted to numbers.
function turnUsageRow(r) {
  return {
    projectId: r.project_id == null ? null : Number(r.project_id),
    jobId: r.job_id,
    repo: r.repo,
    provider: r.provider,
    model: r.model,
    activity: r.activity,
    accountId: r.account_id == null ? null : Number(r.account_id),
    accountLabel: r.account_label,
    sessionTitle: r.session_title,
    inputTokens: r.input_tokens == null ? null : Number(r.input_tokens),
    cachedInputTokens: r.cached_input_tokens == null ? null : Number(r.cached_input_tokens),
    cacheMeasured: r.cache_measured === 1,
    longInputTokens: r.long_input_tokens == null ? null : Number(r.long_input_tokens),
    longCachedInputTokens: r.long_cached_input_tokens == null ? null : Number(r.long_cached_input_tokens),
    longOutputTokens: r.long_output_tokens == null ? null : Number(r.long_output_tokens),
    outputTokens: r.output_tokens == null ? null : Number(r.output_tokens),
    costUsd: r.cost_usd == null ? null : Number(r.cost_usd),
    durationMs: r.duration_ms == null ? null : Number(r.duration_ms),
    at: Number(r.at),
  };
}

const TURN_USAGE_COLUMNS =
  '`project_id`, `job_id`, `repo`, `provider`, `model`, `activity`, `account_id`, `account_label`, `session_title`, `input_tokens`, `cached_input_tokens`, `cache_measured`, `output_tokens`, `cost_usd`, `duration_ms`, `at`, `long_input_tokens`, `long_cached_input_tokens`, `long_output_tokens`';

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

// Every project's turns inside [from, to); a null bound is open ("all time").
// Both `project_id` and `repo` are returned because older turns carry only the repo
// and deleted projects leave ids nothing resolves.
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

// Every turn of the given sessions, with no date window since a session shows its
// lifetime spend; one indexed query instead of one per session.
export async function loadJobTurnUsage(jobIds) {
  const ids = [...new Set((jobIds || []).filter(Boolean))];
  if (!ids.length) return [];
  const p = await pool();
  const [rows] = await p.query(
    `SELECT ${TURN_USAGE_COLUMNS} FROM \`turn_usage\`
      WHERE \`job_id\` IN (?) ORDER BY \`job_id\`, \`at\`, \`id\``,
    [ids],
  );
  return rows.map(turnUsageRow);
}

// The compact lifetime input used to calibrate catalog estimates. The cache
// share is a ratio of sums, so these per-model sums are exactly equivalent to
// handing it every unpriced row that recorded its cache reads, while the
// amount returned stays proportional to the models in use, not to history.
export async function loadTurnUsageCalibration() {
  const p = await pool();
  const [rows] = await p.query(
    `SELECT \`provider\`, \`model\`, SUM(\`input_tokens\`) AS \`input_tokens\`,
            SUM(\`cached_input_tokens\`) AS \`cached_input_tokens\`
       FROM \`turn_usage\`
      WHERE \`cost_usd\` IS NULL AND \`input_tokens\` > 0
        AND \`cache_measured\` = 1 AND \`cached_input_tokens\` IS NOT NULL AND \`cached_input_tokens\` <= \`input_tokens\`
      GROUP BY \`provider\`, \`model\``,
  );
  return rows.map((row) => ({
    provider: row.provider,
    model: row.model,
    inputTokens: Number(row.input_tokens),
    cachedInputTokens: Number(row.cached_input_tokens),
    cacheMeasured: true,
    costUsd: null,
  }));
}

// Deletes a run and its log; its turn_usage rows are project history and stay.
//
// `absorb` adds the run's spend to another job in the same transaction, so a crash
// cannot lose it, and only if the delete removed the row, so a racing delete
// transfers nothing. It goes into the absorbed* fields because a session's own
// figures are rewritten after every turn (probeContextUsage). Measures the run
// never had are skipped so an unpriced cost stays null, not a misleading zero.
/** @type {Array<[keyof AbsorbedUsage, string, string]>} */
const ABSORBED = [
  ['sessions', '$.absorbedSessions', 'UNSIGNED'],
  ['costUsd', '$.absorbedCostUsd', 'DECIMAL(12, 4)'],
  ['estimatedCostUsd', '$.absorbedEstimatedCostUsd', 'DECIMAL(12, 4)'],
  ['estimatedTurns', '$.absorbedEstimatedTurns', 'UNSIGNED'],
  ['unpricedTurns', '$.absorbedUnpricedTurns', 'UNSIGNED'],
  ['inputTokens', '$.absorbedInputTokens', 'UNSIGNED'],
  ['outputTokens', '$.absorbedOutputTokens', 'UNSIGNED'],
  ['durationMs', '$.absorbedDurationMs', 'UNSIGNED'],
];

/**
 * @typedef {{ sessions: number, costUsd: number | null, estimatedCostUsd?: number | null,
 *   estimatedTurns?: number, unpricedTurns?: number, inputTokens: number | null,
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
      // `meta` is what loadJobs restores from. JSON_UNQUOTE(JSON_EXTRACT()) because
      // MariaDB rejects `->>`; NULLIF folds a JSON null ('null') into SQL NULL.
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
