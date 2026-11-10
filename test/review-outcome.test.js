import { describe, expect, it } from 'vitest';
import {
  OUTCOMES,
  REVIEW_STAGES,
  STATUS_CONTEXT,
  STATUS_DESCRIPTION_MAX,
  computeReviewOutcome,
  findingEvidence,
  requiredReviewStages,
  statusFor,
} from '../lib/review-outcome.js';

const head = 'a'.repeat(40);
const next = 'b'.repeat(40);

const review = (over = {}) => ({ id: 5, status: 'completed', headSha: head, baseRef: 'main', ...over });
// Every stage a review on Claude needs, seen to complete on the reviewed head.
const stages = (over = {}, names = REVIEW_STAGES) =>
  names.map((stage) => ({ stage, headSha: head, status: 'completed', detail: null, ...(over[stage] || {}) }));
const finding = (over = {}) => ({
  id: 1,
  findingRef: 'ref-1',
  title: 'Lost update',
  filePath: 'lib/cart.js',
  reconciliation: 'new',
  commentId: 501,
  threadId: 'PRRT_1',
  shouldFix: null,
  verification: null,
  comments: null,
  ...over,
});
const verified = (shouldFix, over = {}) =>
  finding({ shouldFix, verification: 'confirmed', comments: 'Traced through lib/cart.js:44', ...over });
const compute = (over = {}) =>
  computeReviewOutcome({ review: review(), stages: stages(), findings: [], ...over });
const codes = (result) => result.reasons.map((r) => r.code);

describe('what a verdict needs before it lets a finding through', () => {
  it.each([
    // verdict, verification, comments, state, code
    ['fix', 'confirmed', 'proof', 'fix', undefined],
    ['fix', 'plausible', 'likely', 'fix', undefined],
    // A fix needs no evidence to block: only clearing a finding does.
    ['fix', null, null, 'fix', undefined],
    ['optional', 'confirmed', 'style only', 'cleared', undefined],
    ['optional', 'plausible', 'cleanup, not blocking', 'cleared', undefined],
    ['optional', null, 'style only', 'open', 'finding_unverified'],
    ['optional', 'confirmed', null, 'open', 'finding_unverified'],
    ['optional', 'confirmed', '   ', 'open', 'finding_unverified'],
    ['dismiss', 'confirmed', 'guarded by the caller, lib/api.js:12', 'cleared', undefined],
    // A refutation nobody proved is not a dismissal.
    ['dismiss', 'plausible', 'probably guarded', 'open', 'dismissal_unproven'],
    ['dismiss', null, 'guarded', 'open', 'finding_unverified'],
    ['dismiss', 'confirmed', null, 'open', 'finding_unverified'],
    [null, null, null, 'open', 'finding_without_verdict'],
    [null, 'confirmed', 'could not tell', 'open', 'finding_without_verdict'],
  ])('%s / %s / %j is %s', (shouldFix, verification, comments, state, code) => {
    const evidence = findingEvidence(finding({ shouldFix, verification, comments }));
    expect(evidence.state).toBe(state);
    expect(evidence.code).toBe(code);
  });

  it('names what is missing', () => {
    expect(findingEvidence(finding({ shouldFix: 'optional' })).missing).toEqual(['verification', 'comments']);
    expect(
      findingEvidence(finding({ shouldFix: 'dismiss', verification: 'plausible', comments: 'x' })),
    ).toEqual({ state: 'open', code: 'dismissal_unproven', missing: ['verification'] });
  });

  it('takes a suppressed duplicate’s verdict from the earlier decision, unless a person requires a fix', () => {
    const carried = { reconciliation: 'suppressed', verification: null, comments: 'Not repeated' };
    expect(findingEvidence(finding({ ...carried, shouldFix: 'dismiss' })).state).toBe('cleared');
    expect(findingEvidence(finding({ ...carried, shouldFix: 'optional' })).state).toBe('cleared');
    expect(findingEvidence(finding({ ...carried, shouldFix: 'fix' })).state).toBe('fix');
    expect(findingEvidence(finding({ ...carried, shouldFix: null })).code).toBe('finding_without_verdict');
  });
});

