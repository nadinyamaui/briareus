// @ts-check
import { loadProjectRows, saveProject, saveProjectOrder, deleteProject, getProjectRow } from './db.js';
import { normalize as normalizeTemplates } from './templates.js';
import { parseRunProfiles } from './runprofiles.js';

// A project is everything needed to run a session against one repository (setup
// steps, PHP, pooled database, .env seed, how to serve it), stored in the
// `projects` table. Cached in memory and reloaded on every write, because the call
// sites are synchronous and rows change rarely.

let cache = [];

const REPO_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

export const PROJECT_DEFAULTS = {
  repo: '',
  label: '',
  enabled: true,
  // Opt-in access to the operator's mail from interactive sessions.
  mailToolsEnabled: false,
  sortOrder: 0,
  setupCommands: [],
  phpBinDir: '',
  localDir: '',
  // Whether a pull request merging into the branch the local checkout is on
  // pulls it and runs `updateCommands` there (lib/local-update.js).
  autoUpdate: false,
  updateCommands: [],
  dbPoolEnabled: false,
  dbPoolDatabase: '',
  dbRestoreSql: '',
  dbExtensions: [],
  envTemplate: '',
  runCommands: [],
  // Named configurations ▶ Run can serve, as typed in Settings; see
  // lib/runprofiles.js for the format.
  runProfiles: '',
  reviewPublishInstructions: '',
  // Automatically send verified worthwhile review-loop findings to the fix errand.
  autonomousReviewLoop: false,
  reviewTestSheet: false,
  reviewTestRun: false,
  qaNotes: '',
  feedbackInstructions: '',
  testSheetInstructions: '',
  reviewAuthor: '',
  reviewProviderId: null,
  reviewModel: '',
  reviewEffort: '',
  // What a 🧭 orchestrator's workers run on when it names nothing on spawn
  // (null means the orchestrator's own entry, usually too expensive).
  workerProviderId: null,
  workerModel: '',
  workerEffort: '',
  // Whether this project is the running dashboard itself, where fix_tooling sends
  // fixes; at most one project carries the flag.
  isSelf: false,
  stepRuntimes: {},
  promptTemplates: {},
  // The GitHub Projects v2 board a client draws as the project's board tab:
  // `{ owner, ownerType, number, view }`, or null for none (lib/projectboard.js).
  projectBoard: null,
};

// The QA session's steps after its opening turn, in order. Each may set its own
// runtime in `stepRuntimes`, else it runs on the session's. Publishing is not a
// step: only the model that ran the review holds its findings, so it stays there.
export const REVIEW_STEPS = [
  { key: 'testSheet', label: 'Test sheet' },
  { key: 'testRun', label: 'Test run' },
];

const STEP_KEYS = REVIEW_STEPS.map((s) => s.key);

// A step's configured runtime, or null for "the session's own". Model and effort
// only count with a provider, since they name options from its list.
export function stepRuntime(project, step) {
  const entry = project && project.stepRuntimes ? project.stepRuntimes[step] : null;
  if (!entry || !entry.providerId) return null;
  return {
    providerId: entry.providerId,
    model: entry.model || '',
    effort: entry.effort || '',
  };
}

// The ⌕ Code review's configured runtime; same rule as stepRuntime.
export function reviewerRuntime(project) {
  if (!project || !project.reviewProviderId) return null;
  return {
    providerId: project.reviewProviderId,
    model: project.reviewModel || '',
    effort: project.reviewEffort || '',
  };
}

// A GitHub login: what the board matches a PR's author against.
const LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;

const OWNER_TYPES = ['organization', 'user'];

// A whole number from a form or a JSON body, or NaN.
const wholeNumber = (v) =>
  Number.isInteger(v) ? v : typeof v === 'string' && /^\s*\d+\s*$/.test(v) ? Number(v) : NaN;

// The Projects v2 board this project shows. Boards belong to an org or user, not
// the repo, so it is named in full (ownerType matters: GitHub reads the two through
// different roots). Clearing owner and number, or sending null, removes it.
function normalizeProjectBoard(input) {
  if (input == null || input === '') return null;
  if (typeof input !== 'object' || Array.isArray(input))
    throw new Error('The project board must be an object');
  const owner = String(input.owner || '')
    .trim()
    .replace(/^@/, '');
  const hasNumber = input.number != null && String(input.number).trim() !== '';
  if (!owner && !hasNumber) return null;
  if (!LOGIN_RE.test(owner)) throw new Error(`"${owner}" is not a GitHub organization or user`);
  const ownerType = String(input.ownerType || 'organization')
    .trim()
    .toLowerCase();
  if (!OWNER_TYPES.includes(ownerType))
    throw new Error('The project board’s owner type must be organization or user');
  const number = wholeNumber(input.number);
  if (!(number >= 1)) throw new Error('The project board needs its project number, a whole number');
  const hasView = input.view != null && String(input.view).trim() !== '';
  const view = hasView ? wholeNumber(input.view) : null;
  if (hasView && !(view >= 1)) throw new Error('The project board’s view must be a whole number');
  return { owner, ownerType, number, view };
}

