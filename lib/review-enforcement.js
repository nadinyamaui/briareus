// @ts-check
// Keeps a pull request's review outcome (lib/review-outcome.js) and, for a project that
// enforces it, makes GitHub carry it as a commit status a repository can require.
//
// The outcome is read from the store and computed again whenever something it depends
// on changes: a review starts or ends, a client changes a finding's verdict, a review
// is refused at the round limit. A project that does not enforce it still gets it
// computed and stored, so its owner can see what would block before requiring anything;
// nothing is written to GitHub and the review's own steps run as they always did.
//
// The status is the server's to write, never the agent's, and it is written so that a
// failure cannot leave GitHub saying "passed" for something that is not:
//
// - It goes on the head the outcome is for. A head the server has not judged carries no
//   status from here, which a required check reads as not met.
// - A review that starts posts `pending` on its head before anything else, so a
//   success an earlier review left on that same head stops counting while it runs.
// - `success` is the last thing written: after every stage, after the label step was
//   held against the outcome, and only for an outcome stored as passed.
// - What GitHub is known to carry is recorded apart from what it should carry, and
//   only an answer from GitHub makes it known: from the moment a write is sent until
//   its answer arrives the record says "unknown", so a write that landed while its
//   answer was lost is never mistaken for one that did not. While the two differ, or
//   the record is unknown, the outcome is reported as not published.
// - The status a stored outcome owes is a debt on its row, written in the outcome's own
//   transaction, and a sweep pays whatever is owed: a write that failed, one that was
//   never made because the server stopped first, an outcome that could not be computed
//   again when its evidence changed.
// - Before it concludes that GitHub already carries a status, it reads the commit's
//   statuses back: a status under this context written by anything else is replaced.
//
// What this cannot do is withdraw a status GitHub will not let it replace: if a write
// fails for good (the token lost its permission, say) an older status stays on the
// commit. The stored outcome then says so, and that is what the API reports. Nor can it
// stop another holder of a token that may write statuses from writing one under this
// context between two of its own checks.
import { asGithubUser, githubRest } from './github.js';
import {
  dropCodeReviewStatusDebt,
  getCodeReviewOutcome,
  listCodeReviewOutcomesDue,
  listFailedCodeReviewStatuses,
  markCodeReviewOutcomeStale,
  markCodeReviewStatusSending,
  markRepoCodeReviewOutcomesStale,
  readCodeReviewOutcomeState,
  recordCodeReviewStatusFailed,
  recordCodeReviewStatusPublished,
  refreshCodeReviewOutcome,
} from './db.js';
import { STATUS_CONTEXT, computeReviewOutcome, statusFor } from './review-outcome.js';
import { roundLimitOf, securityClaims, settledClaims, unresolvedWork } from './review-rounds.js';
import { computeSecurityResult, securityPolicyOf, securityRequirement } from './review-security.js';

// Whether the project publishes the outcome and holds the label step to it. Off unless
// it was switched on: requiring a status is a decision about a repository.
export function enforcesOutcome(project) {
  return project?.enforceReviewOutcome === true;
}

/**
 * The outcome of what the store holds for a pull request.
 * @param {any} state from lib/db.js (readCodeReviewOutcomeState, refreshCodeReviewOutcome)
 * @param {{ project: any, current?: { headSha?: string | null, baseRef?: string | null } | null, provisional?: boolean }} p
 * `current` is the pull request's revision when the caller has just read it; without
 * one, the revision the server last saw (the outcome row), else the reviewed one.
 */