describe('computeReviewOutcome', () => {
  it('answers one of the four outcomes', () => {
    expect(OUTCOMES).toEqual(['pending', 'incomplete', 'changes_required', 'passed']);
  });

  describe('pending', () => {
    it('when nothing was reviewed yet', () => {
      for (const none of [null, review({ headSha: null })]) {
        const result = computeReviewOutcome({ review: none });
        expect(result).toMatchObject({ outcome: 'pending', stale: false, reviewed: null });
        expect(codes(result)).toEqual(['no_review']);
      }
    });

    it('while a review is running, whatever it recorded so far', () => {
      const result = compute({
        review: review({ status: 'running' }),
        findings: [verified('fix')],
        standing: { fix: [{ findingRef: 'ref-old', title: 'Old' }], unverified: [] },
        rounds: { limitReached: true, used: 3, limit: 3 },
      });
      expect(result.outcome).toBe('pending');
      expect(codes(result)).toEqual(['review_running']);
    });

    it('when the head moved since the review: stale, never passed', () => {
      const result = compute({ current: { headSha: next, baseRef: 'main' } });
      expect(result).toMatchObject({ outcome: 'pending', stale: true, headSha: next });
      expect(result.reviewed).toEqual({ headSha: head, baseRef: 'main' });
      expect(result.reasons).toEqual([
        expect.objectContaining({ code: 'head_moved', reviewedHeadSha: head, headSha: next }),
      ]);
    });

    it('when the pull request targets another base branch', () => {
      const result = compute({ current: { headSha: head, baseRef: 'release' } });
      expect(result).toMatchObject({ outcome: 'pending', stale: true, baseRef: 'release' });
      expect(result.reasons[0]).toMatchObject({
        code: 'base_changed',
        reviewedBaseRef: 'main',
        baseRef: 'release',
      });
    });

    it('not for the same head and base, nor when the current revision is unknown', () => {
      expect(compute({ current: { headSha: head, baseRef: 'main' } }).outcome).toBe('passed');
      expect(compute({ current: null }).outcome).toBe('passed');
      // A base that was never recorded cannot have changed.
      expect(
        compute({ review: review({ baseRef: null }), current: { headSha: head, baseRef: 'main' } }).outcome,
      ).toBe('passed');
      // Branch names are case-sensitive.
      expect(compute({ current: { headSha: head, baseRef: 'Main' } }).stale).toBe(true);
    });
  });

  describe('incomplete', () => {
    it('for a review with no stage records at all, such as one stored before they existed', () => {
      const result = compute({ stages: [], findings: [verified('optional')] });
      expect(result.outcome).toBe('incomplete');
      expect(codes(result)).toEqual(['stages_not_recorded']);
    });

    it.each(REVIEW_STAGES)('when the %s stage never ran', (stage) => {
      const result = compute({ stages: stages({ [stage]: { status: 'pending' } }) });
      expect(result.outcome).toBe('incomplete');
      expect(result.reasons).toEqual([expect.objectContaining({ code: 'stage_not_run', stage })]);
    });

    it.each(REVIEW_STAGES)('when the %s stage was interrupted', (stage) => {
      // Still marked running, and the review is not: nobody finished it.
      const result = compute({
        review: review({ status: 'failed' }),
        stages: stages({ [stage]: { status: 'running' } }),
      });
      expect(result.outcome).toBe('incomplete');
      expect(result.reasons).toEqual([expect.objectContaining({ code: 'stage_interrupted', stage })]);
    });

    it.each(REVIEW_STAGES)('when the %s stage failed, with why', (stage) => {
      const result = compute({
        review: review({ status: 'failed' }),
        stages: stages({ [stage]: { status: 'failed', detail: { error: 'exited with code 1' } } }),
      });
      expect(result.outcome).toBe('incomplete');
      expect(result.reasons).toEqual([
        expect.objectContaining({ code: 'stage_failed', stage, error: 'exited with code 1' }),
      ]);
      expect(result.reasons[0].message).toContain('exited with code 1');
    });

    it('when a stage is missing from the records, or was recorded for another head', () => {
      const missing = compute({ stages: stages().filter((s) => s.stage !== 'verify') });
      expect(missing.reasons).toEqual([expect.objectContaining({ code: 'stage_not_run', stage: 'verify' })]);
      const other = compute({ stages: stages({ publish: { headSha: next } }) });
      expect(other.outcome).toBe('incomplete');
      expect(other.reasons).toEqual([expect.objectContaining({ code: 'stage_not_run', stage: 'publish' })]);
    });

    it('requires every stage the review recorded, such as the Codex delegation receipt', () => {
      const names = requiredReviewStages({ delegation: true });
      expect(names).toEqual(['discover', 'publish', 'delegation', 'verify', 'label']);
      expect(requiredReviewStages()).toEqual(REVIEW_STAGES);
      expect(compute({ stages: stages({}, names) }).outcome).toBe('passed');
      const blocked = compute({
        stages: stages({ delegation: { status: 'failed', detail: { error: 'receipt is missing' } } }, names),
      });
      expect(blocked.outcome).toBe('incomplete');
      expect(blocked.reasons[0]).toMatchObject({ code: 'stage_failed', stage: 'delegation' });
      // A review that ran on Claude has no such row and needs none.
      expect(compute({ stages: stages() }).outcome).toBe('passed');
    });

    it('when a finding has no verdict or its verdict lacks evidence', () => {
      const result = compute({
        findings: [
          finding({ id: 1, findingRef: 'r1' }),
          finding({ id: 2, findingRef: 'r2', shouldFix: 'optional' }),
          finding({
            id: 3,
            findingRef: 'r3',
            shouldFix: 'dismiss',
            verification: 'plausible',
            comments: 'x',
          }),
          verified('optional', { id: 4, findingRef: 'r4' }),
        ],
      });
      expect(result.outcome).toBe('incomplete');
      expect(result.reasons.map((r) => [r.findingId, r.code])).toEqual([
        [1, 'finding_without_verdict'],
        [2, 'finding_unverified'],
        [3, 'dismissal_unproven'],
      ]);
      expect(result.reasons[1]).toMatchObject({
        effect: 'incomplete',
        missing: ['verification', 'comments'],
        findingRef: 'r2',
        threadId: 'PRRT_1',
        title: 'Lost update',
        filePath: 'lib/cart.js',
      });
      expect(result.counts).toMatchObject({ unverified: 3, optional: 1 });
    });

    it('when a finding names a comment the server never found on the pull request', () => {
      const result = compute({ findings: [verified('dismiss', { threadId: null })] });
      expect(result.outcome).toBe('incomplete');
      expect(result.reasons).toEqual([expect.objectContaining({ code: 'finding_unlinked', commentId: 501 })]);
      // A finding with no inline comment, or one that was not posted again, has no thread to find.
      expect(compute({ findings: [verified('dismiss', { threadId: null, commentId: null })] }).outcome).toBe(
        'passed',
      );
      expect(
        compute({
          findings: [finding({ reconciliation: 'suppressed', shouldFix: 'dismiss', threadId: null })],
        }).outcome,
      ).toBe('passed');
    });

    it('when an earlier round left a published finding without a verified verdict', () => {
      const result = compute({
        standing: { fix: [], unverified: [{ findingRef: 'ref-old', threadId: 'PRRT_old', title: 'Old' }] },
      });
      expect(result.outcome).toBe('incomplete');
      expect(result.reasons).toEqual([
        expect.objectContaining({ code: 'earlier_finding_unverified', findingRef: 'ref-old' }),
      ]);
    });

    it('outranks changes required, and lists both', () => {
      const result = compute({
        stages: stages({ label: { status: 'failed', detail: { error: 'stopped' } } }),
        findings: [verified('fix')],
      });
      expect(result.outcome).toBe('incomplete');
      expect(codes(result)).toEqual(['stage_failed', 'fix_required']);
    });

    it('for a revision nobody reviewed once the round limit is reached', () => {
      const limit = { limitReached: true, used: 3, limit: 3 };
      const moved = compute({ current: { headSha: next }, rounds: limit });
      expect(moved).toMatchObject({ outcome: 'incomplete', stale: true, headSha: next });
      expect(codes(moved)).toEqual(['head_moved', 'round_limit_reached']);
      expect(moved.reasons[1]).toMatchObject({ effect: 'incomplete', used: 3, limit: 3 });
      const never = computeReviewOutcome({ review: null, rounds: limit });
      expect(never.outcome).toBe('incomplete');
      expect(codes(never)).toEqual(['no_review', 'round_limit_reached']);
      // With rounds to spare the same revision simply waits for its review.
      expect(compute({ current: { headSha: next }, rounds: { limitReached: false } }).outcome).toBe(
        'pending',
      );
    });
  });

  describe('changes required', () => {
    it.each(['confirmed', 'plausible', null])('for a Fix with verification %s', (verification) => {
      const result = compute({ findings: [finding({ shouldFix: 'fix', verification })] });
      expect(result.outcome).toBe('changes_required');
      expect(result.reasons).toEqual([
        expect.objectContaining({ code: 'fix_required', effect: 'changes_required', findingId: 1 }),
      ]);
    });

    it('for an adopted thread whose verdict is Fix, and a suppressed duplicate a person overruled', () => {
      expect(
        compute({ findings: [verified('fix', { reconciliation: 'adopted', priorThreadId: 'PRRT_1' })] })
          .outcome,
      ).toBe('changes_required');
      expect(
        compute({ findings: [finding({ reconciliation: 'suppressed', shouldFix: 'fix', threadId: null })] })
          .outcome,
      ).toBe('changes_required');
    });

    it('for a fix still owed from an earlier review that this one did not raise', () => {
      const result = compute({
        findings: [verified('optional')],
        standing: {
          fix: [{ findingRef: 'ref-owed', threadId: 'PRRT_owed', title: 'Leaks' }],
          unverified: [],
        },
      });
      expect(result.outcome).toBe('changes_required');
      expect(result.reasons).toEqual([
        expect.objectContaining({ code: 'fix_owed', findingRef: 'ref-owed', threadId: 'PRRT_owed' }),
      ]);
      expect(result.counts.fix).toBe(1);
    });

    it('lists a claim once when the review’s finding and the standing decision agree', () => {
      const result = compute({
        findings: [verified('fix', { findingRef: 'ref-1' })],
        standing: { fix: [{ findingRef: 'ref-1', title: 'Lost update' }], unverified: [] },
      });
      expect(codes(result)).toEqual(['fix_required']);
      expect(result.counts.fix).toBe(1);
    });

    it('when a later decision requires a fix on a claim this review let through', () => {
      const result = compute({
        findings: [verified('optional', { findingRef: 'ref-1' })],
        standing: { fix: [{ findingRef: 'ref-1', title: 'Lost update' }], unverified: [] },
      });
      expect(result.outcome).toBe('changes_required');
      expect(codes(result)).toEqual(['fix_owed']);
    });

    it('stays changes required on the reviewed head at the round limit, which is only noted', () => {
      const result = compute({
        findings: [verified('fix')],
        rounds: { limitReached: true, used: 3, limit: 3 },
      });
      expect(result.outcome).toBe('changes_required');
      expect(result.reasons.map((r) => [r.code, r.effect])).toEqual([
        ['fix_required', 'changes_required'],
        ['round_limit_reached', 'note'],
      ]);
    });
  });

  describe('passed', () => {
    it('with no findings and every stage complete', () => {
      const result = compute();
      expect(result).toMatchObject({ outcome: 'passed', reasons: [], stale: false, reviewId: 5 });
      expect(result).toMatchObject({ headSha: head, baseRef: 'main' });
    });

    it('with only verified Optional and Dismissed findings and suppressed duplicates', () => {
      const result = compute({
        findings: [
          verified('optional', { id: 1 }),
          verified('optional', { id: 2, verification: 'plausible' }),
          verified('dismiss', { id: 3 }),
          finding({ id: 4, reconciliation: 'suppressed', shouldFix: 'dismiss', threadId: null }),
          finding({ id: 5, reconciliation: 'suppressed', shouldFix: 'optional', threadId: null }),
        ],
      });
      expect(result.outcome).toBe('passed');
      expect(result.reasons).toEqual([]);
      // Confirmed Optional findings stay apart from refuted ones.
      expect(result.counts).toEqual({ fix: 0, optional: 2, dismissed: 1, suppressed: 2, unverified: 0 });
    });

    it('at the round limit too, when the reviewed head is clean', () => {
      const result = compute({
        findings: [verified('optional')],
        rounds: { limitReached: true, used: 3, limit: 3 },
      });
      expect(result).toMatchObject({ outcome: 'passed', reasons: [] });
    });

    it('whatever the execution status says once every stage was seen to complete', () => {
      expect(compute({ review: review({ status: 'failed' }) }).outcome).toBe('passed');
    });

    it('never from a completed execution alone', () => {
      expect(compute({ review: review({ status: 'completed' }), stages: [] }).outcome).toBe('incomplete');
    });
  });

  describe('before the label step', () => {
    const before = stages({ label: { status: 'running' } });

    it('reads the review as if it had ended, without that step', () => {
      const running = review({ status: 'running' });
      expect(compute({ review: running, stages: before, provisional: true }).outcome).toBe('passed');
      expect(compute({ review: running, stages: before }).outcome).toBe('pending');
      expect(
        compute({ review: running, stages: before, findings: [verified('fix')], provisional: true }).outcome,
      ).toBe('changes_required');
    });

    it('still needs every earlier stage, and the head not to have moved', () => {
      const running = review({ status: 'running' });
      const unverified = compute({
        review: running,
        stages: stages({ verify: { status: 'pending' }, label: { status: 'running' } }),
        provisional: true,
      });
      expect(unverified.outcome).toBe('incomplete');
      expect(codes(unverified)).toEqual(['stage_not_run']);
      expect(
        compute({ review: running, stages: before, current: { headSha: next }, provisional: true }),
      ).toMatchObject({ outcome: 'pending', stale: true });
    });
  });

  describe('what the label step was found to have done', () => {
    const notes = [
      { code: 'approved_label_ignored', message: 'The pull request carries `code-approved`…' },
      { code: 'approval_dismissed', message: 'Briareus dismissed that approval.', reviewId: 900 },
    ];
    const labelled = stages({ label: { detail: { outcome: 'changes_required', notes } } });

    it('is listed as notes on an outcome that does not pass', () => {
      const result = compute({ stages: labelled, findings: [verified('fix')] });
      expect(result.outcome).toBe('changes_required');
      expect(result.reasons.map((r) => [r.code, r.effect])).toEqual([
        ['fix_required', 'changes_required'],
        ['approved_label_ignored', 'note'],
        ['approval_dismissed', 'note'],
      ]);
    });

    it('says nothing once the outcome passes: a label on a passed review is not a mismatch', () => {
      expect(compute({ stages: labelled, findings: [verified('optional')] })).toMatchObject({
        outcome: 'passed',
        reasons: [],
      });
    });
  });

  describe('further requirements', () => {
    it('lets a caller add conditions that block with their own outcome', () => {
      const met = { id: 'security', outcome: 'passed' };
      expect(compute({ requirements: [met] }).outcome).toBe('passed');
      const failed = compute({
        requirements: [met, { id: 'security', outcome: 'changes_required', message: 'A secret is logged.' }],
      });
      expect(failed.outcome).toBe('changes_required');
      expect(failed.reasons).toEqual([
        {
          code: 'requirement_unmet',
          effect: 'changes_required',
          requirement: 'security',
          message: 'A secret is logged.',
        },
      ]);
      const waiting = compute({ requirements: [{ id: 'human-approval', outcome: 'pending' }] });
      expect(waiting.outcome).toBe('pending');
      expect(waiting.reasons[0].message).toBe('The human-approval requirement is not met.');
      expect(compute({ requirements: [{ id: 'security', outcome: 'incomplete' }] }).outcome).toBe(
        'incomplete',
      );
    });
  });
});

