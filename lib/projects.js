// @ts-check
import { loadProjectRows, saveProject, deleteProject, getProjectRow } from './db.js';
import { normalize as normalizeTemplates } from './templates.js';

// A project is everything the app needs to know to run a session against one
// repository: which dependency-install steps to run, which PHP to run them
// with, whether the session claims a database server of its own and which
// database it points at there, what to seed the checkout's .env with, and how
// to serve the app for â–¶ Run.
//
// Projects live in the `projects` table, edited from /settings.
//
// The table is read into memory at boot and refreshed on every write, because
// the call sites (spawning a process, building a prompt) are synchronous and a
// project row changes far more rarely than it is read.

let cache = [];

const REPO_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

export const PROJECT_DEFAULTS = {
  repo: '',
  label: '',
  enabled: true,
  sortOrder: 0,
  setupCommands: [],
  phpBinDir: '',
  localDir: '',
  dbPoolEnabled: false,
  dbPoolDatabase: '',
  dbRestoreSql: '',
  dbExtensions: [],
  envTemplate: '',
  runCommands: [],
  reviewPublishInstructions: '',
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
  // (null means the orchestrator's own entry, usually too expensive), and how
  // much one orchestration may spend across itself and its workers before
  // spawning and steering stop (null means no cap).
  workerProviderId: null,
  workerModel: '',
  workerEffort: '',
  workerBudgetUsd: null,
  // Whether this project is the dashboard itself: the repository whose code is
  // running right now. An orchestrator that finds a flaw in the tooling that
  // runs it hands the fix to a worker on this project (fix_tooling), so at
  // most one project carries the flag.
  isSelf: false,
  stepRuntimes: {},
  promptTemplates: {},
};

// The work a QA session leads to after its opening turn, in the order it
// happens. Each may name a provider, model and effort of its own in
// `stepRuntimes`; a step that names none runs on whatever the session it came
// from runs on: the composer's pick, or the project's reviewer defaults when
// the board started it.
//
// Publishing is deliberately not on the list: it is the review's own second
// breath, "now put what you just found on the pull request", and only the
// model that ran the review holds that, so it stays in the review's
// conversation, on its provider.
export const REVIEW_STEPS = [
  { key: 'testSheet', label: 'Test sheet' },
  { key: 'testRun', label: 'Test run' },
];

const STEP_KEYS = REVIEW_STEPS.map((s) => s.key);

// What one step was configured to run on, or null for "the session's own".
// The model and effort are only honoured together with a provider: they name
// options of that provider's list, which is not the same list the session's
// provider offers.
export function stepRuntime(project, step) {
  const entry = project && project.stepRuntimes ? project.stepRuntimes[step] : null;
  if (!entry || !entry.providerId) return null;
  return {
    providerId: entry.providerId,
    model: entry.model || '',
    effort: entry.effort || '',
  };
}

// A GitHub login: what the board matches a PR's author against.
const LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;

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

// The project flagged as the dashboard itself, when one is and it is enabled:
// where an orchestrator's tooling fixes go. Null means the tool has nowhere
// to point, which the orchestrator's briefing says in so many words.
export function selfProject() {
  return cache.find((p) => p.enabled && p.isSelf) || null;
}

// Looked up case-insensitively: GitHub repo names are, and a project typed by
// hand into the settings form will not always match the casing a session was
// created with.
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

// The per-step provider overrides, kept to the steps that exist and to entries
// that actually name a provider. "Same as the session" is stored as nothing at
// all rather than as an entry full of empty strings.
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
  if (has('sortOrder')) p.sortOrder = Number(input.sortOrder) || 0;

  if (has('setupCommands')) p.setupCommands = asList(input.setupCommands);
  if (has('phpBinDir')) p.phpBinDir = String(input.phpBinDir || '').trim();
  if (has('localDir')) p.localDir = String(input.localDir || '').trim();

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
  // Stored with LF endings whatever they arrive as: a textarea posts LF, a
  // seeded file may have been CRLF, and the two must not read as a change
  // every time the project is opened and saved. The checkouts are forced to LF
  // anyway (core.autocrlf=false), so this is also what the .env should be.
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

  // The QA chain, run in a session of its own by the board's 🎬 QA errand: the
  // test sheet turn, and the test run turn that executes it. The run reads the
  // sheet, so switching it on switches the sheet on with it.
  if (has('reviewTestSheet')) p.reviewTestSheet = !!input.reviewTestSheet;
  if (has('reviewTestRun')) p.reviewTestRun = !!input.reviewTestRun;
  if (p.reviewTestRun) p.reviewTestSheet = true;

  // What this project's errands are about: the GitHub user whose pull requests
  // the board is about, and the provider a review opens on unless the composer
  // says otherwise.
  if (has('reviewAuthor'))
    p.reviewAuthor = String(input.reviewAuthor || '')
      .trim()
      .replace(/^@/, '');
  if (has('reviewProviderId')) {
    const id = Number(input.reviewProviderId);
    p.reviewProviderId = Number.isInteger(id) && id > 0 ? id : null;
  }
  if (has('stepRuntimes')) p.stepRuntimes = normalizeStepRuntimes(input.stepRuntimes);
  // This project's own wording for the prompts it sends. Kept to the templates
  // that exist and to the ones actually filled in: an empty field means "use
  // the global text", so it is stored as no entry at all.
  if (has('promptTemplates')) p.promptTemplates = normalizeTemplates(input.promptTemplates);
  if (has('reviewModel')) p.reviewModel = String(input.reviewModel || '').trim();
  if (has('reviewEffort')) p.reviewEffort = String(input.reviewEffort || '').trim();
  if (has('workerProviderId')) {
    const id = Number(input.workerProviderId);
    p.workerProviderId = Number.isInteger(id) && id > 0 ? id : null;
  }
  if (has('workerModel')) p.workerModel = String(input.workerModel || '').trim();
  if (has('workerEffort')) p.workerEffort = String(input.workerEffort || '').trim();
  if (has('workerBudgetUsd')) {
    // A budget is dollars, positive, or nothing at all; zero and garbage both
    // read as "no cap" rather than as a cap nothing could ever fit under.
    const n = Number(input.workerBudgetUsd);
    p.workerBudgetUsd = Number.isFinite(n) && n > 0 ? n : null;
  }
  if (has('isSelf')) p.isSelf = !!input.isSelf;
  if (p.reviewAuthor && !LOGIN_RE.test(p.reviewAuthor)) {
    throw new Error(`"${p.reviewAuthor}" is not a GitHub username`);
  }
  return p;
}

// Two projects cannot both be the running dashboard, and the tool that
// spawns a fix would have to pick one blindly if they were: the second flag
// is refused, naming the first, rather than silently moved.
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
  const saved = await saveProject({ ...project, id: existing.id });
  await reload();
  return saved;
}

export async function removeProject(id) {
  const removed = await deleteProject(id);
  await reload();
  return removed;
}

// ---------------------------------------------------------------------------
// rendering
// ---------------------------------------------------------------------------

// {token} substitution, used for the serve arguments. Unknown tokens are left
// alone rather than blanked, so a typo shows up in the output instead of
// silently disappearing.
export function render(template, vars) {
  return String(template ?? '').replace(/\{(\w+)\}/g, (whole, key) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : whole,
  );
}
