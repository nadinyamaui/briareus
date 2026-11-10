// @ts-check
// The security result of a code review: what its security pass amounts to, tracked
// apart from the review outcome (lib/review-outcome.js) and computed the same way, by
// the server, from what it recorded.
//
// The pass is a second discovery inside the review, after the provider's own and before
// publication (lib/jobs.js). Its findings are findings of the review like any other:
// reconciled with the pull request's earlier threads, published, verified and decided by
// the same steps, and held to the same evidence rule, here and in the outcome. A security
// finding verified as a required fix therefore blocks as any required fix does, whatever
// the project's policy. What the policy decides is whether the pass itself is owed: under
// `required` a pass that did not run, did not complete or failed keeps the outcome from
// passing; under `advisory` the result is computed and shown and adds nothing to the
// outcome.
//
// So the mark on a finding only ever adds to what blocks, and that is deliberate. It is
// asked for by the review's publish step, whose agent merges two overlapping reports: if
// a marked finding stopped counting under some policy, that agent's classification would
// decide which required fixes block, and the outcome would no longer be the server's.
//
// "No findings" is not "did not look": the pass completes only on a coverage record the
// agent wrote for the reviewed head, assessing every category below against what the
// change touches, a category it does not touch with the reason. The server checks that
// record (securityCoverage) and keeps it with the pass's stage.
//
// Pure, like the outcome, so the rules can be tested as a table.
import { SECURITY_STAGE, evidenceReasons } from './review-outcome.js';

// The project's policy. Off unless it was switched on: existing projects run the review
// they always ran.
export const SECURITY_POLICIES = ['off', 'advisory', 'required'];

/** @param {any} project @returns {'off' | 'advisory' | 'required'} */
export function securityPolicyOf(project) {
  return SECURITY_POLICIES.includes(project?.securityReview) ? project.securityReview : 'off';
}

export const SECURITY_RESULTS = ['not_required', 'not_run', 'pending', 'incomplete', 'failed', 'passed'];

// What the pass assesses. The ids are stored with every coverage record and read by
// clients: add to the list, never rename.
export const SECURITY_CATEGORIES = [
  {
    id: 'permissions',
    covers:
      'permissions and authorization: who may call what the change adds or alters, missing or weakened checks, privilege escalation, and trust placed in something the caller controls',
  },
  {
    id: 'secrets',
    covers:
      'secrets and credentials: tokens, keys and passwords the change stores, logs, returns, commits, passes on a command line or sends to another service',
  },
  {
    id: 'isolation',
    covers:
      'user and tenant isolation: data access boundaries, lookups by an id the caller chose, queries and caches that are not scoped to their owner, and one user’s state reaching another',
  },
  {
    id: 'execution',
    covers:
      'command execution and injection: shell commands, SQL, path traversal and file access, SSRF and outbound requests to a caller-chosen target, deserialization, and template or expression injection',
  },
  {
    id: 'untrusted_input',
    covers:
      'other unsafe use of untrusted input: request data, webhook payloads, file contents and model or agent output used without validation, including output that reaches a browser or a prompt',
  },
  {
    id: 'dependencies',
    covers:
      'dependencies and supply chain: new or changed packages, lockfiles, install and build scripts, CI workflows and anything fetched and run at build or run time',
  },
];
const CATEGORY_IDS = SECURITY_CATEGORIES.map((c) => c.id);
const SEVERITIES = ['critical', 'high', 'medium', 'low'];

// An assessment has to say something: what was looked at, or why nothing applies.
export const ASSESSMENT_MIN = 20;
// Six of these and what a pass widened to are kept in one stage row's detail, a TEXT
// column: short enough that the whole record fits whatever its characters weigh.
export const ASSESSMENT_MAX = 1000;
// As many as a review holds (MAX_FINDINGS in lib/code-reviews.js).
const RECORD_FINDINGS_MAX = 100;

const short = (sha) => String(sha || '').slice(0, 7);
const clip = (text, max) => {
  const points = [...String(text).toWellFormed()];
  return points.length > max ? `${points.slice(0, max - 1).join('')}…` : points.join('');
};
const filled = (value) => typeof value === 'string' && !!value.trim();

