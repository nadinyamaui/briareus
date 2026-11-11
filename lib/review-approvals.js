// @ts-check
// Whether the people a pull request's risk calls for have approved the reviewed
// revision: a result of its own, beside the review outcome (lib/review-outcome.js) and
// never part of it. "The review passed" is what the server concluded from the review's
// evidence; "the required people approved" is what persons did afterwards. An approval
// that is missing is not a finding and not a change to make, so it never turns the
// outcome into `changes_required`, and the review's own label step, which runs before
// anybody could have approved, is not held to it. The two are published as two commit
// statuses, and a repository requires either or both.
//
// What counts as a person approving is decided here, from what the server itself can
// establish, and an approval that cannot be attributed to a person does not count:
//
// - An approval somebody records through Briareus's client API, with their own token.
//   Agent sessions cannot reach that API (their tokens open /api/agent/* only), so this is
//   the one act the server knows a user's own client made. It is stored with who, when,
//   and the exact head and base branch it approves.
// - An approval on GitHub, only when the project accepts those, and only from an account
//   nothing automated acts as. The server's own account never counts, nor does an
//   account a Briareus user linked: sessions run `gh` with those credentials, the
//   review's own label step approves that way, and GitHub cannot say whether the person
//   or a session of theirs clicked. That person records the approval through the API
//   instead. A bot never counts, nor an account without a collaborator's standing.
//
// Accounts are told apart by GitHub's user id, and an account stays its owner's after
// they unlink it: nobody approves their own change by removing or renaming the account
// it was made under, and nobody counts twice, once here and once on GitHub. Whether an
// approver wrote the change is judged every time the requirement is computed, against
// every account they ever linked and the commits their sessions made.
//
// An approval is for one revision. It stops counting when the head moves or the pull
// request is retargeted, stays on record, and says why. The base branch gaining commits
// under an unchanged head changes nothing, as for the review outcome. And approvals make
// a pull request ready only while the review covers that same revision.
//
// Pure, so the rules can be tested as a table. lib/review-enforcement.js feeds it from
// the store and publishes the result.
import { statusDescription } from './review-outcome.js';
import { higherTier } from './review-risk.js';

// The name of the commit status, the one a repository requires in its branch
// protection beside `briareus/code-review`. A contract string, like that one.
export const APPROVALS_CONTEXT = 'briareus/approvals';
export const APPROVAL_RESULTS = ['not_required', 'pending', 'satisfied'];
export const NOTE_MAX = 2000;

// OWNER and COLLABORATOR carry repository standing. MEMBER alone says only org
// membership; WRITE is set by the server after checking that member's push permission.
const COLLABORATORS = ['OWNER', 'WRITE', 'COLLABORATOR'];
// GitHub's clock and this server's are not the same clock.
const CLOCK_SLACK_MS = 60_000;

const short = (sha) => String(sha || '').slice(0, 7);
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const lower = (login) => String(login || '').toLowerCase();

/**
 * Who the server can ask about a Briareus user, as server.js wires it in. Without one
 * nobody is known, and an approval by somebody unknown does not count.
 *
 * `accountsOf` is every GitHub account a user has ever linked here, the current one
 * included, and `linkedAccounts` the same for all users: unlinking an account does not
 * make its commits somebody else's, nor an approval from it a person's. Each is
 * `{ id, login }` with GitHub's own user id, which a renamed account keeps. Both throw
 * when that cannot be known just now, and what depends on it then does not count.
 * @typedef {{ id: number | null, login: string }} GithubAccount
 * @typedef {{
 *   user: (id: number) => { id: number, name: string, disabled: boolean } | null,
 *   mayApprove: (id: number, project: any) => boolean,
 *   accountsOf: (userId: number) => GithubAccount[],
 *   linkedAccounts: () => GithubAccount[],
 * }} ApprovalDirectory
 */
/** @type {ApprovalDirectory} */
export const NO_DIRECTORY = {
  user: () => null,
  mayApprove: () => false,
  accountsOf: () => [],
  linkedAccounts: () => [],
};

/**
 * Whether two records name the same GitHub account: by GitHub's user id when both carry
 * one, since a login can be renamed and then taken by somebody else; by login otherwise.
 * @param {{ id?: number | null, login?: string | null } | null | undefined} a
 * @param {{ id?: number | null, login?: string | null } | null | undefined} b
 */
