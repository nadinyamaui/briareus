// @ts-check
import express from 'express';
import fs from 'fs';
import path from 'path';
import { execFile, spawn } from 'child_process';
import { getConfig, ROOT } from './lib/config.js';
import { workerTranscript } from './lib/worker-transcript.js';
import { assetCacheHeaders, pageHandler } from './lib/assets.js';
import { initDb, dbHealthy } from './lib/db.js';
import {
  initJobs,
  setAgentApiBase,
  jobForAgentToken,
  getJob,
  jobEventsSince,
  jobEventsFor,
  deleteJobById,
  publicJob,
  bus,
  listDevSessions,
  createDevSession,
  sendDevMessage,
  cancelDevTurn,
  closeDevSession,
  reopenDevSession,
  setReviewLoop,
  setQaLoop,
  renameDevSession,
  linkPrToSession,
  dropQueuedMessage,
  startDevServe,
  flushJobs,
  spawnWorkerSession,
  workerSessionsFor,
  workerSummary,
  assertWorkerSlot,
  assertWorkerBudget,
  orchestratorBudgetStatus,
  triageLoopFindings,
  retryLoopRound,
  DEV_OPEN,
} from './lib/jobs.js';
import {
  getBinary,
  probeProviderAuth,
  providerAuthAccount,
  claudeUsage,
  claudeHomeDir,
  ensureClaudeHome,
  codexHomeDir,
  ensureCodexHome,
  codexUsage,
  zaiUsage,
  grokHomeDir,
  ensureGrokHome,
  grokUsage,
  opencodeHomeDir,
  refreshCodexModelCache,
  claudeLoginStart,
  claudeLoginFinish,
  testProviderEndpoint,
  probeChatEndpoint,
  verifyCustomEndpoint,
} from './lib/providers.js';
import {
  initProviders,
  listProviders,
  getProvider,
  createProvider,
  updateProvider,
  removeProvider,
  PROVIDER_DEFAULTS,
  captureProviderAuth,
  providerModels,
  providerEfforts,
  providerDefaultModel,
  providerDefaultEffort,
} from './lib/providerstore.js';
import {
  initProjects,
  listProjects,
  activeProjects,
  getProject,
  createProject,
  updateProject,
  removeProject,
  PROJECT_DEFAULTS,
} from './lib/projects.js';
import {
  initDbServers,
  listDbServers,
  createDbServer,
  updateDbServer,
  removeDbServer,
  DB_SERVER_DEFAULTS,
} from './lib/dbservers.js';
import { probeDbServer, claimHolder, sessionCapacity } from './lib/dbpool.js';
import { listActions, getAction } from './lib/actions.js';
import {
  initSavedPrompts,
  listSavedPrompts,
  createSavedPrompt,
  updateSavedPrompt,
  removeSavedPrompt,
} from './lib/savedprompts.js';
import {
  initMemories,
  listMemories,
  findMemory,
  createMemory,
  updateMemory,
  upsertMemory,
  removeMemory,
  removeMemoryByName,
} from './lib/memories.js';
import { initTemplates, globalTemplates, saveGlobalTemplates, templateCatalog } from './lib/templates.js';
import { projectPulls, pullOverview } from './lib/prboard.js';
import { getFindings, decideFinding } from './lib/findings.js';
import { listRepoBranches, githubRest } from './lib/github.js';
import { storeUpload } from './lib/uploads.js';
import { projectUsage, overallUsage } from './lib/usage.js';
import {
  requireAuth,
  authEnabled,
  signedIn,
  signIn,
  signOut,
  verifyCredentials,
  loginBlocked,
  loginFailed,
  loginSucceeded,
} from './lib/auth.js';
import { webhookRouter, installRepoWebhooks } from './lib/webhooks.js';
import { securityHeaders, sameOriginWrites } from './lib/security.js';
import { listWorkspaces, resetSetup, cleanWorkspace } from './lib/workspaces.js';
import { githubWebhookUrl } from './lib/webhooksecrets.js';

// Before anything else: .env has to be complete. Every setting without a
// default names something about this machine (its database, its port, its
// public hostname) and a server that comes up on a guess is worse than one
// that does not come up at all. One line, then out; not a stack trace.
try {
  getConfig();
} catch (e) {
  if (e.code !== 'CONFIG_INCOMPLETE') throw e;
  console.error(e.message);
  process.exit(1);
}

// Where the frontend lives, and the three documents that serve it.
const PUBLIC = path.join(ROOT, 'public');
const loginPage = pageHandler(PUBLIC, 'login.html');

const app = express();
// The only proxy in front of this is a tunnel/reverse proxy on this machine, so
// trust exactly that one hop: it is what makes `req.secure` (and with it the
// Secure flag on the session cookie) reflect the browser's real scheme.
app.set('trust proxy', 'loopback');

// On every response, including the webhooks': the headers that keep the
// dashboard from being framed, sniffed or scripted from another origin.
app.use(securityHeaders);

// Webhooks come first, ahead of both the JSON body parser and the login gate:
// GitHub signs the raw bytes (a re-serialized body verifies against nothing),
// and GitHub cannot sign into a browser session. Each delivery authenticates
// itself instead, with an HMAC over the raw body. See lib/webhooks.js.
app.use('/webhooks', webhookRouter());

// Behind the webhooks (GitHub authenticates itself and sends no Origin),
// ahead of everything a browser cookie could reach: a write whose Origin
// names another site is refused before any handler sees it.
app.use(sameOriginWrites);

app.use(express.json({ limit: '1mb' }));

// Everything below the login gate. Mounted before the static files so pages,
// videos and APIs are all behind it; see lib/auth.js for what stays public.
app.use(requireAuth);

// The sign-in page itself, and the two calls it makes.
app.get('/login', (req, res) => {
  if (!authEnabled() || signedIn(req)) return res.redirect('/');
  return loginPage(req, res);
});

app.post('/api/login', (req, res) => {
  if (!authEnabled()) return res.json({ ok: true });
  const ip = req.ip || 'unknown';
  const wait = loginBlocked(ip);
  if (wait)
    return res.status(429).json({ error: `Too many attempts, try again in ${Math.ceil(wait / 60)} min` });
  const username = String((req.body || {}).username || '');
  const password = String((req.body || {}).password || '');
  if (!username || !password || !verifyCredentials(username, password)) {
    loginFailed(ip);
    // Deliberately vague, and deliberately slow to answer: which half was wrong
    // is exactly what an attacker would like to be told.
    return setTimeout(() => res.status(401).json({ error: 'Wrong username or password' }), 400);
  }
  loginSucceeded(ip);
  signIn(req, res);
  res.json({ ok: true });
});

app.post('/api/logout', (req, res) => {
  signOut(req, res);
  res.json({ ok: true });
});

// Whether the pages should offer a Sign out at all. Off on a local install
// with no login configured.
app.get('/api/auth/state', (req, res) => res.json({ enabled: authEnabled() }));

// For the uptime monitor: no auth (a monitor has no cookie, so the path is on
// the public list) and nothing sensitive in the answer. 200 means the app AND
// its database answer; 503 when MySQL does not, so a paused database shows up
// on the monitor instead of as silently missing session history.
app.get('/healthz', async (req, res) => {
  const db = await dbHealthy();
  res.status(db ? 200 : 503).json({ ok: db, db, uptime: Math.floor(process.uptime()) });
});

