// @ts-check
import express from 'express';
import { createDeploymentService } from './lib/deployments.js';
import { deploymentRoutes } from './lib/deployment-routes.js';
import { createForgeClient } from './lib/forge.js';
import { forgeRoutes } from './lib/forge-routes.js';
import { createEnvoyerService } from './lib/envoyer.js';
import { envoyerRoutes } from './lib/envoyer-routes.js';
import { createForgeAccounts } from './lib/forge-accounts.js';
import { createMailService } from './lib/mail.js';
import { mailRoutes, mailCallbackRoutes } from './lib/mail-routes.js';
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
import { createSlackService } from './lib/slack.js';
import { slackRoutes, slackEventsRouter } from './lib/slack-routes.js';
import { createWhatsAppService } from './lib/whatsapp.js';
import { whatsappRoutes } from './lib/whatsapp-routes.js';
import { createMcpService, MCP_OAUTH_CALLBACK_PATH } from './lib/mcp-servers.js';
import { mcpRoutes, mcpProxyRouter, mcpOAuthCallbackRouter } from './lib/mcp-routes.js';
import { sessionWebhookRoutes } from './lib/webhook-routes.js';
import { sessionTranscriptRoutes } from './lib/transcript-routes.js';
import { providerTestRoutes } from './lib/provider-test-routes.js';
import { sessionEditRoute } from './lib/session-edit-route.js';
import { sessionBrowserRoutes } from './lib/browser-routes.js';
import {
  browserInput,
  browserScreenshot,
  browserState,
  stopAllBrowsers,
  watchBrowser,
} from './lib/browser.js';
import fs from 'fs';
import { execFile, spawn } from 'child_process';
import { getConfig } from './lib/config.js';
import { maintenanceState } from './lib/recovery.js';
import { workerTranscript } from './lib/worker-transcript.js';
import { orchestratorRoutes } from './lib/orchestrator-routes.js';
import { initDb, dbHealthy, loadTaskSessions, loadJobTurnUsage } from './lib/db.js';
import {
  initJobs,
  resumeRestartedSessions,
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
  askDevSessionBtw,
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
  startBranchPreview,
  flushJobs,
  stopAllDevServes,
  openSessionBrowser,
  closeSessionBrowser,
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
  deliverToSession,
  noteSession,
  webhookUnfit,
  setSlackAccess,
  setExternalMcp,
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
import { closeIssue, projectPulls, pullOverview, updateGithubItem } from './lib/prboard.js';
import {
  commitView,
  mergePullRequest,
  pullRequestView,
  pullRequestViewOptions,
  updatePullRequestBranch,
} from './lib/prviewer.js';
import { issueTimeline, issueView } from './lib/issueviewer.js';
import { repoArchive, repoFile, repoTree } from './lib/repofiles.js';
import { boardInScope, moveBoardItem, projectBoard } from './lib/projectboard.js';
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

// .env must be complete first: settings without a default are machine-specific, and a server
// that starts on a guess is worse than none. One line, then exit; not a stack trace.
try {
  getConfig();
} catch (e) {
  if (e.code !== 'CONFIG_INCOMPLETE') throw e;
  console.error(e.message);
  process.exit(1);
}

const app = express();
// Only a local tunnel/reverse proxy sits in front: trust that one hop so `req.ip` is the caller's.
app.set('trust proxy', 'loopback');

// API handlers live on their own router: /api/v1 dispatches to them once the bearer token is
// judged (lib/api-v1.js), and an agent reaches its own under /api/agent/.
const api = express.Router();

// On every response, including the webhooks': nothing here is a page, and the
// headers say so (lib/security.js).
app.use(securityHeaders);

// Slack inbox and session replies (lib/slack.js): created here because its events route
// is a webhook, and webhooks come before everything else.
const slackService = createSlackService({
  getJob,
  deliver: (id, delivery) => deliverToSession(id, delivery, { via: 'slack' }),
  note: noteSession,
  unfit: webhookUnfit,
  eventsUrl: (id) => `${getConfig().publicBaseUrl}/webhooks/slack/${id}`,
});
setSlackAccess((repo) => slackService.briefing(repo));

// Webhooks go ahead of the JSON body parser: GitHub and Slack sign the raw bytes with an HMAC,
// and a re-serialized body verifies against nothing (lib/webhooks.js).
app.use('/webhooks/slack', slackEventsRouter({ service: slackService }));

// The operator's MCP servers (lib/mcp-servers.js). The provider's redirect
// after a sign-in is no webhook, but it rides the same Access bypass, and the
// proxy sessions reach their remote servers through wants the body as bytes.
const mcpService = createMcpService({
  callbackUrl: () => `${getConfig().publicBaseUrl}${MCP_OAUTH_CALLBACK_PATH}`,
});
setExternalMcp((repo) => mcpService.mounts(repo));
app.use(mcpOAuthCallbackRouter({ service: mcpService }));
app.use(mcpProxyRouter({ service: mcpService, agentSession }));
app.use('/webhooks', webhookRouter());

// The only client API: owner-issued tokens (`npm run create-token`) in front of the handlers below.
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

// Retired routes answer in JSON with where to go, since the caller is a script, not a browser.
app.use('/api', (req, res) =>
  res.status(410).json({ error: 'This route is retired. Call /api/v1 with a token: see docs/api-v1.md' }),
);

// For the uptime monitor (no auth, nothing sensitive). 503 when MySQL is down, so a paused
// database shows on the monitor rather than as silently missing session history.
app.get('/healthz', async (req, res) => {
  const db = await dbHealthy();
  res.status(db ? 200 : 503).json({ ok: db, db, uptime: Math.floor(process.uptime()) });
});

// Where a mailbox's sign-in ends when its redirect URI is this server's own
// (lib/mail-routes.js). The mail service is created here for it, and the
// API's mail routes below share it.
const mailService = createMailService();
app.use(mailCallbackRoutes({ service: mailService }));

// The scenario videos a test run records. The run copies each .webm here, and
// a client fetches one through /api/v1 with its token; the links a run leaves
// on a pull request point there too, unless an R2 bucket serves them instead
// (lib/prtasks.js).
fs.mkdirSync(getConfig().testVideosDir, { recursive: true });
api.use('/videos', express.static(getConfig().testVideosDir));

// The spawned CLI does not share the desktop app's login, so its auth state is surfaced rather
// than letting sessions fail cryptically. Each claude entry logs in in its own config dir.
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

// Probed at boot, after provider edits and on this timer: a login made outside the server is
// invisible otherwise, and the balancer ranks a remembered-logged-out account last. Must stay
// inside the balancer's AUTH_TTL_MS so a probe is always fresh enough to count.
const AUTH_RECHECK_MS = 5 * 60_000;

function checkClaudeAuth() {
  const cfg = getConfig();
  const checkedAt = new Date().toISOString();
  for (const p of listProviders().filter((r) => r.active && r.binary === 'claude' && !r.apiKey)) {
    // Materialize the dir and adopt any fresh login made in it before probing.
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

// Codex and grok entries: the probe is a stat of the CLI's login file, cheap on a timer, and
// without it the balancer's memory of a logged-out account expires and the row ranks as fine.
// Key or custom-endpoint rows need a live call, so they are probed per page request instead.
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

function checkProviderAuth() {
  checkClaudeAuth();
  checkLoginAuth();
}

// ---- projects ----
//
// A repository sessions start against, plus what the runner needs to prepare and run it.

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

// The wording of the PR body and every errand prompt: a singleton shaped as a one-row list (id 1)
// to reuse the select/save plumbing. `catalog` carries labels, allowed `{{TOKEN}}`s and built-in
// fallbacks, so the client never holds a second copy of the prompts.
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
// The composer's kickoff library: with ?repo=, that project's Prompts menu (its own first, then
// shared); without, the whole library.
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
// Clients edit the library by id through /api/v1; the agent's memory tool reaches its own
// project's memories by name, the session's bearer token deciding the project (agentOnly in
// lib/auth.js), never a repo parameter.

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
api.use(slackRoutes({ service: slackService, agentSession, getProject }));
api.use(whatsappRoutes({ service: createWhatsAppService() }));
api.use(mcpRoutes({ service: mcpService, getProject }));
api.use(
  operationsRoutes({
    listSessions: devSessionRecords,
    ssh: sshService,
    slack: slackService,
    getJob,
    sendMessage: sendDevMessage,
  }),
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
api.use(mailRoutes({ service: mailService }));

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
// The worker tools an orchestrator's turns mount (lib/orchestrator-mcp.js, or curl for CLIs
// without a headless MCP flag). The bearer token's whole authority is "this orchestrator and
// its own workers".

const workerRoutes = orchestratorRoutes({
  agentSession,
  workerSessionsFor,
  setQaLoop,
  workerSummary,
  getJob,
  workerTranscript,
  jobEventsFor,
  sendDevMessage,
});
const { orchestratorSession, workerOf } = workerRoutes;
api.post('/api/agent/sessions/:id/qa-loop', workerRoutes.qaLoop);
api.get('/api/agent/sessions/:id/question', workerRoutes.readQuestion);
api.post('/api/agent/sessions/:id/question', workerRoutes.answerQuestion);

api.post('/api/agent/sessions', (req, res) => {
  const orchestrator = orchestratorSession(req, res);
  if (!orchestrator) return;
  try {
    // `reviewLoop` reviews every push the worker settles with and returns findings as a fix
    // session (lib/jobs.js); `qaLoop` queues the test run behind it. `tooling` (fix_tooling)
    // targets the dashboard's own project with the review loop armed regardless.
    const { title, prompt, providerId, model, effort, branch, reviewLoop, qaLoop, tooling } = req.body || {};
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
    // Reopening a closed worker is effectively a spawn, so the open-worker cap applies.
    if (!DEV_OPEN.includes(worker.status)) assertWorkerSlot(orchestrator);
    sendDevMessage(worker.id, String((req.body || {}).text || ''));
    res.json({ session: workerSummary(worker) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// The orchestrator's verdicts on a held review round (lib/jobs.js, holdForTriage): "fix" starts
// the fix session, the rest is recorded on the PR. Spends no worker turn, so no slot gate.
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

// Re-runs a review round whose provider errored: the loop stays gated on that commit and a
// finished worker has no push left to reopen it. An optional provider/model/effort moves off the
// failing runtime. It never replaces a review, so it cannot approve a push; no slot gate.
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
// Findings from a PR's review summaries joined with stored fix/optional/dismissed verdicts.
// "fix" mirrors onto one anchored "Required fixes" checklist comment that later reviews tick.

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

api.post('/api/pr/update-branch', async (req, res) => {
  try {
    const { repo, prNumber } = findingsParams(req.body || {});
    const { headSha, baseRef } = req.body || {};
    res.status(202).json(
      await updatePullRequestBranch({ repo }, prNumber, {
        headSha: String(headSha || ''),
        baseRef: String(baseRef || ''),
      }),
    );
  } catch (e) {
    res.status(e.status || (e.rateLimited ? 429 : 502)).json({ error: e.message });
  }
});

function githubUpdateHandler(kind) {
  return async (req, res) => {
    try {
      const body = req.body || {};
      const project = getProject(typeof body.repo === 'string' ? body.repo : '');
      if (!project) return res.status(404).json({ error: 'Unknown project' });
      res.json(await updateGithubItem(project, Number(body[kind]), kind, body));
    } catch (e) {
      res.status(e.status || (e.rateLimited ? 429 : 502)).json({ error: e.message });
    }
  };
}
api.patch('/api/pr/update', githubUpdateHandler('pr'));
api.patch('/api/issues/update', githubUpdateHandler('issue'));

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

// One issue read whole, and its timeline a page at a time.
function issueParams(query) {
  const project = getProject(String(query.repo || ''));
  if (!project) throw Object.assign(new Error(`Unknown project: ${query.repo || ''}`), { status: 404 });
  return { project: { repo: project.repo }, number: Number(query.issue) };
}

api.get('/api/issues/view', async (req, res) => {
  try {
    const { project, number } = issueParams(req.query);
    res.json(await issueView(project, number));
  } catch (e) {
    res.status(e.status || (e.rateLimited ? 429 : 502)).json({ error: e.message });
  }
});

api.get('/api/issues/timeline', async (req, res) => {
  try {
    const { project, number } = issueParams(req.query);
    res.json(await issueTimeline(project, number, { page: Number(req.query.page || 1) }));
  } catch (e) {
    res.status(e.status || (e.rateLimited ? 429 : 502)).json({ error: e.message });
  }
});

// One commit with the files it changed, as a PR's commit list links to.
api.get('/api/pr/commit', async (req, res) => {
  try {
    const project = getProject(String(req.query.repo || ''));
    if (!project) throw Object.assign(new Error(`Unknown project: ${req.query.repo || ''}`), { status: 404 });
    res.json(await commitView({ repo: project.repo }, String(req.query.sha || '')));
  } catch (e) {
    res.status(e.status || (e.rateLimited ? 429 : 502)).json({ error: e.message });
  }
});

// For a client's file browser: every path at a ref, and one file's text.
api.get('/api/repo/tree', async (req, res) => {
  try {
    const project = getProject(String(req.query.repo || ''));
    if (!project) throw Object.assign(new Error(`Unknown project: ${req.query.repo || ''}`), { status: 404 });
    res.json(await repoTree({ repo: project.repo }, req.query.ref ? String(req.query.ref) : undefined));
  } catch (e) {
    res.status(e.status || (e.rateLimited ? 429 : 502)).json({ error: e.message });
  }
});

api.get('/api/repo/file', async (req, res) => {
  try {
    const project = getProject(String(req.query.repo || ''));
    if (!project) throw Object.assign(new Error(`Unknown project: ${req.query.repo || ''}`), { status: 404 });
    const ref = req.query.ref ? String(req.query.ref) : undefined;
    res.json(await repoFile({ repo: project.repo }, ref, String(req.query.path || '')));
  } catch (e) {
    res.status(e.status || (e.rateLimited ? 429 : 502)).json({ error: e.message });
  }
});

api.get('/api/repo/archive', async (req, res) => {
  const controller = new AbortController();
  res.once('close', () => controller.abort());
  try {
    const project = getProject(String(req.query.repo || ''));
    if (!project) throw Object.assign(new Error(`Unknown project: ${req.query.repo || ''}`), { status: 404 });
    const { stream, size } = await repoArchive({ repo: project.repo }, String(req.query.ref || ''), {
      signal: controller.signal,
    });
    res.once('close', () => stream.destroy());
    // The client may have disconnected while GitHub was sending headers.
    if (res.destroyed) {
      stream.destroy();
      return;
    }
    res.setHeader('Content-Type', 'application/gzip');
    if (size) res.setHeader('Content-Length', String(size));
    // A failure once bytes have gone out can only cut the response short.
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  } catch (e) {
    if (res.destroyed) return;
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
// Database servers sessions can claim, one session per server at a time.

api.get('/api/dbservers', (req, res) => {
  res.json({ servers: listDbServers(), defaults: DB_SERVER_DEFAULTS });
});

// Probes the connection as the form holds it, so an entry can be verified before saving. The
// pool size rides along because it caps how many sessions may be open at once.
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
// Clone-slot health, plus resetting an idle slot's install fingerprints or dropping its
// dependency trees. lib/workspaces.js refuses both with a 409 while a session holds the slot.
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
// Each row binds a label to one of the hardcoded binaries (claude / codex / grok / opencode) with
// its own login dir, endpoint and key, and model/effort overrides.

// The stored login (auth_data) never leaves the server; clients only see whether one exists.
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

// Auth + usage for one row as a session would run it: claude logins answer from the cached
// `claude auth status` probe, everything else is probed on demand.
async function providerAuthUsage(p, cfg, fresh = false) {
  let auth = null;
  let usage = null;
  // Through lib/balancer.js's cache, so page loads keep the balancer's numbers warm.
  const readUsage = () => providerUsage(p, fresh ? { ttlMs: 0 } : {});
  const zaiKeyUsage = () => (p.apiKey && zaiHost(p.baseUrl) ? readUsage() : null);
  if (p.binary === 'claude') {
    if (p.apiKey) {
      // A live call with the default model, not assumed from the key's presence.
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
      // Grok's billing is read with the token `grok login` left in the login dir.
      usage = await readUsage();
    } else {
      usage = await zaiKeyUsage();
    }
  }
  // Only a probe that answered, so an unread claude state cannot erase the boot probe's. A
  // claude answer keeps its probe's time rather than passing for a fresh one.
  if (auth)
    rememberProviderAuth(p.id, auth.loggedIn, auth.checkedAt ? Date.parse(auth.checkedAt) : undefined);
  return { auth, usage };
}

// Everything known about one entry's connection: account, plan, usage, binary, dir.
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

// A login lands in the entry's config dir; the watcher mirrors it into the database once it
// arrives (the same adoption a boot does).
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
        // A fresh login makes the cached "logged out" reading wrong, not just stale.
        forgetProviderUsage(providerId);
        checkProviderAuth();
      }
    } catch {
      /* mid-write credentials file: keep watching */
    }
  }, 5000);
  loginWatchers.set(providerId, timer);
}

// Codex and grok log in by device flow in the entry's home dir, avoiding Codex's localhost
// callback, which would sit inside the app container rather than the user's browser host. The
// watcher mirrors the resulting auth.json into the row. One login per binary at a time; opencode
// has no login flow (its entries use an API key).
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
      // Strip ANSI codes first: a reset right after the URL would become part of its path.
      const plain = output.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');
      const m = plain.match(/https:\/\/[^\s\x1B]+/);
      if (m) {
        // The CLI is hidden, so Codex's ABCD-EFGHI code is returned with the URL.
        const deviceCode = plain.match(/\b[A-Z0-9]{4}-[A-Z0-9]{5}\b/)?.[0] || null;
        // Codex prints the URL before the code, so wait for both; grok has no code.
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

// The claude login: the user opens the authorization URL, approves on claude.ai and pastes
// back the code shown.
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

// Enabled projects in settings order, the first being the default. Separate from the provider
// list so the branch picker need not wait on auth probes that block on live gateway calls.
api.get('/api/dev/projects', (req, res) => {
  // A client token limited to some projects (lib/api-v1.js) is shown those.
  const repos = res.locals.apiRepos;
  const projects = repos ? activeProjects().filter((p) => repos.includes(p.repo)) : activeProjects();
  res.json({
    projects: projects.map((p) => ({
      repo: p.repo,
      label: p.label,
      hasLocal: !!p.localDir,
      // The review runtime the dashboard starts its errands on, so it does not ask again.
      reviewProviderId: p.reviewProviderId,
      reviewModel: p.reviewModel || '',
      reviewEffort: p.reviewEffort || '',
      // The names ▶ Run's dropdown offers, the default first.
      runProfiles: projectRunProfiles(p).map((r) => r.name),
      // Whether it names a Projects v2 board, which is what offers the board tab.
      hasBoard: !!p.projectBoard,
    })),
  });
});

// The project dashboard: open PRs with their review labels and pending errand, plus open issues,
// so the board's tabs cost one call.
api.get('/api/dev/pulls', async (req, res) => {
  const project = getProject(req.query.repo || '');
  if (!project) return res.status(404).json({ error: `Unknown project: ${req.query.repo || ''}` });
  try {
    res.json(await projectPulls(project, { fresh: req.query.fresh === '1' }));
  } catch (e) {
    // A spent GitHub allowance is a 429 that says when to come back, so a
    // client can tell "try again at 15:41" from a server fault. Anything else
    // stays a 502: a GraphQL error carries the 200 it arrived with, and that
    // must not reach the client as a success.
    if (e && e.rateLimited) {
      const retryAt = Number(e.retryAt) || null;
      if (retryAt) res.set('Retry-After', String(Math.max(1, Math.ceil((retryAt - Date.now()) / 1000))));
      return res
        .status(429)
        .json({ error: e.message, retryAt: retryAt ? new Date(retryAt).toISOString() : null });
    }
    res.status(502).json({ error: e.message });
  }
});

// The project's GitHub Projects v2 board, filtered and grouped as its view is; cached like the PR
// board.
api.get('/api/dev/project-board', async (req, res) => {
  const project = getProject(req.query.repo || '');
  if (!project) return res.status(404).json({ error: `Unknown project: ${req.query.repo || ''}` });
  try {
    // A token held to some repositories (lib/api-v1.js) sees only their cards.
    const board = await projectBoard(project, { fresh: req.query.fresh === '1' });
    res.json(boardInScope(board, res.locals.apiRepos));
  } catch (e) {
    res.status(e.status || (e.rateLimited ? 429 : 502)).json({ error: e.message });
  }
});

// A card dragged to another column of that board. A token held to some
// repositories moves only the cards it can see.
api.post('/api/dev/project-board/move', async (req, res) => {
  const body = req.body || {};
  const project = getProject(typeof body.repo === 'string' ? body.repo : '');
  if (!project) return res.status(404).json({ error: 'Unknown project' });
  try {
    res.json(await moveBoardItem(project, body, { repos: res.locals.apiRepos }));
  } catch (e) {
    res.status(e.status || (e.rateLimited ? 429 : 502)).json({ error: e.message });
  }
});

// A project's spend this calendar month, from the per-turn ledger.
api.get('/api/dev/usage', async (req, res) => {
  const project = getProject(req.query.repo || '');
  if (!project) return res.status(404).json({ error: `Unknown project: ${req.query.repo || ''}` });
  res.json(await projectUsage(project));
});

// The whole ledger over one of lib/usage.js's windows. Disabled projects are included so the
// per-project rows still add up to the headline totals.
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

// One PR in the session panel's detail (state, commits, reviews, checks), for a board drilled
// into a PR with no session to read it from.
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

// Startable providers with their models and login state, so a dead provider fails in the banner
// rather than on the first message. Interchangeable accounts (providerGroups) are one entry with
// the first member's id, balanced by headroom (lib/balancer.js); `accounts` lists each member.
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
      // The group is down only when every member is.
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

// /api/dev/providers without the accounts, plus the project's default (runtimeCatalog).
// Availability uses cached login probes rather than probing on every poll.
api.get('/api/dev/runtimes', (req, res) => {
  const project = getProject(req.query.repo || '');
  if (!project) return res.status(404).json({ error: `Unknown project: ${req.query.repo || ''}` });
  res.json(runtimeCatalog(reviewerRuntime(project), getConfig(), (p) => cachedProviderAuth(p.id)));
});

// The default branch first, then the rest alphabetically.
api.get('/api/dev/branches', async (req, res) => {
  const project = getProject(req.query.repo || '');
  if (!project) return res.status(404).json({ error: `Unknown project: ${req.query.repo || ''}` });
  try {
    res.json(await listRepoBranches(getConfig(), project.repo));
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// One file per request: raw bytes as the body, filename in the query; messages carry only the
// returned ids. Clients post application/octet-stream, so the JSON parser never touches it.
api.post('/api/dev/uploads', express.raw({ type: () => true, limit: '25mb' }), (req, res) => {
  try {
    if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: 'Empty file' });
    res.status(201).json({ file: storeUpload(String(req.query.name || ''), req.body) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Voice notes: the raw body's content type names the file for OpenAI. Only the text is returned;
// the recording is not kept.
api.get('/api/dev/transcribe', (req, res) => {
  res.json({ available: transcribeAvailable() });
});

api.post('/api/dev/transcribe', express.raw({ type: () => true, limit: '25mb' }), async (req, res) => {
  if (!Buffer.isBuffer(req.body) || !req.body.length)
    return res.status(400).json({ error: 'Empty recording' });
  // A dropped request aborts OpenAI's call rather than billing for text nobody reads.
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
// ⚡ Actions: prompted errands run on a named PR. Served so clients never copy lib/actions.js.

api.get('/api/dev/actions', (req, res) => {
  res.json({ actions: listActions() });
});

// Looks up the PR's head branch, then starts an ordinary session with the action's prompt. gh-only
// errands run in the local checkout (no clone or pooled database wasted); actions that run the
// app get a fully set up workspace clone (lib/actions.js).
api.post('/api/dev/actions', async (req, res) => {
  const { action: actionId, repo, prNumber, provider, model, effort, input } = req.body || {};
  const action = getAction(actionId);
  if (!action) return res.status(400).json({ error: `Unknown action: ${actionId}` });
  // An action with required input (✍ Give feedback) has no errand without it.
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
    // Awaited because a prompt may read the PR first; one that refuses fails the request rather
    // than starting an empty errand.
    const prompt = await action.prompt(context);
    res.status(201).json({
      session: createDevSession({
        provider,
        model,
        effort,
        repo: project.repo,
        // checkout: false leaves the local tree on the developer's branch (gh-only errand).
        branch: action.checkout === false ? undefined : branch,
        local: (action.workspace || 'local') === 'local',
        prompt,
        // Attached to the PR now rather than waiting to spot its URL.
        prNumber: number,
        // Filed under the PR's branch, whatever branch the borrowed checkout is on.
        prBranch: branch,
        // One-shot errands close when done, freeing clone and database (lib/actions.js).
        autoClose: action.autoClose === true,
        // Arms the 🔁 review loop on pushed fixes. Exclusive with autoClose: the loop needs a
        // parent still open when the review reports.
        reviewLoop: action.reviewLoop === true,
        title: action.title(context),
        // Files the session's spend under the errand in the usage ledger.
        activity: action.id,
      }),
    });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ▶ Run on a PR card: verify the PR's head branch, then prepare and serve a clean workspace
// without an agent turn. The session stays open until the user closes it.
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

// ▶ Run on a branch without a PR (default branch unless named). It must exist on origin, or the
// workspace would cut a new branch of that name off the default and serve it under the wrong label.
api.post('/api/dev/branches/serve', async (req, res) => {
  const { repo, branch: wanted, provider, model, effort } = req.body || {};
  const project = getProject(repo || '');
  if (!project) return res.status(400).json({ error: `Unknown project: ${repo || ''}` });
  if (wanted != null && (typeof wanted !== 'string' || !wanted.trim())) {
    return res.status(400).json({ error: 'The branch must be a branch name' });
  }
  if (!project.runCommands.length) {
    return res
      .status(400)
      .json({ error: `No run command is configured for ${project.repo}; add one in Settings` });
  }
  let listed;
  try {
    listed = await listRepoBranches(getConfig(), project.repo);
  } catch (e) {
    return res.status(502).json({ error: e.message });
  }
  const branch = wanted ? wanted.trim() : listed.defaultBranch;
  if (!branch) return res.status(502).json({ error: `Could not tell ${project.repo}'s default branch` });
  if (!listed.branches.includes(branch)) {
    return res.status(404).json({ error: `${project.repo} has no branch ${branch}` });
  }
  try {
    res.status(201).json(await startBranchPreview({ provider, model, effort, repo: project.repo, branch }));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

async function currentJobUsageEstimates() {
  const plain = listDevSessions();
  try {
    return await jobUsageEstimates(plain.map((session) => session.id));
  } catch (e) {
    // An unreadable ledger must not make the session list disappear.
    console.error(`session costs unavailable: ${e.message}`);
    return null;
  }
}

api.get('/api/dev/sessions', async (req, res) => {
  const estimates = await currentJobUsageEstimates();
  const sessions = listDevSessions(estimates);
  // A project-limited token sees only its projects (lib/api-v1.js).
  const repos = res.locals.apiRepos;
  res.json({ sessions: repos ? sessions.filter((s) => repos.includes(s.repo)) : sessions });
});

// Activities only the client can know (▶ Start on an issue looks like plain chat server-side);
// everything else is derived in lib/jobs.js. Unknown ones are dropped, not rejected, so a stale
// tab still starts its session.
const COMPOSER_ACTIVITIES = new Set(['issue']);

api.post('/api/dev/sessions', (req, res) => {
  // `prNumber` lets a review started from a PR row name it up front. `qa` is the 🎬 QA errand.
  // `reviewLoop` reviews every settled push and feeds findings back as a capped fix turn
  // (lib/jobs.js). `orchestrator` is a checkout-less supervisor that steers worker sessions,
  // which default to `workerRuntime` when given.
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
    workerRuntime,
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
        workerRuntime: workerRuntime && typeof workerRuntime === 'object' ? workerRuntime : null,
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

// The browser the session shares with its user (lib/browser-routes.js).
const sharedBrowser = sessionBrowserRoutes({
  getJob,
  openSessionBrowser,
  closeSessionBrowser,
  browserState,
  watchBrowser,
  browserInput,
  browserScreenshot,
});
api.get('/api/dev/sessions/:id/browser', sharedBrowser.state);
api.post('/api/dev/sessions/:id/browser', sharedBrowser.open);
api.delete('/api/dev/sessions/:id/browser', sharedBrowser.close);
api.get('/api/dev/sessions/:id/browser/stream', sharedBrowser.stream);
api.get('/api/dev/sessions/:id/browser/screenshot', sharedBrowser.screenshot);
api.post('/api/dev/sessions/:id/browser/input', sharedBrowser.input);

// Mid-turn messages are injected into a claude turn or queued, and a released session reopens
// first, so this fails only on a message the session cannot accept at all.
api.post('/api/dev/sessions/:id/message', (req, res) => {
  try {
    const { text, attachments } = req.body || {};
    res.json({ session: sendDevMessage(req.params.id, text, attachments) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// /btw: a side question answered beside the conversation, never in it; the transcript gets it too.
api.post('/api/dev/sessions/:id/btw', async (req, res) => {
  let asked;
  try {
    asked = askDevSessionBtw(req.params.id, (req.body || {}).text);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
  const answer = await asked.answer.then(
    ({ text, costUsd }) => ({ text, isError: false, costUsd }),
    (e) => ({ text: e.message, isError: true, costUsd: e.usage?.costUsd ?? null }),
  );
  const job = getJob(req.params.id); // deleted while it was answered: no record to send
  res.json({ session: job ? publicJob(job) : null, id: asked.id, ...answer });
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

// 🔁 Review loop: arm or disarm it on a running session.
api.post('/api/dev/sessions/:id/loop', (req, res) => {
  try {
    const { on } = req.body || {};
    res.json({ session: setReviewLoop(req.params.id, on === true) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ⚑ Findings, Complete. On the user's own PR, "fix" verdicts start an Implement feedback session
// and the rest are recorded on the PR. On somebody else's PR it rules nothing (the findings are
// that author's) and only clears the card.
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

// ⚑ Findings, Reply on somebody else's PR: posts on the finding's own thread and rules nothing.
api.post('/api/dev/sessions/:id/findings/reply', async (req, res) => {
  try {
    const { key, text } = req.body || {};
    res.json(await replyToReviewFinding(req.params.id, key, text, { by: res.locals.apiActor || 'the user' }));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ⚑ Findings, Delete on a hand-started review: removes the finding's inline comment and its
// entry in the review's findings block on GitHub, irreversibly.
api.post('/api/dev/sessions/:id/findings/delete', async (req, res) => {
  try {
    const { key } = req.body || {};
    res.json(await deleteReviewFinding(req.params.id, key, { by: res.locals.apiActor || 'the user' }));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ⚑ Findings, Save comments: draft verdicts and note kept on the held round and posted as one PR
// comment. Nothing is ruled; the round still waits for Complete.
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

// 🎬 QA loop: queued behind the review loop, armed separately since not every task needs QA.
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

// ▶ Run: serve the session's checkout, one link per tenant host. Without `profile` the session
// serves the profile it served last.
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

// Unmatched routes get a JSON 404, not Express's HTML one. Express 5 forwards rejected async
// handlers and malformed bodies to the error handler, which answers in the JSON clients parse.
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

// Load projects and sessions (database-only) before serving. A down database gets one clear log
// line, and the server still comes up so settings can show what is wrong.
(async () => {
  try {
    await initDb();
    await initTemplates();
    await initProjects();
    await initDbServers();
    await sshService.init();
    await slackService.init();
    await mcpService.init();
    await envoyerService.init();
    await forgeAccounts.init();
    await mailService.init();
    await mobileAuth.init();
    await initSavedPrompts();
    await initMemorySelection();
    await initMemories();
    await initProviders();
    // Warm the quota cache so the first session already lands on the account with most headroom.
    for (const p of listProviders().filter((r) => r.active)) providerUsage(p).catch(() => {});
    // Refresh each login-backed Codex row's model catalog before models are resolved; a failure
    // leaves the last cache usable.
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
  // Only after the provider rows are loaded.
  checkProviderAuth();
  setInterval(checkProviderAuth, AUTH_RECHECK_MS).unref();
  await initJobs({ deferPolling: true });
  // `npm run create-token` writes the database directly; a revoked token stops new requests
  // within 15s and open streams within 30s.
  setInterval(() => {
    mobileAuth.refresh().catch((e) => console.error('Could not reload device tokens:', e.message));
  }, 15000).unref();
  // Every connected mailbox is brought up to date every MAIL_SYNC_MINUTES, so
  // a client reads its mail from the database rather than from the provider.
  mailService.start();
  // Every project gets (or keeps) a hook pointing at this install's public
  // hostname, so an open session's pull request panel keeps up with the reviews,
  // comments and CI runs landing on its branch. Best effort: a repo whose hook
  // cannot be installed just falls back to the twenty-second sync tick.
  await installRepoWebhooks(activeProjects(), cfg, githubRest).catch((e) =>
    console.error('Could not install GitHub webhooks:', e.message),
  );
  // Agent tools run on this machine, so they call back on loopback, not PUBLIC_BASE_URL.
  setAgentApiBase(`http://127.0.0.1:${port}`);
  app.listen(port, cfg.bindHost, () => {
    resumeRestartedSessions();
    // Recovered sessions must claim their slots before pruning unused clones.
    startWorkspacePruner();
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

// On shutdown, flush the write queue: the last moments of a turn exist nowhere else.
let stopping = false;
// On a crash, flush too (or a just-created session vanishes), then die so pm2 restarts clean.
process.on('uncaughtException', (e) => {
  console.error('Uncaught exception:', e);
  stopAllDevServes();
  stopAllBrowsers();
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
    stopAllBrowsers();
    flushJobs()
      .catch((e) => console.error('Could not write the last sessions on shutdown:', e.message))
      .finally(() => process.exit(0));
  });
}