/**
 * Check the record a security pass wrote and return what the server keeps of it: the
 * coverage. Throws, with why, on anything that does not establish that the pass looked:
 * a record for another head, one that says it is blocked, a category left out or
 * assessed with no reason, a finding under a category recorded as not applicable.
 *
 * Only the assessment is the agent's word. How many findings each category has is
 * counted here from the findings listed, and the record's own text is clipped: it is
 * shown to clients, and was written by an agent that read the pull request.
 * @param {any} record the parsed JSON file @param {string} head the reviewed head
 * @returns {{
 *   categories: Array<{ id: string, applicable: boolean, assessment: string, findings: number }>,
 *   findings: number, widened: string | null,
 * }}
 */
export function securityCoverage(record, head) {
  if (!record || typeof record !== 'object' || Array.isArray(record))
    throw new Error('The security record is not a JSON object');
  if (!filled(head) || record.head !== head)
    throw new Error('The security record is missing its head or names a different one');
  if (record.status === 'blocked' || filled(record.blocker))
    throw new Error(
      `The security pass reported itself blocked: ${filled(record.blocker) ? clip(record.blocker.trim(), 500) : 'no details given'}`,
    );
  if (record.status !== 'complete') throw new Error('The security record does not say the pass is complete');
  if (!Array.isArray(record.categories) || !Array.isArray(record.findings))
    throw new Error('The security record needs its categories and its findings, each as a list');
  if (record.findings.length > RECORD_FINDINGS_MAX)
    throw new Error(`The security record lists more than ${RECORD_FINDINGS_MAX} findings`);
  const counted = new Map(CATEGORY_IDS.map((id) => [id, 0]));
  for (const finding of record.findings) {
    if (!finding || !CATEGORY_IDS.includes(finding.category))
      throw new Error(`A finding of the security record names no category of ${CATEGORY_IDS.join(', ')}`);
    if (!SEVERITIES.includes(finding.severity) || !filled(finding.title))
      throw new Error('A finding of the security record lacks its severity or its title');
    counted.set(finding.category, counted.get(finding.category) + 1);
  }
  const categories = CATEGORY_IDS.map((id) => {
    const entries = record.categories.filter((c) => c?.id === id);
    if (entries.length !== 1)
      throw new Error(
        `The security record ${entries.length ? 'assesses' : 'does not assess'} the ${id} category${entries.length ? ' more than once' : ''}`,
      );
    const [entry] = entries;
    if (typeof entry.applicable !== 'boolean')
      throw new Error(`The security record does not say whether the ${id} category applies`);
    if (!filled(entry.assessment) || entry.assessment.trim().length < ASSESSMENT_MIN)
      throw new Error(
        `The security record gives no assessment of the ${id} category: ${entry.applicable ? 'what was examined' : 'why it does not apply'} has to be said`,
      );
    if (!entry.applicable && counted.get(id))
      throw new Error(`The security record lists a finding under ${id}, which it records as not applicable`);
    return {
      id,
      applicable: entry.applicable,
      assessment: clip(entry.assessment.trim(), ASSESSMENT_MAX),
      findings: counted.get(id),
    };
  });
  return {
    categories,
    findings: record.findings.length,
    widened: filled(record.widened) ? clip(record.widened.trim(), ASSESSMENT_MAX) : null,
  };
}

// The coverage a stage row kept, when it is one: every category, each assessed. Read
// back with the same distrust as the file, since the result must not rest on a row
// somebody wrote by hand.
function keptCoverage(stage) {
  const coverage = stage?.detail?.coverage;
  if (!coverage || !Array.isArray(coverage.categories) || !Number.isInteger(coverage.findings)) return null;
  const complete = CATEGORY_IDS.every((id) =>
    coverage.categories.some(
      (c) => c?.id === id && typeof c.applicable === 'boolean' && filled(c.assessment),
    ),
  );
  return complete ? coverage : null;
}

/**
 * Whether the server saw a review's security pass complete on `head`, coverage and all:
 * what has to stand behind a finding before it can be marked as a security one.
 * @param {any[]} stages the review's stage rows @param {string | null | undefined} head
 */
