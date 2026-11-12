import { describe, expect, it } from 'vitest';
import {
  LINE_TOLERANCE,
  answerHash,
  answerSnapshot,
  caseStanding,
  compareRuns,
  matchFindings,
  normalizeCase,
  normalizePath,
  reviewerView,
  scoreResult,
  summarizeRun,
} from '../lib/review-benchmark.js';

const sha = (c) => c.repeat(40);
const defect = (over = {}) => ({
  id: 'd1',
  filePath: 'lib/auth.js',
  startLine: 40,
  endLine: 44,
  severity: 'high',
  summary: 'The token comparison is not constant-time',
  ...over,
});
const input = (over = {}) => ({
  key: 'auth-compare',
  title: 'Check API tokens in the middleware',
  description: 'Moves the token check into the middleware.',
  baseSha: sha('a'),
  headSha: sha('b'),
  kind: 'defective',
  defects: [defect()],
  referenceFix: 'Use crypto.timingSafeEqual on equal-length buffers.',
  origin: 'constructed',
  ...over,
});
const stored = (over = {}) => {
  const c = normalizeCase(input(over));
  return { ...c, id: 1, answerHash: answerHash(c), authoredBy: 7, retiredAt: null };
};
const finding = (over = {}) => ({
  id: 1,
  severity: 'high',
  title: 'Timing attack on token compare',
  filePath: 'lib/auth.js',
  startLine: 42,
  endLine: 42,
  shouldFix: 'fix',
  verification: 'confirmed',
  reconciliation: 'new',
  ...over,
});
const review = (findings, over = {}) => ({
  status: 'completed',
  outcome: { outcome: findings.some((f) => f.shouldFix === 'fix') ? 'changes_required' : 'passed' },
  findings,
  costUsd: 1.5,
  costEstimated: false,
  unpricedTurns: 0,
  provider: 'Claude',
  model: 'opus',
  effort: 'high',
  startedAt: 1000,
  endedAt: 61000,
  ...over,
});

describe('normalizeCase', () => {
  it('keeps a valid case and fills a defect’s end line from its start', () => {
    const c = normalizeCase(input({ defects: [defect({ endLine: undefined })] }));
    expect(c.defects[0]).toEqual({ ...defect(), endLine: 40 });
    expect(c.key).toBe('auth-compare');
  });

  it.each([
    [{ kind: 'defective', defects: [] }, 'A defective case lists its defects'],
    [{ kind: 'clean' }, 'A clean case lists no defects'],
    [{ origin: 'incident' }, 'production incidents are not taken'],
    [{ headSha: sha('a') }, 'headSha must differ'],
    [{ baseSha: 'abc' }, 'baseSha must be a full commit id'],
    [{ key: '../x' }, 'key must be'],
    [{ title: '' }, 'title is required'],
    [{ extra: 1 }, 'Unknown case fields: extra'],
    [{ defects: [defect(), defect({ id: 'D1' })] }, 'used twice'],
    [{ defects: [defect({ filePath: '../etc/passwd' })] }, 'path inside the repository'],
    [{ defects: [defect({ startLine: 10, endLine: 5 })] }, 'before its startLine'],
    [{ defects: [defect({ severity: 'huge' })] }, 'severity must be'],
    [{ defects: [defect({ why: 'x' })] }, 'Unknown fields in defects[0]: why'],
  ])('refuses %o', (over, message) => {
    expect(() => normalizeCase(input(over))).toThrow(message);
  });

  it('refuses a title or description that gives the answer away', () => {
    expect(() =>
      normalizeCase(input({ description: 'Note: the token comparison is not constant-time.' })),
    ).toThrow('quotes the summary of defect d1');
    expect(() =>
      normalizeCase(input({ description: 'Use crypto.timingSafeEqual on equal-length buffers.' })),
    ).toThrow('quotes the reference fix');
  });

  it('keeps the stored key on an update and refuses another', () => {
    expect(normalizeCase({ ...input(), key: undefined }, { key: 'auth-compare' }).key).toBe('auth-compare');
    expect(() => normalizeCase(input({ key: 'other' }), { key: 'auth-compare' })).toThrow('cannot change');
  });

  it('normalizes paths and refuses ones outside the repository', () => {
    expect(normalizePath('./lib//a.js')).toBe('lib/a.js');
    expect(normalizePath('lib\\a.js')).toBe('lib/a.js');
    expect(normalizePath('/etc/a')).toBeNull();
    expect(normalizePath('a/../../b')).toBeNull();
  });
});

