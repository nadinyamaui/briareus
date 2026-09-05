import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import { spawn, spawnSync } from 'child_process';
import { EventEmitter } from 'events';
import crypto from 'crypto';
import { getConfig } from './config.js';
import { memoryBriefing } from './memories.js';
import { githubRest, githubGraphql, upsertPrComment } from './github.js';
import {
  saveJob,
  saveJobEvents,
  loadJobs,
  loadJobEvents,
  deleteJob as dbDeleteJob,
  jobEventMaxSeqs,
} from './db.js';
import {
  acquireInstance,
  releaseInstance,
  ensureSessionDatabase,
  dropSessionDatabase,
  instanceEnv,
  instanceAppPort,
  sessionCapacity,
  projectClaimsServer,
} from './dbpool.js';
import {
  getBinary,
  parserFor,
  newTurn,
  ensureCodexHome,
  ensureClaudeHome,
  ensureGrokHome,
  ensureOpencodeHome,
  opencodeXdgEnv,
  opencodeAuthContent,
  opencodeConfigContent,
  canResume,
  contextWindowFor,
  parseContextReport,
} from './providers.js';
import {
  getProvider,
  getProviderForJob,
  listProviders,
  providerModels,
  providerEfforts,
  providerDefaultModel,
  providerDefaultEffort,
  captureProviderAuth,
  resolveRuntime,
} from './providerstore.js';
import { getProject, activeProjects, selfProject, render, stepRuntime } from './projects.js';
import { testSheetPrompt, testRunPrompt, implementFeedbackPrompt } from './prtasks.js';
import { templateText, renderTemplate } from './templates.js';
import {
  latestReviewFindings,
  latestTestFailures,
  queueFindingsForFix,
  recordTriage,
  findingKey,
  PARK_REASONS,
} from './findings.js';
import { initUploads, getUpload } from './uploads.js';
import { syncVideos } from './r2.js';
import { recordTurnUsage } from './usage.js';
import { fetchWithWorkspaceRecovery } from './workspace-git.js';

// Git over HTTPS gets the same GitHub token the `gh` calls use. Letting git
// authenticate itself works only on a machine that happens to have a credential
// helper configured; a headless run on one that does not (a fresh Linux box)
// dies on `could not read Username for 'https://github.com'` the moment the
// repo is private, and no prompt can be answered from here.

const jobs = new Map(); // id -> job

// Every session runs in a workspace clone of its own, so same-repo sessions
// can run in parallel without ever sharing a working tree. Clones are pooled
// per repo (<owner>__<repo>, then …__2, …__3 as concurrency demands): an idle
// clone is reused, keeping the blobless clone and its installed vendor/ and
// node_modules/, and a new slot is cloned only when every existing one is
// claimed by a running session. Slots are never deleted: a reused one only
// fetches and checks out, and the install steps it then runs are skipped
// wholesale when their manifests have not moved (see INSTALL_STEPS).
const busyClones = new Set(); // absolute clone dirs owned by an active job

// The branch a slot is sitting on right now, or null if it has no checkout yet.
function slotBranch(dir) {
  const probe = spawnSync('git', ['-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' });
  const name = (probe.stdout || '').trim();
  return name && name !== 'HEAD' ? name : null;
}

// Synchronous on purpose: callers in the same event-loop tick (pump starting
// several jobs) must each observe the slots the previous call claimed.
//
// `branch` is the branch the session is about to check out, when it already
// knows it. A slot that is already on that branch is the cheapest one to take:
// its composer.lock / package.json are the ones that branch installed last
// time, so the install steps are skipped outright, and its build output and
// framework caches are that branch's too.
function acquireCloneDir(repoFull, branch = null) {
  const cfg = getConfig();
  const [owner, repo] = repoFull.split('/');
  const base = `${owner}__${repo}`;
  const slot = (i) => path.join(cfg.workspaceDir, i === 1 ? base : `${base}__${i}`);
  // Prefer an idle clone that is already on disk: reuse skips the network
  // clone and keeps dependency installs incremental.
  const idle = [];
  for (let i = 1; fs.existsSync(slot(i)); i++) {
    if (!busyClones.has(slot(i))) idle.push(slot(i));
  }
  const preferred = (branch && idle.find((dir) => slotBranch(dir) === branch)) || idle[0];
  if (preferred) {
    busyClones.add(preferred);
    return preferred;
  }
  // All existing clones are busy: claim the first slot that is neither on
  // disk nor held by a concurrent job still cloning into it.
  for (let i = 1; ; i++) {
    if (!fs.existsSync(slot(i)) && !busyClones.has(slot(i))) {
      busyClones.add(slot(i));
      return slot(i);
    }
  }
}

// The branch a session will end up on, as far as it is known before its
// workspace is prepared: the branch it was started on (a review, a QA run, a
// picked branch), or the one a reopened session was already working on. A
// session that will cut a branch of its own off the default branch has no
// answer here, and takes whichever slot is free.
function wantedBranch(job) {
  return job.branch || job.startBranch || job.reviewBranch || null;
}

// A freshly created session has no branch yet; after its first preparation the
// chosen branch is persisted in `branch`. On a restart that is the branch we
// must restore, even when the session was originally created without a picked
// `startBranch` (which is how worker sessions are created).
export function workspaceStartBranch(job) {
  return job.startBranch || job.reviewBranch || job.branch || null;
}

/** @param {{ id: string, branch?: string|null, startBranch?: string|null, reviewBranch?: string|null }} job @param {string} base */
export function workspaceBranchPlan(job, base) {
  const start = workspaceStartBranch(job);
  const branch = start || `dev-${job.id}`;
  const startPoint = start || base;
  return { branch, startPoint };
}

export function workspaceCheckoutPlan(job, base, { remoteWorkerRef = false, localBranch = false } = {}) {
  const plan = workspaceBranchPlan(job, base);
  if (!workspaceStartBranch(job) || remoteWorkerRef) {
    return { ...plan, source: 'remote', checkoutRef: `refs/remotes/origin/${plan.startPoint}` };
  }
  if (localBranch) return { ...plan, source: 'local', checkoutRef: plan.branch };
  return { ...plan, source: 'base', checkoutRef: `refs/remotes/origin/${base}` };
}

// Sessions queued for the local checkout while another one holds it. On
// release the claim is handed straight to the first waiter; the tree never
// leaves the busy set in between, so nothing can slip in ahead of the queue.
// Clone slots never wait: the pool just grows another slot instead.
const localWaiters = new Map(); // dir -> FIFO of claim resolvers

// Which jobs own their workDir right now. Release goes through this set so a
// double release (a close, then the killed turn's own unwind) cannot hand
// the checkout to a second waiter while the first is still working in it.
// In-memory on purpose: a restart empties it together with busyClones.
const workDirHolders = new Set(); // job objects

// Give a directory back: the next session queued on it takes the claim over
// directly, and only a dir nobody is waiting for actually becomes free.
function handBackDir(dir) {
  const queue = localWaiters.get(dir);
  if (queue && queue.length) {
    queue.shift()();
    if (!queue.length) localWaiters.delete(dir);
    return;
  }
  busyClones.delete(dir);
}

// The one way a job lets go of its working tree.
function releaseWorkDir(job) {
  if (!job || !job.workDir || !workDirHolders.has(job)) return;
  workDirHolders.delete(job);
  handBackDir(job.workDir);
}

// Local mode: the session works directly in the project's own checkout on this
// machine instead of a workspace clone. The tree is also the developer's, so
// it is claimed through the same busy set: two agents (or an agent and the
// clone pool) must never share a working tree. A busy checkout queues the
// session instead of failing it: the claim arrives when the holder closes.
async function acquireLocalDir(job) {
  const project = getProject(job.repo);
  const dir = project ? project.localDir : '';
  if (!dir)
    throw new Error(`${job.repo} has no local checkout configured; set one in Settings to use Local mode`);
  if (!busyClones.has(dir)) {
    busyClones.add(dir);
  } else {
    pushEvent(job, 'info', {
      text: 'Another session is working in the local checkout. Queued until it closes.',
    });
    // A reopen arrives here from failed/closed; a fresh session is queued
    // already and would only repeat itself.
    if (job.status !== 'queued') setStatus(job, 'queued');
    await new Promise((resolve) => {
      const queue = localWaiters.get(dir) || [];
      queue.push(resolve);
      localWaiters.set(dir, queue);
    });
    // Closed while waiting in line: the claim that just arrived goes straight
    // on to whoever is next, and the caller unwinds like any closed session.
    if (job.status === 'closed') {
      handBackDir(dir);
      throw new Error('closed');
    }
  }
  workDirHolders.add(job);
  return dir;
}
export const bus = new EventEmitter();
bus.setMaxListeners(100);

function now() {
  return new Date().toISOString();
}

// ---------------------------------------------------------------------------
// Storage
//
// MySQL holds every session and every line of its log (`jobs` / `job_events`),
// and holds them alone: nothing about a session is written to disk any more.
// The .jsonl logs and jobs.json this used to keep beside the database were a
// second copy of the same history that could disagree with it, capped the list
// at the most recent 200, and left a run's log behind whenever the record was
// trimmed. Writes are queued and flushed in batches, and a batch the database
// refuses is retried rather than dropped: the queue is now the only other copy
// those lines have.
//
// The prompt files below are the one thing still written to disk, and they are
// not session data: the CLIs take a system prompt / prompt as a file path, so
// each turn writes its own into the OS temp dir and deletes it again when the
// process exits.
// ---------------------------------------------------------------------------

function promptDir() {
  return path.join(os.tmpdir(), 'reviewer-prompts');
}

// How many sessions come back at boot. Everything older stays in the database
// and is only a wider limit away; nothing is pruned.
const RESTORE_LIMIT = 2000;

export async function initJobs() {
  const cfg = getConfig();
  fs.mkdirSync(cfg.workspaceDir, { recursive: true });
  fs.mkdirSync(promptDir(), { recursive: true });
  initUploads();
  await restoreFromDb();
  // Codex sessions restore with whatever token numbers were stored; refresh
  // them from each thread's rollout file (the CLI's native accounting), so a
  // record written before that accounting was read shows real context, not
  // the turn's summed usage.
  for (const job of jobs.values()) {
    if (job.kind !== 'devchat' || !job.providerSessionId) continue;
    const prov = getProviderForJob(job);
    if (prov && prov.binary === 'codex') {
      try {
        codexContextFromRollout(job, prov);
      } catch {
        /* stored numbers stand */
      }
    }
  }
  // Dev sessions mirror their branch's PR state and CI checks (syncDevPr).
  // Every turn triggers its own sync; the tick is what keeps a session that is
  // mid-turn (or sitting idle while CI runs) from showing a stale panel.
  setInterval(syncDevPrs, 20_000).unref();
}

// Whether a job is holding a clone slot / database server right now. A dev
// session keeps both between turns, so an idle one holds resources exactly
// like a running review does.
function holdsResources(job) {
  return ACTIVE.includes(job.status) || (job.kind === 'devchat' && job.status === 'idle');
}

// A run that was in flight when the process went away. Database claims live in
// this process's memory, so the restart already released them; clearing the
// claim fields just keeps the record from describing a server it no longer
// holds.
function markInterrupted(job) {
  job.status = 'interrupted';
  job.error = job.error || 'Server restarted while the job was active';
  job.endedAt = job.endedAt || now();
  job.dbServerId = null;
  job.dbHost = null;
  job.dbPort = null;
  dirtyJobs.add(job.id); // the stored row still reads `running` until this lands
}

// Bring every stored session back into memory, each with its log cursor. The
// cursor matters as much as the record: seq is the key job_events is written
// against (and the client drops any event numbered at or below the last one it
// rendered), so a session that resumed numbering at 0 after a restart had every
// line of its next turn silently ignored by the INSERT.
async function restoreFromDb() {
  try {
    const stored = await loadJobs(RESTORE_LIMIT);
    const restored = [];
    // Read before anything is registered: a session restored without knowing
    // where its log ends is worse than one that is missing until the next boot.
    const maxSeqs = await jobEventMaxSeqs();
    for (const job of stored) {
      if (!job.id) continue;
      if (holdsResources(job)) markInterrupted(job);
      // A crash mid-injected-turn left worker updates stashed in flight; put
      // them back in front of the buffer so the reopen flush delivers them.
      if (job.orchestrator && job.inFlightWorkerNotices?.length) {
        job.pendingWorkerNotices = [...job.inFlightWorkerNotices, ...(job.pendingWorkerNotices || [])];
        job.inFlightWorkerNotices = [];
        save(job);
      }
      // Sessions saved before usage gained stable project ownership only carry
      // the repository name. Upgrade them in memory before another turn can
      // write a legacy ledger row; the next normal flush persists the link.
      if (!job.projectId && job.repo) {
        const project = getProject(job.repo);
        if (project?.id) {
          job.projectId = project.id;
          save(job);
        }
      }
      job.seq = maxSeqs.get(job.id) || 0;
      job.events = [];
      registerJob(job);
      restored.push(job);
    }
    // Loop jobs run in their own sessions. A restart interrupts those sessions
    // along with their parent, but the parent owns the durable in-flight flags.
    // Reconcile those flags only after every stored record is registered, so a
    // worker never remains "reviewing" a process this server just stopped.
    reconcileRestartedLoopJobs(restored);
    if (jobs.size) console.log(`  restored ${jobs.size} session(s) from the database`);
    scheduleFlush();
  } catch (e) {
    console.error('Could not restore sessions from the database:', e.message);
    console.error('  they are still stored; this boot just starts with an empty list');
  }
}

// A review, fix, or QA session that was active before this process restarted
// cannot report back afterwards. Its parent is already interrupted by
// markInterrupted above; release the durable loop state too. Reviews and fixes
// make the review round retryable, while QA simply becomes eligible for its
// normal retry when the worker next settles.
function reconcileRestartedLoopJobs(restored) {
  for (const parent of restored) {
    if (parent.kind !== 'devchat' || parent.status !== 'interrupted') continue;

    const loop = parent.reviewLoop;
    if (loop?.reviewing) {
      const review = loop.reviewSessionId ? jobs.get(loop.reviewSessionId) : null;
      if (!review || !DEV_OPEN.includes(review.status)) {
        if (review?.loopParentId === parent.id) {
          review.error = review.error || 'Server restarted while the review was active';
          notifyLoopReviewFailed(review);
        } else {
          loop.reviewing = false;
          const why = 'the code review was interrupted by a server restart';
          failLoopRound(parent, why);
          pushEvent(parent, 'info', {
            text: `Review loop: ${why}, so this round approved nothing. Retry it with ${retryLoopAction(parent)}.`,
          });
          save(parent);
          notifyParentLoop(
            parent,
            `the review loop's code review was interrupted by a server restart. Round ${loop.rounds} approved nothing; retry it with retry_review.`,
          );
        }
      }
    }

    if (loop?.fixing) {
      const fix = loop.fixSessionId ? jobs.get(loop.fixSessionId) : null;
      if (!fix || !DEV_OPEN.includes(fix.status)) {
        if (fix?.loopFixParentId === parent.id) {
          fix.error = fix.error || 'Server restarted while the fix session was active';
          notifyLoopFixFailed(fix);
        } else {
          loop.fixing = false;
          loop.fixSessionId = null;
          const why = 'the fix session was interrupted by a server restart';
          failLoopRound(parent, why);
          pushEvent(parent, 'info', {
            text: `Review loop: ${why}. Retry the round with ${retryLoopAction(parent)}.`,
          });
          save(parent);
          notifyParentLoop(
            parent,
            `the review loop's fix session was interrupted by a server restart. Retry round ${loop.rounds} with retry_review.`,
          );
        }
      }
    }

    const qaLoop = parent.qaLoop;
    if (!qaLoop?.running) continue;
    const activeId = qaLoop.sessionId || qaLoop.staleSessionId;
    const qa = activeId ? jobs.get(activeId) : null;
    if (qa && DEV_OPEN.includes(qa.status)) continue;
    if (qa?.qaParentId === parent.id) {
      qa.error = qa.error || 'Server restarted while the QA session was active';
      notifyQaLoopFailed(qa);
    } else {
      qaLoop.running = false;
      if (qaLoop.staleSessionId === activeId) qaLoop.staleSessionId = null;
      qaLoop.failure = {
        kind: 'interrupted',
        reason: 'the QA session was interrupted by a server restart',
        at: now(),
      };
      pushEvent(parent, 'info', {
        text: 'QA loop: the QA session was interrupted by a server restart. No QA is running; send this session a follow-up turn to retry QA when it settles.',
      });
      save(parent);
      notifyParentLoop(
        parent,
        'QA was interrupted by a server restart. No QA is running and nothing was approved; use send_to_worker for a follow-up turn, which retries QA when the worker settles.',
      );
    }
  }
}

function retryLoopAction(job) {
  return job.parentId ? 'retry_review' : 'the 🔁 chip';
}

// The write queue. A session's metadata changes and its log lines are batched
// for half a second rather than written per event (a turn streams hundreds of
// them), and a batch the database refuses goes back on the queue for the next
// attempt, with the delay backing off while it is unreachable. Nothing is
// written anywhere else now, so dropping a failed batch would lose those lines
// for good.
const pendingEvents = new Map(); // job id -> log lines not yet written
const dirtyJobs = new Set(); // jobs whose metadata changed since the last flush
// Ids mid-delete. A round/verdict read held across an interrupted/failed
// status (see isRetired) can resolve and call save() after deleteJobById has
// already started tearing a job down but before it unregisters it, so runFlush
// checks this rather than only `jobs.get(id)` before writing the row back.
const deletingJobs = new Set();
const FLUSH_MS = 500;
const MAX_BACKOFF_MS = 30_000;
let flushTimer = null;
let flushing = false;
let currentFlush = null; // the in-progress flush's promise, so a delete can wait it out
let flushWarned = false;
let backoffMs = FLUSH_MS;

function scheduleFlush(delay = FLUSH_MS) {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flushToDb().catch((e) => console.error('Session flush failed:', e.message));
  }, delay);
}

// Mark a session's metadata as changed. Log lines carry their own queue; this
// is for the fields a turn updates without saying anything (branch, turns,
// cost, PR state).
function save(job) {
  dirtyJobs.add(job.id);
  scheduleFlush();
}

async function flushToDb() {
  if (flushing) return scheduleFlush();
  flushing = true;
  // Held so a delete that starts mid-flush can wait for the write in progress
  // to land, instead of racing it: a save that lands after a DELETE brings
  // the row right back.
  currentFlush = runFlush();
  try {
    await currentFlush;
  } finally {
    flushing = false;
    currentFlush = null;
  }
}

async function runFlush() {
  const batches = [...pendingEvents];
  const ids = [...dirtyJobs];
  pendingEvents.clear();
  dirtyJobs.clear();
  try {
    for (const id of ids) {
      const job = jobs.get(id);
      if (!job || deletingJobs.has(id)) continue;
      // The rollup is derived from the records around this one and recomputed
      // on every projection; stored, it would come back on a restore as if it
      // were this session's own spend.
      const { usage, ...stored } = publicJob(job);
      await saveJob(stored);
    }
    for (const [id, events] of batches) {
      // Chunked: a long turn can queue thousands of lines, and one giant INSERT
      // would run into max_allowed_packet.
      for (let i = 0; i < events.length; i += 500) {
        await saveJobEvents(id, events.slice(i, i + 500));
      }
    }
    flushWarned = false;
    backoffMs = FLUSH_MS;
  } catch (e) {
    // Back on the queue, ahead of anything the failed attempt raced with, so
    // the log keeps its order when the database comes back.
    for (const [id, events] of batches) {
      const queued = pendingEvents.get(id);
      pendingEvents.set(id, queued ? [...events, ...queued] : events);
    }
    for (const id of ids) dirtyJobs.add(id);
    backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
    if (!flushWarned) {
      flushWarned = true;
      console.error('Could not write sessions to the database, retrying:', e.message);
    }
  } finally {
    if (pendingEvents.size || dirtyJobs.size) scheduleFlush(backoffMs);
  }
}

// Write everything queued right now. Called on shutdown, so the last half
// second of a turn does not go down with the process.
export async function flushJobs() {
  // A context probe still running would save its numbers after the final
  // flush and lose them, so wait it out first (it is seconds at most).
  if (ctxProbes.size) await Promise.allSettled([...ctxProbes.values()]);
  clearTimeout(flushTimer);
  flushTimer = null;
  await flushToDb();
}

// A question the agent wants answered before it goes on, written as a block at
// the end of a reply. It is lifted out of the text and pushed as an `ask` event
// of its own, so the chat renders it with clickable answers instead of leaving
// the user to retype one. claude's native AskUserQuestion tool call arrives as
// the same event straight from the stream parser.
const ASK_BLOCK = /<ask-user>([\s\S]*?)<\/ask-user>/gi;

function parseAskBlocks(text) {
  const asks = [];
  const rest = String(text).replace(ASK_BLOCK, (_, body) => {
    const question = [];
    const options = [];
    for (const raw of String(body).split('\n')) {
      const line = raw.trim();
      if (!line) continue;
      const option = line.match(/^[-*]\s+(.*\S)\s*$/);
      // Bullets are the answers; everything before the first one is the
      // question. A stray line after them is a continuation nobody can click,
      // so it is dropped rather than shown as an answer.
      if (option) options.push({ label: option[1] });
      else if (!options.length) question.push(line);
    }
    if (question.length) asks.push({ question: question.join(' '), options });
    return '';
  });
  return { asks, rest: rest.trim() };
}

function pushEvent(job, kind, data) {
  // Recursion is bounded: the remainder has the blocks removed, and an `ask`
  // event never carries text of its own.
  if (job.kind === 'devchat' && kind === 'text' && /<ask-user>/i.test(String(data.text || ''))) {
    const { asks, rest } = parseAskBlocks(data.text);
    if (asks.length) {
      if (rest) pushEvent(job, 'text', { ...data, text: rest });
      for (const ask of asks) pushEvent(job, 'ask', ask);
      return;
    }
  }
  // A question stands until the user says something; anything they send is the
  // answer, whether they clicked one of the offered options or typed their own.
  if (job.kind === 'devchat') {
    if (kind === 'ask') {
      job.awaitingAnswer = true;
      // A worker's question is its orchestrator's to answer: it goes over as
      // a turn (buffered while the orchestrator is busy), and send_to_worker
      // is the answer channel. Bounded: an orchestrator has no parent.
      const options = (Array.isArray(data.options) ? data.options : [])
        .map((o) => o && o.label)
        .filter(Boolean)
        .join(' | ');
      queueWorkerNotice(job, 'ask', {
        text:
          `Worker ${job.id} (${job.title || 'untitled'}) stopped to ask:\n` +
          `"${String(data.question || '').slice(0, 500)}"${options ? `\nOptions: ${options}` : ''}\n` +
          `Answer it with send_to_worker (your message is read as the answer), or escalate with an ask-user block if the decision is genuinely the user's.`,
      });
    } else if (kind === 'user') {
      job.awaitingAnswer = false;
      job.lastTool = null; // a new turn: whatever the last one was doing is over
    }
    // The office's bubble says which tool a running turn is on. Only the name
    // and a slice of the summary: a record is pushed on every change.
    if (kind === 'tool' && typeof data.name === 'string') {
      const summary = typeof data.summary === 'string' ? data.summary.trim() : '';
      job.lastTool = `${data.name}${summary ? ` ${summary}` : ''}`.slice(0, 120);
    }
    // The record carries the opening of the agent's latest message so the
    // sidebar and the office can show what a settled session last said without
    // reading its log. Only the first line, and only enough of it to read: a
    // record is pushed on every change.
    if (kind === 'text' && typeof data.text === 'string') {
      const line = data.text.split('\n').find((l) => l.trim());
      if (line) job.lastText = line.trim().slice(0, 200);
    }
  }
  // Last line of defence for a session that reached here without a cursor:
  // numbering must never restart over lines already stored, or job_events,
  // keyed by (job_id, seq) and written with INSERT IGNORE, drops the new ones.
  if (typeof job.seq !== 'number') job.seq = 0;
  if (!job.events) job.events = [];
  const event = { seq: ++job.seq, t: now(), kind, ...data };
  job.events.push(event);
  if (job.events.length > 3000) job.events.splice(0, job.events.length - 3000);
  const batch = pendingEvents.get(job.id) || [];
  batch.push(event);
  pendingEvents.set(job.id, batch);
  dirtyJobs.add(job.id);
  scheduleFlush();
  bus.emit('event', job.id, event);
  if (job.kind === 'devchat' && typeof data.text === 'string') spotPrUrl(job, data.text);
}

// Sub-agents are session state, not conversation: a Task call that is still
// running belongs in the right panel, not as another line in the log (the tool
// step that started it is already there). The list only ever holds what is
// working right now; an `end` takes its agent straight back out.
function trackSubagent(job, e) {
  const live = job.subagents || (job.subagents = []);
  if (e.state === 'start') {
    if (live.some((a) => a.id === e.id)) return;
    live.push({ id: e.id, name: e.name, summary: e.summary, startedAt: now() });
  } else {
    const i = live.findIndex((a) => a.id === e.id);
    if (i === -1) return;
    live.splice(i, 1);
  }
  bus.emit('job', publicJob(job));
  save(job);
}

// job.branch is set once, when the workspace is prepared, but an agent is
// free to rename it before pushing (dev-<id> is not a name anyone wants on a
// pull request). Re-reading HEAD lets the session's own idea of its branch
// catch up, so the sidebar files it under where the work actually landed and
// spottedPrIsThisSession recognizes the PR it just opened as its own.
function refreshJobBranch(job) {
  if (job.local || job.orchestrator || !job.workDir) return;
  const head = slotBranch(job.workDir);
  if (head && head !== job.branch) {
    pushEvent(job, 'info', { text: `Working tree is now on branch ${head} (was ${job.branch}).` });
    job.branch = head;
  }
}

// The moment a PR URL for the session's repo shows up in the stream (the
// agent just opened one, or quoted it), that PR is synced by number right
// away, mid-turn, instead of waiting for the turn to end. One of the three ways
// a session attaches to a PR (the others being the number its caller handed it
// and attachPrForBranch's head-ref lookup); syncDevPr itself guesses nothing.
//
// A URL in the stream is not proof the PR is this session's, though: agents
// read other pull requests all the time (`gh pr view`, a link in the task, a
// sibling session's work quoted back). So a spotted number only attaches when
// the pull request is actually open from this session's branch: syncDevPr
// checks its head ref before mirroring it. That branch may have just been
// renamed (opening a PR is exactly when an agent trades dev-<id> for
// something descriptive), so HEAD is re-read first; otherwise the PR this
// session just opened would fail its own head-ref check.
function spotPrUrl(job, text) {
  // An orchestrator has no branch, so no pull request can ever be its own,
  // and its whole job is quoting its workers' PRs: spotting there is one
  // GitHub lookup and one "mentioned, not attached" line per quote, for
  // nothing.
  if (job.orchestrator) return;
  const m = text.match(/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/i);
  if (!m || m[1].toLowerCase() !== job.repo.toLowerCase()) return;
  const number = Number(m[2]);
  if (job.prStatus && job.prStatus.number === number) return;
  // An agent quoting someone else's PR usually quotes it many times over a
  // turn. Once it has been looked up and turned down, it is not looked up
  // again for this session: one GitHub call and one log line, not one per
  // chunk of text that carries the link.
  if (spotRejected.has(`${job.id}:${number}`)) return;
  refreshJobBranch(job);
  syncDevPr(job, number, { spotted: true }).catch(() => {});
}

// session id + PR number pairs spotted in a stream and rejected: not this
// session's branch. In-process only, so a restart may re-check, which costs one
// request.
const spotRejected = new Set();

// Does a pull request spotted in the stream belong to this session? Only when
// it is open from the exact branch the session works on (or, for an errand
// that never checked its pull request out, the branch that one is open from). A
// session whose workspace is not prepared yet has no branch to compare
// against, and nothing it quotes can be its own PR: it has not pushed
// anything.
export function spottedPrIsThisSession(job, headRef) {
  if (!headRef) return false;
  return headRef === job.prBranch || (!!job.branch && headRef === job.branch);
}

function setStatus(job, status, patch = {}) {
  Object.assign(job, patch, { status });
  pushEvent(job, 'status', { status, ...patch });
  bus.emit('job', publicJob(job));
  save(job);
}

export function publicJob(job) {
  // seq stays out: it is this process's cursor into the log, restored from the
  // stored log itself on the next boot.
  const { events, seq, proc, timeout, turnCanceled, serveProc, ...meta } = job;
  // Messages typed while the turn was running are held in this process, not in
  // the record, but the composer has to show what is still waiting, so they
  // ride along as previews (no server paths, same shape as a user event's).
  // The delete is for a record restored from storage: a queue written into meta
  // by an earlier boot describes messages this process never received.
  const queue = devQueues.get(job.id);
  if (queue && queue.length) {
    meta.queued = queue.map(({ shown, files }) => ({ text: shown, ...attachmentMeta(files) }));
  } else if (meta.queued) {
    delete meta.queued;
  }
  // What the session has spent with everything it ordered included, see
  // sessionUsage. The record's own costUsd / inputTokens / outputTokens /
  // durationMs stay what this conversation itself consumed.
  if (job.kind === 'devchat') meta.usage = sessionUsage(job);
  return meta;
}

// ---- who spent on whose behalf ----

// The one link that files a session under another (createDevSession's opts
// name them): a worker under its orchestrator, and a loop's review, QA run or
// fix session under the task it ran for. Set at creation and never moved, so
// the index is built as records register and torn down as they are deleted.
function parentLinkOf(job) {
  return job.loopParentId || job.qaParentId || job.loopFixParentId || job.parentId || null;
}

const childrenOf = new Map(); // parent id -> Set<job>

function registerJob(job) {
  jobs.set(job.id, job);
  const parentId = parentLinkOf(job);
  if (!parentId) return;
  if (!childrenOf.has(parentId)) childrenOf.set(parentId, new Set());
  childrenOf.get(parentId).add(job);
}

function unregisterJob(job) {
  jobs.delete(job.id);
  const parentId = parentLinkOf(job);
  const set = parentId && childrenOf.get(parentId);
  if (!set) return;
  set.delete(job);
  if (!set.size) childrenOf.delete(parentId);
}

// The sessions filed directly under this one, in memory right now.
export function childSessionsOf(job) {
  return [...(childrenOf.get(job.id) || [])];
}

// null + null stays null: a number nobody reported is not a zero.
function addNullable(a, b) {
  return a == null && b == null ? null : (a || 0) + (b || 0);
}

// What one session has spent, everything it ordered included: its own turns,
// what its deleted children paid in on their way out (the absorbed* fields
// deleteJobById fills), and live, every session still filed under it, all the
// way down. So an orchestrator's number covers its workers, and each worker's
// covers the reviews, fix sessions and QA runs its loops ran; the sub-agents a
// turn forks inside the CLI are already inside that turn's own figures. Cost
// keeps lib/usage.js's honesty: null until something in the tree was priced.
// `sessions` counts how many other sessions the total folds in.
export function sessionUsage(job, seen = new Set()) {
  seen.add(job.id);
  const total = {
    sessions: job.absorbedSessions || 0,
    costUsd: addNullable(job.costUsd, job.absorbedCostUsd),
    inputTokens: addNullable(job.inputTokens, job.absorbedInputTokens),
    outputTokens: addNullable(job.outputTokens, job.absorbedOutputTokens),
    durationMs: addNullable(job.durationMs, job.absorbedDurationMs),
  };
  for (const child of childSessionsOf(job)) {
    if (seen.has(child.id)) continue;
    const u = sessionUsage(child, seen);
    total.sessions += 1 + u.sessions;
    total.costUsd = addNullable(total.costUsd, u.costUsd);
    total.inputTokens = addNullable(total.inputTokens, u.inputTokens);
    total.outputTokens = addNullable(total.outputTokens, u.outputTokens);
    total.durationMs = addNullable(total.durationMs, u.durationMs);
  }
  return total;
}

// A session's spend just moved: its own record goes out, and so does every
// session above it, whose rollup just moved with it. Nothing above is saved;
// the rollup is derived, not stored.
function emitUsage(job) {
  bus.emit('job', publicJob(job));
  const seen = new Set([job.id]);
  for (let p = jobs.get(parentLinkOf(job)); p && !seen.has(p.id); p = jobs.get(parentLinkOf(p))) {
    seen.add(p.id);
    bus.emit('job', publicJob(p));
  }
}

export function getJob(id) {
  return jobs.get(id) || null;
}

// Session names are navigation, not conversation: editing one must not spend a
// turn or rewrite the first message that originally supplied it. The job's
// ordinary save path persists both the indexed title column and the complete
// metadata record, and the job event wakes every open view immediately.
export function renameDevSession(id, title) {
  const job = jobs.get(id);
  if (!job || job.kind !== 'devchat') throw new Error('Session not found');
  const next = typeof title === 'string' ? title.trim() : '';
  if (!next) throw new Error('The session title cannot be empty');
  if (next.length > 160) throw new Error('The session title cannot be longer than 160 characters');
  if (job.title === next) return publicJob(job);
  job.title = next;
  bus.emit('job', publicJob(job));
  save(job);
  return publicJob(job);
}

export function jobEventsSince(job, since) {
  return job.events.filter((e) => e.seq > since);
}

// What the drawer opens with: the whole conversation, however it is split. The
// stored log is the spine (it holds every turn this process and every earlier
// one streamed), and memory contributes only the tail past the last stored
// line, the half-second the flush has not caught up with yet. Splitting it the
// other way round (memory first, storage for the rest) is what made a session
// spoken to after a restart show only the half this process had streamed.
export async function jobEventsFor(job, since) {
  const stored = await loadJobEvents(job.id, since);
  const top = stored.length ? stored[stored.length - 1].seq : since;
  return [...stored, ...jobEventsSince(job, top)];
}

// Trash a run: the record and its log. Refuses while it is still going;
// cancel it first, so nothing is still writing as it is deleted.
export async function deleteJobById(id) {
  const job = jobs.get(id);
  if (job && holdsResources(job)) {
    const err = new Error(`This run is ${job.status}; cancel it before deleting it`);
    err.code = 'ACTIVE';
    throw err;
  }
  // Claimed before any await below yields, so a round/verdict read that is
  // retried across interrupted/failed (see isRetired) and resolves somewhere
  // in the middle of this function cannot have its save() write the row back
  // once the DELETE below lands: runFlush skips any id claimed here even while
  // it is still in `jobs` (the unregister at the end is too late to rely on
  // alone, since a flush can run during the awaits ahead of it). Cleared in
  // `finally` so a delete that ends up throwing (the row was never removed)
  // leaves the job saveable again.
  deletingJobs.add(id);
  try {
    // Queued writes go first, or the next flush would write the record straight
    // back after the row is gone. Unsent messages go with them: there is no
    // session left to send them to.
    pendingEvents.delete(id);
    dirtyJobs.delete(id);
    devQueues.delete(id);
    // Closing a session drops its database, but a session that failed is deleted
    // straight from where it died, without ever being closed. Its record is about
    // to go, so this is the last moment anything knows the database's name: drop
    // it here too, or it stays on the server until somebody finds it by hand. No
    // event: there will be no session left to show it on.
    if (job) await dropSessionDatabase(job);
    // Too late for a flush already under way, though: it snapshot dirtyJobs
    // before the line above ran. Wait for it to finish landing whatever it has
    // for this id before deleting, or its save can commit after our DELETE and
    // resurrect the row (it comes back the moment a restart reloads from the
    // database).
    if (currentFlush) await currentFlush.catch(() => {});
    // The database is the only copy now, so a delete it refuses is a delete that
    // did not happen: the row stays, and so does the session in memory, letting
    // the caller report the failure instead of the list quietly disagreeing with
    // storage until the next restart brings the run back.
    // A loop review, QA run or fix session spent its tokens on the parent task's
    // behalf, and its row is the only session-level copy of that spend, so the delete pays
    // it into the parent's row inside its own transaction, where a crash cannot
    // separate the two and a racing close (whose DELETE touches zero rows)
    // transfers nothing. Living here rather than in closeDevSession also
    // catches the retry path: an auto-delete that failed leaves a closed row
    // whose hand-delete comes straight through this function. An orchestrator's
    // worker folds the same way: its spend belongs to the task the orchestrator
    // ran, and deleting the worker must not make that number lie. What moves is
    // the whole rollup (tokens and time as well as cost, and whatever the
    // deleted session had absorbed or still has filed under it), so a number
    // that stood on the orchestrator while the worker existed stands after it.
    const parentId = job ? parentLinkOf(job) : null;
    const usage = parentId ? sessionUsage(job) : null;
    const transfer =
      usage && [usage.costUsd, usage.inputTokens, usage.outputTokens, usage.durationMs].some((v) => v != null)
        ? { intoJobId: parentId, ...usage, sessions: usage.sessions + 1 }
        : null;
    const removed = await dbDeleteJob(id, transfer);
    if (job) unregisterJob(job);
    if (removed && transfer) absorbDeletedSessionUsage(transfer);
    return removed;
  } finally {
    deletingJobs.delete(id);
  }
}

