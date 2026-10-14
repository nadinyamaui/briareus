// @ts-check
import { loadAppSetting, saveAppSetting } from './db.js';
import { activeProjects, reviewerRuntime } from './projects.js';
import { projectPulls, hasLabel, LABELS } from './prboard.js';
import { getAction, actionSessionSpec } from './actions.js';
import { createDevSession, devSessionSlots, pullRequestHasOpenSession } from './jobs.js';

// The PR babysitter: every 15 minutes, for each project with `babysitPrs` on, it
// starts the errand each open pull request needs, the way a developer would from
// the board. Conflicts come first (nothing else matters until the branch can
// merge), then failing checks, then a ⌕ Code review when the board recommends one.
//
// Each errand runs at most once per head commit, remembered in `app_settings` so a
// restart does not repeat them: a review whose labels never change, or a fix that
// did not land, would otherwise start again every tick. A new push re-arms all
// three. A pull request that already has an open session is left to it, and so are
// drafts and stalled ones. Errands that push (conflicts, checks) only touch the
// project's own PR author's pull requests when one is configured, since pushing to
// a colleague's branch unasked is not babysitting.

export const BABYSIT_INTERVAL_MS = 15 * 60 * 1000;
const SETTING = 'babysitter';

function log(message) {
  console.log(`babysitter: ${message}`);
}

// Which errand a board row needs, or null.
export function errandFor(pr, project) {
  if (pr.draft || !pr.headSha || hasLabel(pr.labels, LABELS.stalled)) return null;
  const author = String(project.reviewAuthor || '').toLowerCase();
  const pushes = !author || String(pr.author || '').toLowerCase() === author;
  if (pr.recommended === 'solve-conflicts') return pushes ? 'solve-conflicts' : null;
  if (pr.checks === 'failure' || pr.checks === 'error') return pushes ? 'fix-checks' : null;
  if (pr.recommended === 'review') return 'review';
  return null;
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
    const runtime = reviewerRuntime(project);
    if (!runtime) {
      log(`${project.repo}: no review provider is set in Settings, so nothing was started`);
      return;
    }
    const board = await pulls(project);
    const open = new Set(board.pulls.map((pr) => `${project.repo.toLowerCase()}#${pr.number}`));
    // Forget merged and closed pull requests so the setting stays small.
    for (const key of Object.keys(handled)) {
      if (key.startsWith(`${project.repo.toLowerCase()}#`) && !open.has(key)) delete handled[key];
    }
    for (const pr of board.pulls) {
      const errand = errandFor(pr, project);
      if (!errand) continue;
      const key = `${project.repo.toLowerCase()}#${pr.number}`;
      if (handled[key] && handled[key][errand] === pr.headSha) continue;
      if (hasSession(project.repo, pr.number, pr.branch)) continue;
      // A full pool refuses every start; the next tick tries again.
      if (slots(project.repo) <= 0) {
        log(`${project.repo}: no session slot free; the rest wait for the next round`);
        return;
      }
      try {
        await start(errand, project, pr, runtime);
        handled[key] = { ...handled[key], [errand]: pr.headSha };
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

// Starts one errand on the project's review runtime, as the board's buttons would.
async function startErrand(errand, project, pr, runtime) {
  const run = { provider: runtime.providerId, model: runtime.model, effort: runtime.effort };
  if (errand === 'review') {
    createDevSession({ ...run, repo: project.repo, branch: pr.branch, review: true, prNumber: pr.number });
    return;
  }
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
