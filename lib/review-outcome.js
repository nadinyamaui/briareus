// @ts-check
// What a code review of a pull request amounts to, as distinct from whether its session
// ran to the end (`code_reviews.status`). The outcome is computed here, by the server,
// from what it recorded: which steps it saw complete and on which head, the stored
// findings with their verdicts and evidence, the decisions still standing on the pull
// request, and the revision that was reviewed against the one the PR has now. Nothing an
// agent says or does stands in for any of it: a label, an approval and a clean exit of
// the last turn are not inputs.
//
// Pure, so the whole rule set can be tested as a table. lib/review-enforcement.js feeds
// it from the store, keeps the result and publishes it to GitHub.

export const OUTCOMES = ['pending', 'incomplete', 'changes_required', 'passed'];

// The steps every review runs, in order. A review may require more (its stage rows say
// which: Codex's delegation receipt today), and every row it has is required.
export const REVIEW_STAGES = ['discover', 'publish', 'verify', 'label'];
export const DELEGATION_STAGE = 'delegation';
// The security pass, a second discovery whose findings are published and verified with
// the rest. Its record is kept like any stage's and judged apart (lib/review-security.js):
// what it amounts to is the security result, which reaches the outcome as a requirement
// when the project requires the pass, and not at all otherwise.
export const SECURITY_STAGE = 'security';

// The stage rows a review starts with: the security pass follows discovery, and the
// delegation receipt is checked between publication, where Codex writes it, and
// verification.
/** @param {{ delegation?: boolean, security?: boolean }} [options] */
export function requiredReviewStages({ delegation = false, security = false } = {}) {
  return [
    'discover',
    ...(security ? [SECURITY_STAGE] : []),
    'publish',
    ...(delegation ? [DELEGATION_STAGE] : []),
    'verify',
    'label',
  ];
}

// The name of the commit status, the one a repository requires in its branch
// protection. A contract string: changing it silently lifts that requirement everywhere.
export const STATUS_CONTEXT = 'briareus/code-review';
// GitHub refuses a longer description.
export const STATUS_DESCRIPTION_MAX = 140;

/**
 * Whether a finding is settled, and if not what is missing.
 *
 * A verdict is needed to block nothing; none is needed to block. A `fix` therefore
 * always stands, confirmed, plausible or bare: a defect the verification step could not
 * rule out is the author's to answer, and waving it through for lack of proof would
 * make doubt the cheapest way to pass. The two verdicts that let a finding through must
 * show their work:
 *
 * - `optional` says the claim does not block even if it holds, so it needs the
 *   explanation of that (`comments`) and a recorded verification, `confirmed` or
 *   `plausible`: whether the claim was proven changes nothing about its not blocking,
 *   and its thread stays open for people to see.
 * - `dismiss` says the claim is wrong or already covered. It takes the claim out of the
 *   review for good (later rounds suppress it), so it needs its reason and a
 *   `confirmed` verification. A `plausible` dismissal is a refutation nobody proved,
 *   which is the definition of a finding that was not verified.
 *
 * `verification` is read as how well the verdict is established, which is how the
 * verification step is told to record it.
 *
 * The same rule is applied to the verdict wherever it is kept: on the finding, and on
 * the pull request's decision that outlives it (decisionEvidence), so a verdict that did
 * not clear its finding does not clear the claim in a rerun or in the next round either.
 * @param {{ verdict?: string | null, verification?: string | null, reason?: string | null }} verdict
 * @returns {{ state: 'cleared' | 'fix' | 'open', code?: string, missing?: string[] }}
 */
function verdictEvidence({ verdict = null, verification = null, reason = null }) {
  if (verdict === 'fix') return { state: 'fix' };
  if (!verdict) return { state: 'open', code: 'finding_without_verdict', missing: ['shouldFix'] };
  const missing = [
    ...(verification ? [] : ['verification']),
    ...(String(reason || '').trim() ? [] : ['comments']),
  ];
  if (missing.length) return { state: 'open', code: 'finding_unverified', missing };
  if (verdict === 'dismiss' && verification !== 'confirmed')
    return { state: 'open', code: 'dismissal_unproven', missing: ['verification'] };
  return { state: 'cleared' };
}

