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
// - A status belongs to the commit, and so to every open pull request whose head that
//   commit is. What is written is therefore the most restrictive status among them,
//   named after the pull request it is of; one of them the server holds nothing for
//   counts as not passed, and `success` is not written while GitHub cannot say which
//   pull requests are there (statusForCommit).
//
// What this cannot do is withdraw a status GitHub will not let it replace: if a write
// fails for good (the token lost its permission, say) an older status stays on the
// commit. The stored outcome then says so, and that is what the API reports. Nor can it
// stop another holder of a token that may write statuses from writing one under this
// context between two of its own checks.
//
// The approval requirement (lib/review-approvals.js) is computed beside the outcome, in
// the same transaction and from the same reading, and published by the same code as a
// second status, `briareus/approvals`: every rule above holds for it. It is a result of
// its own and never an input of the outcome.
import { asGithubUser, githubRest } from './github.js';
import {
  clearCodeReviewRiskRetry,
  clearCodeReviewWaiting,
  dropCodeReviewStatusDebt,
  getCodeReviewOutcome,
  getCodeReviewReadiness,
  getCodeReviewRisk,
  listCodeReviewReadinessWaiting,
  listCodeReviewStatusesAtHead,
  oweCodeReviewStatusesAtHead,
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
import { APPROVALS_CONTEXT, NO_DIRECTORY, approvalStatusFor, computeApprovals } from './review-approvals.js';
import { STATUS_CONTEXT, computeReviewOutcome, statusDescription, statusFor } from './review-outcome.js';
import { observeRevision, pullReviews, pullsAtHead, readJson } from './review-revision.js';
import { approvalPolicyOf, effectiveSecurityPolicy, riskOf, riskRaisesSecurity } from './review-risk.js';
import { roundLimitOf, securityClaims, settledClaims, unresolvedWork } from './review-rounds.js';
import { computeSecurityResult, securityPolicyOf, securityRequirement } from './review-security.js';

// Whether the project publishes the outcome and holds the label step to it. Off unless
// it was switched on: requiring a status is a decision about a repository.
export function enforcesOutcome(project) {
  return project?.enforceReviewOutcome === true;
}

// Who the server can ask about its users when it judges an approval: wired in by
// server.js, as its other services are. Until then nobody is known and no approval
// recorded here counts.
/** @type {import('./review-approvals.js').ApprovalDirectory} */
let directory = NO_DIRECTORY;
/** @param {import('./review-approvals.js').ApprovalDirectory | null} known */
export function setApprovalDirectory(known) {
  directory = known || NO_DIRECTORY;
}

/**
 * The outcome of what the store holds for a pull request, with the security result and
 * the approval requirement computed from the same reading.
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
  //
  // The policy the pass is held to is the project's, raised to `required` when the risk
  // of the revision calls for it (lib/review-risk.js): the assessment the server stored
  // for this head and base branch, or the highest tier when it has none.
  const approvalPolicy = approvalPolicyOf(project);
  const risk = riskOf(approvalPolicy, state.risk, {
    headSha: seen.headSha || state.review?.headSha || null,
    baseRef: seen.baseRef || state.review?.baseRef || null,
  });
  const asked = effectiveSecurityPolicy(project, risk);
  const result = computeSecurityResult({
    ...evidence,
    policy: asked.policy,
    addressed: securityClaims(state.decisions).filter((claim) => claim.status === 'addressed'),
  });
  // Said only when it is so: which tier made a pass required that the project leaves
  // advisory or off.
  const security = asked.raisedBy ? { ...result, requiredByRisk: asked.raisedBy } : result;
  const required = securityRequirement(security);
  const outcome = computeReviewOutcome({
    ...evidence,
    rounds: { limit, used, limitReached: limit > 0 && used >= limit },
    requirements: required ? [required] : [],
  });
  // Beside the outcome, never inside it: whether the people the risk calls for approved
  // this revision (lib/review-approvals.js).
  const observed = state.risk?.headSha && state.risk.headSha === outcome.headSha ? state.risk : null;
  const approvals = computeApprovals({
    policy: approvalPolicy,
    project,
    risk,
    outcome,
    // A review that is still running has concluded nothing an approval could rest on.
    reviewEnded: !!state.review && state.review.status !== 'running',
    security,
    approvals: state.approvals || [],
    // Who wrote this revision, as far as the server read it, and whose sessions made
    // commits of it: what an approval of one's own change is recognised by.
    authors: observed?.authors || null,
    workers: observed ? state.workers || [] : [],
    github: observed ? { syncedAt: observed.reviewsSyncedAt, error: observed.error } : null,
    directory,
  });
  return { ...outcome, security, approvals };
}

// Whether the pull request waits on people and nothing else: its review passed and
// covers the revision, and approvals are what is missing.
const waitsOnPeople = (result) =>
  result.outcome === 'passed' && result.approvals.result === 'pending' && result.approvals.reviewCurrent;

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
  const { counts: _counts, reviewed, security, approvals, ...outcome } = result;
  const status = statusFor(result);
  const row = state.row;
  const enforced = enforcesOutcome(project);
  const readiness = state.readiness || null;
  const approvalStatus = approvalStatusFor(approvals);
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
    status: publicationView(STATUS_CONTEXT, result.headSha, status, row, enforced),
    // Whether the people this change's risk calls for approved the revision: a result
    // of its own, with its own status. The outcome above never depends on it.
    approvals: {
      ...approvals,
      // Since when the pull request has waited on people alone, while it does.
      waitingSince:
        waitsOnPeople(result) && readiness?.headSha === result.headSha ? readiness.waitingSince : null,
      status: publicationView(APPROVALS_CONTEXT, result.headSha, approvalStatus, readiness, enforced),
    },
    // Both: the review passed for this revision and nobody's approval is missing.
    ready: result.outcome === 'passed' && approvals.result !== 'pending',
  };
}

// How the status of a commit that several open pull requests share is worded.
const SHARED = /^PR #\d+: /;

// A status as a client reads it, with what GitHub carries of it: the same reading for
// the outcome's status and for the approval requirement's.
function publicationView(context, sha, status, row, enforced) {
  return {
    context,
    sha,
    ...status,
    // True only when GitHub is known to carry exactly this status for this head: it
    // answered that it took it, and nothing was sent since. An outcome is enforced on
    // GitHub when the project enforces it and this is true.
    //
    // A commit shared with other open pull requests carries one status for all of
    // them, the most restrictive, named after the pull request it is of ("PR #7: …"):
    // then this is true when that state is this pull request's own, and
    // `publishedDescription` says whose status the commit shows.
    published:
      enforced &&
      !!sha &&
      !!row?.publishedConfirmed &&
      row.publishedSha === sha &&
      row.publishedState === status.state &&
      (row.publishedDescription === status.description || SHARED.test(row.publishedDescription || '')),
    // What GitHub last confirmed. With `publishedConfirmed` false a write was sent
    // since and never answered, so the commit may carry that one instead.
    publishedConfirmed: !!row?.publishedConfirmed,
    publishedSha: row?.publishedSha ?? null,
    publishedState: row?.publishedState ?? null,
    publishedDescription: row?.publishedDescription ?? null,
    publishedAt: row?.publishedAt ?? null,
    error: row?.publishError ?? null,
    errorStatus: row?.publishErrorStatus ?? null,
    attempts: row?.publishAttempts ?? 0,
    failedAt: row?.publishFailedAt ?? null,
    retryAt: row?.publishRetryAt ?? null,
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
 *   labelStep?: { login?: string | null, known?: number[] | null, since?: number | null } | null,
 *   asked?: boolean,
 * }} options
 * `asked` says a person is waiting on this computation (an approval): what could not be
 * read about the revision is then read again sooner than it otherwise would be.
 * `reviewId` makes that review the one the outcome is computed from, which a discovery
 * run does when it starts. `labelStep` describes the review's label step that just ran
 * (lib/review-revision.js).
 *
 * For a project with an approval policy, what the server holds about the revision is
 * brought up to date first (its risk, and the approvals GitHub carries): the computation
 * itself reads only the store. A project without one reads and writes nothing more than
 * it always did.
 */
export async function refreshReviewOutcome(
  project,
  prNumber,
  { cfg, reviewId = null, current = null, retryDelayMs, now, labelStep = null, asked = false },
) {
  let result;
  let state;
  let observedRevision = null;
  const policy = approvalPolicyOf(project);
  const observe = (revision) =>
    observeRevision(project, prNumber, revision, { cfg, now, directory, labelStep, asked }).catch((e) => {
      console.error(`Risk of ${project.repo}#${prNumber}: ${e.message}`);
      return null;
    });
  const compute = () =>
    refreshCodeReviewOutcome(project.repo, prNumber, { reviewId }, (read) => {
      result = outcomeOf(read, { project, current });
      const status = statusFor(result);
      const approvalStatus = approvalStatusFor(result.approvals);
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
        // The approval requirement, for a project that has a policy, and for a pull
        // request that had one computed under a policy since switched off: its status
        // may still be on GitHub, and is replaced rather than left to say `pending`.
        readiness:
          policy || read.readiness
            ? {
                result: result.approvals.result,
                tier: result.approvals.tier,
                required: result.approvals.required,
                valid: result.approvals.valid,
                reasons: result.approvals.reasons,
                waiting: waitsOnPeople(result),
                statusState: approvalStatus.state,
                statusDescription: approvalStatus.description,
                owed: enforcesOutcome(project),
              }
            : null,
      };
    });
  try {
    if (policy) {
      // Learn the stored revision without first writing an outcome from stale facts.
      const known = current?.headSha
        ? current
        : outcomeOf(await readCodeReviewOutcomeState(project.repo, prNumber, { reviewId }), {
            project,
            current,
          });
      if (known.headSha) {
        observedRevision = known;
        await observe(known);
      }
    }
    state = await compute();
    // If another revision arrived during observation, read it and compute once more.
    if (
      policy &&
      result.headSha &&
      (observedRevision?.headSha !== result.headSha || observedRevision?.baseRef !== result.baseRef)
    ) {
      const observed = await observe({ headSha: result.headSha, baseRef: result.baseRef });
      if (observed && observed.updatedAt !== state.risk?.updatedAt) state = await compute();
    }
  } catch (e) {
    await oweReviewOutcome(project, prNumber);
    throw e;
  }
  owedRecomputes.delete(keyOf(project.repo, prNumber));
  const failed = (e) => {
    console.error(`Code review status for ${project.repo}#${prNumber}: ${e.message}`);
    return null;
  };
  const published = publishReviewStatus(project, prNumber, { cfg, retryDelayMs, now }).catch(failed);
  if (state.readiness)
    publishReviewStatus(project, prNumber, { cfg, retryDelayMs, now, channel: 'approvals' }).catch(failed);
  return { outcome: outcomeView(state, result, project), published };
}

