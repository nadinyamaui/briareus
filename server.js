// @ts-check
import express from 'express';
import { createDeploymentService } from './lib/deployments.js';
import { deploymentRoutes } from './lib/deployment-routes.js';
import { createForgeClient } from './lib/forge.js';
import { forgeRoutes } from './lib/forge-routes.js';
import { createEnvoyerService } from './lib/envoyer.js';
import { envoyerRoutes } from './lib/envoyer-routes.js';
import { createForgeAccounts } from './lib/forge-accounts.js';
import { taskHistoryRoutes } from './lib/task-history-routes.js';
import { estimateCosts } from './lib/prices.js';
import { previewFeedbackRoutes } from './lib/preview-feedback.js';
import { initMemorySelection } from './lib/memory-selection.js';
import { memoryMaintenanceRoutes } from './lib/memory-maintenance-routes.js';
import { operationsRoutes } from './lib/operations-routes.js';
import { createMobileAuth } from './lib/mobile-auth.js';
import { apiV1Routes } from './lib/api-v1.js';
import { createSshService } from './lib/ssh.js';
import { sshRoutes } from './lib/ssh-routes.js';
import { sessionWebhookRoutes } from './lib/webhook-routes.js';
import { sessionTranscriptRoutes } from './lib/transcript-routes.js';
import { providerTestRoutes } from './lib/provider-test-routes.js';
import { sessionEditRoute } from './lib/session-edit-route.js';
import fs from 'fs';
import { execFile, spawn } from 'child_process';
import { getConfig } from './lib/config.js';
import { maintenanceState } from './lib/recovery.js';
import { workerTranscript } from './lib/worker-transcript.js';
import { initDb, dbHealthy, loadTaskSessions, loadJobTurnUsage } from './lib/db.js';
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
  devSessionRecords,
  createDevSession,
  sendDevMessage,
  cancelDevTurn,
  compactDevSession,
  clearDevTranscript,
  visibleEvents,
  closeDevSession,
  reopenDevSession,
  setReviewLoop,
  setQaLoop,
  renameDevSession,
  setDevSessionAutoCompact,
  setDevSessionCompactInstructions,
  linkPrToSession,
  dropQueuedMessage,
  startDevServe,
  startPullRequestPreview,
  flushJobs,
  stopAllDevServes,
  spawnWorkerSession,
  workerSessionsFor,
  workerSummary,
  assertWorkerSlot,
  sessionWebhookState,
  setSessionWebhook,
  rotateSessionWebhook,
  triageLoopFindings,
  triageReviewFindings,
  saveReviewFindingsDrafts,
  deleteReviewFinding,
  replyToReviewFinding,
  retryLoopRound,
  DEV_OPEN,
} from './lib/jobs.js';
import {
  getBinary,
  probeProviderAuth,
  providerAuthAccount,
  claudeHomeDir,
  ensureClaudeHome,
  codexHomeDir,
  ensureCodexHome,
  grokHomeDir,
  ensureGrokHome,
  opencodeHomeDir,
  refreshCodexModelCache,
  claudeLoginStart,
  claudeLoginFinish,
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
  providerModelEfforts,
  providerDefaultModel,
  providerDefaultEffort,
  providerGroups,
  runtimeCatalog,
} from './lib/providerstore.js';
import {
  providerUsage,
  zaiHost,
  rememberProviderAuth,
  cachedProviderAuth,
  forgetProviderUsage,
} from './lib/balancer.js';
import {
  initProjects,
  listProjects,
  activeProjects,
  getProject,
  createProject,
  updateProject,
  removeProject,
  reorderProjects,
  PROJECT_DEFAULTS,
  reviewerRuntime,
  stepRuntime,
} from './lib/projects.js';
import { projectRunProfiles } from './lib/runprofiles.js';
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
import { closeIssue, projectPulls, pullOverview } from './lib/prboard.js';
import { commitView, mergePullRequest, pullRequestView, pullRequestViewOptions } from './lib/prviewer.js';
import { getFindings, decideFinding } from './lib/findings.js';
import { listRepoBranches, githubRest } from './lib/github.js';
import { storeUpload, getUpload } from './lib/uploads.js';
import { transcribe, transcribeAvailable } from './lib/transcribe.js';
import { previewAccess } from './lib/tunnel.js';
import { projectUsage, overallUsage, jobUsageEstimates, estimateEventCosts } from './lib/usage.js';
import { agentOnly, apiEnabled } from './lib/auth.js';
import { webhookRouter, installRepoWebhooks } from './lib/webhooks.js';
import { localUpdater } from './lib/local-update.js';
import { securityHeaders } from './lib/security.js';
import { listWorkspaces, resetSetup, cleanWorkspace, startWorkspacePruner } from './lib/workspaces.js';
import { githubWebhookUrl, sessionWebhookKey, sessionWebhookUrl } from './lib/webhooksecrets.js';
import { childEnv } from './lib/childenv.js';

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

const app = express();
// The only proxy in front of this is a tunnel/reverse proxy on this machine, so
// trust exactly that one hop: it is what makes `req.ip` the caller's address
// rather than the proxy's.
app.set('trust proxy', 'loopback');

// The API handlers live on a router of their own rather than on the app,
// because nothing reaches them by their own paths any more. /api/v1 hands a
// client's request to them once its bearer token has been judged
// (lib/api-v1.js), and an agent reaches its own under /api/agent/.
const api = express.Router();

// On every response, including the webhooks': nothing here is a page, and the
// headers say so (lib/security.js).
app.use(securityHeaders);

// Webhooks come first, ahead of the JSON body parser: GitHub signs the raw
// bytes (a re-serialized body verifies against nothing). Each delivery
// authenticates itself with an HMAC over the raw body. See lib/webhooks.js.
app.use('/webhooks', webhookRouter());

// The client API, and the only one: owner-issued tokens (`npm run
// create-token`, the only place tokens are issued or listed), in front of the
// handlers below.
const mobileAuth = createMobileAuth();
app.use(
  apiV1Routes({
    auth: mobileAuth,
    apiEnabled,
    ownerSecret: () => getConfig().auth.secret,
    handlers: api,
    getJob,
    getProject,
    listSessions: listDevSessions,
    bus,
    reviewerRuntime,
    stepRuntime,
    transcribeAvailable,
    previewAccess,
  }),
);
app.use(express.json({ limit: '1mb' }));

// Of all the handlers added for the rest of this file, only an agent's own are
// answered at their own path.
app.use(agentOnly(api));