/**
 * Whether a stored decision (lib/db.js, code_review_decisions) is established, by the
 * rule above. A decision with no recorded verification is not: one read from GitHub's
 * history, or stored before the verification was kept with it, was never seen to be
 * proven, and stays open until somebody rules on it again.
 * @param {{ verdict?: string | null, verification?: string | null, rationale?: string | null }} decision
 */
export function decisionEvidence(decision) {
  return verdictEvidence({
    verdict: decision.verdict,
    verification: decision.verification,
    reason: decision.rationale,
  });
}

/**
 * Whether a finding is settled by its own record.
 *
 * A suppressed duplicate carries the verdict of an earlier decision instead of one of
 * its own, so it is cleared by that decision and only while that decision is itself
 * established: `claim` says how the claim stands on the pull request (`settled`), or
 * what the earlier decision lacks (`missing`). Without one it is not cleared. A person
 * can still overrule it with a `fix`, or record the missing verification on it.
 * @param {any} finding
 * @param {{ settled?: boolean, owed?: boolean, verdict?: string | null, missing?: string[] } | null} [claim]
 * @returns {{ state: 'cleared' | 'fix' | 'open', code?: string, missing?: string[] }}
 */
export function findingEvidence(finding, claim = null) {
  const verdict = finding.shouldFix || null;
  if (finding.reconciliation !== 'suppressed' || verdict === 'fix' || !verdict)
    return verdictEvidence({ verdict, verification: finding.verification, reason: finding.comments });
  // A fix the claim has come to owe since is listed for the claim itself.
  if (claim?.settled || claim?.owed) return { state: 'cleared' };
  return { state: 'open', code: 'prior_decision_unverified', missing: claim?.missing || ['decision'] };
}

const short = (sha) => String(sha || '').slice(0, 7);
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
// By code point: half of a surrogate pair is not text, and the database stores what it
// is given differently from how it was sent.
const clip = (text, max) => {
  const points = [...String(text).toWellFormed()];
  return points.length > max ? `${points.slice(0, max - 1).join('')}…` : points.join('');
};
const named = (finding) => (finding.title ? `"${clip(finding.title, 120)}"` : 'A finding');

const MISSING = {
  shouldFix: 'a verdict',
  verification: 'a recorded verification',
  comments: 'its evidence',
  decision: 'a decision on record',
};
const without = (missing) => (missing || []).map((m) => MISSING[m] || m).join(' and ');
const VERDICT_WORDS = { dismiss: 'dismissed', optional: 'marked optional' };

function findingReason(finding, evidence) {
  const about = {
    findingId: finding.id ?? null,
    findingRef: finding.findingRef ?? null,
    threadId: finding.threadId ?? null,
    title: finding.title ?? null,
    filePath: finding.filePath ?? null,
  };
  if (evidence.state === 'fix')
    return {
      code: 'fix_required',
      effect: 'changes_required',
      message: `${named(finding)} is a required fix.`,
      ...about,
    };
  const message =
    evidence.code === 'dismissal_unproven'
      ? `${named(finding)} was dismissed without proof (verification is plausible): a dismissal needs a confirmed verification.`
      : evidence.code === 'finding_without_verdict'
        ? `${named(finding)} has no verdict.`
        : evidence.code === 'prior_decision_unverified'
          ? `${named(finding)} repeats a claim an earlier review ${VERDICT_WORDS[finding.shouldFix] || 'decided'} without ${without(evidence.missing)}, so that decision does not clear it: record the verification on this finding or on the decision.`
          : `${named(finding)} is ${finding.shouldFix === 'dismiss' ? 'dismissed' : 'optional'} without ${without(evidence.missing)}.`;
  return { code: evidence.code, effect: 'incomplete', message, missing: evidence.missing, ...about };
}