export function securityPassCompleted(stages, head) {
  const stage = stages.find((s) => s.stage === SECURITY_STAGE);
  return !!head && stage?.headSha === head && stage.status === 'completed' && !!keptCoverage(stage);
}

// The outcome's word for a required fix, in this result's own.
const EFFECTS = { changes_required: 'failed' };

/**
 * The security result of a pull request's review.
 *
 * - `not_required`: the project asks for no security pass and the review ran none.
 * - `not_run`: the project asks for one (`advisory` or `required`) and the review that
 *   governs the pull request ran without it: it ran before the policy was switched on,
 *   or before security passes existed. Never read as passed.
 * - `pending`: nothing to judge yet. No review covers the pull request, one is running,
 *   or the pull request moved on from what was reviewed (`stale`).
 * - `incomplete`: the pass ran and a result cannot be drawn from it. Its step failed or
 *   was interrupted, it left no coverage record for the reviewed head, its findings were
 *   not all published and registered, or a security finding has no verified verdict (the
 *   evidence rule of the outcome: findingEvidence in lib/review-outcome.js).
 * - `failed`: the pass is complete and a security finding stands as a required fix, from
 *   this review or still owed from an earlier round.
 * - `passed`: the pass completed on the reviewed head with its coverage record, that is
 *   still the pull request's head against the same base branch, and every security
 *   finding is a properly verified Optional or Dismissed, or a suppressed duplicate of one.
 *
 * `incomplete` outranks `failed`, as in the outcome. A pass a review did run is judged
 * on its evidence whatever the policy is now, so switching the policy off does not
 * unsay what the pass found; only `blocking` follows the policy.
 *
 * @param {{
 *   policy?: string,
 *   review?: { id?: number, status?: string, headSha?: string | null, baseRef?: string | null } | null,
 *   stages?: any[], findings?: any[],
 *   standing?: { fix: any[], unverified: any[], settled?: Iterable<string> },
 *   current?: { headSha?: string | null, baseRef?: string | null } | null,
 *   provisional?: boolean, own?: boolean,
 * }} input
 * The inputs are the outcome's (computeReviewOutcome), and the security findings and
 * claims are picked out of them here by their mark. `provisional` is the reading taken
 * before the label step. `own` reads one stored review by itself: its own pass and
 * findings, without what other rounds left on the pull request and without staleness.
 */
