// @ts-check
// How a project's code reviews have gone, from what the server already keeps of them:
// what their claims were ruled and by whom, how many rounds pull requests took, how often
// a claim came back, what the reviews cost, and how long they waited on people. Read
// for GET /review-quality; nothing here is a judgment of whether a review was right,
// which only the benchmark (lib/review-benchmark.js) can say, against answers people
// settled beforehand. Production incidents are not read or counted.

export const QUALITY_DAYS = { default: 30, max: 365 };
// Bounds every list read for one answer: a project with more in its window is summed
// from the newest rows, and the answer says it was cut.
export const QUALITY_ROW_LIMIT = 20000;

const DAY = 86_400_000;
const PEOPLE = ['api', 'github'];

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const at = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[at];
}

// How long something took or has been waiting, in milliseconds.
export function durations(values) {
  const sorted = values.filter((v) => Number.isFinite(v) && v >= 0).sort((a, b) => a - b);
  return {
    count: sorted.length,
    medianMs: percentile(sorted, 50),
    p90Ms: percentile(sorted, 90),
    maxMs: sorted.length ? sorted[sorted.length - 1] : null,
  };
}

const tally = (rows, key) => {
  /** @type {Record<string, number>} */
  const out = {};
  for (const row of rows) {
    const k = String(key(row) ?? 'none');
    out[k] = (out[k] || 0) + 1;
  }
  return out;
};
const money = (n) => Math.round(n * 1e6) / 1e6;
const person = (decision) => PEOPLE.includes(decision.source) && !/^session:/.test(decision.decidedBy || '');

/**
 * The summary, from rows already read for the window (readReviewQualityRows).
 * @param {{
 *   reviews: any[], rounds: any[], counts: any[], decisions: any[], findings: any[],
 *   approvals: any[], readiness: any[], truncated?: string[], since: number, until: number, now?: number,
 * }} input
 */