describe('statusFor', () => {
  const status = (over) => statusFor(compute(over));

  it('names the context a repository requires', () => {
    expect(STATUS_CONTEXT).toBe('briareus/code-review');
  });

  it('maps each outcome to a commit status state', () => {
    expect(status({ findings: [verified('optional'), verified('dismiss', { id: 2 })] })).toEqual({
      state: 'success',
      description: 'Review passed at aaaaaaa: 1 optional, 1 dismissed, nothing to fix',
    });
    expect(status()).toEqual({ state: 'success', description: 'Review passed at aaaaaaa: no findings' });
    expect(status({ findings: [verified('fix'), verified('fix', { id: 2, findingRef: 'r2' })] })).toEqual({
      state: 'failure',
      description: '2 required fixes at aaaaaaa',
    });
    expect(status({ review: review({ status: 'running' }) })).toEqual({
      state: 'pending',
      description: 'Review of aaaaaaa in progress',
    });
    expect(status({ current: { headSha: next } })).toEqual({
      state: 'pending',
      description: 'Waiting for a review of bbbbbbb',
    });
    // Incomplete is an error, not a failure: the review did not reach a verdict.
    expect(status({ stages: stages({ verify: { status: 'pending' } }), findings: [finding()] })).toEqual({
      state: 'error',
      description: 'Review incomplete: The verify step did not run for aaaaaaa (+1 more)',
    });
    expect(status({ current: { headSha: next }, rounds: { limitReached: true, used: 3, limit: 3 } })).toEqual(
      {
        state: 'error',
        description: 'Not reviewed at bbbbbbb; the review limit is reached and a person must continue',
      },
    );
  });

  it('keeps the description within what GitHub accepts', () => {
    const long = status({ findings: [finding({ title: 'x'.repeat(400) })] });
    expect(long.state).toBe('error');
    expect(long.description).toHaveLength(STATUS_DESCRIPTION_MAX);
    expect(long.description.endsWith('…')).toBe(true);
  });
});
