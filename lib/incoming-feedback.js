// @ts-check
// Shares Babysit PRs' opt-in and reviewer runtime, but always stops at manual triage.
import { loadAppSetting, saveAppSetting } from './db.js';
import { activeProjects } from './projects.js';
import { hasLabel, LABELS } from './prboard.js';
import {
  createDevSession,
  devSessionSlots,
  pullRequestHasOpenSession,
  pendingFeedbackAssessment,
  flushJobs,
} from './jobs.js';
import {
  readFeedbackSnapshot,
  externalFeedbackRevisions,
  feedbackAssessmentSpec,
} from './feedback-assessment.js';

const SETTING = 'incoming-feedback';
const MAX_ATTEMPTS = 3;

export function createIncomingFeedback({
  projects = activeProjects,
  read = readFeedbackSnapshot,
  pending = pendingFeedbackAssessment,
  busy = pullRequestHasOpenSession,
  slots = devSessionSlots,
  start = createDevSession,
  persist = flushJobs,
  load = () => loadAppSetting(SETTING, {}),
  save = (value) => saveAppSetting(SETTING, value),
} = {}) {
  // Serialize polling and webhook deliveries, including the durable dedup writes.
  let tail = Promise.resolve();
  const serial = (fn) => {
    const next = tail.then(fn);
    tail = next.catch(() => {});
    return next;
  };

  async function assess(project, pr, force) {
    const author = String(project.reviewAuthor || '')
      .trim()
      .toLowerCase();
    if (
      !project.enabled ||
      !project.babysitPrs ||
      !author ||
      String(pr.author || '').toLowerCase() !== author ||
      pr.draft ||
      pr.crossRepository ||
      hasLabel(pr.labels, LABELS.stalled)
    )
      return false;
    const key = `${project.repo.toLowerCase()}#${pr.number}`;
    if (force) {
      // Preserve a webhook nudge while a session/card blocks intake, including
      // multiple reviews within GitHub's one-second updatedAt resolution.
      const dirty = (await load()) || {};
      dirty[key] = { ...dirty[key], updatedAt: null };
      await save(dirty);
    }
    // A held card is already the user's decision, including after a server restart.
    if (pending(project.repo, pr.number)) return true;
    if (busy(project.repo, pr.number, pr.branch)) return false;
    const state = (await load()) || {};
    const seen = state[key] || {};
    if (!force && pr.updatedAt && seen.updatedAt === pr.updatedAt) return false;
    const snapshot = await read(project.repo, pr.number);
    if (
      snapshot.author.toLowerCase() !== author ||
      snapshot.draft ||
      hasLabel(snapshot.labels, LABELS.stalled)
    )
      return false;
    const revisions = externalFeedbackRevisions(snapshot);
    const unseen = revisions.filter((r) => seen.reviews?.[r.id] !== r.revision);
    if (unseen.length) {
      const retryable = unseen.filter((r) => {
        const attempt = seen.attempts?.[r.id];
        return (
          attempt?.sha !== snapshot.sha || attempt?.revision !== r.revision || attempt.count < MAX_ATTEMPTS
        );
      });
      // Webhooks do not reset the budget for unchanged evidence. The explicit
      // Implement feedback action can still retry without automatic intake.
      if (!retryable.length) return false;
      // Do not consume the review while capacity is full: polling retries later.
      if (slots(project.repo) <= 0) return true;
      // Recheck after the GitHub reads: a manual click may have claimed the PR meanwhile.
      if (pending(project.repo, pr.number) || busy(project.repo, pr.number, snapshot.branch)) return true;
      // Reserve the attempt durably before dispatch, including asynchronous
      // output failures and restarts. Consumption remains completion-only.
      state[key] = { ...seen, attempts: { ...seen.attempts } };
      for (const r of retryable) {
        const previous = seen.attempts?.[r.id];
        state[key].attempts[r.id] = {
          sha: snapshot.sha,
          revision: r.revision,
          count: previous?.sha === snapshot.sha && previous?.revision === r.revision ? previous.count + 1 : 1,
        };
      }
      await save(state);
      await start(
        feedbackAssessmentSpec(
          project,
          snapshot,
          retryable.flatMap((r) => r.sources),
        ),
      );
      await persist();
      // Dispatch is not completion. Pending sessions prevent duplicate starts;
      // only a validated assessment consumes its revisions; failures retry up to the budget.
      return true;
    }
    state[key] = {
      updatedAt: pr.updatedAt || null,
      reviews: Object.fromEntries(revisions.map((r) => [r.id, r.revision])),
    };
    await save(state);
    return !!unseen.length;
  }

  return {
    assess: (project, pr) => serial(() => assess(project, pr, false)),
    remember: (snapshot) =>
      serial(async () => {
        if (!snapshot.completed) return;
        const state = (await load()) || {};
        const key = `${snapshot.repo.toLowerCase()}#${snapshot.prNumber}`;
        const seen = state[key] || {};
        state[key] = {
          ...seen,
          reviews: {
            ...seen.reviews,
            ...Object.fromEntries(externalFeedbackRevisions(snapshot).map((r) => [r.id, r.revision])),
          },
        };
        await save(state);
      }),
    reviewEvent: (repo, payload) =>
      serial(async () => {
        if (!['submitted', 'edited', 'created'].includes(payload.action)) return;
        const project = projects().find((p) => p.repo.toLowerCase() === repo.toLowerCase());
        if (!project) return;
        const pr = payload.pull_request;
        if (!pr?.number) return;
        // Read the canonical review and PR before spending anything; payload bodies
        // are never prompts and labels/verdicts are not interpreted as permission to fix.
        await assess(
          project,
          {
            number: pr.number,
            branch: pr.head?.ref,
            author: pr.user?.login,
            updatedAt: pr.updated_at,
            draft: pr.draft,
            labels: pr.labels,
            crossRepository: pr.head?.repo?.full_name?.toLowerCase() !== repo.toLowerCase(),
          },
          true,
        );
      }),
  };
}

let shared;
export function incomingFeedback() {
  return (shared ||= createIncomingFeedback());
}
