// @ts-check
import { securityPolicyOf } from './review-security.js';
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

// Errors that mean "not listening yet" rather than "wrong": worth waiting out at boot.
// A bad password or a failing migration answers the same on every attempt.
const NOT_YET = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EAI_AGAIN',
  'PROTOCOL_CONNECTION_LOST',
  'ER_SERVER_SHUTDOWN',
]);

// Boot's first connection. After a reboot this server can start before MySQL
// listens, and a boot that gives up restores no sessions, so the ones the
// reboot interrupted would never resume. Waits up to dbBootWaitMs, then
// rethrows so the server still comes up and says what is wrong. Timed on the
// monotonic clock: NTP often steps the wall clock in the minutes after a reboot.
export async function waitForDb({
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  log = console,
} = {}) {
  const deadline = performance.now() + (getConfig().dbBootWaitMs ?? 0);
  for (let delay = 1000; ; delay = Math.min(delay * 2, 10000)) {
    try {
      return await initDb();
    } catch (e) {
      const code = /** @type {any} */ (e)?.code;
      const left = deadline - performance.now();
      if (!NOT_YET.has(code) || left <= 0) throw e;
      log.error(`Database not reachable yet (${code}); retrying for up to ${Math.ceil(left / 1000)}s`);
      await sleep(Math.min(delay, left));
    }
  }
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

// SSH telemetry has its own indexed time series, rather than rewriting an
// app_settings blob every minute. Raw counters stay private to the collector.
export async function saveSshResourceSample(serverId, target, sample) {
  const p = await pool();
  await p.query(
    'INSERT INTO ssh_resource_samples (server_id, target, `at`, payload) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE payload = VALUES(payload)',
    [serverId, target, sample.at, JSON.stringify(sample)],
  );
}

export async function loadSshResourceSamples(serverId, target, since, until) {
  const p = await pool();
  const [rows] = await p.query(
    'SELECT payload FROM ssh_resource_samples WHERE server_id = ? AND target = ? AND `at` >= ? AND `at` <= ? ORDER BY `at` DESC LIMIT 1441',
    [serverId, target, since, until],
  );
  return rows.reverse().map((row) => JSON.parse(row.payload));
}

export async function latestSshResourceSample(serverId, target, since) {
  const p = await pool();
  const [rows] = await p.query(
    'SELECT payload FROM ssh_resource_samples WHERE server_id = ? AND target = ? AND `at` >= ? ORDER BY `at` DESC LIMIT 1',
    [serverId, target, since],
  );
  return rows.length ? JSON.parse(rows[0].payload) : null;
}

export async function pruneSshResourceSamples(before) {
  const p = await pool();
  await p.query('DELETE FROM ssh_resource_samples WHERE `at` < ?', [before]);
}

// Dedicated connections let repositories publish related GitHub rows atomically.
export async function githubStoreConnection() {
  return (await pool()).getConnection();
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
    printToolsEnabled: !!r.print_tools_enabled,
    homeAssistantToolsEnabled: !!r.home_assistant_tools_enabled,
    sortOrder: Number(r.sort_order),
    setupCommands: fromJson(r.setup_commands, []),
    phpBinDir: r.php_bin_dir || '',
    localDir: r.local_dir || '',
    localSessionLimit: r.local_session_limit == null ? 1 : Number(r.local_session_limit),
    autoUpdate: !!r.auto_update,
    updateCommands: fromJson(r.update_commands, []),
    dbPoolDatabase: r.db_pool_database || '',
    databaseBackupEnabled: !!r.database_backup_enabled,
    dbExtensions: fromJson(r.db_extensions, []),
    envTemplate: r.env_template || '',
    runCommands: fromJson(r.run_commands, []),
    runProfiles: r.run_profiles || '',
    reviewRoundLimit: r.review_round_limit == null ? 3 : Number(r.review_round_limit),
    enforceReviewOutcome: !!r.enforce_review_outcome,
    securityReview: r.security_review || 'off',
    approvalPolicy: fromJson(r.approval_policy, null),
    reviewBenchmark: !!r.review_benchmark,
    postReviewToGithub: r.post_review_to_github == null ? true : !!r.post_review_to_github,
    qaTestRun: !!r.qa_test_run,
    qaNotes: r.qa_notes || '',
    testSheetInstructions: r.test_sheet_instructions || '',
    prAuthor: r.pr_author || '',
    actionProviderId: r.action_provider_id == null ? null : Number(r.action_provider_id),
    actionModel: r.action_model || '',
    actionEffort: r.action_effort || '',
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
  'print_tools_enabled',
  'home_assistant_tools_enabled',
  'sort_order',
  'setup_commands',
  'php_bin_dir',
  'local_dir',
  'local_session_limit',
  'auto_update',
  'update_commands',
  'db_pool_database',
  'database_backup_enabled',
  'db_extensions',
  'env_template',
  'run_commands',
  'run_profiles',
  'review_round_limit',
  'enforce_review_outcome',
  'security_review',
  'approval_policy',
  'review_benchmark',
  'post_review_to_github',
  'qa_test_run',
  'qa_notes',
  'test_sheet_instructions',
  'pr_author',
  'action_provider_id',
  'action_model',
  'action_effort',
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
    p.printToolsEnabled === true ? 1 : 0,
    p.homeAssistantToolsEnabled === true ? 1 : 0,
    p.sortOrder || 0,
    toJson(p.setupCommands || []),
    p.phpBinDir || '',
    p.localDir || '',
    p.localSessionLimit ?? 1,
    p.autoUpdate ? 1 : 0,
    toJson(p.updateCommands || []),
    p.dbPoolDatabase || '',
    p.databaseBackupEnabled === true ? 1 : 0,
    toJson(p.dbExtensions || []),
    p.envTemplate || '',
    toJson(p.runCommands || []),
    p.runProfiles || '',
    p.reviewRoundLimit ?? 3,
    p.enforceReviewOutcome === true ? 1 : 0,
    securityPolicyOf(p),
    p.approvalPolicy ? toJson(p.approvalPolicy) : null,
    p.reviewBenchmark === true ? 1 : 0,
    p.postReviewToGithub === false ? 0 : 1,
    p.qaTestRun ? 1 : 0,
    p.qaNotes || '',
    p.testSheetInstructions || '',
    p.prAuthor || '',
    p.actionProviderId || null,
    p.actionModel || '',
    p.actionEffort || '',
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
// nothing is written. fn may be async and receives the locked connection for
// related reads. Scripts with their own pool pass it as `via`.
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
    const result = await fn(value, conn);
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

// ---- users ----
//
// Each takes `via` like updateAppSetting: `npm run users` writes with its own pool.

function rowToUser(r) {
  return {
    id: Number(r.id),
    name: r.name,
    role: r.role,
    createdAt: Number(r.created_at),
    disabledAt: r.disabled_at == null ? null : Number(r.disabled_at),
  };
}

export async function loadUserRows(via = null) {
  const p = via || (await pool());
  const [rows] = await p.query('SELECT * FROM `users` ORDER BY `id`');
  return /** @type {any[]} */ (rows).map(rowToUser);
}

export async function insertUser({ name, role }, via = null) {
  const p = via || (await pool());
  const [res] = await p.query('INSERT INTO `users` (`name`, `role`, `created_at`) VALUES (?, ?, ?)', [
    name,
    role,
    Date.now(),
  ]);
  return /** @type {any} */ (res).insertId;
}

// Only the fields named in `changes` are written.
export async function updateUser(id, changes, via = null) {
  const columns = { name: 'name', role: 'role', disabledAt: 'disabled_at' };
  const keys = Object.keys(changes).filter((k) => k in columns);
  if (!keys.length) return;
  const p = via || (await pool());
  const [res] = await p.query(
    `UPDATE \`users\` SET ${keys.map((k) => `\`${columns[k]}\` = ?`).join(', ')} WHERE \`id\` = ?`,
    [...keys.map((k) => changes[k]), id],
  );
  if (!(/** @type {any} */ (res).affectedRows)) throw new Error(`No user with id ${id}`);
}

// ---- shares ----

export async function loadShareRows(via = null) {
  const p = via || (await pool());
  const [rows] = await p.query(
    'SELECT `kind`, `resource_id`, `user_id` FROM `shares` ORDER BY `kind`, `resource_id`, `user_id`',
  );
  return /** @type {any[]} */ (rows).map((r) => ({
    kind: r.kind,
    id: r.resource_id,
    userId: Number(r.user_id),
  }));
}

// The users one resource is shared with, replaced as a whole so a save cannot interleave
// with another and leave a mix of both.
export async function replaceShares(kind, id, userIds) {
  const p = await pool();
  const conn = await p.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query('DELETE FROM `shares` WHERE `kind` = ? AND `resource_id` = ?', [kind, id]);
    const now = Date.now();
    if (userIds.length)
      await conn.query('INSERT INTO `shares` (`kind`, `resource_id`, `user_id`, `created_at`) VALUES ?', [
        userIds.map((userId) => [kind, id, userId, now]),
      ]);
    await conn.commit();
  } catch (e) {
    await conn.rollback().catch(() => {});
    throw e;
  } finally {
    conn.release();
  }
}

// ---- user credentials ----

export async function loadUserCredentialRows() {
  const p = await pool();
  const [rows] = await p.query('SELECT `user_id`, `kind`, `value` FROM `user_credentials`');
  return /** @type {any[]} */ (rows).map((r) => ({
    userId: Number(r.user_id),
    kind: r.kind,
    value: r.value,
  }));
}

export async function saveUserCredential(userId, kind, value) {
  const p = await pool();
  await p.query(
    'INSERT INTO `user_credentials` (`user_id`, `kind`, `value`, `updated_at`) VALUES (?, ?, ?, ?)' +
      ' ON DUPLICATE KEY UPDATE `value` = VALUES(`value`), `updated_at` = VALUES(`updated_at`)',
    [userId, kind, value, Date.now()],
  );
}