export function outcomeOf(state, { project, current = null, provisional = false }) {
  const limit = roundLimitOf(project);
  const used = state.count?.rounds || 0;
  const seen = {
    headSha: current?.headSha || state.row?.headSha || null,
    baseRef: current?.baseRef || state.row?.baseRef || null,
  };
  const evidence = {
    review: state.review,
    stages: state.stages,
    findings: state.findings,
    standing: { ...unresolvedWork(state.decisions), settled: settledClaims(state.decisions) },
    current: seen,
    provisional,
  };
  // The security pass is judged from the same records (lib/review-security.js) and
  // reaches the outcome only as a requirement, and only for a project that requires it:
  // everything that follows from the outcome (the status, the label step) then follows
  // from the security result too, with nothing of its own to remember.
  const security = computeSecurityResult({
    ...evidence,
    policy: securityPolicyOf(project),
    addressed: securityClaims(state.decisions).filter((claim) => claim.status === 'addressed'),
  });
  const required = securityRequirement(security);
  return {
    ...computeReviewOutcome({
      ...evidence,
      rounds: { limit, used, limitReached: limit > 0 && used >= limit },
      requirements: required ? [required] : [],
    }),
    security,
  };
}

/**
 * One stored review's own security result, for a client reading that review: its pass
 * and its findings as they stand now, under the project's policy as it stands now.
 * `decisions` are the pull request's, which say whether the earlier decision a
 * suppressed finding rests on is itself established.
 * @param {any} project @param {any} review a review with its `findings` and `stages`
 * @param {any[]} decisions
 */
export function reviewSecurity(project, { findings = [], stages = [], ...review }, decisions) {
  return computeSecurityResult({
    policy: securityPolicyOf(project),
    review,
    stages,
    findings,
    standing: { ...unresolvedWork(decisions), settled: settledClaims(decisions) },
    own: true,
  });
}

const publicStage = ({ codeReviewId: _review, ...stage }) => stage;

/**
 * The outcome as a client reads it, with what GitHub carries of it.
 * @param {any} state @param {ReturnType<typeof outcomeOf>} result @param {any} project
 */
function outcomeView(state, result, project) {
  const { counts: _counts, reviewed, security, ...outcome } = result;
  const status = statusFor(result);
  const row = state.row;
  const enforced = enforcesOutcome(project);
  const round =
    state.review && reviewed
      ? state.rounds.find((r) => r.round === state.review.round && r.headSha === reviewed.headSha) || null
      : null;
  return {
    ...outcome,
    // The revision the review covered; `headSha` and `baseRef` above are the pull
    // request's as the server last saw it, and `stale` says they differ.
    reviewed: reviewed
      ? {
          ...reviewed,
          baseSha: round?.baseSha ?? null,
          mergeBaseSha: round?.mergeBaseSha ?? null,
          round: state.review.round ?? null,
        }
      : null,
    // Whether the session ran to its end, which is not the outcome.
    execution: state.review?.status ?? null,
    stages: state.stages.map(publicStage),
    // What the review's security pass amounts to, whether or not it counts here.
    security,
    enforced,
    status: {
      context: STATUS_CONTEXT,
      sha: result.headSha,
      ...status,
      // True only when GitHub is known to carry exactly this status for this head: it
      // answered that it took it, and nothing was sent since. An outcome is enforced on
      // GitHub when the project enforces it and this is true.
      published:
        enforced &&
        !!result.headSha &&
        !!row?.publishedConfirmed &&
        row.publishedSha === result.headSha &&
        row.publishedState === status.state &&
        row.publishedDescription === status.description,
      // What GitHub last confirmed. With `publishedConfirmed` false a write was sent
      // since and never answered, so the commit may carry that one instead.
      publishedConfirmed: !!row?.publishedConfirmed,
      publishedSha: row?.publishedSha ?? null,
      publishedState: row?.publishedState ?? null,
      publishedAt: row?.publishedAt ?? null,
      error: row?.publishError ?? null,
      errorStatus: row?.publishErrorStatus ?? null,
      attempts: row?.publishAttempts ?? 0,
      failedAt: row?.publishFailedAt ?? null,
      retryAt: row?.publishRetryAt ?? null,
    },
  };
}

/**
 * A pull request's outcome for an answer to a client: computed now from what is stored,
 * nothing written, GitHub not asked. `current` is the PR's revision when the caller
 * happens to have read it.
 * @param {any} project @param {number} prNumber
 * @param {{ current?: { headSha?: string | null, baseRef?: string | null } | null }} [options]
 */
