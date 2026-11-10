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

// GitHub's own word for an account that may push to the repository, as it reports it on
// a review. Anybody can approve a public repository's pull request; only these count.
const COLLABORATORS = ['OWNER', 'MEMBER', 'COLLABORATOR'];
// GitHub's clock and this server's are not the same clock.
const CLOCK_SLACK_MS = 60_000;

const short = (sha) => String(sha || '').slice(0, 7);
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const lower = (login) => String(login || '').toLowerCase();

/**
 * Who the server can ask about a Briareus user, as server.js wires it in. Without one
 * nobody is known, and an approval by somebody unknown does not count.
 * @typedef {{
 *   user: (id: number) => { id: number, name: string, disabled: boolean } | null,
 *   mayApprove: (id: number, project: any) => boolean,
 *   linkedLogins: () => string[],
 * }} ApprovalDirectory
 */
/** @type {ApprovalDirectory} */
export const NO_DIRECTORY = { user: () => null, mayApprove: () => false, linkedLogins: () => [] };

/**
 * How the person who wants to approve relates to the change, from what the server can
 * know: `author` when the pull request is theirs on GitHub, `commits` when commits of it
 * carry their GitHub account (which is also how a session of theirs commits once they
 * linked one), `session` when a session they own worked on the pull request. Null when
 * none of that holds.
 *
 * What this cannot see: commits somebody pushed under a GitHub account they never linked
 * here, and the work of a session that was deleted before they linked an account, which
 * committed as the server.
 * @param {{ login?: string | null, author?: string | null, commitAuthors?: string[], session?: boolean }} p
 * @returns {'author' | 'commits' | 'session' | null}
 */
export function authorshipOf({ login = null, author = null, commitAuthors = [], session = false }) {
  const own = lower(login);
  if (own && own === lower(author)) return 'author';
  if (own && commitAuthors.some((name) => lower(name) === own)) return 'commits';
  return session ? 'session' : null;
}

// The errands a session runs on somebody's pull request without writing its code: a
// person who asked for one of these did not thereby author the change.
const READ_ONLY_ERRANDS = ['review', 'test-sheet', 'test-run', 'pr-body-summary'];

/**
 * Whether a user owns a session that worked on a pull request: the session that opened
 * it, or one started on it for anything but reading it (a review, QA, a preview). This
 * is what ties a change to a person whose sessions commit as the server's account.
 * Only sessions the server still has: one deleted since leaves no trace here.
 * @param {any[]} sessions the session records @param {{ userId: number, repo: string, prNumber: number }} p
 */