// The pages above and below name their scripts with a hash of the script's own
// bytes, so a changed file is a changed URL; see lib/assets.js for why the
// browser cannot be left to work that out for itself.
app.use(express.static(PUBLIC, { setHeaders: assetCacheHeaders(PUBLIC) }));
// three.js, for the office. Served straight out of node_modules rather than
// copied under public/: the package's own build is what the island module
// imports, and its version moves with the lockfile like any other
// dependency. The addons (the water, the bloom pass) live in the package's
// examples tree and import the core as the bare `three`, which the page's
// import map points back here. The addons route goes first: the build route
// would otherwise swallow its prefix and answer 404.
app.use('/vendor/three/addons', express.static(path.join(ROOT, 'node_modules', 'three', 'examples', 'jsm')));
app.use('/vendor/three', express.static(path.join(ROOT, 'node_modules', 'three', 'build')));
// The scenario videos a test run records. The run copies each .webm here and
// links this route from the PR's test sheet, so the evidence outlives the
// session workspace it was recorded in.
fs.mkdirSync(getConfig().testVideosDir, { recursive: true });
app.use('/videos', express.static(getConfig().testVideosDir));

// The spawned CLI does not share the desktop app's login, so surface its auth
// state in the UI instead of letting sessions fail cryptically. Every claude
// entry is a login of its own, kept in its derived config dir: one state per
// dir.
const claudeAuthByDir = new Map(); // config dir -> { checkedAt, loggedIn, authMethod }

// Runs `claude auth status` with the same env sanitization sessions use, so
// the banner reflects the auth state they will actually run with.
function probeClaudeCli(cfg, configDir, apply) {
  const checkedAt = new Date().toISOString();
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  delete env.CLAUDE_CODE_OAUTH_TOKEN;
  delete env.CLAUDE_CONFIG_DIR;
  if (configDir) env.CLAUDE_CONFIG_DIR = configDir;
  try {
    execFile(cfg.claudeBin, ['auth', 'status'], { timeout: 20000, env }, (err, stdout) => {
      try {
        const parsed = JSON.parse(String(stdout).trim());
        apply({ checkedAt, loggedIn: !!parsed.loggedIn, authMethod: parsed.authMethod || null });
      } catch {
        apply({ checkedAt, loggedIn: null, authMethod: 'unknown' });
      }
    });
  } catch {
    // A best-effort probe must never take the server down.
    apply({ checkedAt, loggedIn: null, authMethod: 'check failed' });
  }
}

// One probe per claude entry. Run at boot (once the providers are loaded)
// and again after every provider edit.
function checkClaudeAuth() {
  const cfg = getConfig();
  const checkedAt = new Date().toISOString();
  for (const p of listProviders().filter((r) => r.binary === 'claude' && !r.apiKey)) {
    // Materialize the entry's dir from the database, and adopt whatever fresh
    // login was made in it since the last look, then probe what a session
    // would actually run with.
    const dir = ensureClaudeHome(p);
    captureProviderAuth(p).catch(() => {});
    if (!cfg.claudeBin) {
      claudeAuthByDir.set(dir, { checkedAt, loggedIn: false, authMethod: 'cli not found' });
    } else {
      probeClaudeCli(cfg, dir, (a) => claudeAuthByDir.set(dir, a));
    }
  }
}

// Subscription usage per account (claude, codex and grok logins each have a
// usage endpoint, as does a Z.AI coding-plan key), cached so page loads don't
// hit it more than once a minute.
const usageCache = new Map(); // `binary:account` -> { at, value }
async function providerUsageCached(binaryId, account, read) {
  const key = `${binaryId}:${account || ''}`;
  const hit = usageCache.get(key);
  if (hit && Date.now() - hit.at < 60_000) return hit.value;
  const value = await read();
  usageCache.set(key, { at: Date.now(), value });
  return value;
}

// Z.AI publishes the plan's quota on the same host the sessions run against,
// so the endpoint's URL is what says whether there is anything to read, not
// the binary, which is codex for the Responses wire and claude for the
// Anthropic-shaped one.
function zaiHost(baseUrl) {
  try {
    const host = new URL(baseUrl).hostname;
    return host === 'api.z.ai' || host.endsWith('.bigmodel.cn');
  } catch {
    return false;
  }
}

// The developer chat is the whole app now. Both pages route in the browser, so
// every view inside one has an address of its own and each of those addresses
// serves the same document back: the page reads the path and opens what it
// names. Keep these in step with the paths public/developer.js and
// public/settings.js build, or a link will 404 before the page can read it.
const devPage = pageHandler(PUBLIC, 'developer.html');
const settingsPage = pageHandler(PUBLIC, 'settings.html');

app.get('/', devPage);
app.get('/dashboard', devPage);
app.get('/office', devPage);
app.get('/sessions/:id', devPage);
app.get('/projects/:owner/:name', devPage);
app.get('/projects/:owner/:name/dashboard', devPage);
app.get('/projects/:owner/:name/issues', devPage);
// A branch name may carry slashes of its own (feature/thing), so it is the
// whole tail rather than one segment.
app.get('/projects/:owner/:name/branches/*branch', devPage);

app.get('/settings', (req, res) => res.redirect('/settings/projects'));
for (const section of ['projects', 'providers', 'servers', 'saved-prompts', 'memory']) {
  app.get(`/settings/${section}`, settingsPage);
  app.get(`/settings/${section}/:id`, settingsPage);
}
// The prompts are a single shared row, so the section is the whole address.
app.get('/settings/prompts', settingsPage);
app.get('/settings/workspaces', settingsPage);

// ---- projects ----
//
// A project is a repository a session can be started against, plus everything
// the runner needs to prepare and run it: setup steps, PHP version, its
// session database, the checkout's .env and the ▶ Run commands.

app.get('/api/projects', (req, res) => {
  res.json({ projects: listProjects(), defaults: PROJECT_DEFAULTS });
});

app.post('/api/projects', async (req, res) => {
  try {
    res.status(201).json({ project: await createProject(req.body || {}) });
  } catch (e) {
    res.status(e.status === 503 ? 503 : 400).json({ error: e.message });
  }
});

app.put('/api/projects/:id', async (req, res) => {
  try {
    res.json({ project: await updateProject(Number(req.params.id), req.body || {}) });
  } catch (e) {
    res.status(e.status === 503 ? 503 : 400).json({ error: e.message });
  }
});

app.delete('/api/projects/:id', async (req, res) => {
  try {
    const removed = await removeProject(Number(req.params.id));
    if (!removed) return res.status(404).json({ error: 'Project not found' });
    res.json({ ok: true });
  } catch (e) {
    res.status(e.status === 503 ? 503 : 400).json({ error: e.message });
  }
});

// ---- prompt templates ----

// The wording of everything this app sends out: the PR body it writes and the
// prompt of every errand. A singleton shaped as a one-row list (id 1) so the
// settings page reuses the same select/save plumbing.
//
// `catalog` is what makes the page editable at all: the label, the hint, the
// `{{TOKEN}}`s each template may use and the built-in text an empty field falls
// back on. Sending it means the client never carries a second copy of the
// prompts.
app.get('/api/templates', (req, res) => {
  res.json({
    templates: [{ id: 1, values: globalTemplates() }],
    defaults: { values: {} },
    catalog: templateCatalog(),
  });
});

app.put('/api/templates/1', async (req, res) => {
  try {
    const values = await saveGlobalTemplates((req.body || {}).values || {});
    res.json({ templates: { id: 1, values } });
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message });
  }
});

// ---- saved prompts ----
//
// The composer's kickoff library. With ?repo= it is what that project's
// Prompts menu offers (its own first, then the shared ones); without, the
// whole library the settings page edits.
app.get('/api/dev/prompts', (req, res) => {
  const repo = typeof req.query.repo === 'string' ? req.query.repo : null;
  res.json({ prompts: listSavedPrompts(repo) });
});