// What the built-in pages used to call. Said in JSON, and with where to go,
// because the caller is a script that would otherwise be handed a 404 page.
app.use('/api', (req, res) =>
  res.status(410).json({ error: 'This route is retired. Call /api/v1 with a token: see docs/api-v1.md' }),
);

// For the uptime monitor: no auth, and nothing sensitive in the answer. 200 means the app AND
// its database answer; 503 when MySQL does not, so a paused database shows up
// on the monitor instead of as silently missing session history.
app.get('/healthz', async (req, res) => {
  const db = await dbHealthy();
  res.status(db ? 200 : 503).json({ ok: db, db, uptime: Math.floor(process.uptime()) });
});

// The scenario videos a test run records. The run copies each .webm here, and
// a client fetches one through /api/v1 with its token; the links a run leaves
// on a pull request point there too, unless an R2 bucket serves them instead
// (lib/prtasks.js).
fs.mkdirSync(getConfig().testVideosDir, { recursive: true });
api.use('/videos', express.static(getConfig().testVideosDir));

// The spawned CLI does not share the desktop app's login, so surface its auth
// state in the UI instead of letting sessions fail cryptically. Every claude
// entry is a login of its own, kept in its derived config dir: one state per
// dir.
const claudeAuthByDir = new Map(); // config dir -> { checkedAt, loggedIn, authMethod }

// Runs `claude auth status` with the same env sanitization sessions use, so
// the banner reflects the auth state they will actually run with.
function probeClaudeCli(cfg, configDir, apply) {
  const checkedAt = new Date().toISOString();
  const env = childEnv();
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

// One probe per claude entry, and the same for the other login-backed
// binaries below. Run at boot (once the providers are loaded), after every
// provider edit, and on a timer: a login made from a terminal (or a token one
// of the account's own sessions refreshed) changes nothing the server can see,
// and the balancer ranks an account it remembers as logged out behind one at
// its limit, so the memory has to be renewed to stay honest. The timer is
// inside the balancer's AUTH_TTL_MS, so a probe is always fresh enough to
// count.
const AUTH_RECHECK_MS = 5 * 60_000;

function checkClaudeAuth() {
  const cfg = getConfig();
  const checkedAt = new Date().toISOString();
  for (const p of listProviders().filter((r) => r.active && r.binary === 'claude' && !r.apiKey)) {
    // Materialize the entry's dir from the database, and adopt whatever fresh
    // login was made in it since the last look, then probe what a session
    // would actually run with.
    const dir = ensureClaudeHome(p);
    captureProviderAuth(p).catch(() => {});
    // The balancer hears the result too, so a session started before anyone
    // opens the composer already knows not to start on a logged-out account.
    const record = (a) => {
      claudeAuthByDir.set(dir, a);
      rememberProviderAuth(p.id, a.loggedIn, Date.parse(a.checkedAt));
    };
    if (!cfg.claudeBin) {
      record({ checkedAt, loggedIn: false, authMethod: 'cli not found' });
    } else {
      probeClaudeCli(cfg, dir, record);
    }
  }
}

// The other binaries that log in per entry. Their probe is a look for the
// login file the CLI wrote (probeProviderAuth, codex and grok), so putting
// them on the same timer costs a stat call per row, and leaving them off it
// costs correctness: nothing else refreshes their login state, so the
// balancer's memory of a logged-out codex or grok account expires ten minutes
// after the last page load and the row ranks as if it were fine again. Rows
// with a key or a custom endpoint are left out — theirs is a live call to the
// endpoint, which belongs on a page's request rather than on a timer.
function checkLoginAuth() {
  const cfg = getConfig();
  for (const p of listProviders().filter(
    (r) => r.active && (r.binary === 'codex' || r.binary === 'grok') && !r.baseUrl && !r.apiKey,
  )) {
    probeProviderAuth(p, cfg)
      .then((a) => a && rememberProviderAuth(p.id, a.loggedIn))
      .catch(() => {
        /* a best-effort probe never fails a request or the boot */
      });
  }
}

// Every login-backed row's auth state, refreshed together: what the settings
// page shows for a claude entry, and what the balancer ranks on for all of
// them.
function checkProviderAuth() {
  checkClaudeAuth();
  checkLoginAuth();
}

// ---- projects ----
//
// A project is a repository a session can be started against, plus everything
// the runner needs to prepare and run it: setup steps, PHP version, its
// session database, the checkout's .env and the ▶ Run commands.

api.get('/api/projects', (req, res) => {
  res.json({ projects: listProjects(), defaults: PROJECT_DEFAULTS });
});

api.post('/api/projects', async (req, res) => {
  try {
    res.status(201).json({ project: await createProject(req.body || {}) });
  } catch (e) {
    res.status(e.status === 503 ? 503 : 400).json({ error: e.message });
  }
});

// Before /:id, which would otherwise take "order" for an id.
api.put('/api/projects/order', async (req, res) => {
  try {
    res.json({ projects: await reorderProjects((req.body || {}).ids) });
  } catch (e) {
    res.status(e.status === 503 || e.status === 409 ? e.status : 400).json({ error: e.message });
  }
});

api.put('/api/projects/:id', async (req, res) => {
  try {
    res.json({ project: await updateProject(Number(req.params.id), req.body || {}) });
  } catch (e) {
    res.status(e.status === 503 ? 503 : 400).json({ error: e.message });
  }
});

api.delete('/api/projects/:id', async (req, res) => {
  try {
    const removed = await removeProject(Number(req.params.id));
    if (!removed) return res.status(404).json({ error: 'Project not found' });
    res.json({ ok: true });
  } catch (e) {
    res.status(e.status === 503 ? 503 : 400).json({ error: e.message });
  }
});

// The local checkout's auto-update (lib/local-update.js): how its last run
// went, and Settings' "Update now".
const projectRepo = (id) => (listProjects().find((p) => p.id === Number(id)) || {}).repo;

api.get('/api/projects/:id/update', async (req, res) => {
  const repo = projectRepo(req.params.id);
  if (!repo) return res.status(404).json({ error: 'Project not found' });
  res.json({ status: await localUpdater().status(repo) });
});

api.post('/api/projects/:id/update', async (req, res) => {
  const repo = projectRepo(req.params.id);
  if (!repo) return res.status(404).json({ error: 'Project not found' });
  try {
    res.status(202).json({ status: await localUpdater().runNow(repo) });
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message });
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
api.get('/api/templates', (req, res) => {
  res.json({
    templates: [{ id: 1, values: globalTemplates() }],
    defaults: { values: {} },
    catalog: templateCatalog(),
  });
});

api.put('/api/templates/1', async (req, res) => {
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
api.get('/api/dev/prompts', (req, res) => {
  const repo = typeof req.query.repo === 'string' ? req.query.repo : null;
  res.json({ prompts: listSavedPrompts(repo) });
});

api.post('/api/dev/prompts', async (req, res) => {
  try {
    res.status(201).json({ prompt: await createSavedPrompt(req.body || {}) });
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message });
  }
});

api.put('/api/dev/prompts/:id', async (req, res) => {
  try {
    res.json({ prompt: await updateSavedPrompt(Number(req.params.id), req.body || {}) });
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message });
  }
});