export async function deleteUserCredential(userId, kind) {
  const p = await pool();
  await p.query('DELETE FROM `user_credentials` WHERE `user_id` = ? AND `kind` = ?', [userId, kind]);
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

// Capture only auth, provided the login configuration still matches the snapshot.
export async function saveProviderAuth(provider, authData) {
  const p = await pool();
  await p.query(
    'UPDATE `providers` SET `auth_data` = ?, `updated_at` = ? WHERE `id` = ? AND `binary` = ? AND BINARY `base_url` = ? AND BINARY `api_key` = ? AND BINARY `auth_data` <=> ?',
    [
      toJson(authData),
      Date.now(),
      provider.id,
      provider.binary,
      provider.baseUrl || '',
      provider.apiKey || '',
      provider.authData ? toJson(provider.authData) : null,
    ],
  );
  return getProviderRow(provider.id);
}

// A transaction connection locks the configuration until its usage write commits.
export async function getProviderRow(id, via = null) {
  const p = via || (await pool());
  const [rows] = await p.query(
    'SELECT * FROM `providers` WHERE `id` = ?' + (via ? ' LOCK IN SHARE MODE' : ''),
    [id],
  );
  return rows.length ? rowToProvider(rows[0]) : null;
}

export async function deleteProviderRow(id) {
  const p = await pool();
  const [res] = await p.query('DELETE FROM `providers` WHERE `id` = ?', [id]);
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

// ---- code reviews ----

function rowToCodeReview(r) {
  return {
    id: Number(r.id),
    jobId: r.job_id,
    projectId: r.project_id == null ? null : Number(r.project_id),
    repo: r.repo,
    prNumber: r.pr_number == null ? null : Number(r.pr_number),
    branch: r.branch,
    headSha: r.head_sha || null,
    // The base branch it reviewed against; null on a review from before that was kept.
    baseRef: r.base_ref || null,
    // Which of the pull request's review rounds it ran as, and what that round covered.
    round: r.round == null ? null : Number(r.round),
    scope: r.scope || null,
    scopeReason: r.scope_reason || null,
    scopeBaseSha: r.scope_base_sha || null,
    userId: r.user_id == null ? null : Number(r.user_id),
    providerId: r.provider_id == null ? null : Number(r.provider_id),
    provider: r.provider || '',
    model: r.model || '',
    effort: r.effort || '',
    inputTokens: r.input_tokens == null ? null : Number(r.input_tokens),
    outputTokens: r.output_tokens == null ? null : Number(r.output_tokens),
    costUsd: r.cost_usd == null ? null : Number(r.cost_usd),
    costEstimated: !!r.cost_estimated,
    unpricedTurns: Number(r.unpriced_turns || 0),
    status: r.status,
    handlingStatus: r.handling_status,
    summary: r.summary || null,
    completedAt: iso(r.completed_at),
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
  };
}

// Keyed by session, so a retried insert for the same session is a no-op.
export async function createCodeReview(review) {
  const p = await pool();
  const now = Date.now();
  await p.query(
    `INSERT IGNORE INTO \`code_reviews\`
       (\`job_id\`, \`project_id\`, \`repo\`, \`pr_number\`, \`branch\`, \`user_id\`, \`provider_id\`, \`provider\`, \`model\`, \`effort\`, \`created_at\`, \`updated_at\`)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      review.jobId,
      review.projectId ?? null,
      review.repo,
      review.prNumber || null,
      review.branch,
      review.userId ?? null,
      review.providerId ?? null,
      review.provider || '',
      review.model || '',
      review.effort || '',
      now,
      now,
    ],
  );
  return getCodeReviewByJob(review.jobId);
}

// A session's review is one row, so a discovery run (the first, or a `/review` sent
// again) starts it over on the head it reviews: a rerun's findings, summary and
// outcome must not mix with the previous run's. The records of what its steps did go
// too, in the same transaction: a step the earlier run completed says nothing about
// this one, and with no record at all a review cannot pass (lib/review-outcome.js).
export async function restartCodeReview(jobId, headSha) {
  const p = await pool();
  const conn = await p.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query(
      'DELETE f FROM `code_review_findings` f JOIN `code_reviews` r ON r.`id` = f.`code_review_id` WHERE r.`job_id` = ?',
      [jobId],
    );
    await conn.query(
      'DELETE s FROM `code_review_stages` s JOIN `code_reviews` r ON r.`id` = s.`code_review_id` WHERE r.`job_id` = ?',
      [jobId],
    );
    await conn.query(
      // `round` stays: the claim that precedes this (claimCodeReviewRound) has just named it.
      "UPDATE `code_reviews` SET `head_sha` = ?, `base_ref` = NULL, `scope` = NULL, `scope_reason` = NULL, `scope_base_sha` = NULL, `status` = 'running', `handling_status` = 'pending', `summary` = NULL, `completed_at` = NULL, `updated_at` = ? WHERE `job_id` = ?",
      [headSha, Date.now(), jobId],
    );
    await conn.commit();
  } catch (e) {
    await conn.rollback().catch(() => {});
    throw e;
  } finally {
    conn.release();
  }
}

export async function setCodeReviewUsage(
  jobId,
  { inputTokens, outputTokens, costUsd, costEstimated, unpricedTurns },
) {
  const p = await pool();
  await p.query(
    'UPDATE `code_reviews` SET `input_tokens` = ?, `output_tokens` = ?, `cost_usd` = ?, `cost_estimated` = ?, `unpriced_turns` = ?, `updated_at` = ? WHERE `job_id` = ?',
    [inputTokens, outputTokens, costUsd, costEstimated ? 1 : 0, unpricedTurns || 0, Date.now(), jobId],
  );
}

export async function getCodeReviewByJob(jobId) {
  const p = await pool();
  const [rows] = await p.query('SELECT * FROM `code_reviews` WHERE `job_id` = ?', [jobId]);
  return rows.length ? rowToCodeReview(rows[0]) : null;
}

// A review and the round it ran as are settled together, or not at all: the review row
// names its round (written by the claim), so exactly that round is settled, never
// another the same session once held. Under the review row's lock, so a claim and a
// settle of one session cannot interleave.
async function settleCodeReview(jobId, settle) {
  const p = await pool();
  const conn = await p.getConnection();
  try {
    await conn.beginTransaction();
    const [rows] = await conn.query('SELECT * FROM `code_reviews` WHERE `job_id` = ? FOR UPDATE', [jobId]);
    await settle(conn, rows[0] || null, Date.now());
    await conn.commit();
  } catch (e) {
    await conn.rollback().catch(() => {});
    throw e;
  } finally {
    conn.release();
  }
}

const HELD_ROUND = 'WHERE `repo` = ? AND `pr_number` = ? AND `round` = ? AND `job_id` = ?';
const heldRound = (review, jobId) => [review.repo, review.pr_number, review.round, jobId];

// The review's last step finished, and with it the round it ran as. Whatever the round
// was marked meanwhile, the session that holds it has now reviewed it to the end.
export async function completeCodeReview(jobId) {
  await settleCodeReview(jobId, async (conn, review, now) => {
    await conn.query(
      "UPDATE `code_reviews` SET `status` = 'completed', `completed_at` = ?, `updated_at` = ? WHERE `job_id` = ?",
      [now, now, jobId],
    );
    if (review?.round != null)
      await conn.query(
        `UPDATE \`code_review_rounds\` SET \`status\` = 'completed', \`reviewed_at\` = ?, \`updated_at\` = ? ${HELD_ROUND}`,
        [now, now, ...heldRound(review, jobId)],
      );
    // No review row to name the round (its insert was lost): the round this session
    // is running is the one it finished.
    else if (!review)
      await conn.query(
        "UPDATE `code_review_rounds` SET `status` = 'completed', `reviewed_at` = ?, `updated_at` = ? WHERE `job_id` = ? AND `status` = 'running'",
        [now, now, jobId],
      );
  });
}

export async function setCodeReviewSummary(jobId, summary) {
  const p = await pool();
  await p.query('UPDATE `code_reviews` SET `summary` = ?, `updated_at` = ? WHERE `job_id` = ?', [
    summary,
    Date.now(),
    jobId,
  ]);
}

// Only a review still running fails: a later chat turn going wrong does not undo
// one that already published. Its round fails with it and keeps its place in the count:
// only the attempt failed. A round another session has taken up since is that
// session's to settle.
export async function failCodeReview(jobId) {
  await settleCodeReview(jobId, async (conn, review, now) => {
    if (!review) {
      // No review row to name the round (its insert was lost): whatever this session
      // still holds as running is what failed.
      await conn.query(
        "UPDATE `code_review_rounds` SET `status` = 'failed', `updated_at` = ? WHERE `job_id` = ? AND `status` = 'running'",
        [now, jobId],
      );
      return;
    }
    if (review.status !== 'running') return;
    await conn.query(
      "UPDATE `code_reviews` SET `status` = 'failed', `completed_at` = ?, `updated_at` = ? WHERE `job_id` = ?",
      [now, now, jobId],
    );
    if (review.round != null)
      await conn.query(
        `UPDATE \`code_review_rounds\` SET \`status\` = 'failed', \`updated_at\` = ? ${HELD_ROUND} AND \`status\` = 'running'`,
        [now, ...heldRound(review, jobId)],
      );
  });
}

function rowToCodeReviewFinding(r) {
  return {
    id: Number(r.id),
    codeReviewId: Number(r.code_review_id),
    severity: r.severity,
    type: r.type || '',
    // Part of the review's security result (lib/review-security.js). The server's mark,
    // unlike `type`, which is what the agent calls the defect.
    security: !!r.security,
    // Which finding of the security pass's record it publishes (its id in the coverage
    // kept with the pass's stage); null for a security finding the record does not hold.
    securityEntry: r.security_entry == null ? null : Number(r.security_entry),
    shouldFix: r.should_fix || null,
    verification: r.verification || null,
    title: r.title,
    body: r.body ?? null,
    filePath: r.file_path ?? null,
    startLine: r.start_line == null ? null : Number(r.start_line),
    endLine: r.end_line == null ? null : Number(r.end_line),
    comments: r.comments ?? null,
    findingRef: r.finding_ref ?? null,
    reconciliation: r.reconciliation || 'new',
    commentId: r.comment_id == null ? null : Number(r.comment_id),
    threadId: r.thread_id ?? null,
    headSha: r.head_sha ?? null,
    priorThreadId: r.prior_thread_id ?? null,
    priorDisposition: r.prior_disposition ?? null,
    priorReason: r.prior_reason ?? null,
    priorUrl: r.prior_url ?? null,
    revisitReason: r.revisit_reason ?? null,
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
  };
}

const FINDING_COLUMNS = {
  severity: 'severity',
  type: 'type',
  security: 'security',
  securityEntry: 'security_entry',
  shouldFix: 'should_fix',
  verification: 'verification',
  title: 'title',
  body: 'body',
  filePath: 'file_path',
  startLine: 'start_line',
  endLine: 'end_line',
  comments: 'comments',
  // How the finding relates to the PR's earlier threads (lib/review-history.js). Only
  // the server sets these, from what lib/code-reviews.js checked against that history.
  findingRef: 'finding_ref',
  reconciliation: 'reconciliation',
  commentId: 'comment_id',
  threadId: 'thread_id',
  headSha: 'head_sha',
  priorThreadId: 'prior_thread_id',
  priorDisposition: 'prior_disposition',
  priorReason: 'prior_reason',
  priorUrl: 'prior_url',
  revisitReason: 'revisit_reason',
};

export async function listCodeReviewFindings(codeReviewId) {
  const p = await pool();
  const [rows] = await p.query(
    'SELECT * FROM `code_review_findings` WHERE `code_review_id` = ? ORDER BY `id`',
    [codeReviewId],
  );
  return rows.map(rowToCodeReviewFinding);
}

export async function getCodeReviewFinding(codeReviewId, id) {
  return findingRow(await pool(), codeReviewId, id);
}

export async function getPullCodeReview(repo, prNumber, id) {
  const p = await pool();
  const [rows] = await p.query(
    'SELECT * FROM `code_reviews` WHERE `repo` = ? AND `pr_number` = ? AND `id` = ?',
    [repo, prNumber, id],
  );
  return rows.length ? rowToCodeReview(rows[0]) : null;
}

// A client's explicit decision; a `fix` verdict alone does not prove a fix was made.
export async function setPullCodeReviewHandlingStatus(repo, prNumber, id, handlingStatus) {
  const p = await pool();
  await p.query(
    'UPDATE `code_reviews` SET `handling_status` = ?, `updated_at` = ? WHERE `repo` = ? AND `pr_number` = ? AND `id` = ?',
    [handlingStatus, Date.now(), repo, prNumber, id],
  );
  return getPullCodeReview(repo, prNumber, id);
}

// A pull request's latest reviews, newest first, each carrying its findings. Two
// queries rather than a join, so a review's columns are not repeated per finding.
// `completed` keeps only reviews that finished, leaving out a queued, running or
// refused session's row, which holds no findings of its own.
export async function listPullCodeReviews(repo, prNumber, limit, { completed = false } = {}) {
  const p = await pool();
  const [rows] = await p.query(
    `SELECT * FROM \`code_reviews\` WHERE \`repo\` = ? AND \`pr_number\` = ?${completed ? " AND `status` = 'completed'" : ''} ORDER BY \`created_at\` DESC, \`id\` DESC LIMIT ?`,
    [repo, prNumber, limit],
  );
  const reviews = rows.map((r) => ({ ...rowToCodeReview(r), findings: [], stages: [] }));
  if (!reviews.length) return reviews;
  const byId = new Map(reviews.map((r) => [r.id, r]));
  const [found] = await p.query(
    'SELECT * FROM `code_review_findings` WHERE `code_review_id` IN (?) ORDER BY `id`',
    [[...byId.keys()]],
  );
  for (const f of found.map(rowToCodeReviewFinding)) byId.get(f.codeReviewId)?.findings.push(f);
  const [stages] = await p.query(
    'SELECT * FROM `code_review_stages` WHERE `code_review_id` IN (?) ORDER BY `id`',
    [[...byId.keys()]],
  );
  for (const s of stages.map(rowToCodeReviewStage)) byId.get(s.codeReviewId)?.stages.push(s);
  return reviews;
}

// A finding's verdict is also the pull request's decision on its claim. When `decide`
// is given the finding and that decision are written in one transaction, with the
// finding's row locked, so two writers (a client and the review's own verification)
// cannot leave the finding saying one thing and the decision another.
// `decide.build(finding, previous)` returns the decision row, or null for none.
// `decide.outcomeStale` also marks the pull request's outcome as owing a recomputation,
// in that transaction: the write and the mark land together, so a change to the evidence
// is never stored without the outcome knowing it is out of date (lib/review-enforcement.js
// computes it again at once, and its sweep does if that never happens).
async function writeFinding(decide, write) {
  const p = await pool();
  if (!decide) return write(p, null);
  const conn = await p.getConnection();
  try {
    await conn.beginTransaction();
    const finding = await write(conn, async (updated, previous) => {
      const decision = decide.build(updated, previous);
      if (decision) await upsertCodeReviewDecision(conn, decide.repo, decide.prNumber, decision, Date.now());
    });
    if (finding && decide.outcomeStale) await markOutcomeStale(conn, decide.repo, decide.prNumber);
    await conn.commit();
    return finding;
  } catch (e) {
    await conn.rollback().catch(() => {});
    throw e;
  } finally {
    conn.release();
  }
}