describe('answerHash and caseStanding', () => {
  it('changes with the answer and not with the provenance or the defect order', () => {
    const a = normalizeCase(input({ defects: [defect(), defect({ id: 'd2', startLine: 90, endLine: 91 })] }));
    const b = { ...a, defects: [...a.defects].reverse(), provenance: 'moved' };
    expect(answerHash(a)).toBe(answerHash(b));
    expect(answerHash(a)).not.toBe(answerHash({ ...a, kind: 'clean', defects: [] }));
    expect(answerHash(a)).not.toBe(answerHash({ ...a, headSha: sha('c') }));
  });

  it('counts only an agreement from somebody other than the author, on the answer as it stands', () => {
    const c = stored();
    const at = (userId, verdict, hash = c.answerHash) => ({ userId, verdict, answerHash: hash });
    expect(caseStanding(c, []).status).toBe('draft');
    expect(caseStanding(c, [at(7, 'agree')])).toMatchObject({ status: 'draft', runnable: false });
    expect(caseStanding(c, [at(8, 'agree')])).toMatchObject({
      status: 'adjudicated',
      runnable: true,
      agreedBy: [8],
    });
    expect(caseStanding(c, [at(8, 'agree', 'old')])).toMatchObject({ status: 'draft', outdated: 1 });
    expect(caseStanding(c, [at(8, 'agree'), at(9, 'disagree')])).toMatchObject({
      status: 'disputed',
      runnable: false,
    });
    // The author's own doubt still holds the case back.
    expect(caseStanding(c, [at(8, 'agree'), at(7, 'disagree')]).status).toBe('disputed');
    expect(caseStanding({ ...c, retiredAt: 5 }, [at(8, 'agree')]).runnable).toBe(false);
  });
});

describe('what the reviewer is shown', () => {
  it('is the change, its title and its description, and none of the answer', () => {
    const c = stored();
    const view = reviewerView(answerSnapshot(c).change);
    expect(view).toEqual({
      title: c.title,
      body: c.description,
      baseSha: c.baseSha,
      headSha: c.headSha,
    });
    const shown = JSON.stringify(view);
    expect(shown).not.toContain(c.defects[0].summary);
    expect(shown).not.toContain('timingSafeEqual');
    expect(shown).not.toContain('defective');
  });
});

describe('matchFindings', () => {
  const defects = [defect(), defect({ id: 'd2', filePath: 'lib/b.js', startLine: null, endLine: null })];

  it('matches by file and lines within the tolerance, and only then', () => {
    const near = finding({ startLine: 44 + LINE_TOLERANCE, endLine: 44 + LINE_TOLERANCE });
    const far = finding({ id: 2, startLine: 45 + LINE_TOLERANCE, endLine: 50 });
    const other = finding({ id: 3, filePath: 'lib/other.js' });
    const noLine = finding({ id: 4, startLine: null, endLine: null });
    const wholeFile = finding({ id: 5, filePath: './lib/b.js', startLine: 300 });
    const m = matchFindings([near, far, other, noLine, wholeFile], defects);
    expect(m.map((x) => [x.defectId, x.basis])).toEqual([
      ['d1', 'location'],
      [null, null],
      [null, null],
      [null, null],
      ['d2', 'location'],
    ]);
  });

  it('takes a person’s judgment over the location', () => {
    const judgments = [
      { findingId: 1, assessment: 'false_positive' },
      { findingId: 2, assessment: 'matches', defectId: 'd1' },
      { findingId: 3, assessment: 'matches', defectId: 'nope' },
    ];
    const m = matchFindings(
      [finding(), finding({ id: 2, filePath: 'x.js' }), finding({ id: 3 })],
      defects,
      judgments,
    );
    expect(m.map((x) => [x.defectId, x.basis])).toEqual([
      [null, 'judgment'],
      ['d1', 'judgment'],
      [null, 'judgment'],
    ]);
  });
});