const ACTIVE = ['queued', 'preparing', 'running'];

// Which PHP a job runs against: its project's own. Projects on one machine do
// not have to agree on a version, and one PATH for all of them fails whichever
// project is not the pinned one. Side-by-side installs (ondrej/php's
// /usr/bin/php8.x, phpenv, asdf) keep every version available while the plain
// `php` follows whichever one is globally selected, so prepending the
// project's version directory to PATH pins the
// whole job (including the `php` that composer's shim shells out to) to that
// one instead.
function jobPhpBinDir(job) {
  const project = job && job.repo ? getProject(job.repo) : null;
  return project ? project.phpBinDir : '';
}

// Teaches git the configured GitHub token for github.com only. The token
// travels by environment, never on a command line the event log prints and
// never into the clone's .git/config: a remote URL carrying it would be
// written to disk and echoed back by every later `git remote -v`. The empty
// helper first resets whatever helper list the machine configured, so a stale
// GCM/keychain entry answering first cannot shadow the token we know is good.
// With no token configured this returns nothing and git falls back to the
// machine's own helpers, exactly as before.
function gitCredentialEnv() {
  const token = (getConfig().githubToken || '').trim();
  if (!token) return {};
  const n = Number(process.env.GIT_CONFIG_COUNT) || 0;
  return {
    REVIEWER_GIT_TOKEN: token,
    GIT_CONFIG_COUNT: String(n + 2),
    [`GIT_CONFIG_KEY_${n}`]: 'credential.https://github.com.helper',
    [`GIT_CONFIG_VALUE_${n}`]: '',
    [`GIT_CONFIG_KEY_${n + 1}`]: 'credential.https://github.com.helper',
    [`GIT_CONFIG_VALUE_${n + 1}`]:
      '!f() { test "$1" = get && printf "username=x-access-token\\npassword=%s\\n" "$REVIEWER_GIT_TOKEN"; }; f',
  };
}

// The environment every job child process gets: the parent's, plus git's
// GitHub credentials, plus whatever the caller overrides, plus the job's PHP
// version pinned ahead of everything else on PATH so it runs against that
// rather than the machine's globally selected one (a no-op when neither pin is
// set).
function jobEnv(overrides = {}, job = null) {
  const env = { ...process.env, ...gitCredentialEnv(), ...overrides };
  // The R2 write credential is the server's own, never a session's. In a
  // container the R2_* settings arrive as process environment, and this
  // environment reaches every child (provider CLIs, setup steps, the
  // project's own run commands) where an agent's shell could read it.
  // Nothing a job runs uploads videos; the server does that itself.
  for (const key of Object.keys(env)) if (key.startsWith('R2_')) delete env[key];
  const dir = jobPhpBinDir(job);
  if (!dir) return env;
  env.PATH = `${dir}${path.delimiter}${process.env.PATH || ''}`;
  return env;
}

// The options shared by synchronous git probes and runCmd: probes must use
// the same GitHub credential helper as the commands that fetch and checkout.
export function workspaceGitProbeOptions(job) {
  return {
    encoding: 'utf8',
    env: jobEnv(
      {
        GIT_TERMINAL_PROMPT: '0',
        GCM_INTERACTIVE: 'never',
      },
      job,
    ),
  };
}

// git's --progress counters, which redraw a line per percentage point.
const GIT_PROGRESS_RE =
  /^(?:remote:\s*)?(?:Counting|Compressing|Receiving|Resolving|Updating|Enumerating|Unpacking|Checking out|Filtering content)[a-z ]*:\s+(\d+)%/i;

function runCmd(job, cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    pushEvent(job, 'cmd', { text: `${cmd} ${args.join(' ')}` });
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: workspaceGitProbeOptions(job).env,
      // Its own process group, so killJobProcess can take down whatever it
      // spawned rather than just the direct child.
      detached: true,
    });
    job.proc = child;
    let lastLines = [];
    const onData = (chunk) => {
      for (const line of chunk.toString('utf8').split(/\r?\n|\r/)) {
        const text = line.trim();
        if (!text) continue;
        lastLines.push(text);
        if (lastLines.length > 20) lastLines.shift();
        // Progress redraws are one event per percent: 150 lines of "Receiving
        // objects: 47%" for a 2 KB fetch, which buries the lines a human reads
        // the log for. Keep only each counter's final 100% frame, which carries
        // the totals worth reading.
        const progress = text.match(GIT_PROGRESS_RE);
        if (progress && progress[1] !== '100') continue;
        pushEvent(job, 'git', { text });
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', (e) => {
      job.proc = null;
      reject(e);
    });
    child.on('close', (code) => {
      job.proc = null;
      if (job.status === 'canceled') return reject(new Error('canceled'));
      if (code === 0) resolve();
      else
        reject(new Error(`${cmd} ${args[0]} exited with code ${code}: ${lastLines.slice(-5).join(' | ')}`));
    });
  });
}