export function sameAccount(a, b) {
  if (!a || !b) return false;
  if (a.id != null && b.id != null) return a.id === b.id;
  return !!a.login && lower(a.login) === lower(b.login);
}

/**
 * How somebody relates to a change, from what the server can know: `author` when the
 * pull request was opened by one of their GitHub accounts, `commits` when commits of it
 * carry one (which is also how a session of theirs commits once they linked one),
 * `session` when a session they own made commits of it. Null when none of that holds.
 *
 * `accounts` is every account the person has ever linked, so unlinking one does not
 * undo the tie; `authors` is who wrote the pull request as read from GitHub
 * (lib/review-revision.js).
 * @param {{
 *   accounts?: Array<{ id?: number | null, login?: string | null }>,
 *   authors?: { author?: any, commits?: any[] } | null,
 *   session?: boolean,
 * }} p
 * @returns {'author' | 'commits' | 'session' | null}
 */
export function authorshipOf({ accounts = [], authors = null, session = false }) {
  if (authors?.author && accounts.some((account) => sameAccount(account, authors.author))) return 'author';
  if ((authors?.commits || []).some((commit) => accounts.some((account) => sameAccount(account, commit))))
    return 'commits';
  return session ? 'session' : null;
}

/**
 * Whether a user owns a session whose own branch became this pull request: one that was
 * not started on the pull request as an errand and carries it. The durable record of who
 * committed what is kept per commit (lib/db.js, code_review_commit_owners) from when a
 * project has an approval policy; this is what ties a person to a pull request their
 * session opened before that, while the server still has the session.
 * @param {any[]} sessions the session records @param {{ userId: number, repo: string, prNumber: number }} p
 */
export function openedPull(sessions, { userId, repo, prNumber }) {
  const key = lower(repo);
  return sessions.some(
    (s) => s.ownerId === userId && lower(s.repo) === key && !s.startedOnPr && s.prStatus?.number === prNumber,
  );
}

/**
 * What the pull request's reviews on GitHub amount to as approval records: one row per
 * review that approves, classified by whether the server can attribute it to a person.
 *
 * `automation` names why a row is automation's, and once stored it stays: an account
 * that was the server's or a session's when the approval was first seen does not become
 * a person's by being unlinked later. `review_label_step` is an approval the reviewing
 * account submitted since a review's label step started (the ids known before it, else
 * the two clocks' slack), which is the review approving, whatever account it used.
 * Accounts are told apart by GitHub's user id, by login only where no id is known.
 *
 * A person's verdict on GitHub is their latest one: an approval followed by a request
 * for changes from the same account is `superseded`. `dismissed` lists the reviews
 * GitHub now shows as dismissed, for the rows already stored under those ids.
 * @param {any[]} reviews the pull request's reviews as GitHub lists them, oldest first
 * @param {{
 *   headSha: string, baseRef: string | null,
 *   server: { id?: number | null, login: string },
 *   linked?: Array<{ id?: number | null, login?: string | null }>,
 *   authors?: { author?: any, commits?: any[] } | null,
 *   labelStep?: { login?: string | null, known?: number[] | null, since?: number | null } | null,
 * }} context
 */
