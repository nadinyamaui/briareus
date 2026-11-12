// @ts-check
// How well the code review does its job, measured on curated changes whose answers
// people settled beforehand: the benchmark's cases, what makes one fit to be run, and how
// a run's reviews are scored against them. Pure: the cases and runs are stored by
// lib/review-benchmark-store.js and driven through the real review by
// lib/review-benchmark-runner.js.
//
// A case is a change in a project set aside for this (`reviewBenchmark`): two commits of
// its repository, the base and the head, with the answer: whether the change is
// defective or clean, the defects it carries, and a reference fix. The reviewer sees the
// change and the case's title and description, as the pull request a run opens, and
// nothing else: the answer lives in Briareus's database only, never in the repository,
// the pull request or a session's workspace (reviewerView is the one way out).
//
// Cases come from changes built for the benchmark or taken from past work, never from
// production incidents, and a case counts only once somebody other than its author agreed
// with its answer: independently adjudicated. Any edit of the change or the answer makes
// the earlier adjudications about something else, so they stop counting.
//
// The score is held against that answer, never against how many findings a review
// produced: an empty report on a defective change is every defect missed, a review that
// did not finish is no result at all (never a pass), and a flood of findings scores only
// what in it is real. Where the server can only guess (a finding matched to a defect by
// its location, an unexplained finding), the score says so, and a person's judgment of
// the finding settles it.
import { createHash } from 'node:crypto';

export const CASE_KINDS = ['defective', 'clean'];
// Built for the benchmark, or taken from a past change. There is no third kind: cases
// derived from production incidents are out of scope.
export const CASE_ORIGINS = ['constructed', 'historical'];
export const DEFECT_SEVERITIES = ['critical', 'high', 'medium', 'low'];
export const ADJUDICATION_VERDICTS = ['agree', 'disagree'];
// What a person says a finding is: the defect it names (`matches`, with `defectId`), a
// claim that is wrong (`false_positive`), or a real problem the answer does not list
// (`valid_unlisted`, which says the answer may be incomplete and counts against nothing).
export const JUDGMENT_ASSESSMENTS = ['matches', 'false_positive', 'valid_unlisted'];
export const RESULT_STATES = ['queued', 'opening', 'reviewing', 'done', 'failed', 'cancelled'];
export const RUN_STATUSES = ['running', 'completed', 'cancelled'];
// How many lines a finding may sit beside a defect's range and still be matched to it by
// location: reviewers anchor a comment on the call, the condition or the line before.
export const LINE_TOLERANCE = 3;
export const LIMITS = {
  key: 64,
  title: 200,
  description: 20000,
  defects: 50,
  defectSummary: 2000,
  filePath: 1000,
  referenceFix: 200000,
  provenance: 2000,
  note: 2000,
  label: 200,
  casesPerRun: 100,
  concurrency: 5,
};

const SHA_RE = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const KEY_RE = /^[a-z0-9][a-z0-9._-]*$/i;
const DEFECT_ID_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/i;

const invalid = (message) => Object.assign(new Error(message), { status: 400 });

function text(value, name, max, { required = false } = {}) {
  if (value == null || value === '') {
    if (required) throw invalid(`${name} is required`);
    return null;
  }
  if (typeof value !== 'string') throw invalid(`${name} must be text`);
  const trimmed = value.trim();
  if (!trimmed && required) throw invalid(`${name} is required`);
  if (trimmed.length > max) throw invalid(`${name} is longer than ${max} characters`);
  return trimmed || null;
}

function positive(value, name) {
  if (value == null) return null;
  if (!Number.isSafeInteger(value) || value < 1) throw invalid(`${name} must be a positive whole number`);
  return value;
}

// A repository path as a reviewer writes it: relative, with forward slashes. `./a` and
// `a` are the same file; anything that climbs out of the repository is not a path in it.
export function normalizePath(value) {
  if (typeof value !== 'string') return null;
  let path = value.trim().replace(/\\/g, '/');
  while (path.startsWith('./')) path = path.slice(2);
  path = path.replace(/\/{2,}/g, '/');
  if (!path || path.startsWith('/') || path.split('/').includes('..')) return null;
  return path;
}