async function findingRow(conn, codeReviewId, id, lock = '') {
  const [rows] = await conn.query(
    `SELECT * FROM \`code_review_findings\` WHERE \`code_review_id\` = ? AND \`id\` = ?${lock}`,
    [codeReviewId, id],
  );
  return rows.length ? rowToCodeReviewFinding(rows[0]) : null;
}

// `finding` holds validated fields only (lib/code-reviews.js); the keys pick the columns.
export function addCodeReviewFinding(codeReviewId, finding, decide = null) {
  return writeFinding(decide, async (conn, decided) => {
    const now = Date.now();
    const keys = Object.keys(finding).filter((k) => k in FINDING_COLUMNS);
    const [res] = await conn.query(
      `INSERT INTO \`code_review_findings\` (\`code_review_id\`, ${keys.map((k) => `\`${FINDING_COLUMNS[k]}\``).join(', ')}, \`created_at\`, \`updated_at\`)
     VALUES (?, ${keys.map(() => '?').join(', ')}, ?, ?)`,
      [codeReviewId, ...keys.map((k) => finding[k]), now, now],
    );
    const added = await findingRow(conn, codeReviewId, res.insertId);
    if (decided) await decided(added, null);
    return added;
  });
}

// Scoped to the review, so a session can never touch another review's finding.
export function updateCodeReviewFinding(codeReviewId, id, changes, decide = null) {
  return writeFinding(decide, async (conn, decided) => {
    const previous = decided ? await findingRow(conn, codeReviewId, id, ' FOR UPDATE') : null;
    if (decided && !previous) return null;
    const keys = Object.keys(changes).filter((k) => k in FINDING_COLUMNS);
    if (keys.length) {
      const sets = keys.map((k) => `\`${FINDING_COLUMNS[k]}\` = ?`).join(', ');
      await conn.query(
        `UPDATE \`code_review_findings\` SET ${sets}, \`updated_at\` = ? WHERE \`code_review_id\` = ? AND \`id\` = ?`,
        [...keys.map((k) => changes[k]), Date.now(), codeReviewId, id],
      );
    }
    const updated = await findingRow(conn, codeReviewId, id);
    if (decided && updated) await decided(updated, previous);
    return updated;
  });
}

// What a pull request's reviews decided about each claim, one row per GitHub review
// thread (or per finding that had no thread). Kept per PR, not per review, so a rerun
// that deletes a review's findings, a deleted session and a later review all still see
// them (lib/review-history.js reads and refreshes them).
function rowToCodeReviewDecision(r) {
  return {
    id: Number(r.id),
    repo: r.repo,
    prNumber: Number(r.pr_number),
    anchor: r.anchor,
    threadId: r.thread_id ?? null,
    commentId: r.comment_id == null ? null : Number(r.comment_id),
    findingRef: r.finding_ref,
    findingId: r.finding_id == null ? null : Number(r.finding_id),
    title: r.title ?? null,
    filePath: r.file_path ?? null,
    line: r.line == null ? null : Number(r.line),
    verdict: r.verdict || null,
    rationale: r.rationale ?? null,
    // How well the verdict was established when it was recorded. Null when nobody
    // recorded that: a verdict read from GitHub's history, or one stored before this was
    // kept, which therefore does not count as verified (lib/review-outcome.js).
    verification: r.verification || null,
    // Whether the claim is a security one: marked by a finding of a security pass, and
    // kept from then on, so later rounds know what a fix still owed or a dismissal was.
    security: !!r.security,
    source: r.source || null,
    decidedBy: r.decided_by ?? null,
    headSha: r.head_sha ?? null,
    raisedSha: r.raised_sha ?? null,
    resolved: !!r.resolved,
    resolvedBefore: !!r.resolved_before,
    decidedAt: iso(r.decided_at),
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
  };
}

export async function listCodeReviewDecisions(repo, prNumber) {
  const p = await pool();
  const [rows] = await p.query(
    'SELECT * FROM `code_review_decisions` WHERE `repo` = ? AND `pr_number` = ? ORDER BY `id`',
    [repo, prNumber],
  );
  return rows.map(rowToCodeReviewDecision);
}

export async function getCodeReviewDecision(repo, prNumber, id) {
  const p = await pool();
  const [rows] = await p.query(
    'SELECT * FROM `code_review_decisions` WHERE `repo` = ? AND `pr_number` = ? AND `id` = ?',
    [repo, prNumber, id],
  );
  return rows.length ? rowToCodeReviewDecision(rows[0]) : null;
}

// When this server began storing decisions: the moment the table arrived. A verdict
// reply written on GitHub before then is history to honour; since then a verdict is
// whatever was stored here, and GitHub text decides nothing (lib/review-history.js).
// Null without the record, which the caller reads as "no reply counts".
export async function codeReviewDecisionsSince() {
  const p = await pool();
  const [rows] = await p.query('SELECT `ran_at` FROM `migrations` WHERE `migration` = ?', [
    '2026_11_10_120000_add_code_review_decisions',
  ]);
  return rows.length ? Number(rows[0].ran_at) : null;
}

// One decision row, written under its row lock: the locked read says what stands, and
// the rules are applied here where they can be read. The insert takes that lock even
// when the row is already there (a plain INSERT IGNORE would take a shared one, and
// two writers upgrading it would deadlock each other).
//
// What a row describes (its thread, comment, title, place, that it is a security claim)
// is filled in and never blanked, and its reference is kept once given, since later
// reviews carry it.
// A row carries a verdict to record only with `decidedAt`. Which verdict stands:
// - one the server itself was given (a review's verification, a client) always
//   replaces what was only read from GitHub, and among themselves the later one stands;
// - one read from GitHub (`source` github) is only ever history: it never lands on a
//   decision the server was given, cleared ones included.
// `rationaleOnly` rewords the reason of the decision a finding already gave, and brings
// its verification up to date when the row carries one, and only while that decision is
// still the one standing.
// A verdict is stored with the verification recorded for it, or with none: what was not
// recorded is not assumed.
async function upsertCodeReviewDecision(conn, repo, prNumber, d, now) {
  if (!d.anchor || !d.findingRef) throw new Error('A code review decision needs its anchor and reference');
  const key = [repo, prNumber, d.anchor];
  const where = 'WHERE `repo` = ? AND `pr_number` = ? AND `anchor` = ?';
  if (d.rationaleOnly) {
    const evidence = 'verification' in d ? ', `verification` = ?' : '';
    await conn.query(
      `UPDATE \`code_review_decisions\` SET \`rationale\` = ?${evidence}, \`updated_at\` = ? ${where} AND \`finding_id\` = ?`,
      [d.rationale ?? null, ...(evidence ? [d.verification ?? null] : []), now, ...key, d.findingId],
    );
    return;
  }
  await conn.query(
    'INSERT INTO `code_review_decisions` (`repo`, `pr_number`, `anchor`, `finding_ref`, `created_at`, `updated_at`) VALUES (?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE `id` = `id`',
    [...key, d.findingRef, now, now],
  );
  const [rows] = await conn.query(`SELECT * FROM \`code_review_decisions\` ${where} FOR UPDATE`, key);
  const row = rows[0];
  /** @type {Record<string, any>} */
  const sets = { updated_at: now };
  for (const [column, value] of [
    ['thread_id', d.threadId],
    ['comment_id', d.commentId],
    ['title', d.title],
    ['file_path', d.filePath],
    ['line', d.line],
  ])
    if (value != null) sets[column] = value;
  if (d.raisedSha != null && row.raised_sha == null) sets.raised_sha = d.raisedSha;
  // Set by a security finding and never taken back: what the claim is does not change
  // with who rules on it later.
  if (d.security) sets.security = 1;
  const resolved = d.resolved == null ? !!row.resolved : !!d.resolved;
  if (d.resolved != null) sets.resolved = resolved ? 1 : 0;
  if (d.decidedAt != null) {
    // Nothing decided here yet, or only what was read from GitHub.
    const history = row.source == null || row.source === 'github';
    const later = row.decided_at == null || d.decidedAt >= Number(row.decided_at);
    if (d.source === 'github' ? history && later : history || later) {
      // Whether the thread was closed before this verdict, so not because of it: it was
      // resolved already, or the dismissal this verdict overturns (directly or through
      // verdicts given since) is what resolved it. The same verdict given again keeps
      // the answer from when it was first given.
      const restated = !history && row.verdict != null && row.verdict === (d.verdict ?? null);
      Object.assign(sets, {
        verdict: d.verdict ?? null,
        rationale: d.rationale ?? null,
        verification: d.verdict ? (d.verification ?? null) : null,
        source: d.source ?? null,
        decided_by: d.decidedBy ?? null,
        head_sha: d.headSha ?? null,
        finding_id: d.findingId ?? null,
        decided_at: d.decidedAt,
        resolved_before: restated
          ? row.resolved_before
          : (d.resolvedBefore ?? (resolved || row.verdict === 'dismiss' || !!row.resolved_before))
            ? 1
            : 0,
      });
    }
  }
  await conn.query('UPDATE `code_review_decisions` SET ? WHERE `id` = ?', [sets, row.id]);
}

// `decisions` are rows as lib/review-history.js builds them: `anchor` and `findingRef`
// always, `decidedAt` (epoch millis) only when the row carries a verdict to record.
// All or nothing, so a review never reads half of what an earlier one refreshed; in
// anchor order, so two batches for one pull request take their row locks the same way.
// `outcomeStale` marks the PR's outcome as owing a recomputation with them (writeFinding).
export async function saveCodeReviewDecisions(repo, prNumber, decisions, { outcomeStale = false } = {}) {
  if (!decisions.length) return;
  const p = await pool();
  const conn = await p.getConnection();
  try {
    await conn.beginTransaction();
    const now = Date.now();
    const ordered = [...decisions].sort((a, b) => (a.anchor < b.anchor ? -1 : a.anchor > b.anchor ? 1 : 0));
    for (const d of ordered) await upsertCodeReviewDecision(conn, repo, prNumber, d, now);
    if (outcomeStale) await markOutcomeStale(conn, repo, prNumber);
    await conn.commit();
  } catch (e) {
    await conn.rollback().catch(() => {});
    throw e;
  } finally {
    conn.release();
  }
}

// ---- code review rounds ----
//
// How many review rounds a pull request has used and what each one reviewed
// (lib/review-rounds.js holds the rules). Kept per PR and tied to no session or review
// row, so the count outlives both.

function rowToCodeReviewRound(r) {
  return {
    id: Number(r.id),
    repo: r.repo,
    prNumber: Number(r.pr_number),
    round: Number(r.round),
    headSha: r.head_sha,
    baseRef: r.base_ref,
    baseSha: r.base_sha ?? null,
    mergeBaseSha: r.merge_base_sha ?? null,
    status: r.status,
    jobId: r.job_id ?? null,
    attempts: Number(r.attempts),
    source: r.source,
    requestedBy: r.requested_by ?? null,
    continuedBy: r.continued_by ?? null,
    continuedAt: iso(r.continued_at),
    scope: r.scope || null,
    scopeReason: r.scope_reason || null,
    scopeBaseSha: r.scope_base_sha ?? null,
    publishedAt: iso(r.published_at),
    reviewedAt: iso(r.reviewed_at),
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
  };
}

function rowToCodeReviewRoundCount(r) {
  return {
    repo: r.repo,
    prNumber: Number(r.pr_number),
    rounds: Number(r.rounds),
    continuations: Number(r.continuations),
    refusedAt: iso(r.refused_at),
    refusedHeadSha: r.refused_head_sha ?? null,
    refusedSource: r.refused_source ?? null,
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
  };
}

async function roundRows(conn, repo, prNumber) {
  const [rows] = await conn.query(
    'SELECT * FROM `code_review_rounds` WHERE `repo` = ? AND `pr_number` = ? ORDER BY `round`',
    [repo, prNumber],
  );
  return rows.map(rowToCodeReviewRound);
}