/**
 * The security policy a review that is about to start is held to, and with it whether it
 * runs the security pass: the project's, raised to `required` when the risk of the
 * revision calls for it (lib/review-risk.js). The tier has to be known here, before
 * discovery, because that is where the review's steps are chosen; so the changed files
 * are read now, and a read that fails leaves the tier unknown, which is the highest one.
 *
 * A project whose policy raises nothing is answered without reading anything.
 * @param {any} project @param {number} prNumber
 * @param {{ headSha: string, baseRef?: string | null }} revision
 * @param {{ cfg: { githubToken?: string } }} options
 * @returns {Promise<{ policy: 'off' | 'advisory' | 'required', raisedBy: string | null }>}
 */
export async function reviewSecurityPolicy(project, prNumber, revision, { cfg }) {
  const policy = approvalPolicyOf(project);
  if (securityPolicyOf(project) === 'required' || !riskRaisesSecurity(policy))
    return { policy: securityPolicyOf(project), raisedBy: null };
  const stored = await observeRevision(project, prNumber, revision, { cfg, directory }).catch((e) => {
    console.error(`Risk of ${project.repo}#${prNumber}: ${e.message}`);
    return null;
  });
  return effectiveSecurityPolicy(project, riskOf(policy, stored, revision));
}

/**
 * Something changed on GitHub that an approval requirement may be computed from: a
 * review was submitted or dismissed. Computed again for a pull request that has an
 * outcome, in a project that counts approvals given on GitHub; nothing otherwise.
 * @param {any} project @param {number} prNumber @param {{ cfg: { githubToken?: string } }} options
 */
