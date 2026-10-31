// @ts-check
import { loadAppSetting, saveAppSetting } from './db.js';
import { activeProjects, actionRuntime } from './projects.js';
import { projectPulls, hasLabel, recommend, LABELS } from './prboard.js';
import { getAction, actionSessionSpec } from './actions.js';
import { createDevSession, devSessionSlots, pullRequestHasOpenSession } from './jobs.js';

// The PR babysitter: every 15 minutes, for each project with `babysitPrs` on, it
// starts the errand each open pull request needs, the way a developer would from
// the board: conflicts first, then failing checks, then a 🔎 Code review when the
// board recommends one. Each errand runs at most once per head commit, remembered
// in `app_settings`, so a review that failed or left the labels as they were does
// not start again every tick; a new push re-arms all three. Errands that push only
// touch the project's own PR author's pull requests when one is configured; a
// review pushes nothing, so it runs on everyone's, at most MAX_REVIEWS_PER_TICK
// per project each round.

export const BABYSIT_INTERVAL_MS = 15 * 60 * 1000;
export const MAX_PUSH_ERRANDS = 3;
// A project without a DB pool has no slot limit, so this alone stops a backlog of
// unreviewed PRs from starting a review session each in the same round.
export const MAX_REVIEWS_PER_TICK = 3;
const SETTING = 'babysitter';
const PUSHING = ['solve-conflicts', 'fix-checks'];

function log(message) {
  console.log(`babysitter: ${message}`);
}

// Whether a pull request is green (or has no checks at all) and free of conflicts.
// Pending checks are not settled, or slow CI would reset the count every tick.
function settled(pr) {
  return (pr.checks === 'success' || pr.checks == null) && pr.recommended !== 'solve-conflicts';
}

// The errands a board row needs, in the order to try them; empty when none.
export function errandsFor(pr, project) {
  if (pr.draft || pr.crossRepository || !pr.headSha || hasLabel(pr.labels, LABELS.stalled)) return [];
  const author = String(project.prAuthor || '').toLowerCase();
  const pushes = !author || String(pr.author || '').toLowerCase() === author;
  const errands = [];
  if (pushes && pr.recommended === 'solve-conflicts') errands.push('solve-conflicts');
  if (pushes && (pr.checks === 'failure' || pr.checks === 'error')) errands.push('fix-checks');
  // What the board would recommend without the conflict, so a conflict that is not
  // ours to solve, or one already tried on this head, does not hide the review.
  const labels = (pr.labels || []).filter((l) => !hasLabel([l], LABELS.conflicts));
  if (recommend({ conflicting: false, labels }) === 'review') errands.push('review');
  return errands;
}

// Dependencies are injected so the tests drive a tick without GitHub or sessions.
export function createBabysitter({
  projects = () => activeProjects(),
  pulls = (project) => projectPulls(project, { fresh: true }),
  hasSession = pullRequestHasOpenSession,
  slots = devSessionSlots,
  start = startErrand,
  load = () => loadAppSetting(SETTING, {}),
  save = (value) => saveAppSetting(SETTING, value),
} = {}) {
  let running = null;

  async function babysit(project, handled) {
    const runtime = actionRuntime(project);
    if (!runtime) {
      log(`${project.repo}: no action provider is set in Settings, so nothing was started`);
      return;
    }
    const board = await pulls(project);
    const open = new Set(board.pulls.map((pr) => `${project.repo.toLowerCase()}#${pr.number}`));
    // Forget merged and closed pull requests so the setting stays small.
    for (const key of Object.keys(handled)) {
      if (key.startsWith(`${project.repo.toLowerCase()}#`) && !open.has(key)) delete handled[key];
    }
    let reviews = 0;
    for (const pr of board.pulls) {
      const key = `${project.repo.toLowerCase()}#${pr.number}`;
      let seen = handled[key] || {};
      // A green, mergeable head ends the run of push errands.
      if (seen.pushes && settled(pr)) seen = handled[key] = { ...seen, pushes: 0 };
      const capped = (seen.pushes || 0) >= MAX_PUSH_ERRANDS;
      const errand = errandsFor(pr, project).find(
        (e) => seen[e] !== pr.headSha && !(capped && PUSHING.includes(e)),
      );
      if (!errand) continue;
      // Past the cap only reviews wait; push errands further down still start.
      if (errand === 'review' && reviews >= MAX_REVIEWS_PER_TICK) continue;
      if (hasSession(project.repo, pr.number, pr.branch)) continue;
      // A full pool refuses every start; the next tick tries again.
      if (slots(project.repo) <= 0) {
        log(`${project.repo}: no session slot free; the rest wait for the next round`);
        return;
      }
      try {
        await start(errand, project, pr, runtime);
        if (errand === 'review') reviews++;
        handled[key] = {
          ...seen,
          [errand]: pr.headSha,
          ...(PUSHING.includes(errand) ? { pushes: (seen.pushes || 0) + 1 } : {}),
        };
        log(`${project.repo}#${pr.number}: started ${errand} on ${pr.headSha.slice(0, 7)}`);
      } catch (e) {
        log(`${project.repo}#${pr.number}: could not start ${errand}: ${e.message}`);
      }
    }
  }

  async function tick() {
    // A slow round (GitHub, many projects) must not overlap the next one.
    if (running) return running;
    running = (async () => {
      const chosen = projects().filter((p) => p.enabled && p.babysitPrs);
      if (!chosen.length) return;
      const handled = (await load()) || {};
      for (const project of chosen) {
        try {
          await babysit(project, handled);
        } catch (e) {
          log(`${project.repo}: ${e.message}`);
        }
      }
      await save(handled);
    })()
      .catch((e) => log(e.message))
      .finally(() => {
        running = null;
      });
    return running;
  }

  function startTimer(intervalMs = BABYSIT_INTERVAL_MS) {
    setInterval(tick, intervalMs).unref();
  }

  return { tick, startTimer };
}

export async function startErrand(errand, project, pr, runtime) {
  const run = { provider: runtime.providerId, model: runtime.model, effort: runtime.effort };
  const action = getAction(errand);
  if (!action) throw new Error(`Unknown action: ${errand}`);
  const context = {
    repo: project.repo,
    prNumber: pr.number,
    branch: pr.branch,
    baseBranch: pr.baseBranch || '',
    title: pr.title || '',
    project,
    input: '',
  };
  createDevSession({ ...run, ...(await actionSessionSpec(action, context)) });
}