export function ownsWorkOn(sessions, { userId, repo, prNumber }) {
  const key = lower(repo);
  return sessions.some(
    (s) =>
      s.ownerId === userId &&
      lower(s.repo) === key &&
      (s.startedOnPr === prNumber || s.prStatus?.number === prNumber) &&
      !s.preview &&
      !READ_ONLY_ERRANDS.includes(s.activity),
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
 *
 * A person's verdict on GitHub is their latest one: an approval followed by a request
 * for changes from the same account is `superseded`. `dismissed` lists the reviews
 * GitHub now shows as dismissed, for the rows already stored under those ids.
 * @param {any[]} reviews the pull request's reviews as GitHub lists them, oldest first
 * @param {{
 *   headSha: string, baseRef: string | null, serverLogin: string, linkedLogins?: string[],
 *   author?: string | null, commitAuthors?: string[],
 *   labelStep?: { login?: string | null, known?: number[] | null, since?: number | null } | null,
 * }} context
 */
export function githubApprovalRows(reviews, context) {
  const { headSha, baseRef, serverLogin, linkedLogins = [], author = null, commitAuthors = [] } = context;
  const linked = new Set(linkedLogins.map(lower));
  const labelStep = context.labelStep || null;
  const reviewer = lower(labelStep?.login || serverLogin);
  const known = labelStep?.known ? new Set(labelStep.known) : null;
  // The latest verdict of each account: a comment decides nothing.
  const latest = new Map();
  for (const review of reviews) {
    if (!['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(review?.state)) continue;
    latest.set(lower(review.user?.login), review.id);
  }
  const rows = [];
  const dismissed = [];
  for (const review of reviews) {
    if (review?.state === 'DISMISSED') dismissed.push(review.id);
    if (review?.state !== 'APPROVED' || !Number.isInteger(review.id)) continue;
    const login = String(review.user?.login || '');
    const submitted = Date.parse(review.submitted_at) || null;
    const inLabelStep =
      !!labelStep &&
      lower(login) === reviewer &&
      (known
        ? !known.has(review.id)
        : !!labelStep.since && !!submitted && submitted >= labelStep.since - CLOCK_SLACK_MS);
    rows.push({
      githubReviewId: review.id,
      githubLogin: login,
      status: latest.get(lower(login)) === review.id ? 'approved' : 'superseded',
      headSha: String(review.commit_id || ''),
      // Known only for an approval of the head the server is looking at: that is the
      // base branch it was first seen against, kept from then on.
      baseRef: review.commit_id === headSha ? baseRef : null,
      association: String(review.author_association || '') || null,
      automation: inLabelStep
        ? 'review_label_step'
        : !login || lower(login) === lower(serverLogin)
          ? 'server_account'
          : review.user?.type === 'Bot' || login.endsWith('[bot]')
            ? 'bot_account'
            : linked.has(lower(login))
              ? 'linked_account'
              : null,
      authorship: authorshipOf({ login, author, commitAuthors }),
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
  session: 'owns a session that worked on this pull request',
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
 * The approval requirement of a pull request and how it stands.
 *
 * - `not_required`: the project has no approval policy switched on, or the change's
 *   tier asks for no approval.
 * - `pending`: approvals are required and too few count for the revision the pull
 *   request has now, or the review does not cover that revision (none ran, or the pull
 *   request moved on): approvals of a revision nobody reviewed make nothing ready.
 * - `satisfied`: enough people approved exactly this head against this base branch, and
 *   the review covers it.
 *
 * `satisfied` says the people approved, not that the review passed: `ready` in the read
 * model (lib/review-enforcement.js) is both.
 *
 * Every approval on record is listed with whether it counts and, when it does not, why
 * (`reason`, `message`). `reasons` explains the requirement itself in plain words: the
 * tier and what produced it, how many approvals that asks for, how many count and by
 * whom, and what is still missing.
 *
 * @param {{
 *   policy: any, project?: any,
 *   risk: any,
 *   outcome: { outcome?: string, stale?: boolean, reviewed?: { headSha: string, baseRef: string | null } | null, headSha?: string | null, baseRef?: string | null },
 *   security?: { result?: string, counts?: { findings?: number } } | null,
 *   approvals?: any[],
 *   github?: { syncedAt?: string | null, error?: string | null } | null,
 *   directory?: ApprovalDirectory,
 * }} input
 * `policy` is the project's approval policy when switched on, else null; `risk` the
 * assessment that stands for the revision (riskOf in lib/review-risk.js); `outcome` the
 * review outcome computed for the same revision; `approvals` everything on record for
 * the pull request; `github` how current the approvals read from GitHub are.
 */
export function computeApprovals({
  policy,
  project = null,
  risk,
  outcome,
  security = null,
  approvals = [],
  github = null,
  directory = NO_DIRECTORY,
}) {
  const headSha = outcome.headSha || null;
  const baseRef = outcome.baseRef || null;
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
      reviewCurrent: !!outcome.reviewed && !outcome.stale,
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
  const reviewCurrent = !!outcome.reviewed && !outcome.stale;
  // Which accounts sessions act as may not be knowable right now (the store that says
  // is not loaded): then no approval given on GitHub can be told from automation's.
  /** @type {Set<string> | null} */
  let linked = null;
  try {
    linked = new Set(directory.linkedLogins().map(lower));
  } catch {
    linked = null;
  }
  const people = new Set();
  const unread = policy.acceptGithubApprovals && (!github?.syncedAt || !!github.error);

  const judged = approvals.map((approval) => {
    const who = approverOf(approval, directory).name || 'somebody';
    const no = (reason, why) => listed(approval, false, reason, `Approval by ${who} not counted: ${why}.`);
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
      if (!policy.acceptGithubApprovals)
        return no(
          'github_not_accepted',
          'this project counts only approvals recorded through the Briareus API',
        );
      if (!linked)
        return no('github_unconfirmed', 'the accounts Briareus sessions act as could not be read just now');
      const automation =
        approval.automation || (linked.has(lower(approval.githubLogin)) ? 'linked_account' : null);
      if (automation) return no(automation, AUTOMATION_WORDS[automation] || 'it was submitted by automation');
      if (!COLLABORATORS.includes(approval.association))
        return no(
          'not_a_collaborator',
          'GitHub does not report the account as a collaborator of the repository',
        );
      // What GitHub shows now could not be read: an approval dismissed since would
      // still read as standing here.
      if (unread)
        return no(
          'github_unconfirmed',
          `the pull request’s reviews could not be read from GitHub just now${github?.error ? ` (${github.error})` : ''}`,
        );
    } else {
      const user = approval.userId == null ? null : directory.user(approval.userId);
      if (!user) return no('approver_gone', 'the user no longer exists');
      if (user.disabled) return no('approver_disabled', 'the user is disabled');
      if (!directory.mayApprove(user.id, project))
        return no('approver_no_access', 'the user no longer has access to this project');
    }
    if (approval.authorship && !policy.allowSelfApproval)
      return no(
        'own_change',
        `${who} ${AUTHORSHIP_WORDS[approval.authorship] || 'wrote part of this change'}, and this project does not count an approval of one’s own change`,
      );
    const person =
      approval.source === 'github' ? `github:${lower(approval.githubLogin)}` : `user:${approval.userId}`;
    if (people.has(person)) return no('duplicate', 'the same person already approved this revision');
    people.add(person);
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
  if (required > 0 && !reviewCurrent)
    reasons.push(
      outcome.reviewed
        ? {
            code: 'review_not_current',
            effect: 'pending',
            reviewedHeadSha: outcome.reviewed.headSha,
            headSha,
            message: `The code review covered ${short(outcome.reviewed.headSha)}${outcome.reviewed.baseRef ? ` against ${outcome.reviewed.baseRef}` : ''}, not ${about}: approvals make the pull request ready only once this revision is reviewed.`,
          }
        : {
            code: 'no_review',
            effect: 'pending',
            message:
              'No code review covers this pull request yet: approvals make it ready only once it is reviewed.',
          },
    );
  if (risk.unknown)
    reasons.push({ ...risk.reasons.find((r) => r.code === 'file_list_unknown'), effect: 'note' });
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
    explanation: `${asks}${has}${required > 0 && !reviewCurrent ? ' The code review does not cover this revision.' : ''}`,
  };
}

/**
 * The commit status an approval requirement is published as: `success` when nothing is
 * asked or enough people approved the reviewed revision, `pending` while it waits on
 * people or on the review. Never `failure`: nobody did anything wrong by not having
 * approved yet.
 * @param {ReturnType<typeof computeApprovals>} approvals
 */
export function approvalStatusFor(approvals) {
  const at = short(approvals.headSha);
  const counted = `${approvals.valid} of ${plural(approvals.required, 'human approval', 'human approvals')}`;
  let description;
  if (!approvals.enabled) description = 'Human approval is not required by this project';
  else if (approvals.result === 'not_required')
    description = `No human approval required at ${at}: ${approvals.tier} risk`;
  else if (approvals.result === 'satisfied') description = `${counted} at ${at} (${approvals.tier} risk)`;
  else if (!approvals.reviewCurrent)
    description = `${counted} at ${at} (${approvals.tier} risk); waiting for a review of this revision`;
  else description = `${counted} at ${at} (${approvals.tier} risk)`;
  return {
    state: approvals.result === 'pending' ? 'pending' : 'success',
    description: statusDescription(description),
  };
}