export async function readReviewOutcome(project, prNumber, { current = null } = {}) {
  const state = await readCodeReviewOutcomeState(project.repo, prNumber);
  return outcomeView(state, outcomeOf(state, { project, current }), project);
}

/**
 * The reading a review's label step is given and then held to: this review's outcome
 * as if it had ended, without that step. Nothing is stored; the review is still running.
 * @param {any} project @param {number} prNumber
 * @param {{ reviewId: number | null, current?: { headSha?: string | null, baseRef?: string | null } | null }} options
 */
export async function provisionalReviewOutcome(project, prNumber, { reviewId, current = null }) {
  const state = await readCodeReviewOutcomeState(project.repo, prNumber, { reviewId });
  // Not this session's review: it kept no record, or its row is gone, and another
  // review's evidence is not this one's to label on.
  if (!reviewId || state.review?.id !== reviewId)
    return outcomeOf({ ...state, review: null }, { project, current });
  return outcomeOf(state, { project, current, provisional: true });
}

// Outcomes whose recomputation failed and could not even be marked as owed in the store
// (the database was the problem): kept here until the sweep gets one through.
const owedRecomputes = new Map(); // `repo#pr`, lowercased -> { repo, prNumber }
const keyOf = (repo, prNumber) => `${repo}#${prNumber}`.toLowerCase();

// The outcome could not be computed and stored when it should have been. Until it is,
// the stored outcome and the status GitHub carries are those of older evidence, so the
// recomputation is owed: on the row when that can be written, and in memory either way.
async function oweReviewOutcome(project, prNumber) {
  owedRecomputes.set(keyOf(project.repo, prNumber), { repo: project.repo, prNumber });
  await markCodeReviewOutcomeStale(project.repo, prNumber).catch(() => {});
}

/**
 * Compute a pull request's outcome again, store it, and for an enforcing project bring
 * its commit status in line. Resolves with the outcome as a client reads it once it is
 * stored; `published` settles when the status write was tried, and never rejects. When
 * the outcome cannot be stored this rejects, and the recomputation stays owed: the sweep
 * (retryReviewStatuses) tries it again.
 * @param {any} project @param {number} prNumber
 * @param {{
 *   cfg: { githubToken?: string }, reviewId?: number | null,
 *   current?: { headSha?: string | null, baseRef?: string | null } | null,
 *   retryDelayMs?: number, now?: () => number,
 * }} options
 * `reviewId` makes that review the one the outcome is computed from, which a discovery
 * run does when it starts.
 */
export async function refreshReviewOutcome(
  project,
  prNumber,
  { cfg, reviewId = null, current = null, retryDelayMs, now },
) {
  let result;
  let state;
  try {
    state = await refreshCodeReviewOutcome(project.repo, prNumber, { reviewId }, (read) => {
      result = outcomeOf(read, { project, current });
      const status = statusFor(result);
      return {
        outcome: result.outcome,
        stale: result.stale,
        reasons: result.reasons,
        headSha: result.headSha,
        baseRef: result.baseRef,
        statusState: status.state,
        statusDescription: status.description,
        // Kept with the outcome it was computed beside, policy included.
        security: result.security,
        // In the same transaction as the outcome: from here GitHub is owed its status.
        owed: enforcesOutcome(project),
      };
    });
  } catch (e) {
    await oweReviewOutcome(project, prNumber);
    throw e;
  }
  owedRecomputes.delete(keyOf(project.repo, prNumber));
  const published = publishReviewStatus(project, prNumber, { cfg, retryDelayMs, now }).catch((e) => {
    console.error(`Code review status for ${project.repo}#${prNumber}: ${e.message}`);
    return null;
  });
  return { outcome: outcomeView(state, result, project), published };
}

/**
 * A setting the project's outcomes depend on changed. Mark every stored outcome for
 * recomputation, without consulting the board: its cache can omit a reviewed PR, and
 * a cold cache can require a slow GitHub fetch while the project edit lock is held.
 * A closed PR may get a redundant recomputation; missing an open PR could leave an
 * obsolete success in place. Only PRs with a stored outcome are marked.
 * @param {any} project
 * @returns {Promise<number>} how many outcomes were marked
 */