function defectOf(input, index) {
  const at = `defects[${index}]`;
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalid(`${at} must be an object`);
  const unknown = Object.keys(input).filter(
    (k) => !['id', 'filePath', 'startLine', 'endLine', 'severity', 'summary'].includes(k),
  );
  if (unknown.length) throw invalid(`Unknown fields in ${at}: ${unknown.join(', ')}`);
  const id = typeof input.id === 'string' ? input.id.trim() : '';
  if (!DEFECT_ID_RE.test(id)) throw invalid(`${at}.id must be 1–40 letters, digits, - or _`);
  const filePath = normalizePath(input.filePath);
  if (!filePath) throw invalid(`${at}.filePath must be a path inside the repository`);
  if (filePath.length > LIMITS.filePath) throw invalid(`${at}.filePath is too long`);
  const startLine = positive(input.startLine, `${at}.startLine`);
  const endLine = positive(input.endLine, `${at}.endLine`);
  if (endLine != null && startLine == null) throw invalid(`${at}.endLine needs a startLine`);
  if (endLine != null && startLine != null && endLine < startLine)
    throw invalid(`${at}.endLine is before its startLine`);
  if (!DEFECT_SEVERITIES.includes(input.severity))
    throw invalid(`${at}.severity must be one of ${DEFECT_SEVERITIES.join(', ')}`);
  const summary = text(input.summary, `${at}.summary`, LIMITS.defectSummary, { required: true });
  return { id, filePath, startLine, endLine: endLine ?? startLine, severity: input.severity, summary };
}

const CASE_FIELDS = [
  'key',
  'title',
  'description',
  'baseSha',
  'headSha',
  'kind',
  'defects',
  'referenceFix',
  'origin',
  'provenance',
];

// A case as written by a client, checked in full: a write replaces the whole case, and a
// field it does not know is refused rather than guessed at. `key` names the case within
// its project and never changes, so an update takes the stored one.
export function normalizeCase(input, { key = null } = {}) {
  const body = input && typeof input === 'object' && !Array.isArray(input) ? input : null;
  if (!body) throw invalid('A case must be an object');
  const unknown = Object.keys(body).filter((k) => !CASE_FIELDS.includes(k) && k !== 'repo');
  if (unknown.length) throw invalid(`Unknown case fields: ${unknown.join(', ')}`);
  let caseKey = key;
  if (key == null) {
    caseKey = typeof body.key === 'string' ? body.key.trim() : '';
    if (!caseKey || caseKey.length > LIMITS.key || !KEY_RE.test(caseKey))
      throw invalid(
        `key must be 1–${LIMITS.key} letters, digits, ., - or _, starting with a letter or digit`,
      );
  } else if (body.key != null && body.key !== key) throw invalid('A case’s key cannot change');
  const title = text(body.title, 'title', LIMITS.title, { required: true });
  const description = text(body.description, 'description', LIMITS.description);
  for (const name of ['baseSha', 'headSha'])
    if (typeof body[name] !== 'string' || !SHA_RE.test(body[name]))
      throw invalid(`${name} must be a full commit id`);
  if (body.baseSha === body.headSha) throw invalid('headSha must differ from baseSha');
  if (!CASE_KINDS.includes(body.kind)) throw invalid(`kind must be one of ${CASE_KINDS.join(', ')}`);
  if (body.defects != null && !Array.isArray(body.defects)) throw invalid('defects must be a list');
  const raw = body.defects || [];
  if (raw.length > LIMITS.defects) throw invalid(`A case lists at most ${LIMITS.defects} defects`);
  const defects = raw.map(defectOf);
  const ids = new Set();
  for (const d of defects) {
    if (ids.has(d.id.toLowerCase())) throw invalid(`Defect id ${d.id} is used twice`);
    ids.add(d.id.toLowerCase());
  }
  if (body.kind === 'defective' && !defects.length) throw invalid('A defective case lists its defects');
  if (body.kind === 'clean' && defects.length) throw invalid('A clean case lists no defects');
  if (!CASE_ORIGINS.includes(body.origin))
    throw invalid(
      `origin must be one of ${CASE_ORIGINS.join(', ')}; cases derived from production incidents are not taken`,
    );
  const referenceFix = text(body.referenceFix, 'referenceFix', LIMITS.referenceFix);
  const provenance = text(body.provenance, 'provenance', LIMITS.provenance);
  const out = {
    key: caseKey,
    title,
    description,
    baseSha: body.baseSha,
    headSha: body.headSha,
    kind: body.kind,
    defects,
    referenceFix,
    origin: body.origin,
    provenance,
  };
  const leak = answerLeak(out);
  if (leak) throw invalid(leak);
  return out;
}