// Ask for the round a review of one revision runs as, under the pull request's count
// row lock: every claim for a PR waits its turn there, so two starters can never both
// take the last round, and the same revision always gets the same answer. The insert
// takes that lock even when the row is already there (see upsertCodeReviewDecision).
//
// `decide({ count, rounds })` holds the rules (decideRound in lib/review-rounds.js) and
// answers with what to do: `create` a round, `reuse` the one this revision already has,
// `takeover` one that never reviewed anything, or `refuse`. With `admitOnly` nothing is
// claimed: the answer says what a claim would get, and only a refusal at the limit is
// recorded, as what now waits on a person. A claim also names the round on the
// session's review row and fails the rounds `decide` reports as left running (`stale`).
export async function claimCodeReviewRound(request, decide) {
  const { repo, prNumber, headSha, baseRef, source, requestedBy = null, jobId = null } = request;
  const p = await pool();
  const conn = await p.getConnection();
  try {
    await conn.beginTransaction();
    const now = Date.now();
    const key = [repo, prNumber];
    const where = 'WHERE `repo` = ? AND `pr_number` = ?';
    // The session's review row first, as a settle takes it (settleCodeReview): the two
    // then lock in the same order and cannot deadlock each other.
    if (jobId && !request.admitOnly)
      await conn.query('SELECT `id` FROM `code_reviews` WHERE `job_id` = ? FOR UPDATE', [jobId]);
    await conn.query(
      'INSERT INTO `code_review_round_counts` (`repo`, `pr_number`, `created_at`, `updated_at`) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE `pr_number` = `pr_number`',
      [...key, now, now],
    );
    const [counts] = await conn.query(`SELECT * FROM \`code_review_round_counts\` ${where} FOR UPDATE`, key);
    const count = rowToCodeReviewRoundCount(counts[0]);
    const rounds = await roundRows(conn, repo, prNumber);
    const decision = decide({ count, rounds });
    let roundId = decision.round?.id ?? null;
    // What a session's own claim took: null for a refusal and for a question.
    const claimed = decision.action === 'refuse' || request.admitOnly ? null : decision.action;
    let created = null;
    if (decision.action === 'refuse') {
      if (decision.reason === 'limit')
        await conn.query(
          `UPDATE \`code_review_round_counts\` SET \`refused_at\` = COALESCE(\`refused_at\`, ?), \`refused_head_sha\` = ?, \`refused_source\` = ?, \`updated_at\` = ? ${where}`,
          [now, headSha || null, source, now, ...key],
        );
    } else if (request.admitOnly) {
      // Nothing to write: the session claims for itself once it knows what it checked out.
    } else if (decision.action === 'create') {
      // The count is the highest round number, whatever a hand-edited row says.
      const number = Math.max(count.rounds, ...rounds.map((r) => r.round)) + 1;
      const continuedBy = decision.continued ? requestedBy || source : null;
      const [res] = await conn.query(
        `INSERT INTO \`code_review_rounds\`
           (\`repo\`, \`pr_number\`, \`round\`, \`head_sha\`, \`base_ref\`, \`job_id\`, \`source\`, \`requested_by\`, \`continued_by\`, \`continued_at\`, \`created_at\`, \`updated_at\`)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          ...key,
          number,
          headSha,
          baseRef,
          jobId,
          source,
          requestedBy,
          continuedBy,
          continuedBy ? now : null,
          now,
          now,
        ],
      );
      roundId = res.insertId;
      created = number;
      await conn.query(
        `UPDATE \`code_review_round_counts\` SET \`rounds\` = ?, \`continuations\` = \`continuations\` + ?, \`refused_at\` = NULL, \`refused_head_sha\` = NULL, \`refused_source\` = NULL, \`updated_at\` = ? ${where}`,
        [number, continuedBy ? 1 : 0, now, ...key],
      );
    } else if (decision.action === 'takeover') {
      // The round keeps its number and whoever granted it; everything about the
      // revision it never reviewed is replaced.
      await conn.query(
        "UPDATE `code_review_rounds` SET `head_sha` = ?, `base_ref` = ?, `base_sha` = NULL, `merge_base_sha` = NULL, `status` = 'running', `job_id` = ?, `attempts` = `attempts` + 1, `source` = ?, `requested_by` = ?, `scope` = NULL, `scope_reason` = NULL, `scope_base_sha` = NULL, `updated_at` = ? WHERE `id` = ?",
        [headSha, baseRef, jobId, source, requestedBy, now, roundId],
      );
    } else {
      await conn.query(
        "UPDATE `code_review_rounds` SET `status` = 'running', `job_id` = ?, `attempts` = `attempts` + 1, `updated_at` = ? WHERE `id` = ?",
        [jobId, now, roundId],
      );
    }
    if (claimed) {
      // The review row names the round it holds from here on, which is how the two are
      // settled together (settleCodeReview).
      await conn.query('UPDATE `code_reviews` SET `round` = ?, `updated_at` = ? WHERE `job_id` = ?', [
        created ?? rounds.find((r) => r.id === roundId).round,
        now,
        jobId,
      ]);
      // Rounds whose settling write never landed: still running for a session that
      // is gone, or that has moved on to this round. Only the attempt is failed.
      const stale = (decision.stale || []).filter((id) => id !== roundId);
      if (stale.length)
        await conn.query(
          "UPDATE `code_review_rounds` SET `status` = 'failed', `updated_at` = ? WHERE `id` IN (?) AND `status` = 'running'",
          [now, stale],
        );
    }
    const [after] = await conn.query(`SELECT * FROM \`code_review_round_counts\` ${where}`, key);
    const stored = await roundRows(conn, repo, prNumber);
    await conn.commit();
    return {
      decision: { action: decision.action, reason: decision.reason ?? null, continued: !!decision.continued },
      count: rowToCodeReviewRoundCount(after[0]),
      rounds: stored,
      round: stored.find((r) => r.id === roundId) || null,
    };
  } catch (e) {
    await conn.rollback().catch(() => {});
    throw e;
  } finally {
    conn.release();
  }
}

// What the round covers and the base it was computed against, on the round and on the
// review row of the session running it. Only that session's round is written: one
// another session has taken up since is no longer this one's to describe.
export async function setCodeReviewRoundScope(jobId, roundId, details) {
  const p = await pool();
  const now = Date.now();
  const scope = [details.scope ?? null, details.scopeReason ?? null, details.scopeBaseSha ?? null];
  const [res] = await p.query(
    'UPDATE `code_review_rounds` SET `scope` = ?, `scope_reason` = ?, `scope_base_sha` = ?, `base_sha` = ?, `merge_base_sha` = ?, `updated_at` = ? WHERE `id` = ? AND `job_id` = ?',
    [...scope, details.baseSha ?? null, details.mergeBaseSha ?? null, now, roundId, jobId],
  );
  if (!res.affectedRows) throw new Error('This session no longer holds its code review round');
  await p.query(
    'UPDATE `code_reviews` SET `round` = ?, `scope` = ?, `scope_reason` = ?, `scope_base_sha` = ?, `updated_at` = ? WHERE `job_id` = ?',
    [details.round ?? null, ...scope, now, jobId],
  );
}

// From here on the round's findings may be on GitHub, so it is a review somebody
// received: it can no longer be handed to another revision. Kept from its first time.
// By id and holder, so nothing but the round the session holds is marked.
export async function markCodeReviewRoundPublished(jobId, roundId) {
  const p = await pool();
  const now = Date.now();
  const [res] = await p.query(
    'UPDATE `code_review_rounds` SET `published_at` = COALESCE(`published_at`, ?), `updated_at` = ? WHERE `id` = ? AND `job_id` = ?',
    [now, now, roundId, jobId],
  );
  return res.affectedRows > 0;
}

export async function getCodeReviewRounds(repo, prNumber) {
  const p = await pool();
  const [counts] = await p.query(
    'SELECT * FROM `code_review_round_counts` WHERE `repo` = ? AND `pr_number` = ?',
    [repo, prNumber],
  );
  return {
    count: counts.length ? rowToCodeReviewRoundCount(counts[0]) : null,
    rounds: await roundRows(p, repo, prNumber),
  };
}

// The pull requests a review was refused for at the limit and no round has started on
// since, latest first: what waits on a person (lib/attention.js). `repos` narrows it
// before the limit, so other repositories' refusals cannot crowd a scoped reader out.
export async function listRefusedCodeReviewRounds({ repos = null, limit = 200 } = {}) {
  if (repos && !repos.length) return [];
  const p = await pool();
  const [rows] = await p.query(
    `SELECT * FROM \`code_review_round_counts\` WHERE \`refused_at\` IS NOT NULL${repos ? ' AND `repo` IN (?)' : ''} ORDER BY \`refused_at\` DESC LIMIT ?`,
    repos ? [repos, limit] : [limit],
  );
  return rows.map(rowToCodeReviewRoundCount);
}

// ---- code review stages and outcomes ----

// What the server saw each step of a review do, and what the pull request's review
// amounts to (lib/review-outcome.js holds the rules, lib/review-enforcement.js the
// reading and the publication). A stage row is a fact the server observed, bound to the
// head the step ran on; the outcome row is per pull request, like the decisions and the
// rounds, and also keeps what GitHub was last told.

function rowToCodeReviewStage(r) {
  return {
    codeReviewId: Number(r.code_review_id),
    stage: r.stage,
    headSha: r.head_sha,
    status: r.status,
    detail: fromJson(r.detail, null),
    startedAt: iso(r.started_at),
    endedAt: iso(r.ended_at),
  };
}

/**
 * Start a review's stage records over for the discovery run that begins: one row per
 * stage it must complete, for the head and the base branch it reviews, the first of them
 * running. Resolves with the review's id, or null when the session has no review row
 * (its insert was lost): such a review keeps no record and so cannot pass.
 * `prNumber` is the pull request discovery verified its checkout against. A review row
 * created before its session knew its pull request has none, and learns it here: the
 * outcome, the decisions and the reads are all kept per pull request.
 * @param {string} jobId @param {{ headSha: string, baseRef: string, stages: string[], prNumber?: number | null }} run
 */
export async function beginCodeReviewStages(jobId, { headSha, baseRef, stages, prNumber = null }) {
  const p = await pool();
  const conn = await p.getConnection();
  try {
    await conn.beginTransaction();
    const [rows] = await conn.query('SELECT `id` FROM `code_reviews` WHERE `job_id` = ? FOR UPDATE', [jobId]);
    if (!rows.length) {
      await conn.rollback();
      return null;
    }
    const reviewId = Number(rows[0].id);
    const now = Date.now();
    await conn.query('DELETE FROM `code_review_stages` WHERE `code_review_id` = ?', [reviewId]);
    await conn.query(
      'INSERT INTO `code_review_stages` (`code_review_id`, `stage`, `head_sha`, `status`, `started_at`, `created_at`, `updated_at`) VALUES ?',
      [
        stages.map((stage, i) => [
          reviewId,
          stage,
          headSha,
          i === 0 ? 'running' : 'pending',
          i === 0 ? now : null,
          now,
          now,
        ]),
      ],
    );
    await conn.query(
      'UPDATE `code_reviews` SET `base_ref` = ?, `pr_number` = COALESCE(`pr_number`, ?), `updated_at` = ? WHERE `id` = ?',
      [baseRef, prNumber, now, reviewId],
    );
    await conn.commit();
    return reviewId;
  } catch (e) {
    await conn.rollback().catch(() => {});
    throw e;
  } finally {
    conn.release();
  }
}

/**
 * Record what the server saw a stage do. Only for the head the review now holds: a late
 * write from a run on an earlier head marks nothing. `started_at` keeps the first start,
 * so a recovered stage is still dated from when it first ran. Resolves false when there
 * was no such row to mark.
 * @param {string} jobId @param {string} stage @param {string} headSha
 * @param {{ status: 'running' | 'completed' | 'failed', detail?: object | null }} seen
 */
export async function setCodeReviewStage(jobId, stage, headSha, { status, detail }) {
  const p = await pool();
  const now = Date.now();
  const ended = status === 'running' ? null : now;
  const [res] = await p.query(
    `UPDATE \`code_review_stages\` s JOIN \`code_reviews\` r ON r.\`id\` = s.\`code_review_id\`
       SET s.\`status\` = ?, s.\`started_at\` = COALESCE(s.\`started_at\`, ?), s.\`ended_at\` = ?, s.\`detail\` = ?, s.\`updated_at\` = ?
     WHERE r.\`job_id\` = ? AND r.\`head_sha\` = ? AND s.\`stage\` = ? AND s.\`head_sha\` = ?`,
    [status, now, ended, detail == null ? null : toJson(detail), now, jobId, headSha, stage, headSha],
  );
  return res.affectedRows > 0;
}

// The review's run on this head stopped: whatever stage of it was under way failed,
// with why. Like setCodeReviewStage, it marks nothing of a run on another head.
export async function failRunningCodeReviewStages(jobId, headSha, detail) {
  const p = await pool();
  const now = Date.now();
  await p.query(
    `UPDATE \`code_review_stages\` s JOIN \`code_reviews\` r ON r.\`id\` = s.\`code_review_id\`
       SET s.\`status\` = 'failed', s.\`ended_at\` = ?, s.\`detail\` = ?, s.\`updated_at\` = ?
     WHERE r.\`job_id\` = ? AND s.\`head_sha\` = ? AND s.\`status\` = 'running'`,
    [now, toJson(detail), now, jobId, headSha],
  );
}