app.post('/api/dev/prompts', async (req, res) => {
  try {
    res.status(201).json({ prompt: await createSavedPrompt(req.body || {}) });
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message });
  }
});

app.put('/api/dev/prompts/:id', async (req, res) => {
  try {
    res.json({ prompt: await updateSavedPrompt(Number(req.params.id), req.body || {}) });
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message });
  }
});

app.delete('/api/dev/prompts/:id', async (req, res) => {
  try {
    const removed = await removeSavedPrompt(Number(req.params.id));
    if (!removed) return res.status(404).json({ error: 'Saved prompt not found' });
    res.json({ ok: true });
  } catch (e) {
    res.status(e.status === 503 ? 503 : 400).json({ error: e.message });
  }
});

// ---- project memory ----
//
// Two doors to the same rows. The settings page edits the whole library by id;
// the agent, through the memory tool during a turn, reaches its own
// project's memories by name, authorized by the session's bearer token rather
// than the browser cookie (see requireAuth), and never sees a repo parameter:
// the session decides the project.

app.get('/api/memories', (req, res) => {
  const repo = typeof req.query.repo === 'string' ? req.query.repo : null;
  res.json({ memories: listMemories(repo) });
});

app.post('/api/memories', async (req, res) => {
  try {
    res.status(201).json({ memory: await createMemory(req.body || {}) });
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message });
  }
});

app.put('/api/memories/:id', async (req, res) => {
  try {
    // Edited by hand: the trail no longer points at a session.
    res.json({ memory: await updateMemory(Number(req.params.id), { ...(req.body || {}), jobId: null }) });
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message });
  }
});

app.delete('/api/memories/:id', async (req, res) => {
  try {
    const removed = await removeMemory(Number(req.params.id));
    if (!removed) return res.status(404).json({ error: 'Memory not found' });
    res.json({ ok: true });
  } catch (e) {
    res.status(e.status === 503 ? 503 : 400).json({ error: e.message });
  }
});

function agentSession(req, res) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  const job = jobForAgentToken(token);
  if (!job || !job.repo) {
    res.status(401).json({ error: 'Unknown session token' });
    return null;
  }
  return job;
}

app.get('/api/agent/memories', (req, res) => {
  const job = agentSession(req, res);
  if (!job) return;
  res.json({
    memories: listMemories(job.repo).map(({ name, type, description, updatedAt }) => ({
      name,
      type,
      description,
      updatedAt,
    })),
  });
});

app.get('/api/agent/memories/:name', (req, res) => {
  const job = agentSession(req, res);
  if (!job) return;
  const memory = findMemory(job.repo, req.params.name);
  if (!memory) return res.status(404).json({ error: `No memory named ${req.params.name} on ${job.repo}` });
  res.json({ memory });
});

app.post('/api/agent/memories', async (req, res) => {
  const job = agentSession(req, res);
  if (!job) return;
  try {
    const memory = await upsertMemory(job.repo, { ...(req.body || {}), jobId: job.id });
    res.status(201).json({ memory });
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message });
  }
});

app.delete('/api/agent/memories/:name', async (req, res) => {
  const job = agentSession(req, res);
  if (!job) return;
  try {
    const removed = await removeMemoryByName(job.repo, req.params.name);
    if (!removed) return res.status(404).json({ error: `No memory named ${req.params.name} on ${job.repo}` });
    res.json({ ok: true });
  } catch (e) {
    res.status(e.status === 503 ? 503 : 400).json({ error: e.message });
  }
});

// ---- orchestrator worker routes ----
//
// The worker tools an orchestrator session's turns mount
// (lib/orchestrator-mcp.js, or curl for the CLIs with no MCP flag headless).
// Same authorization shape as the memory routes: the bearer token names the
// session, but only a session created as an orchestrator gets past here, and
// it only ever reaches its own workers, so the token's whole authority is
// "this supervisor and its children".

function orchestratorSession(req, res) {
  const job = agentSession(req, res);
  if (!job) return null;
  if (!job.orchestrator) {
    res.status(403).json({ error: 'Only an orchestrator session can manage worker sessions' });
    return null;
  }
  return job;
}

function workerOf(req, res, orchestrator) {
  const worker = workerSessionsFor(orchestrator).find((j) => j.id === req.params.id);
  if (!worker) {
    res.status(404).json({ error: `No worker session ${req.params.id} under this orchestrator` });
    return null;
  }
  return worker;
}