// Runs the project's configured dependency install / build steps in the
// workspace clone. Commands come from the project row (operator-authored local
// config, never from the reviewed repository) and run through a shell, so they
// can chain commands and use whatever is on PATH.
//
// Installed artifacts survive between jobs: vendor/ and node_modules/ are
// gitignored, and `git clean -fd` (no -x) leaves ignored files alone, so only
// the first run on a fresh clone pays the full install cost.
function runSetupStep(job, command, cwd, timeoutMin) {
  return new Promise((resolve, reject) => {
    pushEvent(job, 'cmd', { text: command });
    const env = jobEnv(
      {
        GITHUB_TOKEN: getConfig().githubToken,
        GH_TOKEN: getConfig().githubToken,
        GIT_TERMINAL_PROMPT: '0',
        GCM_INTERACTIVE: 'never',
        // Package managers that detect a TTY otherwise emit progress spinners
        // that flood the event log with redraw frames.
        CI: '1',
        NO_COLOR: '1',
        COMPOSER_NO_INTERACTION: '1',
        // This service runs under NODE_ENV=production, and jobEnv inherits it.
        // yarn/npm read that as "skip devDependencies", so a later build step
        // dies on its own toolchain being absent (laravel-mix: "mix: not
        // found"). The reviewer's own environment is not the workspace's.
        NODE_ENV: 'development',
        // The claimed database server's DB_*/REDIS_* overrides, so a migrate or
        // seed step here runs against the session's own database, not whatever
        // the .env template names. Empty when the session claimed no server.
        ...instanceEnv(job),
      },
      job,
    );
    // detached so the whole shell tree is killable: the direct child is only
    // the shell the command went through.
    const child = spawn(command, { cwd, env, shell: true, detached: true });
    job.proc = child;

    let timedOut = false;
    const timer = setTimeout(
      () => {
        timedOut = true;
        pushEvent(job, 'info', { text: `Setup step exceeded ${timeoutMin} min, killing it.` });
        killJobProcess(job);
      },
      timeoutMin * 60 * 1000,
    );

    let lastLines = [];
    const onData = (chunk) => {
      for (const line of chunk.toString('utf8').split(/\r?\n|\r/)) {
        const text = line.trim();
        if (!text) continue;
        lastLines.push(text);
        if (lastLines.length > 20) lastLines.shift();
        pushEvent(job, 'setup', { text: text.slice(0, 500) });
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', (e) => {
      clearTimeout(timer);
      job.proc = null;
      reject(new Error(`Could not start "${command}": ${e.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      job.proc = null;
      if (job.status === 'canceled') return reject(new Error('canceled'));
      if (timedOut) return reject(new Error(`Setup step "${command}" timed out after ${timeoutMin} min`));
      if (code === 0) return resolve();
      reject(
        new Error(`Setup step "${command}" exited with code ${code}: ${lastLines.slice(-5).join(' | ')}`),
      );
    });
  });
}

// Which setup steps are dependency installs, and what each one reads and
// writes. A pooled clone keeps its vendor/ and node_modules/ between sessions
// (git clean -fd leaves ignored files alone), so an install whose manifests are
// byte-for-byte what they were the last time it succeeded in this very slot has
// nothing left to do, and `composer install` on an already-installed tree still
// costs the best part of a minute before it works that out for itself.
//
// Only installs are on the list. Build steps (yarn build, assets:publish) and
// anything that touches the database (migrate, app:install, tenant:install) run
// every time: their inputs are the checked-out source and the session's own
// fresh database, both of which change from one session to the next.
const INSTALL_STEPS = [
  {
    // composer install / composer.phar install, with any flags around it.
    // `run` is excluded so a project script that happens to be called install
    // is not mistaken for the installer itself.
    test: /(^|[\s&|])composer(\.phar)?\s+(?!run\b)[^&|]*\binstall\b/i,
    manifests: ['composer.json', 'composer.lock'],
    outputs: ['vendor'],
  },
  {
    // yarn/npm/pnpm install (and npm ci), including via corepack.
    test: /(^|[\s&|])(corepack\s+)?(yarn|npm|pnpm)\s+(?!run\b)[^&|]*\b(install|ci)\b/i,
    manifests: ['package.json', 'yarn.lock', 'package-lock.json', 'pnpm-lock.yaml', 'npm-shrinkwrap.json'],
    outputs: ['node_modules'],
  },
];

// Where a slot remembers what it has already installed. Inside .git so that the
// checkout's own `git clean -fd` cannot delete it, and so that a reclone (which
// removes the whole directory) correctly starts from no memory at all.
function setupStateFile(dir) {
  return path.join(dir, '.git', 'reviewer-setup.json');
}

function readSetupState(dir) {
  try {
    return JSON.parse(fs.readFileSync(setupStateFile(dir), 'utf8')) || {};
  } catch {
    return {}; // no memory yet, or a file we cannot read: install and rewrite it
  }
}

function writeSetupState(dir, state) {
  try {
    fs.writeFileSync(setupStateFile(dir), JSON.stringify(state, null, 2), 'utf8');
  } catch {
    /* the step still ran; the next session just installs again */
  }
}

// The fingerprint an install step is cached against: the command itself, the
// PHP it runs under, and the contents of every manifest it reads. A manifest
// that does not exist is recorded as absent, so adding one busts the cache.
function installFingerprint(dir, command, rule, project) {
  const h = crypto.createHash('sha1');
  h.update(command)
    .update('\0')
    .update(project.phpBinDir || '');
  for (const name of rule.manifests) {
    h.update('\0').update(name).update('\0');
    try {
      h.update(fs.readFileSync(path.join(dir, name)));
    } catch {
      h.update('absent');
    }
  }
  return h.digest('hex');
}

// Whether this step can be skipped: an install rule matches it, everything it
// installs is still on disk, and its fingerprint is the one recorded when it
// last succeeded here.
function installCacheKey(dir, command, project) {
  const rule = INSTALL_STEPS.find((r) => r.test.test(command));
  if (!rule) return null;
  if (!rule.outputs.every((out) => fs.existsSync(path.join(dir, out)))) return null;
  return installFingerprint(dir, command, rule, project);
}

// Throws on the first failing step: a review of a half-installed tree would
// report failures that belong to the workspace, not to the pull request.
async function runSetupCommands(job, dir, repoFull) {
  const project = getProject(repoFull);
  const commands = project ? project.setupCommands : [];
  if (!commands.length) {
    pushEvent(job, 'info', { text: `No setup steps configured for ${repoFull}, using the checkout as-is.` });
    job.setupSteps = null;
    return;
  }

  // How long one setup step may run before it is killed.
  const timeoutMin = 15;
  if (project.phpBinDir) {
    pushEvent(job, 'info', { text: `This project pins its own PHP: ${project.phpBinDir}` });
  }
  pushEvent(job, 'info', {
    text: `Installing project dependencies for ${repoFull} (${commands.length} step(s), first run can take a while)…`,
  });
  job.setupSteps = commands.length;
  save(job);

  // What this slot installed last time, so an install whose manifests have not
  // moved since can be skipped. Read once and written back after each install
  // that runs, so a session killed halfway leaves the steps it did finish cached
  // and the ones it never reached uncached.
  const state = readSetupState(dir);

  for (const [i, command] of commands.entries()) {
    pushEvent(job, 'info', { text: `Setup step ${i + 1}/${commands.length}` });
    const key = installCacheKey(dir, command, project);
    if (key && state[command] === key) {
      pushEvent(job, 'cmd', { text: command });
      pushEvent(job, 'info', {
        text: 'Skipped: this workspace already installed exactly these dependencies and nothing it reads has changed.',
      });
      continue;
    }
    // A stale entry goes now rather than after the run: a step killed or failed
    // midway must not leave the previous fingerprint behind claiming the tree
    // is installed.
    if (state[command]) {
      delete state[command];
      writeSetupState(dir, state);
    }
    await runSetupStep(job, command, dir, timeoutMin);
    if (job.status === 'canceled') throw new Error('canceled');
    if (key) {
      state[command] = key;
      writeSetupState(dir, state);
    }
  }
  job.setupDone = true;
  pushEvent(job, 'info', { text: 'Project dependencies are ready.' });
  save(job);
}

// The CLI ignores a repo's own .claude/settings.json (skill permissions, hooks)
// in a directory that never went through the interactive trust dialog, and a
// headless run can never answer it. We created this clone ourselves from a repo
// the user explicitly queued for review, so record the trust decision for it.
// Trust lives in the .claude.json of the config dir the run uses, and each
// provider entry has its own (CLAUDE_CONFIG_DIR), so the flag must be written
// there, not in the machine's ~/.claude.json, which no run reads.
// Keys are stored with forward slashes, matching how the CLI writes them.
function trustWorkspace(job, dir, configDir) {
  const file = path.join(configDir, '.claude.json');
  try {
    const cfgJson = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
    cfgJson.projects = cfgJson.projects || {};
    const slashKey = dir.replace(/\\/g, '/');
    // Always write the slash form; also fix a backslash entry if one exists.
    const keys = cfgJson.projects[dir] ? [slashKey, dir] : [slashKey];
    const stale = keys.filter((k) => (cfgJson.projects[k] || {}).hasTrustDialogAccepted !== true);
    if (!stale.length) return;
    for (const key of stale) {
      cfgJson.projects[key] = { ...(cfgJson.projects[key] || {}), hasTrustDialogAccepted: true };
    }
    // Write via temp + rename so a concurrent CLI write can never observe a
    // half-written config.
    const tmp = `${file}.reviewer-${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(cfgJson, null, 2), 'utf8');
    fs.renameSync(tmp, file);
    pushEvent(job, 'info', { text: 'Marked the workspace clone as trusted for the Claude CLI.' });
  } catch (e) {
    pushEvent(job, 'info', {
      text: `Could not mark workspace as trusted (${e.message}); repo-local Claude settings may be ignored.`,
    });
  }
}

// Clones the repo into the job's pool slot on first use and repairs/refreshes
// the clone on later runs. The pool hands each slot to exactly one job at a
// time, so nothing else writes to this tree while we own it.
async function ensureClone(job, dir, repoFull) {
  const cleanUrl = `https://github.com/${repoFull}.git`;

  if (fs.existsSync(path.join(dir, '.git'))) {
    // Self-heal: a force-killed previous job (cancel/timeout SIGKILLs the whole
    // process group) can leave stale git lock files or a broken clone behind.
    // We own this
    // slot exclusively, so removing locks is safe.
    for (const lock of ['index.lock', 'config.lock', 'HEAD.lock', 'packed-refs.lock', 'shallow.lock']) {
      fs.rmSync(path.join(dir, '.git', lock), { force: true });
    }
    try {
      await runCmd(job, 'git', ['-C', dir, 'rev-parse', '--git-dir']);
    } catch {
      pushEvent(job, 'info', { text: 'Existing clone looks broken, deleting it and recloning…' });
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  if (!fs.existsSync(path.join(dir, '.git'))) {
    pushEvent(job, 'info', {
      text: `Cloning ${repoFull} (blobless partial clone, first run can take a while)…`,
    });
    // A slot dir left without .git (a clone killed at just the wrong moment)
    // would make git clone refuse, so always start from an empty dir.
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    await runCmd(job, 'git', ['clone', '--filter=blob:none', '--no-checkout', '--progress', cleanUrl, dir]);
  }
  await normalizeLineEndings(job, dir);
  return dir;
}

// A global core.autocrlf=true in ~/.gitconfig (nothing here sets it, but a
// gitconfig carried in from elsewhere can) gives every checkout CRLF working
// files, which makes linters
// (phpcs) report line-ending violations on code the session never touched:
// noise it then has to spend turns disproving. Force LF in the clone and
// renormalize the tree once; later runs see it already set and skip straight
// past.
async function normalizeLineEndings(job, dir) {
  const probe = spawnSync('git', ['-C', dir, 'config', '--local', '--get', 'core.autocrlf'], {
    encoding: 'utf8',
  });
  if ((probe.stdout || '').trim() === 'false') return;
  try {
    await runCmd(job, 'git', ['-C', dir, 'config', 'core.autocrlf', 'false']);
    // A clone made with --no-checkout has no working tree yet, so the setting
    // alone is enough: the job's own checkout lands as LF. Renormalizing there
    // would instead materialize the default branch in full, fetching every blob
    // the blobless clone deliberately skipped.
    if (!fs.readdirSync(dir).some((name) => name !== '.git')) {
      pushEvent(job, 'info', { text: 'Set core.autocrlf=false on the new clone; it will check out as LF.' });
      return;
    }
    // An index built under CRLF reports every file as modified once the setting
    // flips; dropping and rebuilding it is what makes the change take effect.
    await runCmd(job, 'git', ['-C', dir, 'rm', '--cached', '-r', '-q', '--ignore-unmatch', '.']);
    await runCmd(job, 'git', ['-C', dir, 'reset', '--hard', '-q']);
    pushEvent(job, 'info', { text: 'Set core.autocrlf=false on the clone and renormalized it to LF.' });
  } catch (e) {
    // Cosmetic: the session still works, its linter just gets chattier.
    pushEvent(job, 'info', {
      text: `Could not normalize line endings (${e.message}); linters may report CRLF noise.`,
    });
  }
}

// Write the checkout's .env from the project's stored template. Rewritten on
// every run, overwriting whatever a previous session left behind, so each
// clone in the pool starts from the same known-good settings the operator
// maintains on the settings page, and a brand-new slot is configured before its
// setup steps run.
function seedCheckoutEnv(job, dir, repoFull) {
  const project = getProject(repoFull);
  if (!project || !project.envTemplate.trim()) return;
  // An unpooled session runs against a database of its own, and the name replaces
  // the template's DB_DATABASE so the checkout's .env points at it.
  let content = project.envTemplate;
  if (job.sessionDb) {
    content = /^DB_DATABASE=/m.test(content)
      ? content.replace(/^DB_DATABASE=.*$/m, `DB_DATABASE=${job.sessionDb}`)
      : `${content.replace(/\n?$/, '\n')}DB_DATABASE=${job.sessionDb}\n`;
  }
  try {
    fs.writeFileSync(path.join(dir, '.env'), content, 'utf8');
    pushEvent(job, 'info', { text: "Wrote the project's .env template into the checkout." });
  } catch (e) {
    // Fail loudly: running setup or a session against wrong settings produces
    // failures that belong to the workspace, not to the change under review.
    throw new Error(`Could not write the project's .env into the checkout: ${e.message}`, { cause: e });
  }
}

// The prompt gets this when the runner installed the project's dependencies:
// without it the session assumes a bare checkout and never tries to run
// anything, and it would otherwise read the generated vendor/ and node_modules/
// trees as part of the change under review.
function setupContext(job) {
  if (!job.setupDone) return '';
  return `\n\nThe project's dependencies were installed and its assets built in this checkout before you started, so it is in a runnable state: you may run its test suite, linters and other tooling. The generated output (vendor/, node_modules/, build artifacts, and anything else those steps produced) is untracked scaffolding, not part of the change: never review it, never commit it, and never include it in any diff you produce.`;
}

// Kill a child and everything it spawned. Several of these children are a
// shell, so signalling the direct child alone would leave the real work
// running; they are spawned detached, which makes each one a process-group
// leader, so a negative pid reaches the whole group. The single-pid fallback
// covers a child that is not a group leader.
function killTree(proc) {
  if (!proc || !proc.pid || proc.exitCode !== null) return;
  try {
    process.kill(-proc.pid, 'SIGKILL');
  } catch {
    try {
      proc.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  }
}

function killJobProcess(job) {
  killTree(job.proc);
}

// ---------------------------------------------------------------------------
// Developer sessions (the /developer chat page)
//
// A dev session is a job of kind 'devchat', not 'dev', which the removed
// developer mode (e9f7448) already used for rows that still live in the jobs
// table. It is a conversation with one of the coding agents
// (claude / codex / grok / opencode) inside a workspace clone of its project
// with a database server of its own. The session keeps its clone and claim between
// turns, for as long as the conversation stays open. Each user message spawns
// one headless provider run that resumes the provider's own session state.
// ---------------------------------------------------------------------------

export const DEV_OPEN = ['queued', 'preparing', 'running', 'idle'];

// `closed` is the one status a session never comes back from; `interrupted`
// and `failed` are not it, even though neither is in DEV_OPEN. A pending
// review-loop/QA-loop round or verdict is a plain GitHub read that needs none
// of the session's own resources, so wherever the question is "has nobody
// been left to want this any more" (rather than "is the session itself
// live"), test this instead of DEV_OPEN.
export function isRetired(status) {
  return status === 'closed';
}

// Messages typed while a turn was still in flight. The composer used to refuse
// them outright, which meant sitting on a correction until the agent stopped;
// they wait here instead and run as their own turns, in order, the moment the
// turn that was going finishes. Deliberately not part of the session record: a
// queue is this process's memory, and a restart interrupts the session anyway.
const devQueues = new Map(); // job id -> [{ prompt, shown, files }]

const MAX_QUEUED = 20;

function queueDevMessage(job, entry) {
  const queue = devQueues.get(job.id) || [];
  if (queue.length >= MAX_QUEUED) {
    throw new Error(
      `Already ${queue.length} message(s) queued for this session; wait for the current turn to work through them`,
    );
  }
  queue.push(entry);
  devQueues.set(job.id, queue);
  bus.emit('job', publicJob(job));
}

// Take a queued message back out before it is sent. Returns whether there was
// one at that position: a message the drain just picked up is gone already.
export function dropQueuedMessage(id, index) {
  const job = jobs.get(id);
  if (!job || job.kind !== 'devchat') throw new Error('Session not found');
  const queue = devQueues.get(id) || [];
  if (!Number.isInteger(index) || index < 0 || index >= queue.length) return false;
  queue.splice(index, 1);
  if (queue.length) devQueues.set(id, queue);
  else devQueues.delete(id);
  bus.emit('job', publicJob(job));
  return true;
}

// Work through whatever was typed during the turn that just ended, one turn per
// message, the same conversation the user would have had by waiting, with the
// agent's reply in between. A canceled turn still drains: "stop, do this
// instead" is exactly why a message gets queued mid-run.
async function drainDevQueue(job) {
  for (;;) {
    const queue = devQueues.get(job.id) || [];
    if (!queue.length || job.status === 'closed') {
      devQueues.delete(job.id);
      return;
    }
    const next = queue.shift();
    if (queue.length) devQueues.set(job.id, queue);
    else devQueues.delete(job.id);
    if (next.newFusionBrief) {
      job.zeusProposalPrompt = null;
      save(job);
    }
    pushEvent(job, 'user', { text: next.shown, ...attachmentMeta(next.files) });
    if (job.status !== 'running') setStatus(job, 'running', { error: null });
    await runDevTurn(job, next.prompt);
  }
}

export function listDevSessions() {
  return [...jobs.values()]
    .filter((j) => j.kind === 'devchat')
    .map(publicJob)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function openDevSessions() {
  return [...jobs.values()].filter((j) => j.kind === 'devchat' && DEV_OPEN.includes(j.status));
}

// git check-ref-format's rules, near enough: the picker offers whatever the
// repository actually has, and real branches use characters (`#`, `]`, …) that
// a tighter rule would reject. The name only ever
// reaches git inside an argv array and inside a refs/… path, so the one thing
// that must stay out is a leading "-", which `checkout -B <name>` would read as
// a flag.
function isValidBranchName(name) {
  if (/[\x00-\x20~^:?*[\\\x7f]/.test(name)) return false;
  if (name.includes('..') || name.includes('//') || name.includes('@{')) return false;
  if (/^[-./]/.test(name) || /[./]$/.test(name)) return false;
  return !name.endsWith('.lock') && name !== '@';
}

function devTitle(prompt) {
  const line = String(prompt).trim().split('\n')[0];
  return line.length > 60 ? line.slice(0, 60) + '…' : line;
}

// The uploads a message came with, resolved to files on disk. Failing on a
// missing one beats silently sending a prompt that points at nothing: the
// user still has the composer in front of them and can re-attach.
function resolveAttachments(ids) {
  return (Array.isArray(ids) ? ids.slice(0, 20) : []).map((id) => {
    const file = getUpload(id);
    if (!file) throw new Error('An attached file is no longer on the server; remove it and attach it again');
    return file;
  });
}

// How the agent learns about the attachments: absolute paths appended to the
// prompt, for it to read with its own file tools.
function attachmentNote(files) {
  if (!files.length) return '';
  return (
    `\n\nThe user attached ${files.length === 1 ? 'this file' : 'these files'} to the message, read ${files.length === 1 ? 'it' : 'them'} from disk:\n` +
    files.map((f) => `- ${f.path} (${Math.max(1, Math.round(f.size / 1024))} KB)`).join('\n')
  );
}

// What the user event (and through it the UI) shows for the attachments:
// names and sizes, not server paths.
function attachmentMeta(files) {
  return files.length ? { attachments: files.map(({ name, size }) => ({ name, size })) } : {};
}

// The open sessions that hold a pooled database server, the only sessions
// that are in anybody's way, and so the only ones the cap counts. An
// orchestrator never claims one, however its project is configured, so it
// never counts.
function pooledDevSessions() {
  return openDevSessions().filter((j) => !j.orchestrator && projectClaimsServer(j.repo));
}

// How many more sessions this project may open. A project that does not claim
// a database server has nothing to run out of: its sessions share no exclusive
// resource, so there is no cap at all.
export function devSessionSlots(repoFull) {
  if (!projectClaimsServer(repoFull)) return Infinity;
  return Math.max(0, sessionCapacity() - pooledDevSessions().length);
}

// `autoClose` and `prNumber` are not part of the HTTP surface; they are what
// an errand this app composes passes: the PR it already knows the number of,
// and "release the clone and the database server the moment the work is
// published", since nobody is sitting in front of that session waiting to ask
// it a follow-up.
//
// `title` is the same kind of caller-side detail: an ⚡ Actions session sends a
// long prompt this app wrote, so the sidebar shows the action's own name rather
// than the first sixty characters of it.
//
// `qa` is the 🎬 QA errand: the test sheet and the test run for a pull request
// whose code has been approved. It is a session of its own rather than more
// turns on a review's, because the two are started at different moments and a
// review session that sat waiting for QA would hold its clone and its database
// server for however long the humans took to approve.
//
// `prBranch` is what an errand that never checks its pull request out (📋 Test
// sheet, ✎ PR body, 🧹 Delete my comments work through gh alone) says it is
// about. Those run in the developer's own checkout, so the branch they end up
// on is whatever the developer had out, filing the run under a pull request
// nobody started it from. The branch the errand's PR is open from is known when
// it starts, so it is kept rather than inferred later.
// `reviewLoop` arms the review loop on a durable task session: a
// from-scratch composer session, or 🛠 Implement feedback from the board:
// every time the session settles with new commits on its open pull request,
// a review session is started for it, and the findings that review leaves are
// handed to a fix session of their own, round after round for as long as
// reviews keep finding things (see the review-loop section below).
// `loopParentId` is the other half: it marks a review session that loop
// started, so its close reports back to the session it reviews for.
// `loopFixParentId` is the third: it marks a fix session the loop started to
// implement a round's findings (startLoopFixSession), whose close likewise
// reports back to the session whose loop it fixes for.
//
// The runtime an orchestrator was started with for its workers, as the record
// stores it: the provider row id, and a model and effort that provider offers
// (one it does not falls to its default, as it would on the session itself).
// Nothing named is null, and the project's worker runtime applies at spawn.
function normalizeWorkerRuntime(input, cfg) {
  if (input == null || typeof input !== 'object') return null;
  const provider = getProvider(input.providerId);
  if (!provider) throw new Error(`Unknown worker provider: ${input.providerId}`);
  const models = providerModels(provider, cfg);
  const efforts = providerEfforts(provider);
  return {
    providerId: provider.id,
    model: models.includes(input.model) ? input.model : providerDefaultModel(provider, cfg),
    effort: efforts.includes(input.effort) ? input.effort : providerDefaultEffort(provider, cfg),
  };
}

// The analyst roles a ⚡ Zeus session staffs, in the order the method runs
// them: two independent complete proposals. Each must be given a
// runtime of its own when the session starts, so the operator decides which
// model independently reads the same brief (the diversity the fusion pattern
// leans on) instead of leaving it to the agent's pick.
export const ZEUS_PROPOSAL_ROLES = ['product', 'architecture'];
// Keep qa and validator readable for existing sessions, which staffed a third
// proposal slot and, older still, a separate validator; new fusion runs pair
// two proposals and use Zeus itself to summarize.
export const ZEUS_ROLES = [...ZEUS_PROPOSAL_ROLES, 'qa', 'validator'];

function normalizeZeusRoles(input, cfg) {
  if (input == null || typeof input !== 'object') return null;
  const unknown = Object.keys(input).filter((k) => !ZEUS_ROLES.includes(k));
  if (unknown.length) throw new Error(`Unknown Zeus analyst role: ${unknown.join(', ')}`);
  const roles = {};
  for (const role of ZEUS_ROLES) {
    if (input[role] == null) continue;
    roles[role] = normalizeWorkerRuntime(input[role], cfg);
  }
  return Object.keys(roles).length ? roles : null;
}

// `orchestrator` is the supervisor kind: a chat-only session with no checkout,
// no pooled database server and no branch, whose agent gets the worker tools
// (spawn/list/read/send/close, see spawnWorkerSession) instead of a tree to
// edit. `parentId` is the generic child link those tools create: unlike
// loopParentId/qaParentId it carries no workflow of its own; a worker is a
// first-class session that merely files under its orchestrator.
//
// `zeus` is the epic-writing flavour of that supervisor (⚡ Zeus): the same
// chat-only session with the same worker tools, briefed to turn a brief into a
// GitHub epic rather than to land code. It differs in two ways the record has
// to carry: it gets a read-only clone of the default branch beside its scratch
// dir, so it can investigate and verify evidence itself, and its workers are
// analysts (`readOnly`), who report findings instead of pushing code.
/**
 * @param {{ provider?: any, model?: string, effort?: string, prompt?: string,
 *   repo?: string, branch?: string, review?: boolean, qa?: boolean,
 *   local?: boolean, attachments?: any[], autoClose?: boolean,
 *   prNumber?: number|string, prBranch?: string, title?: string,
 *   reviewLoop?: boolean, qaLoop?: boolean, loopParentId?: string,
 *   qaParentId?: string, loopFixParentId?: string, orchestrator?: boolean, zeus?: boolean,
 *   workerRuntime?: { providerId?: any, model?: string, effort?: string } | null,
 *   zeusRoles?: Record<string, { providerId?: any, model?: string, effort?: string }> | null,
 *   parentId?: string, toolingFor?: string, readOnly?: boolean, analystRole?: string,
 *   activity?: string }} opts
 */
export function createDevSession({
  provider,
  model,
  effort,
  prompt,
  repo,
  branch,
  review,
  qa,
  local,
  attachments,
  autoClose,
  prNumber,
  prBranch,
  title,
  reviewLoop,
  qaLoop,
  loopParentId,
  qaParentId,
  loopFixParentId,
  orchestrator,
  zeus,
  workerRuntime,
  zeusRoles,
  parentId,
  toolingFor,
  readOnly,
  analystRole,
  activity,
}) {
  const cfg = getConfig();
  const prov = getProvider(provider);
  if (!prov) throw new Error(`Unknown provider: ${provider}`);
  const binary = getBinary(prov.binary);
  const found = binary.bin(cfg);
  if (!found) throw new Error(`${prov.label}: the ${binary.label} CLI was not found on this machine`);
  const projects = activeProjects();
  if (!projects.length) throw new Error('No projects are set up yet; add one in Settings first');
  // The stored spelling wins over whatever the client sent, so every later
  // lookup (setup steps, database profile, run command) finds the project.
  const project = repo
    ? projects.find((p) => p.repo.toLowerCase() === String(repo).toLowerCase())
    : projects[0];
  if (!project) throw new Error(`Unknown project: ${repo}`);
  // An existing branch to check out and work on, instead of cutting a fresh
  // dev-<id> branch off the default one: what the composer's branch picker
  // sends, and how a code-review session lands on the code it is asked to
  // review. A review's first message is composed here per provider (each has
  // its own way of triggering a review), so the client sends only the branch.
  branch = typeof branch === 'string' ? branch.trim() : '';
  if (branch && !isValidBranchName(branch)) throw new Error(`"${branch}" is not a valid branch name`);
  // An orchestrator only talks and steers: everything that needs a working
  // tree of its own (a review, a QA run, the loops, a branch to check out) is
  // its workers' job, and autoClose would delete the one conversation the
  // whole task hangs off. Checked ahead of those options' own rules, so the
  // refusal names the real conflict.
  zeus = !!zeus;
  orchestrator = !!orchestrator || zeus;
  if (orchestrator && (review || qa || local || autoClose || reviewLoop || qaLoop || branch)) {
    throw new Error('An orchestrator session only chats and manages workers; it takes none of those options');
  }
  // A read-only session analyses and reports: no loop can review a push it
  // never makes, and it is always somebody's worker (a Zeus analyst).
  readOnly = !!readOnly;
  if (readOnly && (orchestrator || review || qa || local || autoClose || reviewLoop || qaLoop)) {
    throw new Error('A read-only analyst session only reads and reports; it takes none of those options');
  }
  if (readOnly && !parentId) throw new Error('A read-only analyst is a worker session of some Zeus session');
  analystRole = typeof analystRole === 'string' && analystRole ? analystRole : null;
  if (analystRole && !readOnly) throw new Error('Only a read-only analyst carries a Zeus role');
  if (analystRole && !ZEUS_ROLES.includes(analystRole)) {
    throw new Error(`Unknown Zeus analyst role: ${analystRole}`);
  }
  // What this orchestration's workers run on when a spawn names nothing: the
  // pick made when the epic was started, ahead of the project's worker
  // runtime from Settings. Checked now so a wrong provider fails the start
  // rather than the first spawn.
  if (workerRuntime != null && !orchestrator) {
    throw new Error('Only an orchestrator session carries a runtime for its workers');
  }
  const workers = orchestrator ? normalizeWorkerRuntime(workerRuntime, cfg) : null;
  // What each analyst role runs on, when the start picked them: Zeus only.
  if (zeusRoles != null && !zeus) throw new Error('Only a Zeus session carries runtimes for analyst roles');
  const roles = zeus ? normalizeZeusRoles(zeusRoles, cfg) : null;
  if (zeus && (!roles || ZEUS_PROPOSAL_ROLES.some((role) => !roles[role]))) {
    throw new Error('Choose a model for both proposal slots before starting Zeus');
  }
  // The generic child link. Validated here so a worker always files under a
  // live supervisor; the review/QA loops keep their own parent fields.
  if (parentId) {
    const parent = jobs.get(parentId);
    if (!parent || parent.kind !== 'devchat' || !parent.orchestrator) {
      throw new Error(`No orchestrator session ${parentId} to file this worker under`);
    }
    if (orchestrator) throw new Error('An orchestrator cannot be another orchestrator’s worker');
    // Zeus never lands code, so its workers cannot be tasks that land code
    // either: every worker under it is an analyst (a tooling fix excepted,
    // which goes to the dashboard's own project rather than to this one).
    if (parent.zeus && !readOnly && !toolingFor) {
      throw new Error('A Zeus session only starts read-only analysts');
    }
  }
  // A tooling fix is a worker and nothing else: the repository it names is
  // the orchestration it was sent from, which only a worker has.
  if (toolingFor && !parentId) throw new Error('A tooling fix is a worker session of some orchestrator');
  review = !!review;
  // A QA session's turns run the app, record videos against it and may push a
  // fix to the pull request's branch, so it wants the same prepared workspace a
  // review gets, never the shared local checkout.
  qa = !!qa;
  if (qa && review) throw new Error('A session is either a code review or a QA run, not both');
  if (qa && local)
    throw new Error('A QA run needs a workspace clone of its own; switch Local mode off to run one');
  if (qa && !branch) throw new Error('A QA run needs the pull request branch to test');
  // The loop is a property of a durable task session: a from-scratch
  // composer session, or 🛠 Implement feedback from the board, which is that
  // same kind of work started on an existing pull request. A review, a QA
  // run or an auto-closing errand is itself one step of somebody's flow, and
  // a local session cannot start reviews (a review needs a workspace clone).
  // A review started by hand never carries a loop either: what the
  // composer's ⌕ button and the board start is exactly one review.
  reviewLoop = !!reviewLoop;
  qaLoop = !!qaLoop;
  if (reviewLoop && (review || qa || local || autoClose)) {
    throw new Error('The review loop only applies to a session started from scratch on a task');
  }
  if (qaLoop && (review || qa || local || autoClose)) {
    throw new Error('The QA loop only applies to a session started from scratch on a task');
  }
  if (qaLoop && !reviewLoop) {
    throw new Error('The QA loop waits for the review loop; arm the review loop too');
  }
  // Local mode: work inside the project's existing checkout instead of a
  // workspace clone. A picked branch is switched to with a plain checkout
  // (git refuses over conflicting uncommitted changes, which is the right
  // failure in a shared tree), and no branch means "whatever is checked out".
  // No review lane either (a review force-checks-out the branch, which a
  // shared tree must never do).
  local = !!local;
  if (local) {
    if (review)
      throw new Error('A code review runs in a workspace clone of its own; switch Local mode off to run one');
    const dir = project.localDir;
    if (!dir)
      throw new Error(
        `${project.repo} has no local checkout configured; set one in Settings to use Local mode`,
      );
    if (!fs.existsSync(path.join(dir, '.git'))) throw new Error(`${dir} is not a git checkout`);
    // A busy checkout is no longer refused here: the session is created
    // queued and starts the moment the holder closes (acquireLocalDir).
  }
  if (review && !branch) throw new Error('A code review needs the branch to review');
  // A review's (and a QA run's) first message is composed server-side;
  // attachments belong to chat messages only.
  const files = review || qa ? [] : resolveAttachments(attachments);
  const text = typeof prompt === 'string' ? prompt.trim() : '';
  if (!review && !qa && !text && !files.length) throw new Error('The first message cannot be empty');
  // Resolved before the first message is composed: a review prompt carries the
  // session's effort into the provider's review command.
  effort = providerEfforts(prov).includes(effort) ? effort : providerDefaultEffort(prov, cfg);
  // A QA session opens on the test sheet; whether it goes on to execute it is
  // the project's call, decided when that turn ends (runQaSequence).
  const qaFirstMessage = () =>
    testSheetPrompt({
      repo: project.repo,
      prNumber: prNumber || null,
      branch,
      project,
    });
  // No base branch yet: the clone that resolves it is made when the session
  // runs, so the review command names the repository's default branch instead.
  const firstMessage = review
    ? binary.reviewPrompt({ branch, prNumber, effort, base: null })
    : qa
      ? qaFirstMessage()
      : (text + attachmentNote(files)).trim();
  // An orchestrator claims no database server, so it is never in the pool's
  // way and the cap does not apply to it; its workers each pass through here
  // on their own.
  if (!orchestrator && projectClaimsServer(project.repo)) {
    const open = pooledDevSessions();
    if (open.length >= sessionCapacity()) {
      throw new Error(
        `Already ${open.length} open session(s) holding a database server; close one first (${project.repo} gives each session a server of its own)`,
      );
    }
  }
  const models = providerModels(prov, cfg);
  const job = {
    id: crypto.randomUUID().slice(0, 8),
    kind: 'devchat',
    // The row id is what resolves the provider later; the label is what the
    // UI shows, kept even if the row is renamed or deleted.
    providerId: prov.id,
    provider: prov.label,
    model: models.includes(model) ? model : providerDefaultModel(prov, cfg),
    effort,
    // Usage belongs to this stable project row, independently of whether this
    // session and its transcript are kept.
    projectId: project.id,
    repo: project.repo,
    // What kind of work this session's spend is filed under in the usage
    // ledger. A board action names its own id (server.js passes it through);
    // everything else is derived from what the session is: a review, a QA run,
    // a supervisor, one of its workers, or a plain conversation. Named here
    // once, not per turn: a review's publish turn is still review spend.
    activity:
      (typeof activity === 'string' && activity.trim()) ||
      (review
        ? 'code-review'
        : qa
          ? 'qa'
          : zeus
            ? 'zeus'
            : orchestrator
              ? 'orchestrator'
              : readOnly
                ? 'analyst'
                : parentId
                  ? 'worker'
                  : 'chat'),
    local,
    title: review
      ? `Code review: ${prNumber ? `#${prNumber} ` : ''}${branch}`
      : qa
        ? `QA: ${prNumber ? `#${prNumber} ` : ''}${branch}`
        : typeof title === 'string' && title.trim()
          ? devTitle(title)
          : devTitle(text || `📎 ${files[0].name}`),
    status: 'queued',
    createdAt: now(),
    startedAt: null,
    endedAt: null,
    error: null,
    // The provider-side conversation id. claude and grok accept a UUID we
    // choose up front; codex and opencode assign their own, captured from the
    // first turn's stream.
    providerSessionId: crypto.randomUUID(),
    // One conversation per provider row, keyed by id: a resume id belongs to
    // the CLI (and the login) that issued it, so a project step configured to
    // run on another provider gets a thread of its own in the same workspace
    // rather than trying to resume this one's. The session's own provider is
    // filled in lazily from the two fields above.
    chats: {},
    turns: 0,
    costUsd: null,
    // Token accounting, filled in as turns end: total consumption (input /
    // output), the live context size against the model's window, and, for
    // claude, the /context probe's per-category breakdown.
    inputTokens: null,
    outputTokens: null,
    contextTokens: null,
    contextWindow: null,
    contextUsage: null,
    // The Task calls working right now, for the right panel's live view.
    subagents: [],
    setupSteps: null,
    setupDone: false,
    // The existing branch the workspace checks out and works on; null means
    // "cut a fresh dev-<id> branch off the default branch". reviewBranch is the
    // same branch when the session was started from ⌕ Code review, and is what
    // makes the first turn a review turn.
    startBranch: branch || null,
    reviewBranch: review ? branch : null,
    // The pull request branch a QA session tests. Set on nothing else: it is
    // what makes the first turn a test sheet and what the turns after it work
    // against.
    qaBranch: qa ? branch : null,
    // The review turn's own message, kept so the panel can show what the
    // session was actually asked without re-composing it per provider.
    reviewPrompt: review ? firstMessage : null,
    // Close this session once its work is done rather than leaving a clone and
    // a database server held for a thread nobody continues: the board's ⚡
    // errands that report on the PR itself.
    //
    // Every code review is one of those, however it was started: what it found
    // is published on the pull request, which is where findings get read,
    // replied to and implemented from. So a review started by hand ends like a
    // review the loop started: the clone and the database server go back, and
    // the record goes with them instead of piling one row per review up in the
    // sidebar. A review that stopped to ask something is the exception the
    // close itself makes: it stays open until it is answered.
    autoClose: !!autoClose || review,
    // The review loop's state, when the composer armed it. setReviewLoop
    // arms and disarms the same field later: how many reviews it has started,
    // whether one is out right now, the commit the last one reviewed (the gate
    // that keeps a session with nothing new pushed from being reviewed again)
    // and, on records written before fixes ran in sessions of their own, a fix
    // prompt held back while the session waited on an answer (see
    // maybeStartLoopReview).
    reviewLoop: reviewLoop ? newReviewLoop() : null,
    // The QA loop's state, when the composer armed it. It is deliberately not a
    // round counter: QA runs once, after the review loop converges cleanly.
    qaLoop: qaLoop ? newQaLoop() : null,
    // Set on a review session the loop started: the session its close reports
    // back to, and, once the review has actually published, the flag that
    // says the close carries findings rather than an abort.
    loopParentId: loopParentId || null,
    loopReviewDone: false,
    // Set on a QA session the QA loop started. Separate from loopParentId so a
    // QA close reports test failures rather than being mistaken for a review.
    qaParentId: qaParentId || null,
    qaLoopDone: false,
    // Set on a fix session the review loop started to implement a round's
    // findings. Its close is what releases the loop for the next round, and
    // the done flag distinguishes a finished errand from one stopped mid-way.
    loopFixParentId: loopFixParentId || null,
    loopFixDone: false,
    // The supervisor kind and its generic child link (see the comment above
    // this function). Workers stay first-class sessions: parentId only files
    // them under their orchestrator and routes it their notices.
    orchestrator,
    zeus,
    parentId: parentId || null,
    // A Zeus analyst: reads the checkout, runs what it needs to, and reports
    // in its reply. Never commits, pushes or opens a pull request; the UI
    // offers it none of those either.
    readOnly,
    // Provider row id, model and effort its workers default to (orchestrator
    // only, null when the start named none). Kept as ids and names, not the
    // resolved rows, so a spawn resolves them against the entries as they
    // stand then, the way the project's worker runtime is.
    workerRuntime: workers,
    // The runtime each analyst role spawns on (Zeus only, null when the start
    // picked none): the same shape as workerRuntime, per role.
    zeusRoles: roles,
    // Which of ZEUS_ROLES this analyst plays, when its spawn said.
    analystRole,
    // Set on a worker the fix_tooling tool started: the repository of the
    // orchestration whose tooling it fixes. The worker itself runs on the
    // dashboard's own project (this session's repo), which is usually another
    // one; the sidebar and the worker list say so.
    toolingFor: toolingFor || null,
    // The pull request this session was started from, when the caller knew it:
    // a ⌕ Code review on a PR branch, a board errand. It
    // is what the review's later turns publish to, and what attaches the PR to
    // the session at creation instead of when its URL turns up in the stream.
    startedOnPr: prNumber || null,
    // The branch that pull request is open from, when the session works on it
    // without checking it out. What the session is about, as opposed to
    // `branch`, which is the tree it actually runs in.
    prBranch: prBranch || null,
    branch: null,
    baseBranch: null,
    // Whether the provider holds a resumable conversation: every turn,
    // review turns included, leaves one behind once it has run.
    chatStarted: false,
    // The agent asked something and stopped for the answer. Set by the `ask`
    // event, cleared by the next thing the user says.
    awaitingAnswer: false,
    // Filled in by syncDevPr() once this session's pull request is known: from
    // the branch it checked out, or from a PR URL showing up in its stream.
    prStatus: null,
    // Whether that pull request was found from the branch rather than handed to
    // this session or quoted by its agent. An implicit attachment is not
    // allowed to end the session when the pull request merges (closePrSessions).
    prAttachedByBranch: false,
    // ▶ Run: the php -S process serving this workspace, and its port.
    appPort: null,
    serveProc: null,
    workDir: null,
    dbServerId: null,
    dbHost: null,
    dbPort: null,
    events: [],
    seq: 0, // nothing stored yet, so this session's log starts at 1
  };
  registerJob(job);
  // The user bubble shows what was typed plus the attachment chips; the
  // paths-on-disk note is agent context, not conversation.
  pushEvent(job, 'user', { text: review ? firstMessage : text, ...attachmentMeta(files) });
  bus.emit('job', publicJob(job));
  save(job);
  // A session started from a pull request (a board errand, a ⌕ Code review)
  // already knows which one it is, so it is attached here rather
  // than waiting for the agent to quote the URL back. The panel then shows the
  // PR, its checks and its issues from the first second of the run.
  if (prNumber) syncDevPr(job, prNumber).catch(() => {});
  startDevSession(job, firstMessage);
  return publicJob(job);
}

// After a review turn, a second turn runs the project's own publish steps:
// exactly the text from Settings, nothing added. A project that leaves the
// setting empty gets no second turn at all: whatever the provider's built-in
// review command already did to the PR is the whole review.
function reviewPublishPrompt(job) {
  const project = getProject(job.repo);
  return project ? project.reviewPublishInstructions.trim() : '';
}

// The PR a session's own turns work on: the one whoever started it handed it,
// or the one the session spotted in its own stream. Null is fine; the
// prompts fall back to "the PR for this branch".
function sessionPrNumber(job) {
  return job.startedOnPr || (job.prStatus && job.prStatus.number) || null;
}

// The anchor on the app's "review started" notice. A project that reviews every
// push would otherwise stack an identical notice per push on the pull request;
// with it, the newest review edits the one already there.
const REVIEW_STARTED_ANCHOR = '<!-- reviewer:review-started -->';

// Say on the pull request that a review of it has started, before the clone and
// the setup steps eat the next few minutes: whoever pushed can see that the
// push was picked up, rather than waiting on a review nothing has said is
// running.
//
// Best effort in every direction. No token, no pull request, a missing scope,
// GitHub down: each just leaves a line in the session's log. A review must
// never fail because its announcement did.
async function announceReviewStart(job) {
  const prNumber = sessionPrNumber(job);
  if (!prNumber) return;
  const cfg = getConfig();
  if (!cfg.githubToken) return;
  const body = [
    REVIEW_STARTED_ANCHOR,
    '### 🔍 Code review started',
    '',
    `${job.provider}${job.model ? ` (${job.model})` : ''} is reviewing \`${job.reviewBranch}\`. The findings land on this pull request when it is done.`,
    '',
    `_Started ${new Date().toISOString()} by the reviewer dashboard, session ${job.id}._`,
  ].join('\n');
  try {
    await upsertPrComment(cfg, job.repo, prNumber, REVIEW_STARTED_ANCHOR, body);
    pushEvent(job, 'info', { text: `Said on #${prNumber} that this review has started.` });
  } catch (e) {
    pushEvent(job, 'info', {
      text: `Could not say on #${prNumber} that this review has started: ${e.message}`,
    });
  }
  save(job);
}

// The test run turn: the session already holds a prepared workspace and a
// database of its own, so it executes the sheet it just posted with Playwright
// and records a video per scenario.
async function runTestRunTurn(job) {
  const project = getProject(job.repo);
  const prompt = testRunPrompt({
    repo: job.repo,
    prNumber: sessionPrNumber(job), // the sheet turn may have surfaced the PR
    branch: job.qaBranch,
    portHint: instanceAppPort(job),
    project,
  });
  pushEvent(job, 'user', { text: prompt });
  await runDevTurn(job, prompt, { step: 'testRun' });
}

// Everything a review session does after its review turn: the project's own
// publish steps. QA is deliberately not here: the test sheet and its run
// belong to the pull request being approved, not to the code being reviewed,
// so the 🎬 QA errand starts a session of its own for them.
async function runReviewSequence(job) {
  const live = () => !job.turnCanceled && job.status !== 'closed';
  const publish = reviewPublishPrompt(job);
  if (publish && live()) {
    pushEvent(job, 'user', { text: publish });
    // No step runtime: publishing is the review turn's own follow-through, so
    // it stays in the review's conversation, on the review's provider.
    await runDevTurn(job, publish);
  }
}

// What a QA session does after its opening test sheet turn: execute that sheet,
// as far as the project asks for it. Nothing follows the run: reading the ❌
// scenarios and fixing them is somebody's decision, taken from the board.
async function runQaSequence(job) {
  const live = () => !job.turnCanceled && job.status !== 'closed';
  const project = getProject(job.repo);
  if (!project) return;
  // A loop-started QA run exists to execute the sheet; a QA errand started by
  // hand does so only when the project asks for it.
  if (!job.qaParentId && !project.reviewTestRun) return;
  if (live()) await runTestRunTurn(job);
}

// First turn: claim resources, prepare the workspace, run the provider once.
// Failures release everything: a session that never got a workspace has
// nothing worth holding on to.
function startDevSession(job, prompt) {
  (async () => {
    try {
      // An orchestrator gets a scratch dir of its own, never a clone slot: it
      // is not in busyClones or workDirHolders, so nothing needs releasing.
      job.workDir = job.orchestrator
        ? orchestratorDir(job)
        : job.local
          ? await acquireLocalDir(job)
          : acquireCloneDir(job.repo, wantedBranch(job));
      if (!job.orchestrator) workDirHolders.add(job);
      setStatus(job, 'preparing', { startedAt: now() });
      // The clone slot is claimed, so the review is really going ahead: say so
      // on the pull request now rather than after the workspace is prepared,
      // which is the part that takes minutes.
      if (job.reviewBranch) await announceReviewStart(job);
      // A local session runs against the checkout's own database; the pool
      // exists to keep parallel clones apart, and there is only one local tree.
      // An orchestrator has no app to run, so it claims no server either.
      if (!job.local && !job.orchestrator) {
        const onDb = (text) => {
          pushEvent(job, 'info', { text });
          save(job);
        };
        await acquireInstance(job, job.repo, onDb);
        await ensureSessionDatabase(job, job.repo, onDb);
      }
      await prepareDevWorkspace(job);
      if (job.status === 'closed') throw new Error('closed');
      setStatus(job, 'running');
      await runDevTurn(job, prompt, { review: !!job.reviewBranch });
      // A review session goes on to publish what it reviewed, and a QA session
      // to execute the sheet it just wrote, as far as the project asks for
      // either. Skipped when the first turn was canceled: a half-review
      // must not reach the PR, and a half-written sheet must not be executed.
      if (!job.turnCanceled && job.status !== 'closed') {
        if (job.reviewBranch) await runReviewSequence(job);
        else if (job.qaBranch) await runQaSequence(job);
      }
      // Closed while the turn was in flight: the Stop button, or a review a
      // newer push superseded. The workspace and the database server have
      // already been handed back, so there is nothing left to drain and the
      // session must not be walked back to idle.
      if (job.status === 'closed') return;
      // Anything the user typed while the first turn ran goes now.
      await drainDevQueue(job);
      setStatus(job, 'idle');
      // A loop review that got this far did its work, so the close below is the
      // normal end of its errand, and must hand the findings back rather than
      // read as an abort. A review that stopped on a question is not done yet;
      // it stays open like any asking session, and the parent is told where
      // the answer is owed.
      if (job.loopParentId) {
        if (job.awaitingAnswer) notifyLoopReviewAsking(job);
        else job.loopReviewDone = true;
      }
      if (job.qaParentId) {
        if (job.awaitingAnswer) notifyQaLoopAsking(job);
        else job.qaLoopDone = true;
      }
      if (job.loopFixParentId) {
        if (job.awaitingAnswer) notifyLoopFixAsking(job);
        else job.loopFixDone = true;
      }
      notifyParentSettled(job);
      // …and if this session is itself an orchestrator, its settle is what
      // frees it to take the worker updates that arrived mid-turn.
      deliverWorkerNotices(job);
      // An unattended review holds a clone and a database server for nothing
      // once it has published; three of them would fill the pool and block
      // every session started by hand. The conversation stays readable.
      // A turn that ended on a question is not finished: closing it would
      // throw away the one thread somebody still has to answer.
      if (job.autoClose && job.status === 'idle' && !job.awaitingAnswer) await closeDevSession(job.id);
      maybeStartLoopReview(job, { fresh: true }).catch(() => {});
    } catch (e) {
      if (job.status !== 'closed') {
        setStatus(job, 'failed', { error: e.message, endedAt: now() });
      }
      killDevServe(job);
      await releaseInstance(job);
      releaseWorkDir(job);
      // A loop review that died must not leave its parent waiting on a report
      // that is never coming. Only a real failure though: a review closed
      // mid-flight lands here too, and its close already reported the abort.
      if (job.loopParentId && job.status === 'failed') notifyLoopReviewFailed(job);
      if (job.qaParentId && job.status === 'failed') notifyQaLoopFailed(job);
      if (job.loopFixParentId && job.status === 'failed') notifyLoopFixFailed(job);
      if (job.status === 'failed') {
        queueWorkerNotice(job, 'failed', {
          text: `Worker ${job.id} (${job.title || 'untitled'}) failed: ${job.error || 'no error recorded'}. Decide: retry it with send_to_worker, spawn a replacement, or report it to the user.`,
        });
      }
    }
  })().catch((e) => console.error('dev session error:', e.message));
}

// Whether the provider has a conversation this session can resume. Jobs from
// before the chatStarted field fall back to "had any turn".
function hasProviderChat(job) {
  return job.chatStarted !== undefined ? !!job.chatStarted : job.turns > 0;
}

// The conversation one provider holds for this session: its resume id, and
// whether there is anything to resume yet. The session's own provider inherits
// the id chosen when the session was created (which is also all a record
// stored before this map existed carries), and every other provider starts a
// thread of its own the first time a step sends it a turn.
function providerChat(job, providerId) {
  if (!job.chats) job.chats = {};
  const key = String(providerId);
  if (!job.chats[key]) {
    job.chats[key] =
      String(job.providerId) === key
        ? { sessionId: job.providerSessionId, started: hasProviderChat(job) }
        : { sessionId: crypto.randomUUID(), started: false };
  }
  return job.chats[key];
}

// What one turn runs on. Turns run on the session's own provider, model and
// effort, except a step the project gave a runtime of its own, which spawns
// that provider's CLI against the same workspace instead. A step whose provider
// row has since been deleted falls back to the session's rather than failing
// the step, and says so in the log.
function turnRuntime(job, step) {
  const configured = step ? stepRuntime(getProject(job.repo), step) : null;
  const resolved = configured ? resolveRuntime(configured, getConfig()) : null;
  if (resolved) return resolved;
  if (configured) {
    pushEvent(job, 'info', {
      text: `The provider this step was set to run on no longer exists, so running it on ${job.provider} instead.`,
    });
  }
  const provider = getProviderForJob(job);
  if (!provider)
    throw new Error('The provider this session ran on was removed in Settings; add it back to continue');
  return { provider, model: job.model, effort: job.effort };
}

// Whether one more session may hold a database server right now. Checked
// before reopening rather than inside the async body, so the caller hears
// "close one first" instead of the session quietly failing a moment later.
// A session whose project claims no server is never in the way, so it reopens
// no matter how many others are open.
function assertSessionSlot(job) {
  if (job.orchestrator || !projectClaimsServer(job.repo)) return;
  const open = pooledDevSessions().filter((j) => j.id !== job.id);
  if (open.length >= sessionCapacity()) {
    throw new Error(
      `Already ${open.length} open session(s) holding a database server; close one before reopening this one`,
    );
  }
}

// Claim a workspace and a database server again for a session that let go of
// them: closed by hand, interrupted by a restart, or failed. The same clone
// slot is preferred: claude, grok and opencode scope their session files to the
// working directory, so resuming from a different path would not find the
// conversation.
async function reopenWorkspace(job) {
  // A close set this to stop the turn it killed; the session is running again.
  job.turnCanceled = false;
  if (job.orchestrator) {
    // Nothing to claim: the scratch dir is derived from the id, so reopening
    // lands in the same place and the CLI finds its conversation there.
    job.workDir = orchestratorDir(job);
    setStatus(job, 'preparing', { error: null, endedAt: null });
    await prepareOrchestratorWorkspace(job);
    if (job.status === 'closed') throw new Error('closed');
    return;
  }
  if (job.local) {
    // A local session only ever has the one directory, so reclaim it, waiting
    // in line if another session holds the checkout. Cleared first so an
    // abandoned claim cannot make the caller's catch release the holder's.
    job.workDir = null;
    job.workDir = await acquireLocalDir(job);
  } else if (job.workDir && !busyClones.has(job.workDir)) {
    busyClones.add(job.workDir);
  } else {
    const previous = job.workDir;
    job.workDir = acquireCloneDir(job.repo, wantedBranch(job));
    if (previous && previous !== job.workDir) {
      pushEvent(job, 'info', {
        text: 'Previous workspace slot is busy, so using another clone. Resuming may start a fresh provider session.',
      });
    }
  }
  workDirHolders.add(job);
  setStatus(job, 'preparing', { error: null, endedAt: null });
  if (!job.local) {
    const onDb = (t) => {
      pushEvent(job, 'info', { text: t });
      save(job);
    };
    await acquireInstance(job, job.repo, onDb);
    await ensureSessionDatabase(job, job.repo, onDb);
  }
  await prepareDevWorkspace(job);
  if (job.status === 'closed') throw new Error('closed');
}

// Reopen a session without saying anything to the agent: the workspace and the
// database server come back, and the conversation is live again: ▶ Run works,
// and the next message resumes the provider's own session
// instead of waiting out the preparation first. A closed session is reopenable
// exactly like an interrupted one; nothing about closing it was final.
export function reopenDevSession(id) {
  const job = jobs.get(id);
  if (!job || job.kind !== 'devchat') throw new Error('Session not found');
  if (DEV_OPEN.includes(job.status)) return publicJob(job);
  assertSessionSlot(job);
  (async () => {
    try {
      await reopenWorkspace(job);
      setStatus(job, 'idle');
      syncDevPr(job).catch(() => {});
      // Anything queued against the session while it was down goes now.
      await drainDevQueue(job);
      if (job.status === 'running') setStatus(job, 'idle');
      // retry_review can reopen an interrupted worker without spending a
      // throwaway chat turn. The retry's gates were reset before this prep;
      // now that the workspace is live, offer the round exactly as a push
      // would. A queued user message still owns the turn, so leave the retry
      // armed for that turn's normal idle-settle path instead. The start
      // itself consumes it only after it has created a reviewer: otherwise a
      // full pool would make an interrupted round look recovered when none
      // ever ran.
      if (job.status === 'idle' && job.reviewLoop?.retryPending) {
        await maybeStartLoopReview(job, { fresh: true });
      }
      // A reopened orchestrator picks the buffered worker updates back up: a
      // restart interrupted it, but the buffer rode along on the record.
      deliverWorkerNotices(job);
    } catch (e) {
      if (job.status !== 'closed') {
        setStatus(job, 'failed', { error: e.message, endedAt: now() });
      }
      killDevServe(job);
      await releaseInstance(job);
      releaseWorkDir(job);
    }
  })().catch((e) => console.error('dev reopen error:', e.message));
  return publicJob(job);
}

// A follow-up message. Mid-turn it joins the queue; on an idle session it runs
// another provider turn straight away; on a closed/interrupted/failed one it
// re-claims resources first (the provider's own session state survives on disk,
// so the conversation resumes).
export function sendDevMessage(id, text, attachments, zeusRoles) {
  const job = jobs.get(id);
  if (!job || job.kind !== 'devchat') throw new Error('Session not found');
  // A word from the user is what re-arms the unattended-turn breaker: only
  // deliverWorkerNotices' own sends (marked in injectedSends) do not count as
  // the user paying attention.
  if (job.orchestrator && !injectedSends.has(job.id)) {
    job.unattendedTurns = 0;
    job.unattendedSaid = false;
  }
  const files = resolveAttachments(attachments);
  const shown = typeof text === 'string' ? text.trim() : '';
  if (!shown && !files.length) throw new Error('Empty message');
  let prompt = (shown + attachmentNote(files)).trim();
  if (zeusRoles != null) {
    if (!job.zeus) throw new Error('Only a Zeus session carries runtimes for analyst roles');
    const roles = normalizeZeusRoles(zeusRoles, getConfig());
    if (!roles || ZEUS_PROPOSAL_ROLES.some((role) => !roles[role])) {
      throw new Error('Choose a model for both proposal slots');
    }
    job.zeusRoles = roles;
    save(job);
    // Resumed providers may retain their first-turn briefing. Carry this
    // update with the message itself so queued turns receive it as well.
    prompt += `\n\n<workspace-context>\nThe user has now chosen both proposal models. \
These choices supersede any earlier missing or partial picks. ${zeusRolesAdvice(job)}
Use role product for Model 1 and architecture for Model 2. \
The proposal slots are complete independent proposals, not specialties; send the same complete proposal prompt to both.
ZEUS itself consolidates both complete outputs; do not split the task into phases or spawn a separate validator.

${zeusRolesBriefing(job)}\n</workspace-context>`;
  }

  // Reset only when the new user brief is delivered, never while the old
  // round is still spawning models or when worker notifications arrive.
  const newFusionBrief = job.zeus && !injectedSends.has(job.id);

  // A turn is still in flight. The message waits its turn instead of being
  // refused, and the user bubble is pushed when it is actually sent, so the
  // transcript stays a record of what the agent was told and when.
  if (ACTIVE.includes(job.status)) {
    queueDevMessage(job, { prompt, shown, files, newFusionBrief });
    return publicJob(job);
  }

  if (job.status !== 'idle') assertSessionSlot(job);
  if (newFusionBrief) {
    job.zeusProposalPrompt = null;
    save(job);
  }
  pushEvent(job, 'user', { text: shown, ...attachmentMeta(files) });

  const live = job.status === 'idle'; // already holds its workspace
  (async () => {
    // Which failure this is decides what happens to the workspace: a turn that
    // failed on a prepared checkout leaves it prepared, and the session stays
    // open for a retry. A reopen that never got that far has nothing worth
    // holding, so the clone slot and the database server go back.
    let prepared = live;
    try {
      if (live) setStatus(job, 'running', { error: null });
      else {
        await reopenWorkspace(job);
        prepared = true;
        setStatus(job, 'running');
      }
      await runDevTurn(job, prompt);
      await drainDevQueue(job);
      // Closed while the turn was in flight (the Stop button, or an
      // orchestrator's close_worker): the resources are already handed back,
      // so the session must not be walked back to idle over a workspace it no
      // longer holds. Same guard the first turn has.
      if (job.status === 'closed') return;
      // The injected turn (if this was one) delivered its batch; the stash
      // has done its job and must not resurface these updates later.
      if (job.orchestrator) job.inFlightWorkerNotices = [];
      setStatus(job, 'idle');
      notifyParentSettled(job);
      deliverWorkerNotices(job);
      // A loop review that had stopped on a question and just got its answer
      // finished the work this turn, so a close now carries its findings. And
      // nothing else ever closes an auto-closing session past its first turn,
      // so without the close here the review would sit idle forever: holding
      // its clone, its database server and, because the parent waits on an
      // open review, the loop itself.
      if (job.loopParentId && !job.awaitingAnswer) {
        job.loopReviewDone = true;
        if (job.autoClose && job.status === 'idle') await closeDevSession(job.id);
      }
      // The same close-on-answer rule for a QA session the QA loop is waiting on.
      if (job.qaParentId && !job.awaitingAnswer) {
        job.qaLoopDone = true;
        if (job.autoClose && job.status === 'idle') await closeDevSession(job.id);
      }
      // And for a fix session the review loop is waiting on.
      if (job.loopFixParentId && !job.awaitingAnswer) {
        job.loopFixDone = true;
        if (job.autoClose && job.status === 'idle') await closeDevSession(job.id);
      }
      // And for a review nobody's loop is waiting on: one somebody started by
      // hand from the board or the composer. It stopped to ask, this turn was
      // the answer, and the review it was asking about is published by now: the
      // reason it stayed open past its first turn is gone, so it ends the way
      // every other review does rather than holding its clone forever.
      if (job.reviewBranch && job.autoClose && !job.loopParentId && !job.awaitingAnswer) {
        if (job.status === 'idle') await closeDevSession(job.id);
      }
      maybeStartLoopReview(job, { fresh: true }).catch(() => {});
    } catch (e) {
      if (prepared && job.status !== 'closed') {
        pushEvent(job, 'stderr', { text: e.message });
        setStatus(job, 'idle', { error: e.message });
        // An orchestrator's failed turn may have been carrying worker
        // updates; they surface as lines rather than retrying the model that
        // just refused.
        dumpWorkerNotices(job, `This session's turn failed (${e.message})`);
        queueWorkerNotice(job, 'error', {
          text: `Worker ${job.id} (${job.title || 'untitled'}) hit an error: ${e.message}. It is still open; decide whether to retry with send_to_worker or report it.`,
        });
        return;
      }
      // Closed mid-flight lands here too: the status is already right, but a
      // claim this run made after the close has to go back (both calls are
      // no-ops when the close already released them).
      if (job.status !== 'closed') {
        setStatus(job, 'failed', { error: e.message, endedAt: now() });
        // A failed orchestrator holds its updates in the buffer: the reopen
        // is what flushes them, and the stash goes back in front so nothing
        // the dead turn was carrying is lost.
        if (job.orchestrator && job.inFlightWorkerNotices?.length) {
          job.pendingWorkerNotices = [...job.inFlightWorkerNotices, ...(job.pendingWorkerNotices || [])];
          job.inFlightWorkerNotices = [];
          save(job);
        }
        queueWorkerNotice(job, 'failed', {
          text: `Worker ${job.id} (${job.title || 'untitled'}) failed: ${e.message}. Decide: retry it with send_to_worker, spawn a replacement, or report it to the user.`,
        });
      }
      killDevServe(job);
      await releaseInstance(job);
      releaseWorkDir(job);
    }
  })().catch((e) => console.error('dev turn error:', e.message));
  return publicJob(job);
}

// ---------- run the session's app (▶ in the UI) ----------

// What the project says ▶ Run does: its shell commands with {port} and {dir}
// filled in, chained so they run in order in the checkout and the last one is
// the server that stays up. They go through a shell for the same reason the
// setup steps do: they chain commands and rely on what is on PATH.
//
// The Laravel default every project here uses is deliberately NOT
// `php artisan serve`: on this machine it spawns a child PHP that drops the
// shell environment, so the session's DB_* overrides would never reach the
// app. Laravel's server.php router under `php -S` keeps the process, and its
// env, intact.
function devServeRecipe(job) {
  const project = getProject(job.repo);
  const commands = project ? project.runCommands : [];
  if (!commands.length) {
    return { notReady: `No run command is configured for ${job.repo}; add one in Settings` };
  }
  const vars = { port: job.appPort, dir: job.workDir };
  return {
    command: commands.map((c) => render(c, vars)).join(' && '),
    cwd: job.workDir,
    notReady: null,
  };
}

// The pool port is only a preference: an orphaned serve surviving a reviewer
// restart, a second unpooled project on 8100, or an unrelated process can
// already hold it, and both run recipes pass {port} explicitly, so nothing
// downstream would step aside on its own. Prove the port is bindable with a
// real listen/close, walking forward a few ports so the URL, the {port}
// substitution and the event text all agree on whichever one actually works.
function portFree(port) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)));
  });
}

async function freeAppPort(job) {
  const preferred = instanceAppPort(job);
  for (let port = preferred; port < preferred + 10; port++) {
    if (await portFree(port)) {
      if (port !== preferred) {
        pushEvent(job, 'info', { text: `Port ${preferred} is already in use, serving on ${port} instead` });
      }
      return port;
    }
  }
  throw new Error(
    `Ports ${preferred}-${preferred + 9} are all in use. Stop whatever is holding them (an orphaned app server from an earlier run?) and press ▶ again`,
  );
}

export async function startDevServe(id) {
  const job = jobs.get(id);
  if (!job || job.kind !== 'devchat') throw new Error('Session not found');
  if (job.orchestrator) throw new Error('An orchestrator session has no checkout to serve');
  if (!DEV_OPEN.includes(job.status) || !job.workDir) {
    throw new Error('The session has no live workspace; send a message to reopen it first');
  }
  // A live server may sit on a shifted port, so reuse the port it bound rather
  // than recomputing the preferred one.
  if (job.serveProc && job.serveProc.exitCode === null) {
    return { url: `http://127.0.0.1:${job.appPort}` };
  }
  // Two ▶ presses land before the first has spawned anything (the port probe
  // is async), and a second spawn would overwrite serveProc, leaving a
  // detached server tree nothing can ever kill, squatting on a pool port.
  // Hand every concurrent caller the same in-flight start instead.
  if (job.serveStarting) return job.serveStarting;
  job.serveStarting = startDevServeProc(job).finally(() => {
    job.serveStarting = null;
  });
  return job.serveStarting;
}

async function startDevServeProc(job) {
  job.appPort = await freeAppPort(job);
  const url = `http://127.0.0.1:${job.appPort}`;

  const recipe = devServeRecipe(job);
  if (recipe.notReady) throw new Error(recipe.notReady);
  const env = jobEnv(instanceEnv(job), job);
  const proc = spawn(recipe.command, {
    cwd: recipe.cwd,
    env,
    shell: true,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  job.serveProc = proc;
  let stderrTail = '';
  proc.stderr.on('data', (d) => {
    stderrTail = (stderrTail + d).slice(-500);
  });
  proc.on('exit', (code) => {
    // killDevServe detaches serveProc before the tree dies, so a proc we no
    // longer track exited because we killed it, not something to report.
    const killed = job.serveProc !== proc;
    if (!killed) job.serveProc = null;
    // php -S logs every request to stderr, so stderr alone is not an error,
    // but any non-zero exit is, no matter how long the run chain's build steps
    // delayed the bind ("Address already in use" after a yarn build used to
    // die past the old 5-second window without a trace).
    if (code && !killed) {
      pushEvent(job, 'stderr', { text: `App server died (exit ${code}): ${stderrTail.trim()}` });
    }
  });
  pushEvent(job, 'info', {
    text: `Serving the workspace at ${url} (${recipe.command}, session database ${job.dbHost ? `${job.dbHost}:${job.dbPort}` : 'n/a'})`,
  });
  save(job);
  // Give the server a beat to bind the port (or fail) before the tab opens.
  return new Promise((resolve, reject) => {
    setTimeout(() => {
      if (proc.exitCode !== null)
        reject(
          new Error(`The run commands exited immediately: ${stderrTail.trim() || `exit ${proc.exitCode}`}`),
        );
      else resolve({ url });
    }, 600);
  });
}

// The whole tree: the direct child is the shell the run commands went through,
// and killing only that would leave the server holding the app port.
function killDevServe(job) {
  killTree(job.serveProc);
  job.serveProc = null;
}

// Kill the in-flight turn but keep the session open.
export function cancelDevTurn(id) {
  const job = jobs.get(id);
  if (!job || job.kind !== 'devchat') return null;
  if (job.status !== 'running') return publicJob(job);
  job.turnCanceled = true;
  killJobProcess(job);
  return publicJob(job);
}

// The durable half of this fold already happened: dbDeleteJob paid the child's
// spend into the parent's row inside the delete's own transaction, because the
// parent may not even be in memory (the restore window is bounded). This
// mirrors the same addition onto the loaded record when there is one, so the
// panel's number moves now rather than at the next restart. It lands in the
// absorbed* fields, apart from the parent's own figures: codex rewrites those
// from its thread's own accounting after every turn (probeContextUsage), and
// a fold added into them would be gone by the next reply.
function absorbDeletedSessionUsage({ intoJobId, sessions, costUsd, inputTokens, outputTokens, durationMs }) {
  const parent = jobs.get(intoJobId);
  if (!parent) return;
  parent.absorbedSessions = (parent.absorbedSessions || 0) + sessions;
  if (costUsd != null) parent.absorbedCostUsd = (parent.absorbedCostUsd || 0) + costUsd;
  if (inputTokens != null) parent.absorbedInputTokens = (parent.absorbedInputTokens || 0) + inputTokens;
  if (outputTokens != null) parent.absorbedOutputTokens = (parent.absorbedOutputTokens || 0) + outputTokens;
  if (durationMs != null) parent.absorbedDurationMs = (parent.absorbedDurationMs || 0) + durationMs;
  save(parent);
  emitUsage(parent);
}

// Close the session: kill anything running, hand back the database server and
// the clone slot. The conversation history stays readable, unless nobody was
// meant to read it, see below.
export async function closeDevSession(id) {
  const job = jobs.get(id);
  if (!job || job.kind !== 'devchat') return null;
  if (job.status === 'closed') return publicJob(job);
  job.turnCanceled = true;
  // Messages still waiting were meant for a live session, so closing it drops
  // them rather than firing them at the next reopen. An orchestrator's
  // buffered worker updates go with them: the user closing the supervisor is
  // the user saying stop, and a reopen must not open on an unprompted turn.
  devQueues.delete(job.id);
  if (job.orchestrator) {
    job.pendingWorkerNotices = [];
    job.inFlightWorkerNotices = [];
  }
  // A round whose review finished but whose findings were never read back off
  // the pull request goes with the close: nobody is owed it once the session is
  // over, and a reopen days later must not drain that stale round into a fix
  // session for a review that ran before the close. What it published stays on
  // the pull request, like every other round's findings.
  if (job.reviewLoop && job.reviewLoop.pendingResult) {
    job.reviewLoop.pendingResult = null;
    pushEvent(job, 'info', {
      text: 'Review loop: the finished round still waiting for its findings to be read off the pull request is dropped with this close. What it published is on the pull request.',
    });
  }
  killJobProcess(job);
  killDevServe(job);
  await releaseInstance(job);
  // The session's own database goes back with the rest of what it held. A
  // reopen makes it again and the project's setup commands fill it, so the only
  // thing keeping it would be the disk (or, on a pool server, the RAM) it sits
  // in and the table definitions it costs every instance on that server.
  await dropSessionDatabase(job, (t) => pushEvent(job, 'info', { text: t }));
  releaseWorkDir(job);
  // A Zeus session's read-only clone is disk held for nothing once it closes:
  // the scratch dir itself stays (the CLI's conversation lives there), the
  // clone is made again at the current tip on reopen.
  if (job.zeus && job.workDir) fs.rmSync(zeusCloneDir(job), { recursive: true, force: true });
  setStatus(job, 'closed', { endedAt: now() });
  // A loop review reports back to the session it reviewed for the moment it
  // closes: with its findings when it finished, as an abort when it was
  // stopped mid-way. Fire and forget: reading the findings takes a GitHub
  // round-trip and may start a whole fix session, none of which the close waits on.
  if (job.loopParentId) onLoopReviewClosed(job).catch(() => {});
  if (job.qaParentId) onQaLoopClosed(job).catch(() => {});
  if (job.loopFixParentId) onLoopFixClosed(job).catch(() => {});
  if (job.parentId) notifyParent(job, `Worker ${job.id} (${job.title || 'untitled'}) closed.`);
  const closed = publicJob(job);
  // A session nobody is sitting in front of said everything it had to say on
  // the pull request; the transcript is a by-product, and one row per push
  // would bury the sessions people actually started by hand. So an unattended
  // session's record goes back with its resources rather than piling up.
  // Deleting it must never make closing it fail: the resources are already
  // handed back by here, and a row left behind is only clutter.
  if (job.autoClose) {
    try {
      // A loop review or QA run spent its tokens on the parent task's behalf,
      // and this delete takes the only session-level copy of that spend with
      // it, so deleteJobById folds it into the parent's absorbed total, so the
      // task's number keeps saying what the whole loop cost rather than only
      // the fix sessions.
      await deleteJobById(job.id);
    } catch (e) {
      console.error(`could not delete auto-closed session ${job.id}:`, e.message);
    }
  }
  return closed;
}

// One session this app decides to stop rather than waiting for its own work to
// end: a review a newer push has just made obsolete, say. The reason goes into
// the conversation first, so the transcript says why it stops mid-turn instead
// of just ending. Returns whether there was an open session to close.
export async function closeDevSessionWithReason(id, why) {
  const job = jobs.get(id);
  if (!job || job.kind !== 'devchat' || !DEV_OPEN.includes(job.status)) return false;
  pushEvent(job, 'info', { text: `${why}. Closing this session.` });
  try {
    await closeDevSession(job.id);
  } catch (e) {
    pushEvent(job, 'info', { text: `Could not close this session: ${e.message}` });
    return false;
  }
  return true;
}

// Every open session working on one pull request, closed. A merged pull
// request has no errand left on it: a review would report on code that is
// already in the base branch, a fix or QA turn would push to a branch nobody
// merges again, and each of them holds a clone and a pooled database server
// while it does. Closing hands the resources back and leaves the conversation
// readable, except on the auto-closing errands, a review among them, whose
// record goes with the resources because what they had to say is on the pull
// request.
//
// Except a session that was never pointed at this pull request: attachPrForBranch
// found it from the branch, and being stopped mid-work (by a teammate's merge,
// on a session somebody opened to keep iterating) is not something an implicit
// attachment gets to decide. Those are told and left alone, to close when their
// user is done with them.
async function closePrSessions(repo, number, why) {
  const key = String(repo || '').toLowerCase();
  const onPr = openDevSessions().filter((j) => j.repo.toLowerCase() === key && sessionPrNumber(j) === number);
  const targets = [];
  for (const job of onPr) {
    if (job.prAttachedByBranch) {
      pushEvent(job, 'info', {
        text: `${why}. This session stays open: its pull request was found from its branch, not handed to it. Close it when you are done with its workspace.`,
      });
      save(job);
      continue;
    }
    targets.push(job);
  }
  for (const job of targets) await closeDevSessionWithReason(job.id, why);
  return targets.length;
}

// ---------------------------------------------------------------------------
// The review loop
//
// A session armed with 🔁 (the composer's chip, or 🛠 Implement feedback,
// which starts with the loop already on) gets reviewed every time it
// settles with new commits on its open pull request: a review session (the
// same auto-closing kind the board starts) is started for it, and the
// findings that review publishes are handed to a fix session (the same
// auto-closing implement-feedback errand the board starts), whose pushes,
// once it closes, trigger the next review. The session itself is the durable
// half: it is the loop's anchor, it keeps its clone, its database and its
// conversation, and its user chats in it undisturbed while the reviews and
// the fix sessions come and go around it.
//
// The loop runs until it converges, and three gates decide when that is. It
// stops on its own when a review declares no findings. It stops on the stall
// gate when a round hands back exactly the findings the round before it did:
// the fix session between them did not move the review, and repeating it would
// ping-pong forever. And it stops at REVIEW_LOOP_MAX_ROUNDS, which is the gate
// for the failure the other two miss: a loop reviewing the scaffolding its own
// fixes introduced finds something genuine and something different every
// round, so it neither runs dry nor repeats itself, and would go on until
// somebody noticed. Alongside the cap, the severity floor tightens as rounds
// go by (see onLoopReviewClosed) so a late low is recorded rather than
// implemented. Nothing a stopped loop found is lost: every round's findings
// are on the pull request and in the findings panel either way, and the 🔁
// chip restarts it. Between rounds the commit gate (lastSha) keeps a
// session with nothing new pushed from being reviewed again, so chatting
// never re-triggers a review, and a failed or aborted review pauses the loop
// until the next push instead of retrying itself in a circle. Nothing on
// GitHub starts any of it: the one trigger is this session's own turn ending,
// on a loop its user armed: at the composer, from 🛠 Implement feedback
// (which starts with it on), or with the same chip on the session once it
// was underway (setReviewLoop). The sync tick only re-asks the
// same question for a session still looking for its pull request, and every
// gate below is the same either way.
// ---------------------------------------------------------------------------

// The state an armed loop starts from, whether the composer armed it at
// creation or the 🔁 chip did halfway through the session.
function newReviewLoop() {
  return {
    rounds: 0,
    done: false,
    stalled: false,
    reviewing: false,
    reviewSessionId: null,
    // The fix session a round handed its findings to (see startLoopFixSession),
    // holding the loop the same way `reviewing` does while a review is out.
    fixing: false,
    fixSessionId: null,
    lastSha: null,
    lastFindings: null,
    // Only ever set by records written before fixes ran in sessions of their
    // own: a fix prompt held back because the parent was standing on a
    // question. maybeStartLoopReview drains it into a fix session.
    pendingFix: null,
    // A round waiting for its orchestrator's verdicts (see holdForTriage):
    // the pull request, the round, and the findings with the automatic
    // split's advice on each. Holds the loop the way `reviewing` and
    // `fixing` do; triageLoopFindings releases it.
    triage: null,
    // A round whose review has finished but whose result has not been read off
    // the pull request yet: the review's own outcome, recorded before the
    // GitHub call that reads it (see onLoopReviewClosed). Holds the loop the
    // way the fields above do, so a rate limit or a 5xx while reading the
    // findings leaves the round pending and retried rather than discarded,
    // which is how a converged round used to read as "waiting for a push".
    // Carries what the retries are paced by (attempts, nextRetryAt,
    // failingSince). resolveLoopRound clears it, as does closing the session.
    pendingResult: null,
    // The runtime the loop's own sessions run on when it is not the parent's:
    // the override an orchestrator retried a failed round with
    // (retryLoopRound), kept so every later round stays off the provider that
    // failed this one. Null means "whatever the session it belongs to runs on"
    // (loopSessionRuntime).
    runtime: null,
    // retry_review sets this while it reopens an interrupted worker. Once its
    // workspace is ready, reopenDevSession offers the request without
    // spending a chat turn; only a reviewer successfully created for the
    // round consumes it.
    retryPending: false,
    // The last round that ended with no verdict because the machinery under it
    // failed: the provider exited non-zero, an exhausted account, a review
    // that closed having published nothing. Never a round that ran and
    // declared nothing, which is what converges a loop. { round, reason, at },
    // cleared by the retry that re-runs the round and by the next round that
    // starts on its own.
    failure: null,
    // A failed branch lookup is separate from an empty result. It is cleared
    // as soon as a later idle transition finds the PR.
    discoveryError: null,
    discoveryErrorSaid: false,
    discoveryRetries: 0,
  };
}

// The QA loop is one queued run, not a series of rounds. `done` means a QA run
// closed after doing its work; a stopped or failed run leaves it false so the
// next review-loop convergence (or the parent's next settle) can offer it again.
function newQaLoop() {
  return {
    running: false,
    sessionId: null,
    staleSessionId: null,
    done: false,
    failedScenarios: null,
    // The QA run finished, but its test-sheet verdict is still being read.
    // Keep that read separate from `running`: retrying it must never start a
    // second QA run.
    pendingVerdict: null,
    verdictError: null,
    // A run that never reached a verdict is not queued QA. Keep why it
    // stopped until another QA session is successfully created, so worker
    // status cannot turn a provider failure or interruption into apparent
    // work that is still waiting to start. { kind, reason, at }
    failure: null,
  };
}

// A later push reopens the review loop, so an earlier convergence (and the QA
// verdict that came with it) no longer describes the branch. A QA session
// still running that old sha becomes stale: it is allowed to finish, but its
// close is ignored rather than marking the new work QA'd.
function reopenLoopForPush(job) {
  const loop = job.reviewLoop;
  if (!loop) return;
  loop.done = false;
  loop.stalled = false;
  const qaLoop = job.qaLoop;
  if (!qaLoop) return;
  qaLoop.done = false;
  qaLoop.failedScenarios = null;
  qaLoop.pendingVerdict = null;
  qaLoop.verdictError = null;
  qaLoop.failure = null;
  if (qaLoop.running && qaLoop.sessionId) {
    qaLoop.staleSessionId = qaLoop.sessionId;
    qaLoop.sessionId = null;
  }
}

// What a session the loop starts runs on: the session whose work it is.
// A review, a fix session and a QA run of the loop are all continuations of
// that session's task, so they follow the runtime it was given rather than a
// project-wide default: an orchestrator that moved a worker onto another
// provider (because the first one's account was out of quota, say) is deciding
// for that worker's reviews too, and a loop review left on the project's board
// reviewer would keep running on the provider that just failed. The one thing
// above it is `loop.runtime`, the override a retry moved this loop onto
// (retryLoopRound); a step with a runtime of its own (REVIEW_STEPS) still
// moves its own turn inside the session, as it does everywhere else.
function loopSessionRuntime(job) {
  const loop = job.reviewLoop;
  const override = loop && loop.runtime ? resolveRuntime(loop.runtime, getConfig()) : null;
  // An override whose provider row was deleted since falls back to the
  // session's own rather than failing every round from here on.
  if (override) return { provider: override.provider.id, model: override.model, effort: override.effort };
  return { provider: job.providerId, model: job.model, effort: job.effort };
}

// A review this session's loop started that has not closed yet, found from the
// registry rather than from the loop's own pointer, which disarming throws
// away while the review session it names goes on running. Re-arming has to
// know about it (see below), and only the records still say it is there.
function openLoopReviewFor(job) {
  for (const other of jobs.values()) {
    if (other.loopParentId === job.id && DEV_OPEN.includes(other.status)) return other;
  }
  return null;
}

// Arm or disarm the loop on a session that is already running: the 🔁 chip
// over an open session, described in the README.
//
// Arming leaves lastSha unset and offers a round on the spot, so an idle
// session with a pull request is reviewed now rather than at its next push.
// Turning the loop off drops its state, which is how onLoopReviewClosed knows
// not to report back.
export function setReviewLoop(id, on) {
  const job = jobs.get(id);
  if (!job || job.kind !== 'devchat') throw new Error('Session not found');
  // The same sessions the loop refuses at creation, recognised from what the
  // record kept: a review, a QA run, an auto-closing errand or a loop's own
  // review is itself one step of somebody's flow, and a local session cannot
  // start reviews at all (a review needs a workspace clone). 🛠 Implement
  // feedback is not among them; it stays open and starts with the loop on.
  // An orchestrator has no pull request of its own to review either.
  if (
    job.reviewBranch ||
    job.qaBranch ||
    job.autoClose ||
    job.loopParentId ||
    job.local ||
    job.orchestrator
  ) {
    throw new Error('The review loop only applies to a session started from scratch on a task');
  }
  if (!DEV_OPEN.includes(job.status)) {
    throw new Error('The review loop needs an open session; reopen this one first');
  }
  if (!!job.reviewLoop === !!on) return publicJob(job);
  if (on) {
    job.reviewLoop = newReviewLoop();
    // A review from an arm this session had turned off can still be running.
    // The fresh loop adopts it, counted as the round it is, instead of
    // starting a second review of the same pull request: two of them would
    // publish over each other, and the older one's close would find a loop
    // that disowns it and report nothing at all.
    const running = openLoopReviewFor(job);
    if (running) {
      job.reviewLoop.rounds = 1;
      job.reviewLoop.reviewing = true;
      job.reviewLoop.reviewSessionId = running.id;
    }
    pushEvent(job, 'info', {
      text: running
        ? 'Review loop armed. The review already running is its first round and reports back here after all.'
        : "Review loop armed. Everything this session pushes is reviewed, and each round's findings are implemented here, until a review finds nothing.",
    });
    save(job);
    // Nothing here waits for a turn to end: an idle session with a pull
    // request open is exactly the case somebody arms the loop for. fresh so a
    // branch that already has one is attached now rather than waiting out a
    // cooldown the tick set while the loop was off.
    maybeStartLoopReview(job, { fresh: true }).catch(() => {});
    return publicJob(job);
  }
  // Off drops the loop's whole state, an outstanding review included: that
  // review keeps running and closes itself, but onLoopReviewClosed finds no
  // loop to report to, which is what off means. Say so rather than leaving
  // somebody waiting for feedback that is not coming.
  const outstanding = job.reviewLoop.reviewing;
  const fixing = job.reviewLoop.fixing;
  const held = !!job.reviewLoop.pendingFix;
  const triaging = !!job.reviewLoop.triage;
  const qaQueued = !!job.qaLoop;
  job.reviewLoop = null;
  job.qaLoop = null;
  pushEvent(job, 'info', {
    text:
      'Review loop turned off. No further reviews start on their own.' +
      (outstanding
        ? ' The review already running reports nothing back; what it finds stays on the pull request.'
        : '') +
      (fixing ? ' The fix session already running finishes on its own; no review follows it.' : '') +
      (held ? ' The findings it was holding are on the pull request too.' : '') +
      (triaging ? ' The findings awaiting triage stay on the pull request, undecided.' : '') +
      (qaQueued ? ' The QA loop waiting behind it is off as well.' : ''),
  });
  save(job);
  return publicJob(job);
}

// Arm or disarm the QA loop behind a session's armed review loop. It is offered
// only there because its one trigger is the review loop converging cleanly; a
// loop that stalled on repeating findings, or a review that failed, is not an
// approval to test.
export function setQaLoop(id, on) {
  const job = jobs.get(id);
  if (!job || job.kind !== 'devchat') throw new Error('Session not found');
  if (
    job.reviewBranch ||
    job.qaBranch ||
    job.autoClose ||
    job.loopParentId ||
    job.local ||
    job.orchestrator
  ) {
    throw new Error('The QA loop only applies to a session started from scratch on a task');
  }
  if (!DEV_OPEN.includes(job.status)) {
    throw new Error('The QA loop needs an open session; reopen this one first');
  }
  if (on && !job.reviewLoop) {
    throw new Error('The QA loop waits for the review loop; turn the review loop on first');
  }
  if (!!job.qaLoop === !!on) return publicJob(job);
  if (on) {
    job.qaLoop = newQaLoop();
    pushEvent(job, 'info', {
      text: 'QA loop armed. Once the review loop declares no findings, it writes the test sheet, executes it, and stops with the result.',
    });
    // Arming after the review loop already converged gives QA its turn now;
    // arming earlier leaves the queued run for that convergence.
    if (job.reviewLoop.done) maybeStartLoopQa(job).catch(() => {});
  } else {
    const running = job.qaLoop.running;
    job.qaLoop = null;
    pushEvent(job, 'info', {
      text:
        'QA loop turned off. No test sheet or test run starts on its own.' +
        (running ? ' The QA session already running finishes and reports nothing back.' : ''),
    });
  }
  save(job);
  return publicJob(job);
}

// The commit the next review would actually read: what the loop gates rounds
// against. The pushed head, not the workspace's HEAD: the review session this
// starts checks out `refs/remotes/origin/<branch>`, so a turn that commits
// without pushing would otherwise burn a round on the code the previous round
// already saw, and pin the gate to a sha that never reaches the pull request,
// silently skipping the commits the round was about once they do land.
//
// Read from the clone's own remote-tracking ref, which the push in the turn
// that just ended updated, rather than from the mirrored PR head, whose sync
// races this settle. The mirror is only the fallback for a branch this
// workspace has no tracking ref for.
function loopHeadSha(job) {
  const pushed = job.prStatus && job.prStatus.headSha;
  if (!job.workDir || !job.branch) return pushed || null;
  const probe = spawnSync('git', ['-C', job.workDir, 'rev-parse', `refs/remotes/origin/${job.branch}`], {
    encoding: 'utf8',
  });
  return (probe.stdout || '').trim() || pushed || null;
}

// Called every time an armed session settles idle. Decides whether this is a
// moment to review, and starting none is the common case: no pull request
// yet, nothing new pushed, a review already out, or a question waiting for
// the user.
async function maybeStartLoopReview(job, { fresh = false } = {}) {
  const loop = job.reviewLoop;
  if (!loop) return;
  if (loop.pendingResult) {
    // A round whose review is finished and whose findings GitHub would not
    // hand over yet. That round is the loop's next step, not a new review: it
    // is retried here, and the loop moves on (converges or fixes)
    // inside resolveLoopRound the moment the read comes back.
    await resolveLoopRound(job);
    return;
  }
  if (loop.reviewing) {
    // Still waiting on a review, unless the review is gone without ever
    // reporting back (a restart interrupted it, or its record was deleted),
    // in which case waiting forever helps nobody.
    const review = loop.reviewSessionId ? jobs.get(loop.reviewSessionId) : null;
    if (review && DEV_OPEN.includes(review.status)) return;
    loop.reviewing = false;
  }
  if (loop.fixing) {
    // Still waiting on a fix session, with the same escape as `reviewing`: one
    // gone without ever reporting back releases the loop rather than holding
    // it forever.
    const fix = loop.fixSessionId ? jobs.get(loop.fixSessionId) : null;
    if (fix && DEV_OPEN.includes(fix.status)) return;
    loop.fixing = false;
    loop.fixSessionId = null;
  }
  if (loop.triage) {
    // Resume persisted rounds from before fix sessions owned finding decisions.
    const held = loop.triage;
    loop.triage = null;
    pushEvent(job, 'info', {
      text: `Review loop: round ${held.round}'s previously held findings now go directly to the fix session for assessment.`,
    });
    save(job);
    bus.emit('job', publicJob(job));
    await implementRound(job, held.prNumber, held.findings);
    return;
  }
  if (job.status !== 'idle' || job.awaitingAnswer) return;
  if ((devQueues.get(job.id) || []).length) return;
  // A fix prompt a record written before fixes ran in sessions of their own
  // was holding (the parent was standing on a question when its review came
  // back). It goes to a fix session now, before anything else, since it is
  // what that round was for.
  if (loop.pendingFix) {
    const held = loop.pendingFix;
    loop.pendingFix = null;
    save(job);
    startLoopFixSession(job, sessionPrNumber(job), held);
    return;
  }
  // Ask GitHub for the branch's own pull request before concluding there is
  // nothing to review: the session may be working on a branch whose PR was
  // already open when it started, or have opened one without ever writing its
  // URL where the stream watcher could see it. A turn that has just ended is
  // exactly when a pull request appears, so that call asks past the cooldown;
  // the tick's does not.
  const prNumber = sessionPrNumber(job) || (await attachPrForBranch(job, { fresh }));
  // The lookup is a round-trip, and the session may have started its next turn
  // (or stopped on a question) while it was out, and the gates above are worth
  // nothing if they are not still true now. `reviewing` among them: this runs
  // both on a settle and on the sync tick, so two calls can be inside the
  // lookup at once and only one of them may start the round.
  if (loop.reviewing) return;
  if (job.status !== 'idle' || job.awaitingAnswer) return;
  if ((devQueues.get(job.id) || []).length) return;
  if (!prNumber) {
    // A failed lookup is not evidence that the branch has no pull request.
    // The next idle transition calls this path again, so keep a transient
    // GitHub failure distinct from the normal "no PR yet" state.
    if (loop.discoveryError) {
      if (!loop.discoveryErrorSaid) {
        loop.discoveryErrorSaid = true;
        pushEvent(job, 'info', {
          text: `Review loop: could not discover the pull request for ${job.branch} (${loop.discoveryError}). It will retry when this session settles idle.`,
        });
        save(job);
      }
      return;
    }
    // Armed but nothing to review against yet: the findings land on a pull
    // request, so the loop starts once the session has opened one. Said once,
    // not per turn.
    if (!loop.armedSaid) {
      loop.armedSaid = true;
      pushEvent(job, 'info', {
        text: 'Review loop is armed. The first review starts once this session has an open pull request.',
      });
      save(job);
    }
    return;
  }
  if (job.prStatus && job.prStatus.state !== 'open') return;
  const sha = loopHeadSha(job);
  // A converged loop still reviews a later push. With nothing new, though, its
  // queued QA run is the next step, and the only one, before the loop idles.
  if (loop.done && sha && sha !== loop.lastSha) reopenLoopForPush(job);
  if (loop.done) {
    await maybeStartLoopQa(job);
    return;
  }
  // A stalled loop is waiting for a person, and a push is the sign one has
  // been: nothing automatic pushes while the loop is stalled, since the round
  // that stalled it started no fix session. So the next new commit lifts the stall
  // the same way it reopens a converged loop, and one that never comes leaves
  // the loop quietly stopped.
  if (loop.stalled && sha && sha !== loop.lastSha) loop.stalled = false;
  if (loop.stalled) return;
  if (!sha || sha === loop.lastSha) return;
  // Safety for records restored before QA carried its own done state: every
  // new review round invalidates an earlier QA verdict, however the gates above
  // were spelled when that verdict was recorded.
  reopenLoopForPush(job);
  loop.reviewing = true;
  loop.rounds += 1;
  loop.lastSha = sha;
  try {
    const review = createDevSession({
      ...loopSessionRuntime(job),
      repo: job.repo,
      branch: job.branch,
      review: true,
      prNumber,
      autoClose: true,
      loopParentId: job.id,
    });
    // Creation is the point at which this round truly exists. Until here, a
    // restarted worker must retain the failure that made retry_review useful,
    // and its queued retry must remain armed in case the pool refuses this
    // attempt.
    loop.failure = null;
    loop.retryPending = false;
    loop.reviewSessionId = review.id;
    pushEvent(job, 'info', {
      // No session id in the text: a loop review is auto-closing, and closing
      // it deletes its record, so an id here would dangle by the time anyone
      // read it. What the review did outlives it on the pull request.
      text: `Review loop: started code review round ${loop.rounds} of PR #${prNumber}. Its feedback comes back here when it is done, and what it publishes stays on the pull request.`,
    });
  } catch (e) {
    // Most often the pool is full. The round did not happen: give it back,
    // and clear the sha gate so the next settle tries again.
    loop.reviewing = false;
    loop.rounds -= 1;
    loop.lastSha = null;
    // A refused reviewer is a failed round too. Persist it rather than
    // clearing the prior state before the create attempt: list_workers then
    // says what happened and retry_review still has a round to re-run.
    failLoopRound(job, e.message);
    pushEvent(job, 'info', {
      text: `Review loop: could not start the code review: ${e.message}. Retry it with ${retryLoopAction(job)}, or it starts on the next push.`,
    });
  }
  bus.emit('job', publicJob(job));
  save(job);
}

// A loop review closed. When it finished its errand, read what it declared and
// hand it to a fix session of its own; a review stopped mid-way (the Stop
// button, a superseding close) just releases the loop, which waits for the
// next push rather than re-running a review nobody finished on purpose.
async function onLoopReviewClosed(review) {
  const parent = jobs.get(review.loopParentId);
  if (!parent || parent.kind !== 'devchat' || !parent.reviewLoop) return;
  const loop = parent.reviewLoop;
  if (loop.reviewSessionId !== review.id) return;
  loop.reviewing = false;
  save(parent);
  // The parent went away while the review ran: closed by hand, or the merge
  // that closed the review closed it too. Nobody is owed the findings.
  if (!DEV_OPEN.includes(parent.status)) return;
  if (!review.loopReviewDone) {
    failLoopRound(parent, 'the code review closed before it published anything');
    pushEvent(parent, 'info', {
      text: 'Review loop: the code review was stopped before it finished, so this round approved nothing. It runs again on the next push, or now with the 🔁 chip (an orchestrator retries it with retry_review).',
    });
    save(parent);
    return;
  }
  const prNumber = sessionPrNumber(parent);
  if (!prNumber) return;
  // The review's own outcome goes into the loop's state before GitHub is asked
  // anything: what the round found is on the pull request from here on, and a
  // transient failure reading it back must not be the same thing as the round
  // never having happened. Everything after this point is a retry of one read.
  loop.pendingResult = { prNumber, round: loop.rounds, since: review.createdAt || null };
  save(parent);
  await resolveLoopRound(parent);
}

// How a failed findings read is retried inside one resolveLoopRound call,
// before the round is left pending for the next settle or sync tick to pick up.
// Short on purpose: this is for the rate limit or the 5xx that clears in a
// second, and the pending state is what carries the longer outages.
const FINDINGS_READ_ATTEMPTS = 3;
const FINDINGS_READ_RETRY_MS = 400;

// How the pending round is paced once those in-call attempts are spent. Both
// the settle and the 20s sync tick drain the field, and without a cooldown a
// GitHub incident would mean a full resolveLoopRound — three requests — every
// 20s for every pending session, which is the core budget the pull request
// syncs, the comment writes and the reviews themselves need. The wait doubles
// per failed resolve, capped so a read that comes back is still picked up
// within a couple of minutes.
const PENDING_ROUND_RETRY_MS = 20_000;
const PENDING_ROUND_RETRY_MAX_MS = 160_000;

// And how long it is retried at all. Past this the failure is not the 5xx the
// pending state is for: it is a rotated token, a lost `repo` scope, a deleted
// pull request — something no number of retries fixes. The round is dropped
// there rather than held forever behind a gate that holds every later round
// with it (see resolveLoopRound). It measures reads that actually failed
// against GitHub: a rate-limit cooldown, which throws locally without asking
// GitHub anything, is not charged to it.
const PENDING_ROUND_DEADLINE_MS = 30 * 60_000;

// Sessions whose pending round is being resolved right now: the settle, the
// sync tick and the review's own close all drain the same field, and two of
// them inside the same GitHub call would act on one round twice.
const loopResultInflight = new Set();

// QA has one verdict read after its run, just as review has one findings read
// after each round. Keep its retry state on the parent so an idle session and
// a restarted process can both continue the same read.
const QA_VERDICT_READ_ATTEMPTS = 3;
const QA_VERDICT_READ_RETRY_MS = 400;
const PENDING_QA_VERDICT_RETRY_MS = 20_000;
const PENDING_QA_VERDICT_RETRY_MAX_MS = 160_000;
const PENDING_QA_VERDICT_DEADLINE_MS = 30 * 60_000;
const qaVerdictInflight = new Set();
const qaVerdictRetryTimers = new Map();

// Read what a finished review declared and act on it: the round's whole second
// half, kept separate from the review's close so it can be retried. A read that
// keeps failing leaves `pendingResult` where it is, so the round is still the
// loop's next step (maybeStartLoopReview drains it before considering a new
// review, and syncDevPrs retries it while nobody is chatting) instead of the
// loop falling back to waiting for a push with a finished review discarded.
// Those retries back off, and past PENDING_ROUND_DEADLINE_MS they stop: a read
// that will never succeed must not hold the round — and with it every later
// round — for good.
async function resolveLoopRound(parent) {
  const loop = parent.reviewLoop;
  if (!loop || !loop.pendingResult) return;
  if (loopResultInflight.has(parent.id)) return;
  const pending = loop.pendingResult;
  const { prNumber, round, since } = pending;
  // The parent was closed (by hand, or by the merge that closed the review)
  // while the result was pending: nobody is owed it. The round goes with it,
  // exactly as the post-read check below drops it, so a reopen does not fire a
  // round that finished before the close. `interrupted` (a process restart
  // caught it mid-backoff) and `failed` are not this: see isRetired.
  if (isRetired(parent.status)) {
    loop.pendingResult = null;
    save(parent);
    return;
  }
  // Backed off between resolves: every other GitHub caller on the sync tick
  // holds a cooldown of its own, and this one holds it here so the retry
  // survives an incident instead of amplifying it.
  if (pending.nextRetryAt && Date.now() < Date.parse(pending.nextRetryAt)) return;
  let findings;
  let failure = null;
  loopResultInflight.add(parent.id);
  try {
    for (let attempt = 1; attempt <= FINDINGS_READ_ATTEMPTS; attempt++) {
      try {
        // Scoped to comments this review could have written: a round that ran
        // but published nothing must read as "declared nothing" (which stops
        // the loop) rather than handing back the previous round's
        // already-fixed findings.
        findings = await latestReviewFindings(parent.repo, prNumber, { since });
        failure = null;
        break;
      } catch (e) {
        failure = e;
        // A primary rate limit is thrown locally off the running cooldown, so
        // the two retries behind it would fail the same way in the same
        // millisecond: the wait below is the only thing that helps.
        if (e && e.rateLimited) break;
        if (attempt < FINDINGS_READ_ATTEMPTS) {
          await new Promise((r) => setTimeout(r, FINDINGS_READ_RETRY_MS * attempt));
        }
      }
    }
  } finally {
    loopResultInflight.delete(parent.id);
  }
  if (failure) {
    // A primary rate limit is not a failed read: `checkCooldown` threw off the
    // running cooldown without touching the network, and the error already
    // says when that cooldown lifts. The retry is parked exactly there, and
    // the wait is added back to `failingSince` so it costs the round nothing:
    // GitHub's core budget resets on a fixed hourly window, so a limit hit
    // early in one parks the cooldown for longer than the deadline itself, and
    // charging that wait to the round would drop precisely the round this
    // whole pending state exists to hold on to.
    const rateWait = failure.rateLimited && failure.retryAt ? Math.max(0, failure.retryAt - Date.now()) : 0;
    if (rateWait) {
      pending.nextRetryAt = new Date(failure.retryAt).toISOString();
      if (pending.failingSince) {
        pending.failingSince = new Date(Date.parse(pending.failingSince) + rateWait).toISOString();
      }
    } else {
      // What paces the next resolve and what the deadline is measured from:
      // the first failed read starts the clock, and each one after it doubles
      // the wait.
      pending.attempts = (pending.attempts || 0) + 1;
      pending.failingSince = pending.failingSince || now();
      pending.nextRetryAt = new Date(
        Date.now() +
          Math.min(PENDING_ROUND_RETRY_MS * 2 ** (pending.attempts - 1), PENDING_ROUND_RETRY_MAX_MS),
      ).toISOString();
    }
    pending.error = failure.message;
    // The read has been failing for longer than any outage worth waiting out,
    // so waiting is not the answer. Judged here rather than on the way in: a
    // round pending across a restart (markInterrupted) or a failed turn has
    // nothing retrying it in the meantime, and the read GitHub would now
    // answer must be made before its clock is read. The round stops being the
    // loop's next step and the loop stalls the way every other dead end does:
    // what the round found is on the pull request, its orchestrator is told to
    // judge it by hand, and the next push starts a fresh round instead of
    // finding the loop wedged here.
    if (!rateWait && Date.now() - Date.parse(pending.failingSince) >= PENDING_ROUND_DEADLINE_MS) {
      loop.pendingResult = null;
      // A pull request that was merged or closed during the outage is owed
      // nothing: no round to judge, nothing to stall the loop for, and no
      // reason to spend an orchestrator turn on it — the same exit every other
      // branch here takes.
      if (parent.prStatus && parent.prStatus.state !== 'open') {
        save(parent);
        return;
      }
      loop.stalled = true;
      const why = pending.error ? ` The last attempt said: ${pending.error}.` : '';
      pushEvent(parent, 'info', {
        text: `Review loop: review round ${round}'s findings could not be read off PR #${prNumber} for ${Math.round(PENDING_ROUND_DEADLINE_MS / 60_000)} minutes, so the loop stops rather than holding the round any longer.${why} What the round published is on the pull request: read it there and decide. The loop picks up again on the next push, and the 🔁 chip restarts it from scratch.`,
      });
      save(parent);
      bus.emit('job', publicJob(parent));
      notifyParentUnreadRound(parent, prNumber, round, pending.error);
      return;
    }
    // Said once per round, not once per retry: the tick asks again every few
    // seconds and a log line for each would drown the session.
    if (!pending.said) {
      pending.said = true;
      pushEvent(parent, 'info', {
        text: `Review loop: could not read review round ${round}'s findings from PR #${prNumber}: ${failure.message}. The round is not lost; reading it is retried, and what the review published is on the pull request.`,
      });
      bus.emit('job', publicJob(parent));
    }
    save(parent);
    return;
  }
  // Re-checked after the GitHub round-trip: a merge or a close that landed
  // while the findings were being read must not reopen the parent for a fix
  // turn nobody wants. The pending round goes with them either way: the review
  // it belongs to is over, and there is nothing left to retry it for. An
  // interrupted or failed parent is not retired (see isRetired), so its round
  // still goes on to a fix session below, which starts its own session
  // rather than resuming the parent's turn, so the parent need not be live.
  loop.pendingResult = null;
  if (isRetired(parent.status) || (parent.prStatus && parent.prStatus.state !== 'open')) {
    save(parent);
    return;
  }
  if (!findings.length) {
    loop.done = true;
    pushEvent(parent, 'info', {
      text: `Review loop: review round ${round} declared no findings. The loop is done unless something new is pushed.`,
    });
    save(parent);
    bus.emit('job', publicJob(parent));
    notifyParentConverged(parent, prNumber, `review round ${round} declared no findings`);
    await maybeStartLoopQa(parent);
    return;
  }
  // The fix session has the checkout and owns the decision on what needs fixing.
  await implementRound(parent, prNumber, findings);
}

// The severity floor a round's automatic split runs on. The first rounds
// take everything; from `lowFindingsUntilRound` on, a low no longer re-opens
// the loop. A low found on a later round is nearly always a note on the code
// the round before it wrote (a memo keyed by the wrong thing, a query count
// that moved by two) and fixing it writes more code for the next round to
// have an opinion about. That is the shape a loop that never converges has:
// every round genuine, every round smaller, none of them the feature.
function roundSeverityFloor(loop) {
  const cfg = getConfig();
  return cfg.reviewLoop.lowFindingsUntilRound
    ? loop.rounds > cfg.reviewLoop.lowFindingsUntilRound
      ? 'medium'
      : 'low'
    : 'low';
}

// Legacy triage API for clients with a previously held round. New rounds go straight to fixes.
// Every finding needs one: a triage that rules on half a round would leave
// the other half neither fixed nor recorded, and the loop has to know the
// judgment was made rather than skipped. Dismissed and optional are recorded
// the way the findings panel records them (and said on the pull request with
// the reasons), so a later round's review re-declaring the finding is left
// alone; what is marked fix goes to the fix session, with the note as extra
// guidance. Nothing to fix converges the round.
export async function triageLoopFindings(id, { verdicts, note } = {}) {
  const job = jobs.get(id);
  if (!job || job.kind !== 'devchat') throw new Error('Session not found');
  const loop = job.reviewLoop;
  const held = loop && loop.triage;
  if (!held) throw new Error('This worker has no review round waiting for triage');
  if (!Array.isArray(verdicts) || !verdicts.length) throw new Error('Give one verdict per finding');
  const byKey = new Map(held.findings.map((f) => [f.key || findingKey(f.title), f]));
  const ruled = new Map();
  for (const v of verdicts) {
    const key = String((v && v.key) || '').trim();
    const finding = byKey.get(key);
    if (!finding) throw new Error(`No finding ${key || '(blank key)'} is waiting for triage on this worker`);
    const decision = normalizeVerdict(v.decision);
    if (!decision) {
      throw new Error(`"${v.decision}" is not a verdict for ${key}; use fix, dismissed or optional`);
    }
    ruled.set(key, { ...finding, decision, reason: String(v.reason || '').trim() || null });
  }
  const missing = [...byKey.keys()].filter((k) => !ruled.has(k));
  if (missing.length) {
    throw new Error(`Every finding needs a verdict; still unruled: ${missing.join(', ')}`);
  }
  const all = [...ruled.values()];
  const kept = all.filter((v) => v.decision === 'fix');
  const { error } = await recordTriage(
    job.repo,
    held.prNumber,
    all.map(({ parked, ...v }) => v),
    { round: held.round },
  );
  // The record and the comment were a round-trip; what the loop is holding
  // may have changed under them (the loop turned off, the round already
  // triaged by a second call, the worker closed).
  if (!job.reviewLoop || job.reviewLoop.triage !== held) {
    throw new Error('That round is no longer waiting for triage');
  }
  loop.triage = null;
  const waived = all.length - kept.length;
  pushEvent(job, 'info', {
    text:
      `Review loop: the orchestrator triaged round ${held.round}: ${kept.length} finding(s) to fix, ${waived} left out` +
      (waived
        ? ` (${all
            .filter((v) => v.decision !== 'fix')
            .map((v) => `${v.title}: ${v.decision}${v.reason ? `, ${v.reason}` : ''}`)
            .join('; ')})`
        : '') +
      (error ? `. Recording the verdicts on PR #${held.prNumber} failed in part: ${error}` : '.'),
  });
  save(job);
  bus.emit('job', publicJob(job));
  if (isRetired(job.status)) return { fixing: false, converged: false };
  if (job.prStatus && job.prStatus.state !== 'open') return { fixing: false, converged: false };
  if (!kept.length) {
    loop.done = true;
    pushEvent(job, 'info', {
      text: `Review loop: round ${held.round} leaves nothing to implement after triage. The loop is done unless something new is pushed.`,
    });
    save(job);
    bus.emit('job', publicJob(job));
    notifyParentConverged(
      job,
      held.prNumber,
      `round ${held.round} left nothing to implement after your triage`,
    );
    await maybeStartLoopQa(job);
    return { fixing: false, converged: true };
  }
  const started = startRoundFix(
    job,
    held.prNumber,
    kept.map(({ decision, reason, parked, ...f }) => f),
    { triaged: true, note: String(note || '').trim() || null },
  );
  return { fixing: started, converged: false };
}

function normalizeVerdict(decision) {
  const d = String(decision || '')
    .trim()
    .toLowerCase();
  if (d === 'fix') return 'fix';
  if (d === 'dismiss' || d === 'dismissed') return 'dismissed';
  if (d === 'optional') return 'optional';
  return null;
}

// A round nobody triages: the loop's own rules decide what is implemented,
// the round's findings go on the checklist, and the gates that stop a loop
// from chasing its own fixes run in order.
async function implementRound(parent, prNumber, findings) {
  const cfg = getConfig();
  const loop = parent.reviewLoop;
  // Put this round's findings on the pull request's "Required fixes" checklist
  // before the fix session starts. That checklist is where a finding is marked
  // solved (the fix session ticks the items it actually fixed), and nothing else
  // writes it for a loop round, whose findings no human ever decided on. A
  // failure here is not worth withholding the fixes for: the turn still runs,
  // it just has nothing to tick.
  //
  // What goes to the fix session is narrower than what the review found, and it
  // narrows as the rounds go by (roundSeverityFloor).
  const floor = roundSeverityFloor(loop);
  let queued = findings;
  try {
    const listed = await queueFindingsForFix(parent.repo, prNumber, findings, { severityFloor: floor });
    // A checklist that could not be written still filtered the round against
    // the verdicts somebody gave; those hold either way.
    queued = listed.kept;
    const parked = listed.parked;
    if (parked.length) {
      const why = parked.map((f) => `${f.title} (${PARK_REASONS[f.reason] || f.reason})`).join('; ');
      pushEvent(parent, 'info', {
        text: `Review loop: round ${loop.rounds} left ${parked.length} finding(s) on PR #${prNumber} as optional rather than implementing them: ${why}. They are in the findings panel if you want any of them done.`,
      });
      save(parent);
    }
    if (listed.error) {
      pushEvent(parent, 'info', {
        text: `Review loop: could not list the findings as required fixes on PR #${prNumber}: ${listed.error}. They are implemented anyway, but nothing marks them solved there.`,
      });
      save(parent);
    }
  } catch (e) {
    // Not even the stored verdicts could be read. The round goes as it came:
    // holding findings back because the database is unreachable would drop
    // work the review did, and re-fixing a dismissed one is the lesser harm.
    pushEvent(parent, 'info', {
      text: `Review loop: could not read this pull request's finding verdicts: ${e.message}. Every finding this round left is implemented, including any that were dismissed.`,
    });
    save(parent);
  }
  // The checklist write is another round-trip, so the guard above is re-run:
  // a merge or a close that landed inside it must not still start a fix session.
  if (isRetired(parent.status)) return;
  if (parent.prStatus && parent.prStatus.state !== 'open') return;
  // Nothing this round found is this round's to implement: every finding was
  // already dismissed or marked optional by hand, or parked by the rules
  // above. Either way the loop has converged on what it is allowed to change.
  if (!queued.length) {
    loop.done = true;
    pushEvent(parent, 'info', {
      text: `Review loop: review round ${loop.rounds} left ${findings.length} finding(s), none of them for this loop to implement, so nothing to do.`,
    });
    save(parent);
    notifyParentConverged(
      parent,
      prNumber,
      `review round ${loop.rounds} left ${findings.length} finding(s), none of them for the loop to implement (already dismissed or optional)`,
    );
    await maybeStartLoopQa(parent);
    return;
  }
  // The round cap. The stall gate below only catches a loop handing back the
  // *same* findings; a loop reviewing its own fixes hands back different ones
  // every round and would run forever without ever repeating itself. This
  // round still reviewed and its findings are listed on the pull request; the
  // loop just stops short of the fix session that would start round n+1.
  if (cfg.reviewLoop.maxRounds && loop.rounds >= cfg.reviewLoop.maxRounds) {
    loop.stalled = true;
    pushEvent(parent, 'info', {
      text: `Review loop: round ${loop.rounds} is as far as this loop goes (REVIEW_LOOP_MAX_ROUNDS=${cfg.reviewLoop.maxRounds}), so its ${queued.length} finding(s) are listed on PR #${prNumber} rather than implemented. Read them and decide: ⚙ Implement feedback does the round, and the 🔁 chip restarts the loop from scratch.`,
    });
    save(parent);
    bus.emit('job', publicJob(parent));
    notifyParentStalled(
      parent,
      prNumber,
      `round ${loop.rounds} is as far as it goes (REVIEW_LOOP_MAX_ROUNDS=${cfg.reviewLoop.maxRounds})`,
      queued,
    );
    return;
  }
  startRoundFix(parent, prNumber, queued);
}

// The last gate and the fix session behind it, for the findings a round is
// implementing: the loop's own pick, or what the orchestrator's triage kept.
// Answers whether a fix session was started.
//
// The stall gate is the backstop that took the round cap's place. Two rounds
// that hand back exactly the same findings mean the fix session between them
// did not move the review: implementing them again pushes another commit,
// which opens the sha gate, which starts the same round over: a ping-pong
// that holds a pooled session and spends tokens on a session nobody is
// watching. The loop stops instead and says why. What the round found is not
// lost: it is on the pull request either way.
function startRoundFix(parent, prNumber, queued, { triaged = false, note = null } = {}) {
  const loop = parent.reviewLoop;
  const signature = queued
    .map((f) => f.key || findingKey(f.title))
    .sort()
    .join(',');
  if (signature === loop.lastFindings) {
    loop.stalled = true;
    pushEvent(parent, 'info', {
      text: `Review loop: review round ${loop.rounds} left the same ${queued.length} finding(s) as the round before it. The fix sessions are not moving them, so the loop stops rather than repeating itself. They are listed on PR #${prNumber}; the loop picks up again on the next push, and the 🔁 chip restarts it from scratch.`,
    });
    save(parent);
    bus.emit('job', publicJob(parent));
    notifyParentStalled(
      parent,
      prNumber,
      `round ${loop.rounds} left the same findings as the round before it, so the fix sessions are not moving them`,
      queued,
    );
    return false;
  }
  loop.lastFindings = signature;
  // The same errand ⚙ Implement feedback runs, in an auto-closing session of
  // its own rather than as a turn inside this one: the round's fixes never
  // interleave with the conversation the user is having here (a question this
  // session is standing on stays standing), and what the fix session pushes
  // comes back through the pull request, where the next round reads it anyway.
  // Its close is what starts that next round (onLoopFixClosed).
  const prompt = implementFeedbackPrompt({
    repo: parent.repo,
    prNumber,
    branch: parent.branch,
    findings: queued,
    triaged,
    note,
    project: getProject(parent.repo),
  });
  pushEvent(parent, 'info', {
    text: `Review loop: review round ${loop.rounds} left ${queued.length} finding(s).`,
  });
  save(parent);
  startLoopFixSession(parent, prNumber, prompt);
  return !!loop.fixing;
}

// A round's findings go to a fix session: the same auto-closing worktree
// errand the board's 🛠 Implement feedback starts, on the parent's own branch
// and provider, marked with loopFixParentId so its close reports back here.
// The parent stays what it is, the loop's anchor: it keeps its clone and its
// conversation, and the loop's next round starts from it once the fix session
// has pushed and closed.
function startLoopFixSession(parent, prNumber, prompt) {
  const loop = parent.reviewLoop;
  if (!loop || loop.fixing) return;
  const where = prNumber ? `PR #${prNumber}` : 'the pull request';
  // The branch is what the fix session checks out; without one there is no
  // tree to fix on, and cutting a fresh branch would push the fixes nowhere.
  if (!parent.branch) {
    pushEvent(parent, 'info', {
      text: `Review loop: this session has no branch to fix on yet, so the findings stay on ${where}.`,
    });
    save(parent);
    return;
  }
  loop.fixing = true;
  try {
    const fix = createDevSession({
      ...loopSessionRuntime(parent),
      repo: parent.repo,
      branch: parent.branch,
      prompt,
      title: `Fix findings${prNumber ? `: #${prNumber}` : ''}`,
      autoClose: true,
      prNumber: prNumber || undefined,
      loopFixParentId: parent.id,
      // The same errand the board's 🛠 Implement feedback starts, so its spend
      // files under the same activity in the usage ledger.
      activity: 'implement-feedback',
    });
    loop.fixSessionId = fix.id;
    pushEvent(parent, 'info', {
      // No session id in the text: a fix session is auto-closing, and closing
      // it deletes its record, so an id here would dangle by the time anyone
      // read it. What it did outlives it on the pull request.
      text: `Review loop: started a fix session to implement the findings on ${where}. What it pushes is reviewed as the next round.`,
    });
  } catch (e) {
    loop.fixing = false;
    pushEvent(parent, 'info', {
      text: `Review loop: could not start the fix session: ${e.message}. The findings are on ${where}.`,
    });
  }
  bus.emit('job', publicJob(parent));
  save(parent);
}

// A fix session the loop started closed. When it finished its errand, its
// pushes are on the branch: teach the parent's clone about them (the sha gate
// reads the parent's own remote-tracking ref, see loopHeadSha) and offer the
// next round. One stopped mid-way just releases the loop, which waits for the
// next push rather than re-running work nobody finished on purpose.
async function onLoopFixClosed(fix) {
  const parent = jobs.get(fix.loopFixParentId);
  if (!parent || parent.kind !== 'devchat' || !parent.reviewLoop) return;
  const loop = parent.reviewLoop;
  if (loop.fixSessionId !== fix.id) return;
  loop.fixing = false;
  loop.fixSessionId = null;
  save(parent);
  // A fix session started for a parent that has since gone `interrupted` or
  // `failed` (not `closed`) still owes it a resumed loop: it is not resuming
  // the parent's own turn, so it does not need the parent live either.
  if (isRetired(parent.status)) return;
  if (!fix.loopFixDone) {
    pushEvent(parent, 'info', {
      text: 'Review loop: the fix session was stopped before it finished. The loop resumes on the next push.',
    });
    save(parent);
    return;
  }
  pushEvent(parent, 'info', {
    text: 'Review loop: the fix session finished. Whatever it pushed is reviewed as the next round.',
  });
  save(parent);
  await fetchLoopBranch(parent);
  maybeStartLoopReview(parent, { fresh: true }).catch(() => {});
}

// Update the parent clone's remote-tracking ref with what the fix session
// pushed from its own worktree. The loop's commit gate (loopHeadSha) reads
// that ref, and without the fetch a push made anywhere but this clone never
// opens it. Only the ref moves: the checkout itself is the agent's, and is
// never rewritten behind it.
function fetchLoopBranch(job) {
  if (!job.workDir || !job.branch) return Promise.resolve(false);
  return new Promise((resolve) => {
    const child = spawn('git', ['-C', job.workDir, 'fetch', 'origin', job.branch], {
      env: jobEnv({ GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' }, job),
    });
    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0));
  });
}

// The fix session stopped to ask something. It stays open like any asking
// session; this says where the answer is owed.
function notifyLoopFixAsking(fix) {
  const parent = jobs.get(fix.loopFixParentId);
  if (!parent || !parent.reviewLoop || parent.reviewLoop.fixSessionId !== fix.id) return;
  if (!DEV_OPEN.includes(parent.status)) return;
  pushEvent(parent, 'info', {
    text: `Review loop: the fix session stopped to ask a question. Answer it in session ${fix.id} to let it finish.`,
  });
  save(parent);
}

// The fix session died before it could close: release the loop and say so, so
// the parent is not left waiting on fixes that are never coming. The sha gate
// keeps this from retrying in a circle: the next round starts on the next
// push, or by hand.
function notifyLoopFixFailed(fix) {
  const parent = jobs.get(fix.loopFixParentId);
  if (!parent || !parent.reviewLoop || parent.reviewLoop.fixSessionId !== fix.id) return;
  parent.reviewLoop.fixing = false;
  parent.reviewLoop.fixSessionId = null;
  const why = fix.error || 'no error recorded';
  failLoopRound(parent, why);
  save(parent);
  if (!DEV_OPEN.includes(parent.status) && parent.status !== 'interrupted') return;
  pushEvent(parent, 'info', {
    text: `Review loop: the fix session failed (${why}). The findings are on the pull request; retry the round with ${retryLoopAction(parent)}, or the next push starts a new one.`,
  });
  save(parent);
  notifyParentLoop(
    parent,
    `the review loop's fix session failed (${why}). The findings are on its pull request; retry the round with retry_review, or send the worker back to implement them and push a fix.`,
  );
}

// A round that ended with no verdict because the machinery under it failed:
// the provider exited non-zero (an exhausted account, a crashed CLI), or the
// review closed having published nothing. Deliberately not the same thing as a
// round that ran and declared nothing, which is what converges a loop: this one
// approved nothing, and the only reason it is not running is that nothing
// re-ran it. Recorded so list_workers says so and retryLoopRound can re-run it
// without a push nobody has left to make.
function failLoopRound(job, reason) {
  const loop = job.reviewLoop;
  if (!loop) return;
  loop.failure = { round: loop.rounds, reason, at: now() };
}

// Re-run the loop's round now: the orchestrator's retry_review tool (the UI's
// own retry is the 🔁 chip off and on, which re-arms the loop from scratch).
// A round whose review died on its provider
// leaves the loop gated on a commit that has already been reviewed once, so
// nothing short of a new push would start another — and a worker whose work is
// finished and correct has none to make. This clears that gate and offers the
// round again, optionally on another runtime, which the loop then keeps for
// its later rounds (loopSessionRuntime) so a retry away from an exhausted
// account does not have to be repeated every round.
//
// It re-runs a review; it never stands in for one. A loop mid-round (a review
// out, findings being read, a round awaiting triage, a fix session running) is
// refused rather than restarted: those rounds are alive.
export async function retryLoopRound(id, { providerId, model, effort } = {}) {
  const job = jobs.get(id);
  if (!job || job.kind !== 'devchat') throw new Error('Session not found');
  const loop = job.reviewLoop;
  if (!loop) throw new Error('This session has no review loop to retry a round of');
  const reopen = job.status === 'interrupted';
  if (!DEV_OPEN.includes(job.status) && !reopen)
    throw new Error('This session is closed; reopen it before retrying');
  const busy = loop.reviewing
    ? 'a code review is running'
    : loop.pendingResult
      ? "the last round's findings are still being read off the pull request"
      : loop.triage
        ? 'a round is waiting for triage'
        : loop.fixing
          ? 'a fix session is running'
          : null;
  if (busy) throw new Error(`Nothing to retry: ${busy}`);
  if (providerId != null || model != null || effort != null) {
    const runtime = {
      providerId: providerId != null ? providerId : job.providerId,
      model: typeof model === 'string' && model ? model : job.model,
      effort: typeof effort === 'string' && effort ? effort : job.effort,
    };
    const resolved = resolveRuntime(runtime, getConfig());
    if (!resolved) throw new Error(`Unknown provider: ${runtime.providerId}`);
    loop.runtime = { providerId: resolved.provider.id, model: resolved.model, effort: resolved.effort };
  }
  const failed = loop.failure;
  // The gates a failed (or stalled, or converged) round left behind: the sha
  // the round was started for, which is what makes a round happen at most once
  // per push. The round itself is started by maybeStartLoopReview, so every
  // rule it applies — an open pull request, the round cap, a session that is
  // not mid-turn — applies to a retry exactly as to a push's round.
  loop.lastSha = null;
  loop.stalled = false;
  loop.done = false;
  if (reopen) loop.retryPending = true;
  const where = loop.runtime ? ` on ${loop.runtime.model}` : '';
  pushEvent(job, 'info', {
    text: `Review loop: ${reopen ? 'reopening this session and retrying' : 'retrying'} the review${where}${
      failed ? ` after round ${failed.round} failed (${failed.reason})` : ''
    }.`,
  });
  save(job);
  if (reopen) {
    reopenDevSession(job.id);
    return { started: false, round: loop.rounds };
  }
  await maybeStartLoopReview(job, { fresh: true });
  // Not started is not a failure: the session may be mid-turn, and the gate is
  // open now, so the round starts the moment it settles.
  return { started: !!loop.reviewing, round: loop.rounds };
}

// The review stopped to ask something, so it stays open on its question, and the
// loop stays on hold until it is answered (in the review session) and the
// review closes.
function notifyLoopReviewAsking(review) {
  const parent = jobs.get(review.loopParentId);
  if (!parent || !parent.reviewLoop || parent.reviewLoop.reviewSessionId !== review.id) return;
  if (!DEV_OPEN.includes(parent.status)) return;
  pushEvent(parent, 'info', {
    text: `Review loop: the code review stopped to ask a question. Answer it in session ${review.id} to let it finish.`,
  });
  save(parent);
}

// The review died before doing anything, so release the loop and say so, so the
// parent is not left waiting on a report that is never coming. The sha gate
// keeps this from retrying in a circle: the next round starts on the next
// push, or by hand.
function notifyLoopReviewFailed(review) {
  const parent = jobs.get(review.loopParentId);
  if (!parent || !parent.reviewLoop || parent.reviewLoop.reviewSessionId !== review.id) return;
  parent.reviewLoop.reviewing = false;
  const why = review.error || 'no error recorded';
  failLoopRound(parent, why);
  save(parent);
  if (!DEV_OPEN.includes(parent.status) && parent.status !== 'interrupted') return;
  pushEvent(parent, 'info', {
    text: `Review loop: the code review failed (${why}), so this round reviewed nothing. It runs again on the next push, or now with ${retryLoopAction(parent)}.`,
  });
  save(parent);
  notifyParentLoop(
    parent,
    `the review loop's code review could not run (${why}). This is the provider failing, not a review that found nothing: round ${parent.reviewLoop.rounds} approved nothing. Retry it with retry_review — on another provider_id/model if this one is out of quota — since a worker with nothing left to push will never start the round itself.`,
  );
}

// The review loop's clean hand-off to QA: start the same kind of auto-closing
// QA session the board's 🎬 button starts. That session's first turn writes the
// test sheet; runQaSequence sends the test-run turn the moment that turn
// settles, so “sheet first, then QA” is one session with two turns rather than
// a fragile chain of sessions.
async function maybeStartLoopQa(job) {
  const qaLoop = job.qaLoop;
  if (!qaLoop) return;
  // A completed QA run whose verdict read is pending is still this run's
  // responsibility. Never mistake the idle gap for permission to execute QA
  // again; resolveQaVerdict owns the retry.
  if (qaLoop.pendingVerdict || qaLoop.verdictError) return;
  if (qaLoop.running) {
    // The expected run, or an old one left to finish after a newer push. Either
    // still holds this loop's QA turn; neither starts a second QA alongside it.
    const activeId = qaLoop.sessionId || qaLoop.staleSessionId;
    const qa = activeId ? jobs.get(activeId) : null;
    if (qa && DEV_OPEN.includes(qa.status)) return;
    qaLoop.running = false;
    if (qaLoop.staleSessionId === activeId) qaLoop.staleSessionId = null;
  }
  if (qaLoop.done) return;
  if (!job.reviewLoop || !job.reviewLoop.done) return;
  if (job.status !== 'idle' || job.awaitingAnswer) return;
  if ((devQueues.get(job.id) || []).length) return;
  const prNumber = sessionPrNumber(job);
  if (!prNumber) {
    pushEvent(job, 'info', {
      text: 'QA loop: the review loop converged before this session’s pull request could be read. QA is retried when the session next settles.',
    });
    save(job);
    return;
  }
  if (job.prStatus && job.prStatus.state !== 'open') return;
  if (!job.branch) {
    pushEvent(job, 'info', {
      text: 'QA loop: the session has no branch to test yet. QA is retried when the session next settles.',
    });
    save(job);
    return;
  }
  // The project's Test sheet runtime decides who writes the sheet; the run turn
  // itself already follows the project's Test run runtime. With no configured
  // sheet runtime, QA follows the session whose work it tests, exactly as the
  // loop's reviews and fixes do (loopSessionRuntime).
  const project = getProject(job.repo);
  const runtime = project ? stepRuntime(project, 'testSheet') : null;
  const provider = runtime ? getProvider(runtime.providerId) : null;
  qaLoop.running = true;
  try {
    const qa = createDevSession({
      ...(provider
        ? { provider: provider.id, model: runtime.model || undefined, effort: runtime.effort || undefined }
        : loopSessionRuntime(job)),
      repo: job.repo,
      branch: job.branch,
      qa: true,
      autoClose: true,
      prNumber,
      qaParentId: job.id,
    });
    qaLoop.sessionId = qa.id;
    // Clear the old failure only once its replacement really exists. A pool
    // refusal must leave list_workers saying why no QA is active.
    qaLoop.failure = null;
    pushEvent(job, 'info', {
      text: `QA loop: the review loop converged, so QA started on PR #${prNumber}: the test sheet is written first, then executed.`,
    });
  } catch (e) {
    qaLoop.running = false;
    qaLoop.failure = { kind: 'failed', reason: `could not start QA: ${e.message}`, at: now() };
    pushEvent(job, 'info', {
      text: `QA loop: could not start QA: ${e.message}. It is retried when this session next finishes a turn.`,
    });
    notifyParentLoop(
      job,
      `QA could not start (${e.message}). No QA is running and nothing was approved; use send_to_worker for a follow-up turn, which retries QA when the worker settles.`,
    );
  }
  bus.emit('job', publicJob(job));
  save(job);
}

function scheduleQaVerdictRetry(parent, delay) {
  if (qaVerdictRetryTimers.has(parent.id)) return;
  const timer = setTimeout(
    () => {
      qaVerdictRetryTimers.delete(parent.id);
      resolveQaVerdict(parent).catch(() => {});
    },
    Math.max(0, delay),
  );
  timer.unref?.();
  qaVerdictRetryTimers.set(parent.id, timer);
}

// Read the test sheet's final verdict after a QA run. The pending record is
// written before the first GitHub call, so a rate limit, transient outage,
// idle session or restart cannot turn a completed run into a retryable QA run.
async function resolveQaVerdict(parent) {
  const qaLoop = parent.qaLoop;
  if (!qaLoop?.pendingVerdict || qaVerdictInflight.has(parent.id)) return;
  const pending = qaLoop.pendingVerdict;
  // Closed is the only status nobody is owed this for; an interrupted or
  // failed parent still gets its read retried, per the comment above.
  if (isRetired(parent.status)) return;
  if (pending.nextRetryAt && Date.now() < Date.parse(pending.nextRetryAt)) {
    scheduleQaVerdictRetry(parent, Date.parse(pending.nextRetryAt) - Date.now());
    return;
  }
  let failures;
  let failure = null;
  qaVerdictInflight.add(parent.id);
  try {
    for (let attempt = 1; attempt <= QA_VERDICT_READ_ATTEMPTS; attempt++) {
      try {
        failures = await latestTestFailures(parent.repo, pending.prNumber);
        failure = null;
        break;
      } catch (e) {
        failure = e;
        if (e?.rateLimited) break;
        if (attempt < QA_VERDICT_READ_ATTEMPTS)
          await new Promise((resolve) => setTimeout(resolve, QA_VERDICT_READ_RETRY_MS * attempt));
      }
    }
  } finally {
    qaVerdictInflight.delete(parent.id);
  }
  if (failure) {
    const rateWait = failure.rateLimited && failure.retryAt ? Math.max(0, failure.retryAt - Date.now()) : 0;
    if (rateWait) {
      pending.nextRetryAt = new Date(failure.retryAt).toISOString();
      // A primary reset can be longer than the ordinary deadline; do not
      // discard a verdict merely because the account was exhausted first.
      if (pending.failingSince) {
        pending.failingSince = new Date(Date.parse(pending.failingSince) + rateWait).toISOString();
      }
      scheduleQaVerdictRetry(parent, rateWait);
    } else {
      pending.attempts = (pending.attempts || 0) + 1;
      pending.failingSince = pending.failingSince || now();
      pending.nextRetryAt = new Date(
        Date.now() +
          Math.min(
            PENDING_QA_VERDICT_RETRY_MS * 2 ** (pending.attempts - 1),
            PENDING_QA_VERDICT_RETRY_MAX_MS,
          ),
      ).toISOString();
      scheduleQaVerdictRetry(parent, Date.parse(pending.nextRetryAt) - Date.now());
    }
    pending.error = failure.message;
    if (!rateWait && Date.now() - Date.parse(pending.failingSince) >= PENDING_QA_VERDICT_DEADLINE_MS) {
      qaLoop.pendingVerdict = null;
      qaLoop.verdictError = failure.message;
      pushEvent(parent, 'info', {
        text: `QA loop: the test sheet’s verdict could not be read for ${Math.round(PENDING_QA_VERDICT_DEADLINE_MS / 60_000)} minutes: ${failure.message}. QA was executed, but its result is not assumed clean; read the sheet and decide by hand.`,
      });
      save(parent);
      bus.emit('job', publicJob(parent));
      notifyParentLoop(
        parent,
        `QA on PR #${pending.prNumber} finished, but its test-sheet verdict could not be read: ${failure.message}. Do not treat it as passed; read the sheet and decide by hand.`,
      );
      return;
    }
    if (!pending.said) {
      pending.said = true;
      pushEvent(parent, 'info', {
        text: `QA loop: could not read the test sheet’s verdict on PR #${pending.prNumber}: ${failure.message}. The QA run is complete; its verdict is retried without rerunning QA.`,
      });
      bus.emit('job', publicJob(parent));
    }
    save(parent);
    return;
  }
  qaLoop.pendingVerdict = null;
  qaLoop.verdictError = null;
  qaLoop.done = true;
  qaLoop.failedScenarios = failures.length;
  pushEvent(parent, 'info', {
    text: failures.length
      ? `QA loop: ${failures.length} scenario(s) failed. The loop stops here for now; read the ❌ rows and decide what to do next.`
      : 'QA loop: the test sheet reports no failed scenarios, so no QA actions are required, so the loop stopped.',
  });
  bus.emit('job', publicJob(parent));
  save(parent);
  notifyParentLoop(
    parent,
    failures.length
      ? `QA on PR #${pending.prNumber} failed ${failures.length} scenario(s). Read the ❌ rows of the test sheet on the pull request and send the worker what to fix, or waive the ones that do not apply and say why there.`
      : `QA on PR #${pending.prNumber} passed: the test sheet reports no failed scenarios. With the review loop converged, the code is approved; if its checks are green, this task is ready to merge.`,
  );
}

// A QA session the loop started stopped on a question. It stays open like any
// asking session; this says where the answer is owed.
function notifyQaLoopAsking(qa) {
  const parent = jobs.get(qa.qaParentId);
  if (!parent || !parent.qaLoop || parent.qaLoop.sessionId !== qa.id) return;
  if (!DEV_OPEN.includes(parent.status)) return;
  pushEvent(parent, 'info', {
    text: `QA loop: the QA session stopped to ask a question. Answer it in session ${qa.id} to let it finish.`,
  });
  save(parent);
}

// A loop-started QA session that dies before it can close: release the QA turn
// and tell the parent, rather than leaving “QA running” stuck until the parent
// happens to settle again. As with a failed review, the next settle is the
// retry point: a provider that just failed should not be retried in a tight
// circle.
function notifyQaLoopFailed(qa) {
  const parent = jobs.get(qa.qaParentId);
  if (!parent || parent.kind !== 'devchat' || !parent.qaLoop) return;
  const qaLoop = parent.qaLoop;
  if (qaLoop.staleSessionId === qa.id) {
    qaLoop.staleSessionId = null;
    qaLoop.running = false;
    save(parent);
    if (DEV_OPEN.includes(parent.status) && parent.reviewLoop && parent.reviewLoop.done) {
      maybeStartLoopQa(parent).catch(() => {});
    }
    return;
  }
  if (qaLoop.sessionId !== qa.id) return;
  qaLoop.running = false;
  const kind = qa.status === 'interrupted' ? 'interrupted' : 'failed';
  const reason = qa.error || 'no error recorded';
  qaLoop.failure = { kind, reason, at: now() };
  save(parent);
  if (!DEV_OPEN.includes(parent.status) && parent.status !== 'interrupted') return;
  pushEvent(parent, 'info', {
    text: `QA loop: the QA session ${kind} (${reason}). No QA is running; send this session a follow-up turn to retry QA when it settles.`,
  });
  save(parent);
  bus.emit('job', publicJob(parent));
  notifyParentLoop(
    parent,
    `QA ${kind} (${reason}). No QA is running and nothing was approved; use send_to_worker for a follow-up turn, which retries QA when the worker settles.`,
  );
}

// A QA run's close is the end of the QA loop. Failed sheet rows are feedback,
// not a fix session: the loop stops there and leaves acting on the feedback to a
// human decision, exactly as the hand-started QA errand does.
async function onQaLoopClosed(qa) {
  const parent = jobs.get(qa.qaParentId);
  if (!parent || parent.kind !== 'devchat' || !parent.qaLoop) return;
  const qaLoop = parent.qaLoop;
  if (qaLoop.staleSessionId === qa.id) {
    qaLoop.staleSessionId = null;
    qaLoop.running = false;
    save(parent);
    if (DEV_OPEN.includes(parent.status) && parent.reviewLoop && parent.reviewLoop.done) {
      maybeStartLoopQa(parent).catch(() => {});
    }
    return;
  }
  if (qaLoop.sessionId !== qa.id) return;
  qaLoop.running = false;
  save(parent);
  // Same as onLoopFixClosed: an interrupted or failed parent still gets its
  // QA verdict, not just an open one.
  if (isRetired(parent.status)) return;
  if (!qa.qaLoopDone) {
    // A provider failure is followed by a close in some paths. Preserve the
    // specific failure recorded above instead of overwriting it with the
    // generic close, and do not wake the orchestrator twice.
    if (qaLoop.failure) return;
    const reason = 'the QA session was stopped before it finished';
    qaLoop.failure = { kind: 'interrupted', reason, at: now() };
    pushEvent(parent, 'info', {
      text: 'QA loop: the QA session was stopped before it finished. No QA is running; send this session a follow-up turn to retry QA when it settles.',
    });
    save(parent);
    bus.emit('job', publicJob(parent));
    notifyParentLoop(
      parent,
      'QA was interrupted before it finished. No QA is running and nothing was approved; use send_to_worker for a follow-up turn, which retries QA when the worker settles.',
    );
    return;
  }
  const prNumber = sessionPrNumber(parent);
  if (!prNumber) return;
  qaLoop.pendingVerdict = { prNumber, since: qa.createdAt || null };
  qaLoop.verdictError = null;
  save(parent);
  await resolveQaVerdict(parent);
}

// ---------------------------------------------------------------------------
// Worker sessions (the orchestrator's children)
//
// An orchestrator session spawns workers through spawnWorkerSession below,
// reached over the /api/agent/sessions routes by the worker tools its turns
// mount (lib/orchestrator-mcp.js). A worker is an ordinary session in every
// other way: its own clone, branch, database claim and sidebar row; parentId
// only files it under its orchestrator and routes it the updates below. An
// update is handed to the orchestrator as an injected turn (that is what
// makes it autonomous), and every turn runs its usually-expensive model, so
// the whole machinery is built around not wasting them: updates batch into
// one turn while the session is busy, and MAX_UNATTENDED_TURNS caps how many
// injected turns may run back to back with no word from the user before the
// updates fall back to plain lines.
// ---------------------------------------------------------------------------

// How many workers one orchestrator may hold open at once, over and above the
// database pool's own cap. A backstop against a runaway agent spawning in a
// loop, not a tuning knob.
const MAX_OPEN_WORKERS = 8;

// The one line a worker drops into its orchestrator's chat when something
// needs eyes: it asked a question, settled, failed or closed.
function notifyParent(job, text) {
  if (!job.parentId) return;
  const parent = jobs.get(job.parentId);
  if (!parent || parent.kind !== 'devchat' || !DEV_OPEN.includes(parent.status)) return;
  pushEvent(parent, 'info', { text });
  save(parent);
}

// A worker settled idle: hand the update to its orchestrator as a turn. A
// worker that stopped on a question already queued something louder (see the
// ask handling in pushEvent), so this stays quiet then. A turn the user
// stopped by hand did not finish anything: saying so costs a line, not an
// orchestrator turn that would race whatever the user stopped it for.
function notifyParentSettled(job) {
  if (!job.parentId || job.awaitingAnswer || job.status !== 'idle') return;
  if (job.turnCanceled) {
    notifyParent(job, `Worker ${job.id} (${job.title || 'untitled'}) had its turn stopped by hand.`);
    return;
  }
  queueWorkerNotice(job, 'settled', {
    text:
      `Worker ${job.id} (${job.title || 'untitled'}) finished its turn` +
      `${job.lastText ? `: ${job.lastText}` : '.'} Verify before moving on: read_worker for the tail, or its pull request.`,
  });
}

// A worker's review loop or QA run reached a verdict. The worker's own chat
// already carries the line; this is the copy its orchestrator acts on, as a
// turn like a settle, because a converged loop is the cue to merge and a
// stalled one the cue to judge what it left. Quiet for a session with no
// orchestrator (queueWorkerNotice checks), which is every loop the user runs
// by hand.
function notifyParentLoop(worker, text) {
  queueWorkerNotice(worker, 'loop', { text: `Worker ${worker.id} (${worker.title || 'untitled'}): ${text}` });
}

function notifyParentConverged(worker, prNumber, how) {
  const qaNext = worker.qaLoop && !worker.qaLoop.done;
  notifyParentLoop(
    worker,
    `the review loop converged on PR #${prNumber}: ${how}, so the code is approved as far as the loop goes.${
      qaNext
        ? ' QA runs next; wait for its verdict before calling the task done.'
        : ' If its checks are green, this task is ready to merge.'
    }`,
  );
}

// The CI run on a worker's pull request finished, as a turn for its
// orchestrator. Without it the session that is one merge from done sits idle
// forever: a converged loop tells it the code is approved "if its checks are
// green", which at that moment they usually are not (the run is still going),
// the orchestrator answers that it will merge once they pass, and its turn
// ends. Nothing would ever wake it again — a finished check run only refreshes
// prStatus and repaints the panel, it moves no session — and the user has to
// nudge a session that already knows what it wants to do.
//
// A failing run is worth the same turn: it is the cue to send the worker back,
// and it arrives while the orchestrator still remembers the task.
function notifyParentChecks(worker, status) {
  const c = status.checks;
  const failing = c.runs
    ? c.runs.filter((r) => ['failure', 'timed_out', 'action_required'].includes(r.conclusion))
    : [];
  if (c.failed > 0) {
    notifyParentLoop(
      worker,
      `the checks on PR #${status.number} finished with ${c.failed} of ${c.total} failing${
        failing.length ? ` (${failing.map((r) => r.name).join(', ')})` : ''
      }. Do not merge it: send the worker back to read the failures and push a fix, or judge the failure yourself if it is not this branch's doing.`,
    );
    return;
  }
  // Green, but green is only half the gate: the loop's verdict is the other
  // half, and a worker mid-round is not ready however passing its CI is.
  const loop = worker.reviewLoop;
  const qa = worker.qaLoop;
  const wait = !loop
    ? null
    : loop.stalled
      ? 'its review loop is stalled and needs a decision on further work'
      : !loop.done
        ? `its review loop is still running (round ${loop.rounds})`
        : qa && !qa.done
          ? 'its QA run has not reported yet'
          : null;
  notifyParentLoop(
    worker,
    `every check on PR #${status.number} passed (${c.passed}/${c.total}). ${
      wait
        ? `${wait[0].toUpperCase()}${wait.slice(1)}, so wait for that before merging.`
        : 'Nothing is pending on it: if its work is approved, this task is ready to merge.'
    }`,
  );
}

// Report the stop without inviting another automatic fix/review cycle.
// Titles only: the pull request carries the detail.
function notifyParentStalled(worker, prNumber, why, left) {
  const titles = left.map((f) => f.title).join('; ');
  notifyParentLoop(
    worker,
    `the review loop stalled on PR #${prNumber}: ${why}, leaving ${left.length} finding(s) listed on the pull request: ${titles}. Report this stop to the user before spending another round. The fix session owns finding assessment; do not waive findings or restart the loop automatically.`,
  );
}

// A round the loop gave up reading, reported as the stall it is: there are no
// findings to list here — that is the whole problem — so the pull request is
// where the orchestrator reads them.
function notifyParentUnreadRound(worker, prNumber, round, why) {
  notifyParentLoop(
    worker,
    `the review loop stalled on PR #${prNumber}: review round ${round} finished and published its findings, but they could not be read back off the pull request${
      why ? ` (${why})` : ''
    }, so the loop stops rather than holding the round. Read the round on the pull request and judge it by hand: send what applies to the worker with send_to_worker (its push resumes the loop), and waive the rest saying why on the pull request.`,
  );
}

// Worker updates waiting for the orchestrator to be free. An update runs a
// turn on the orchestrator's (usually expensive) model, so it is not fired at
// a session that is mid-turn, has queued user messages, or is standing on a
// question of its own — a user message is what clears awaitingAnswer, and an
// injected turn would be read as the user's answer (the same trap the review
// loop's pendingFix guards). Buffered updates flush as ONE combined turn the
// moment the session settles free, so five workers finishing together cost
// one orchestrator turn, not five. The buffer rides on the record, so a
// restart keeps it; the cap only guards a session left asking for days.
const MAX_PENDING_NOTICES = 30;

// The circuit breaker on unattended spend. Worker turns and injected
// orchestrator turns feed each other (a settle injects a turn, whose
// send_to_worker starts the next worker turn, whose settle injects the
// next), so with nobody watching, the cycle would run — and pay for — itself
// indefinitely. After this many injected turns in a row with no word from
// the user, updates arrive as plain lines instead until the user says
// anything, which resets the count (see sendDevMessage).
const MAX_UNATTENDED_TURNS = 10;

// Injected sends in flight, so sendDevMessage can tell the orchestrator's
// user apart from deliverWorkerNotices: only a genuine user message resets
// the unattended-turn count.
const injectedSends = new Set(); // orchestrator job ids

// One update from a worker to its orchestrator: injected as a turn right away
// when the orchestrator is free, buffered for the next settle otherwise. A
// parent the user closed gets nothing — a worker event must not resurrect it
// — but an interrupted or failed one keeps buffering: its buffer rides the
// record, and reopening it is exactly when those updates are wanted.
function queueWorkerNotice(worker, kind, { text }) {
  if (!worker.parentId) return;
  const parent = jobs.get(worker.parentId);
  if (!parent || parent.kind !== 'devchat' || !parent.orchestrator || parent.status === 'closed') return;
  const pending = parent.pendingWorkerNotices || (parent.pendingWorkerNotices = []);
  if (pending.length >= MAX_PENDING_NOTICES) {
    pushEvent(parent, 'info', {
      text: `Worker ${worker.id}: update dropped, ${pending.length} are already waiting. Check list_workers when this session is free.`,
    });
    save(parent);
    return;
  }
  pending.push({ workerId: worker.id, kind, text });
  save(parent);
  deliverWorkerNotices(parent);
}

// Flush the buffered updates into one orchestrator turn, when the session is
// free to take one. Called when an update arrives and every time the
// orchestrator itself settles idle (its turn ending is what frees it). Not
// on a session the user just stopped: ■ Stop means the next turn is theirs,
// and the buffer waits for that turn's settle. Stale updates are dropped at
// delivery rather than spending a turn on them: a question already answered
// (or a worker closed or deleted meanwhile) is nobody's to act on. The batch
// in flight is stashed on the record so a turn that dies mid-way can give it
// back (see sendDevMessage's catch and restoreFromDb).
export function deliverWorkerNotices(parent) {
  if (!parent.orchestrator) return;
  const pending = parent.pendingWorkerNotices;
  if (!pending || !pending.length) return;
  if (parent.status !== 'idle' || parent.awaitingAnswer || parent.turnCanceled) return;
  if ((devQueues.get(parent.id) || []).length) return;
  const fresh = pending.splice(0).filter((n) => {
    const worker = jobs.get(n.workerId);
    if (!worker || worker.status === 'closed') return false;
    if (n.kind === 'ask') return !!worker.awaitingAnswer;
    // A round already triaged (or a loop turned off with the round on hold)
    // is not waiting for anything.
    if (n.kind === 'triage') return !!(worker.reviewLoop && worker.reviewLoop.triage);
    return true;
  });
  save(parent);
  if (!fresh.length) return;
  const text = fresh.map((n) => n.text).join('\n\n');
  // Past the breaker, the updates go as lines the user reads, not turns the
  // model spends: an orchestrator that ran this long unattended should stop
  // and wait for a human to look at what it did.
  if ((parent.unattendedTurns || 0) >= MAX_UNATTENDED_TURNS) {
    if (!parent.unattendedSaid) {
      parent.unattendedSaid = true;
      pushEvent(parent, 'info', {
        text: `${parent.unattendedTurns} automatic turns ran since your last message, so this session is paused: worker updates arrive as plain lines until you say anything.`,
      });
    }
    pushEvent(parent, 'info', { text });
    save(parent);
    return;
  }
  // Past the budget, the same: an injected turn is spend, and the budget is
  // the user's line in the sand. Said once; the flag clears if the gate ever
  // passes again (the budget was raised in Settings).
  const budget = workerBudget(parent);
  if (budget != null && orchestratorSpend(parent) >= budget) {
    if (!parent.budgetSaid) {
      parent.budgetSaid = true;
      pushEvent(parent, 'info', {
        text: `This orchestration has spent $${orchestratorSpend(parent).toFixed(2)} of its $${budget.toFixed(2)} budget, so it is paused: worker updates arrive as plain lines. Raise the budget in the project's settings to resume.`,
      });
    }
    pushEvent(parent, 'info', { text });
    save(parent);
    return;
  }
  parent.budgetSaid = false;
  parent.unattendedTurns = (parent.unattendedTurns || 0) + 1;
  parent.inFlightWorkerNotices = fresh;
  save(parent);
  injectedSends.add(parent.id);
  try {
    sendDevMessage(parent.id, text);
  } catch (e) {
    // The updates must not vanish with the failed turn: as plain lines the
    // user still sees what happened, and list_workers still has the truth.
    parent.inFlightWorkerNotices = [];
    pushEvent(parent, 'info', { text: `Could not start a turn for these worker updates: ${e.message}` });
    pushEvent(parent, 'info', { text });
    save(parent);
  } finally {
    injectedSends.delete(parent.id);
  }
}

// An orchestrator turn died after its updates were handed to it: what was in
// flight (and anything buffered since) goes to the user as plain lines, so
// nothing is lost and nothing retries a model that just failed.
function dumpWorkerNotices(job, why) {
  if (!job.orchestrator) return;
  const held = [...(job.inFlightWorkerNotices || []), ...(job.pendingWorkerNotices || []).splice(0)];
  job.inFlightWorkerNotices = [];
  if (!held.length) return;
  pushEvent(job, 'info', { text: `${why}, so these worker updates are listed here instead:` });
  pushEvent(job, 'info', { text: held.map((n) => n.text).join('\n\n') });
  save(job);
}

// This orchestrator's workers, newest first, whatever state they are in: a
// closed worker is still worth listing, its branch and pull request outlive
// it.
export function workerSessionsFor(parent) {
  return [...jobs.values()]
    .filter((j) => j.kind === 'devchat' && j.parentId === parent.id)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

// A worker as its orchestrator's tools see it: enough to decide what to do
// next, small enough that a list of them does not crowd the agent's context.
export function workerSummary(job) {
  const pr = job.prStatus;
  const checks = pr && pr.checks;
  return {
    id: job.id,
    title: job.title,
    status: job.status,
    awaitingAnswer: !!job.awaitingAnswer,
    // Which repository the worker is on, and, for a tooling fix, which
    // orchestration it is for: a fix lands on the dashboard's project, not on
    // the one the orchestrator was started on.
    repo: job.repo,
    toolingFor: job.toolingFor || null,
    branch: job.branch || job.startBranch || null,
    provider: job.provider,
    model: job.model,
    effort: job.effort,
    turns: job.turns,
    // With the worker's own reviews, fixes and QA run in it: what the task
    // cost, which is what the budget is spent against.
    costUsd: sessionUsage(job).costUsd,
    lastText: job.lastText || null,
    createdAt: job.createdAt,
    error: job.error || null,
    // Where the worker's review loop stands, when it has one: the supervisor
    // has to know a task is still being reviewed before it calls it done, and
    // the review sessions themselves are not its to read (they publish on the
    // pull request and close).
    reviewLoop: job.reviewLoop
      ? {
          rounds: job.reviewLoop.rounds || 0,
          reviewing: !!job.reviewLoop.reviewing,
          // The round whose review is done and whose findings are still being
          // read off the pull request: the loop is mid-round, not idle, so the
          // supervisor does not read it as a task waiting for a push.
          awaitingResult: !!job.reviewLoop.pendingResult,
          fixing: !!job.reviewLoop.fixing,
          stalled: !!job.reviewLoop.stalled,
          done: !!job.reviewLoop.done,
          // A round that could not run, as opposed to one that ran and found
          // nothing: the supervisor has to be able to tell "nothing approved
          // this push, retry it" from "the loop converged".
          failure: job.reviewLoop.failure
            ? {
                round: job.reviewLoop.failure.round || 0,
                reason: job.reviewLoop.failure.reason || 'no error recorded',
              }
            : null,
          discoveryError: job.reviewLoop.discoveryError || null,
          discoveryRetries: job.reviewLoop.discoveryRetries || 0,
          discoveryRetryPending: branchPrRetryTimers.has(job.id),
          // The round held for the supervisor's verdicts, findings and all:
          // the update that announced it may have been dropped or read as a
          // plain line, and this is where the tool re-reads what to rule on.
          triage: job.reviewLoop.triage
            ? {
                prNumber: job.reviewLoop.triage.prNumber,
                round: job.reviewLoop.triage.round,
                findings: job.reviewLoop.triage.findings.map((f) => ({
                  key: f.key || findingKey(f.title),
                  severity: f.severity || 'medium',
                  title: f.title,
                  file: f.file || null,
                  line: f.line || null,
                  parked: f.parked ? PARK_REASONS[f.parked] || f.parked : null,
                })),
              }
            : null,
        }
      : null,
    // And the QA run queued behind it: running, still waiting for the reviews
    // to converge, or finished with the number of scenarios that failed.
    qaLoop: job.qaLoop
      ? {
          running: !!job.qaLoop.running,
          done: !!job.qaLoop.done,
          failedScenarios: job.qaLoop.failedScenarios ?? 0,
          awaitingVerdict: !!job.qaLoop.pendingVerdict,
          verdictError: job.qaLoop.verdictError || null,
          failure: job.qaLoop.failure
            ? {
                kind: job.qaLoop.failure.kind || 'failed',
                reason: job.qaLoop.failure.reason || 'no error recorded',
              }
            : null,
        }
      : null,
    pr: pr
      ? {
          number: pr.number,
          state: pr.state,
          url: pr.url,
          checks: checks ? `✓${checks.passed} ✗${checks.failed} ●${checks.pending}` : null,
        }
      : null,
  };
}

// One more open worker under this orchestrator, or the reason why not. Spawn
// checks it before creating; the message route checks it before a send that
// would reopen a closed worker, so the cap means what it says either way.
export function assertWorkerSlot(parent) {
  const open = workerSessionsFor(parent).filter((j) => DEV_OPEN.includes(j.status));
  if (open.length >= MAX_OPEN_WORKERS) {
    throw new Error(`Already ${open.length} open workers; close one before starting another`);
  }
}

// What one orchestration has spent so far: the supervisor's own turns plus
// every worker's, live and closed alike (a deleted worker's spend was already
// folded into the parent's), plus what the loops a worker carries spend on its
// behalf — the review sessions of an orchestrator-armed review loop, their fix
// errands and the QA run. A worker's review is work this orchestration
// ordered, so its budget pays for it whether the record has been absorbed yet
// or not; sessionUsage is the rollup. Only priced turns count — a provider
// that reports no cost spends "nothing" here, the same honesty lib/usage.js
// keeps.
export function orchestratorSpend(parent) {
  return sessionUsage(parent).costUsd || 0;
}

// The project's cap on that spend, or null for none.
function workerBudget(parent) {
  const project = getProject(parent.repo);
  return project && project.workerBudgetUsd > 0 ? project.workerBudgetUsd : null;
}

// Both numbers together, for the list_workers tool to lead with.
export function orchestratorBudgetStatus(parent) {
  return { spentUsd: orchestratorSpend(parent), limitUsd: workerBudget(parent) };
}

// Refuses the next spend once the budget is gone. On the agent's own actions
// only (spawning, steering, the injected update turns): the user messaging a
// session directly is the human overriding, and is never gated.
export function assertWorkerBudget(parent) {
  const budget = workerBudget(parent);
  if (budget == null) return;
  const spent = orchestratorSpend(parent);
  if (spent >= budget) {
    throw new Error(
      `This orchestration has spent $${spent.toFixed(2)} of its $${budget.toFixed(2)} budget; report where the work stands and wait — the budget is raised in the project's settings`,
    );
  }
}

// The runtime a worker starts on when the spawn names no provider: what the
// orchestration was started with (the epic dialog's worker pick), then the
// project's worker runtime from Settings, each resolved against the provider
// rows as they stand now, or nothing when neither names one (the
// orchestrator's own entry then). A pick whose provider row was deleted since
// the start falls through to the project's rather than failing every spawn.
function ownWorkerRuntime(parent) {
  return parent.workerRuntime ? resolveRuntime(parent.workerRuntime, getConfig()) : null;
}

// The project is the one the worker runs on, which for a tooling fix is the
// dashboard's, not the orchestrator's.
function projectWorkerRuntime(project) {
  if (!project || project.workerProviderId == null) return null;
  return resolveRuntime(
    { providerId: project.workerProviderId, model: project.workerModel, effort: project.workerEffort },
    getConfig(),
  );
}

function workerRuntime(parent) {
  return ownWorkerRuntime(parent) || projectWorkerRuntime(getProject(parent.repo));
}

// A tooling fix runs on the dashboard's project, so that project's worker
// runtime comes first: it is what its operator set for work on the dashboard.
// The orchestration's own pick is still a cheap entry the user chose for
// workers, so it stands in when the dashboard project names none.
function toolingWorkerRuntime(parent, target) {
  return projectWorkerRuntime(target) || ownWorkerRuntime(parent);
}

// Start a worker under an orchestrator: what the spawn_worker tool (and only
// it) reaches. A spawn that names a provider runs on it exactly as asked; one
// that names nothing runs on the project's worker runtime from Settings, and
// only without one falls back to the orchestrator's own entry (a model the
// picked provider does not offer falls back to that provider's default inside
// createDevSession). The worker inherits nothing else: it is created exactly
// as the composer would create it, so it claims a clone slot and, when the
// project asks for one, a database server, and every cap applies.
//
// `tooling` is the fix_tooling tool: the same spawn, pointed at the project
// flagged as the dashboard itself (Settings → project → "this project is the
// dashboard itself") instead of the orchestrator's own, with the review loop
// armed whatever the call said, because a fix to the tooling is code that
// lands. The brief is framed for the worker (toolingFixBrief): it lands in a
// checkout of the dashboard's repository knowing nothing of the orchestration
// that sent it.
export function spawnWorkerSession(
  parent,
  { title, prompt, providerId, model, effort, branch, reviewLoop, qaLoop, tooling, role } = {},
) {
  if (!parent.orchestrator) throw new Error('Only an orchestrator session can start workers');
  if (!DEV_OPEN.includes(parent.status)) throw new Error('This orchestrator session is not open');
  const text = typeof prompt === 'string' ? prompt.trim() : '';
  if (!text) throw new Error('A worker needs a task brief as its first message');
  tooling = tooling === true;
  const target = tooling ? selfProject() : getProject(parent.repo);
  if (tooling && !target) {
    throw new Error(
      'No enabled project is flagged as the dashboard itself, so there is nowhere to send a tooling fix; tell the user what you found instead',
    );
  }
  assertWorkerSlot(parent);
  assertWorkerBudget(parent);
  // Zeus writes an epic; nothing it starts may land code. Its workers are
  // read-only analysts, and a loop on one would wait forever for a push it
  // never makes, so asking for one is a mistake worth naming to the agent.
  const analyst = !!parent.zeus && !tooling;
  if (analyst && (reviewLoop === true || qaLoop === true)) {
    throw new Error(
      'A Zeus analyst is read-only: it pushes nothing, so there is nothing for a review or QA loop to run on',
    );
  }
  if (analyst && typeof branch === 'string' && branch.trim()) {
    throw new Error('A Zeus analyst reads the default branch; it takes no branch of its own');
  }
  // The role names the runtime the user picked for it when Zeus started; a
  // spawn that names its own provider or model overrides that pick.
  role = typeof role === 'string' && role ? role : null;
  if (role && !analyst) throw new Error('Only a Zeus session starts analysts by role');
  if (role && !ZEUS_ROLES.includes(role)) {
    throw new Error(`Unknown analyst role "${role}"; one of ${ZEUS_ROLES.join(', ')}`);
  }
  const proposal = analyst && role !== 'validator';
  if (proposal && parent.zeusProposalPrompt && text !== parent.zeusProposalPrompt) {
    throw new Error(
      'Fusion models must receive exactly the same prompt; reuse the first proposal prompt verbatim',
    );
  }
  const rolePick =
    role && parent.zeusRoles && parent.zeusRoles[role]
      ? resolveRuntime(parent.zeusRoles[role], getConfig())
      : null;
  // The project's worker runtime steps in only when the spawn names neither a
  // provider nor a model: a model named on its own means "this model", and
  // pairing it with the runtime's provider would silently swap it for that
  // provider's default the moment it fails the list check.
  const configured =
    providerId == null && typeof model !== 'string'
      ? tooling
        ? toolingWorkerRuntime(parent, target)
        : rolePick || workerRuntime(parent)
      : null;
  const session = createDevSession({
    provider: providerId != null ? providerId : configured ? configured.provider.id : parent.providerId,
    model: typeof model === 'string' ? model : configured ? configured.model : parent.model,
    effort: typeof effort === 'string' ? effort : configured ? configured.effort : parent.effort,
    prompt: tooling ? toolingFixBrief(parent, text) : text,
    repo: tooling ? target.repo : parent.repo,
    branch: typeof branch === 'string' ? branch : undefined,
    title: typeof title === 'string' && title.trim() ? title.trim() : undefined,
    // The orchestrator decides per task whether the work gets reviewed: armed
    // here, every push the worker settles with is reviewed and the findings
    // come back to the worker as a fix session, without the user having to
    // reach for the 🔁 chip on each new worker. Those reviews and fixes are
    // sessions of the worker's (loopParentId / loopFixParentId), which is what
    // files them under this orchestration in the sidebar and in its spend.
    reviewLoop: reviewLoop === true || tooling,
    // The test run queued behind that loop, when the task has a surface worth
    // exercising. It refuses without the review loop (createDevSession says
    // so), which reaches the agent as the tool's error.
    qaLoop: qaLoop === true,
    parentId: parent.id,
    toolingFor: tooling ? parent.repo : undefined,
    readOnly: analyst || undefined,
    analystRole: analyst && role ? role : undefined,
  });
  // Persist the shared prompt so subsequent model spawns and retries cannot
  // silently turn the same task into separate specialist assignments.
  if (proposal) parent.zeusProposalPrompt = text;
  // In the orchestrator's own chat too, so the user watching it sees the
  // fan-out as it happens rather than only in the sidebar.
  pushEvent(parent, 'info', {
    text: tooling
      ? `Started tooling-fix worker ${session.id} (${session.title}) on ${session.repo}, ${session.provider} ${session.model}, review loop armed.`
      : analyst
        ? `Started ${role ? `${role} ` : ''}analyst ${session.id} (${session.title}) on ${session.provider} ${session.model}, read-only.`
        : `Started worker ${session.id} (${session.title}) on ${session.provider} ${session.model}.`,
  });
  save(parent);
  return session;
}

// The first message of a tooling-fix worker: the orchestrator's report, framed
// for an agent that wakes up in a checkout of the dashboard's own repository
// and has to know what it is looking at. The running dashboard is the one
// thing it must not touch: the fix lands as a pull request, and the user
// redeploys.
function toolingFixBrief(parent, report) {
  return `This is a tooling fix. The repository you are in is the dashboard that runs coding-agent sessions, \
including the orchestrator on ${parent.repo} that sent you and the workers it supervises: their briefings, the \
worker tools, the review and QA loops and the UI all live here. That orchestrator found a flaw in this tooling \
while doing its work and reported it below. Fix the flaw in this checkout: find where the behaviour lives \
(a prompt, a tool, a loop, a route), change it, verify it the way this repository verifies changes (its tests, \
lint and format check), and open a pull request whose body says what went wrong, what you changed and how you \
verified it. Stay on the flaw described: the orchestrator's own task on ${parent.repo} is not yours, and neither \
is the running dashboard, which keeps its current code until the user redeploys it.

# What the orchestrator reported

${report}`;
}

// Best-effort mirror of the session branch's PR: state (open/closed/merged)
// and its CI check runs. Called after every turn and from a slow interval, so
// a PR the agent opens (or one merged from GitHub later) shows up in the UI
// without a manual refresh. Never throws; GitHub being down just leaves the
// last synced state in place.
// A branch lookup can finish at the same moment as the no-number sync queued
// when a provider turn exits. Keep the in-flight promise, rather than only a
// guard bit, so a caller that has just discovered an exact PR can wait for the
// old no-op and then mirror the number it found instead of losing the
// association forever.
const prSyncInflight = new Map(); // session id -> sync promise

async function syncDevPr(job, number = null, { spotted = false, strict = false } = {}) {
  if (job.kind !== 'devchat') return;
  const prior = prSyncInflight.get(job.id);
  if (prior) {
    await prior;
    // A no-number refresh only needed to wait for the current sync. An
    // explicit PR number still needs another pass when that sync did not
    // mirror it (the common case is a turn-end refresh with no PR yet).
    if (number == null || (job.prStatus && job.prStatus.number === number)) return job.prStatus || null;
  }
  const current = syncDevPrNow(job, number, { spotted, strict });
  prSyncInflight.set(job.id, current);
  try {
    return await current;
  } finally {
    if (prSyncInflight.get(job.id) === current) prSyncInflight.delete(job.id);
  }
}

async function syncDevPrNow(job, number = null, { spotted = false, strict = false } = {}) {
  if (job.kind !== 'devchat') return;
  const cfg = getConfig();
  if (!cfg.githubToken) {
    if (strict) throw new Error('No GitHub token is configured, so the pull request cannot be linked');
    return null;
  }
  try {
    // Which PR to mirror: the number just spotted in the stream, or the one
    // already known. No branch-based guessing: a lookup by head branch can
    // latch onto an unrelated PR (e.g. a local session on master matching any
    // old PR opened from master).
    number = number ?? (job.prStatus ? job.prStatus.number : null) ?? job.startedOnPr ?? null;
    if (number == null) return;
    // The single-PR endpoint, not the list one: it is the only one that
    // carries the overview numbers (additions/deletions/changed files).
    const pres = await githubRest(cfg, 'GET', `/repos/${job.repo}/pulls/${number}`);
    if (!pres.ok) {
      if (strict) throw new Error(`GitHub returned ${pres.status || 'an error'} reading PR #${number}`);
      return null;
    }
    const pr = await pres.json();
    // A number picked out of the stream has to earn the attachment: the pull
    // request must use the branch this session works on. Anything
    // else is a PR the agent merely read (another session's, an older one it
    // was told to look at), and mirroring it would put the wrong title,
    // checks and linked issue in the panel for the rest of the session.
    const head = (pr.head && pr.head.ref) || null;
    if (spotted && !spottedPrIsThisSession(job, head)) {
      spotRejected.add(`${job.id}:${pr.number}`);
      const message = `PR #${pr.number} is on branch ${head || 'unknown'}, not this session's ${job.prBranch || job.branch || 'branch'}: mentioned, not attached.`;
      pushEvent(job, 'info', { text: message });
      if (strict) throw new Error(message);
      return null;
    }
    const status = {
      number: pr.number,
      url: pr.html_url,
      title: pr.title,
      state: pr.merged_at ? 'merged' : pr.state,
      draft: !!pr.draft,
      headSha: pr.head && pr.head.sha,
      headRef: pr.head && pr.head.ref,
      baseRef: pr.base && pr.base.ref,
      additions: pr.additions,
      deletions: pr.deletions,
      changedFiles: pr.changed_files,
      commits: pr.commits,
      commitList: job.prStatus ? job.prStatus.commitList : null,
      checks: job.prStatus ? job.prStatus.checks : null,
      issues: job.prStatus ? job.prStatus.issues : null,
      reviews: job.prStatus ? job.prStatus.reviews : null,
      syncedAt: now(),
    };
    // The PR's review verdicts, one per reviewer. This is where a published
    // code review lands, so the panel can show whether codex (or whichever
    // entry reviewed) approved the change. Chronological fold: a real verdict
    // replaces anything earlier from the same reviewer, a plain comment never
    // overrides one (GitHub keeps an approval standing when the reviewer later
    // just comments), and a dismissal clears the standing verdict: GitHub no
    // longer counts a review once it is dismissed.
    try {
      const rres = await githubRest(cfg, 'GET', `/repos/${job.repo}/pulls/${number}/reviews?per_page=100`);
      if (rres.ok) {
        const latest = new Map(); // login -> { user, state, url }
        for (const r of await rres.json()) {
          const state = String(r.state || '').toLowerCase();
          if (!r.user || state === 'pending') continue;
          const verdict = state === 'approved' || state === 'changes_requested';
          const cur = latest.get(r.user.login);
          if (
            cur &&
            !verdict &&
            state !== 'dismissed' &&
            (cur.state === 'approved' || cur.state === 'changes_requested')
          )
            continue;
          latest.set(r.user.login, {
            user: r.user.login,
            state: verdict ? state : 'commented',
            url: r.html_url || null,
          });
        }
        status.reviews = [...latest.values()];
      }
    } catch {
      /* best-effort, like the rest of the sync */
    }
    // The PR's commits, for the panel's collapsible list: first message line,
    // short sha and a link each. A failure keeps the last synced list.
    try {
      const commitsRes = await githubRest(
        cfg,
        'GET',
        `/repos/${job.repo}/pulls/${number}/commits?per_page=100`,
      );
      if (commitsRes.ok) {
        status.commitList = (await commitsRes.json()).map((c) => ({
          sha: c.sha,
          message: String((c.commit && c.commit.message) || '')
            .split('\n')[0]
            .slice(0, 140),
          url: c.html_url,
        }));
      }
    } catch {
      /* best-effort, like the rest of the sync */
    }
    // The issues this PR closes: its "Development" links on GitHub. Only the
    // GraphQL API exposes them; a failure just keeps the last synced list,
    // same as checks.
    try {
      const [owner, name] = job.repo.split('/');
      const data = await githubGraphql(
        cfg,
        `
        query($owner: String!, $name: String!, $number: Int!) {
          repository(owner: $owner, name: $name) {
            pullRequest(number: $number) {
              closingIssuesReferences(first: 10) { nodes { number title state url } }
            }
          }
        }`,
        { owner, name, number },
      );
      const nodes = data?.repository?.pullRequest?.closingIssuesReferences?.nodes || [];
      status.issues = nodes.map((i) => ({
        number: i.number,
        title: i.title,
        state: String(i.state || '').toLowerCase(),
        url: i.url,
      }));
    } catch {
      /* best-effort, like the rest of the sync */
    }
    if (status.headSha) {
      const cres = await githubRest(
        cfg,
        'GET',
        `/repos/${job.repo}/commits/${status.headSha}/check-runs?per_page=100`,
      );
      if (cres.ok) {
        const runs = ((await cres.json()).check_runs || []).map((r) => ({
          name: r.name,
          status: r.status,
          conclusion: r.conclusion,
          url: r.html_url,
        }));
        status.checks = {
          total: runs.length,
          passed: runs.filter((r) => r.conclusion === 'success').length,
          failed: runs.filter((r) => ['failure', 'timed_out', 'action_required'].includes(r.conclusion))
            .length,
          pending: runs.filter((r) => r.status !== 'completed').length,
          runs,
        };
      }
    }
    const before = job.prStatus;
    job.prStatus = status;
    if (!before || before.state !== status.state) {
      pushEvent(job, 'info', { text: `PR #${status.number} is ${status.state}: ${status.url}` });
    }
    bus.emit('job', publicJob(job));
    save(job);
    dirtyJobs.add(job.id);
    scheduleFlush();
    // The merge is the end of every errand on this pull request, including
    // this session's own.
    if (status.state === 'merged' && (!before || before.state !== 'merged')) {
      closePrSessions(job.repo, status.number, `PR #${status.number} was merged`).catch(() => {});
    }
    // The CI run reaching a verdict, handed to the orchestrator as a turn (see
    // notifyParentChecks; quiet for every session without one). Only a rollup
    // this session watched move: either it was pending on the sha before, or
    // the head moved under it, which is a push it saw land. The first sync of
    // a pull request says nothing — a fresh attach and the first tick after a
    // restart both find a finished run that nobody is waiting on any more.
    const rollup = status.checks;
    const settled = rollup && rollup.total > 0 && rollup.pending === 0;
    const watched =
      before && (before.headSha !== status.headSha || !!(before.checks && before.checks.pending));
    if (settled && watched && status.state === 'open') notifyParentChecks(job, status);
    // The PR often attaches moments after the turn that opened it ended: the
    // idle-settle check ran before this sync landed, so an armed session gets
    // another look now that there is a pull request to review. Harmless on
    // every other sync: the loop's own gates decide.
    if (!before && job.status === 'idle') maybeStartLoopReview(job).catch(() => {});
    return status;
  } catch (e) {
    if (strict) throw e;
    /* best-effort: rate limits and outages must not touch the session */
    return null;
  }
}

// A PR the automatic paths missed can be handed to a session explicitly. A
// number is not trusted on its own: the exact PR is read from this session's
// repository and must use the branch the session represents. Keeping
// startedOnPr records that this was an explicit association (unlike branch
// discovery), including after a restart.
function manualPrNumber(job, reference) {
  if (Number.isSafeInteger(reference) && reference > 0) return reference;
  const text = typeof reference === 'string' ? reference.trim() : '';
  const short = text.match(/^#?(\d+)$/);
  if (short) {
    const number = Number(short[1]);
    if (Number.isSafeInteger(number) && number > 0) return number;
    throw new Error('The pull request number must be a positive whole number');
  }
  const url = text.match(/^https?:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)\/?(?:[?#].*)?$/i);
  if (!url) throw new Error('Enter a pull request number, #number, or GitHub pull request URL');
  if (url[1].toLowerCase() !== String(job.repo || '').toLowerCase()) {
    throw new Error(`That pull request belongs to ${url[1]}, not ${job.repo}`);
  }
  const number = Number(url[2]);
  if (!Number.isSafeInteger(number) || number < 1) {
    throw new Error('The pull request number must be a positive whole number');
  }
  return number;
}

export async function linkPrToSession(id, reference) {
  const job = jobs.get(id);
  if (!job || job.kind !== 'devchat') throw new Error('Session not found');
  if (job.orchestrator) throw new Error('An orchestrator has no pull request of its own');
  // A closed session no longer owns its remembered workspace slot; another
  // session may already have checked out a different branch there.
  if (DEV_OPEN.includes(job.status)) refreshJobBranch(job);
  if (!job.branch && !job.prBranch) throw new Error('This session has no branch to match to a pull request');
  const number = manualPrNumber(job, reference);
  const known = sessionPrNumber(job);
  if (known) {
    if (known !== number) throw new Error(`This session is already linked to PR #${known}`);
    if (job.prStatus?.number === number) return publicJob(job);
  }

  // Make the explicit association visible to closePrSessions while the sync
  // runs: a manual link to an already-merged PR should close the session just
  // like a session started from that PR. Roll it back if validation fails.
  const previousStartedOnPr = job.startedOnPr || null;
  job.startedOnPr = number;
  try {
    const status = await syncDevPr(job, number, { spotted: true, strict: true });
    if (!status || status.number !== number) throw new Error(`Could not link PR #${number}`);
  } catch (e) {
    job.startedOnPr = previousStartedOnPr;
    throw e;
  }
  job.prAttachedByBranch = false;
  pushEvent(job, 'info', { text: `Linked this session to PR #${number} by hand.` });
  bus.emit('job', publicJob(job));
  save(job);
  return publicJob(job);
}

// The pull request a session's own branch is open from, looked up by head ref
// and attached. syncDevPr deliberately guesses nothing: it mirrors a number
// somebody handed it or one the agent quoted. But a session that checked out
// an existing branch has nothing to guess about: that branch is the tree it
// works in, and the only pull request that can be its own is the one open from
// exactly it.
//
// Without this a session continuing work on a branch whose pull request is
// already open never attaches it, because the URL spotPrUrl watches for never
// appears: an agent reads the PR with `gh pr view 51` and reports back "pushed
// to dev-x (PR #51)": a number, not a link. The panel then shows no pull
// request, and the review loop waits for one that has been open all along.
//
// Never for a local session, and never on the default branch: there a branch is
// nobody's in particular, and the match would be somebody else's pull request.
//
// Asking is throttled, because the sync tick asks on behalf of every session
// that has no pull request yet and a session can spend an hour without opening
// one: a branch that answered "none" is left alone for BRANCH_PR_COOLDOWN_MS,
// and one lookup at a time per session, so a GitHub slower than the tick does
// not have two ticks asking the same question at once. The moment a lookup can
// actually be worth more (a turn that just ended, which is when an agent
// opens its pull request) asks with { fresh: true } and skips the cooldown.
const branchPrLookups = new Set(); // session ids inside a lookup right now
const branchPrColdUntil = new Map(); // session id -> when its branch is worth asking about again
const branchPrSaid = new Set(); // session ids already told why nothing was attached
const branchPrRetryTimers = new Map(); // session ids with a bounded idle retry pending
const BRANCH_PR_COOLDOWN_MS = 5 * 60_000;
const BRANCH_PR_RETRY_MS = [5_000, 15_000, 60_000];

// GraphQL has a rate budget apart from REST's core budget. Keep the fallback
// deliberately narrow: a missing token scope is not made better by a second
// API, while a spent core budget (or a REST 5xx) can still leave this exact
// lookup available through GraphQL.
function canFallbackPrDiscovery(error) {
  return !!error?.rateLimited || (Number(error?.status) >= 500 && Number(error?.status) < 600);
}

async function openPrsViaGraphql(cfg, repo, branch) {
  const [owner, name] = repo.split('/');
  const data = await githubGraphql(
    cfg,
    `
      query($owner: String!, $name: String!, $head: String!) {
        repository(owner: $owner, name: $name) {
          pullRequests(states: [OPEN], headRefName: $head, first: 10) {
            nodes { number baseRefName headRepository { nameWithOwner } }
          }
        }
      }`,
    { owner, name, head: branch },
  );
  // GraphQL names the base ref `baseRefName`, REST nests it under `base.ref`.
  // The fallback answers in REST's shape so the caller cannot tell which API
  // its list came from.
  return (data?.repository?.pullRequests?.nodes || [])
    .filter((pr) => pr.headRepository?.nameWithOwner === repo)
    .map((pr) => ({ number: pr.number, base: { ref: pr.baseRefName } }));
}

async function openPrsForBranch(cfg, job, owner, branch) {
  let res;
  try {
    res = await githubRest(
      cfg,
      'GET',
      `/repos/${job.repo}/pulls?state=open&per_page=10&head=${owner}:${encodeURIComponent(branch)}`,
    );
  } catch (e) {
    if (!canFallbackPrDiscovery(e)) throw e;
    try {
      return await openPrsViaGraphql(cfg, job.repo, branch);
    } catch (fallbackError) {
      if (e.rateLimited && Number.isFinite(Number(e.retryAt))) {
        fallbackError.rateLimited = true;
        fallbackError.retryAt = e.retryAt;
      }
      throw fallbackError;
    }
  }
  if (res.ok) return (await res.json()) || [];
  if (res.status >= 500 && res.status < 600) {
    return openPrsViaGraphql(cfg, job.repo, branch);
  }
  const error = new Error(`GitHub returned ${res.status || 'an error'}`);
  error.status = res.status;
  throw error;
}

function retryLoopPrDiscovery(job, failure = null) {
  const loop = job.reviewLoop;
  if (!loop) return;
  if (!Number.isFinite(loop.discoveryRetries)) loop.discoveryRetries = 0;
  if (branchPrRetryTimers.has(job.id)) return;
  // githubRest knows the primary-limit reset from GitHub's headers. Its
  // ordinary short retries cannot get past an hourly core limit, and after
  // those retries were spent an idle worker never made another discovery
  // attempt until somebody sent it a message. Keep the loop armed through the
  // reset instead: a PR the worker just reported remains the next thing to
  // review, not a task that silently needs a human nudge.
  const resetAt = failure && failure.rateLimited && Number(failure.retryAt);
  const delayToReset = resetAt && resetAt > Date.now() ? resetAt - Date.now() : null;
  if (delayToReset == null && loop.discoveryRetries >= BRANCH_PR_RETRY_MS.length) return;
  const delay = delayToReset == null ? BRANCH_PR_RETRY_MS[loop.discoveryRetries++] : delayToReset;
  const timer = setTimeout(() => {
    branchPrRetryTimers.delete(job.id);
    maybeStartLoopReview(job, { fresh: true }).catch(() => {});
  }, delay);
  timer.unref?.();
  branchPrRetryTimers.set(job.id, timer);
}

export async function attachPrForBranch(job, { fresh = false } = {}) {
  if (job.kind !== 'devchat' || job.local || job.orchestrator) return null;
  const known = sessionPrNumber(job);
  if (known) return known;
  const branch = job.branch;
  if (!branch || !job.repo || branch === job.baseBranch) return null;
  const cfg = getConfig();
  if (!cfg.githubToken) return null;
  if (branchPrLookups.has(job.id)) return null;
  if (!fresh && Date.now() < (branchPrColdUntil.get(job.id) || 0)) return null;
  branchPrLookups.add(job.id);
  try {
    const owner = job.repo.split('/')[0];
    const open = await openPrsForBranch(cfg, job, owner, branch);
    if (job.reviewLoop) {
      job.reviewLoop.discoveryError = null;
      job.reviewLoop.discoveryErrorSaid = false;
      job.reviewLoop.discoveryRetries = 0;
      const retry = branchPrRetryTimers.get(job.id);
      if (retry) clearTimeout(retry);
      branchPrRetryTimers.delete(job.id);
    }
    // GitHub allows more than one pull request open from the same head ref, as
    // long as their bases differ: dev-x → main and dev-x → release/1.0 can
    // both be out at once. One is this session's whatever it targets; between
    // several, the one that targets the branch this workspace was cut from is
    // the session's own, and anything still ambiguous is left alone rather than
    // guessed at, since attaching the wrong one would publish the loop's findings on
    // somebody else's release.
    const onBase = open.filter((p) => p.base && p.base.ref === job.baseBranch);
    const pr = open.length === 1 ? open[0] : onBase.length === 1 ? onBase[0] : null;
    if (!pr) {
      branchPrColdUntil.set(job.id, Date.now() + BRANCH_PR_COOLDOWN_MS);
      // Said once per session: silence here is what made the review loop wait
      // on a pull request nobody could see it was missing.
      if (open.length > 1 && !branchPrSaid.has(job.id)) {
        branchPrSaid.add(job.id);
        pushEvent(job, 'info', {
          text: `${open.map((p) => `#${p.number}`).join(', ')} are all open from ${branch}, so none is attached to this session, since which one it is about cannot be told apart. Work on it from the pull request board to say which.`,
        });
        save(job);
      }
      return null;
    }
    branchPrColdUntil.delete(job.id);
    // Raced by another path in the meantime (a URL in the stream, a webhook):
    // that attachment is as good as this one, and syncDevPr would only be
    // fetching the same pull request twice.
    const raced = sessionPrNumber(job);
    if (raced) return raced;
    // Nobody pointed this session at this pull request; it was found from the
    // branch, and closePrSessions treats that as too thin a claim to end the
    // session on when the pull request merges. An errand is pointed at one by
    // definition (a review reviews it, a QA run tests it, and both hold a clone
    // and a database server for work the merge just made pointless), so those
    // are marked as handed the pull request even when it took a lookup to find.
    if (!job.reviewBranch && !job.qaBranch && !job.autoClose) job.prAttachedByBranch = true;
    // The number is answered whether or not the mirror latched: a sync already
    // in flight makes syncDevPr a no-op, and the caller should not have to wait
    // a tick for a pull request this call has just confirmed is open from the
    // session's own branch. The panel catches up on the next sync.
    await syncDevPr(job, pr.number);
    return pr.number;
  } catch (e) {
    if (job.reviewLoop) {
      job.reviewLoop.discoveryError = e.message || 'GitHub lookup failed';
      job.reviewLoop.discoveryErrorSaid = false;
      save(job);
      retryLoopPrDiscovery(job, e);
    }
    return null;
  } finally {
    branchPrLookups.delete(job.id);
  }
}

// Keeps sessions' PR state fresh while nobody is chatting: any session that
// already knows its PR, while the session is open or the PR still has news
// coming (open, or checks running, so a merge done from GitHub after the
// session closes still lands in the sidebar).
function syncDevPrs() {
  for (const job of jobs.values()) {
    if (job.kind !== 'devchat') continue;
    // A completed QA run may still be waiting for its test-sheet verdict.
    // This persisted read resumes while idle and after a process restart: a
    // restart marks the session `interrupted`, not `closed`, and the read
    // needs none of its resources back to retry, so it is driven here as long
    // as the session is not retired for good.
    if (job.qaLoop?.pendingVerdict && !isRetired(job.status)) {
      resolveQaVerdict(job).catch(() => {});
    }
    // A finished review round whose findings could not be read off the pull
    // request yet, retried on the tick rather than waiting for the session's
    // next turn: an idle worker whose review converged has no next turn, and
    // that round is the whole answer its orchestrator is waiting for. The
    // cooldown between two real attempts, and the deadline the retries stop
    // at, are resolveLoopRound's own. Same as above: driven for as long as the
    // session is not retired, a restart's `interrupted` included, so a backoff
    // outlasting the process that started it still gets picked back up.
    if (job.reviewLoop && job.reviewLoop.pendingResult && !isRetired(job.status)) {
      resolveLoopRound(job).catch(() => {});
    }
    // A session with no pull request mirrored yet: ask which one its branch is
    // open from. The attach at checkout is one attempt and swallows a GitHub
    // that was down, and a pull request may be opened minutes after the
    // checkout, and without this the panel would show none for the whole life of
    // the session. attachPrForBranch holds the cooldown that keeps this to one
    // request every few minutes, and the sync it runs on a hit is what starts
    // an armed session's first round (see the maybeStartLoopReview call at the
    // end of syncDevPr), so a loop that settled before its pull request existed
    // does not wait for another turn either.
    if (!job.prStatus) {
      if (job.status === 'idle' && !job.local) attachPrForBranch(job).catch(() => {});
      continue;
    }
    const watch =
      DEV_OPEN.includes(job.status) ||
      job.prStatus.state === 'open' ||
      (job.prStatus.checks && job.prStatus.checks.pending > 0);
    if (!watch) continue;
    // A turn in flight is when the PR moves most (a push lands, checks start,
    // a review gets posted), so a running session is re-synced on every tick.
    // The rest keep the slower minute cadence they had.
    const age = Date.now() - Date.parse(job.prStatus.syncedAt || 0);
    if (ACTIVE.includes(job.status) || !(age < 55_000)) syncDevPr(job).catch(() => {});
  }
}

// GitHub just told us something moved on this branch (or this pull request):
// a review posted, a check finished, a commit pushed, the thing merged. The
// tick above would find it within the minute; this makes the panel redraw as
// the event lands instead. Matching is by branch when the event names one and
// by pull request number when it does not (an issue comment names no branch).
//
// Fire and forget, deliberately: a webhook delivery must be answered in
// milliseconds, and a sync that fails is one the tick will retry anyway.
export function syncSessionsOn(repo, branch = null, prNumber = null) {
  if (!repo || (!branch && !prNumber)) return 0;
  const wanted = String(repo).toLowerCase();
  let nudged = 0;
  for (const job of jobs.values()) {
    if (job.kind !== 'devchat') continue;
    if (String(job.repo || '').toLowerCase() !== wanted) continue;
    const byBranch = branch && (job.branch === branch || job.prBranch === branch);
    const byNumber = prNumber && job.prStatus && job.prStatus.number === Number(prNumber);
    if (!byBranch && !byNumber) continue;
    nudged++;
    // A branch event can be the first notice of a PR opened during the turn.
    // syncDevPr deliberately refuses to guess a number, so discover the PR
    // from the exact head ref when this session has not attached one yet.
    if (byBranch && !job.prStatus && !sessionPrNumber(job)) {
      attachPrForBranch(job, { fresh: true }).catch(() => {});
    } else {
      syncDevPr(job, byNumber ? Number(prNumber) : null).catch(() => {});
    }
  }
  return nudged;
}

// Where an orchestrator session runs its CLI: a scratch dir of its own under
// the workspace root, stable across turns and reopens because claude, grok and
// opencode scope their conversation state to the working directory. It is not
// a clone slot (no `__` in the name, so lib/workspaces.js never lists it) and
// never enters busyClones: ids are unique, so nothing contends for it.
function orchestratorDir(job) {
  return path.join(getConfig().workspaceDir, 'orchestrators', job.id);
}

// An orchestrator's whole preparation: make the scratch dir exist. No clone,
// no .env, no setup steps; the agent is told not to edit code here at all.
async function prepareOrchestratorWorkspace(job) {
  fs.mkdirSync(job.workDir, { recursive: true });
  job.branch = null;
  job.baseBranch = null;
  if (job.zeus) {
    pushEvent(job, 'info', {
      text: `Zeus session for ${job.repo}: a read-only clone of the default branch to investigate, and analyst sessions to compare against.`,
    });
    await ensureZeusClone(job);
  } else {
    pushEvent(job, 'info', {
      text: `Orchestrator session for ${job.repo}: no checkout of its own; it starts and steers worker sessions instead.`,
    });
  }
  save(job);
}

// Where a Zeus session reads the code: a shallow clone of the default branch
// beside its scratch dir, outside the workspace pool. A pool slot would cost
// a claim, a database server and the setup steps for a tree nobody builds or
// runs; a full-text shallow clone is what grep-driven investigation wants,
// and a blobless one would fetch every file it opens one round trip at a
// time. The clone is thrown away on close (closeDevSession) and made again on
// reopen, always at the branch's current tip.
function zeusCloneDir(job) {
  return path.join(job.workDir, 'repo');
}

async function ensureZeusClone(job) {
  const dir = zeusCloneDir(job);
  const url = `https://github.com/${job.repo}.git`;
  if (fs.existsSync(path.join(dir, '.git'))) {
    try {
      await runCmd(job, 'git', ['-C', dir, 'fetch', '--depth', '1', 'origin']);
      await runCmd(job, 'git', ['-C', dir, 'reset', '--hard', '@{upstream}']);
      return;
    } catch {
      pushEvent(job, 'info', { text: 'Existing read-only clone could not be refreshed; recloning…' });
    }
  }
  fs.rmSync(dir, { recursive: true, force: true });
  pushEvent(job, 'info', { text: `Cloning ${job.repo} (shallow, default branch, read-only)…` });
  await runCmd(job, 'git', ['clone', '--depth', '1', '--single-branch', '--progress', url, dir]);
}

// Local mode's preparation: nothing but an optional branch switch. The tree,
// its .env and its database belong to the developer and are used as they
// stand: a picked branch is a plain checkout (never -f, never clean), so git
// refuses it over conflicting uncommitted changes instead of eating them.
async function prepareLocalWorkspace(job) {
  const dir = job.workDir;
  if (!fs.existsSync(path.join(dir, '.git'))) throw new Error(`${dir} is not a git checkout`);
  const headBranch = () => {
    const probe = spawnSync('git', ['-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' });
    return (probe.stdout || '').trim() || null;
  };
  const want = job.startBranch || null;
  if (want && want !== headBranch()) {
    pushEvent(job, 'info', { text: `Switching the local checkout to branch ${want}…` });
    // Best effort: a branch that only exists locally still checks out when
    // the fetch cannot find it on origin.
    try {
      await runCmd(job, 'git', ['-C', dir, 'fetch', '--no-tags', 'origin', want]);
    } catch {
      /* offline or a purely local branch: checkout decides */
    }
    await runCmd(job, 'git', ['-C', dir, 'checkout', want]);
  }
  job.branch = headBranch();
  job.baseBranch = null;
  pushEvent(job, 'info', {
    text: `Working directly in the local checkout ${dir}${job.branch ? ` on branch ${job.branch}` : ''}. No clone, no setup steps, no pooled database.`,
  });
  save(job);
}

// The session's checkout: the repo's default branch on a work branch of its
// own, dependencies installed: the same prep a review gets, minus the PR.
async function prepareDevWorkspace(job) {
  if (job.orchestrator) return prepareOrchestratorWorkspace(job);
  if (job.local) return prepareLocalWorkspace(job);
  const dir = job.workDir;
  await ensureClone(job, dir, job.repo);
  const probe = spawnSync(
    'git',
    ['-C', dir, 'ls-remote', '--symref', 'origin', 'HEAD'],
    workspaceGitProbeOptions(job),
  );
  const base = ((probe.stdout || '').match(/ref:\s+refs\/heads\/(\S+)\s+HEAD/) || [])[1] || 'master';
  // A session that picked a branch (including every review session) works on
  // that existing branch; one that did not gets a fresh branch of its own off
  // the default branch. The base is fetched either way, so a review can diff
  // against it. reviewBranch is the fallback for sessions created before the
  // branch picker existed.
  const plan = workspaceBranchPlan(job, base);
  const start = workspaceStartBranch(job);
  const remoteProbe = start
    ? spawnSync(
        'git',
        ['-C', dir, 'ls-remote', '--exit-code', 'origin', `refs/heads/${start}`],
        workspaceGitProbeOptions(job),
      )
    : null;
  const localProbe = start
    ? spawnSync(
        'git',
        ['-C', dir, 'show-ref', '--verify', '--quiet', `refs/heads/${start}`],
        workspaceGitProbeOptions(job),
      )
    : null;
  const checkout = workspaceCheckoutPlan(job, base, {
    remoteWorkerRef: !!remoteProbe && remoteProbe.status === 0,
    localBranch: !!localProbe && localProbe.status === 0,
  });
  job.branch = plan.branch;
  job.baseBranch = base;
  pushEvent(job, 'info', { text: `Fetching ${base} and checking out ${job.branch}…` });
  const refspecs = [...new Set([base, ...(checkout.source === 'remote' ? [plan.startPoint] : [])])].map(
    (b) => `+refs/heads/${b}:refs/remotes/origin/${b}`,
  );
  const fetchRefs = () =>
    runCmd(job, 'git', ['-C', dir, 'fetch', '--progress', '--no-tags', 'origin', ...refspecs]);
  await fetchWithWorkspaceRecovery({
    dir,
    fetchRefs,
    onRepair: (refs) =>
      pushEvent(job, 'info', {
        text: `Removed ${refs.length === 1 ? 'an invalid remote-tracking ref' : `${refs.length} invalid remote-tracking refs`} (${refs.join(', ')}) from this workspace slot and retrying the fetch. Local branches and working files were left untouched.`,
      }),
    onQuarantine: ({ objects, quarantineDir }) =>
      pushEvent(job, 'info', {
        text: `Quarantined ${objects.length} empty loose Git ${objects.length === 1 ? 'object' : 'objects'} under ${quarantineDir} and retrying the fetch. The corrupt files were preserved; local branches, working files and valid objects were left untouched.`,
      }),
  });
  await runCmd(job, 'git', [
    '-C',
    dir,
    'symbolic-ref',
    'refs/remotes/origin/HEAD',
    `refs/remotes/origin/${base}`,
  ]);
  if (checkout.source === 'local') {
    await runCmd(job, 'git', ['-C', dir, 'checkout', '--progress', checkout.checkoutRef]);
  } else {
    await runCmd(job, 'git', [
      '-C',
      dir,
      'checkout',
      '--progress',
      '-f',
      '-B',
      job.branch,
      checkout.checkoutRef,
    ]);
  }
  await runCmd(job, 'git', ['-C', dir, 'clean', '-fd']);
  // A picked branch usually already has a pull request (that is what "continue
  // this work" means), so it is attached now rather than waiting for the agent
  // to quote its URL back, which it may never do. Fire and forget: the setup
  // steps below are the slow part and a GitHub hiccup must not hold them up.
  if (start) attachPrForBranch(job).catch(() => {});
  seedCheckoutEnv(job, dir, job.repo);
  await runSetupCommands(job, dir, job.repo);
  save(job);
}

// How every provider asks the user something. claude has AskUserQuestion of its
// own and the stream parser turns that into the same question card, but the
// others have nothing to ask with headless, and a question buried in a
// paragraph is one the user has to answer by retyping it. The block below is
// lifted out of the reply (parseAskBlocks) and rendered with its answers as
// buttons.
// ---------------------------------------------------------------------------
// The memory tool's credentials. Each session gets a bearer token of its own,
// minted in this process and never stored: the tool runs as a child of the
// turn and reads it from the environment, and a restart simply mints new ones
// for the next turns. The token names the session, and the session names the
// project: that is the whole authorization the agent routes need.
// ---------------------------------------------------------------------------

const agentTokens = new Map(); // job id -> token
let agentApiBase = '';

// Where the tool phones home. Set once the server knows the port it listens
// on (--port may have overridden .env).
export function setAgentApiBase(url) {
  agentApiBase = String(url || '').replace(/\/+$/, '');
}

function agentTokenFor(job) {
  let token = agentTokens.get(job.id);
  if (!token) {
    token = crypto.randomBytes(24).toString('hex');
    agentTokens.set(job.id, token);
  }
  return token;
}

// The session a bearer token stands for, or null: only a session that still
// exists in this process can write memories, and only to its own project.
export function jobForAgentToken(token) {
  if (!token) return null;
  for (const [id, t] of agentTokens) {
    if (t === token) return jobs.get(id) || null;
  }
  return null;
}

function memoryEnv(job) {
  return { REVIEWER_MEMORY_URL: agentApiBase, REVIEWER_MEMORY_TOKEN: agentTokenFor(job) };
}

const MEMORY_MCP_SCRIPT = path.join(path.dirname(new URL(import.meta.url).pathname), 'memory-mcp.js');
const WORKERS_MCP_SCRIPT = path.join(path.dirname(new URL(import.meta.url).pathname), 'orchestrator-mcp.js');

// The memory tool as an MCP server entry, for the CLIs that take one.
function memoryMcpServer(job) {
  return {
    name: 'reviewer_memory',
    command: process.execPath,
    args: [MEMORY_MCP_SCRIPT],
    env: memoryEnv(job),
  };
}

// Every MCP server a turn mounts. The memory tool goes to every session; the
// worker tools only to an orchestrator, whose token is also the only one the
// /api/agent/sessions routes accept, so a worker never gets a spawn tool it
// could only be refused on.
function mcpServersFor(job) {
  const servers = [memoryMcpServer(job)];
  if (job.orchestrator) {
    servers.push({
      name: 'reviewer_workers',
      command: process.execPath,
      args: [WORKERS_MCP_SCRIPT],
      // The same base URL and per-session token as the memory tool: the token
      // names the session, and the routes decide what it may do.
      env: memoryEnv(job),
    });
  }
  return servers;
}

// The memory section of the briefing: what is already known about the project
// and how to add to it. The tool is described for the CLIs that mount it, the
// HTTP route for the ones that do not (grok, opencode); the same two variables
// carry both.
function memoryProtocol(job) {
  const known = memoryBriefing(job.repo);
  return `

# Project memory

The dashboard keeps a memory per project (facts about the user, feedback on how to work, project context that \
is not in the code, and pointers to external resources) and hands it to every session on ${job.repo}. Save a \
memory when you learn something a future session on this project should know; do not save what the repository \
already records (code structure, git history, CLAUDE.md) or what only matters to this conversation. Each memory \
has a kebab-case name, a type (user | feedback | project | reference), a one-line description and a body; for \
feedback and project memories, say why and how to apply it. Saving an existing name replaces it.

If you have the memory_save / memory_list / memory_read / memory_delete tools, use them. Otherwise the same \
memory is reachable over HTTP with the REVIEWER_MEMORY_URL and REVIEWER_MEMORY_TOKEN environment variables:

    curl -sS -X POST "$REVIEWER_MEMORY_URL/api/agent/memories" -H "Authorization: Bearer $REVIEWER_MEMORY_TOKEN" \
      -H 'Content-Type: application/json' -d '{"name":"prefers-small-prs","type":"feedback","description":"…","body":"…"}'
    curl -sS "$REVIEWER_MEMORY_URL/api/agent/memories" -H "Authorization: Bearer $REVIEWER_MEMORY_TOKEN"
    curl -sS -X DELETE "$REVIEWER_MEMORY_URL/api/agent/memories/<name>" -H "Authorization: Bearer $REVIEWER_MEMORY_TOKEN"

${known ? `## What is remembered about ${job.repo}\n\n${known}` : `Nothing is remembered about ${job.repo} yet.`}`;
}

const ASK_PROTOCOL = `

When a decision is genuinely the user's to make, ask them instead of guessing: end your turn with a block of this shape and stop there:

<ask-user>
The question, on one line.
- First answer
- Second answer
</ask-user>

The dashboard renders it as a question with those answers as buttons, and the pick comes back as your next message. Leave the bullets out for an open question. Use this block rather than any interactive question tool you have, since there is no interactive session here for one of those to reach. Use it only when you are actually blocked: routine judgment calls are yours to make.`;

// The team's own pull request description template, handed over before the
// session opens anything rather than applied to a body somebody may already
// have read. ✎ PR Body Summary rewrites an existing description with the same
// template; this is the same text arriving early enough that there is usually
// nothing to rewrite.
//
// It is the resolved template (project override, global override or the
// built-in) so a project that has written its own gets its own, exactly as
// the ✎ errand does.
function prBodyProtocol(job) {
  // A session started on a pull request (a review, a QA run, any ⚡ action)
  // is not going to open one, so the template is only noise in its prompt.
  if (job.startedOnPr) return '';
  const template = templateText('prBody', getProject(job.repo)).trim();
  if (!template) return '';
  return `

# Pull request descriptions

When you open a pull request on ${job.repo}, write its description to the template below: keep its headings and \
fill each one in from the change itself. A section that genuinely does not apply gets one line saying so rather \
than being deleted. Anything the template asks for that you cannot answer is a question for the user, not a \
heading to drop.

<pr-body-template>
${template}
</pr-body-template>`;
}

// The provider entries a worker can be started on, written into the
// orchestrator's briefing so it can pick a cheap model by id instead of
// guessing. Resolved fresh each turn: entries and their model lists are
// edited in Settings while sessions run.
function workerProviderCatalog() {
  const cfg = getConfig();
  return listProviders()
    .map((p) => {
      const models = providerModels(p, cfg);
      return `- provider_id ${p.id}: ${p.label} (${p.binary}) — models: ${models.join(', ')} (default ${providerDefaultModel(p, cfg)}); efforts: ${providerEfforts(p).join(', ')}`;
    })
    .join('\n');
}

// The supervisor's briefing: what an orchestrator session is, its worker
// tools, and the discipline that keeps it cheap. It replaces the workspace
// briefing wholesale: there is no checkout to describe.
function orchestratorSystemPrompt(job) {
  return `You are the orchestrator of coding-agent worker sessions on ${job.repo}, run from a local dashboard. \
The user chats with you from a web UI and reads your replies there. They give you goals; you break them into \
tasks, start workers, steer and verify their work, and report back. Keep your replies short and concrete: what \
each worker is doing, what landed, what needs the user's decision. Never paste long transcripts or diffs back.

# Workers

A worker is a full coding agent in a workspace clone of ${job.repo} on a branch of its own: it edits code, runs \
the app and its tests, and can open a pull request. Every worker turn costs money, so give each one a complete, \
self-contained brief (goal, constraints, how to verify, whether to open a PR) rather than drip-feeding, and \
pick a cheap model for routine work.

Use the spawn_worker / list_workers / read_worker / send_to_worker / retry_review / close_worker tools. If you do not have \
them, the same routes are reachable over HTTP with the REVIEWER_MEMORY_URL and REVIEWER_MEMORY_TOKEN \
environment variables:

    curl -sS -X POST "$REVIEWER_MEMORY_URL/api/agent/sessions" -H "Authorization: Bearer $REVIEWER_MEMORY_TOKEN" \
      -H 'Content-Type: application/json' -d '{"title":"…","prompt":"…","providerId":1,"model":"…","effort":"…","reviewLoop":true,"qaLoop":false}'
    curl -sS "$REVIEWER_MEMORY_URL/api/agent/sessions" -H "Authorization: Bearer $REVIEWER_MEMORY_TOKEN"
    curl -sS "$REVIEWER_MEMORY_URL/api/agent/sessions/<id>?tail=40" -H "Authorization: Bearer $REVIEWER_MEMORY_TOKEN"
    curl -sS -X POST "$REVIEWER_MEMORY_URL/api/agent/sessions/<id>/message" -H "Authorization: Bearer $REVIEWER_MEMORY_TOKEN" \
      -H 'Content-Type: application/json' -d '{"text":"…"}'
    curl -sS -X POST "$REVIEWER_MEMORY_URL/api/agent/sessions/<id>/close" -H "Authorization: Bearer $REVIEWER_MEMORY_TOKEN"
    curl -sS -X POST "$REVIEWER_MEMORY_URL/api/agent/sessions/<id>/retry-review" -H "Authorization: Bearer $REVIEWER_MEMORY_TOKEN" \
      -H 'Content-Type: application/json' -d '{"providerId":1,"model":"…"}'

Spawning with review_loop: true arms the review loop on that worker: every push it settles with on its pull \
request is code-reviewed, and findings go directly to a fix session that decides which feedback needs changes, \
implements valid findings and explains anything it leaves unchanged. Those reviews and \
fixes are sessions under the worker, and their spend counts against this orchestration's budget. Arm it for \
work meant to land; leave it off for investigations, spikes and anything that opens no pull request. \
Those reviews run on the worker's own runtime, so a worker you move to another provider takes its loop with \
it. A round that could not run at all — its provider out of quota, its CLI exiting non-zero, a dashboard restart \
interrupting its review or fix session, or a review that published nothing — is not a review that found nothing: \
list_workers says the round failed, and retry_review re-runs it (with another provider_id/model when that is the \
problem), which is the only thing that will, \
since the loop otherwise waits for a push the worker may have none left to make. \
qa_loop: true queues a QA run behind it (it needs review_loop armed too): once the reviews converge cleanly, \
a session writes a test sheet for the pull request and executes it against the running app, which is worth \
its cost for user-facing work and rarely for a refactor. list_workers says where each loop stands — a worker \
still reviewing, fixing or running QA is not done, so do not close it or report the \
task finished until the loops converge, stall or fail. A failed or interrupted QA run is not active: \
list_workers says it is not running, and a send_to_worker follow-up retries QA after that worker turn settles.

# Review findings

The fix session owns assessment of review findings against the code and pull request context. Do not \
stage a separate triage pass or decide which individual findings it should implement. The loop retains \
its severity filter, stored verdicts, repeated-findings stop and round cap. When it stalls, report the \
stop and let the user decide whether to spend another round; do not automatically restart it or waive \
findings to get a clean result.

A worker that stops to ask a question shows as awaiting an answer in list_workers; send_to_worker with the \
answer resumes it. Prefer read_worker's default tail (or the worker's pull request) over whole transcripts: \
what you read fills your own context. Text is clipped at 2000 characters per entry by default; if you need \
complete text, use full_text: true with a small tail. Increasing tail only adds older entries. Close a worker when its task is done or abandoned; its branch and pull \
request outlive it.

# Worker updates

When a worker stops — finishes a turn, stops on a question, or fails — or its review loop converges or \
stalls, or its QA run reaches a verdict, the update arrives as your next message, batched while you are \
busy. Act on it in the same turn: verify finished work before calling it done (read_worker's tail, or gh pr \
diff / checks on its pull request), answer a worker's question with send_to_worker, retry or replace a failed \
worker, and report a stalled review loop without restarting it automatically. \
Escalate to the user with an ask-user block only when the decision is genuinely theirs: scope, spend, anything irreversible. Keep your visible reply to a line or two — \
the user reads this chat as a status feed, and every word you write costs your own (expensive) turn.

# Your own workspace

Your working directory is a scratch directory, not a checkout of ${job.repo}. Do not clone the repository or \
edit code yourself; delegate the work. You may read GitHub directly to verify results, and act on a pull \
request when your instructions say so (gh pr comment, gh pr merge): the gh CLI is authenticated via the \
GH_TOKEN environment variable (gh pr view / diff / checks).

# Providers a worker can run on

${workerProviderCatalog() || 'No provider entries are configured yet; workers spawn on your own entry.'}

${workerRuntimeBriefing(job)}${budgetBriefing(job)}${toolingBriefing(job)}${projectInstructions(job)}${memoryProtocol(job)}${ASK_PROTOCOL}`;
}

// What a spawn that names nothing runs on, said plainly so the agent knows
// whether omitting the provider is already the cheap choice.
function workerRuntimeBriefing(job) {
  const own = ownWorkerRuntime(job);
  const configured = own || projectWorkerRuntime(getProject(job.repo));
  if (configured) {
    const source = own
      ? 'the worker runtime this orchestration was started with'
      : "the project's worker runtime";
    return `Omitting provider_id/model on spawn_worker uses ${source}: ${configured.provider.label} \
(${configured.model}, effort ${configured.effort}). Name a provider only when a task needs a different one.`;
  }
  return `Omitting provider_id/model on spawn_worker uses your own (${job.provider}, ${job.model}), which is usually too \
expensive for a worker; pick a cheaper entry from the list above for routine work.`;
}

// Where the orchestration stands against the project's budget, when it has
// one. Recomputed per turn, so the numbers are live.
function budgetBriefing(job) {
  const budget = workerBudget(job);
  if (budget == null) return '';
  const spent = orchestratorSpend(job);
  return `

# Budget

This orchestration (your turns, every worker's, and the reviews, fixes and QA runs their loops ran) has spent $${spent.toFixed(2)} of its $${budget.toFixed(2)} budget. \
When it runs out, spawning and steering stop until the user raises it: plan the remaining spend, and prefer \
finishing work in flight over starting more.`;
}

// Self-healing: the dashboard is a project here too, and a flaw in the
// tooling that runs the orchestrator is a task like any other, sent to a
// worker on that project through fix_tooling. The section says when that is
// warranted (a real, repeatable flaw, with evidence) and what happens after
// (the pull request is merged like any other, the user redeploys), and,
// with no project flagged, that a flaw is still worth a line to the user.
function toolingBriefing(job) {
  const self = selfProject();
  if (!self) {
    return `

# The tooling itself

The dashboard that runs you and your workers (your briefing, the worker tools, the review and QA loops) is \
software of its own and can fail you: a tool that errors or misleads, a briefing that sent a worker the wrong \
way, a loop that misbehaves. It is not set up as a project here, so you cannot fix it; when it happens, say so \
to the user in a line, with what you saw, and work around it.`;
  }
  return `

# Fixing the tooling

The dashboard that runs you and your workers is itself a project here: ${self.repo}. Your briefing, the worker \
tools, the review and QA loops, the prompts every session gets and the UI all live in that repository. When \
something in it fails you or your workers — a tool that errors or misleads, a briefing that sent a worker the \
wrong way, a loop that misbehaves, a capability you plainly needed and did not have — fix it rather than \
working around it every time: fix_tooling starts a worker on ${self.repo} with the review loop armed, \
exactly like spawn_worker otherwise (it runs on that project's worker runtime unless you name one, spends \
from this orchestration's budget, and counts among your open workers). \
Brief it with evidence, since it wakes up in a checkout of the dashboard knowing nothing of your task: what \
you or the worker did, what the tooling did, what it should have done, and where you suspect it lives. Only \
real, repeatable flaws earn this: not taste, not a task on ${job.repo} that was merely hard, and never as a \
way to loosen a rule that got in your way. When its review loop converges and its checks are green, merge the \
pull request (gh pr merge --squash --delete-branch) and tell the user a tooling fix landed: the running \
dashboard keeps its current code until they redeploy it, so keep working around the flaw meanwhile.${
    job.repo.toLowerCase() === self.repo.toLowerCase()
      ? ' You are orchestrating that repository right now, so a tooling fix is one more worker on it.'
      : ''
  }`;
}

// The operator's own standing orders for this project, from the orchestrator
// template (project override → global → nothing). This is where "what I
// review, what I care about" lives, edited under Settings → Prompts or on the
// project itself.
function projectInstructions(job) {
  const text = renderTemplate('orchestrator', { REPO: job.repo }, getProject(job.repo));
  if (!text) return '';
  return `

# Project instructions

${text}`;
}

function devSystemPrompt(job) {
  if (job.orchestrator) return job.zeus ? zeusSystemPrompt(job) : orchestratorSystemPrompt(job);
  if (job.local) {
    return `You are a coding agent in a developer session started from a local dashboard. The user chats with you \
from a web UI and reads your replies there, so keep them concise and readable.

The repository ${job.repo} is the user's own local checkout at ${job.workDir}${job.branch ? `, currently on branch ${job.branch}` : ''}. \
This is a live working tree shared with the user's own work: its .env, database and installed dependencies are the real local ones, \
and it may hold uncommitted changes that are not yours; leave those alone. Work within the tree as it stands; never reset, clean, \
stash or switch branches unless the user explicitly asks. \
The gh CLI is authenticated via the GH_TOKEN environment variable. Never push to shared branches on your own; \
pushing a feature branch or opening a PR is fine when the user asks for it.${prBodyProtocol(job)}${memoryProtocol(job)}${ASK_PROTOCOL}`;
  }
  return `You are a coding agent in a developer session started from a local dashboard. The user chats with you \
from a web UI and reads your replies there, so keep them concise and readable.

The repository ${job.repo} is checked out at ${job.workDir} on branch ${job.branch}, ${
    job.reviewBranch
      ? 'an existing branch checked out for you to review'
      : job.startBranch
        ? 'an existing branch the user chose for this session to work on'
        : 'created from the default branch'
  }. \
This clone is yours alone for the whole conversation: edit files, run the app and its tests freely. \
The gh CLI is authenticated via the GH_TOKEN environment variable. Never push to shared branches on your own; \
pushing a feature branch or opening a PR is fine when the user asks for it.${setupContext(job)}${readOnlyProtocol(job)}${prBodyProtocol(job)}${memoryProtocol(job)}${ASK_PROTOCOL}`;
}

// What makes a Zeus analyst's session read-only. The clone is an ordinary
// pool slot, so nothing stops the CLI from editing; the rule is the prompt,
// backed by the loops it cannot arm.
// Its whole product is its reply: the Zeus session reads it with read_worker.
function readOnlyProtocol(job) {
  if (!job.readOnly) return '';
  return `

# Read-only analysis

This session is an analyst started by a ⚡ Zeus session that is writing an epic, and it is read-only: read the \
code, search it, run its tests or read-only commands when that answers a question, but do not edit files, do not \
commit, do not push and do not open a pull request. Your deliverable is your final message, which the Zeus \
session reads back: put everything in it (the whole analysis, not a summary of a file you wrote), cite evidence \
as file paths, symbols, tables and endpoints that actually exist in this checkout, and separate what you \
verified from what you infer or propose. Do not present a component you are proposing as if it existed.`;
}

// The ⚡ Zeus briefing: the orchestrator's machinery (worker tools, budget,
// tooling, memory) turned to one product, a GitHub epic, and one method, the
// fusion pattern: independent proposals from several analysts, compared and
// merged by Zeus on evidence rather than by vote, then
// published as a parent issue with sub-issues. The Zeus session itself has a
// read-only clone, so the investigation that opens the flow and the
// verification that closes it are its own rather than an analyst's word.
// The document's shape comes from the zeusEpic template, editable per
// project like every other prompt.
function zeusSystemPrompt(job) {
  const clone = zeusCloneDir(job);
  return `You are Zeus, an epic-writing supervisor on ${job.repo}, run from a local dashboard. The user chats with \
you from a web UI and reads your replies there. They give you a brief; two models independently solve the same complete task, and you consolidate their outputs and \
publish the epic as a GitHub issue with sub-issues. You never implement the feature and never edit code. Keep \
your replies short and concrete: which models are working, what each analyst found, what needs the user's \
decision. Never paste whole proposals back into the chat.

# Your workspace

${job.repo} is checked out read-only at ${clone}, a shallow clone of the default branch (this session's own \
scratch directory is ${job.workDir}, where you may write notes). Read and search it freely, run read-only \
commands, but never edit, commit or push there: the epic is the product. The gh CLI is authenticated via the \
GH_TOKEN environment variable; use it to read and write issues on ${job.repo}.

# Fusion

Your session model is the summarizer. Both selected models do the same complete task independently, \
then you combine their outputs into one final epic. There are no specialist assignments, phased analyst \
workflow or separate validator. Before spawning, ensure the user has chosen both models; if choices \
are missing, ask with an ask-user block and wait. ${zeusRolesAdvice(job)}

Compose ONE self-contained prompt containing the user's brief verbatim, its constraints and exclusions, \
any supplied context, and the epic template below. Ask every model to investigate the repository and produce \
the complete epic, covering product, architecture, requirements, acceptance criteria and implementation plan. \
Each model must distinguish verified facts (with repository references), explicit requirements, assumptions \
and open decisions. Include the same instruction to report the complete result in its final message.

Start two analysts with spawn_worker, passing exactly the SAME prompt string to both. Do not divide \
the task, change emphasis, assign phases or share their outputs with one another. Use role: product for \
Model 1 and architecture for Model 2; these legacy identifiers select runtimes only, not \
specialties. Use neutral titles Model 1 and Model 2. Analysts are read-only and cannot publish.

Wait for both outputs. Read each proposal with read_worker using full_text: true and a small tail \
(for example tail: 12). Increase tail if earlier entries are missing; tail alone cannot undo clipping. \
If a model fails, report the missing output and retry or ask how to proceed; do not claim complete fusion.

As ZEUS, consolidate their complete outputs into ONE epic. Preserve justified unique findings and useful \
detail, remove duplicates, and resolve contradictions using evidence rather than a majority vote. Check \
disputed repository references yourself. Keep uncertain claims and unresolved user decisions explicit; never \
turn assumptions into requirements. Ensure the combined result covers the brief and respects exclusions. \
Give requirements stable ids (FR-# and TR-#), evidence, acceptance criteria and dependencies. Do not merely \
shorten the proposals or concatenate them. You perform this consolidation yourself, without another worker.

# Deliver the consolidated epic

First look for an equivalent epic already open (gh issue list --search, the issue tab's parent issues) and \
stop to ask the user with an ask-user block if one exists. Then create the epic with the consolidated document \
as the body of a parent issue (gh issue create), and one sub-issue per implementation phase or per group of \
requirements that one worker could land as a pull request, each body naming the requirement ids it covers. \
Link each as a real GitHub sub-issue, which is what the dashboard reads as an epic:

    gh api repos/${job.repo}/issues/<parent-number>/sub_issues -F sub_issue_id=<child database id>

where the child's database id is \`gh api repos/${job.repo}/issues/<child-number> --jq .id\`. If decisions are \
still pending, say so at the top of the epic and do not present it as ready to implement. Verify by reading the \
parent back (gh issue view), then report its number, link, sub-issues and the pending decisions in a few lines. \
Close your analysts once you have read them; their transcripts stay readable.

# Analysts

Use spawn_worker / list_workers / read_worker / send_to_worker / close_worker. Give each analyst a complete, \
self-contained brief: it wakes up in a clone of its own knowing nothing of this conversation. An analyst that \
stops on a question shows as awaiting an answer in list_workers; send_to_worker resumes it. Their updates \
arrive as your next message when they settle, batched while you are busy. If you do not have the tools, the \
same routes are reachable over HTTP with the REVIEWER_MEMORY_URL and REVIEWER_MEMORY_TOKEN environment variables:

    curl -sS -X POST "$REVIEWER_MEMORY_URL/api/agent/sessions" -H "Authorization: Bearer $REVIEWER_MEMORY_TOKEN" \
      -H 'Content-Type: application/json' -d '{"title":"…","prompt":"…","providerId":1,"model":"…","effort":"…"}'
    curl -sS "$REVIEWER_MEMORY_URL/api/agent/sessions" -H "Authorization: Bearer $REVIEWER_MEMORY_TOKEN"
    curl -sS "$REVIEWER_MEMORY_URL/api/agent/sessions/<id>?tail=200" -H "Authorization: Bearer $REVIEWER_MEMORY_TOKEN"
    curl -sS -X POST "$REVIEWER_MEMORY_URL/api/agent/sessions/<id>/message" -H "Authorization: Bearer $REVIEWER_MEMORY_TOKEN" \
      -H 'Content-Type: application/json' -d '{"text":"…"}'
    curl -sS -X POST "$REVIEWER_MEMORY_URL/api/agent/sessions/<id>/close" -H "Authorization: Bearer $REVIEWER_MEMORY_TOKEN"

# Providers an analyst can run on

${workerProviderCatalog() || 'No provider entries are configured yet; analysts spawn on your own entry.'}

${zeusRolesBriefing(job) || workerRuntimeBriefing(job)}${budgetBriefing(job)}${toolingBriefing(job)}${zeusEpicTemplate(job)}${memoryProtocol(job)}${ASK_PROTOCOL}`;
}

// How the analysts' runtimes were decided: by the user, role by role, when the
// start picked them, or left to the agent otherwise. The two halves are one
// sentence in the method and one section in the briefing, so a Zeus session
// started without picks still hears the fusion pattern's advice on diversity.
function zeusRolesAdvice(job) {
  return job.zeusRoles
    ? 'Omit provider_id and model unless the user asks for a change: the runtimes below are their pick. '
    : 'No saved model choices exist. Ask the user which models to use before spawning, then pass their choices explicitly. ';
}

function zeusRolesBriefing(job) {
  if (!job.zeusRoles) return '';
  const cfg = getConfig();
  const lines = ZEUS_PROPOSAL_ROLES.map((role) => {
    const pick = job.zeusRoles[role] ? resolveRuntime(job.zeusRoles[role], cfg) : null;
    return `- ${role}: ${
      pick
        ? `${pick.provider.label} (provider_id ${pick.provider.id}), ${pick.model}, effort ${pick.effort}`
        : 'no pick; the fallback below applies'
    }`;
  });
  return `# Analyst runtimes

The user chose what each role runs on. spawn_worker with that role and no provider_id \
or model uses it:

${lines.join('\n')}

${workerRuntimeBriefing(job)}`;
}

// The epic's own shape and the operator's standing orders for it, from the
// zeusEpic template (project override → global → built-in).
function zeusEpicTemplate(job) {
  const text = renderTemplate('zeusEpic', { REPO: job.repo }, getProject(job.repo));
  if (!text) return '';
  return `

# The epic document

Write the epic body, and brief every analyst, to this template:

<epic-template>
${text}
</epic-template>`;
}

// The environment a provider's CLI runs with: the job's instance env plus the
// provider entry's own credential home. Shared by the turn itself and the
// post-turn /context probe, which must see exactly the login (and workspace
// trust) the turn ran under. `turnModel` is the model that turn runs on, which
// is the session's own unless a step moved it.
function providerEnv(job, prov, cfg, turnModel = job.model) {
  const env = jobEnv(
    {
      GITHUB_TOKEN: cfg.githubToken,
      GH_TOKEN: cfg.githubToken,
      GIT_TERMINAL_PROMPT: '0',
      ...instanceEnv(job),
      ...memoryEnv(job),
    },
    job,
  );
  if (prov.binary === 'claude') {
    // Every claude entry is a login of its own: the run gets the entry's
    // registered config dir (materialized from the database when missing)
    // and nothing of the machine's own credentials, or two picker entries
    // would silently run as one account (and share its rate limits).
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_AUTH_TOKEN;
    delete env.CLAUDE_CODE_OAUTH_TOKEN;
    delete env.CLAUDE_CONFIG_DIR;
    delete env.ANTHROPIC_BASE_URL;
    env.CLAUDE_CONFIG_DIR = ensureClaudeHome(prov);
    // Print mode kills any Bash tool call still running in the background after
    // 600s and prints a diagnostic line to stdout, which is not JSON, so the
    // parser above drops it into the log as garbled text. A review turn's own
    // background commands (tests, builds) can easily outlive that ceiling long
    // before the job's real timeout does, so let print mode wait indefinitely
    // and leave enforcement to the job's own limitMin timeout.
    env.CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS = '0';
    if (prov.apiKey) env.ANTHROPIC_API_KEY = prov.apiKey;
    if (prov.baseUrl) env.ANTHROPIC_BASE_URL = prov.baseUrl;
    // ANTHROPIC_API_KEY only travels as x-api-key; a gateway that reads
    // Authorization (vLLM, most OpenAI-shaped proxies) never sees it. The
    // auth token variable is what the CLI sends as `Authorization: Bearer`,
    // so a custom endpoint gets the key on both headers.
    if (prov.baseUrl && prov.apiKey) env.ANTHROPIC_AUTH_TOKEN = prov.apiKey;
    // --model only sets the main loop's model. Sub-agents, and anything else
    // the CLI resolves through its built-in aliases, still ask for opus/sonnet/
    // haiku by their Anthropic ids, which a custom gateway does not serve, so
    // every Task the turn spawns dies on "model unavailable". Point the aliases
    // at the model this session actually runs on.
    if (prov.baseUrl) {
      const model = turnModel || prov.defaultModel || (prov.models || [])[0];
      if (model) {
        env.ANTHROPIC_MODEL = model;
        env.ANTHROPIC_DEFAULT_OPUS_MODEL = model;
        env.ANTHROPIC_DEFAULT_SONNET_MODEL = model;
        env.ANTHROPIC_DEFAULT_HAIKU_MODEL = model;
        env.ANTHROPIC_SMALL_FAST_MODEL = model;
      }
    }
    // Trust is per config dir, so it has to happen here, where the entry that
    // will run this turn is known, not at workspace-prep time.
    trustWorkspace(job, job.workDir, env.CLAUDE_CONFIG_DIR);
  }
  if (prov.binary === 'codex') {
    // Every codex entry runs in a CODEX_HOME of its own: its login (or
    // custom endpoint + key) lives there, never the developer's own ~/.codex.
    // The turn's model goes in with it: `codex exec review` takes its model
    // from the config's review_model, not from the -m on argv, so a review
    // would otherwise run on the entry's default whatever the picker says.
    env.CODEX_HOME = ensureCodexHome(prov, turnModel);
  }
  if (prov.binary === 'grok') {
    // grok too: each entry's login lives in a GROK_HOME of its own.
    env.GROK_HOME = ensureGrokHome(prov);
  }
  if (prov.binary === 'opencode') {
    // opencode has no home variable (it reads the XDG base directories), so
    // an entry gets all four pointed inside a root of its own, sessions and
    // caches included, and the developer's own opencode is never touched.
    // Whatever opencode variables the server itself was started with are the
    // developer's, not this entry's: inherited they would point the CLI at
    // another credential store or another config on a row that carries none.
    for (const key of [
      'OPENCODE_AUTH_CONTENT',
      'OPENCODE_CONFIG',
      'OPENCODE_CONFIG_CONTENT',
      'OPENCODE_CONFIG_DIR',
    ])
      delete env[key];
    Object.assign(env, opencodeXdgEnv(ensureOpencodeHome(prov)));
    // An opencode entry authenticates with the API key on the row and nothing
    // else: this is the CLI's whole credential store, read in place of the
    // file, so the key never lands on disk. Filed under the service the
    // turn's own model names: a step that moved this turn onto another of the
    // entry's models needs the key under that service, not the default's.
    const auth = opencodeAuthContent(prov, turnModel);
    if (auth) env.OPENCODE_AUTH_CONTENT = auth;
    // The entry's endpoint rides along the same way, as an inline config that
    // sets the base URL of that same service, so a proxy or a compatible
    // gateway is reached without a config file in the entry's XDG root.
    const config = opencodeConfigContent(prov, turnModel);
    if (config) env.OPENCODE_CONFIG_CONTENT = config;
  }
  return env;
}

// After a turn, ask each CLI's own native accounting where the session's
// context stands, instead of trusting whatever the event stream implied:
//  - claude: `claude -p "/context" --resume <session>` computes the same
//    per-category estimate the interactive /context screen shows, locally,
//    with no API call, in about a second.
//  - codex: the CLI appends a token_count event to the thread's rollout file
//    after every model call (the numbers its /status screen shows) with the
//    live context (last_token_usage), the thread's total consumption and the
//    model's context window. Read the newest one back.
//  - grok and opencode: nothing to probe. Neither has a local /context
//    command headless (it would go to the model as a prompt), but both
//    streams already report each request's own usage, which the parsers take
//    the live context from directly.
//
// The numbers describe the conversation the turn that just ended ran in, so a
// step on another provider therefore reports its own thread's context, which is
// exactly the context that turn was working with.
const ctxProbes = new Map(); // job id -> the in-flight probe, so shutdown can wait for it
async function probeContextUsage(job, prov, chat, model) {
  if (ctxProbes.has(job.id)) return;
  const run = (async () => {
    try {
      if (prov.binary === 'claude') await claudeContextProbe(job, prov, chat, model);
      else if (prov.binary === 'codex') codexContextFromRollout(job, prov, chat.sessionId);
    } catch {
      /* an estimate that failed to compute just leaves the panel as it was */
    }
  })();
  ctxProbes.set(job.id, run);
  try {
    await run;
  } finally {
    ctxProbes.delete(job.id);
  }
}

// codex's native context numbers, read from the thread's rollout file under
// CODEX_HOME/sessions/<y>/<m>/<d>/rollout-<stamp>-<threadId>.jsonl. token_count
// rides at the tail (it follows every model call), so the last chunk of the
// file is enough.
function codexContextFromRollout(job, prov, sessionId = job.providerSessionId) {
  if (!sessionId) return;
  const file = findCodexRollout(path.join(ensureCodexHome(prov), 'sessions'), sessionId);
  if (!file) return;
  const fd = fs.openSync(file, 'r');
  let tail;
  try {
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, 1024 * 1024);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    tail = buf.toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
  const lines = tail.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes('"token_count"')) continue;
    let info;
    try {
      info = JSON.parse(lines[i]).payload?.info;
    } catch {
      continue;
    }
    if (!info) continue;
    const total = info.total_token_usage || {};
    const last = info.last_token_usage || {};
    if (last.total_tokens) job.contextTokens = last.total_tokens;
    if (info.model_context_window) job.contextWindow = info.model_context_window;
    // The thread totals are the CLI's own ledger, so take them over the sums
    // accumulated from turn reports.
    if (total.input_tokens != null) job.inputTokens = total.input_tokens;
    if (total.output_tokens != null) job.outputTokens = total.output_tokens;
    bus.emit('job', publicJob(job));
    save(job);
    return;
  }
}

function findCodexRollout(root, threadId) {
  const suffix = `-${threadId}.jsonl`;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.isDirectory()) stack.push(path.join(dir, e.name));
      else if (e.name.startsWith('rollout-') && e.name.endsWith(suffix)) return path.join(dir, e.name);
    }
  }
  return null;
}

async function claudeContextProbe(job, prov, chat, model) {
  if (!chat.started || !chat.sessionId || !job.workDir) return;
  // Its own file, not the turn's: the turn deletes its prompt files on exit,
  // and the next turn may already be writing new ones under the same names.
  const sysFile = path.join(promptDir(), `${job.id}-ctx-system-prompt.txt`);
  try {
    const cfg = getConfig();
    const found = getBinary('claude').bin(cfg);
    if (!found) return;
    // The same appended system prompt the turns run with, so the report's
    // System prompt row counts the workspace briefing too.
    fs.writeFileSync(sysFile, devSystemPrompt(job), 'utf8');
    const args = [
      '-p',
      '/context',
      '--resume',
      chat.sessionId,
      '--output-format',
      'json',
      '--model',
      model,
      '--append-system-prompt-file',
      sysFile,
    ];
    const env = providerEnv(job, prov, cfg, model);
    const stdout = await new Promise((resolve, reject) => {
      const child = spawn(found.bin, args, { cwd: job.workDir, env });
      let out = '';
      child.stdout.on('data', (c) => {
        out += c.toString('utf8');
      });
      child.stderr.resume();
      child.stdin.on('error', () => {});
      child.stdin.end();
      const timer = setTimeout(() => child.kill(), 30_000);
      child.on('error', (e) => {
        clearTimeout(timer);
        reject(e);
      });
      child.on('close', () => {
        clearTimeout(timer);
        resolve(out);
      });
    });
    const report = parseContextReport(JSON.parse(stdout).result);
    if (!report || !report.categories.length) return;
    job.contextUsage = { ...report, at: now() };
    if (report.tokens != null) job.contextTokens = report.tokens;
    if (report.window != null) job.contextWindow = report.window;
    bus.emit('job', publicJob(job));
    save(job);
  } finally {
    try {
      fs.rmSync(sysFile, { force: true });
    } catch {
      /* harmless leftover */
    }
  }
}

// One provider turn: spawn the CLI headless, stream its output into events,
// resolve when it exits. The provider's own session state carries the
// conversation; we only hand it the new message and the resume id.
//
// `step` names one of the project's configured steps (lib/projects.js,
// REVIEW_STEPS) when this turn is one: that is what may move it onto another
// provider, model or effort, and onto that provider's own conversation.
function runDevTurn(job, prompt, { review = false, step = null } = {}) {
  const cfg = getConfig();
  const { provider: prov, model, effort } = turnRuntime(job, step);
  const chat = providerChat(job, prov.id);
  // Every provider resumes its own thread: the session's after its first turn,
  // a step provider's after the first step that ran on it, but only when the
  // id it left behind is one that binary can actually pick up. A first turn
  // killed before its CLI ever printed one leaves the id the session was
  // created with, which names no conversation: that next turn is a fresh one,
  // and has to be briefed as such.
  const resume = chat.started && canResume(prov.binary, chat.sessionId);
  const desc = getBinary(prov.binary);
  const found = desc.bin(cfg);
  if (!found) throw new Error(`${desc.label} CLI not found`);

  // A binary with a dedicated review command (codex) gets it invoked for the
  // review turn; the others run their review as a normal conversation turn.
  // Either way the turn is built the same: the review message carries the
  // provider's review command and the shared instructions, and the prompt
  // travels the way that binary wants it.
  const native = review && !!desc.buildReviewArgs;

  let fullPrompt = prompt;
  const files = [];
  const buildTurn = (extra) => {
    const opts = {
      model,
      effort,
      resume,
      sessionId: chat.sessionId,
      base: job.baseBranch || 'master',
      sysPromptFile: null, // set below for claude
      promptFile: null, // set below for grok
      mcpConfigFile: null, // set below for claude
      // codex takes its tools as config overrides on argv; grok and
      // opencode have no MCP flag headless and reach the same routes over
      // HTTP instead.
      mcp: prov.binary === 'codex' ? mcpServersFor(job) : null,
      ...extra,
    };
    return native ? desc.buildReviewArgs(opts) : desc.buildArgs(opts);
  };
  const build = buildTurn();
  // Claude takes the workspace context as a proper system prompt; the others
  // get it inside the first message.
  let args = build.args;
  if (!build.briefingInPrompt) {
    const sysFile = path.join(promptDir(), `${job.id}-dev-system-prompt.txt`);
    fs.writeFileSync(sysFile, devSystemPrompt(job), 'utf8');
    files.push(sysFile);
    // The turn's tools (memory, plus the worker tools on an orchestrator),
    // mounted for this turn only. The file carries the turn's token, so it
    // goes with the prompt files when the turn ends.
    const mcpFile = path.join(promptDir(), `${job.id}-mcp.json`);
    const mcpServers = {};
    for (const { name, command, args: mcpArgs, env } of mcpServersFor(job)) {
      mcpServers[name] = { command, args: mcpArgs, env };
    }
    fs.writeFileSync(mcpFile, JSON.stringify({ mcpServers }), 'utf8');
    files.push(mcpFile);
    args = buildTurn({ sysPromptFile: sysFile, mcpConfigFile: mcpFile }).args;
  } else if (!resume) {
    // A review prompt opens with the provider's review command, which has to
    // stay the first line of the message, so the briefing follows it instead of
    // leading.
    fullPrompt = review
      ? `${prompt}\n\n<workspace-context>\n${devSystemPrompt(job)}\n</workspace-context>`
      : `<workspace-context>\n${devSystemPrompt(job)}\n</workspace-context>\n\n${prompt}`;
  }
  if (build.promptVia === 'file') {
    const promptFile = path.join(promptDir(), `${job.id}-prompt.txt`);
    fs.writeFileSync(promptFile, fullPrompt, 'utf8');
    files.push(promptFile);
    args = buildTurn({ promptFile }).args;
  }

  // The turn's time limit, and who it is for: a session holding one of the
  // pooled database servers is what its peers queue behind, so a run that
  // forgets to stop has to be cut off. A session that claimed no server
  // (local mode, or a project outside the pool) is in nobody's way, and a turn
  // there is allowed to take as long as the work does.
  const limitMin = job.dbServerId == null ? null : cfg.dev.timeoutMin;

  pushEvent(job, 'info', {
    text:
      (native
        ? `Starting ${prov.label} code review (${model}, effort ${effort}): ${job.branch} against ${job.baseBranch || 'master'}`
        : `Starting ${prov.label} (${model}, effort ${effort})${resume ? ', resuming session' : ''}`) +
      (limitMin ? `, ${limitMin} min limit` : ', no time limit (no database server claimed)'),
  });

  const env = providerEnv(job, prov, cfg, model);

  const turn = newTurn();
  const parser = parserFor(prov.binary, turn);
  job.turnCanceled = false;
  // Nothing is working yet, and a record restored from storage may still
  // carry the sub-agents a killed turn left behind.
  job.subagents = [];

  // Token accounting against a baseline, so the same numbers can be applied
  // mid-stream (the live context panel during a running turn) and again at
  // close without double-counting: the turn accumulator holds this turn's
  // consumption, the baseline what the session had before it.
  const baseInputTokens = job.inputTokens || 0;
  const baseOutputTokens = job.outputTokens || 0;
  const applyTurnUsage = () => {
    if (turn.contextTokens != null) job.contextTokens = turn.contextTokens;
    if (turn.contextWindow != null) job.contextWindow = turn.contextWindow;
    if (turn.inputTokens != null) job.inputTokens = baseInputTokens + turn.inputTokens;
    if (turn.outputTokens != null) job.outputTokens = baseOutputTokens + turn.outputTokens;
  };
  let lastUsagePush = 0;

  return new Promise((resolve, reject) => {
    // detached: cancelling a turn has to take down the tool processes the CLI
    // spawned too, not just the CLI itself.
    const child = spawn(found.bin, args, { cwd: job.workDir, env, detached: true });
    job.proc = child;
    // A CLI that dies before reading its prompt (a rejected key, a bad flag,
    // a killed turn) leaves this write going into a closed stdin. That EPIPE
    // is an uncaught exception with no listener here, and it takes the whole
    // server down with every other running session. Swallow it: 'close' below
    // ends the turn with the child's own exit code and stderr.
    child.stdin.on('error', () => {});
    if (build.promptVia === 'stdin') child.stdin.end(fullPrompt);
    else child.stdin.end();

    job.timeout = limitMin
      ? setTimeout(
          () => {
            pushEvent(job, 'info', { text: `Timeout after ${limitMin} min, killing ${prov.label}` });
            killJobProcess(job);
          },
          limitMin * 60 * 1000,
        )
      : null;

    let buffer = '';
    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let idx;
      while ((idx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        try {
          for (const e of parser.feed(JSON.parse(line))) {
            if (e.kind === 'agent') {
              trackSubagent(job, e);
              continue;
            }
            const { kind, ...data } = e;
            pushEvent(job, kind, data);
          }
        } catch {
          pushEvent(job, 'claude', { text: line.slice(0, 500) });
        }
      }
      // Live context/token numbers while the turn runs. The right panel's
      // usage section polls the session record, so pushing the accumulator's
      // running totals in every couple of seconds is what makes a long review
      // turn show its context filling up instead of nothing until it ends.
      if (Date.now() - lastUsagePush > 2000 && (turn.contextTokens != null || turn.inputTokens != null)) {
        lastUsagePush = Date.now();
        applyTurnUsage();
        // Up the tree too: a worker's running turn moves its orchestrator's
        // rollup, and the panel on that session polls the same record.
        emitUsage(job);
        save(job);
      }
    });
    child.stderr.on('data', (chunk) => {
      const t = chunk.toString('utf8').trim();
      if (!t) return;
      // A custom-baseUrl provider entry points the CLI's small-fast-model alias
      // at that provider's own model (see providerEnv above), which is never one
      // of Anthropic's known ids. The CLI logs this benign mismatch as a plain
      // warning on every side query (title generation, etc.), and surfacing it as
      // a red stderr line would misread it as the turn actually failing.
      const kind = /^\[claude-code:unrecognized_model\]/.test(t) ? 'claude' : 'stderr';
      pushEvent(job, kind, { text: t.slice(0, 1000) });
    });
    // The prompt files are named after the job, so every turn of a session
    // reuses the same two paths. Deleting them asynchronously would let the
    // unlink land after the *next* turn has already written its own copy,
    // which is what a review session hit, the publish turn dying on "Append
    // system prompt file not found" the moment the review turn ended. The CLI
    // has long finished reading them by the time it exits, so clearing them
    // synchronously here keeps the next turn's write safe.
    const cleanupFiles = () => {
      for (const f of files) {
        try {
          fs.rmSync(f, { force: true });
        } catch {
          /* a leftover file is harmless */
        }
      }
    };
    child.on('error', (e) => {
      clearTimeout(job.timeout);
      job.proc = null;
      cleanupFiles();
      reject(new Error(`Could not start ${prov.label}: ${e.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(job.timeout);
      job.proc = null;
      cleanupFiles();
      // The CLI is gone, so no sub-agent of this turn is still working,
      // including on the paths that never reach parser.flush().
      job.subagents = [];
      // The run may have refreshed the OAuth token (or made a first login), so
      // mirror the dir back into the provider's row, best effort.
      captureProviderAuth(prov).catch(() => {});
      // A branch rename that never printed its PR url mid-stream (or printed
      // it before the push actually landed) still has to be caught: every
      // turn re-reads HEAD, not just the ones that spot a link.
      refreshJobBranch(job);
      // Every turn ends with a PR sync, not just the run: a session that works
      // through queued messages (or a review's publish turn) changes labels,
      // reviews and checks along the way, and the panel should follow each turn
      // instead of standing still until the whole run is done. Cheap when the
      // session has no PR yet: syncDevPr returns straight away.
      syncDevPr(job).catch(() => {});
      // Whatever videos the turn dropped into the shared videos directory go
      // to the R2 bucket now, since the links the run just left on the pull request
      // point there. Best effort like the PR sync, and a no-op without a
      // bucket configured; a failed upload stays out of the manifest and is
      // retried when the next turn (any session's) ends.
      syncVideos()
        .then(({ uploaded, failed, deferred }) => {
          // An auto-closed session may be deleted by the time the sync lands,
          // and a pushEvent/save then would re-queue the record and resurrect
          // the deleted row on the next flush. Map membership alone is not
          // enough: deleteJobById holds the job in the map across its awaits,
          // so `closed` (set before the delete ever starts) is what covers
          // that window. The uploads themselves have already happened; a
          // failure means the links the run left on the pull request are
          // dead, and with no session to tell, the server log is what
          // survives to say why.
          if (job.status === 'closed' || jobs.get(job.id) !== job) {
            for (const f of failed) {
              console.error(`could not upload ${f.file} to the R2 bucket: ${f.error}`);
            }
            return;
          }
          if (uploaded.length) {
            pushEvent(job, 'info', {
              text: `Uploaded ${uploaded.length} video${uploaded.length === 1 ? '' : 's'} to the R2 bucket.`,
            });
          }
          for (const f of failed) {
            pushEvent(job, 'info', { text: `Could not upload ${f.file} to the R2 bucket: ${f.error}` });
          }
          if (deferred) {
            pushEvent(job, 'info', {
              text: `${deferred} video${deferred === 1 ? '' : 's'} deferred to the next sync; this one ran out its upload budget.`,
            });
          }
          if (uploaded.length || failed.length || deferred) save(job);
        })
        .catch(() => {});
      // How the turn ended goes in with the flush: a parser whose stream never
      // states an outcome of its own (opencode's) closes the turn on this
      // verdict instead of assuming success. The ones that read a result
      // message from their CLI ignore it.
      const outcome = { canceled: job.turnCanceled || job.status === 'closed', code };
      // A stream can report a failed turn the exit code does not: opencode
      // ends 0 after an error it recovered the process from, and a turn the
      // caller is told succeeded is one it will run a publish or a QA
      // follow-up on.
      let streamFailed = false;
      for (const e of parser.flush(outcome)) {
        if (e.kind === 'agent') {
          trackSubagent(job, e);
          continue;
        }
        if (e.kind === 'result' && e.isError) streamFailed = true;
        const { kind, ...data } = e;
        pushEvent(job, kind, data);
      }
      if (turn.sessionId) chat.sessionId = turn.sessionId;
      chat.started = true;
      job.turns++;
      // The session's own provider keeps mirroring into the flat fields: they
      // are what the restore path, the /context probe and the panel read, and
      // a step's provider must not overwrite the conversation they describe.
      if (prov.id === job.providerId) {
        job.providerSessionId = chat.sessionId;
        job.chatStarted = true;
      }
      if (turn.costUsd != null) job.costUsd = (job.costUsd || 0) + turn.costUsd;
      // Cost, time and token consumption accumulate across turns; context is
      // a size, not a sum: the latest turn's number is the session's live
      // context, measured against the model's window. applyTurnUsage adds the
      // turn's tokens onto the pre-turn baseline, so the mid-stream updates
      // above and this final one agree.
      if (turn.durationMs != null) job.durationMs = (job.durationMs || 0) + turn.durationMs;
      applyTurnUsage();
      job.contextWindow =
        turn.contextWindow ?? job.contextWindow ?? contextWindowFor(prov.binary, model, prov);
      save(job);
      emitUsage(job);
      recordTurnUsage(job, turn, prov, model);
      if (job.turnCanceled || job.status === 'closed') {
        pushEvent(job, 'info', { text: 'Turn canceled.' });
        probeContextUsage(job, prov, chat, model).catch(() => {});
        return resolve();
      }
      probeContextUsage(job, prov, chat, model).catch(() => {});
      if (code === 0 && !streamFailed) return resolve();
      reject(
        new Error(
          code === 0 ? `${prov.label} reported a failed turn` : `${prov.label} exited with code ${code}`,
        ),
      );
    });
  });
}