export function summarizeReviewQuality({
  reviews,
  rounds,
  counts,
  decisions,
  findings,
  approvals,
  readiness,
  truncated = [],
  since,
  until,
  now = Date.now(),
}) {
  const pulls = new Set(reviews.filter((r) => r.prNumber != null).map((r) => r.prNumber));
  const priced = reviews.filter((r) => r.costUsd != null);
  /** @type {Record<string, any>} */
  const byRuntime = {};
  for (const r of reviews) {
    const key = [r.provider || '?', r.model || 'default', r.effort || 'default'].join(' / ');
    const entry = (byRuntime[key] ||= {
      provider: r.provider || null,
      model: r.model || null,
      effort: r.effort || null,
      reviews: 0,
      completed: 0,
      costUsd: 0,
      estimated: false,
      unpricedTurns: 0,
      withoutCost: 0,
    });
    entry.reviews++;
    if (r.status === 'completed') entry.completed++;
    if (r.costUsd != null) entry.costUsd = money(entry.costUsd + r.costUsd);
    else entry.withoutCost++;
    if (r.costEstimated) entry.estimated = true;
    entry.unpricedTurns += r.unpricedTurns || 0;
  }

  // Rounds per pull request, as far as the window shows them: the highest round number
  // reviewed in it.
  const highest = new Map();
  for (const r of rounds) highest.set(r.prNumber, Math.max(highest.get(r.prNumber) || 0, r.round));
  const roundsPerPull = tally([...highest.values()], (n) => (n >= 4 ? '4+' : n));
  const reviewedAt = new Map(
    rounds.filter((r) => r.reviewedAt != null).map((r) => [`${r.prNumber}#${r.round}`, r.reviewedAt]),
  );
  const continued = rounds.filter((r) => r.continuedAt != null);

  const ruled = decisions.filter((d) => d.verdict);
  const byPeople = ruled.filter(person);
  // A person's verdict on a claim, from when the claim was stored to when they ruled.
  const verdictWaits = byPeople
    .filter((d) => d.decidedAt != null && d.createdAt != null)
    .map((d) => d.decidedAt - d.createdAt);
  // The first approval of a reviewed revision, from when its review ended.
  const firstApproval = new Map();
  for (const a of approvals) {
    if (a.approvedAt == null || a.automation) continue;
    const key = `${a.prNumber}@${a.headSha}`;
    if (!firstApproval.has(key) || a.approvedAt < firstApproval.get(key).approvedAt)
      firstApproval.set(key, a);
  }
  const roundOfHead = new Map(
    rounds.filter((r) => r.reviewedAt != null).map((r) => [`${r.prNumber}@${r.headSha}`, r.reviewedAt]),
  );
  const approvalWaits = [...firstApproval.entries()]
    .map(([key, a]) => (roundOfHead.has(key) ? a.approvedAt - roundOfHead.get(key) : null))
    .filter((v) => v != null);
  // A round a person let past the limit, from the end of the round before it.
  const continueWaits = continued
    .map((r) => {
      const before = reviewedAt.get(`${r.prNumber}#${r.round - 1}`);
      return before == null ? null : r.continuedAt - before;
    })
    .filter((v) => v != null);
  const waitingLimit = counts.filter((c) => c.refusedAt != null);
  const waitingApproval = readiness.filter((r) => r.waitingSince != null);

  const caveats = [];
  if (reviews.some((r) => r.costEstimated))
    caveats.push('Part of the cost is estimated from catalog prices (cost_estimated), not billed');
  const unpriced = reviews.reduce((n, r) => n + (r.unpricedTurns || 0), 0);
  if (unpriced) caveats.push(`${unpriced} review turns had no price and are left out of the cost`);
  if (reviews.length - priced.length)
    caveats.push(`${reviews.length - priced.length} reviews recorded no cost and are left out of it`);
  caveats.push(
    'Verdicts given by people are those recorded through the API or read from GitHub; a person acting through a session counts as the session',
  );
  caveats.push(
    'Waiting times are measured from what is kept: a verdict from when its claim was stored, an approval from when the review of that head ended, a continued round from when the round before it ended',
  );
  if (truncated.length)
    caveats.push(
      `More rows than ${QUALITY_ROW_LIMIT} were in the window for ${truncated.join(', ')}: the newest were summed`,
    );

  return {
    since: new Date(since).toISOString(),
    until: new Date(until).toISOString(),
    reviews: {
      total: reviews.length,
      byStatus: tally(reviews, (r) => r.status),
      pulls: pulls.size,
      byRuntime: Object.values(byRuntime),
    },
    rounds: {
      pulls: highest.size,
      perPull: roundsPerPull,
      continued: continued.length,
      waitingAtLimit: waitingLimit.length,
    },
    dispositions: {
      claims: decisions.length,
      unruled: decisions.length - ruled.length,
      byVerdict: tally(ruled, (d) => d.verdict),
      bySource: tally(ruled, (d) => (person(d) ? 'person' : 'review')),
      byPeople: tally(byPeople, (d) => d.verdict),
      verification: tally(ruled, (d) => d.verification),
    },
    repeats: {
      findings: findings.length,
      byReconciliation: tally(findings, (f) => f.reconciliation || 'new'),
    },
    cost: {
      usd: money(priced.reduce((n, r) => n + r.costUsd, 0)),
      estimated: reviews.some((r) => r.costEstimated),
      unpricedTurns: unpriced,
      reviewsWithoutCost: reviews.length - priced.length,
      perReviewUsd: priced.length ? money(priced.reduce((n, r) => n + r.costUsd, 0) / priced.length) : null,
    },
    waiting: {
      verdicts: durations(verdictWaits),
      approvals: durations(approvalWaits),
      continuations: durations(continueWaits),
      now: {
        atLimit: durations(waitingLimit.map((c) => now - c.refusedAt)),
        forApproval: durations(waitingApproval.map((r) => now - r.waitingSince)),
      },
    },
    caveats,
  };
}

// The window a query asks for, in days back from now.
export function qualityWindow(days, now = Date.now()) {
  const n = days == null || days === '' ? QUALITY_DAYS.default : Number(days);
  if (!Number.isInteger(n) || n < 1 || n > QUALITY_DAYS.max)
    throw Object.assign(new Error(`days must be a whole number from 1 to ${QUALITY_DAYS.max}`), {
      status: 400,
    });
  return { since: now - n * DAY, until: now };
}

/**
 * The rows of one project's window, newest first and bounded. `connection` hands out a
 * mysql2 connection (lib/db.js githubStoreConnection).
 * @param {() => Promise<any>} connection
 * @param {string} repo
 * @param {{ since: number, until: number }} window
 */