export async function listCodeReviewStages(codeReviewId) {
  const p = await pool();
  const [rows] = await p.query(
    'SELECT * FROM `code_review_stages` WHERE `code_review_id` = ? ORDER BY `id`',
    [codeReviewId],
  );
  return rows.map(rowToCodeReviewStage);
}

function rowToCodeReviewOutcome(r) {
  return {
    repo: r.repo,
    prNumber: Number(r.pr_number),
    codeReviewId: r.code_review_id == null ? null : Number(r.code_review_id),
    headSha: r.head_sha ?? null,
    baseRef: r.base_ref ?? null,
    outcome: r.outcome,
    stale: !!r.stale,
    reasons: fromJson(r.reasons, []),
    computedAt: iso(r.computed_at),
    statusState: r.status_state ?? null,
    statusDescription: r.status_description ?? null,
    publishedSha: r.published_sha ?? null,
    publishedState: r.published_state ?? null,
    publishedDescription: r.published_description ?? null,
    // Whether GitHub is known to carry exactly that: false from the moment a write is
    // sent until its answer says it was taken.
    publishedConfirmed: !!r.published_confirmed,
    publishedAt: iso(r.published_at),
    publishError: r.publish_error ?? null,
    publishErrorStatus: r.publish_error_status == null ? null : Number(r.publish_error_status),
    publishAttempts: Number(r.publish_attempts || 0),
    publishFailedAt: iso(r.publish_failed_at),
    publishRetryAt: iso(r.publish_retry_at),
    // The security policy the outcome was computed under, where the read joined it
    // (getCodeReviewOutcome): null when it was not read, or nothing was stored yet.
    securityPolicy: r.security_policy ?? null,
    // Since when GitHub is owed this outcome's status, and since when the outcome
    // itself is owed a recomputation; null when nothing is.
    publishOwedAt: iso(r.publish_owed_at),
    recomputeAt: iso(r.recompute_at),
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
  };
}

const OUTCOME_KEY = 'WHERE `repo` = ? AND `pr_number` = ?';
// The outcome with the security policy it was computed under: what tells a pull
// request's stored outcome apart from one the project's policy has since moved past.
const OUTCOME_WITH_POLICY =
  'SELECT o.*, s.`policy` AS `security_policy` FROM `code_review_outcomes` o LEFT JOIN `code_review_security` s ON s.`repo` = o.`repo` AND s.`pr_number` = o.`pr_number`';
const OUTCOME_KEY_O = 'WHERE o.`repo` = ? AND o.`pr_number` = ?';

// The pull request's security result as last computed (lib/review-security.js), kept
// beside its outcome and written with it.
function rowToCodeReviewSecurity(r) {
  return {
    repo: r.repo,
    prNumber: Number(r.pr_number),
    codeReviewId: r.code_review_id == null ? null : Number(r.code_review_id),
    headSha: r.head_sha ?? null,
    reviewedSha: r.reviewed_sha ?? null,
    policy: r.policy,
    result: r.result,
    blocking: !!r.blocking,
    stale: !!r.stale,
    reasons: fromJson(r.reasons, []),
    coverage: fromJson(r.coverage, null),
    computedAt: iso(r.computed_at),
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
  };
}

export async function getCodeReviewSecurity(repo, prNumber) {
  const p = await pool();
  const [rows] = await p.query(`SELECT * FROM \`code_review_security\` ${OUTCOME_KEY}`, [repo, prNumber]);
  return rows.length ? rowToCodeReviewSecurity(rows[0]) : null;
}

// Evidence the outcome depends on changed: it is owed a recomputation until one lands
// (refreshCodeReviewOutcome clears this). A pull request with no outcome row has had no
// review record, so nothing was computed or published that could be out of date.
async function markOutcomeStale(conn, repo, prNumber) {
  await conn.query(
    `UPDATE \`code_review_outcomes\` SET \`recompute_at\` = COALESCE(\`recompute_at\`, ?) ${OUTCOME_KEY}`,
    [Date.now(), repo, prNumber],
  );
}

export async function markCodeReviewOutcomeStale(repo, prNumber) {
  await markOutcomeStale(await pool(), repo, prNumber);
}

// A setting of the project that its outcomes are computed from changed: the stored
// outcomes of these pull requests are owed a recomputation, which the sweep pays
// (lib/review-enforcement.js). `prNumbers` null means every one the repository has a
// row for. Resolves with how many rows were marked.
export async function markRepoCodeReviewOutcomesStale(repo, prNumbers = null) {
  if (prNumbers && !prNumbers.length) return 0;
  const p = await pool();
  const [res] = await p.query(
    `UPDATE \`code_review_outcomes\` SET \`recompute_at\` = COALESCE(\`recompute_at\`, ?) WHERE \`repo\` = ?${prNumbers ? ' AND `pr_number` IN (?)' : ''}`,
    [Date.now(), repo, ...(prNumbers ? [prNumbers] : [])],
  );
  return res.affectedRows;
}

// Everything an outcome is computed from, as stored: the review that governs the pull
// request (`reviewId`, else the one the outcome row names, else the latest), its stage
// records and findings, the PR's decisions and its rounds.
async function outcomeState(conn, repo, prNumber, row, reviewId) {
  const key = [repo, prNumber];
  const wanted = reviewId ?? row?.codeReviewId ?? null;
  // By its id, for this repository. A review row created before its session knew its
  // pull request carries no PR number, and is still the review that was named: falling
  // back to another review of the PR would compute the outcome from evidence that is
  // not this review's (an earlier review that passed, say, while this one runs).
  let [reviews] = wanted
    ? await conn.query(
        'SELECT * FROM `code_reviews` WHERE `repo` = ? AND `id` = ? AND (`pr_number` = ? OR `pr_number` IS NULL)',
        [repo, wanted, prNumber],
      )
    : [[]];
  // No review named, or the one named is gone: the latest one stored for the PR.
  if (!reviews.length)
    [reviews] = await conn.query(
      `SELECT * FROM \`code_reviews\` ${OUTCOME_KEY} ORDER BY \`created_at\` DESC, \`id\` DESC LIMIT 1`,
      key,
    );
  const review = reviews.length ? rowToCodeReview(reviews[0]) : null;
  const of = async (table, map) => {
    if (!review) return [];
    const [rows] = await conn.query(
      `SELECT * FROM \`${table}\` WHERE \`code_review_id\` = ? ORDER BY \`id\``,
      [review.id],
    );
    return rows.map(map);
  };
  const [decisions] = await conn.query(
    `SELECT * FROM \`code_review_decisions\` ${OUTCOME_KEY} ORDER BY \`id\``,
    key,
  );
  const [counts] = await conn.query(`SELECT * FROM \`code_review_round_counts\` ${OUTCOME_KEY}`, key);
  // What the approval requirement is computed from beside the outcome: the risk the
  // server assessed for the revision, every approval on record, and the requirement as
  // last stored.
  const [risk] = await conn.query(`SELECT * FROM \`code_review_risk\` ${OUTCOME_KEY}`, key);
  const [approvals] = await conn.query(
    `SELECT * FROM \`code_review_approvals\` ${OUTCOME_KEY} ORDER BY \`id\``,
    key,
  );
  const [readiness] = await conn.query(`SELECT * FROM \`code_review_readiness\` ${OUTCOME_KEY}`, key);
  // Whose sessions made commits of the revision the server read: asked now, not kept
  // with that read, because a session's commits are recorded when its turn ends, which
  // may be after the head was first seen.
  const assessed = risk.length ? rowToCodeReviewRisk(risk[0]) : null;
  const workers = await commitOwners(conn, repo, assessed?.authors?.shas);
  // The revisions the governing review carries over to: same change, rebased.
  const [carryovers] = review
    ? await conn.query(
        `SELECT * FROM \`code_review_carryovers\` ${OUTCOME_KEY} AND \`code_review_id\` = ? ORDER BY \`id\``,
        [...key, review.id],
      )
    : [[]];
  return {
    row,
    review,
    carryovers: carryovers.map(rowToCodeReviewCarryover),
    stages: await of('code_review_stages', rowToCodeReviewStage),
    findings: await of('code_review_findings', rowToCodeReviewFinding),
    decisions: decisions.map(rowToCodeReviewDecision),
    count: counts.length ? rowToCodeReviewRoundCount(counts[0]) : null,
    rounds: await roundRows(conn, repo, prNumber),
    risk: assessed,
    workers,
    approvals: approvals.map(rowToCodeReviewApproval),
    readiness: readiness.length ? rowToCodeReviewReadiness(readiness[0]) : null,
  };
}

/**
 * What a pull request's outcome is computed from, read without writing anything: for an
 * answer to a client, and for the reading taken before a review's label step.
 * @param {string} repo @param {number} prNumber @param {{ reviewId?: number | null }} [options]
 */
export async function readCodeReviewOutcomeState(repo, prNumber, { reviewId = null } = {}) {
  const p = await pool();
  const [rows] = await p.query(`SELECT * FROM \`code_review_outcomes\` ${OUTCOME_KEY}`, [repo, prNumber]);
  return outcomeState(p, repo, prNumber, rows.length ? rowToCodeReviewOutcome(rows[0]) : null, reviewId);
}

/**
 * Compute a pull request's outcome again and store it, under the PR's outcome row lock:
 * every recomputation for a PR waits its turn there and reads what is committed by
 * then, so the one that writes last is also the one that read last, and an older
 * reading can never overwrite a newer one. The insert takes the lock even when the row
 * is already there (see upsertCodeReviewDecision).
 *
 * `compute(state)` holds the rules (lib/review-enforcement.js) and answers the revision
 * the outcome is for and the commit status it maps to. `reviewId` names the review that
 * governs from now on, which only a discovery run does. Only the outcome and the status
 * it should have are written here: what GitHub carries is recorded by the publication.
 * @param {string} repo @param {number} prNumber
 * @param {{ reviewId?: number | null }} options
 * `owed` says GitHub is to carry that status (the project enforces the outcome): the row
 * then owes a publication from this transaction on, until one is recorded, so an outcome
 * stored and never posted (a restart in between) is found again by the sweep. The
 * recomputation the row may have owed is settled by this one.
 * `security` is the security result computed beside the outcome, stored in the same
 * transaction: the two are one reading of the same records, and are never seen apart.
 * `readiness` is the approval requirement computed beside them (lib/review-approvals.js),
 * stored in that transaction too, with the status it maps to and, under `owed`, the debt
 * of its publication; null leaves the pull request without one, as for a project that
 * never had an approval policy.
 * @param {(state: any) => { outcome: string, stale: boolean, reasons: any[], headSha: string | null, baseRef: string | null, statusState: string, statusDescription: string, owed?: boolean, security?: any, readiness?: any }} compute
 */