function stageReasons(review, stages, required) {
  if (!stages.length)
    return [
      {
        code: 'stages_not_recorded',
        effect: 'incomplete',
        message:
          'Briareus has no record of what this review’s steps did (it ran before outcomes were recorded, or the record could not be written): run the review again.',
      },
    ];
  const byName = new Map(stages.map((s) => [s.stage, s]));
  const reasons = [];
  for (const stage of required) {
    const row = byName.get(stage);
    const reason = (code, message, more = {}) =>
      reasons.push({ code, effect: 'incomplete', stage, message, ...more });
    if (!row || row.status === 'pending' || row.headSha !== review.headSha)
      reason('stage_not_run', `The ${stage} step did not run for ${short(review.headSha)}.`);
    else if (row.status === 'failed')
      reason('stage_failed', `The ${stage} step failed${row.detail?.error ? `: ${row.detail.error}` : '.'}`, {
        error: row.detail?.error ?? null,
      });
    else if (row.status !== 'completed')
      reason('stage_interrupted', `The ${stage} step was interrupted before it finished.`);
  }
  return reasons;
}

/**
 * What a review's findings and the claims standing on the pull request leave unsettled:
 * the reasons, and how many findings ended where. The one reading of the evidence rule,
 * shared by the outcome and by the security result (lib/review-security.js), which
 * applies it to the findings and claims marked as security ones.
 *
 * `earlier` false leaves out what earlier rounds left on the pull request and this
 * review does not answer for: the reading of one review's own findings.
 * @param {{
 *   findings?: any[],
 *   standing?: { fix: any[], unverified: any[], settled?: Iterable<string> },
 *   earlier?: boolean,
 * }} input
 */
export function evidenceReasons({ findings = [], standing = { fix: [], unverified: [] }, earlier = true }) {
  const counts = { fix: 0, optional: 0, dismissed: 0, suppressed: 0, unverified: 0 };
  /** @type {any[]} */
  const reasons = [];
  // The claims this review already answers for, so a standing decision on the same
  // claim is not listed a second time.
  const answered = new Set();
  const settled = new Set(standing.settled || []);
  const owed = new Set(standing.fix.map((entry) => entry.findingRef));
  const unproven = new Map(standing.unverified.map((entry) => [entry.findingRef, entry]));
  for (const finding of findings) {
    const ref = finding.findingRef || null;
    const evidence = findingEvidence(
      finding,
      ref ? { settled: settled.has(ref), owed: owed.has(ref), missing: unproven.get(ref)?.missing } : null,
    );
    if (evidence.state === 'cleared') {
      if (finding.reconciliation === 'suppressed') counts.suppressed++;
      else if (finding.shouldFix === 'optional') counts.optional++;
      else counts.dismissed++;
    } else {
      if (evidence.state === 'fix') counts.fix++;
      else counts.unverified++;
      reasons.push(findingReason(finding, evidence));
      if (finding.findingRef) answered.add(finding.findingRef);
    }
    // Registered as posted, and the server never found the comment on the pull request:
    // it cannot say the finding was published, nor keep its verdict on a thread.
    if (finding.reconciliation !== 'suppressed' && finding.commentId != null && !finding.threadId)
      reasons.push({
        code: 'finding_unlinked',
        effect: 'incomplete',
        message: `${named(finding)} names inline comment ${finding.commentId}, which was not found on the pull request.`,
        findingId: finding.id ?? null,
        findingRef: finding.findingRef ?? null,
        commentId: finding.commentId,
      });
  }
  if (!earlier) return { reasons, counts };
  // What earlier rounds left on the pull request and this review does not answer for:
  // a required fix still owed, a published finding nobody ruled on.
  for (const [list, code, effect, what] of /** @type {const} */ ([
    [standing.fix, 'fix_owed', 'changes_required', 'is a required fix still owed from an earlier review'],
    [
      standing.unverified,
      'earlier_finding_unverified',
      'incomplete',
      'was published by an earlier review and has no verified verdict',
    ],
  ])) {
    for (const entry of list) {
      if (entry.findingRef && answered.has(entry.findingRef)) continue;
      if (effect === 'changes_required') counts.fix++;
      else counts.unverified++;
      // Ruled on, but never seen to be proven: the verdict an earlier review, a client or
      // GitHub's history left on the claim lacks what would let it through.
      const lacking = effect === 'incomplete' && entry.verdict && entry.missing?.length;
      reasons.push({
        code,
        effect,
        message: lacking
          ? `${named(entry)} was ${VERDICT_WORDS[entry.verdict] || 'decided'} earlier without ${without(entry.missing)}, so that decision does not stand as verified.`
          : `${named(entry)} ${what}.`,
        findingRef: entry.findingRef ?? null,
        threadId: entry.threadId ?? null,
        title: entry.title ?? null,
        filePath: entry.filePath ?? null,
        ...(lacking ? { verdict: entry.verdict, missing: entry.missing } : {}),
      });
    }
  }
  return { reasons, counts };
}