app.post('/api/agent/sessions', (req, res) => {
  const orchestrator = orchestratorSession(req, res);
  if (!orchestrator) return;
  try {
    // `reviewLoop` is the orchestrator's per-task call on whether the work gets
    // reviewed: armed, every push this worker settles with is reviewed and the
    // findings come back to it as a fix session (lib/jobs.js), all of it filed
    // under this orchestration. `qaLoop` queues the test run behind it.
    // `tooling` is the fix_tooling tool: the worker goes to the project
    // flagged as the dashboard itself, with the review loop armed regardless.
    // `role` is a Zeus analyst's role, which picks the runtime the user chose
    // for it when the session started.
    const { title, prompt, providerId, model, effort, branch, reviewLoop, qaLoop, tooling, role } =
      req.body || {};
    const session = spawnWorkerSession(orchestrator, {
      title,
      prompt,
      providerId,
      model,
      effort,
      branch,
      reviewLoop: reviewLoop === true,
      qaLoop: qaLoop === true,
      tooling: tooling === true,
      role: typeof role === 'string' ? role : undefined,
    });
    res.status(201).json({ session: workerSummary(session) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get('/api/agent/sessions', (req, res) => {
  const orchestrator = orchestratorSession(req, res);
  if (!orchestrator) return;
  res.json({
    sessions: workerSessionsFor(orchestrator).map(workerSummary),
    budget: orchestratorBudgetStatus(orchestrator),
  });
});

app.get('/api/agent/sessions/:id', async (req, res) => {
  const orchestrator = orchestratorSession(req, res);
  if (!orchestrator) return;
  const worker = workerOf(req, res, orchestrator);
  if (!worker) return;
  const events = await workerTranscript(worker, req.query, jobEventsFor);
  res.json({ session: workerSummary(worker), events });
});

app.post('/api/agent/sessions/:id/message', (req, res) => {
  const orchestrator = orchestratorSession(req, res);
  if (!orchestrator) return;
  const worker = workerOf(req, res, orchestrator);
  if (!worker) return;
  try {
    // A message to a closed worker reopens it, which is a spawn in
    // everything but name: the open-worker cap applies to it the same way.
    // And every send runs a worker turn, so the budget gates them all —
    // the user steering a worker directly goes through /api/dev, never here.
    if (!DEV_OPEN.includes(worker.status)) assertWorkerSlot(orchestrator);
    assertWorkerBudget(orchestrator);
    sendDevMessage(worker.id, String((req.body || {}).text || ''));
    res.json({ session: workerSummary(worker) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// The orchestrator's verdicts on the review round its worker's loop is
// holding (lib/jobs.js, holdForTriage): what it marks fix starts the fix
// session, the rest is recorded on the pull request. Nothing here spends a
// worker turn by itself, so neither the slot nor the budget gate applies; the
// fix session it may start is loop spend like every other round's.
app.post('/api/agent/sessions/:id/triage', async (req, res) => {
  const orchestrator = orchestratorSession(req, res);
  if (!orchestrator) return;
  const worker = workerOf(req, res, orchestrator);
  if (!worker) return;
  try {
    const { verdicts, note } = req.body || {};
    const outcome = await triageLoopFindings(worker.id, { verdicts, note });
    res.json({ session: workerSummary(worker), ...outcome });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Re-run a review round that could not run: a review whose provider errored
// (an exhausted account, a non-zero exit) left the loop gated on a commit it
// has already tried once, and a worker whose work is finished has no push left
// to open that gate with. An optional provider/model/effort moves the loop off
// the runtime that failed it. It re-runs a review and never replaces one, so
// nothing here can approve a push; like triage, it spends no worker turn of
// its own, and the review it starts is loop spend like every other round's.
app.post('/api/agent/sessions/:id/retry-review', async (req, res) => {
  const orchestrator = orchestratorSession(req, res);
  if (!orchestrator) return;
  const worker = workerOf(req, res, orchestrator);
  if (!worker) return;
  try {
    const { providerId, model, effort } = req.body || {};
    const outcome = await retryLoopRound(worker.id, { providerId, model, effort });
    res.json({ session: workerSummary(worker), ...outcome });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/agent/sessions/:id/close', async (req, res) => {
  const orchestrator = orchestratorSession(req, res);
  if (!orchestrator) return;
  const worker = workerOf(req, res, orchestrator);
  if (!worker) return;
  try {
    await closeDevSession(worker.id);
    res.json({ session: workerSummary(worker) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ---- review findings ----
//
// The findings a PR's reviews declared (each summary comment carries a
// machine-readable block), joined with the stored fix/optional/dismissed
// verdicts. Deciding "fix" mirrors the set onto the PR as one anchored
// "Required fixes" checklist comment, which a later review ticks as pushes
// actually fix items.

function findingsParams(body) {
  const project = getProject(String(body.repo || ''));
  if (!project) throw Object.assign(new Error(`Unknown project: ${body.repo || ''}`), { status: 404 });
  const prNumber = Number(body.pr);
  if (!Number.isInteger(prNumber) || prNumber < 1) throw new Error('The PR number must be a whole number');
  return { repo: project.repo, prNumber };
}

app.get('/api/pr/findings', async (req, res) => {
  try {
    const { repo, prNumber } = findingsParams(req.query);
    res.json(await getFindings(repo, prNumber));
  } catch (e) {
    res.status(e.status || (e.rateLimited ? 429 : 400)).json({ error: e.message });
  }
});

app.post('/api/pr/findings/decision', async (req, res) => {
  try {
    const { repo, prNumber } = findingsParams(req.body || {});
    const { key, decision } = req.body || {};
    res.json(await decideFinding(repo, prNumber, key, decision || null));
  } catch (e) {
    res.status(e.status === 503 ? 503 : e.status || 400).json({ error: e.message });
  }
});

// ---- database pool ----
//
// The database servers sessions can claim: one session per server at a time,
// each entry a host/port/username/password the operator adds in Settings.

app.get('/api/dbservers', (req, res) => {
  res.json({ servers: listDbServers(), defaults: DB_SERVER_DEFAULTS });
});

// Is this entry healthy? Probes the connection as the form holds it, so an entry
// can be verified before it is saved, and an existing one re-checked without a
// session having to fail on it first. The pool size rides along: it is what
// caps how many sessions may be open at once.
app.post('/api/dbservers/test', async (req, res) => {
  try {
    const { id, host, port, username, password } = req.body || {};
    const probe = await probeDbServer({ host, port, username, password });
    res.json({
      ...probe,
      claimedBy: id ? claimHolder(id) : null,
      capacity: sessionCapacity(),
      poolSize: listDbServers().filter((s) => s.enabled).length,
    });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/dbservers', async (req, res) => {
  try {
    res.status(201).json({ server: await createDbServer(req.body || {}) });
  } catch (e) {
    res.status(e.status === 503 ? 503 : 400).json({ error: e.message });
  }
});

app.put('/api/dbservers/:id', async (req, res) => {
  try {
    res.json({ server: await updateDbServer(Number(req.params.id), req.body || {}) });
  } catch (e) {
    res.status(e.status === 503 ? 503 : 400).json({ error: e.message });
  }
});

app.delete('/api/dbservers/:id', async (req, res) => {
  try {
    const removed = await removeDbServer(Number(req.params.id));
    if (!removed) return res.status(404).json({ error: 'Database server not found' });
    res.json({ ok: true });
  } catch (e) {
    res.status(e.status === 503 ? 503 : 400).json({ error: e.message });
  }
});

// ---- workspace pool ----
//
// Read-only health of the clone slots, plus the two things worth doing to an
// idle one by hand: forgetting its install fingerprints, or dropping its
// dependency trees outright. lib/workspaces.js refuses both with a 409 while
// a session holds the slot; the error handler below turns that into the reply.
app.get('/api/workspaces', async (req, res) => {
  res.json({ workspaces: await listWorkspaces() });
});

app.post('/api/workspaces/:slot/reset-setup', (req, res) => {
  res.json(resetSetup(req.params.slot));
});

app.post('/api/workspaces/:slot/clean', (req, res) => {
  res.json(cleanWorkspace(req.params.slot));
});

// ---- provider settings ----
//
// The providers sessions can be started on: each row links a label to one of
// the hardcoded binaries (claude / codex / grok / opencode) plus its own config: an
// isolated login dir, a custom endpoint and key, model and effort overrides.

// The stored login (auth_data) never leaves the server; the settings page
// only needs to know whether one is registered, and where it lives.
function publicProvider(p) {
  const { authData, ...rest } = p;
  return {
    ...rest,
    hasLogin: !!authData,
    loginDir: !p.id
      ? ''
      : p.binary === 'claude'
        ? claudeHomeDir(p)
        : p.binary === 'codex'
          ? codexHomeDir(p)
          : p.binary === 'opencode'
            ? opencodeHomeDir(p)
            : grokHomeDir(p),
  };
}

app.get('/api/providers', (req, res) => {
  res.json({ providers: listProviders().map(publicProvider), defaults: PROVIDER_DEFAULTS });
});

app.post('/api/providers', async (req, res) => {
  try {
    const provider = await createProvider(req.body || {});
    checkClaudeAuth();
    res.status(201).json({ provider: publicProvider(provider) });
  } catch (e) {
    res.status(e.status === 503 ? 503 : 400).json({ error: e.message });
  }
});

app.put('/api/providers/:id', async (req, res) => {
  try {
    const provider = await updateProvider(Number(req.params.id), req.body || {});
    checkClaudeAuth();
    res.json({ provider: publicProvider(provider) });
  } catch (e) {
    res.status(e.status === 503 ? 503 : 400).json({ error: e.message });
  }
});

app.delete('/api/providers/:id', async (req, res) => {
  try {
    const removed = await removeProvider(Number(req.params.id));
    if (!removed) return res.status(404).json({ error: 'Provider not found' });
    res.json({ ok: true });
  } catch (e) {
    res.status(e.status === 503 ? 503 : 400).json({ error: e.message });
  }
});

// Auth + usage for one provider row, exactly as a session would run it:
// claude entries answer from the cached `claude auth status` probe (plus the
// account's subscription usage), everything else is probed on demand.
async function providerAuthUsage(p, cfg) {
  let auth = null;
  let usage = null;
  const zaiKeyUsage = () =>
    p.apiKey && zaiHost(p.baseUrl)
      ? providerUsageCached('zai', p.apiKey, () => zaiUsage(p.baseUrl, p.apiKey))
      : null;
  if (p.binary === 'claude') {
    if (p.apiKey) {
      // Verified with a live call to the endpoint (Anthropic's or the custom
      // base URL) rather than assumed from the key's presence.
      auth = await verifyCustomEndpoint({
        binary: 'claude',
        baseUrl: p.baseUrl,
        apiKey: p.apiKey,
        model: p.defaultModel || p.models[0] || null,
      });
      usage = await zaiKeyUsage();
    } else {
      const state = claudeAuthByDir.get(claudeHomeDir(p));
      if (state && state.loggedIn != null) {
        auth = {
          loggedIn: state.loggedIn,
          detail: state.authMethod,
          checkedAt: state.checkedAt,
          ...providerAuthAccount('claude', p),
        };
        if (state.loggedIn) {
          const dir = claudeHomeDir(p);
          usage = await providerUsageCached('claude', dir, () => claudeUsage(dir));
        }
      }
    }
  } else {
    auth = await probeProviderAuth(p, cfg);
    if (p.binary === 'codex' && !p.baseUrl && !p.apiKey && auth?.loggedIn) {
      const dir = codexHomeDir(p);
      usage = await providerUsageCached('codex', dir, () => codexUsage(dir));
    } else if (p.binary === 'grok' && auth?.loggedIn) {
      // The login dir is the account here: grok's billing is read with the
      // token `grok login` left in it, exactly as probeProviderAuth found it.
      const dir = grokHomeDir(p);
      usage = await providerUsageCached('grok', dir, () => grokUsage(dir));
    } else {
      usage = await zaiKeyUsage();
    }
  }
  return { auth, usage };
}

// The Status section on the settings page: everything known about one entry's
// connection: account, organization, plan, subscription usage, binary, dir.
app.get('/api/providers/:id/status', async (req, res) => {
  const p = getProvider(Number(req.params.id));
  if (!p) return res.status(404).json({ error: 'Provider not found' });
  const cfg = getConfig();
  const found = getBinary(p.binary).bin(cfg);
  const { auth, usage } = await providerAuthUsage(p, cfg);
  res.json({
    status: {
      available: !!found,
      binSource: found ? found.source : null,
      loginDir: publicProvider(p).loginDir,
      auth,
      usage,
    },
  });
});

// The Test button: probe an endpoint + token exactly as the form holds them
// (no save needed) by listing the endpoint's models. The list comes back so
// the page can drop it into the Models field. A gateway with no model list
// route is probed with a minimal chat call as the form's model instead.
app.post('/api/providers/test', async (req, res) => {
  try {
    const { binary, baseUrl, apiKey, model } = req.body || {};
    try {
      return res.json({ models: await testProviderEndpoint({ binary, baseUrl, apiKey }) });
    } catch (e) {
      if (!e.routeMissing || !model) throw e;
      await probeChatEndpoint({ binary, baseUrl, apiKey, model });
      res.json({ models: [], probedModel: model });
    }
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// A login is registered against the row: it lands in the entry's own derived
// config dir and is mirrored into the database once it arrives (the same
// adoption a boot does). The watcher picks it up whichever way it lands.
const loginWatchers = new Map(); // provider id -> interval

function watchLogin(providerId) {
  clearInterval(loginWatchers.get(providerId));
  let waited = 0;
  const timer = setInterval(async () => {
    waited += 5000;
    const row = getProvider(providerId);
    if (!row || waited > 5 * 60 * 1000) {
      clearInterval(timer);
      loginWatchers.delete(providerId);
      return;
    }
    try {
      const updated = await captureProviderAuth(row);
      if (JSON.stringify(updated.authData) !== JSON.stringify(row.authData)) {
        clearInterval(timer);
        loginWatchers.delete(providerId);
        checkClaudeAuth();
      }
    } catch {
      /* mid-write credentials file: keep watching */
    }
  }, 5000);
  loginWatchers.set(providerId, timer);
}

// The codex and grok browser logins: no console window, since the CLI's login
// command runs hidden with the entry's own home dir and prints the
// authorization URL. codex then waits on its localhost callback (the CLI
// opens the browser tab itself); grok's device flow just waits for the code
// to be confirmed, so the page opens the URL. Either way the CLI writes
// auth.json when the login lands, and the watcher mirrors it into the row.
// One per binary at a time: codex's callback port is fixed.
//
// opencode has no login flow of any kind: its entries authenticate with a
// service API key, handed to the CLI from the row.
const cliLogins = new Map(); // binary -> the in-flight login child process

app.post('/api/providers/:id/login', async (req, res) => {
  const provider = getProvider(Number(req.params.id));
  if (!provider) return res.status(404).json({ error: 'Provider not found' });
  if (provider.binary !== 'codex' && provider.binary !== 'grok') {
    return res.status(400).json({ error: `The ${provider.binary} binary has no login flow here` });
  }
  const found = getBinary(provider.binary).bin(getConfig());
  if (!found)
    return res.status(400).json({ error: `The ${provider.binary} CLI was not found on this machine` });
  const previous = cliLogins.get(provider.binary);
  if (previous) {
    try {
      previous.kill();
    } catch {
      /* already gone */
    }
    cliLogins.delete(provider.binary);
  }
  const env =
    provider.binary === 'codex'
      ? { ...process.env, CODEX_HOME: ensureCodexHome(provider) }
      : { ...process.env, GROK_HOME: ensureGrokHome(provider) };
  // grok's device flow: print the confirm URL and poll, with no localhost callback.
  const loginArgs = provider.binary === 'codex' ? ['login'] : ['login', '--device-auth'];
  let child;
  try {
    child = spawn(found.bin, loginArgs, { env, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    return res.status(500).json({ error: `Could not start ${provider.binary} login: ${e.message}` });
  }
  cliLogins.set(provider.binary, child);
  child.on('exit', () => {
    if (cliLogins.get(provider.binary) === child) cliLogins.delete(provider.binary);
  });
  let output = '';
  const url = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), 20000);
    const scan = (chunk) => {
      output += chunk;
      // The authorization URL is the only https URL in the output; the
      // callback the CLI mentions alongside it is plain http://localhost.
      const m = output.match(/https:\/\/\S+/);
      if (m) {
        clearTimeout(timer);
        resolve(m[0]);
      }
    };
    child.stdout.on('data', scan);
    child.stderr.on('data', scan);
    child.on('exit', () => {
      clearTimeout(timer);
      resolve(null);
    });
  });
  if (!url) {
    try {
      child.kill();
    } catch {
      /* already gone */
    }
    // The login command exits straight away when the dir already holds a login.
    const updated = await captureProviderAuth(provider).catch(() => provider);
    if (updated.authData) return res.json({ ok: true });
    return res.status(500).json({
      error: `${provider.binary} login produced no login URL: ${output.trim().slice(0, 300) || '(no output)'}`,
    });
  }
  watchLogin(provider.id);
  res.json({ url });
});

// The claude browser login: no console window. The settings page opens the
// authorization URL in a browser tab, the user approves on claude.ai and
// pastes the code shown back into the page.
const claudeLogins = new Map(); // provider id -> the in-flight flow's PKCE verifier

app.post('/api/providers/:id/login/start', (req, res) => {
  const provider = getProvider(Number(req.params.id));
  if (!provider) return res.status(404).json({ error: 'Provider not found' });
  if (provider.binary !== 'claude') {
    return res.status(400).json({
      error: `The code-paste login is claude-only; a ${provider.binary} entry logs in through its own flow`,
    });
  }
  const { url, verifier } = claudeLoginStart();
  claudeLogins.set(provider.id, verifier);
  res.json({ url });
});

app.post('/api/providers/:id/login/finish', async (req, res) => {
  const provider = getProvider(Number(req.params.id));
  if (!provider) return res.status(404).json({ error: 'Provider not found' });
  const verifier = claudeLogins.get(provider.id);
  if (!verifier) return res.status(400).json({ error: 'No login in flight; start the login first' });
  try {
    await claudeLoginFinish(provider, String((req.body || {}).code || ''), verifier);
    claudeLogins.delete(provider.id);
    const updated = await captureProviderAuth(provider);
    checkClaudeAuth();
    res.json({ provider: publicProvider(updated) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// The project list the composer's dropdown is built from: enabled projects
// only, in the order the settings page put them in; the first is the default.
// Served on its own so the branch picker can start loading without waiting on
// the provider auth probes, which block on live gateway calls.
app.get('/api/dev/projects', (req, res) => {
  res.json({
    projects: activeProjects().map((p) => ({
      repo: p.repo,
      label: p.label,
      hasLocal: !!p.localDir,
      // What the project dashboard starts its errands on: the review runtime
      // this project was set up with, so the board does not ask again for
      // something Settings already answered. Its PR author is not here; the
      // board learns that from the pull request list, which had to apply the
      // filter anyway.
      reviewProviderId: p.reviewProviderId,
      reviewModel: p.reviewModel || '',
      reviewEffort: p.reviewEffort || '',
    })),
  });
});

// The project dashboard: one project's open pull requests, with the labels the
// review workflow speaks in and the errand each one is asking for, and, on the
// same payload, the repo's open issues, so the board's tabs cost one call.
app.get('/api/dev/pulls', async (req, res) => {
  const project = getProject(req.query.repo || '');
  if (!project) return res.status(404).json({ error: `Unknown project: ${req.query.repo || ''}` });
  try {
    res.json(await projectPulls(project, { fresh: req.query.fresh === '1' }));
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// What a project has spent this calendar month, from the per-turn ledger:
// sessions that ran a turn, tokens in and out, and the cost of the turns whose
// provider priced them.
app.get('/api/dev/usage', async (req, res) => {
  const project = getProject(req.query.repo || '');
  if (!project) return res.status(404).json({ error: `Unknown project: ${req.query.repo || ''}` });
  res.json(await projectUsage(project));
});

// The same ledger with no project filter: the main dashboard, over one of
// lib/usage.js's windows. Disabled projects are in the list on purpose: one
// switched off mid-month still spent what it spent, and leaving it out would
// make the per-project rows fail to add up to the headline totals.
app.get('/api/dev/usage/all', async (req, res) => {
  res.json(await overallUsage(listProjects(), String(req.query.period || 'month')));
});

// One pull request on its own, in the detail the right-hand panel draws: state,
// line changes, commits, linked issues, review verdicts and CI checks. It is
// what the session panel shows for a session's own PR, served here for the
// board drilled into a pull request, which has no session to read it from.
app.get('/api/dev/pull', async (req, res) => {
  const project = getProject(req.query.repo || '');
  if (!project) return res.status(404).json({ error: `Unknown project: ${req.query.repo || ''}` });
  const number = Number(req.query.pr);
  if (!Number.isInteger(number) || number <= 0)
    return res.status(400).json({ error: 'A pull request number is required' });
  try {
    res.json({ pr: await pullOverview(project, number) });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// Which providers a session can be started on, with what models, and whether
// each is logged in, so a dead provider fails in the banner instead of on the
// first message.
app.get('/api/dev/providers', async (req, res) => {
  const cfg = getConfig();
  const providers = await Promise.all(
    listProviders().map(async (p) => {
      const binary = getBinary(p.binary);
      const found = binary.bin(cfg);
      const { auth, usage } = await providerAuthUsage(p, cfg);
      return {
        id: p.id,
        label: p.label,
        binary: p.binary,
        available: !!found,
        binSource: found ? found.source : null,
        models: providerModels(p, cfg),
        defaultModel: providerDefaultModel(p, cfg),
        efforts: providerEfforts(p),
        defaultEffort: providerDefaultEffort(p, cfg),
        auth,
        usage,
      };
    }),
  );
  res.json({ providers });
});

// The branches of one project, for the composer's branch picker: the default
// branch first, then the rest alphabetically.
app.get('/api/dev/branches', async (req, res) => {
  const project = getProject(req.query.repo || '');
  if (!project) return res.status(404).json({ error: `Unknown project: ${req.query.repo || ''}` });
  try {
    res.json(await listRepoBranches(getConfig(), project.repo));
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// Attachment upload: one file per request, the raw bytes as the body and the
// filename in the query. The composer uploads each file as it is attached
// (picked, pasted or dropped) and sends only the returned ids with the
// message. The client always posts application/octet-stream, so the global
// JSON parser never touches these bodies.
app.post('/api/dev/uploads', express.raw({ type: () => true, limit: '25mb' }), (req, res) => {
  try {
    if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: 'Empty file' });
    res.status(201).json({ file: storeUpload(String(req.query.name || ''), req.body) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---- actions ----
//
// ⚡ Actions in the sidebar: errands this app has a prompt for, run on a pull
// request the user names. The list is served so the menu grows with lib/actions.js
// rather than with a second copy of it in the client.

app.get('/api/dev/actions', (req, res) => {
  res.json({ actions: listActions() });
});

// Start an action: look the pull request up (its head branch is what the
// session checks out), then start an ordinary session with the action's prompt.
//
// Where it runs is the action's own call (lib/actions.js): gh-only errands run
// in the project's local checkout (a fresh clone and a pooled database server
// would be claimed for nothing) while an action that has to run the app (the
// test run) gets a workspace clone with the full setup, like a review does.
app.post('/api/dev/actions', async (req, res) => {
  const { action: actionId, repo, prNumber, provider, model, effort, input } = req.body || {};
  const action = getAction(actionId);
  if (!action) return res.status(400).json({ error: `Unknown action: ${actionId}` });
  // An action that asks the user something (✍ Give feedback) is nothing without
  // the answer: starting it empty would send a session off with no errand.
  const answer = String(input == null ? '' : input).trim();
  if (action.input && action.input.required && !answer) {
    return res
      .status(400)
      .json({ error: `${action.label} needs ${action.input.label.toLowerCase()}, and nothing was typed` });
  }
  const project = getProject(repo || '');
  if (!project) return res.status(400).json({ error: `Unknown project: ${repo || ''}` });
  const number = Number(prNumber);
  if (!Number.isInteger(number) || number < 1)
    return res.status(400).json({ error: 'The PR number must be a whole number' });
  const cfg = getConfig();
  if (!cfg.githubToken)
    return res
      .status(400)
      .json({ error: 'No GITHUB_TOKEN is configured, so the pull request cannot be looked up' });
  try {
    const lookup = await githubRest(cfg, 'GET', `/repos/${project.repo}/pulls/${number}`);
    if (lookup.status === 404)
      return res.status(404).json({ error: `${project.repo} has no pull request #${number}` });
    if (!lookup.ok)
      return res
        .status(502)
        .json({ error: `GitHub answered ${lookup.status} reading pull request #${number}` });
    const pr = await lookup.json();
    const branch = pr.head && pr.head.ref;
    if (!branch)
      return res
        .status(502)
        .json({ error: `Pull request #${number} has no head branch; its fork may be gone` });
    const context = {
      repo: project.repo,
      prNumber: number,
      branch,
      baseBranch: (pr.base && pr.base.ref) || '',
      title: pr.title || '',
      project,
      // What the user typed, verbatim; only an action with `input` reads it.
      input: answer,
    };
    // An action's prompt may need the pull request read first (⚙ Implement
    // feedback reads its findings), so it is awaited, and a prompt that
    // refuses (nothing to work on) fails the request instead of starting a
    // session with an empty errand.
    const prompt = await action.prompt(context);
    res.status(201).json({
      session: createDevSession({
        provider,
        model,
        effort,
        repo: project.repo,
        // checkout: false, since the action works on the PR through gh alone, so
        // the local tree stays on whatever branch the developer has out.
        branch: action.checkout === false ? undefined : branch,
        local: (action.workspace || 'local') === 'local',
        prompt,
        // The errand was started from this pull request, so the session is
        // attached to it straight away instead of waiting to spot its URL.
        prNumber: number,
        // …and it is filed under that pull request's branch, whatever branch
        // the checkout it borrows happens to be on.
        prBranch: branch,
        // A one-shot errand that reports on the pull request itself closes when
        // it is done, freeing its clone and database server (lib/actions.js).
        autoClose: action.autoClose === true,
        // 🛠 Implement feedback stays open and arms the same review loop the
        // composer's 🔁 chip does: the fixes it pushes get reviewed, and those
        // findings come back here. Mutually exclusive with autoClose: the
        // loop needs a parent that is still around when the review reports.
        reviewLoop: action.reviewLoop === true,
        title: action.title(context),
        // The errand's own id files the session's spend under it in the usage
        // ledger, so the dashboards can say what kind of work the money bought.
        activity: action.id,
      }),
    });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get('/api/dev/sessions', (req, res) => {
  res.json({ sessions: listDevSessions() });
});

// ---- the office ----
//
// 🏝 The office draws every project as a table on the beach and every open
// session as somebody at one, so it needs all of them at once: the per-session
// stream further down speaks for one conversation, which is the wrong shape.
// What it does not need is the conversation itself, so only the handful of
// record fields a building is drawn from go out.
function officeCard(session) {
  return {
    id: session.id,
    title: session.title || '',
    repo: session.repo || '',
    provider: session.provider || '',
    status: session.status,
    awaitingAnswer: session.awaitingAnswer === true,
    review: session.review === true,
    qa: session.qa === true,
    local: session.local === true,
    // Names only, and under a name of their own: `subagents` on the record is
    // a list of objects the right panel reads, and the office wants the crew
    // standing beside a character, not what each of them was asked.
    crew: (session.subagents || []).map((a) => a.name || 'agent'),
    // Who answers to whom: an orchestrator stands apart from its workers, and
    // the island draws the order it gives when one of them starts a turn.
    orchestrator: session.orchestrator === true,
    parentId: session.parentId || null,
    // The line in the bubble over the character's head: the tool a running
    // turn is on, or the opening of the agent's latest message otherwise.
    lastTool: session.lastTool || null,
    lastText: session.lastText || null,
  };
}

app.get('/api/dev/office/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  // A running turn pushes its record every couple of seconds to move the token
  // counters, and no counter moves a building. Sending only what changed since
  // the last line for that session turns a busy turn from ~30 messages a
  // minute into one per status change.
  const sent = new Map();
  const send = (session) => {
    const wire = JSON.stringify(officeCard(session));
    if (sent.get(session.id) === wire) return;
    sent.set(session.id, wire);
    res.write(`data: ${wire}\n\n`);
  };
  for (const session of listDevSessions()) send(session);
  const onJob = (record) => {
    if (record.kind === 'devchat') send(record);
  };
  bus.on('job', onJob);
  const ping = setInterval(() => res.write(': ping\n\n'), 25000);
  req.on('close', () => {
    clearInterval(ping);
    bus.off('job', onJob);
  });
});

app.post('/api/dev/sessions', (req, res) => {
  // prNumber is the project dashboard's: a review started from a pull request
  // row already knows which one it is, so the review prompt and the session's
  // title can say so instead of making the agent find out.
  // `qa` is the board's 🎬 QA errand: a session of its own that writes the test
  // sheet and executes it.
  // `reviewLoop` arms the review loop on a from-scratch session: every push
  // the session settles with gets an automatic review, whose findings come
  // back to it as a fix turn (capped; see lib/jobs.js).
  // `orchestrator` is the composer's 🧭 mode: a chat-only supervisor with no
  // checkout, whose agent starts and steers worker sessions instead;
  // `workerRuntime` ({ providerId, model, effort }) is what those workers
  // default to, when the start picked one (the board's epic dialog does).
  // `zeus` is the composer's ⚡ mode: the same supervisor, briefed to turn the
  // brief into a GitHub epic through read-only analysts rather than to land
  // code (lib/jobs.js, zeusSystemPrompt); `zeusRoles` is what each analyst
  // role (product, architecture, qa, validator) runs on, when the composer's
  // dialog picked them.
  const {
    provider,
    model,
    effort,
    prompt,
    repo,
    branch,
    review,
    qa,
    local,
    orchestrator,
    zeus,
    workerRuntime,
    zeusRoles,
    attachments,
    prNumber,
    reviewLoop,
    qaLoop,
  } = req.body || {};
  try {
    const number = Number.isInteger(Number(prNumber)) && Number(prNumber) > 0 ? Number(prNumber) : undefined;
    res.status(201).json({
      session: createDevSession({
        provider,
        model,
        effort,
        prompt,
        repo,
        branch,
        review,
        qa,
        local,
        orchestrator: orchestrator === true,
        zeus: zeus === true,
        workerRuntime: workerRuntime && typeof workerRuntime === 'object' ? workerRuntime : null,
        zeusRoles: zeusRoles && typeof zeusRoles === 'object' ? zeusRoles : null,
        attachments,
        prNumber: number,
        reviewLoop: reviewLoop === true,
        qaLoop: qaLoop === true,
      }),
    });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get('/api/dev/sessions/:id', async (req, res) => {
  const job = getJob(req.params.id);
  if (!job || job.kind !== 'devchat') return res.status(404).json({ error: 'Session not found' });
  const since = Number(req.query.since || 0);
  // A session from before the last restart has its log in the database, not in
  // memory; jobEventsFor reads back whichever applies.
  res.json({ session: publicJob(job), events: await jobEventsFor(job, since) });
});

app.get('/api/dev/sessions/:id/events', (req, res) => {
  const job = getJob(req.params.id);
  if (!job || job.kind !== 'devchat') return res.status(404).json({ error: 'Session not found' });
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  // id: lets EventSource resume via Last-Event-ID after a dropped connection
  // instead of replaying (and duplicating) everything since page load.
  const send = (event) => res.write(`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`);
  const since = Number(req.headers['last-event-id'] ?? req.query.since ?? 0);
  for (const e of jobEventsSince(job, since)) send(e);
  const onEvent = (jobId, event) => {
    if (jobId === job.id) send(event);
  };
  bus.on('event', onEvent);
  // The session record itself, pushed on every change the server makes to it:
  // a PR sync, a context probe, the live token counters during a turn. No `id:`
  // on these: the Last-Event-ID cursor belongs to the numbered event log, and a
  // record push is a snapshot, worthless to replay. The right panel redraws
  // from them instead of waiting for the next sessions poll.
  const onJob = (record) => {
    if (record.id !== job.id) return;
    res.write(`event: session\ndata: ${JSON.stringify(record)}\n\n`);
  };
  bus.on('job', onJob);
  const ping = setInterval(() => res.write(': ping\n\n'), 25000);
  req.on('close', () => {
    clearInterval(ping);
    bus.off('event', onEvent);
    bus.off('job', onJob);
  });
});

// A message mid-turn is queued rather than refused, and one to a session that
// let go of its workspace reopens it first, so this only fails on a message
// the session could not accept at all.
app.post('/api/dev/sessions/:id/message', (req, res) => {
  try {
    const { text, attachments, zeusRoles } = req.body || {};
    res.json({ session: sendDevMessage(req.params.id, text, attachments, zeusRoles) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Session metadata edits do not wake the agent: they only change how this
// conversation is filed in the dashboard.
app.patch('/api/dev/sessions/:id', (req, res) => {
  try {
    res.json({ session: renameDevSession(req.params.id, req.body?.title) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Manual recovery for a PR that automatic branch/URL discovery missed. The
// jobs layer reads GitHub and verifies the branch before storing the link.
app.post('/api/dev/sessions/:id/link-pr', async (req, res) => {
  try {
    res.json({ session: await linkPrToSession(req.params.id, req.body?.pr) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Take a queued message back before the session gets to it.
app.delete('/api/dev/sessions/:id/queue/:index', (req, res) => {
  try {
    const dropped = dropQueuedMessage(req.params.id, Number(req.params.index));
    res.json({ ok: true, dropped, session: publicJob(getJob(req.params.id)) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// 🔁 Review loop: arm or disarm it on a session that is already running. The
// composer's chip only speaks for a session that does not exist yet, and
// wanting the reviews is usually something the work teaches you.
app.post('/api/dev/sessions/:id/loop', (req, res) => {
  try {
    const { on } = req.body || {};
    res.json({ session: setReviewLoop(req.params.id, on === true) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// 🎬 QA loop: the second live chip, queued behind an armed review loop. It is
// armed independently because not every reviewed task should spend a QA run.
app.post('/api/dev/sessions/:id/qa-loop', (req, res) => {
  try {
    const { on } = req.body || {};
    res.json({ session: setQaLoop(req.params.id, on === true) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Reopen a closed / interrupted / failed session: its workspace clone and
// database server are claimed again, without a message to the agent.
app.post('/api/dev/sessions/:id/reopen', (req, res) => {
  try {
    res.json({ session: reopenDevSession(req.params.id) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ▶ Run: serve the session's checkout and hand back the URL for a new tab.
app.post('/api/dev/sessions/:id/serve', async (req, res) => {
  try {
    res.json(await startDevServe(req.params.id));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/dev/sessions/:id/cancel', (req, res) => {
  const session = cancelDevTurn(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  res.json({ session });
});

app.post('/api/dev/sessions/:id/close', async (req, res) => {
  const session = await closeDevSession(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  res.json({ session });
});

// Delete = close (release the clone and MySQL instance) then trash the record
// and its log.
app.delete('/api/dev/sessions/:id', async (req, res) => {
  const job = getJob(req.params.id);
  if (!job || job.kind !== 'devchat') return res.status(404).json({ error: 'Session not found' });
  try {
    await closeDevSession(req.params.id);
    await deleteJobById(req.params.id);
    res.json({ ok: true });
  } catch (e) {
    res.status(e.status === 503 ? 503 : 502).json({ error: e.message });
  }
});

// Express 5 forwards a rejected async handler here instead of leaving the
// request hanging, so the last resort has to answer in the shape the pages
// parse; otherwise a throw nobody caught reaches the UI as a bare "HTTP 500"
// instead of what actually went wrong. Malformed request bodies land here too.
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  console.error(`${req.method} ${req.originalUrl} failed:`, err);
  res.status(err.status || err.statusCode || 500).json({ error: err.message || 'Server error' });
});

const cfg = getConfig();
// --port overrides .env PORT so a second instance can run alongside the first.
const portFlag = process.argv.indexOf('--port');
const port = portFlag !== -1 ? Number(process.argv[portFlag + 1]) : cfg.port;

// Connect, then load the projects and the stored sessions before serving: both
// live in the database and nowhere else, so a database that is down is worth
// one clear line in the log rather than a confusing failure on the first
// message. The server still comes up: the settings page is how you would find
// out what is wrong.
(async () => {
  try {
    await initDb();
    await initTemplates();
    await initProjects();
    await initDbServers();
    await initSavedPrompts();
    await initMemories();
    await initProviders();
    // Each login-backed Codex row has an isolated CODEX_HOME. Refresh those
    // catalogs before jobs and the composer resolve their available models;
    // a logged-out account or a network failure leaves its last cache usable.
    await Promise.all(
      listProviders()
        .filter((p) => p.binary === 'codex' && !p.baseUrl && !p.apiKey)
        .map((p) =>
          refreshCodexModelCache(p, cfg)
            .then((models) => console.log(`Refreshed ${models.length} Codex models for "${p.label}"`))
            .catch((e) => console.error(`Could not refresh Codex models for "${p.label}":`, e.message)),
        ),
    );
  } catch (e) {
    console.error('Database unavailable:', e.message);
    console.error('  projects and sessions live in the database; neither loads until it is reachable');
  }
  // Providers come from the database, so the login probes can only run once
  // the rows are loaded.
  checkClaudeAuth();
  await initJobs();
  // Every project gets (or keeps) a hook pointing at this install's public
  // hostname, so an open session's pull request panel keeps up with the reviews,
  // comments and CI runs landing on its branch. Best effort: a repo whose hook
  // cannot be installed just falls back to the twenty-second sync tick.
  await installRepoWebhooks(activeProjects(), cfg, githubRest).catch((e) =>
    console.error('Could not install GitHub webhooks:', e.message),
  );
  // The memory tool the turns spawn phones home here, on the loopback address,
  // whatever PUBLIC_BASE_URL says, since it runs on this machine.
  setAgentApiBase(`http://127.0.0.1:${port}`);
  app.listen(port, cfg.bindHost, () => {
    const projects = activeProjects();
    console.log(`Briareus running at http://localhost:${port}`);
    console.log(
      `  projects: ${projects.length ? projects.map((p) => p.repo).join(', ') : 'none, add one at /settings/projects'}`,
    );
    console.log(`  database: mysql://${cfg.db.user}@${cfg.db.host}:${cfg.db.port}/${cfg.db.database}`);
    console.log(
      `  claude: ${cfg.claudeBin || 'NOT FOUND, set CLAUDE_BIN in .env'}${cfg.claudeBinSource ? ` (${cfg.claudeBinSource})` : ''}`,
    );
    console.log(
      `  token: ${cfg.githubToken ? 'configured' : 'missing, set GITHUB_TOKEN in .env for PR sync and gh'}`,
    );
    console.log(
      `  login: ${
        authEnabled()
          ? 'on, every request needs the password'
          : 'OFF, anything that reaches this port is trusted; run `npm run set-password` before exposing it'
      }`,
    );
    console.log(
      `  webhooks: ${
        githubWebhookUrl()
          ? `github → ${githubWebhookUrl()}`
          : 'off, PUBLIC_BASE_URL is not a public https hostname, so session panels sync on the timer alone'
      }`,
    );
  });
})();

// The last half second of a turn is still on the write queue when a restart
// arrives, and the database is the only place it can go.
let stopping = false;
// A crash anywhere (a stream error with no handler, a throw inside a timer)
// must not take that queue down with it: a session created moments before
// simply vanishes (its first flush never ran). Write what is queued, then die
// so pm2 restarts a clean process.
process.on('uncaughtException', (e) => {
  console.error('Uncaught exception:', e);
  const giveUp = setTimeout(() => process.exit(1), 3000);
  flushJobs()
    .catch(() => {})
    .finally(() => {
      clearTimeout(giveUp);
      process.exit(1);
    });
});
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    if (stopping) process.exit(1); // a second Ctrl-C means "now"
    stopping = true;
    flushJobs()
      .catch((e) => console.error('Could not write the last sessions on shutdown:', e.message))
      .finally(() => process.exit(0));
  });
}