describe('scoreResult', () => {
  const answer = answerSnapshot(stored());
  const clean = answerSnapshot(stored({ kind: 'clean', defects: [], referenceFix: null }));

  it('scores a caught defect and keeps a location match provisional', () => {
    const s = scoreResult({ answer, review: review([finding()]) });
    expect(s).toMatchObject({ scored: true, outcome: 'changes_required', outcomeCorrect: true });
    expect(s.defects).toEqual([
      { id: 'd1', severity: 'high', status: 'caught', findingIds: [1], provisional: true },
    ]);
    expect(s.counts).toMatchObject({ caught: 1, missed: 0, falsePositives: 0, provisional: 1 });
    const judged = scoreResult({
      answer,
      review: review([finding()]),
      judgments: [{ findingId: 1, assessment: 'matches', defectId: 'd1' }],
    });
    expect(judged.counts.provisional).toBe(0);
  });

  it('counts an empty report on a defective change as every defect missed', () => {
    const s = scoreResult({ answer, review: review([]) });
    expect(s).toMatchObject({ scored: true, outcome: 'passed', outcomeCorrect: false });
    expect(s.counts).toMatchObject({ caught: 0, missed: 1, findings: 0 });
  });

  it('scores a clean change passed with no findings as correct', () => {
    const s = scoreResult({ answer: clean, review: review([]) });
    expect(s).toMatchObject({ scored: true, outcomeCorrect: true, expectedOutcome: 'passed' });
  });

  it.each([
    [null, 'no_review'],
    [{ status: 'running' }, 'review_running'],
    [{ status: 'failed', findings: [] }, 'review_failed'],
    [{ status: 'completed', outcome: null, findings: [] }, 'outcome_unknown'],
    [{ status: 'completed', outcome: { outcome: 'incomplete' }, findings: [] }, 'outcome_incomplete'],
    [{ status: 'completed', outcome: { outcome: 'pending' }, findings: [] }, 'outcome_pending'],
  ])('gives no result, never a pass, for %o', (r, reason) => {
    const s = scoreResult({ answer: clean, review: r });
    expect(s).toMatchObject({ scored: false, noResult: reason, outcomeCorrect: null, counts: null });
  });

  it('tells verdicts apart: nonblocking, wrongly dismissed, duplicate, false positive, refuted', () => {
    const two = answerSnapshot(
      stored({ defects: [defect(), defect({ id: 'd2', startLine: 100, endLine: 100 })] }),
    );
    const s = scoreResult({
      answer: two,
      review: review([
        finding({ id: 1, shouldFix: 'optional' }),
        finding({ id: 2, shouldFix: 'fix', startLine: 41 }),
        finding({ id: 3, startLine: 100, shouldFix: 'dismiss' }),
        finding({ id: 4, filePath: 'lib/x.js', shouldFix: 'fix' }),
        finding({ id: 5, filePath: 'lib/x.js', shouldFix: 'optional' }),
        finding({ id: 6, filePath: 'lib/y.js', shouldFix: 'dismiss' }),
      ]),
    });
    expect(s.findings.map((f) => [f.id, f.class])).toEqual([
      [1, 'duplicate'],
      [2, 'caught'],
      [3, 'wrongly_dismissed'],
      [4, 'false_positive'],
      [5, 'unlisted_optional'],
      [6, 'refuted'],
    ]);
    expect(s.defects.map((d) => [d.id, d.status])).toEqual([
      ['d1', 'caught'],
      ['d2', 'dismissed'],
    ]);
    expect(s.counts).toMatchObject({
      duplicates: 1,
      falsePositives: 1,
      unlistedOptional: 1,
      refuted: 1,
      dismissed: 1,
    });
  });

  it('lets a finding a person matched to a defect stand for it over a stronger location guess', () => {
    const s = scoreResult({
      answer,
      review: review([
        finding({ id: 1, shouldFix: 'dismiss' }),
        finding({ id: 2, shouldFix: 'fix', startLine: 42 }),
      ]),
      judgments: [{ findingId: 1, assessment: 'matches', defectId: 'd1' }],
    });
    expect(s.findings.map((f) => [f.id, f.class, f.basis])).toEqual([
      [1, 'wrongly_dismissed', 'judgment'],
      [2, 'duplicate', 'location'],
    ]);
    expect(s.defects.map((d) => [d.id, d.status])).toEqual([['d1', 'dismissed']]);
  });

  it('takes judgments of findings outside the answer, and harmful fixes from them alone', () => {
    const s = scoreResult({
      answer: clean,
      review: review([
        finding({ id: 1, filePath: 'a.js', shouldFix: 'optional' }),
        finding({ id: 2, filePath: 'b.js', shouldFix: 'optional' }),
        finding({ id: 3, filePath: 'c.js', shouldFix: 'fix' }),
      ]),
      judgments: [
        { findingId: 1, assessment: 'false_positive', harmfulFix: true },
        { findingId: 2, assessment: 'valid_unlisted' },
      ],
    });
    expect(s.findings.map((f) => f.class)).toEqual([
      'false_positive_nonblocking',
      'valid_unlisted',
      'false_positive',
    ]);
    expect(s.counts).toMatchObject({
      harmfulFixes: 1,
      validUnlisted: 1,
      falsePositives: 1,
      provisional: 1,
      judged: 2,
    });
    expect(s.outcomeCorrect).toBe(false);
  });
});