export async function noteGithubReview(project, prNumber, options) {
  if (!approvalPolicyOf(project)?.acceptGithubApprovals || !Number.isInteger(prNumber)) return null;
  if (!(await getCodeReviewOutcome(project.repo, prNumber))) return null;
  return refreshReviewOutcome(project, prNumber, options);
}

/**
 * A setting the project's outcomes are computed from changed (its security policy,
 * whether it enforces the outcome, its round limit): the outcomes stored for its open
 * pull requests were computed under the old value, and so were the statuses GitHub
 * carries for them. They are marked as owing a recomputation, which the sweep pays
 * (retryReviewStatuses), so a pull request nothing happens to does not keep a `success`
 * the project's policy no longer supports until somebody touches it.
 *
 * Only the open ones: a merged pull request's commit needs no new status. When the open
 * ones cannot be listed, every row of the repository is marked instead: a status too
 * many on a closed pull request is the lesser harm.
 * @param {any} project
 * @param {{ openPulls: (project: any) => Promise<number[]> }} deps
 * @returns {Promise<number>} how many outcomes were marked
 */
export async function oweProjectOutcomes(project, { openPulls }) {
  const numbers = await openPulls(project).catch((e) => {
    console.error(`Open pull requests of ${project.repo} could not be listed: ${e.message}`);
    return null;
  });
  return markRepoCodeReviewOutcomesStale(project.repo, numbers);
}