api.delete('/api/dev/prompts/:id', async (req, res) => {
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
// Two doors to the same rows. A client edits the whole library by id through
// /api/v1; the agent, through the memory tool during a turn, reaches its own
// project's memories by name, authorized by the session's bearer token (see
// agentOnly in lib/auth.js), and never sees a repo parameter:
// the session decides the project.

api.get('/api/memories', (req, res) => {
  const repo = typeof req.query.repo === 'string' ? req.query.repo : null;
  res.json({ memories: listMemories(repo) });
});

api.post('/api/memories', async (req, res) => {
  try {
    res.status(201).json({ memory: await createMemory(req.body || {}) });
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message });
  }
});

api.put('/api/memories/:id', async (req, res) => {
  try {
    // Edited by hand: the trail no longer points at a session.
    res.json({ memory: await updateMemory(Number(req.params.id), { ...(req.body || {}), jobId: null }) });
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message });
  }
});

api.delete('/api/memories/:id', async (req, res) => {
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

const sshService = createSshService({ getJob });
api.use(sshRoutes({ service: sshService, agentSession, getProject }));
api.use(
  operationsRoutes({ listSessions: devSessionRecords, ssh: sshService, getJob, sendMessage: sendDevMessage }),
);

api.use(memoryMaintenanceRoutes({ listMemories, updateMemory }));
api.use(previewFeedbackRoutes({ getJob, getUpload, sendMessage: sendDevMessage }));
api.use(
  taskHistoryRoutes({
    loadSnapshots: loadTaskSessions,
    listSessions: listDevSessions,
    loadUsage: loadJobTurnUsage,
    estimateCosts,
  }),
);

api.use(
  deploymentRoutes({
    service: createDeploymentService(),
    getProject,
    readyForSelfDeploy: () => maintenanceState(listDevSessions(), sshService.runningCount()).ready,
  }),
);
const envoyerService = createEnvoyerService();
api.use(envoyerRoutes({ service: envoyerService, getProject }));
const forgeAccounts = createForgeAccounts();
api.use(
  forgeRoutes({
    accounts: forgeAccounts,
    client: createForgeClient({ account: (id) => forgeAccounts.credentials(id) }),
    getProject,
  }),
);

api.get('/api/agent/memories', (req, res) => {
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

api.get('/api/agent/memories/:name', (req, res) => {
  const job = agentSession(req, res);
  if (!job) return;
  const memory = findMemory(job.repo, req.params.name);
  if (!memory) return res.status(404).json({ error: `No memory named ${req.params.name} on ${job.repo}` });
  res.json({ memory });
});

api.post('/api/agent/memories', async (req, res) => {
  const job = agentSession(req, res);
  if (!job) return;
  try {
    const memory = await upsertMemory(job.repo, { ...(req.body || {}), jobId: job.id });
    res.status(201).json({ memory });
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message });
  }
});

api.delete('/api/agent/memories/:name', async (req, res) => {
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

api.post('/api/agent/sessions', (req, res) => {
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

api.get('/api/agent/sessions', (req, res) => {
  const orchestrator = orchestratorSession(req, res);
  if (!orchestrator) return;
  res.json({ sessions: workerSessionsFor(orchestrator).map(workerSummary) });
});

api.get('/api/agent/sessions/:id', async (req, res) => {
  const orchestrator = orchestratorSession(req, res);
  if (!orchestrator) return;
  const worker = workerOf(req, res, orchestrator);
  if (!worker) return;
  const events = await workerTranscript(worker, req.query, jobEventsFor);
  res.json({ session: workerSummary(worker), events });
});

api.post('/api/agent/sessions/:id/message', (req, res) => {
  const orchestrator = orchestratorSession(req, res);
  if (!orchestrator) return;
  const worker = workerOf(req, res, orchestrator);
  if (!worker) return;
  try {
    // A message to a closed worker reopens it, which is a spawn in
    // everything but name: the open-worker cap applies to it the same way.
    if (!DEV_OPEN.includes(worker.status)) assertWorkerSlot(orchestrator);
    sendDevMessage(worker.id, String((req.body || {}).text || ''));
    res.json({ session: workerSummary(worker) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// The orchestrator's verdicts on the review round its worker's loop is
// holding (lib/jobs.js, holdForTriage): what it marks fix starts the fix
// session, the rest is recorded on the pull request. Nothing here spends a
// worker turn by itself, so the slot gate does not apply.
api.post('/api/agent/sessions/:id/triage', async (req, res) => {
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
api.post('/api/agent/sessions/:id/retry-review', async (req, res) => {
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

api.post('/api/agent/sessions/:id/close', async (req, res) => {
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
  if (!Number.isInteger(prNumber) || prNumber < 1)
    throw Object.assign(new Error('The PR number must be a whole number'), { status: 400 });
  return { repo: project.repo, prNumber };
}

api.get('/api/pr/view', async (req, res) => {
  try {
    const { repo, prNumber } = findingsParams(req.query);
    res.json(await pullRequestView({ repo }, prNumber, pullRequestViewOptions(req.query)));
  } catch (e) {
    res.status(e.status || (e.rateLimited ? 429 : 502)).json({ error: e.message });
  }
});

api.post('/api/pr/merge', async (req, res) => {
  try {
    const { repo, prNumber } = findingsParams(req.body || {});
    const { method, headSha, baseRef } = req.body || {};
    res.json(
      await mergePullRequest({ repo }, prNumber, {
        // A request without a method gets mergePullRequest's squash default.
        ...(method ? { method: String(method) } : {}),
        headSha: String(headSha || ''),
        baseRef: String(baseRef || ''),
      }),
    );
  } catch (e) {
    res.status(e.status || (e.rateLimited ? 429 : 502)).json({ error: e.message });
  }
});

// Closing an issue is the board's other write besides merging, so it sits
// beside the merge and answers GitHub's refusals the same way.
api.post('/api/issues/close', async (req, res) => {
  try {
    const body = req.body || {};
    const project = getProject(String(body.repo || ''));
    if (!project) throw Object.assign(new Error(`Unknown project: ${body.repo || ''}`), { status: 404 });
    const number = Number(body.issue);
    if (!Number.isInteger(number) || number < 1)
      throw Object.assign(new Error('The issue number must be a whole number'), { status: 400 });
    if (body.comment != null && typeof body.comment !== 'string')
      throw Object.assign(new Error('The comment must be a string'), { status: 400 });
    res.json(
      await closeIssue({ repo: project.repo }, number, {
        ...(body.reason ? { reason: String(body.reason) } : {}),
        comment: (body.comment || '').trim(),
      }),
    );
  } catch (e) {
    res.status(e.status || (e.rateLimited ? 429 : 502)).json({ error: e.message });
  }
});

// One commit of the project's repository, with the files it changed: what a
// pull request's commit list links to.
api.get('/api/pr/commit', async (req, res) => {
  try {
    const project = getProject(String(req.query.repo || ''));
    if (!project) throw Object.assign(new Error(`Unknown project: ${req.query.repo || ''}`), { status: 404 });
    res.json(await commitView({ repo: project.repo }, String(req.query.sha || '')));
  } catch (e) {
    res.status(e.status || (e.rateLimited ? 429 : 502)).json({ error: e.message });
  }
});

api.get('/api/pr/findings', async (req, res) => {
  try {
    const { repo, prNumber } = findingsParams(req.query);
    res.json(await getFindings(repo, prNumber));
  } catch (e) {
    res.status(e.status || (e.rateLimited ? 429 : 400)).json({ error: e.message });
  }
});

api.post('/api/pr/findings/decision', async (req, res) => {
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

api.get('/api/dbservers', (req, res) => {
  res.json({ servers: listDbServers(), defaults: DB_SERVER_DEFAULTS });
});

// Is this entry healthy? Probes the connection as the form holds it, so an entry
// can be verified before it is saved, and an existing one re-checked without a
// session having to fail on it first. The pool size rides along: it is what
// caps how many sessions may be open at once.
api.post('/api/dbservers/test', async (req, res) => {
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

api.post('/api/dbservers', async (req, res) => {
  try {
    res.status(201).json({ server: await createDbServer(req.body || {}) });
  } catch (e) {
    res.status(e.status === 503 ? 503 : 400).json({ error: e.message });
  }
});

api.put('/api/dbservers/:id', async (req, res) => {
  try {
    res.json({ server: await updateDbServer(Number(req.params.id), req.body || {}) });
  } catch (e) {
    res.status(e.status === 503 ? 503 : 400).json({ error: e.message });
  }
});

api.delete('/api/dbservers/:id', async (req, res) => {
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
api.get('/api/workspaces', async (req, res) => {
  res.json({ workspaces: await listWorkspaces() });
});

api.post('/api/workspaces/:slot/reset-setup', (req, res) => {
  res.json(resetSetup(req.params.slot));
});

api.post('/api/workspaces/:slot/clean', (req, res) => {
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

api.get('/api/providers', (req, res) => {
  res.json({ providers: listProviders().map(publicProvider), defaults: PROVIDER_DEFAULTS });
});

api.post('/api/providers', async (req, res) => {
  try {
    const provider = await createProvider(req.body || {});
    checkProviderAuth();
    res.status(201).json({ provider: publicProvider(provider) });
  } catch (e) {
    res.status(e.status === 503 ? 503 : 400).json({ error: e.message });
  }
});

api.put('/api/providers/:id', async (req, res) => {
  try {
    const provider = await updateProvider(Number(req.params.id), req.body || {});
    // An edited endpoint or key meters a different account: what was read for
    // the old one must not be served to the balancer for the rest of the TTL.
    forgetProviderUsage(provider.id);
    checkProviderAuth();
    res.json({ provider: publicProvider(provider) });
  } catch (e) {
    res.status(e.status === 503 ? 503 : 400).json({ error: e.message });
  }
});

api.delete('/api/providers/:id', async (req, res) => {
  try {
    const removed = await removeProvider(Number(req.params.id));
    if (!removed) return res.status(404).json({ error: 'Provider not found' });
    forgetProviderUsage(Number(req.params.id));
    res.json({ ok: true });
  } catch (e) {
    res.status(e.status === 503 ? 503 : 400).json({ error: e.message });
  }
});

// Auth + usage for one provider row, exactly as a session would run it:
// claude entries answer from the cached `claude auth status` probe (plus the
// account's subscription usage), everything else is probed on demand.
async function providerAuthUsage(p, cfg, fresh = false) {
  let auth = null;
  let usage = null;
  // Every meter goes through lib/balancer.js's cache: the same numbers the
  // session balancer reads, so page loads keep it warm.
  const readUsage = () => providerUsage(p, fresh ? { ttlMs: 0 } : {});
  const zaiKeyUsage = () => (p.apiKey && zaiHost(p.baseUrl) ? readUsage() : null);
  if (p.binary === 'claude') {
    if (p.apiKey) {
      // Verified with a live call to the endpoint (Anthropic's or the custom
      // base URL) rather than assumed from the key's presence, as the model
      // the picker and new sessions default to.
      auth = await verifyCustomEndpoint({
        binary: 'claude',
        baseUrl: p.baseUrl,
        apiKey: p.apiKey,
        model: providerDefaultModel(p, cfg),
      });
      usage = await zaiKeyUsage();
    } else {
      if (fresh && cfg.claudeBin) {
        const dir = claudeHomeDir(p);
        await new Promise((resolve) =>
          probeClaudeCli(cfg, dir, (state) => {
            const previous = claudeAuthByDir.get(dir);
            if (!previous || Date.parse(state.checkedAt) >= Date.parse(previous.checkedAt))
              claudeAuthByDir.set(dir, state);
            resolve(null);
          }),
        );
      }
      const state = claudeAuthByDir.get(claudeHomeDir(p));
      if (state && state.loggedIn != null) {
        auth = {
          loggedIn: state.loggedIn,
          detail: state.authMethod,
          checkedAt: state.checkedAt,
          ...providerAuthAccount('claude', p),
        };
        if (state.loggedIn) usage = await readUsage();
      }
    }
  } else {
    auth = await probeProviderAuth(p, cfg);
    if (p.binary === 'codex' && !p.baseUrl && !p.apiKey && auth?.loggedIn) {
      usage = await readUsage();
    } else if (p.binary === 'grok' && auth?.loggedIn) {
      // The login dir is the account here: grok's billing is read with the
      // token `grok login` left in it, exactly as probeProviderAuth found it.
      usage = await readUsage();
    } else {
      usage = await zaiKeyUsage();
    }
  }
  // Only a probe that answered: a row whose claude login state has not been
  // read yet must not erase what the boot probe already established. A claude
  // row's answer is the timer's probe read back, so it keeps that probe's
  // time rather than passing for a fresh one.
  if (auth)
    rememberProviderAuth(p.id, auth.loggedIn, auth.checkedAt ? Date.parse(auth.checkedAt) : undefined);
  return { auth, usage };
}

// The Status section on the settings page: everything known about one entry's
// connection: account, organization, plan, subscription usage, binary, dir.
api.get('/api/providers/:id/status', async (req, res) => {
  const p = getProvider(Number(req.params.id));
  if (!p) return res.status(404).json({ error: 'Provider not found' });
  const cfg = getConfig();
  const found = getBinary(p.binary).bin(cfg);
  const { auth, usage } = await providerAuthUsage(p, cfg, req.query.fresh === '1');
  res.set('Cache-Control', 'no-store');
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

api.use(providerTestRoutes({ getProvider, getConfig }));

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
        // A fresh login makes the cached "logged out, no quota" reading wrong
        // rather than stale: the account is pickable again right now.
        forgetProviderUsage(providerId);
        checkProviderAuth();
      }
    } catch {
      /* mid-write credentials file: keep watching */
    }
  }, 5000);
  loginWatchers.set(providerId, timer);
}

// The codex and grok logins run as device flows: the hidden CLI uses the
// entry's own home dir, prints an authorization URL and polls until it is
// approved. The page opens that URL. This deliberately avoids Codex's normal
// localhost callback, which would be inside the app container rather than the
// user's browser host. Either way the CLI writes auth.json when the login
// lands, and the watcher mirrors it into the row.
// One per binary at a time.
//
// opencode has no login flow of any kind: its entries authenticate with a
// service API key, handed to the CLI from the row.
const cliLogins = new Map(); // binary -> the in-flight login child process

api.post('/api/providers/:id/login', async (req, res) => {
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
      ? childEnv({ CODEX_HOME: ensureCodexHome(provider) })
      : childEnv({ GROK_HOME: ensureGrokHome(provider) });
  // Device auth works from Docker and a remote browser alike: no callback port
  // has to be reachable from the browser.
  const loginArgs = ['login', '--device-auth'];
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
  const login = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), 20000);
    const scan = (chunk) => {
      output += chunk;
      // The CLI formats its output for a terminal, including ANSI reset codes
      // immediately after the URL. Strip those first; otherwise a browser
      // treats the reset sequence as part of the device-auth path.
      const plain = output.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');
      const m = plain.match(/https:\/\/[^\s\x1B]+/);
      if (m) {
        // Codex device-auth codes are displayed as ABCD-EFGHI. The CLI is
        // hidden in this app, so return the code to the settings page too.
        const deviceCode = plain.match(/\b[A-Z0-9]{4}-[A-Z0-9]{5}\b/)?.[0] || null;
        // Codex prints its URL before the code. Keep collecting until both
        // have arrived; Grok has no code field in this UI.
        if (provider.binary === 'codex' && !deviceCode) return;
        clearTimeout(timer);
        resolve({ url: m[0], deviceCode });
      }
    };
    child.stdout.on('data', scan);
    child.stderr.on('data', scan);
    child.on('exit', () => {
      clearTimeout(timer);
      resolve(null);
    });
  });
  if (!login) {
    try {
      child.kill();
    } catch {
      /* already gone */
    }
    // The login command exits straight away when the dir already holds a login.
    const updated = await captureProviderAuth(provider).catch(() => provider);
    if (updated.authData) {
      forgetProviderUsage(provider.id);
      return res.json({ ok: true });
    }
    return res.status(500).json({
      error: `${provider.binary} login produced no login URL: ${output.trim().slice(0, 300) || '(no output)'}`,
    });
  }
  watchLogin(provider.id);
  res.json(login);
});

// The claude browser login: no console window. The settings page opens the
// authorization URL in a browser tab, the user approves on claude.ai and
// pastes the code shown back into the page.
const claudeLogins = new Map(); // provider id -> the in-flight flow's PKCE verifier

api.post('/api/providers/:id/login/start', (req, res) => {
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

api.post('/api/providers/:id/login/finish', async (req, res) => {
  const provider = getProvider(Number(req.params.id));
  if (!provider) return res.status(404).json({ error: 'Provider not found' });
  const verifier = claudeLogins.get(provider.id);
  if (!verifier) return res.status(400).json({ error: 'No login in flight; start the login first' });
  try {
    await claudeLoginFinish(provider, String((req.body || {}).code || ''), verifier);
    claudeLogins.delete(provider.id);
    const updated = await captureProviderAuth(provider);
    forgetProviderUsage(provider.id);
    checkProviderAuth();
    res.json({ provider: publicProvider(updated) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// The project list the composer's dropdown is built from: enabled projects
// only, in the order the settings page put them in; the first is the default.
// Served on its own so the branch picker can start loading without waiting on
// the provider auth probes, which block on live gateway calls.
api.get('/api/dev/projects', (req, res) => {
  // A client token limited to some projects (lib/api-v1.js) is shown those.
  const repos = res.locals.apiRepos;
  const projects = repos ? activeProjects().filter((p) => repos.includes(p.repo)) : activeProjects();
  res.json({
    projects: projects.map((p) => ({
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
      // The names ▶ Run's dropdown offers, the default first.
      runProfiles: projectRunProfiles(p).map((r) => r.name),
    })),
  });
});

// The project dashboard: one project's open pull requests, with the labels the
// review workflow speaks in and the errand each one is asking for, and, on the
// same payload, the repo's open issues, so the board's tabs cost one call.
api.get('/api/dev/pulls', async (req, res) => {
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
api.get('/api/dev/usage', async (req, res) => {
  const project = getProject(req.query.repo || '');
  if (!project) return res.status(404).json({ error: `Unknown project: ${req.query.repo || ''}` });
  res.json(await projectUsage(project));
});

// The same ledger with no project filter: the main dashboard, over one of
// lib/usage.js's windows. Disabled projects are in the list on purpose: one
// switched off mid-month still spent what it spent, and leaving it out would
// make the per-project rows fail to add up to the headline totals.
api.get('/api/dev/usage/all', async (req, res) => {
  const filter = {};
  for (const key of ['project', 'model', 'provider', 'activity', 'account', 'session', 'from', 'to']) {
    const value = req.query[key];
    if (value != null) filter[key] = Array.isArray(value) ? value.map(String) : String(value);
  }
  try {
    res.json(await overallUsage(listProjects(), String(req.query.period || 'month'), Date.now(), filter));
  } catch (error) {
    if (/^Choose a/.test(error.message)) return res.status(400).json({ error: error.message });
    throw error;
  }
});

// One pull request on its own, in the detail the right-hand panel draws: state,
// line changes, commits, linked issues, review verdicts and CI checks. It is
// what the session panel shows for a session's own PR, served here for the
// board drilled into a pull request, which has no session to read it from.
api.get('/api/dev/pull', async (req, res) => {
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
// first message. Interchangeable accounts (see providerGroups) come back as
// one entry: its id is the first member's, and naming it starts the session on
// whichever member has the most headroom (lib/balancer.js). `accounts` lists
// the members behind it, with each one's login and quota, so the picker can
// show where the group stands and warn about one login without hiding the rest.
api.get('/api/dev/providers', async (req, res) => {
  const cfg = getConfig();
  const providers = await Promise.all(
    providerGroups().map(async (group) => {
      const p = group.members[0];
      const binary = getBinary(p.binary);
      const found = binary.bin(cfg);
      const accounts = await Promise.all(
        group.members.map(async (m) => {
          const { auth, usage } = await providerAuthUsage(m, cfg, req.query.fresh === '1');
          return { id: m.id, label: m.label, auth, usage };
        }),
      );
      // One login out of several keeps the group usable; the group is only
      // down when every member is.
      const known = accounts.filter((a) => a.auth && a.auth.loggedIn != null);
      const auth =
        accounts.length === 1
          ? accounts[0].auth
          : known.length
            ? {
                loggedIn: known.some((a) => a.auth.loggedIn),
                detail: known
                  .map((a) => `${a.label}: ${a.auth.detail || (a.auth.loggedIn ? 'ok' : 'not logged in')}`)
                  .join('; '),
                checkedAt: known[0].auth.checkedAt || null,
              }
            : null;
      return {
        id: p.id,
        label: group.label,
        binary: p.binary,
        available: !!found,
        binSource: found ? found.source : null,
        models: providerModels(p, cfg),
        defaultModel: providerDefaultModel(p, cfg),
        efforts: providerEfforts(p),
        modelEfforts: providerModelEfforts(p, cfg),
        defaultEffort: providerDefaultEffort(p, cfg, providerDefaultModel(p, cfg)),
        auth,
        usage: accounts.length === 1 ? accounts[0].usage : null,
        accounts,
      };
    }),
  );
  res.set('Cache-Control', 'no-store').json({ providers });
});

// What a client picks a runtime from: what /api/dev/providers offers, without
// the accounts behind each entry, plus the project's own default (see
// runtimeCatalog). Availability goes on the login probes already made rather
// than probing on every poll.
api.get('/api/dev/runtimes', (req, res) => {
  const project = getProject(req.query.repo || '');
  if (!project) return res.status(404).json({ error: `Unknown project: ${req.query.repo || ''}` });
  res.json(runtimeCatalog(reviewerRuntime(project), getConfig(), (p) => cachedProviderAuth(p.id)));
});

// The branches of one project, for the composer's branch picker: the default
// branch first, then the rest alphabetically.
api.get('/api/dev/branches', async (req, res) => {
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
api.post('/api/dev/uploads', express.raw({ type: () => true, limit: '25mb' }), (req, res) => {
  try {
    if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: 'Empty file' });
    res.status(201).json({ file: storeUpload(String(req.query.name || ''), req.body) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Voice notes: the composer asks once whether the server can transcribe, and
// posts each recording as the raw body, typed with what the browser recorded
// (the type is what names the file for OpenAI); OpenAI tells the language
// itself. The answer is the text only; the recording is not kept.
api.get('/api/dev/transcribe', (req, res) => {
  res.json({ available: transcribeAvailable() });
});

api.post('/api/dev/transcribe', express.raw({ type: () => true, limit: '25mb' }), async (req, res) => {
  if (!Buffer.isBuffer(req.body) || !req.body.length)
    return res.status(400).json({ error: 'Empty recording' });
  // A note the composer dropped (another chat opened meanwhile) closes its
  // request, and OpenAI's call goes with it rather than billing for text
  // nobody reads.
  const gone = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) gone.abort();
  });
  try {
    const text = await transcribe(req.body, {
      type: String(req.headers['content-type'] || ''),
      signal: gone.signal,
    });
    res.json({ text });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// ---- actions ----
//
// ⚡ Actions in the sidebar: errands this app has a prompt for, run on a pull
// request the user names. The list is served so the menu grows with lib/actions.js
// rather than with a second copy of it in the client.

api.get('/api/dev/actions', (req, res) => {
  res.json({ actions: listActions() });
});

// Start an action: look the pull request up (its head branch is what the
// session checks out), then start an ordinary session with the action's prompt.
//
// Where it runs is the action's own call (lib/actions.js): gh-only errands run
// in the project's local checkout (a fresh clone and a pooled database server
// would be claimed for nothing) while an action that has to run the app (the
// test run) gets a workspace clone with the full setup, like a review does.
api.post('/api/dev/actions', async (req, res) => {
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

// ▶ Run on a pull-request card: verify the PR and its current head branch on
// GitHub, then prepare a clean session workspace and serve it without sending
// an agent turn. The returned session remains available in the sidebar so the
// user can inspect it, chat in it, or close it to release its resources.
api.post('/api/dev/pulls/:number/serve', async (req, res) => {
  const { repo, provider, model, effort } = req.body || {};
  const project = getProject(repo || '');
  if (!project) return res.status(400).json({ error: `Unknown project: ${repo || ''}` });
  const number = Number(req.params.number);
  if (!Number.isInteger(number) || number < 1) {
    return res.status(400).json({ error: 'The PR number must be a whole number' });
  }
  if (!project.runCommands.length) {
    return res
      .status(400)
      .json({ error: `No run command is configured for ${project.repo}; add one in Settings` });
  }
  const cfg = getConfig();
  if (!cfg.githubToken) {
    return res
      .status(400)
      .json({ error: 'No GITHUB_TOKEN is configured, so the pull request cannot be looked up' });
  }
  try {
    const lookup = await githubRest(cfg, 'GET', `/repos/${project.repo}/pulls/${number}`);
    if (lookup.status === 404) {
      return res.status(404).json({ error: `${project.repo} has no pull request #${number}` });
    }
    if (!lookup.ok) {
      return res
        .status(502)
        .json({ error: `GitHub answered ${lookup.status} reading pull request #${number}` });
    }
    const pr = await lookup.json();
    const branch = pr.head && pr.head.ref;
    if (!branch) {
      return res
        .status(502)
        .json({ error: `Pull request #${number} has no head branch; its fork may be gone` });
    }
    res.status(201).json(
      await startPullRequestPreview({
        provider,
        model,
        effort,
        repo: project.repo,
        branch,
        prNumber: number,
        title: pr.title || '',
      }),
    );
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ▶ Run on the board itself: the same clean preview a pull request gets, of a
// branch (the default one unless the client names another), so what is live
// can be compared with what a pull request would change.
api.post('/api/dev/branches/serve', async (req, res) => {
  const { repo, branch, provider, model, effort } = req.body || {};
  const project = getProject(repo || '');
  if (!project) return res.status(400).json({ error: `Unknown project: ${repo || ''}` });
  if (!project.runCommands.length) {
    return res
      .status(400)
      .json({ error: `No run command is configured for ${project.repo}; add one in Settings` });
  }
  try {
    let name = typeof branch === 'string' ? branch.trim() : '';
    if (!name) name = (await listRepoBranches(getConfig(), project.repo)).defaultBranch;
    if (!name) {
      return res.status(502).json({ error: `Could not tell ${project.repo}’s default branch` });
    }
    res
      .status(201)
      .json(await startPullRequestPreview({ provider, model, effort, repo: project.repo, branch: name }));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

async function currentJobUsageEstimates() {
  const plain = listDevSessions();
  try {
    return await jobUsageEstimates(plain.map((session) => session.id));
  } catch (e) {
    // Usage is an enhancement to the in-memory session list, not a reason to
    // make every conversation disappear when its ledger cannot be read.
    console.error(`session costs unavailable: ${e.message}`);
    return null;
  }
}

api.get('/api/dev/sessions', async (req, res) => {
  const estimates = await currentJobUsageEstimates();
  const sessions = listDevSessions(estimates);
  // A project-limited token's own projects, everything for an admin token
  // (lib/api-v1.js).
  const repos = res.locals.apiRepos;
  res.json({ sessions: repos ? sessions.filter((s) => repos.includes(s.repo)) : sessions });
});

// What the browser is allowed to file a session's spend under. Everything
// else names its activity server-side: a board errand passes its own action id
// and the rest is derived from what the session is (lib/jobs.js). This list is
// for the kinds of work only the browser knows about, because the derivation
// cannot see them: ▶ Start on an issue is an ordinary coding session in every
// respect except what it was started for, and folding its spend into plain
// chat is what makes "what did working issues cost?" unanswerable. An activity
// not on the list is dropped rather than rejected: a stale tab must not fail
// to start a session over a label.
const COMPOSER_ACTIVITIES = new Set(['issue']);

api.post('/api/dev/sessions', (req, res) => {
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
  // `activity` is what the start files its spend under in the usage ledger,
  // for the starts the server cannot tell apart from a plain chat; see
  // COMPOSER_ACTIVITIES above.
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
    activity,
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
        activity: COMPOSER_ACTIVITIES.has(activity) ? activity : undefined,
      }),
    });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// The transcript a page opens with, the stream that follows it, and ✕ Clear
// (lib/transcript-routes.js).
const transcript = sessionTranscriptRoutes({
  getJob,
  publicJob,
  jobEventsFor,
  jobEventsSince,
  visibleEvents,
  clearDevTranscript,
  currentEstimates: currentJobUsageEstimates,
  jobUsageEstimates,
  estimateEventCosts,
  bus,
});

api.get('/api/dev/sessions/:id', transcript.read);

api.get('/api/dev/sessions/:id/events', transcript.stream);

// A message mid-turn goes into a claude turn still reading its input, or is
// queued rather than refused otherwise, and one to a session that
// let go of its workspace reopens it first, so this only fails on a message
// the session could not accept at all.
api.post('/api/dev/sessions/:id/message', (req, res) => {
  try {
    const { text, attachments, zeusRoles } = req.body || {};
    res.json({ session: sendDevMessage(req.params.id, text, attachments, zeusRoles) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Dashboard only: internal session tokens cannot compact other sessions.
api.post('/api/dev/sessions/:id/compact', async (req, res) => {
  try {
    res.json({ session: await compactDevSession(req.params.id) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Hides the transcript so far from the dashboard; the stored log keeps it.
// Dashboard only, like compact.
api.post('/api/dev/sessions/:id/clear', transcript.clear);

// Where an outside system posts to wake this session, the key it signs with,
// and the caps its turns run under (lib/webhook-routes.js).
api.use(
  sessionWebhookRoutes({
    state: sessionWebhookState,
    update: setSessionWebhook,
    rotate: rotateSessionWebhook,
    url: sessionWebhookUrl,
    key: sessionWebhookKey,
  }),
);

// Session metadata edits (lib/session-edit-route.js).
const editSession = sessionEditRoute({
  renameDevSession,
  setDevSessionAutoCompact,
  setDevSessionCompactInstructions,
});
api.patch('/api/dev/sessions/:id', editSession);

// Manual recovery for a PR that automatic branch/URL discovery missed. The
// jobs layer reads GitHub and verifies the branch before storing the link.
api.post('/api/dev/sessions/:id/link-pr', async (req, res) => {
  try {
    res.json({ session: await linkPrToSession(req.params.id, req.body?.pr) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Take a queued message back before the session gets to it.
api.delete('/api/dev/sessions/:id/queue/:index', (req, res) => {
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
api.post('/api/dev/sessions/:id/loop', (req, res) => {
  try {
    const { on } = req.body || {};
    res.json({ session: setReviewLoop(req.params.id, on === true) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ⚑ Findings, Complete. On a round of the user's own pull request — a
// review-loop round, or a hand-started review of their own work — it takes the
// verdicts: what is marked fix starts an Implement feedback session, the rest
// is recorded on the pull request, and the screen sends an unmarked finding as
// optional so it is not offered again. On a review of somebody else's pull
// request it takes nothing and rules nothing — those findings are that
// author's to fix — and only clears the card.
api.post('/api/dev/sessions/:id/triage', async (req, res) => {
  try {
    const { verdicts, note } = req.body || {};
    res.json(
      await triageReviewFindings(req.params.id, { verdicts, note, by: res.locals.apiActor || 'the user' }),
    );
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ⚑ Findings, Reply on one finding of a review of somebody else's pull
// request: the text
// goes on that finding's own thread on the pull request, where its author
// answers it. It rules nothing and leaves the finding on the card.
api.post('/api/dev/sessions/:id/findings/reply', async (req, res) => {
  try {
    const { key, text } = req.body || {};
    res.json(await replyToReviewFinding(req.params.id, key, text, { by: res.locals.apiActor || 'the user' }));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ⚑ Findings, Delete on one finding of a hand-started code review: the finding
// leaves the review — its inline comment on the pull request and the review's
// own findings block — rather than only this card. Irreversible on GitHub; the
// screen asks before calling it.
api.post('/api/dev/sessions/:id/findings/delete', async (req, res) => {
  try {
    const { key } = req.body || {};
    res.json(await deleteReviewFinding(req.params.id, key, { by: res.locals.apiActor || 'the user' }));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ⚑ Findings, Save comments: the verdicts picked and the reasons and note
// typed so far, kept on the held round and posted on the pull request as one
// comment. Nothing is ruled; the round goes on waiting for Complete.
api.post('/api/dev/sessions/:id/triage/save', async (req, res) => {
  try {
    const { verdicts, note } = req.body || {};
    res.json(
      await saveReviewFindingsDrafts(req.params.id, {
        verdicts,
        note,
        by: res.locals.apiActor || 'the user',
      }),
    );
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// 🎬 QA loop: the second live chip, queued behind an armed review loop. It is
// armed independently because not every reviewed task should spend a QA run.
api.post('/api/dev/sessions/:id/qa-loop', (req, res) => {
  try {
    const { on } = req.body || {};
    res.json({ session: setQaLoop(req.params.id, on === true) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Reopen a closed / interrupted / failed session: its workspace clone and
// database server are claimed again, without a message to the agent.
api.post('/api/dev/sessions/:id/reopen', (req, res) => {
  try {
    res.json({ session: reopenDevSession(req.params.id) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ▶ Run: serve the session's checkout and hand back the URL for a new tab,
// with one link per tenant host when the run profile names tenants. `profile`
// picks one of the project's run profiles; without it the session serves the
// one it served last.
api.post('/api/dev/sessions/:id/serve', async (req, res) => {
  try {
    const profile = req.body && typeof req.body.profile === 'string' ? req.body.profile : null;
    res.json(await startDevServe(req.params.id, { profile }));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

api.post('/api/dev/sessions/:id/cancel', (req, res) => {
  const session = cancelDevTurn(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  res.json({ session });
});

api.post('/api/dev/sessions/:id/close', async (req, res) => {
  const session = await closeDevSession(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  res.json({ session });
});

// Delete = close (release the clone and MySQL instance) then trash the record
// and its log.
api.delete('/api/dev/sessions/:id', async (req, res) => {
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
// request hanging, so the last resort has to answer in the shape every client
// parses; otherwise a throw nobody caught reaches it as a bare "HTTP 500"
// instead of what actually went wrong. Malformed request bodies land here too.
// Anything else that reaches the end matched no route: a JSON 404, not
// Express's HTML one.
app.use((req, res) =>
  res.status(404).json({ error: 'Not found. The API is at /api/v1: see docs/api-v1.md' }),
);
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
    await sshService.init();
    await envoyerService.init();
    await forgeAccounts.init();
    await mobileAuth.init();
    await initSavedPrompts();
    await initMemorySelection();
    await initMemories();
    await initProviders();
    // Warm the balancer's quota cache so the first session started after boot
    // already lands on the account with the most headroom.
    for (const p of listProviders().filter((r) => r.active)) providerUsage(p).catch(() => {});
    // Each login-backed Codex row has an isolated CODEX_HOME. Refresh those
    // catalogs before jobs and the composer resolve their available models;
    // a logged-out account or a network failure leaves its last cache usable.
    await Promise.all(
      listProviders()
        .filter((p) => p.active && p.binary === 'codex' && !p.baseUrl && !p.apiKey)
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
  checkProviderAuth();
  setInterval(checkProviderAuth, AUTH_RECHECK_MS).unref();
  await initJobs();
  // `npm run create-token` issues and revokes from a shell, straight into the
  // database. A token revoked there stops new requests within 15 seconds; an
  // open stream, which rechecks on its own 15-second tick, within 30.
  setInterval(() => {
    mobileAuth.refresh().catch((e) => console.error('Could not reload device tokens:', e.message));
  }, 15000).unref();
  // Clone slots are caches, not session records. Drop every unclaimed slot at
  // boot and once a day so a project's peak concurrency does not permanently
  // consume disk; the pruner sees the live session registry and skips claims.
  startWorkspacePruner();
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
      `  projects: ${projects.length ? projects.map((p) => p.repo).join(', ') : 'none, add one with POST /api/v1/settings/projects'}`,
    );
    console.log(`  database: mysql://${cfg.db.user}@${cfg.db.host}:${cfg.db.port}/${cfg.db.database}`);
    console.log(
      `  claude: ${cfg.claudeBin || 'NOT FOUND, set CLAUDE_BIN in .env'}${cfg.claudeBinSource ? ` (${cfg.claudeBinSource})` : ''}`,
    );
    console.log(
      `  token: ${cfg.githubToken ? 'configured' : 'missing, set GITHUB_TOKEN in .env for PR sync and gh'}`,
    );
    console.log(
      `  api: ${
        apiEnabled()
          ? '/api/v1 takes tokens (`npm run create-token` issues one)'
          : 'OFF until AUTH_SECRET is set; `npm run create-token` sets it and issues the first token'
      }`,
    );
    console.log(
      `  webhooks: ${
        githubWebhookUrl()
          ? `github → ${githubWebhookUrl()}`
          : 'github off, PUBLIC_BASE_URL is not a public https hostname, so session panels sync on the timer alone'
      }; sessions → ${getConfig().publicBaseUrl}/webhooks/session/<id>`,
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
  stopAllDevServes();
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
    stopAllDevServes();
    flushJobs()
      .catch((e) => console.error('Could not write the last sessions on shutdown:', e.message))
      .finally(() => process.exit(0));
  });
}