describe('summarizeRun and compareRuns', () => {
  const defective = answerSnapshot(stored());
  const clean = answerSnapshot(stored({ kind: 'clean', defects: [], referenceFix: null }));
  const result = (caseKey, answer, r, state = 'done') => ({
    caseKey,
    state,
    answer,
    review: r,
    score: r || state === 'failed' ? scoreResult({ answer, review: r }) : null,
  });

  it('rates over the cases with a result, says what is left out, and never counts findings as quality', () => {
    const s = summarizeRun([
      result('a', defective, review([finding()])),
      result('b', defective, review([])),
      result('c', clean, review([finding({ filePath: 'z.js' })])),
      result('d', clean, { status: 'completed', outcome: { outcome: 'incomplete' }, findings: [] }),
      result('e', clean, null, 'reviewing'),
      result('f', clean, null, 'cancelled'),
    ]);
    expect(s.cases).toMatchObject({
      total: 6,
      scored: 3,
      pending: 1,
      cancelled: 1,
      noResult: { outcome_incomplete: 1 },
    });
    expect(s.defects).toMatchObject({ total: 2, caught: 1, missed: 1, recall: 0.5 });
    expect(s.findings).toMatchObject({ falsePositives: 1, blockingPrecision: 0.5 });
    expect(s.outcomes).toMatchObject({
      correct: 1,
      cleanPassed: 0,
      cleanTotal: 1,
      defectiveBlocked: 1,
      defectiveTotal: 2,
    });
    expect(s.cost).toMatchObject({ usd: 4.5, estimated: false, reviewsWithoutCost: 1 });
    expect(s.caveats.join('\n')).toContain('3 of 6 cases have no result');
    expect(s.caveats.join('\n')).toContain('not a measure of quality');
  });

  it('flags estimated and unpriced cost and mixed runtimes', () => {
    const s = summarizeRun([
      result('a', clean, review([], { costEstimated: true, unpricedTurns: 2 })),
      result('b', clean, review([], { model: 'sonnet' })),
    ]);
    expect(s.cost).toMatchObject({ estimated: true, unpricedTurns: 2 });
    expect(s.runtimes).toHaveLength(2);
    const text = s.caveats.join('\n');
    expect(text).toContain('estimates');
    expect(text).toContain('2 turns had no price');
    expect(text).toContain('2 different runtimes');
  });

  it('compares the cases both runs scored against the same answer', () => {
    const changed = { ...clean, hash: 'other' };
    const a = {
      run: { id: 1, label: 'before', runtime: { model: 'a' }, configuration: {} },
      results: [
        result('x', defective, review([])),
        result('y', clean, review([])),
        result('z', clean, review([])),
      ],
    };
    const b = {
      run: { id: 2, label: 'after', runtime: { model: 'b' }, configuration: {} },
      results: [
        result('x', defective, review([finding()])),
        result('y', changed, review([])),
        result('w', clean, review([])),
      ],
    };
    const c = compareRuns(a, b);
    expect(c).toMatchObject({ common: 1, onlyA: ['z'], onlyB: ['w'], changedAnswers: ['y'] });
    expect(c.delta).toMatchObject({ recall: 1, outcomesCorrect: 1 });
    expect(c.cases).toEqual([
      expect.objectContaining({
        caseKey: 'x',
        gained: ['d1'],
        lost: [],
        outcomeCorrect: { a: false, b: true },
      }),
    ]);
    expect(c.caveats.join('\n')).toContain('changed their answer');
  });

  it('calls two runs alike only when their reviews ran on the same runtime too', () => {
    const run = (id, results) => ({
      run: { id, label: null, runtime: { model: 'a' }, configuration: {} },
      results,
    });
    const alike = compareRuns(
      run(1, [result('x', clean, review([]))]),
      run(2, [result('x', clean, review([]))]),
    );
    expect(alike.caveats.join('\n')).toContain('same runtime and review configuration');
    const mixed = compareRuns(
      run(1, [result('x', clean, review([]))]),
      run(2, [result('x', clean, review([], { model: 'sonnet' }))]),
    );
    expect(mixed.caveats.join('\n')).not.toContain('same runtime and review configuration');
  });
});