export async function oweProjectOutcomes(project) {
  return markRepoCodeReviewOutcomesStale(project.repo);
}

/**
 * The server saw a pull request at this revision: a webhook delivered it or a session
 * read it. When that is not the revision the stored outcome
 * is for, the outcome is computed again for it, so a push or a retarget of a reviewed
 * pull request turns its outcome stale and puts `pending` on the head it has now.
 * Without this a retarget would change nothing: the head, and the `success` on it,
 * stay the same, for a base branch nobody reviewed against.
 *
 * The same goes for the project's security policy: an outcome computed under another
 * policy than the project has now is computed again, so switching a project to
 * `required` does not leave a pull request reading as passed on a pass that never ran.
 *
 * Nothing happens for a pull request no review has a record of. Resolves with what
 * refreshReviewOutcome answers, or null when there was nothing to do.
 * @param {any} project @param {number} prNumber
 * @param {{ headSha?: string | null, baseRef?: string | null }} revision
 * @param {{ cfg: { githubToken?: string }, retryDelayMs?: number }} options
 */
export async function noteReviewedRevision(project, prNumber, { headSha, baseRef = null }, options) {
  if (!project || !headSha || !Number.isInteger(prNumber)) return null;
  const row = await getCodeReviewOutcome(project.repo, prNumber);
  if (!row) return null;
  const sameRevision = row.headSha === headSha && (!baseRef || row.baseRef === baseRef);
  if (sameRevision && !row.recomputeAt && (row.securityPolicy || 'off') === securityPolicyOf(project))
    return null;
  return refreshReviewOutcome(project, prNumber, { ...options, current: { headSha, baseRef } });
}

// ---- the commit status ----

// A write that fails in passing is tried again at once, like the review's history read
// (lib/review-history.js); what still fails is recorded and tried again later.
const WRITE_ATTEMPTS = 3;
const RETRY_DELAY_MS = 1000;
// Between later attempts: a minute, doubling, up to an hour. A refusal (a token without
// the permission) is retried too, at that pace: it ends when somebody fixes the token.
const RETRY_FIRST_MS = 60_000;
const RETRY_MAX_MS = 3_600_000;
// A status GitHub will not accept for the commit (422: the commit is gone from the
// repository, or it already holds the thousand statuses a context may have) is not
// changed by asking again. Tried this many times in case the commit was only not there
// yet, then left: the failure stays on the outcome for a person to see.
export const UNPROCESSABLE_ATTEMPTS = 5;

export function statusRetryDelay(attempts) {
  return Math.min(RETRY_FIRST_MS * 2 ** Math.min(Math.max(attempts, 0), 10), RETRY_MAX_MS);
}

const REFUSED = {
  401: 'the server’s GitHub token was not accepted',
  403: 'the server’s GitHub token may not write commit statuses on this repository (a classic token needs `repo:status`, a fine-grained one "Commit statuses: write")',
  404: 'the server’s GitHub token cannot see this repository or may not write commit statuses on it (a classic token needs `repo:status`, a fine-grained one "Commit statuses: write")',
  422: 'GitHub refused the status for this commit',
};

async function postStatus(cfg, repo, sha, body, retryDelayMs) {
  for (let attempt = 1; ; attempt++) {
    /** @type {any} */
    let failure;
    try {
      const res = await githubRest(cfg, 'POST', `/repos/${repo}/statuses/${sha}`, body);
      if (res.ok) return;
      const said = await res
        .json()
        .then((answer) => answer?.message)
        .catch(() => null);
      failure = Object.assign(
        new Error(
          `GitHub answered ${res.status}${said ? ` (${said})` : ''}${REFUSED[res.status] ? `: ${REFUSED[res.status]}` : ''}`,
        ),
        { status: res.status },
      );
    } catch (e) {
      failure = e;
    }
    // A refusal and a rate limit do not pass by trying again now.
    const refused = failure.rateLimited || (failure.status >= 400 && failure.status < 500);
    if (refused || attempt >= WRITE_ATTEMPTS) throw failure;
    await new Promise((resolve) => setTimeout(resolve, retryDelayMs * attempt));
  }
}