export async function refreshCodeReviewOutcome(repo, prNumber, { reviewId = null }, compute) {
  const p = await pool();
  const conn = await p.getConnection();
  try {
    await conn.beginTransaction();
    const key = [repo, prNumber];
    const now = Date.now();
    await conn.query(
      'INSERT INTO `code_review_outcomes` (`repo`, `pr_number`, `created_at`, `updated_at`) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE `pr_number` = `pr_number`',
      [...key, now, now],
    );
    const [rows] = await conn.query(`SELECT * FROM \`code_review_outcomes\` ${OUTCOME_KEY} FOR UPDATE`, key);
    const state = await outcomeState(conn, repo, prNumber, rowToCodeReviewOutcome(rows[0]), reviewId);
    const next = compute(state);
    // Retry history belongs to the status being sent, not to the PR forever. A new
    // head or verdict gets its own attempts and must not inherit an old give-up.
    const changed =
      state.row.headSha !== next.headSha ||
      state.row.statusState !== next.statusState ||
      state.row.statusDescription !== next.statusDescription;
    await conn.query(
      `UPDATE \`code_review_outcomes\` SET \`code_review_id\` = ?, \`head_sha\` = ?, \`base_ref\` = ?, \`outcome\` = ?, \`stale\` = ?, \`reasons\` = ?, \`computed_at\` = ?, \`status_state\` = ?, \`status_description\` = ?, \`recompute_at\` = NULL, \`publish_owed_at\` = ${next.owed ? 'COALESCE(`publish_owed_at`, ?)' : 'NULL'}, ${changed ? '`publish_attempts` = 0, `publish_error` = NULL, `publish_error_status` = NULL, `publish_failed_at` = NULL, `publish_retry_at` = NULL,' : ''} \`updated_at\` = ? ${OUTCOME_KEY}`,
      [
        state.review?.id ?? null,
        next.headSha,
        next.baseRef,
        next.outcome,
        next.stale ? 1 : 0,
        toJson(next.reasons),
        now,
        next.statusState,
        next.statusDescription,
        ...(next.owed ? [now] : []),
        now,
        ...key,
      ],
    );
    if (next.security)
      await conn.query(
        `INSERT INTO \`code_review_security\`
           (\`repo\`, \`pr_number\`, \`code_review_id\`, \`head_sha\`, \`reviewed_sha\`, \`policy\`, \`result\`, \`blocking\`, \`stale\`, \`reasons\`, \`coverage\`, \`computed_at\`, \`created_at\`, \`updated_at\`)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE \`code_review_id\` = VALUES(\`code_review_id\`), \`head_sha\` = VALUES(\`head_sha\`), \`reviewed_sha\` = VALUES(\`reviewed_sha\`), \`policy\` = VALUES(\`policy\`), \`result\` = VALUES(\`result\`), \`blocking\` = VALUES(\`blocking\`), \`stale\` = VALUES(\`stale\`), \`reasons\` = VALUES(\`reasons\`), \`coverage\` = VALUES(\`coverage\`), \`computed_at\` = VALUES(\`computed_at\`), \`updated_at\` = VALUES(\`updated_at\`)`,
        [
          ...key,
          state.review?.id ?? null,
          next.headSha,
          next.security.headSha ?? null,
          next.security.policy,
          next.security.result,
          next.security.blocking ? 1 : 0,
          next.security.stale ? 1 : 0,
          toJson(next.security.reasons || []),
          next.security.coverage ? toJson(next.security.coverage) : null,
          now,
          now,
          now,
        ],
      );
    let readiness = state.readiness;
    if (next.readiness) {
      const r = next.readiness;
      // `waiting_since` first: it reads the head the row had before this write, so a
      // wait carries on only on the same head.
      await conn.query(
        `INSERT INTO \`code_review_readiness\`
           (\`repo\`, \`pr_number\`, \`head_sha\`, \`base_ref\`, \`result\`, \`tier\`, \`required\`, \`valid\`, \`reasons\`, \`waiting_since\`, \`computed_at\`, \`status_state\`, \`status_description\`, \`publish_owed_at\`, \`created_at\`, \`updated_at\`)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           \`waiting_since\` = IF(VALUES(\`waiting_since\`) IS NULL, NULL, IF(\`head_sha\` <=> VALUES(\`head_sha\`), COALESCE(\`waiting_since\`, VALUES(\`waiting_since\`)), VALUES(\`waiting_since\`))),
           \`head_sha\` = VALUES(\`head_sha\`), \`base_ref\` = VALUES(\`base_ref\`), \`result\` = VALUES(\`result\`), \`tier\` = VALUES(\`tier\`), \`required\` = VALUES(\`required\`), \`valid\` = VALUES(\`valid\`), \`reasons\` = VALUES(\`reasons\`), \`computed_at\` = VALUES(\`computed_at\`), \`status_state\` = VALUES(\`status_state\`), \`status_description\` = VALUES(\`status_description\`),
           \`publish_owed_at\` = ${r.owed ? 'COALESCE(`publish_owed_at`, VALUES(`publish_owed_at`))' : 'NULL'}, \`updated_at\` = VALUES(\`updated_at\`)`,
        [
          ...key,
          next.headSha,
          next.baseRef,
          r.result,
          r.tier ?? null,
          r.required || 0,
          r.valid || 0,
          toJson(r.reasons || []),
          r.waiting ? now : null,
          now,
          r.statusState,
          r.statusDescription,
          r.owed ? now : null,
          now,
          now,
        ],
      );
      const [stored] = await conn.query(`SELECT * FROM \`code_review_readiness\` ${OUTCOME_KEY}`, key);
      readiness = rowToCodeReviewReadiness(stored[0]);
    }
    const [after] = await conn.query(`${OUTCOME_WITH_POLICY} ${OUTCOME_KEY_O}`, key);
    await conn.commit();
    return { ...state, row: rowToCodeReviewOutcome(after[0]), readiness };
  } catch (e) {
    await conn.rollback().catch(() => {});
    throw e;
  } finally {
    conn.release();
  }
}

function rowToCodeReviewCarryover(r) {
  return {
    id: Number(r.id),
    repo: r.repo,
    prNumber: Number(r.pr_number),
    codeReviewId: Number(r.code_review_id),
    reviewedSha: r.reviewed_sha,
    reviewedBaseRef: r.reviewed_base_ref ?? null,
    headSha: r.head_sha,
    baseRef: r.base_ref,
    digest: r.digest,
    createdAt: iso(r.created_at),
  };
}

/**
 * Record that a review carries over to a revision making the same change
 * (lib/review-carryover.js). Recording it twice keeps the first.
 * @param {{ repo: string, prNumber: number, codeReviewId: number, reviewedSha: string, reviewedBaseRef?: string | null, headSha: string, baseRef: string, digest: string }} c
 */
export async function saveCodeReviewCarryover(c) {
  const p = await pool();
  await p.query(
    'INSERT IGNORE INTO `code_review_carryovers` (`repo`, `pr_number`, `code_review_id`, `reviewed_sha`, `reviewed_base_ref`, `head_sha`, `base_ref`, `digest`, `created_at`) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [
      c.repo,
      c.prNumber,
      c.codeReviewId,
      c.reviewedSha,
      c.reviewedBaseRef ?? null,
      c.headSha,
      c.baseRef,
      c.digest,
      Date.now(),
    ],
  );
}

export async function getCodeReviewOutcome(repo, prNumber) {
  const p = await pool();
  const [rows] = await p.query(`${OUTCOME_WITH_POLICY} ${OUTCOME_KEY_O}`, [repo, prNumber]);
  return rows.length ? rowToCodeReviewOutcome(rows[0]) : null;
}

// The two records of a commit status and its publication: the review outcome's, and the
// approval requirement's beside it (code_review_readiness). The same columns under the
// same names, so what records a publication works on either.
const LEDGERS = { review: 'code_review_outcomes', approvals: 'code_review_readiness' };
const ledgerTable = (ledger) => LEDGERS[ledger] || LEDGERS.review;

// A status write is about to be sent. From here until its answer is recorded nobody
// knows what the commit carries: GitHub may take a write whose answer never arrives.
// Recorded first, so a lost answer, and a server that stops in between, leave the row
// saying "unknown" instead of what GitHub carried before.
export async function markCodeReviewStatusSending(repo, prNumber, ledger = 'review') {
  const p = await pool();
  await p.query(
    `UPDATE \`${ledgerTable(ledger)}\` SET \`published_confirmed\` = 0, \`updated_at\` = ? ${OUTCOME_KEY}`,
    [Date.now(), repo, prNumber],
  );
}

// GitHub carries the status: it answered that it took it, or (`posted` false) it was read
// back from the commit. Any earlier failure is over. The publication the row owes is
// settled only if this is still the status it should carry: an outcome stored while the
// write was under way owes its own.
export async function recordCodeReviewStatusPublished(
  repo,
  prNumber,
  { sha, state, description },
  { posted = true, ledger = 'review', own = null } = {},
) {
  const p = await pool();
  const now = Date.now();
  // `own` is the pull request's own status as the publisher read it, when what GitHub
  // carries for the commit is another one: the most restrictive of the pull requests
  // that share the head. The debt is settled against the pull request's own.
  const settles = own || { sha, state, description };
  await p.query(
    `UPDATE \`${ledgerTable(ledger)}\` SET \`published_sha\` = ?, \`published_state\` = ?, \`published_description\` = ?, \`published_confirmed\` = 1, \`published_at\` = ${posted ? '?' : 'COALESCE(`published_at`, ?)'}, \`publish_error\` = NULL, \`publish_error_status\` = NULL, \`publish_attempts\` = 0, \`publish_failed_at\` = NULL, \`publish_retry_at\` = NULL, \`publish_owed_at\` = IF(CAST(\`head_sha\` AS BINARY) <=> CAST(? AS BINARY) AND \`status_state\` <=> ? AND CAST(\`status_description\` AS BINARY) <=> CAST(? AS BINARY), NULL, \`publish_owed_at\`), \`updated_at\` = ? ${OUTCOME_KEY}`,
    [sha, state, description, now, settles.sha, settles.state, settles.description, now, repo, prNumber],
  );
}

// What each pull request of a repository that is at this head should carry, by its own
// reckoning: a commit status belongs to the commit, so the pull requests that share a
// head share its statuses (lib/review-enforcement.js works out which one stands).
export async function listCodeReviewStatusesAtHead(repo, sha, ledger = 'review') {
  const p = await pool();
  const [rows] = await p.query(
    `SELECT \`pr_number\`, \`status_state\`, \`status_description\` FROM \`${ledgerTable(ledger)}\` WHERE \`repo\` = ? AND \`head_sha\` = ? AND \`status_state\` IS NOT NULL ORDER BY \`pr_number\``,
    [repo, sha],
  );
  return rows.map((r) => ({
    prNumber: Number(r.pr_number),
    state: r.status_state,
    description: r.status_description || '',
  }));
}

// Something changed for one pull request at this head, or a pull request came to it or
// left it: the others at the same head owe their statuses again, on both records, and
// the sweep has each look at the commit once more. Resolves with how many rows.
export async function oweCodeReviewStatusesAtHead(repo, sha, exceptPr = null) {
  const p = await pool();
  const now = Date.now();
  let marked = 0;
  for (const table of Object.values(LEDGERS)) {
    const [res] = await p.query(
      `UPDATE \`${table}\` SET \`publish_owed_at\` = COALESCE(\`publish_owed_at\`, ?) WHERE \`repo\` = ? AND \`head_sha\` = ? AND \`status_state\` IS NOT NULL${exceptPr == null ? '' : ' AND `pr_number` <> ?'}`,
      [now, repo, sha, ...(exceptPr == null ? [] : [exceptPr])],
    );
    marked += res.affectedRows;
  }
  return marked;
}

// GitHub did not take the status, or did not say. What it last confirmed stays recorded
// (`published_*`), unconfirmed, so the row keeps saying that the outcome is not on GitHub
// until a write lands. With `retryAt` null no further attempt is made by itself (a
// refusal that trying again cannot change): the failure stays on the row, the debt goes.
// A failure of an older status cannot spend the new status's attempts or clear its
// debt. Compare bytes, as the publisher does in JS, including description case/spaces.
// `{ sha, state, description }` is the pull request's own status, the one its row holds.
export async function recordCodeReviewStatusFailed(
  repo,
  prNumber,
  { error, status = null, retryAt, ledger = 'review' },
  { sha, state, description },
) {
  const p = await pool();
  const now = Date.now();
  await p.query(
    `UPDATE \`${ledgerTable(ledger)}\` SET \`publish_error\` = ?, \`publish_error_status\` = ?, \`publish_attempts\` = \`publish_attempts\` + 1, \`publish_failed_at\` = ?, \`publish_retry_at\` = ?, \`publish_owed_at\` = ${retryAt == null ? 'NULL' : 'COALESCE(`publish_owed_at`, ?)'}, \`updated_at\` = ? ${OUTCOME_KEY} AND CAST(\`head_sha\` AS BINARY) <=> CAST(? AS BINARY) AND \`status_state\` <=> ? AND CAST(\`status_description\` AS BINARY) <=> CAST(? AS BINARY)`,
    [
      String(error).slice(0, 2000),
      status,
      now,
      retryAt,
      ...(retryAt == null ? [] : [now]),
      now,
      repo,
      prNumber,
      sha,
      state,
      description,
    ],
  );
}

// Nothing is owed to GitHub for this pull request any more: its project stopped
// publishing or is gone, or the pull request closed with a status that kept failing. A
// failure is then neither retried nor listed.
export async function dropCodeReviewStatusDebt(repo, prNumber, ledger = 'review') {
  const p = await pool();
  await p.query(
    `UPDATE \`${ledgerTable(ledger)}\` SET \`publish_error\` = NULL, \`publish_error_status\` = NULL, \`publish_attempts\` = 0, \`publish_failed_at\` = NULL, \`publish_retry_at\` = NULL, \`publish_owed_at\` = NULL,${ledger === 'approvals' ? '' : ' `recompute_at` = NULL,'} \`updated_at\` = ? ${OUTCOME_KEY}`,
    [Date.now(), repo, prNumber],
  );
}