/**
 * The server saw a pull request at this revision: a webhook delivered it, a session
 * read it, the babysitter listed it. When that is not the revision the stored outcome
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
  if (sameRevision) {
    // What the pass is held to now: the project's policy, raised by the risk the server
    // stored for this revision when a tier requires the pass.
    const policy = approvalPolicyOf(project);
    const asked = riskRaisesSecurity(policy)
      ? effectiveSecurityPolicy(
          project,
          riskOf(policy, await getCodeReviewRisk(project.repo, prNumber), {
            headSha,
            baseRef: baseRef || row.baseRef,
          }),
        ).policy
      : securityPolicyOf(project);
    if ((row.securityPolicy || 'off') === asked) return null;
  }
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
async function carriedStatus(cfg, repo, sha, context) {
  const res = await githubRest(cfg, 'GET', `/repos/${repo}/commits/${sha}/statuses?per_page=100`);
  if (!res.ok) throw new Error(`GitHub answered ${res.status} reading the statuses of ${sha.slice(0, 7)}`);
  const statuses = await res.json();
  if (!Array.isArray(statuses)) throw new Error('GitHub answered no list of statuses');
  const mine = statuses.find((status) => status?.context === context);
  return mine ? { state: mine.state, description: mine.description ?? '' } : null;
}

// One publication per pull request at a time, each reading the row when its turn comes:
// two outcomes computed close together reach GitHub in the order they were stored, and
// the later one never loses to an earlier write that was slower.
const publishing = new Map(); // `repo#pr`, lowercased -> the last publication queued

// The two statuses a pull request carries, each with its own record of what it should be
// and what GitHub was told (lib/db.js): the review outcome's, and the approval
// requirement's. One publisher for both, so neither is the weaker.
const CHANNELS = {
  review: {
    context: STATUS_CONTEXT,
    read: (repo, prNumber) => getCodeReviewOutcome(repo, prNumber),
    ledger: /** @type {string[]} */ ([]),
  },
  approvals: {
    context: APPROVALS_CONTEXT,
    read: (repo, prNumber) => getCodeReviewReadiness(repo, prNumber),
    ledger: ['approvals'],
  },
};
const laneOf = (channel, key) => (channel === 'approvals' ? `approvals:${key}` : key);