/**
 * The outcome of a pull request's code review.
 *
 * - `pending`: nothing to judge yet. No review covers the PR, one is running, or the
 *   PR moved on from what was reviewed (`stale`) and a review of the new revision is
 *   still to come.
 * - `incomplete`: a review ran and a verdict cannot be drawn from it. A required stage
 *   is missing, failed or was interrupted; a finding has no verdict or its verdict lacks
 *   evidence (findingEvidence); a published finding could not be tied to its thread; an
 *   earlier round left a finding unverified; or the revision is unreviewed and the round
 *   limit means no review of it starts by itself.
 * - `changes_required`: the review is complete and a required fix stands, from this
 *   review or still owed from an earlier round.
 * - `passed`: every required stage completed on the reviewed head, which is still the
 *   PR's head against the same base branch, every finding is a properly verified
 *   Optional or Dismissed, or a suppressed duplicate of one, and every requirement the
 *   caller evaluated is met (the security pass of a project that requires it).
 *
 * `incomplete` outranks `changes_required`: "changes required" is a claim that the
 * review finished, and every reason is listed either way. The round limit never passes
 * anything and never fails a review that did complete: on the reviewed head it is a note
 * that no further round starts by itself.
 *
 * `reasons` is the list a client or a person acts on: `{ code, effect, message, … }`,
 * `effect` being the outcome that reason alone leads to, or `note` for one that only
 * informs.
 *
 * @param {{
 *   review?: { id?: number, status?: string, headSha?: string | null, baseRef?: string | null } | null,
 *   stages?: any[], findings?: any[],
 *   standing?: { fix: any[], unverified: any[], settled?: Iterable<string> },
 *   current?: { headSha?: string | null, baseRef?: string | null } | null,
 *   rounds?: { limitReached?: boolean, used?: number, limit?: number },
 *   requirements?: Array<{ id: string, outcome: string, message?: string }>,
 *   provisional?: boolean,
 * }} input
 * `review` is the review that governs the pull request, `standing` what its stored
 * decisions leave unresolved and which claims they settle (unresolvedWork and
 * settledClaims in lib/review-rounds.js: a verdict without its evidence leaves the claim
 * unverified there, whichever review gave it) and `current` the
 * PR's revision as last seen (the reviewed one when unknown). `requirements` are further
 * conditions a caller evaluated itself: each not `passed` adds a reason with its own
 * outcome as effect. `provisional` is the reading taken before the label step: the
 * review is still running and that step has not happened, and neither counts against it.
 */