// The status the commit carries under this context right now, or null for none: GitHub
// lists a commit's statuses newest first, and the newest of a context is the one that
// counts. Throws when it cannot be read.
async function carriedStatus(cfg, repo, sha) {
  const res = await githubRest(cfg, 'GET', `/repos/${repo}/commits/${sha}/statuses?per_page=100`);
  if (!res.ok) throw new Error(`GitHub answered ${res.status} reading the statuses of ${sha.slice(0, 7)}`);
  const statuses = await res.json();
  if (!Array.isArray(statuses)) throw new Error('GitHub answered no list of statuses');
  const mine = statuses.find((status) => status?.context === STATUS_CONTEXT);
  return mine ? { state: mine.state, description: mine.description ?? '' } : null;
}

// One publication per pull request at a time, each reading the row when its turn comes:
// two outcomes computed close together reach GitHub in the order they were stored, and
// the later one never loses to an earlier write that was slower.
const publishing = new Map(); // `repo#pr`, lowercased -> the last publication queued

/**
 * Make GitHub carry the stored outcome's status on the head it is for. Does nothing
 * when the project does not enforce the outcome. It posts unless GitHub is known to
 * carry exactly that status for that head, and "known" is held to what GitHub itself
 * said: the record must be confirmed (no write sent since the last answer), and the
 * commit's statuses are read back and must still show it. So a write whose answer was
 * lost, and a status somebody else wrote under this context, are both written over
 * rather than trusted, while posting the same status twice in a row does not happen by
 * itself. A read-back that fails posts: the same status twice reads as one.
 *
 * Resolves with `{ published, skipped?, error? }`. The row is marked unconfirmed before
 * the write goes out; a failure is recorded on it with when to try again.
 * @param {any} project @param {number} prNumber
 * @param {{ cfg: { githubToken?: string }, retryDelayMs?: number, now?: () => number }} options
 */
export function publishReviewStatus(
  project,
  prNumber,
  { cfg, retryDelayMs = RETRY_DELAY_MS, now = Date.now },
) {
  const key = keyOf(project.repo, prNumber);
  const run = async () => {
    const row = await getCodeReviewOutcome(project.repo, prNumber);
    if (!row) return { published: false, skipped: 'no_outcome' };
    const owes = row.publishFailedAt || row.publishOwedAt;
    if (!enforcesOutcome(project)) {
      if (owes) await dropCodeReviewStatusDebt(project.repo, prNumber);
      return { published: false, skipped: 'not_enforced' };
    }
    if (!row.headSha || !row.statusState) {
      if (owes) await dropCodeReviewStatusDebt(project.repo, prNumber);
      return { published: false, skipped: 'no_head' };
    }
    const status = { sha: row.headSha, state: row.statusState, description: row.statusDescription || '' };
    const post = () =>
      // Always as the server, also when a client's request led here: a repository
      // requires this status from one account, not from whoever changed a verdict.
      asGithubUser(null, () =>
        postStatus(
          cfg,
          project.repo,
          status.sha,
          { state: status.state, context: STATUS_CONTEXT, description: status.description },
          retryDelayMs,
        ),
      );
    try {
      if (!cfg.githubToken) throw new Error('No GITHUB_TOKEN is configured');
      if (
        row.publishedConfirmed &&
        row.publishedSha === status.sha &&
        row.publishedState === status.state &&
        row.publishedDescription === status.description
      ) {
        const carried = await asGithubUser(null, () => carriedStatus(cfg, project.repo, status.sha)).catch(
          () => undefined,
        );
        if (carried && carried.state === status.state && carried.description === status.description) {
          if (owes) await recordCodeReviewStatusPublished(project.repo, prNumber, status, { posted: false });
          return { published: true, skipped: 'unchanged' };
        }
      }
      await markCodeReviewStatusSending(project.repo, prNumber);
      await post();
    } catch (e) {
      // Not accepted for this commit, whatever is asked: given up after a few attempts.
      const gaveUp = e.status === 422 && row.publishAttempts + 1 >= UNPROCESSABLE_ATTEMPTS;
      const retryAt = gaveUp
        ? null
        : e.rateLimited && e.retryAt
          ? e.retryAt
          : now() + statusRetryDelay(row.publishAttempts);
      await recordCodeReviewStatusFailed(
        project.repo,
        prNumber,
        {
          error: e.message,
          status: Number.isInteger(e.status) ? e.status : null,
          retryAt,
        },
        status,
      );
      return { published: false, error: e.message, ...(gaveUp ? { gaveUp: true } : {}) };
    }
    await recordCodeReviewStatusPublished(project.repo, prNumber, status);
    return { published: true };
  };
  const queued = (publishing.get(key) || Promise.resolve()).then(run, run);
  publishing.set(key, queued);
  const done = () => {
    if (publishing.get(key) === queued) publishing.delete(key);
  };
  queued.then(done, done);
  return queued;
}