// Writes to one commit under one context, one at a time (see publishReviewStatus).
const commits = new Map();
/** @template T @param {Map<string, Promise<any>>} lanes @param {string} key @param {() => Promise<T>} fn @returns {Promise<T>} */
function inTurn(lanes, key, fn) {
  const turn = (lanes.get(key) || Promise.resolve()).then(fn, fn);
  lanes.set(key, turn);
  const done = () => {
    if (lanes.get(key) === turn) lanes.delete(key);
  };
  turn.then(done, done);
  return turn;
}

// Which status stands when pull requests share a commit: any that does not pass over
// one that does, and among those the one that says most. Ties go to the lowest number,
// so every pull request at the commit works out the same answer.
const RESTRICTS = { success: 0, pending: 1, error: 2, failure: 3 };
// A pull request at the commit the server holds nothing for: not passed, whatever the
// others amount to.
const UNSEEN = {
  review: 'not reviewed at this commit yet',
  approvals: 'no code review of this commit yet, so its approvals are not known',
};

/**
 * The status a commit is given under one context, which is not always the pull
 * request's own. A commit status belongs to the commit: two open pull requests with the
 * same head (the same branch against two bases, say) read the same statuses, and a
 * `success` written for one would let the other merge. So the commit carries the most
 * restrictive status of every open pull request at it, worded as that pull request's
 * ("PR #7: …") once more than one shares it.
 *
 * Which pull requests those are is GitHub's to say, since the server may never have
 * seen one of them; such a pull request counts as not passed. When GitHub cannot say,
 * a status that does not pass is written as it is, and a `success` is not written at
 * all: this throws, the publication fails as any write does, and is tried again.
 * @returns {Promise<{ status: { sha: string, state: string, description: string }, shared: boolean }>}
 */
async function statusForCommit(cfg, project, prNumber, own, channel) {
  // A project without an approval policy asks approvals of no pull request.
  if (channel === 'approvals' && !approvalPolicyOf(project)) return { status: own, shared: false };
  let open;
  try {
    open = await pullsAtHead(cfg, project.repo, own.sha);
  } catch (e) {
    if (own.state !== 'success') return { status: own, shared: false };
    throw Object.assign(
      new Error(
        `The other pull requests at ${own.sha.slice(0, 7)} could not be read from GitHub (${e.message}), so \`success\` was not written: a commit’s status counts for every pull request at that commit`,
      ),
      { rateLimited: e.rateLimited, retryAt: e.retryAt },
    );
  }
  const others = open.filter((number) => number !== prNumber);
  if (!others.length) return { status: own, shared: false };
  const stored = new Map(
    (await listCodeReviewStatusesAtHead(project.repo, own.sha, ...CHANNELS[channel].ledger)).map((row) => [
      row.prNumber,
      row,
    ]),
  );
  const standing = [
    { prNumber, state: own.state, description: own.description },
    ...others.map(
      (number) => stored.get(number) || { prNumber: number, state: 'pending', description: UNSEEN[channel] },
    ),
  ].reduce((most, next) =>
    RESTRICTS[next.state] > RESTRICTS[most.state] ||
    (RESTRICTS[next.state] === RESTRICTS[most.state] && next.prNumber < most.prNumber)
      ? next
      : most,
  );
  return {
    status: {
      sha: own.sha,
      state: standing.state,
      description: statusDescription(`PR #${standing.prNumber}: ${standing.description}`),
    },
    shared: true,
  };
}

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
 * @param {{ cfg: { githubToken?: string }, retryDelayMs?: number, now?: () => number, channel?: 'review' | 'approvals' }} options
 * `channel` names which of the pull request's two statuses: the review outcome's, or
 * the approval requirement's (`briareus/approvals`).
 */