export async function readReviewQualityRows(connection, repo, { since, until }) {
  const c = await connection();
  const truncated = [];
  const read = async (name, sql, params, map) => {
    const [rows] = await c.query(`${sql} LIMIT ${QUALITY_ROW_LIMIT + 1}`, params);
    if (rows.length > QUALITY_ROW_LIMIT) truncated.push(name);
    return rows.slice(0, QUALITY_ROW_LIMIT).map(map);
  };
  const n = (v) => (v == null ? null : Number(v));
  try {
    const window = [repo, since, until];
    const reviews = await read(
      'reviews',
      'SELECT `pr_number`, `status`, `provider`, `model`, `effort`, `cost_usd`, `cost_estimated`, `unpriced_turns` FROM `code_reviews` WHERE `repo` = ? AND `created_at` >= ? AND `created_at` < ? ORDER BY `created_at` DESC',
      window,
      (r) => ({
        prNumber: n(r.pr_number),
        status: r.status,
        provider: r.provider || '',
        model: r.model || '',
        effort: r.effort || '',
        costUsd: n(r.cost_usd),
        costEstimated: !!r.cost_estimated,
        unpricedTurns: Number(r.unpriced_turns || 0),
      }),
    );
    const rounds = await read(
      'rounds',
      'SELECT `pr_number`, `round`, `head_sha`, `reviewed_at`, `continued_at` FROM `code_review_rounds` WHERE `repo` = ? AND `created_at` >= ? AND `created_at` < ? ORDER BY `created_at` DESC',
      window,
      (r) => ({
        prNumber: Number(r.pr_number),
        round: Number(r.round),
        headSha: r.head_sha,
        reviewedAt: n(r.reviewed_at),
        continuedAt: n(r.continued_at),
      }),
    );
    // What waits now is not bound to the window.
    const counts = await read(
      'round counts',
      'SELECT `pr_number`, `refused_at` FROM `code_review_round_counts` WHERE `repo` = ? AND `refused_at` IS NOT NULL ORDER BY `refused_at` DESC',
      [repo],
      (r) => ({ prNumber: Number(r.pr_number), refusedAt: n(r.refused_at) }),
    );
    const decisions = await read(
      'decisions',
      'SELECT `verdict`, `verification`, `source`, `decided_by`, `decided_at`, `created_at` FROM `code_review_decisions` WHERE `repo` = ? AND `created_at` >= ? AND `created_at` < ? ORDER BY `created_at` DESC',
      window,
      (r) => ({
        verdict: r.verdict || null,
        verification: r.verification || null,
        source: r.source || null,
        decidedBy: r.decided_by || null,
        decidedAt: n(r.decided_at),
        createdAt: n(r.created_at),
      }),
    );
    const findings = await read(
      'findings',
      'SELECT f.`reconciliation` FROM `code_review_findings` f JOIN `code_reviews` r ON r.`id` = f.`code_review_id` WHERE r.`repo` = ? AND f.`created_at` >= ? AND f.`created_at` < ? ORDER BY f.`created_at` DESC',
      window,
      (r) => ({ reconciliation: r.reconciliation || 'new' }),
    );
    const approvals = await read(
      'approvals',
      'SELECT `pr_number`, `head_sha`, `approved_at`, `automation` FROM `code_review_approvals` WHERE `repo` = ? AND `approved_at` >= ? AND `approved_at` < ? ORDER BY `approved_at` DESC',
      window,
      (r) => ({
        prNumber: Number(r.pr_number),
        headSha: r.head_sha,
        approvedAt: n(r.approved_at),
        automation: r.automation || null,
      }),
    );
    const readiness = await read(
      'readiness',
      'SELECT `pr_number`, `waiting_since` FROM `code_review_readiness` WHERE `repo` = ? AND `waiting_since` IS NOT NULL ORDER BY `waiting_since` DESC',
      [repo],
      (r) => ({ prNumber: Number(r.pr_number), waitingSince: n(r.waiting_since) }),
    );
    return { reviews, rounds, counts, decisions, findings, approvals, readiness, truncated };
  } finally {
    c.release();
  }
}