// One sweep at a time: a sweep that outlasts the timer's interval (GitHub slow to answer
// many writes) must not be joined by a second one working the same rows.
let sweeping = false;

/**
 * Pay what is owed, as far as it is due: compute again the outcomes whose recomputation
 * did not land, and make GitHub carry the statuses it does not: a write that failed, and
 * one that was never made because the server stopped between storing the outcome and
 * sending it. Run at boot and on a timer (server.js), so none of that is left to the
 * next thing that happens to the pull request.
 *
 * What nobody is owed any more is dropped instead of retried forever: the debt of a
 * project that is gone, and a failing status of a pull request that has closed (a first
 * attempt is always made; `isOpen` failing reads as open).
 * @param {{
 *   getProject: (repo: string) => any, cfg: { githubToken?: string }, now?: () => number, retryDelayMs?: number,
 *   isOpen?: (project: any, prNumber: number) => Promise<boolean>,
 * }} deps
 */
export async function retryReviewStatuses({
  getProject,
  cfg,
  now = Date.now,
  retryDelayMs,
  isOpen = async () => true,
}) {
  if (sweeping) return [];
  sweeping = true;
  const results = [];
  try {
    const due = await listCodeReviewOutcomesDue({ now: now() });
    const listed = new Set(due.map((row) => keyOf(row.repo, row.prNumber)));
    const work = [
      ...[...owedRecomputes.entries()]
        .filter(([key]) => !listed.has(key))
        .map(([, owed]) => ({ ...owed, recomputeAt: true, publishFailedAt: null })),
      ...due,
    ];
    for (const row of work) {
      const key = keyOf(row.repo, row.prNumber);
      // One under way already reads the row when its turn comes.
      if (publishing.has(key)) continue;
      const result = { repo: row.repo, prNumber: row.prNumber };
      try {
        const project = getProject(row.repo);
        if (!project || (row.publishFailedAt && !(await isOpen(project, row.prNumber).catch(() => true)))) {
          owedRecomputes.delete(key);
          await dropCodeReviewStatusDebt(row.repo, row.prNumber);
          results.push({ ...result, published: false, skipped: project ? 'closed' : 'no_project' });
          continue;
        }
        const published = row.recomputeAt
          ? await (
              await refreshReviewOutcome(project, row.prNumber, { cfg, now, retryDelayMs })
            ).published
          : await publishReviewStatus(project, row.prNumber, { cfg, now, retryDelayMs });
        results.push({ ...result, ...(published || { published: false }) });
      } catch (e) {
        console.error(`Code review status for ${row.repo}#${row.prNumber}: ${e.message}`);
        results.push({ ...result, published: false, error: e.message });
      }
    }
  } finally {
    sweeping = false;
  }
  return results;
}