// ---------------------------------------------------------------------------
// reading
// ---------------------------------------------------------------------------

export async function initProjects() {
  return reload();
}

async function reload() {
  try {
    cache = await loadProjectRows();
  } catch (e) {
    console.error('Could not load projects:', e.message);
  }
  return cache;
}

// Every project, including disabled ones â€” what /settings edits.
export function listProjects() {
  return cache;
}

// The ones a new session can be started against; the first is the default.
export function activeProjects() {
  return cache.filter((p) => p.enabled);
}

// The enabled project flagged as the dashboard itself, where tooling fixes go.
export function selfProject() {
  return cache.find((p) => p.enabled && p.isSelf) || null;
}

// Case-insensitive, like GitHub repo names.
export function getProject(repo) {
  const key = String(repo || '').toLowerCase();
  return cache.find((p) => p.repo.toLowerCase() === key) || null;
}

// ---------------------------------------------------------------------------
// writing
// ---------------------------------------------------------------------------

function asList(value) {
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean);
  if (typeof value === 'string')
    return value
      .split('\n')
      .map((v) => v.trim())
      .filter(Boolean);
  return [];
}

// Keeps only known steps that name a provider; "same as the session" is no entry.
function normalizeStepRuntimes(input) {
  const out = {};
  if (!input || typeof input !== 'object') return out;
  for (const key of STEP_KEYS) {
    const entry = input[key];
    if (!entry || typeof entry !== 'object') continue;
    const id = Number(entry.providerId);
    if (!Number.isInteger(id) || id <= 0) continue;
    out[key] = {
      providerId: id,
      model: String(entry.model || '').trim(),
      effort: String(entry.effort || '').trim(),
    };
  }
  return out;
}

// Throws on anything that would produce a project the runtime cannot use â€” a
// bad repo name, or a database name that is not an identifier.
function normalizeProject(input, existing = null) {
  const base = existing || PROJECT_DEFAULTS;
  const p = { ...base };
  const has = (k) => Object.prototype.hasOwnProperty.call(input, k);

  if (has('repo')) p.repo = String(input.repo || '').trim();
  if (!REPO_RE.test(p.repo)) throw new Error(`"${p.repo}" is not a valid repository â€” use owner/name`);

  if (has('label')) p.label = String(input.label || '').trim();
  if (!p.label) p.label = p.repo.split('/')[1];

  if (has('enabled')) p.enabled = !!input.enabled;
  if (has('mailToolsEnabled')) {
    if (typeof input.mailToolsEnabled !== 'boolean')
      throw new Error('mailToolsEnabled must be true or false');
    p.mailToolsEnabled = input.mailToolsEnabled;
  }
  if (has('sortOrder')) p.sortOrder = Number(input.sortOrder) || 0;

  if (has('setupCommands')) p.setupCommands = asList(input.setupCommands);
  if (has('phpBinDir')) p.phpBinDir = String(input.phpBinDir || '').trim();
  if (has('localDir')) p.localDir = String(input.localDir || '').trim();
  if (has('autoUpdate')) p.autoUpdate = !!input.autoUpdate;
  if (has('updateCommands')) p.updateCommands = asList(input.updateCommands);
  if (p.autoUpdate && !p.localDir) throw new Error('Updating the local checkout needs a local checkout');

  if (has('dbPoolEnabled')) p.dbPoolEnabled = !!input.dbPoolEnabled;
  if (has('dbPoolDatabase')) p.dbPoolDatabase = String(input.dbPoolDatabase || '').trim();
  if (has('dbRestoreSql')) p.dbRestoreSql = String(input.dbRestoreSql || '').trim();
  if (p.dbPoolEnabled && !p.dbPoolDatabase) {
    throw new Error('A pooled project needs the database its sessions should point at');
  }
  if (p.dbPoolDatabase && !/^[A-Za-z0-9_$]+$/.test(p.dbPoolDatabase)) {
    throw new Error(`"${p.dbPoolDatabase}" is not a plain database identifier`);
  }
  // Extension names go into CREATE EXTENSION as identifiers, same as the
  // database name; nothing here may reach psql unchecked.
  if (has('dbExtensions')) p.dbExtensions = asList(input.dbExtensions).map((e) => e.toLowerCase());
  for (const ext of p.dbExtensions) {
    if (!/^[a-z0-9_]+$/.test(ext)) throw new Error(`"${ext}" is not a plain extension name`);
  }
  // Normalized to LF so a CRLF seed does not read as a change on every save; the
  // checkouts are LF anyway (core.autocrlf=false).
  for (const key of [
    'envTemplate',
    'reviewPublishInstructions',
    'qaNotes',
    'feedbackInstructions',
    'testSheetInstructions',
  ]) {
    if (has(key)) p[key] = String(input[key] ?? '').replace(/\r\n/g, '\n');
  }

  if (has('runCommands')) p.runCommands = asList(input.runCommands);
  // Rejected unless it parses, or ▶ Run would quietly serve the plain setup. Only
  // the end is trimmed so parse-error line numbers match the textarea.
  if (has('runProfiles')) {
    p.runProfiles = String(input.runProfiles ?? '')
      .replace(/\r\n/g, '\n')
      .replace(/\s+$/, '');
    parseRunProfiles(p.runProfiles);
  }

  // The test run reads the test sheet, so enabling it enables the sheet.
  if (has('autonomousReviewLoop')) p.autonomousReviewLoop = !!input.autonomousReviewLoop;
  if (has('reviewTestSheet')) p.reviewTestSheet = !!input.reviewTestSheet;
  if (has('reviewTestRun')) p.reviewTestRun = !!input.reviewTestRun;
  if (p.reviewTestRun) p.reviewTestSheet = true;

  if (has('reviewAuthor'))
    p.reviewAuthor = String(input.reviewAuthor || '')
      .trim()
      .replace(/^@/, '');
  if (has('reviewProviderId')) {
    const id = Number(input.reviewProviderId);
    p.reviewProviderId = Number.isInteger(id) && id > 0 ? id : null;
  }
  if (has('stepRuntimes')) p.stepRuntimes = normalizeStepRuntimes(input.stepRuntimes);
  // Per-project prompt overrides; an empty field means "use the global text".
  if (has('promptTemplates')) p.promptTemplates = normalizeTemplates(input.promptTemplates);
  if (has('reviewModel')) p.reviewModel = String(input.reviewModel || '').trim();
  if (has('reviewEffort')) p.reviewEffort = String(input.reviewEffort || '').trim();
  if (has('workerProviderId')) {
    const id = Number(input.workerProviderId);
    p.workerProviderId = Number.isInteger(id) && id > 0 ? id : null;
  }
  if (has('workerModel')) p.workerModel = String(input.workerModel || '').trim();
  if (has('workerEffort')) p.workerEffort = String(input.workerEffort || '').trim();
  if (has('isSelf')) p.isSelf = !!input.isSelf;
  if (has('projectBoard')) p.projectBoard = normalizeProjectBoard(input.projectBoard);
  if (p.reviewAuthor && !LOGIN_RE.test(p.reviewAuthor)) {
    throw new Error(`"${p.reviewAuthor}" is not a GitHub username`);
  }
  return p;
}