export function computeReviewOutcome({
  review = null,
  stages = [],
  findings = [],
  standing = { fix: [], unverified: [] },
  current = null,
  rounds = {},
  requirements = [],
  provisional = false,
}) {
  const reviewed = review?.headSha ? { headSha: review.headSha, baseRef: review.baseRef ?? null } : null;
  const head = {
    headSha: current?.headSha || reviewed?.headSha || null,
    baseRef: current?.baseRef || reviewed?.baseRef || null,
  };
  const counts = { fix: 0, optional: 0, dismissed: 0, suppressed: 0, unverified: 0 };
  /** @param {string} outcome @param {any[]} reasons @param {boolean} [stale] */
  const answer = (outcome, reasons, stale = false) => ({
    outcome,
    reasons,
    stale,
    reviewId: review?.id ?? null,
    reviewed,
    ...head,
    counts,
  });
  const atLimit = (what) => ({
    code: 'round_limit_reached',
    effect: what,
    message: `The pull request has used ${rounds.used} of its ${rounds.limit} review rounds, so no further review starts until a person continues it.`,
    used: rounds.used ?? null,
    limit: rounds.limit ?? null,
  });
  // A revision nobody reviewed waits for its review, unless the round limit means none
  // is coming: then it waits on a person, and saying "pending" would promise a review.
  const unreviewed = (reason) =>
    rounds.limitReached
      ? answer('incomplete', [reason, atLimit('incomplete')], reason.code !== 'no_review')
      : answer('pending', [reason], reason.code !== 'no_review');

  if (!reviewed)
    return unreviewed({
      code: 'no_review',
      effect: 'pending',
      message: 'No code review of this pull request has checked out a revision yet.',
    });
  const moved = !!current?.headSha && current.headSha !== reviewed.headSha;
  const retargeted = !!current?.baseRef && !!reviewed.baseRef && current.baseRef !== reviewed.baseRef;
  // A review that is running covers the revision it checked out. Once the pull request
  // is at another one, what waits is a review of that, whatever this one finds.
  if (review.status === 'running' && !provisional && !moved && !retargeted)
    return answer('pending', [
      {
        code: 'review_running',
        effect: 'pending',
        message: `A code review of ${short(reviewed.headSha)} is running.`,
      },
    ]);
  if (moved)
    return unreviewed({
      code: 'head_moved',
      effect: 'pending',
      message: `The pull request head is ${short(current.headSha)}; the review covered ${short(reviewed.headSha)}.`,
      reviewedHeadSha: reviewed.headSha,
      headSha: current.headSha,
    });
  // Only a change of the branch the PR targets: that changes what the PR is. The base
  // branch gaining commits under an unchanged head leaves the reviewed commits what
  // they were, and whether a branch must be up to date is the repository's own rule.
  if (retargeted)
    return unreviewed({
      code: 'base_changed',
      effect: 'pending',
      message: `The pull request now targets ${current.baseRef}; the review was against ${reviewed.baseRef}.`,
      reviewedBaseRef: reviewed.baseRef,
      baseRef: current.baseRef,
    });

  // Every stage the review has a row for is required, but the security pass: that one
  // is judged apart, and what it amounts to arrives as a requirement.
  const required = [...new Set([...REVIEW_STAGES, ...stages.map((s) => s.stage)])].filter(
    (stage) => stage !== SECURITY_STAGE && (!provisional || stage !== 'label'),
  );
  const reasons = stageReasons(reviewed, stages, required);
  const evidence = evidenceReasons({ findings, standing });
  Object.assign(counts, evidence.counts);
  reasons.push(...evidence.reasons);
  for (const requirement of requirements) {
    if (requirement.outcome === 'passed') continue;
    reasons.push({
      code: 'requirement_unmet',
      effect: requirement.outcome,
      requirement: requirement.id,
      message: requirement.message || `The ${requirement.id} requirement is not met.`,
    });
  }
  const has = (effect) => reasons.some((r) => r.effect === effect);
  const outcome = has('incomplete')
    ? 'incomplete'
    : has('changes_required')
      ? 'changes_required'
      : has('pending')
        ? 'pending'
        : 'passed';
  if (outcome === 'passed') return answer(outcome, reasons);
  // What the label step was found to have done against the outcome it was given
  // (lib/review-enforcement.js). Never a reason to fail by itself: the outcome already
  // does not pass, and these say that a label or an approval on GitHub is not it.
  const label = stages.find((s) => s.stage === 'label' && s.headSha === reviewed.headSha);
  for (const note of label?.detail?.notes || []) reasons.push({ ...note, effect: 'note' });
  if (rounds.limitReached) reasons.push(atLimit('note'));
  return answer(outcome, reasons);
}