/**
 * The pull requests whose outcome GitHub does not carry because the status could not be
 * written: what waits on a person when a token lost its permission (lib/attention.js).
 * @param {{ getProject: (repo: string) => any, isOpen?: (project: any, prNumber: number) => Promise<boolean> }} deps
 */
export async function reviewStatusFailures({ getProject, isOpen = async () => true }) {
  const failing = [];
  for (const row of await listFailedCodeReviewStatuses()) {
    const project = getProject(row.repo);
    if (!project || !enforcesOutcome(project)) continue;
    if (!(await isOpen(project, row.prNumber).catch(() => true))) continue;
    failing.push({
      repo: project.repo,
      prNumber: row.prNumber,
      headSha: row.headSha,
      outcome: row.outcome,
      state: row.statusState,
      publishedSha: row.publishedSha,
      publishedState: row.publishedState,
      publishedConfirmed: row.publishedConfirmed,
      error: row.publishError,
      errorStatus: row.publishErrorStatus,
      attempts: row.publishAttempts,
      failedAt: row.publishFailedAt,
      retryAt: row.publishRetryAt,
    });
  }
  return failing;
}

/**
 * Whether a review's findings are closed to the review itself: for a project that
 * enforces the outcome, from its label step on. That step is told the outcome and why,
 * and must not be able to answer by writing the missing evidence itself.
 *
 * Read from both places the start of that step is kept, and either is enough: the stage
 * record, and the session, which notes when the step started before its prompt exists.
 * So a stage write that failed does not leave the findings open. A failure to read the
 * record rejects, and the caller refuses the write.
 * @param {{
 *   project: any, review: { id: number, headSha?: string | null },
 *   session?: { codeReviewRecord?: { head?: string, labelAt?: number } | null } | null,
 *   listStages: (reviewId: number) => Promise<any[]>,
 * }} p
 */
export async function reviewFindingsFrozen({ project, review, session = null, listStages }) {
  if (!enforcesOutcome(project)) return false;
  const record = session?.codeReviewRecord;
  if (record?.labelAt && (!review.headSha || record.head === review.headSha)) return true;
  return (await listStages(review.id)).some((s) => s.stage === 'label' && s.status !== 'pending');
}

// ---- the label step ----

const REVIEWS_PAGE = 100;
// GitHub's clock and this server's are not the same clock.
const CLOCK_SLACK_MS = 60_000;
// Far more reviews than a pull request gets; past it the check says it could not finish.
const MAX_REVIEW_PAGES = 10;

async function readJson(cfg, url, what) {
  const res = await githubRest(cfg, 'GET', url);
  if (!res.ok) throw new Error(`GitHub answered ${res.status} reading ${what}`);
  return res.json();
}

async function pullReviews(cfg, repo, prNumber) {
  const all = [];
  for (let page = 1; ; page++) {
    if (page > MAX_REVIEW_PAGES) throw new Error('The pull request has more reviews than can be read');
    const reviews = await readJson(
      cfg,
      `/repos/${repo}/pulls/${prNumber}/reviews?per_page=${REVIEWS_PAGE}&page=${page}`,
      'the pull request’s reviews',
    );
    all.push(...reviews);
    if (reviews.length < REVIEWS_PAGE) return all;
  }
}

/**
 * The approvals a pull request carries now, by id: read before a review's label step,
 * so that whatever approval exists afterwards and is not among them was submitted since.
 * Exact where a clock comparison between two machines is not.
 * @param {{ cfg: { githubToken?: string }, repo: string, prNumber: number }} p
 * @returns {Promise<number[]>}
 */
export async function approvalsBefore({ cfg, repo, prNumber }) {
  return (await pullReviews(cfg, repo, prNumber)).filter((r) => r?.state === 'APPROVED').map((r) => r.id);
}