export function publishReviewStatus(
  project,
  prNumber,
  { cfg, retryDelayMs = RETRY_DELAY_MS, now = Date.now, channel = 'review' },
) {
  const { context, read, ledger } = CHANNELS[channel];
  const key = laneOf(channel, keyOf(project.repo, prNumber));
  const run = async () => {
    const row = await read(project.repo, prNumber);
    if (!row) return { published: false, skipped: 'no_outcome' };
    const owes = row.publishFailedAt || row.publishOwedAt;
    if (!enforcesOutcome(project)) {
      if (owes) await dropCodeReviewStatusDebt(project.repo, prNumber, ...ledger);
      return { published: false, skipped: 'not_enforced' };
    }
    if (!row.headSha || !row.statusState) {
      if (owes) await dropCodeReviewStatusDebt(project.repo, prNumber, ...ledger);
      return { published: false, skipped: 'no_head' };
    }
    const options = ledger.length ? { ledger: ledger[0] } : null;
    // What this pull request by itself should carry. What the commit is given may be
    // another pull request's, when several share the head (statusForCommit).
    const own = { sha: row.headSha, state: row.statusState, description: row.statusDescription || '' };
    const carries = (status) =>
      row.publishedSha === status.sha &&
      row.publishedState === status.state &&
      row.publishedDescription === status.description;
    // One write per commit and context at a time, each reading the pull requests at the
    // commit when its turn comes: of two that share a head, the one that writes last
    // also read last.
    return inTurn(commits, `${context}:${project.repo.toLowerCase()}@${own.sha}`, async () => {
      /** @type {{ sha: string, state: string, description: string }} */
      let status;
      /** @type {boolean} */
      let shared;
      try {
        if (!cfg.githubToken) throw new Error('No GITHUB_TOKEN is configured');
        ({ status, shared } = await statusForCommit(cfg, project, prNumber, own, channel));
        // Known to carry it, or, on a shared commit, possibly given it by another pull
        // request's publication since: either way GitHub is asked what the commit shows.
        if (row.publishedConfirmed && (shared || carries(status))) {
          const carried = await asGithubUser(null, () =>
            carriedStatus(cfg, project.repo, status.sha, context),
          ).catch(() => undefined);
          if (carried && carried.state === status.state && carried.description === status.description) {
            if (owes || !carries(status))
              await recordCodeReviewStatusPublished(project.repo, prNumber, status, {
                posted: false,
                ...options,
                ...(shared ? { own } : {}),
              });
            return { published: true, skipped: 'unchanged' };
          }
        }
        await markCodeReviewStatusSending(project.repo, prNumber, ...ledger);
        // Always as the server, also when a client's request led here: a repository
        // requires this status from one account, not from whoever changed a verdict.
        await asGithubUser(null, () =>
          postStatus(
            cfg,
            project.repo,
            status.sha,
            { state: status.state, context, description: status.description },
            retryDelayMs,
          ),
        );
      } catch (e) {
        // Not accepted for this commit, whatever is asked: given up after a few attempts.
        const gaveUp = e.status === 422 && row.publishAttempts + 1 >= UNPROCESSABLE_ATTEMPTS;
        const retryAt = gaveUp
          ? null
          : e.rateLimited && e.retryAt
            ? e.retryAt
            : now() + statusRetryDelay(row.publishAttempts);
        await recordCodeReviewStatusFailed(project.repo, prNumber, {
          error: e.message,
          status: Number.isInteger(e.status) ? e.status : null,
          retryAt,
          ...options,
        });
        return { published: false, error: e.message, ...(gaveUp ? { gaveUp: true } : {}) };
      }
      await recordCodeReviewStatusPublished(
        project.repo,
        prNumber,
        status,
        ...(shared ? [{ ...options, own }] : options ? [options] : []),
      );
      // The other pull requests at this commit recorded what it carried before: each
      // looks again, finds this status there, and says so.
      if (shared)
        await oweCodeReviewStatusesAtHead(project.repo, own.sha, prNumber).catch((e) =>
          console.error(`Statuses of the pull requests at ${own.sha.slice(0, 7)}: ${e.message}`),
        );
      return { published: true };
    });
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
    // By the outcome's own rows: an approval requirement that owes its status says
    // nothing about whether the outcome is listed for its recomputation.
    const listed = new Set(
      due.filter((row) => row.ledger !== 'approvals').map((row) => keyOf(row.repo, row.prNumber)),
    );
    const work = [
      ...[...owedRecomputes.entries()]
        .filter(([key]) => !listed.has(key))
        .map(([, owed]) => ({ ...owed, recomputeAt: true, publishFailedAt: null })),
      ...due,
    ];
    for (const row of work) {
      const key = keyOf(row.repo, row.prNumber);
      // The approval requirement's status is owed on its own record, and paid on its own.
      const channel = row.ledger === 'approvals' ? 'approvals' : 'review';
      // One under way already reads the row when its turn comes.
      if (publishing.has(laneOf(channel, key))) continue;
      const result = { repo: row.repo, prNumber: row.prNumber, ...(channel === 'review' ? {} : { channel }) };
      try {
        const project = getProject(row.repo);
        if (!project || (row.publishFailedAt && !(await isOpen(project, row.prNumber).catch(() => true)))) {
          if (channel === 'review') owedRecomputes.delete(key);
          await dropCodeReviewStatusDebt(row.repo, row.prNumber, ...CHANNELS[channel].ledger);
          if (row.riskRetry) await clearCodeReviewRiskRetry(row.repo, row.prNumber);
          results.push({ ...result, published: false, skipped: project ? 'closed' : 'no_project' });
          continue;
        }
        // Due only because its risk was to be read again, for a policy the project no
        // longer has: nobody waits for that read.
        if (row.riskRetry && !approvalPolicyOf(project)) {
          await clearCodeReviewRiskRetry(row.repo, row.prNumber);
          results.push({ ...result, published: false, skipped: 'no_policy' });
          continue;
        }
        const published = row.recomputeAt
          ? await (
              await refreshReviewOutcome(project, row.prNumber, { cfg, now, retryDelayMs })
            ).published
          : await publishReviewStatus(project, row.prNumber, {
              cfg,
              now,
              retryDelayMs,
              ...(channel === 'review' ? {} : { channel }),
            });
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
      // Which of the two statuses, when it is the approval requirement's.
      ...(row.ledger === 'approvals' ? { context: APPROVALS_CONTEXT } : {}),
      outcome: row.ledger === 'approvals' ? row.result : row.outcome,
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
 * The pull requests that wait on people alone: the review passed for the revision they
 * are at, and the approvals their risk calls for are missing (lib/attention.js).
 * @param {{ getProject: (repo: string) => any, isOpen?: (project: any, prNumber: number) => Promise<boolean>, limit?: number }} deps
 */
export async function approvalsWaiting({ getProject, isOpen = async () => true, limit = 200 }) {
  // A pull request that closed, or whose project asks for nothing any more, no longer
  // waits: its mark is taken off as it is met, so that such rows cannot fill the list
  // ahead of the ones that do wait. The list is read again while that made room.
  for (let pass = 0; ; pass++) {
    const rows = await listCodeReviewReadinessWaiting({ limit });
    const waiting = [];
    let cleared = 0;
    for (const row of rows) {
      const project = getProject(row.repo);
      const waits =
        !!project &&
        !!approvalPolicyOf(project) &&
        // A pull request that cannot be told to be closed is taken for open.
        (await isOpen(project, row.prNumber).catch(() => true));
      if (!waits) {
        await clearCodeReviewWaiting(row.repo, row.prNumber).catch(() => {});
        cleared++;
        continue;
      }
      waiting.push({
        repo: project.repo,
        prNumber: row.prNumber,
        headSha: row.headSha,
        tier: row.tier,
        required: row.required,
        valid: row.valid,
        waitingSince: row.waitingSince,
      });
    }
    if (!cleared || rows.length < limit || pass >= 20) return waiting;
  }
}

/**
 * A pull request came to a commit, left it or closed: the other open pull requests at
 * that commit share its statuses, so each of them owes its own again and the sweep has
 * it look at the commit once more (statusForCommit). A closed one waits on nobody.
 * @param {any} project
 * @param {{ number: number, headSha?: string | null, before?: string | null, state?: string }} pull
 */
export async function notePullAtCommit(project, { number, headSha = null, before = null, state = 'open' }) {
  if (!project || !Number.isInteger(number)) return;
  if (state !== 'open') await clearCodeReviewWaiting(project.repo, number);
  if (!enforcesOutcome(project)) return;
  for (const sha of new Set([headSha, before].filter(Boolean)))
    await oweCodeReviewStatusesAtHead(project.repo, sha, number);
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

// GitHub's clock and this server's are not the same clock.
const CLOCK_SLACK_MS = 60_000;

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