// The statuses GitHub refused or could not be reached for, the longest-failing first:
// what may wait on a person (lib/attention.js).
export async function listFailedCodeReviewStatuses({ limit = 200 } = {}) {
  const p = await pool();
  const [rows] = await p.query(
    'SELECT * FROM `code_review_outcomes` WHERE `publish_failed_at` IS NOT NULL ORDER BY `publish_failed_at` LIMIT ?',
    [limit],
  );
  // The approval requirement's status fails the same way, for the same reasons.
  const [approvals] = await p.query(
    'SELECT * FROM `code_review_readiness` WHERE `publish_failed_at` IS NOT NULL ORDER BY `publish_failed_at` LIMIT ?',
    [limit],
  );
  return [...rows.map(rowToCodeReviewOutcome), ...approvals.map(rowToCodeReviewReadiness)];
}

// What the sweep has to attend to by `now`: outcomes owed a recomputation, and stored
// outcomes whose status GitHub is owed, whether a write failed (once its next attempt is
// due) or was never made. The longest-waiting first.
//
// A revision whose risk could not be read is owed too, once its next read is due
// (code_review_risk): its outcome is computed again, which reads it. And the approval
// requirement's status is owed like the outcome's, on its own record (`ledger`).
export async function listCodeReviewOutcomesDue({ now, limit = 200 }) {
  const p = await pool();
  const [rows] = await p.query(
    'SELECT o.*, k.`retry_at` AS `risk_retry_at` FROM `code_review_outcomes` o LEFT JOIN `code_review_risk` k ON k.`repo` = o.`repo` AND k.`pr_number` = o.`pr_number` AND k.`retry_at` IS NOT NULL AND k.`retry_at` <= ? WHERE o.`recompute_at` IS NOT NULL OR k.`retry_at` IS NOT NULL OR (o.`publish_owed_at` IS NOT NULL AND (o.`publish_retry_at` IS NULL OR o.`publish_retry_at` <= ?)) ORDER BY COALESCE(o.`recompute_at`, k.`retry_at`, o.`publish_owed_at`), o.`repo`, o.`pr_number` LIMIT ?',
    [now, now, limit],
  );
  const [approvals] = await p.query(
    'SELECT * FROM `code_review_readiness` WHERE `publish_owed_at` IS NOT NULL AND (`publish_retry_at` IS NULL OR `publish_retry_at` <= ?) ORDER BY `publish_owed_at`, `repo`, `pr_number` LIMIT ?',
    [now, limit],
  );
  return [
    ...rows.map((r) => ({
      ...rowToCodeReviewOutcome(r),
      // Due because its risk is to be read again: a recomputation like any other.
      ...(r.risk_retry_at != null && r.recompute_at == null
        ? { recomputeAt: iso(r.risk_retry_at), riskRetry: true }
        : {}),
    })),
    ...approvals.map(rowToCodeReviewReadiness),
  ];
}

// ---- the risk of a revision, the approvals on record and the requirement ----

function rowToCodeReviewRisk(r) {
  return {
    repo: r.repo,
    prNumber: Number(r.pr_number),
    headSha: r.head_sha,
    baseRef: r.base_ref ?? null,
    policyHash: r.policy_hash,
    tier: r.tier,
    complete: !!r.complete,
    assessment: fromJson(r.assessment, null),
    authors: fromJson(r.authors, null),
    reviewsSyncedAt: iso(r.reviews_synced_at),
    error: r.error ?? null,
    attempts: Number(r.attempts || 0),
    retryAt: iso(r.retry_at),
    observedAt: iso(r.observed_at),
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
  };
}

export async function getCodeReviewRisk(repo, prNumber) {
  const p = await pool();
  const [rows] = await p.query(`SELECT * FROM \`code_review_risk\` ${OUTCOME_KEY}`, [repo, prNumber]);
  return rows.length ? rowToCodeReviewRisk(rows[0]) : null;
}

// What the server read about the revision a pull request is at, replacing what it held
// about any other: one record per pull request, and never one that mixes two revisions.
export async function saveCodeReviewRisk(repo, prNumber, risk) {
  const p = await pool();
  const now = Date.now();
  await p.query(
    `INSERT INTO \`code_review_risk\`
       (\`repo\`, \`pr_number\`, \`head_sha\`, \`base_ref\`, \`policy_hash\`, \`tier\`, \`complete\`, \`assessment\`, \`authors\`, \`reviews_synced_at\`, \`error\`, \`attempts\`, \`retry_at\`, \`observed_at\`, \`created_at\`, \`updated_at\`)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE \`head_sha\` = VALUES(\`head_sha\`), \`base_ref\` = VALUES(\`base_ref\`), \`policy_hash\` = VALUES(\`policy_hash\`), \`tier\` = VALUES(\`tier\`), \`complete\` = VALUES(\`complete\`), \`assessment\` = VALUES(\`assessment\`), \`authors\` = VALUES(\`authors\`), \`reviews_synced_at\` = VALUES(\`reviews_synced_at\`), \`error\` = VALUES(\`error\`), \`attempts\` = VALUES(\`attempts\`), \`retry_at\` = VALUES(\`retry_at\`), \`observed_at\` = VALUES(\`observed_at\`), \`updated_at\` = VALUES(\`updated_at\`)`,
    [
      repo,
      prNumber,
      risk.headSha,
      risk.baseRef ?? null,
      risk.policyHash,
      risk.tier,
      risk.complete ? 1 : 0,
      toJson(risk.assessment),
      risk.authors ? toJson(risk.authors) : null,
      risk.reviewsSyncedAt ?? null,
      risk.error ? String(risk.error).slice(0, 2000) : null,
      risk.attempts || 0,
      risk.retryAt ?? null,
      // When the files and the commits were last asked for, which is not every save.
      risk.observedAt ?? now,
      now,
      now,
    ],
  );
  return getCodeReviewRisk(repo, prNumber);
}

// Nobody is waiting for this revision's risk any more (the project dropped its policy).
export async function clearCodeReviewRiskRetry(repo, prNumber) {
  const p = await pool();
  await p.query(`UPDATE \`code_review_risk\` SET \`retry_at\` = NULL, \`updated_at\` = ? ${OUTCOME_KEY}`, [
    Date.now(),
    repo,
    prNumber,
  ]);
}

function rowToCodeReviewApproval(r) {
  return {
    id: Number(r.id),
    repo: r.repo,
    prNumber: Number(r.pr_number),
    source: r.source,
    userId: r.user_id == null ? null : Number(r.user_id),
    approver: r.approver ?? null,
    githubLogin: r.github_login ?? null,
    githubUserId: r.github_user_id == null ? null : Number(r.github_user_id),
    githubReviewId: r.github_review_id == null ? null : Number(r.github_review_id),
    status: r.status,
    headSha: r.head_sha,
    baseRef: r.base_ref ?? null,
    codeReviewId: r.code_review_id == null ? null : Number(r.code_review_id),
    reviewOutcome: r.review_outcome ?? null,
    note: r.note ?? null,
    authorship: r.authorship ?? null,
    automation: r.automation ?? null,
    association: r.association ?? null,
    approvedAt: iso(r.approved_at),
    withdrawnAt: iso(r.withdrawn_at),
    withdrawNote: r.withdraw_note ?? null,
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
  };
}

export async function listCodeReviewApprovals(repo, prNumber) {
  const p = await pool();
  const [rows] = await p.query(`SELECT * FROM \`code_review_approvals\` ${OUTCOME_KEY} ORDER BY \`id\``, [
    repo,
    prNumber,
  ]);
  return rows.map(rowToCodeReviewApproval);
}

/**
 * Record a user's approval of one revision of a pull request. Resolves with
 * `{ approval, created }`: asking again for the same revision while the first approval
 * stands answers that one (`created` false), so a request sent twice records one
 * approval. The outcome is marked as owing a recomputation in the same transaction, like
 * every other change of what it is computed from.
 * @param {string} repo @param {number} prNumber
 * @param {{ userId: number, approver?: string | null, githubLogin?: string | null, githubUserId?: number | null, headSha: string, baseRef: string, codeReviewId?: number | null, reviewOutcome?: string | null, note?: string | null, authorship?: string | null }} approval
 */
export async function addCodeReviewApproval(repo, prNumber, approval) {
  const p = await pool();
  const conn = await p.getConnection();
  try {
    await conn.beginTransaction();
    const now = Date.now();
    let id;
    let created = true;
    try {
      const [res] = await conn.query(
        `INSERT INTO \`code_review_approvals\`
           (\`repo\`, \`pr_number\`, \`source\`, \`user_id\`, \`approver\`, \`github_login\`, \`github_user_id\`, \`status\`, \`active\`, \`head_sha\`, \`base_ref\`, \`code_review_id\`, \`review_outcome\`, \`note\`, \`authorship\`, \`approved_at\`, \`created_at\`, \`updated_at\`)
         VALUES (?, ?, 'briareus', ?, ?, ?, ?, 'approved', 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          repo,
          prNumber,
          approval.userId,
          approval.approver ?? null,
          approval.githubLogin ?? null,
          approval.githubUserId ?? null,
          approval.headSha,
          approval.baseRef,
          approval.codeReviewId ?? null,
          approval.reviewOutcome ?? null,
          approval.note ?? null,
          approval.authorship ?? null,
          now,
          now,
          now,
        ],
      );
      id = res.insertId;
    } catch (e) {
      if (e.code !== 'ER_DUP_ENTRY') throw e;
      created = false;
      const [standing] = await conn.query(
        `SELECT \`id\` FROM \`code_review_approvals\` ${OUTCOME_KEY} AND \`user_id\` = ? AND \`head_sha\` = ? AND \`base_ref\` = ? AND \`active\` = 1`,
        [repo, prNumber, approval.userId, approval.headSha, approval.baseRef],
      );
      id = standing[0]?.id;
    }
    if (created) await markOutcomeStale(conn, repo, prNumber);
    const [rows] = await conn.query('SELECT * FROM `code_review_approvals` WHERE `id` = ?', [id]);
    await conn.commit();
    return { approval: rows.length ? rowToCodeReviewApproval(rows[0]) : null, created };
  } catch (e) {
    await conn.rollback().catch(() => {});
    throw e;
  } finally {
    conn.release();
  }
}

/**
 * Withdraw an approval, by the user who gave it and nobody else. The row stays, marked
 * withdrawn with when and why. Resolves with `{ approval, changed }`, `approval` null
 * when that user has no such approval on the pull request; withdrawing twice changes
 * nothing the second time.
 * @param {string} repo @param {number} prNumber @param {number} id @param {number} userId
 * @param {{ note?: string | null }} [options]
 */
export async function withdrawCodeReviewApproval(repo, prNumber, id, userId, { note = null } = {}) {
  const p = await pool();
  const conn = await p.getConnection();
  try {
    await conn.beginTransaction();
    const now = Date.now();
    const [res] = await conn.query(
      `UPDATE \`code_review_approvals\` SET \`status\` = 'withdrawn', \`active\` = NULL, \`withdrawn_at\` = ?, \`withdraw_note\` = ?, \`updated_at\` = ? ${OUTCOME_KEY} AND \`id\` = ? AND \`source\` = 'briareus' AND \`user_id\` = ? AND \`status\` = 'approved'`,
      [now, note, now, repo, prNumber, id, userId],
    );
    if (res.affectedRows) await markOutcomeStale(conn, repo, prNumber);
    const [rows] = await conn.query(
      `SELECT * FROM \`code_review_approvals\` ${OUTCOME_KEY} AND \`id\` = ? AND \`source\` = 'briareus' AND \`user_id\` = ?`,
      [repo, prNumber, id, userId],
    );
    await conn.commit();
    return { approval: rows.length ? rowToCodeReviewApproval(rows[0]) : null, changed: !!res.affectedRows };
  } catch (e) {
    await conn.rollback().catch(() => {});
    throw e;
  } finally {
    conn.release();
  }
}

/**
 * Bring the approvals read from GitHub up to date (githubApprovalRows in
 * lib/review-approvals.js): each approving review is one row under its review id. What
 * the server concluded when it first saw one is kept: why it is automation's, who wrote
 * the change, and the base branch it was seen against. Only how the review stands on
 * GitHub follows GitHub, and a dismissal is never undone.
 *
 * `seenAt` is when the list was asked for. Two reads can finish in either order, so how
 * a review stands is taken only from a read no older than the one already stored: a
 * slower, earlier read cannot turn a superseded approval back into a standing one.
 * @param {string} repo @param {number} prNumber
 * @param {{ rows: any[], dismissed: number[], seenAt?: number }} reviews
 */