// What the reviewer is shown must not give the answer away. Only the plain cases are
// caught: a defect's summary or the reference fix quoted in the title or description.
// The rest is the curator's to keep out, with the commit messages and branch names of
// the repository (docs/features.md says how).
function answerLeak(c) {
  const shown = `${c.title}\n${c.description || ''}`.toLowerCase();
  for (const d of c.defects)
    if (d.summary.length >= 12 && shown.includes(d.summary.toLowerCase()))
      return `The title or description quotes the summary of defect ${d.id}: the reviewer would read the answer`;
  const fix = (c.referenceFix || '').trim().toLowerCase();
  if (fix.length >= 12 && shown.includes(fix))
    return 'The title or description quotes the reference fix: the reviewer would read the answer';
  return null;
}

// What an adjudication is about: the change and the answer, as one fingerprint. The
// provenance note is not part of it; editing that changes nobody's verdict.
export function answerHash(c) {
  const canonical = {
    title: c.title,
    description: c.description || null,
    baseSha: c.baseSha,
    headSha: c.headSha,
    kind: c.kind,
    defects: [...c.defects]
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map((d) => [d.id, d.filePath, d.startLine, d.endLine, d.severity, d.summary]),
    referenceFix: c.referenceFix || null,
  };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

// Whether a case may be run, and why. Only adjudications of the answer as it stands
// count; the author's own agreement is on record but adjudicates nothing.
export function caseStanding(c, adjudications = []) {
  const current = adjudications.filter((a) => a.answerHash === c.answerHash);
  const independent = current.filter((a) => c.authoredBy == null || a.userId !== c.authoredBy);
  const agreed = independent.filter((a) => a.verdict === 'agree');
  const disputed = current.filter((a) => a.verdict === 'disagree');
  const status = c.retiredAt
    ? 'retired'
    : disputed.length
      ? 'disputed'
      : agreed.length
        ? 'adjudicated'
        : 'draft';
  return {
    status,
    runnable: status === 'adjudicated',
    agreedBy: agreed.map((a) => a.userId),
    disputedBy: disputed.map((a) => a.userId),
    outdated: adjudications.length - current.length,
  };
}

// The pull request a run opens for a case: the change, its title and its description,
// and nothing of the answer. The only path from a case to anything the reviewer reads.
export function reviewerView(c) {
  return {
    title: c.title,
    body: c.description || '',
    baseSha: c.baseSha,
    headSha: c.headSha,
  };
}

// The answer a run is scored against, kept with each result when the run starts: a case
// edited afterwards does not rescore a run already made, and a comparison tells runs of
// the same answer from runs of different ones by `hash`.
// The change goes with it, for the runner to open: the reviewer-visible part of the case.
export function answerSnapshot(c) {
  return {
    hash: c.answerHash,
    kind: c.kind,
    defects: c.defects.map((d) => ({ ...d })),
    change: { title: c.title, description: c.description || null, baseSha: c.baseSha, headSha: c.headSha },
  };
}

// A finding whose end comes before its start is read as its start line alone.
const range = (start, end) => (start == null ? null : [start, Math.max(start, end ?? start)]);

// How far a finding sits from a defect, in lines: 0 when they overlap, Infinity when
// the location cannot match it at all, null-line rules aside.
function distance(finding, defect) {
  if (normalizePath(finding.filePath) !== defect.filePath) return Infinity;
  const d = range(defect.startLine, defect.endLine);
  if (!d) return 0;
  const f = range(finding.startLine, finding.endLine);
  if (!f) return Infinity;
  if (f[0] <= d[1] && f[1] >= d[0]) return 0;
  const gap = f[1] < d[0] ? d[0] - f[1] : f[0] - d[1];
  return gap <= LINE_TOLERANCE ? gap : Infinity;
}

// Which defect each finding is about: a person's judgment where there is one, else the
// nearest defect in the same file within LINE_TOLERANCE lines. A location match says
// where, not what, so it is `basis: 'location'` until somebody confirms it.
export function matchFindings(findings, defects, judgments = []) {
  const judged = new Map(judgments.map((j) => [j.findingId, j]));
  const known = new Set(defects.map((d) => d.id));
  return findings.map((finding) => {
    const judgment = judged.get(finding.id) || null;
    if (judgment) {
      const defectId =
        judgment.assessment === 'matches' && known.has(judgment.defectId) ? judgment.defectId : null;
      return { finding, judgment, defectId, basis: 'judgment' };
    }
    let best = null;
    let bestDistance = Infinity;
    for (const defect of defects) {
      const gap = distance(finding, defect);
      if (gap < bestDistance) {
        best = defect;
        bestDistance = gap;
      }
    }
    return { finding, judgment: null, defectId: best ? best.id : null, basis: best ? 'location' : null };
  });
}

const VERDICT_RANK = { fix: 3, optional: 2, dismiss: 1 };
const rankOf = (finding) => VERDICT_RANK[finding.shouldFix] || 0;

// Why a review produced nothing to score. A review that did not finish what it owed is
// not a clean bill of health, whatever it found or did not find.
export function noResultReason(review) {
  if (!review) return 'no_review';
  if (review.status === 'running') return 'review_running';
  if (review.status !== 'completed') return 'review_failed';
  const outcome = review.outcome?.outcome;
  if (!outcome) return 'outcome_unknown';
  if (outcome === 'pending' || outcome === 'incomplete') return `outcome_${outcome}`;
  return null;
}

/**
 * One case's result held against its answer.
 * @param {{ answer: any, review: any, judgments?: any[] }} input
 * `review` is the snapshot the runner kept when the review ended (status, outcome,
 * findings with their verdicts); `judgments` what people said about its findings.
 */
export function scoreResult({ answer, review, judgments = [] }) {
  const expectedOutcome = answer.kind === 'defective' ? 'changes_required' : 'passed';
  const reason = noResultReason(review);
  const base = {
    expectedOutcome,
    outcome: review?.outcome?.outcome ?? null,
    noResult: reason,
    scored: !reason,
  };
  if (reason) return { ...base, outcomeCorrect: null, defects: [], findings: [], counts: null };

  const findings = review.findings || [];
  const matches = matchFindings(findings, answer.defects, judgments);
  // The finding that stands for a defect is the one with the strongest verdict; any
  // other finding about the same defect repeats it.
  const primary = new Map();
  for (const m of matches) {
    if (!m.defectId) continue;
    const held = primary.get(m.defectId);
    if (!held || rankOf(m.finding) > rankOf(held.finding)) primary.set(m.defectId, m);
  }
  const scoredFindings = matches.map((m) => {
    const f = m.finding;
    const assessment = m.judgment?.assessment ?? null;
    let cls;
    if (m.defectId) {
      if (primary.get(m.defectId) !== m) cls = 'duplicate';
      else
        cls =
          { fix: 'caught', optional: 'caught_nonblocking', dismiss: 'wrongly_dismissed' }[f.shouldFix] ||
          'unverified';
    } else if (assessment === 'valid_unlisted') cls = 'valid_unlisted';
    else if (f.shouldFix === 'fix') cls = 'false_positive';
    else if (f.shouldFix === 'optional')
      cls = assessment === 'false_positive' ? 'false_positive_nonblocking' : 'unlisted_optional';
    else if (f.shouldFix === 'dismiss') cls = 'refuted';
    else cls = 'unverified';
    // What the server only guessed: a location match nobody confirmed, and a claim that
    // reached the author without a person saying whether it is real.
    const provisional =
      !m.judgment && (m.basis === 'location' || ['false_positive', 'unlisted_optional'].includes(cls));
    return {
      id: f.id,
      title: f.title,
      severity: f.severity,
      filePath: f.filePath ?? null,
      startLine: f.startLine ?? null,
      endLine: f.endLine ?? null,
      shouldFix: f.shouldFix ?? null,
      verification: f.verification ?? null,
      reconciliation: f.reconciliation || 'new',
      defectId: m.defectId,
      basis: m.basis,
      class: cls,
      provisional,
      judged: !!m.judgment,
      harmfulFix: !!m.judgment?.harmfulFix,
    };
  });
  const byDefect = (id) => scoredFindings.filter((f) => f.defectId === id);
  const defects = answer.defects.map((d) => {
    const about = byDefect(d.id);
    const lead = about.find((f) => f.class !== 'duplicate');
    const status = !lead
      ? 'missed'
      : lead.class === 'caught'
        ? 'caught'
        : lead.class === 'caught_nonblocking'
          ? 'caught_nonblocking'
          : lead.class === 'wrongly_dismissed'
            ? 'dismissed'
            : 'unverified';
    return {
      id: d.id,
      severity: d.severity,
      status,
      findingIds: about.map((f) => f.id),
      provisional: !!lead && lead.provisional,
    };
  });
  const count = (cls) => scoredFindings.filter((f) => f.class === cls).length;
  const counts = {
    findings: scoredFindings.length,
    defects: defects.length,
    caught: defects.filter((d) => d.status === 'caught').length,
    caughtNonblocking: defects.filter((d) => d.status === 'caught_nonblocking').length,
    dismissed: defects.filter((d) => d.status === 'dismissed').length,
    missed: defects.filter((d) => d.status === 'missed' || d.status === 'unverified').length,
    falsePositives: count('false_positive'),
    falsePositivesNonblocking: count('false_positive_nonblocking'),
    unlistedOptional: count('unlisted_optional'),
    validUnlisted: count('valid_unlisted'),
    refuted: count('refuted'),
    duplicates: count('duplicate'),
    unverified: count('unverified'),
    harmfulFixes: scoredFindings.filter((f) => f.harmfulFix).length,
    provisional: scoredFindings.filter((f) => f.provisional).length,
    judged: scoredFindings.filter((f) => f.judged).length,
  };
  return {
    ...base,
    outcomeCorrect: base.outcome === expectedOutcome,
    defects,
    findings: scoredFindings,
    counts,
  };
}

const sum = (list, pick) => list.reduce((n, x) => n + (pick(x) || 0), 0);
const rate = (n, d) => (d > 0 ? Math.round((n / d) * 10000) / 10000 : null);

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

/**
 * A run's results summed up. Each result is `{ caseKey, state, answer, review, score }`.
 * Rates are over the cases that produced a result, and `cases` says how many did not;
 * nothing here is a count of findings standing in for quality.
 */
export function summarizeRun(results) {
  const scored = results.filter((r) => r.score?.scored);
  const counts = scored.map((r) => r.score.counts);
  const defectsTotal = sum(counts, (c) => c.defects);
  const caught = sum(counts, (c) => c.caught);
  const caughtNonblocking = sum(counts, (c) => c.caughtNonblocking);
  const falsePositives = sum(counts, (c) => c.falsePositives);
  const clean = scored.filter((r) => r.answer.kind === 'clean');
  const defective = scored.filter((r) => r.answer.kind === 'defective');
  const noResult = {};
  for (const r of results)
    if (r.score && !r.score.scored) noResult[r.score.noResult] = (noResult[r.score.noResult] || 0) + 1;
  const bySeverity = {};
  for (const severity of DEFECT_SEVERITIES) {
    const of = scored.flatMap((r) => r.score.defects.filter((d) => d.severity === severity));
    if (!of.length) continue;
    const hit = of.filter((d) => d.status === 'caught').length;
    bySeverity[severity] = { defects: of.length, caught: hit, recall: rate(hit, of.length) };
  }
  const reviews = results.map((r) => r.review).filter(Boolean);
  const costs = reviews.filter((r) => r.costUsd != null);
  const durations = reviews
    .filter((r) => r.startedAt != null && r.endedAt != null && r.endedAt >= r.startedAt)
    .map((r) => r.endedAt - r.startedAt);
  const summary = {
    cases: {
      total: results.length,
      scored: scored.length,
      pending: results.filter((r) => !r.score && !['failed', 'cancelled'].includes(r.state)).length,
      failed: results.filter((r) => r.state === 'failed').length,
      cancelled: results.filter((r) => r.state === 'cancelled').length,
      noResult,
    },
    defects: {
      total: defectsTotal,
      caught,
      caughtNonblocking,
      dismissed: sum(counts, (c) => c.dismissed),
      missed: sum(counts, (c) => c.missed),
      recall: rate(caught, defectsTotal),
      recallAnyVerdict: rate(caught + caughtNonblocking, defectsTotal),
      bySeverity,
    },
    findings: {
      total: sum(counts, (c) => c.findings),
      falsePositives,
      falsePositivesNonblocking: sum(counts, (c) => c.falsePositivesNonblocking),
      unlistedOptional: sum(counts, (c) => c.unlistedOptional),
      validUnlisted: sum(counts, (c) => c.validUnlisted),
      refuted: sum(counts, (c) => c.refuted),
      duplicates: sum(counts, (c) => c.duplicates),
      unverified: sum(counts, (c) => c.unverified),
      harmfulFixes: sum(counts, (c) => c.harmfulFixes),
      judged: sum(counts, (c) => c.judged),
      provisional: sum(counts, (c) => c.provisional),
      blockingPrecision: rate(caught, caught + falsePositives),
      falsePositivesPerCase: rate(falsePositives, scored.length),
    },
    outcomes: {
      correct: scored.filter((r) => r.score.outcomeCorrect).length,
      cleanPassed: clean.filter((r) => r.score.outcome === 'passed').length,
      cleanTotal: clean.length,
      defectiveBlocked: defective.filter((r) => r.score.outcome === 'changes_required').length,
      defectiveTotal: defective.length,
    },
    cost: {
      usd: Math.round(sum(costs, (r) => r.costUsd) * 1e6) / 1e6,
      estimated: reviews.some((r) => r.costEstimated),
      unpricedTurns: sum(reviews, (r) => r.unpricedTurns),
      reviewsWithoutCost: reviews.length - costs.length,
    },
    durationMs: { median: median(durations), total: sum(durations, (d) => d) },
    // The runtimes the reviews actually ran on. A run records the project's runtime when
    // it started; a provider switched off since, or a settings change, shows here.
    runtimes: [
      ...new Set(
        reviews.map((r) => [r.provider || '?', r.model || 'default', r.effort || 'default'].join(' / ')),
      ),
    ],
    caveats: /** @type {string[]} */ ([]),
  };
  summary.caveats = runCaveats(summary);
  return summary;
}

function runCaveats(s) {
  const out = [];
  const missing = s.cases.total - s.cases.scored;
  if (missing)
    out.push(
      `${missing} of ${s.cases.total} cases have no result (still running, failed, cancelled or reviews that did not complete their required stages); every rate is over the ${s.cases.scored} that do, and a case without a result is never counted as passed`,
    );
  if (s.findings.provisional)
    out.push(
      `${s.findings.provisional} findings are classified by the server alone (matched to a defect by location, or not in the answer and not yet judged): judge them to settle the rates`,
    );
  if (s.findings.validUnlisted)
    out.push(
      `${s.findings.validUnlisted} findings were judged real problems the answer does not list: the answer key of those cases may be incomplete`,
    );
  if (s.findings.total > s.findings.judged)
    out.push(
      `Harmful suggested fixes are only known from judgments: ${s.findings.total - s.findings.judged} findings are not judged`,
    );
  if (s.runtimes.length > 1)
    out.push(`The reviews ran on ${s.runtimes.length} different runtimes (${s.runtimes.join('; ')})`);
  if (s.cost.estimated) out.push('The cost includes estimates from catalog prices, not billed amounts');
  if (s.cost.unpricedTurns) out.push(`${s.cost.unpricedTurns} turns had no price and are not in the cost`);
  if (s.cost.reviewsWithoutCost) out.push(`${s.cost.reviewsWithoutCost} reviews recorded no cost at all`);
  out.push(
    'The number of findings is not a measure of quality: recall, false positives and outcomes are held against the adjudicated answers',
  );
  return out;
}

// Two runs over the same cases, case by case. Only cases both runs scored against the
// same answer are compared; the rest are listed, not mixed in.
export function compareRuns(a, b) {
  const index = (run) => new Map(run.results.map((r) => [r.caseKey, r]));
  const ia = index(a);
  const ib = index(b);
  const common = [];
  const changedAnswers = [];
  for (const [key, ra] of ia) {
    const rb = ib.get(key);
    if (!rb) continue;
    if (ra.answer.hash !== rb.answer.hash) changedAnswers.push(key);
    else common.push(key);
  }
  const pick = (map) => common.map((key) => map.get(key));
  const sa = summarizeRun(pick(ia));
  const sb = summarizeRun(pick(ib));
  const delta = (x, y) => (x == null || y == null ? null : Math.round((y - x) * 10000) / 10000);
  const caughtIds = (r) =>
    new Set(r.score?.scored ? r.score.defects.filter((d) => d.status === 'caught').map((d) => d.id) : []);
  const cases = common.map((key) => {
    const ra = ia.get(key);
    const rb = ib.get(key);
    const ca = caughtIds(ra);
    const cb = caughtIds(rb);
    return {
      caseKey: key,
      scored: { a: !!ra.score?.scored, b: !!rb.score?.scored },
      outcomeCorrect: { a: ra.score?.outcomeCorrect ?? null, b: rb.score?.outcomeCorrect ?? null },
      gained: [...cb].filter((id) => !ca.has(id)),
      lost: [...ca].filter((id) => !cb.has(id)),
      falsePositives: {
        a: ra.score?.counts?.falsePositives ?? null,
        b: rb.score?.counts?.falsePositives ?? null,
      },
    };
  });
  return {
    a: { id: a.run.id, label: a.run.label, runtime: a.run.runtime, configuration: a.run.configuration },
    b: { id: b.run.id, label: b.run.label, runtime: b.run.runtime, configuration: b.run.configuration },
    common: common.length,
    onlyA: [...ia.keys()].filter((k) => !ib.has(k)),
    onlyB: [...ib.keys()].filter((k) => !ia.has(k)),
    changedAnswers,
    summary: { a: sa, b: sb },
    delta: {
      recall: delta(sa.defects.recall, sb.defects.recall),
      recallAnyVerdict: delta(sa.defects.recallAnyVerdict, sb.defects.recallAnyVerdict),
      blockingPrecision: delta(sa.findings.blockingPrecision, sb.findings.blockingPrecision),
      falsePositives: sb.findings.falsePositives - sa.findings.falsePositives,
      harmfulFixes: sb.findings.harmfulFixes - sa.findings.harmfulFixes,
      duplicates: sb.findings.duplicates - sa.findings.duplicates,
      outcomesCorrect: sb.outcomes.correct - sa.outcomes.correct,
      scored: sb.cases.scored - sa.cases.scored,
      costUsd: Math.round((sb.cost.usd - sa.cost.usd) * 1e6) / 1e6,
    },
    cases,
    caveats: [
      ...(changedAnswers.length
        ? [`${changedAnswers.length} cases changed their answer between the runs and are left out`]
        : []),
      ...(sa.cases.scored !== common.length || sb.cases.scored !== common.length
        ? [
            'Some common cases have no result in one of the runs; each run’s rates are over its own scored cases',
          ]
        : []),
      ...(JSON.stringify(a.run.runtime) === JSON.stringify(b.run.runtime) &&
      JSON.stringify(a.run.configuration) === JSON.stringify(b.run.configuration)
        ? ['Both runs used the same runtime and review configuration: a difference is variation between runs']
        : []),
    ],
  };
}
