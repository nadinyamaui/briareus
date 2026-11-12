import { describe, expect, it } from 'vitest';
import { durations, qualityWindow, summarizeReviewQuality } from '../lib/review-quality.js';

const H = 3_600_000;
const empty = {
  reviews: [],
  rounds: [],
  counts: [],
  decisions: [],
  findings: [],
  approvals: [],
  readiness: [],
};

describe('durations', () => {
  it('summarizes what it can measure and ignores what it cannot', () => {
    expect(durations([5, 1, 3, NaN, -1, 10])).toEqual({ count: 4, medianMs: 3, p90Ms: 10, maxMs: 10 });
    expect(durations([])).toEqual({ count: 0, medianMs: null, p90Ms: null, maxMs: null });
  });
});

describe('qualityWindow', () => {
  it('defaults to 30 days and refuses what is out of range', () => {
    expect(qualityWindow(undefined, 100 * 86_400_000)).toEqual({
      since: 70 * 86_400_000,
      until: 100 * 86_400_000,
    });
    for (const bad of ['0', '366', '1.5', 'x']) expect(() => qualityWindow(bad)).toThrow('days must be');
  });
});

describe('summarizeReviewQuality', () => {
  const now = 100 * H;
  const summary = (rows) => summarizeReviewQuality({ ...empty, ...rows, since: 0, until: now, now });

  it('sums cost per runtime with its caveats', () => {
    const s = summary({
      reviews: [
        {
          prNumber: 1,
          status: 'completed',
          provider: 'Claude',
          model: 'opus',
          effort: 'high',
          costUsd: 2,
          unpricedTurns: 0,
        },
        {
          prNumber: 1,
          status: 'failed',
          provider: 'Claude',
          model: 'opus',
          effort: 'high',
          costUsd: null,
          unpricedTurns: 0,
        },
        {
          prNumber: 2,
          status: 'completed',
          provider: 'Codex',
          model: '',
          effort: '',
          costUsd: 1,
          costEstimated: true,
          unpricedTurns: 3,
        },
      ],
    });
    expect(s.reviews).toMatchObject({ total: 3, pulls: 2, byStatus: { completed: 2, failed: 1 } });
    expect(s.reviews.byRuntime).toEqual([
      expect.objectContaining({ provider: 'Claude', reviews: 2, completed: 1, costUsd: 2, withoutCost: 1 }),
      expect.objectContaining({ provider: 'Codex', model: null, estimated: true, unpricedTurns: 3 }),
    ]);
    expect(s.cost).toEqual({
      usd: 3,
      estimated: true,
      unpricedTurns: 3,
      reviewsWithoutCost: 1,
      perReviewUsd: 1.5,
    });
    const text = s.caveats.join('\n');
    expect(text).toContain('estimated');
    expect(text).toContain('3 review turns had no price');
    expect(text).toContain('1 reviews recorded no cost');
  });

  it('tells verdicts people gave from those sessions gave, and counts repeats', () => {
    const s = summary({
      decisions: [
        { verdict: 'fix', source: 'review', decidedBy: 'session:abc', createdAt: 0, decidedAt: 1 },
        {
          verdict: 'dismiss',
          source: 'api',
          decidedBy: 'user:3',
          createdAt: 0,
          decidedAt: 2 * H,
          verification: 'confirmed',
        },
        { verdict: 'optional', source: 'github', decidedBy: 'alice', createdAt: H, decidedAt: 5 * H },
        { verdict: 'fix', source: 'api', decidedBy: 'session:x', createdAt: 0, decidedAt: 1 },
        { verdict: null, source: null, createdAt: 0 },
      ],
      findings: [
        { reconciliation: 'new' },
        { reconciliation: 'suppressed' },
        { reconciliation: 'suppressed' },
      ],
    });
    expect(s.dispositions).toMatchObject({
      claims: 5,
      unruled: 1,
      byVerdict: { fix: 2, dismiss: 1, optional: 1 },
      bySource: { review: 2, person: 2 },
      byPeople: { dismiss: 1, optional: 1 },
    });
    expect(s.waiting.verdicts).toEqual({ count: 2, medianMs: 2 * H, p90Ms: 4 * H, maxMs: 4 * H });
    expect(s.repeats.byReconciliation).toEqual({ new: 1, suppressed: 2 });
  });

  it('measures rounds, continuations and what waits on people now', () => {
    const s = summary({
      rounds: [
        { prNumber: 1, round: 1, headSha: 'a', reviewedAt: 10 * H },
        { prNumber: 1, round: 2, headSha: 'b', reviewedAt: 20 * H },
        { prNumber: 1, round: 3, headSha: 'c', reviewedAt: 30 * H },
        { prNumber: 1, round: 4, headSha: 'd', reviewedAt: null, continuedAt: 33 * H },
        { prNumber: 2, round: 1, headSha: 'e', reviewedAt: 40 * H },
      ],
      approvals: [
        { prNumber: 2, headSha: 'e', approvedAt: 46 * H },
        { prNumber: 2, headSha: 'e', approvedAt: 42 * H },
        { prNumber: 2, headSha: 'e', approvedAt: 41 * H, automation: 'linked_account' },
        { prNumber: 3, headSha: 'z', approvedAt: 50 * H },
      ],
      counts: [{ prNumber: 9, refusedAt: 90 * H }],
      readiness: [{ prNumber: 8, waitingSince: 99 * H }],
    });
    expect(s.rounds).toEqual({ pulls: 2, perPull: { '4+': 1, 1: 1 }, continued: 1, waitingAtLimit: 1 });
    expect(s.waiting.continuations).toMatchObject({ count: 1, medianMs: 3 * H });
    // The first human approval of the reviewed head; automation's and one with no review are left out.
    expect(s.waiting.approvals).toMatchObject({ count: 1, medianMs: 2 * H });
    expect(s.waiting.now.atLimit).toMatchObject({ count: 1, maxMs: 10 * H });
    expect(s.waiting.now.forApproval).toMatchObject({ count: 1, maxMs: H });
  });

  it('says when a list was cut', () => {
    expect(summary({ truncated: ['findings'] }).caveats.join('\n')).toContain('for findings');
  });
});