export async function syncGithubCodeReviewApprovals(
  repo,
  prNumber,
  { rows, dismissed, seenAt = Date.now() },
) {
  const p = await pool();
  const now = Date.now();
  for (const row of rows)
    await p.query(
      `INSERT INTO \`code_review_approvals\`
         (\`repo\`, \`pr_number\`, \`source\`, \`approver\`, \`github_login\`, \`github_user_id\`, \`github_review_id\`, \`status\`, \`active\`, \`head_sha\`, \`base_ref\`, \`authorship\`, \`automation\`, \`association\`, \`approved_at\`, \`seen_at\`, \`created_at\`, \`updated_at\`)
       VALUES (?, ?, 'github', ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         \`status\` = IF(\`status\` = 'dismissed' OR COALESCE(\`seen_at\`, 0) > VALUES(\`seen_at\`), \`status\`, VALUES(\`status\`)),
         \`association\` = IF(COALESCE(\`seen_at\`, 0) > VALUES(\`seen_at\`), \`association\`, VALUES(\`association\`)),
         \`base_ref\` = COALESCE(\`base_ref\`, VALUES(\`base_ref\`)), \`authorship\` = COALESCE(\`authorship\`, VALUES(\`authorship\`)), \`automation\` = COALESCE(\`automation\`, VALUES(\`automation\`)), \`github_user_id\` = COALESCE(\`github_user_id\`, VALUES(\`github_user_id\`)),
         \`seen_at\` = GREATEST(COALESCE(\`seen_at\`, 0), VALUES(\`seen_at\`)), \`updated_at\` = VALUES(\`updated_at\`)`,
      [
        repo,
        prNumber,
        row.githubLogin,
        row.githubLogin,
        row.githubUserId ?? null,
        row.githubReviewId,
        row.status,
        row.headSha,
        row.baseRef ?? null,
        row.authorship ?? null,
        row.automation ?? null,
        row.association ?? null,
        row.approvedAt ?? null,
        seenAt,
        now,
        now,
      ],
    );
  if (dismissed.length)
    await p.query(
      `UPDATE \`code_review_approvals\` SET \`status\` = 'dismissed', \`updated_at\` = ? ${OUTCOME_KEY} AND \`source\` = 'github' AND \`github_review_id\` IN (?) AND \`status\` <> 'dismissed'`,
      [now, repo, prNumber, dismissed],
    );
}

// Which user's session made which commit: written when a session's turn ends with
// commits it did not have before (lib/jobs.js), for a project with an approval policy.
// It outlives the session, and is what ties a person to a change their sessions wrote
// under the server's account, whatever those sessions were started for and wherever
// they went afterwards.
export async function recordCodeReviewCommitOwners(repo, { userId, jobId = null, branch = null, shas }) {
  if (!shas.length) return 0;
  const p = await pool();
  const now = Date.now();
  const [res] = await p.query(
    'INSERT IGNORE INTO `code_review_commit_owners` (`repo`, `commit_sha`, `user_id`, `job_id`, `branch`, `created_at`) VALUES ?',
    [shas.map((sha) => [repo, sha, userId, jobId, branch, now])],
  );
  return res.affectedRows;
}

async function commitOwners(conn, repo, shas) {
  if (!Array.isArray(shas) || !shas.length) return [];
  const [rows] = await conn.query(
    'SELECT DISTINCT `user_id` FROM `code_review_commit_owners` WHERE `repo` = ? AND `commit_sha` IN (?)',
    [repo, shas],
  );
  return rows.map((r) => Number(r.user_id));
}

/** @param {string} repo @param {string[]} shas @returns {Promise<number[]>} the users whose sessions made any of them */
export async function listCodeReviewCommitOwners(repo, shas) {
  return commitOwners(await pool(), repo, shas);
}

// Every GitHub account a user has linked, kept when they unlink it (lib/github-links.js).
export async function loadGithubLinkRows() {
  const p = await pool();
  const [rows] = await p.query('SELECT * FROM `user_github_links` ORDER BY `first_linked_at`, `user_id`');
  return rows.map((r) => ({
    userId: Number(r.user_id),
    id: Number(r.github_id) || null,
    login: r.login,
  }));
}

export async function saveGithubLink(userId, { id = null, login }) {
  const p = await pool();
  const now = Date.now();
  await p.query(
    'INSERT INTO `user_github_links` (`user_id`, `github_id`, `login`, `first_linked_at`, `last_linked_at`) VALUES (?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE `last_linked_at` = VALUES(`last_linked_at`)',
    [userId, id || 0, login, now, now],
  );
}

// The approval requirement as last computed, with the publication of its status: the
// counterpart of the outcome row, read the same way (`ledger` tells the two apart).
function rowToCodeReviewReadiness(r) {
  return {
    ledger: 'approvals',
    repo: r.repo,
    prNumber: Number(r.pr_number),
    headSha: r.head_sha ?? null,
    baseRef: r.base_ref ?? null,
    result: r.result,
    tier: r.tier ?? null,
    required: Number(r.required || 0),
    valid: Number(r.valid || 0),
    reasons: fromJson(r.reasons, []),
    waitingSince: iso(r.waiting_since),
    computedAt: iso(r.computed_at),
    statusState: r.status_state ?? null,
    statusDescription: r.status_description ?? null,
    publishedSha: r.published_sha ?? null,
    publishedState: r.published_state ?? null,
    publishedDescription: r.published_description ?? null,
    publishedConfirmed: !!r.published_confirmed,
    publishedAt: iso(r.published_at),
    publishError: r.publish_error ?? null,
    publishErrorStatus: r.publish_error_status == null ? null : Number(r.publish_error_status),
    publishAttempts: Number(r.publish_attempts || 0),
    publishFailedAt: iso(r.publish_failed_at),
    publishRetryAt: iso(r.publish_retry_at),
    publishOwedAt: iso(r.publish_owed_at),
    recomputeAt: null,
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
  };
}

export async function getCodeReviewReadiness(repo, prNumber) {
  const p = await pool();
  const [rows] = await p.query(`SELECT * FROM \`code_review_readiness\` ${OUTCOME_KEY}`, [repo, prNumber]);
  return rows.length ? rowToCodeReviewReadiness(rows[0]) : null;
}

// The pull requests that wait on people alone, the longest-waiting first: what the
// attention list shows (lib/attention.js).
export async function listCodeReviewReadinessWaiting({ limit = 200 } = {}) {
  const p = await pool();
  const [rows] = await p.query(
    'SELECT * FROM `code_review_readiness` WHERE `waiting_since` IS NOT NULL ORDER BY `waiting_since`, `repo`, `pr_number` LIMIT ?',
    [limit],
  );
  return rows.map(rowToCodeReviewReadiness);
}

// The pull request no longer waits on anybody: it closed or merged, or its project asks
// for nothing any more. Left set, such rows would fill the list above for good.
export async function clearCodeReviewWaiting(repo, prNumber) {
  const p = await pool();
  await p.query(
    `UPDATE \`code_review_readiness\` SET \`waiting_since\` = NULL, \`updated_at\` = ? ${OUTCOME_KEY} AND \`waiting_since\` IS NOT NULL`,
    [Date.now(), repo, prNumber],
  );
}

// ---- mail ----

// An account row keeps its OAuth tokens sealed (lib/secretbox.js); this layer
// hands the sealed text up as it is and never opens it.
function rowToMailAccount(r) {
  return {
    id: Number(r.id),
    userId: r.user_id == null ? null : Number(r.user_id),
    provider: r.provider,
    email: r.email,
    label: r.label || '',
    enabled: !!r.enabled,
    syncDays: Number(r.sync_days),
    credentials: r.credentials,
    syncState: fromJson(r.sync_state, null),
    pushState: fromJson(r.push_state, null),
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
  pushState: 'push_state',
  status: 'status',
  lastSyncAt: 'last_sync_at',
  lastSyncError: 'last_sync_error',
};

function mailAccountValue(key, value) {
  if (key === 'enabled') return value ? 1 : 0;
  if (key === 'syncState' || key === 'pushState') return value == null ? null : toJson(value);
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
       (\`user_id\`, \`provider\`, \`email\`, \`label\`, \`enabled\`, \`sync_days\`, \`credentials\`, \`status\`, \`created_at\`, \`updated_at\`)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      a.userId ?? null,
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
export async function upsertMailMessages(accountId, messages, syncedAt, wakePending = false) {
  if (!messages.length) return;
  const p = await pool();
  for (const m of messages) {
    await p.query(
      `INSERT INTO \`mail_messages\`
         (\`account_id\`, \`id\`, \`thread_id\`, \`folder_id\`, \`received_at\`, \`from_name\`, \`from_address\`,
          \`recipients\`, \`subject\`, \`snippet\`, \`labels\`, \`in_inbox\`, \`is_read\`, \`is_starred\`,
          \`attachments\`, \`body_text\`, \`body_html\`, \`body_truncated\`, \`message_id\`, \`web_url\`, \`synced_at\`, \`wake_pending\`)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        wakePending ? 1 : 0,
      ],
    );
  }
}

export async function pendingMailReceipts(accountId) {
  const p = await pool();
  const [rows] = await p.query(
    'SELECT * FROM `mail_messages` WHERE `account_id` = ? AND `wake_pending` = 1 ORDER BY `received_at`, `id`',
    [accountId],
  );
  return rows.map((r) => ({ ...rowToMailMessage(r), bodyText: r.body_text }));
}

export async function acknowledgeMailReceipt(accountId, id) {
  const p = await pool();
  await p.query('UPDATE `mail_messages` SET `wake_pending` = 0 WHERE `account_id` = ? AND `id` = ?', [
    accountId,
    id,
  ]);
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

// The ids of an account's messages written at or after `syncedAt`: those a
// first pass spread over several syncs has read already.
export async function loadMailMessageIdsSyncedSince(accountId, syncedAt) {
  const p = await pool();
  const [rows] = await p.query(
    'SELECT `id` FROM `mail_messages` WHERE `account_id` = ? AND `synced_at` >= ?',
    [accountId, syncedAt],
  );
  return rows.map((r) => String(r.id));
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
       (\`project_id\`, \`job_id\`, \`user_id\`, \`repo\`, \`provider\`, \`model\`, \`activity\`, \`account_id\`, \`account_label\`, \`session_title\`, \`input_tokens\`, \`cached_input_tokens\`, \`cache_measured\`, \`output_tokens\`, \`cost_usd\`, \`duration_ms\`, \`at\`, \`long_input_tokens\`, \`long_cached_input_tokens\`, \`long_output_tokens\`, \`usage_key\`, \`turn_key\`)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       at = GREATEST(turn_usage.at, VALUES(at)),
       cache_measured = GREATEST(turn_usage.cache_measured, VALUES(cache_measured)),
       input_tokens = GREATEST(COALESCE(turn_usage.input_tokens, 0), COALESCE(VALUES(input_tokens), turn_usage.input_tokens)),
       cached_input_tokens = GREATEST(COALESCE(turn_usage.cached_input_tokens, 0), COALESCE(VALUES(cached_input_tokens), turn_usage.cached_input_tokens)),
       output_tokens = GREATEST(COALESCE(turn_usage.output_tokens, 0), COALESCE(VALUES(output_tokens), turn_usage.output_tokens)),
       duration_ms = GREATEST(COALESCE(turn_usage.duration_ms, 0), COALESCE(VALUES(duration_ms), turn_usage.duration_ms)),
       long_input_tokens = GREATEST(COALESCE(turn_usage.long_input_tokens, 0), COALESCE(VALUES(long_input_tokens), turn_usage.long_input_tokens)),
       long_cached_input_tokens = GREATEST(COALESCE(turn_usage.long_cached_input_tokens, 0), COALESCE(VALUES(long_cached_input_tokens), turn_usage.long_cached_input_tokens)),
       long_output_tokens = GREATEST(COALESCE(turn_usage.long_output_tokens, 0), COALESCE(VALUES(long_output_tokens), turn_usage.long_output_tokens))`,
    values: [
      row.projectId ?? null,
      row.jobId,
      row.userId ?? null,
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
      row.usageKey ?? null,
      row.turnKey ?? null,
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
    userId: r.user_id == null ? null : Number(r.user_id),
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
    // Shared by the rows of one turn booked under several models (lib/usage.js).
    ...(r.turn_key ? { turnKey: r.turn_key } : {}),
  };
}

const TURN_USAGE_COLUMNS =
  '`project_id`, `job_id`, `user_id`, `repo`, `provider`, `model`, `activity`, `account_id`, `account_label`, `session_title`, `input_tokens`, `cached_input_tokens`, `cache_measured`, `output_tokens`, `cost_usd`, `duration_ms`, `at`, `long_input_tokens`, `long_cached_input_tokens`, `long_output_tokens`, `turn_key`';

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