export function githubApprovalRows(reviews, context) {
  const { headSha, baseRef, server, linked = [], authors = null } = context;
  const labelStep = context.labelStep || null;
  const reviewer = labelStep?.login ? { id: null, login: labelStep.login } : server;
  const known = labelStep?.known ? new Set(labelStep.known) : null;
  const accountOf = (review) => ({
    id: Number.isInteger(review?.user?.id) ? review.user.id : null,
    login: String(review?.user?.login || ''),
  });
  const keyOf = (account) => (account.id != null ? `id:${account.id}` : `login:${lower(account.login)}`);
  // The latest verdict of each account: a comment decides nothing.
  const latest = new Map();
  for (const review of reviews) {
    if (!['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(review?.state)) continue;
    latest.set(keyOf(accountOf(review)), review.id);
  }
  const rows = [];
  const dismissed = [];
  for (const review of reviews) {
    if (review?.state === 'DISMISSED') dismissed.push(review.id);
    if (review?.state !== 'APPROVED' || !Number.isInteger(review.id)) continue;
    const account = accountOf(review);
    const submitted = Date.parse(review.submitted_at) || null;
    const inLabelStep =
      !!labelStep &&
      sameAccount(account, reviewer) &&
      (known
        ? !known.has(review.id)
        : !!labelStep.since && !!submitted && submitted >= labelStep.since - CLOCK_SLACK_MS);
    rows.push({
      githubReviewId: review.id,
      githubLogin: account.login,
      githubUserId: account.id,
      status: latest.get(keyOf(account)) === review.id ? 'approved' : 'superseded',
      headSha: String(review.commit_id || ''),
      // Known only for an approval of the head the server is looking at: that is the
      // base branch it was first seen against, kept from then on.
      baseRef: review.commit_id === headSha ? baseRef : null,
      association: String(review.author_association || '') || null,
      automation: inLabelStep
        ? 'review_label_step'
        : !account.login || sameAccount(account, server)
          ? 'server_account'
          : review.user?.type === 'Bot' || account.login.endsWith('[bot]')
            ? 'bot_account'
            : linked.some((other) => sameAccount(account, other))
              ? 'linked_account'
              : null,
      authorship: authorshipOf({ accounts: [account], authors }),
      approvedAt: submitted,
    });
  }
  return { rows, dismissed };
}

const AUTOMATION_WORDS = {
  server_account: 'it was submitted by the server’s own GitHub account',
  linked_account:
    'the account is used by Briareus sessions, so an approval from it on GitHub may be automation’s; its owner can record the approval through the Briareus API',
  bot_account: 'the account is a bot',
  review_label_step: 'it was submitted by a code review’s own label step',
};
const AUTHORSHIP_WORDS = {
  author: 'opened this pull request',
  commits: 'has commits in this pull request',
  session: 'owns a session that committed to this pull request',
};

/** @param {any} approval @param {ApprovalDirectory} directory */
function approverOf(approval, directory) {
  const user =
    approval.source === 'briareus' && approval.userId != null ? directory.user(approval.userId) : null;
  return {
    userId: approval.userId ?? null,
    name: user?.name || approval.approver || approval.githubLogin || null,
    githubLogin: approval.githubLogin || null,
  };
}

/**
 * Why nobody's tie to the change can be ruled out, when it cannot: null when who wrote
 * the pull request is known in full.
 * @param {{ author?: any, commits?: any[], complete?: boolean } | null} authors
 */
export function authorshipGap(authors) {
  if (!authors) return 'who wrote this pull request could not be read from GitHub';
  if (authors.complete === false)
    return 'this pull request has more commits than GitHub lists, so who wrote all of it is not known';
  return null;
}

/**
 * The approval requirement of a pull request and how it stands.
 *
 * - `not_required`: the project has no approval policy switched on, or the change's
 *   tier asks for no approval.
 * - `pending`: approvals are required and too few count for the revision the pull
 *   request has now, or no review that has ended covers that revision (none ran, one is
 *   still running, or the pull request moved on): approvals of a revision nobody
 *   finished reviewing make nothing ready.
 * - `satisfied`: enough people approved exactly this head against this base branch, and
 *   a review of it has ended.
 *
 * `satisfied` says the people approved, not that the review passed: `ready` in the read
 * model (lib/review-enforcement.js) is both.
 *
 * Every approval on record is listed with whether it counts and, when it does not, why
 * (`reason`, `message`). `reasons` explains the requirement itself in plain words: the
 * tier and what produced it, how many approvals that asks for, how many count and by
 * whom, and what is still missing.
 *
 * Whether an approver wrote the change is judged again here, every time, against every
 * account they ever linked and the commits their sessions made: what was known when the
 * approval was recorded is kept (`authorship`) and can only be added to.
 *
 * @param {{
 *   policy: any, project?: any,
 *   risk: any,
 *   outcome: { outcome?: string, stale?: boolean, reviewed?: { headSha: string, baseRef: string | null } | null, headSha?: string | null, baseRef?: string | null },
 *   reviewEnded?: boolean,
 *   security?: { result?: string, counts?: { findings?: number } } | null,
 *   approvals?: any[],
 *   authors?: { author?: any, commits?: any[], complete?: boolean } | null,
 *   workers?: number[],
 *   github?: { syncedAt?: string | null, error?: string | null } | null,
 *   directory?: ApprovalDirectory,
 * }} input
 * `policy` is the project's approval policy when switched on, else null; `risk` the
 * assessment that stands for the revision (riskOf in lib/review-risk.js); `outcome` the
 * review outcome computed for the same revision and `reviewEnded` whether that review
 * is no longer running; `approvals` everything on record for the pull request;
 * `authors` who wrote this revision as read from GitHub, null when that is not known;
 * `workers` the users whose sessions made commits of it; `github` how current the
 * approvals read from GitHub are.
 */
export function computeApprovals({
  policy,
  project = null,
  risk,
  outcome,
  reviewEnded = true,
  security = null,
  approvals = [],
  authors = null,
  workers = [],
  github = null,
  directory = NO_DIRECTORY,
}) {
  const headSha = outcome.headSha || null;
  const baseRef = outcome.baseRef || null;
  const covered = !!outcome.reviewed && !outcome.stale;
  // A review that is still running has concluded nothing about the revision.
  const reviewCurrent = covered && reviewEnded;
  const listed = (approval, counted, reason = null, message = null) => ({
    id: approval.id,
    source: approval.source,
    by: approverOf(approval, directory),
    headSha: approval.headSha,
    baseRef: approval.baseRef ?? null,
    at: approval.approvedAt ?? null,
    note: approval.note ?? null,
    // What the review amounted to when the approval was given: context, not a condition.
    reviewOutcome: approval.reviewOutcome ?? null,
    authorship: approval.authorship ?? null,
    githubReviewId: approval.githubReviewId ?? null,
    withdrawnAt: approval.withdrawnAt ?? null,
    withdrawNote: approval.withdrawNote ?? null,
    counted,
    reason,
    message,
  });
  if (!policy)
    return {
      enabled: false,
      result: 'not_required',
      headSha,
      baseRef,
      tier: null,
      risk: null,
      required: 0,
      valid: 0,
      missing: 0,
      reviewCurrent,
      acceptsGithubApprovals: false,
      allowsSelfApproval: false,
      requiredChecks: { security: false },
      approvals: approvals.map((a) =>
        listed(a, false, 'policy_off', 'The project has no approval policy switched on.'),
      ),
      reasons: [],
      explanation: 'This project requires no human approval.',
    };

  /** @type {any[]} */
  const reasons = [];
  let tier = risk.tier;
  // A change whose security result is not clean is at least as risky as the project
  // says such a change is, whatever its paths: a pass that failed or could not finish,
  // or findings the pass or the review marked as security ones. Explicit configuration,
  // and it only ever raises.
  const signal =
    policy.securitySignalTier &&
    (['failed', 'incomplete', 'not_run'].includes(security?.result || '') ||
      (security?.counts?.findings || 0) > 0);
  if (signal && higherTier(tier, policy.securitySignalTier) !== tier) {
    tier = policy.securitySignalTier;
    reasons.push({
      code: 'security_signal',
      effect: 'note',
      tier,
      securityResult: security?.result ?? null,
      findings: security?.counts?.findings || 0,
      message: `The security review of this change ${security?.counts?.findings ? `holds ${plural(security.counts.findings, 'security finding', 'security findings')}` : `is ${String(security?.result).replace('_', ' ')}`}, which the project treats as at least ${tier} risk.`,
    });
  }
  const required = Math.max(policy.tiers[tier].approvals, risk.approvals || 0);
  // Which accounts sessions act as may not be knowable right now (the store that says
  // is not loaded): then no approval given on GitHub can be told from automation's.
  /** @type {GithubAccount[] | null} */
  let linked = null;
  try {
    linked = directory.linkedAccounts();
  } catch {
    linked = null;
  }
  const unread = policy.acceptGithubApprovals && (!github?.syncedAt || !!github.error);
  // Whether somebody wrote the change has to be answerable before their approval of it
  // can count, unless the project counts such approvals anyway.
  const gap = policy.allowSelfApproval ? null : authorshipGap(authors);
  // A person's API approval is tied to their GitHub accounts wherever two records could
  // otherwise be one person twice, or their own change approved under no account.
  const needsAccount = !policy.allowSelfApproval || policy.acceptGithubApprovals;
  const people = new Set();
  /** @type {Array<{ id?: number | null, login?: string | null }>} */
  const taken = [];

  const judged = approvals.map((approval) => {
    const who = approverOf(approval, directory).name || 'somebody';
    const no = (reason, why) => listed(approval, false, reason, `Approval by ${who} not counted: ${why}.`);
    const own = (authorship) =>
      no(
        'own_change',
        `${who} ${AUTHORSHIP_WORDS[authorship] || 'wrote part of this change'}, and this project does not count an approval of one’s own change`,
      );
    if (approval.status === 'withdrawn') return no('withdrawn', 'it was withdrawn');
    if (approval.status === 'dismissed') return no('dismissed', 'it was dismissed on GitHub');
    if (approval.status === 'superseded')
      return no('superseded', 'the same account reviewed again on GitHub since, without approving');
    if (!headSha || approval.headSha !== headSha)
      return no(
        'head_moved',
        `it approves ${short(approval.headSha)} and the pull request is at ${short(headSha)}`,
      );
    if (!approval.baseRef || (baseRef && approval.baseRef !== baseRef))
      return no(
        'base_changed',
        approval.baseRef
          ? `it was given against ${approval.baseRef} and the pull request now targets ${baseRef}`
          : 'the base branch it was given against is not known',
      );
    if (approval.source === 'github') {
      const account = { id: approval.githubUserId ?? null, login: approval.githubLogin };
      if (!policy.acceptGithubApprovals)
        return no(
          'github_not_accepted',
          'this project counts only approvals recorded through the Briareus API',
        );
      if (!linked)
        return no('github_unconfirmed', 'the accounts Briareus sessions act as could not be read just now');
      const automation =
        approval.automation ||
        (linked.some((other) => sameAccount(account, other)) ? 'linked_account' : null);
      if (automation) return no(automation, AUTOMATION_WORDS[automation] || 'it was submitted by automation');
      if (!COLLABORATORS.includes(approval.association))
        return no(
          'not_a_collaborator',
          'GitHub does not report the account as a collaborator of the repository',
        );
      if (gap) return no('authorship_unknown', gap);
      // What GitHub shows now could not be read: an approval dismissed since would
      // still read as standing here.
      if (unread)
        return no(
          'github_unconfirmed',
          `the pull request’s reviews could not be read from GitHub just now${github?.error ? ` (${github.error})` : ''}`,
        );
      const authorship =
        approval.authorship ||
        (policy.allowSelfApproval ? null : authorshipOf({ accounts: [account], authors }));
      if (authorship && !policy.allowSelfApproval) return own(authorship);
      // The account of somebody who already approved through the API is that person.
      const person = account.id != null ? `github:${account.id}` : `github:${lower(account.login)}`;
      if (people.has(person) || taken.some((other) => sameAccount(account, other)))
        return no('duplicate', 'the same person already approved this revision');
      people.add(person);
      taken.push(account);
      return listed(approval, true);
    }
    const user = approval.userId == null ? null : directory.user(approval.userId);
    if (!user) return no('approver_gone', 'the user no longer exists');
    if (user.disabled) return no('approver_disabled', 'the user is disabled');
    if (!directory.mayApprove(user.id, project))
      return no('approver_no_access', 'the user no longer has access to this project');
    /** @type {Array<{ id?: number | null, login?: string | null }>} */
    let accounts;
    try {
      accounts = [...directory.accountsOf(user.id)];
    } catch {
      return no('approver_unconfirmed', 'the GitHub accounts linked to Briareus could not be read just now');
    }
    // The account the approval was recorded with is theirs too, whatever was kept since.
    if (approval.githubLogin || approval.githubUserId != null)
      accounts.push({ id: approval.githubUserId ?? null, login: approval.githubLogin });
    if (needsAccount && !accounts.length)
      return no(
        'no_linked_account',
        `${who} has never linked a GitHub account to Briareus, so their approval cannot be told apart from their own change or from an approval on GitHub`,
      );
    if (gap) return no('authorship_unknown', gap);
    const authorship =
      approval.authorship ||
      (policy.allowSelfApproval
        ? null
        : authorshipOf({ accounts, authors, session: workers.includes(user.id) }));
    if (authorship && !policy.allowSelfApproval) return own(authorship);
    const person = `user:${user.id}`;
    if (people.has(person) || accounts.some((account) => taken.some((other) => sameAccount(account, other))))
      return no('duplicate', 'the same person already approved this revision');
    people.add(person);
    taken.push(...accounts);
    return listed(approval, true);
  });

  const counted = judged.filter((a) => a.counted);
  const valid = counted.length;
  const missing = Math.max(required - valid, 0);
  const names = counted.map((a) => a.by.name).filter(Boolean);
  const result = required === 0 ? 'not_required' : missing === 0 && reviewCurrent ? 'satisfied' : 'pending';

  const about = `${short(headSha) || 'this revision'}${baseRef ? ` against ${baseRef}` : ''}`;
  const asks =
    required === 0
      ? `This change is ${tier} risk, which asks for no human approval.`
      : `This change is ${tier} risk, which asks for ${plural(required, 'human approval', 'human approvals')} of ${about}.`;
  const has =
    required === 0
      ? ''
      : ` ${valid ? `${plural(valid, 'approval counts', 'approvals count')} (${names.join(', ')})` : 'No approval counts yet'}${missing ? `; ${missing} more ${missing === 1 ? 'is' : 'are'} needed` : ''}.`;
  if (required > 0 && missing > 0)
    reasons.push({
      code: 'approvals_missing',
      effect: 'pending',
      tier,
      required,
      valid,
      missing,
      message: `${asks}${has}`,
    });
  if (!reviewCurrent)
    reasons.push({
      ...(covered
        ? {
            code: 'review_running',
            message: `A code review of ${about} is still running: approvals make the pull request ready once it has ended.`,
          }
        : outcome.reviewed
          ? {
              code: 'review_not_current',
              reviewedHeadSha: outcome.reviewed.headSha,
              headSha,
              message: `The code review covered ${short(outcome.reviewed.headSha)}${outcome.reviewed.baseRef ? ` against ${outcome.reviewed.baseRef}` : ''}, not ${about}: approvals make the pull request ready only once this revision is reviewed.`,
            }
          : {
              code: 'no_review',
              message:
                'No code review covers this pull request yet: approvals make it ready only once it is reviewed.',
            }),
      // Nothing waits on it when nothing is asked: then it only explains the status.
      effect: required > 0 ? 'pending' : 'note',
    });
  if (risk.unknown)
    reasons.push({ ...risk.reasons.find((r) => r.code === 'file_list_unknown'), effect: 'note' });
  if (gap && approvals.some((a) => a.status === 'approved' && a.headSha === headSha))
    reasons.push({
      code: 'authorship_unknown',
      effect: 'note',
      message: `No approval of this revision counts for now: ${gap}, and this project does not count an approval of one’s own change.`,
    });
  if (unread)
    reasons.push({
      code: 'github_approvals_unread',
      effect: 'note',
      error: github?.error ?? null,
      message: `The pull request’s reviews could not be read from GitHub${github?.error ? ` (${github.error})` : ''}, so no approval given there counts until they can.`,
    });

  return {
    enabled: true,
    result,
    headSha,
    baseRef,
    tier,
    risk,
    required,
    valid,
    missing,
    reviewCurrent,
    acceptsGithubApprovals: policy.acceptGithubApprovals,
    allowsSelfApproval: policy.allowSelfApproval,
    // What the tier made required beyond approvals, whatever the project otherwise asks.
    requiredChecks: { security: !!risk.requireSecurity },
    approvals: judged,
    reasons,
    explanation: `${asks}${has}${reviewCurrent ? '' : covered ? ' The code review of this revision is still running.' : ' The code review does not cover this revision.'}`,
  };
}

/**
 * The commit status an approval requirement is published as: `success` when nothing is
 * asked or enough people approved, and a review of this revision has ended; `pending`
 * while it waits on people or on the review. Never `failure`: nobody did anything wrong
 * by not having approved yet. And never `success` for a revision no review has finished
 * with, whatever its tier asks: the status is of a reviewed revision.
 * @param {ReturnType<typeof computeApprovals>} approvals
 */
export function approvalStatusFor(approvals) {
  const at = short(approvals.headSha);
  const counted = `${approvals.valid} of ${plural(approvals.required, 'human approval', 'human approvals')}`;
  if (!approvals.enabled)
    return { state: 'success', description: 'Human approval is not required by this project' };
  const asks =
    approvals.required === 0
      ? `No human approval required at ${at}: ${approvals.tier} risk`
      : `${counted} at ${at} (${approvals.tier} risk)`;
  return {
    state: approvals.result === 'pending' || !approvals.reviewCurrent ? 'pending' : 'success',
    description: statusDescription(
      approvals.reviewCurrent ? asks : `${asks}; waiting for a review of this revision`,
    ),
  };
}