export function computeSecurityResult({
  policy = 'off',
  review = null,
  stages = [],
  findings = [],
  standing = { fix: [], unverified: [] },
  current = null,
  provisional = false,
  own = false,
}) {
  const asked = SECURITY_POLICIES.includes(policy) ? policy : 'off';
  const reviewedSha = review?.headSha || null;
  const stage = stages.find((s) => s.stage === SECURITY_STAGE) || null;
  const coverage = stage?.headSha === reviewedSha ? keptCoverage(stage) : null;
  const counts = { findings: 0, fix: 0, optional: 0, dismissed: 0, suppressed: 0, unverified: 0 };
  /** @param {string} result @param {any[]} reasons @param {boolean} [stale] */
  const answer = (result, reasons, stale = false) => ({
    policy: asked,
    result,
    // Only a project that requires the pass is held back by it.
    blocking: asked === 'required' && result !== 'passed',
    stale,
    reasons,
    reviewId: review?.id ?? null,
    headSha: reviewedSha,
    stage: stage?.status ?? null,
    coverage,
    counts,
  });
  // Nothing was asked for and nothing ran: there is no pass to speak of.
  if (asked === 'off' && !stage) return answer('not_required', []);
  if (!reviewedSha)
    return answer('pending', [
      {
        code: 'no_review',
        effect: 'pending',
        message: 'No code review of this pull request has checked out a revision yet.',
      },
    ]);
  const moved = !own && !!current?.headSha && current.headSha !== reviewedSha;
  const retargeted = !own && !!current?.baseRef && !!review.baseRef && current.baseRef !== review.baseRef;
  if (moved || retargeted)
    return answer(
      'pending',
      [
        moved
          ? {
              code: 'head_moved',
              effect: 'pending',
              message: `The pull request head is ${short(current.headSha)}; the security pass covered ${short(reviewedSha)}.`,
            }
          : {
              code: 'base_changed',
              effect: 'pending',
              message: `The pull request now targets ${current.baseRef}; the security pass was against ${review.baseRef}.`,
            },
      ],
      true,
    );
  if (!stage)
    return answer('not_run', [
      {
        code: 'security_not_run',
        effect: 'incomplete',
        message: `The review of ${short(reviewedSha)} ran without a security pass: the project did not ask for one when it started, or it predates security reviews. Run the review again.`,
      },
    ]);
  if (review.status === 'running' && !provisional)
    return answer('pending', [
      {
        code: 'review_running',
        effect: 'pending',
        message: `A code review of ${short(reviewedSha)} is running.`,
      },
    ]);

  /** @type {any[]} */
  const reasons = [];
  const lacks = (code, message, more = {}) =>
    reasons.push({ code, effect: 'incomplete', stage: SECURITY_STAGE, message, ...more });
  if (stage.status === 'pending' || stage.headSha !== reviewedSha)
    lacks('stage_not_run', `The security pass did not run for ${short(reviewedSha)}.`);
  else if (stage.status === 'failed')
    lacks(
      'stage_failed',
      `The security pass failed${stage.detail?.error ? `: ${stage.detail.error}` : '.'}`,
      {
        error: stage.detail?.error ?? null,
      },
    );
  else if (stage.status !== 'completed')
    lacks('stage_interrupted', 'The security pass was interrupted before it finished.');
  else if (!coverage)
    lacks(
      'coverage_missing',
      `The security pass left no coverage record for ${short(reviewedSha)}, so it does not show what it looked at.`,
    );

  const marked = findings.filter((f) => f.security);
  counts.findings = marked.length;
  const evidence = evidenceReasons({
    findings: marked,
    standing: {
      fix: standing.fix.filter((entry) => entry.security),
      unverified: standing.unverified.filter((entry) => entry.security),
      settled: standing.settled,
    },
    earlier: !own,
  });
  Object.assign(counts, evidence.counts);
  // What the pass recorded has to have reached the pull request: published by a publish
  // step the server saw complete, and registered as the security findings they are. A
  // record of three findings and a review that registered one is a pass whose findings
  // nobody can see or verify.
  if (coverage?.findings) {
    const publish = stages.find((s) => s.stage === 'publish' && s.headSha === reviewedSha);
    if (publish?.status !== 'completed')
      lacks(
        'findings_unpublished',
        `The security pass recorded ${coverage.findings} finding(s), and the review’s publish step did not complete.`,
        { recorded: coverage.findings },
      );
    else if (marked.length < coverage.findings)
      lacks(
        'findings_missing',
        `The security pass recorded ${coverage.findings} finding(s), and the review registered ${marked.length} as security findings.`,
        { recorded: coverage.findings, registered: marked.length },
      );
  }
  reasons.push(...evidence.reasons.map((r) => ({ ...r, effect: EFFECTS[r.effect] || r.effect })));
  const has = (effect) => reasons.some((r) => r.effect === effect);
  return answer(has('incomplete') ? 'incomplete' : has('failed') ? 'failed' : 'passed', reasons);
}

const RESULT_WORDS = {
  not_run: 'did not run',
  pending: 'is pending',
  incomplete: 'is incomplete',
  failed: 'failed',
};

/**
 * What a security result asks of the review outcome, as one of its `requirements`
 * (computeReviewOutcome): nothing unless the project requires the pass and it has not
 * passed. A pass that failed asks for changes, one that is pending waits, and everything
 * else leaves the review incomplete.
 * @param {ReturnType<typeof computeSecurityResult>} security
 * @returns {{ id: string, outcome: string, message: string } | null}
 */
export function securityRequirement(security) {
  if (!security.blocking) return null;
  const outcome = security.result === 'failed' ? 'changes_required' : security.result;
  const [first, ...rest] = security.reasons;
  const why = first ? `: ${first.message}${rest.length ? ` (+${rest.length} more)` : ''}` : '.';
  return {
    id: SECURITY_STAGE,
    outcome: ['changes_required', 'pending'].includes(outcome) ? outcome : 'incomplete',
    message: `The required security review ${RESULT_WORDS[security.result] || 'has not passed'}${why}`,
  };
}