// A second isSelf flag is refused rather than silently moved, since fix_tooling
// could not choose between two.
function assertSingleSelf(project, ownId = null) {
  if (!project.isSelf) return;
  const other = cache.find((p) => p.isSelf && p.id !== ownId);
  if (other) {
    throw new Error(`${other.repo} is already flagged as the dashboard itself; untick it there first`);
  }
}

export async function createProject(input) {
  const project = normalizeProject(input);
  if (getProject(project.repo)) throw new Error(`${project.repo} is already set up`);
  assertSingleSelf(project);
  if (!input.sortOrder) {
    project.sortOrder = cache.reduce((max, p) => Math.max(max, p.sortOrder), 0) + 1;
  }
  const saved = await saveProject(project);
  await reload();
  return saved;
}

export async function updateProject(id, input) {
  const existing = await getProjectRow(id);
  if (!existing) throw new Error('Project not found');
  const project = normalizeProject(input, existing);
  const clash = getProject(project.repo);
  if (clash && clash.id !== existing.id) throw new Error(`${project.repo} is already set up`);
  assertSingleSelf(project, existing.id);
  // The position read above may be stale by now (reordering writes it on its
  // own), so it is only saved when the edit names one.
  if (!Object.prototype.hasOwnProperty.call(input, 'sortOrder')) delete project.sortOrder;
  const saved = await saveProject({ ...project, id: existing.id });
  await reload();
  return saved;
}

// An id is a whole number, or a string of digits the way a form sends one;
// anything else (true, ' 2 ', 1.5) names no project.
const toId = (v) => (Number.isInteger(v) ? v : typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : NaN);

// Sets the display order everywhere. The list must name every project exactly once;
// a stale list is refused (409) rather than guessed at.
export async function reorderProjects(ids) {
  const list = Array.isArray(ids) ? ids.map(toId) : [];
  const known = new Set(cache.map((p) => p.id));
  if (
    list.length !== known.size ||
    new Set(list).size !== list.length ||
    !list.every((id) => known.has(id))
  ) {
    throw Object.assign(new Error('The project list changed since it was loaded; reload and try again'), {
      status: 409,
    });
  }
  await saveProjectOrder(list);
  // Applied to the cache directly in case the reload below fails; projects removed
  // during the save are skipped, ones added keep their place after the list.
  const byId = new Map(cache.map((p) => [p.id, p]));
  const listed = new Set(list);
  cache = [
    ...list.filter((id) => byId.has(id)).map((id, i) => ({ ...byId.get(id), sortOrder: i + 1 })),
    ...cache.filter((p) => !listed.has(p.id)),
  ];
  return reload();
}

export async function removeProject(id) {
  const removed = await deleteProject(id);
  await reload();
  return removed;
}

// {token} substitution lives in runprofiles.js; re-exported for existing callers.
export { render } from './runprofiles.js';