const STATUS_STATES = {
  pending: 'pending',
  passed: 'success',
  // The review ran and the code has to change.
  changes_required: 'failure',
  // The review itself did not reach a verdict. GitHub blocks a required status on
  // either; `error` is its word for a check that could not finish, so a person can tell
  // "fix the code" from "attend to the review" without opening anything.
  incomplete: 'error',
};

/**
 * The commit status an outcome is published as: `{ state, description }`, the
 * description cut to what GitHub accepts.
 *
 * `privately` is the outcome of a project that keeps its code reviews off GitHub
 * (postReviewToGithub off): a reason's message can quote a finding's title, so an
 * incomplete one is described by how many reasons there are and nothing they say.
 * @param {ReturnType<typeof computeReviewOutcome>} result
 * @param {{ privately?: boolean }} [options]
 */
export function statusFor(result, { privately = false } = {}) {
  const { outcome, reasons, counts } = result;
  const first = reasons.find((r) => r.effect !== 'note');
  const more = reasons.filter((r) => r.effect !== 'note').length - 1;
  let description;
  if (outcome === 'passed') {
    const cleared = [
      counts.optional ? `${counts.optional} optional` : null,
      counts.dismissed ? `${counts.dismissed} dismissed` : null,
      counts.suppressed ? `${counts.suppressed} decided earlier` : null,
    ].filter(Boolean);
    description = `Review passed at ${short(result.headSha)}: ${cleared.length ? `${cleared.join(', ')}, nothing to fix` : 'no findings'}`;
  } else if (outcome === 'changes_required') {
    description = `${plural(counts.fix, 'required fix', 'required fixes')} at ${short(result.headSha)}`;
  } else if (first?.code === 'review_running') {
    description = `Review of ${short(result.headSha)} in progress`;
  } else if (outcome === 'pending') {
    description = `Waiting for a review of ${short(result.headSha)}`;
  } else if (first?.code === 'head_moved' || first?.code === 'base_changed' || first?.code === 'no_review') {
    description = `Not reviewed at ${short(result.headSha)}; the review limit is reached and a person must continue`;
  } else if (privately) {
    description = `Review incomplete at ${short(result.headSha)}: ${plural(more + 1, 'reason', 'reasons')}, kept off GitHub`;
  } else {
    description = `Review incomplete: ${String(first?.message || '').replace(/\.$/, '')}${more > 0 ? ` (+${more} more)` : ''}`;
  }
  return { state: STATUS_STATES[outcome], description: statusDescription(description) };
}

// Cut to what GitHub accepts without ever cutting a character in half: a description
// ending in half a surrogate pair is stored as something else than was sent, and would
// never again compare equal to what GitHub was told. Counted in UTF-16 units, the
// stricter of the two ways GitHub might count, and whole characters are kept.
/** @param {string} text */
export function statusDescription(text) {
  const whole = String(text).toWellFormed();
  if (whole.length <= STATUS_DESCRIPTION_MAX) return whole;
  let kept = '';
  for (const character of whole) {
    if (kept.length + character.length > STATUS_DESCRIPTION_MAX - 1) break;
    kept += character;
  }
  return `${kept}…`;
}