/**
 * Hold what a review's label step did against the outcome it was given, when that
 * outcome is not `passed`: nothing on GitHub may then read as an approval by the review.
 * Resolves with notes, each `{ code, message, … }`, which the outcome lists as reasons.
 *
 * - The pull request carries one of `approvedLabels`: noted, and left. A project's
 *   label rules are its own, the label may have been there before the review, and what
 *   blocks the merge is the status, not the label.
 * - The reviewing account submitted an approval since the step started: dismissed, as
 *   that account, with the outcome as the reason. Of whichever commit: the step is told
 *   to approve the reviewed one, and an approval of a head pushed meanwhile is no more
 *   supported by the outcome. That approval is the review's own act, made against what
 *   it was told, and unlike a label it counts towards GitHub's required approvals. An
 *   approval from before the step, or by anybody else, is a person's and is not touched.
 *
 * "Since the step started" is `known`, the approvals that existed just before it
 * (approvalsBefore); without that list, `since` and the two clocks' slack. What it cannot
 * tell apart is an approval the same account submitted by hand while the step ran: when
 * the review posts as its owner's own GitHub account, that person approving in those
 * minutes has the approval dismissed with the review's.
 *
 * A check that could not be made is itself a note; the outcome fails either way.
 * @param {{
 *   cfg: { githubToken?: string }, repo: string, prNumber: number, head: string, outcome: string,
 *   approvedLabels: string[], since: number, known?: number[] | null,
 *   reviewer?: { login: string, token?: string | null } | null,
 * }} p
 * `reviewer` is the account the agent posts as when that is not the server's own;
 * `since` when the label step first started.
 */
export async function checkLabelStep({
  cfg,
  repo,
  prNumber,
  head,
  outcome,
  approvedLabels,
  since,
  known = null,
  reviewer = null,
}) {
  const notes = [];
  try {
    const labels = await readJson(
      cfg,
      `/repos/${repo}/issues/${prNumber}/labels?per_page=100`,
      'the pull request’s labels',
    );
    const carried = (Array.isArray(labels) ? labels : [])
      .map((label) => String(label?.name || ''))
      .filter((name) => approvedLabels.includes(name.toLowerCase()));
    if (carried.length)
      notes.push({
        code: 'approved_label_ignored',
        message: `The pull request carries ${carried.map((name) => `\`${name}\``).join(', ')} while the review outcome is ${outcome}: the label does not count as a passed review.`,
        labels: carried,
      });
    const before = known ? new Set(known) : null;
    const approvals = (await pullReviews(cfg, repo, prNumber)).filter(
      (r) =>
        r?.state === 'APPROVED' &&
        (before ? !before.has(r.id) : Date.parse(r.submitted_at) >= since - CLOCK_SLACK_MS),
    );
    if (approvals.length) {
      const login =
        reviewer?.login || (await readJson(cfg, '/user', 'the server’s GitHub account'))?.login || '';
      const own = approvals.filter((r) => String(r.user?.login || '').toLowerCase() === login.toLowerCase());
      for (const approval of own) {
        const approved = String(approval.commit_id || head).slice(0, 7);
        const res = await asGithubUser(reviewer?.token || null, () =>
          githubRest(cfg, 'PUT', `/repos/${repo}/pulls/${prNumber}/reviews/${approval.id}/dismissals`, {
            message: `Briareus: the code review outcome for ${head.slice(0, 7)} is ${outcome.replace('_', ' ')}, so the review’s own approval of ${approval.commit_id && approval.commit_id !== head ? approved : 'it'} does not stand.`,
            event: 'DISMISS',
          }),
        );
        notes.push(
          res.ok
            ? {
                code: 'approval_dismissed',
                message: `The review approved ${approved} as ${login} while its outcome is ${outcome}; Briareus dismissed that approval.`,
                reviewId: approval.id,
              }
            : {
                code: 'approval_not_dismissed',
                message: `The review approved ${approved} as ${login} while its outcome is ${outcome}, and GitHub answered ${res.status} to dismissing it: the approval still stands on GitHub and does not count as a passed review.`,
                reviewId: approval.id,
              },
        );
      }
    }
  } catch (e) {
    notes.push({
      code: 'label_check_failed',
      message: `Briareus could not check the pull request’s labels and approvals against the outcome: ${e.message}`,
    });
  }
  return notes;
}
