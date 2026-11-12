import { describe, expect, it } from 'vitest';
import {
  APPROVALS_CONTEXT,
  approvalStatusFor,
  authorshipGap,
  authorshipOf,
  computeApprovals,
  githubApprovalRows,
  openedPull,
  sameAccount,
} from '../lib/review-approvals.js';
import { assessRisk, normalizeApprovalPolicy } from '../lib/review-risk.js';

const head = 'a'.repeat(40);
const next = 'b'.repeat(40);
const policyOf = (over = {}) =>
  normalizeApprovalPolicy({
    enabled: true,
    rules: [
      { pattern: '/migrations/', tier: 'high', label: 'Schema' },
      { pattern: '/config/', tier: 'medium' },
    ],
    ...over,
  });
const riskOf = (policy, paths) =>
  assessRisk({ policy, files: paths.map((path) => ({ path, additions: 1, deletions: 0 })) });
// Ada and Grace are users with access; Linus is disabled, Margaret lost the project.
// Each linked a GitHub account, which GitHub knows by an id of its own; Katherine (5)
// never linked one.
const accounts = {
  1: [{ id: 101, login: 'ada-dev' }],
  2: [{ id: 102, login: 'grace-dev' }],
  3: [{ id: 103, login: 'linus-dev' }],
  4: [{ id: 104, login: 'margaret-dev' }],
  9: [{ id: 109, login: 'gone-dev' }],
};
const directory = {
  user: (id) =>
    ({
      1: { id: 1, name: 'Ada', disabled: false },
      2: { id: 2, name: 'Grace', disabled: false },
      3: { id: 3, name: 'Linus', disabled: true },
      4: { id: 4, name: 'Margaret', disabled: false },
      5: { id: 5, name: 'Katherine', disabled: false },
    })[id] || null,
  mayApprove: (id) => id !== 4,
  accountsOf: (id) => accounts[id] || [],
  linkedAccounts: () => Object.values(accounts).flat(),
};
// Who wrote the pull request, as read from GitHub: somebody none of them is.
const written = (over = {}) => ({
  author: { id: 900, login: 'octo-author' },
  commits: [{ id: 900, login: 'octo-author' }],
  shas: ['c'.repeat(40)],
  complete: true,
  ...over,
});
const reviewedAt = (sha = head, over = {}) => ({
  outcome: 'passed',
  stale: false,
  reviewed: { headSha: sha, baseRef: 'main' },
  headSha: sha,
  baseRef: 'main',
  ...over,
});
let ids = 0;
const approval = (userId, over = {}) => ({
  id: ++ids,
  source: 'briareus',
  userId,
  approver: `user ${userId}`,
  status: 'approved',
  headSha: head,
  baseRef: 'main',
  approvedAt: '2026-11-10T12:00:00.000Z',
  ...over,
});
const onGithub = (login, over = {}) => ({
  id: ++ids,
  source: 'github',
  userId: null,
  githubLogin: login,
  // An account of its own unless the test says whose it is.
  githubUserId: 5000 + ids,
  githubReviewId: 9000 + ids,
  status: 'approved',
  headSha: head,
  baseRef: 'main',
  // Push access, as the server verified it (lib/review-revision.js).
  association: 'WRITE',
  automation: null,
  approvedAt: '2026-11-10T12:00:00.000Z',
  ...over,
});
const synced = { syncedAt: '2026-11-10T12:01:00.000Z', error: null };
const compute = (input = {}) => {
  const policy = input.policy === undefined ? policyOf() : input.policy;
  return computeApprovals({
    policy,
    project: { id: 1, repo: 'acme/shop' },
    risk: policy ? (input.risk ?? riskOf(policy, input.paths || ['migrations/1.sql'])) : null,
    outcome: input.outcome || reviewedAt(),
    reviewEnded: input.reviewEnded ?? true,
    security: input.security || null,
    approvals: input.approvals || [],
    authors: input.authors === undefined ? written() : input.authors,
    workers: input.workers || [],
    github: input.github === undefined ? synced : input.github,
    directory: input.directory || directory,
  });
};
const reasonsOf = (state) => state.approvals.map((a) => [a.by.name, a.counted, a.reason]);

describe('the approval requirement', () => {
  it('asks for nothing without a policy, and says so', () => {
    const state = compute({ policy: null, approvals: [approval(1)] });
    expect(state).toMatchObject({
      enabled: false,
      result: 'not_required',
      required: 0,
      valid: 0,
      tier: null,
      risk: null,
      reasons: [],
      explanation: 'This project requires no human approval.',
    });
    expect(state.approvals).toEqual([expect.objectContaining({ counted: false, reason: 'policy_off' })]);
    expect(approvalStatusFor(state)).toEqual({
      state: 'success',
      description: 'Human approval is not required by this project',
    });
  });

  it('asks for as many approvals as the tier says, by tier', () => {
    expect(compute({ paths: ['src/a.js'] })).toMatchObject({
      tier: 'low',
      required: 0,
      result: 'not_required',
    });
    expect(compute({ paths: ['config/a.yml'] })).toMatchObject({
      tier: 'medium',
      required: 1,
      result: 'pending',
    });
    expect(compute({ paths: ['migrations/1.sql'] })).toMatchObject({
      tier: 'high',
      required: 2,
      result: 'pending',
    });
    const custom = policyOf({
      tiers: { low: { approvals: 1 }, medium: { approvals: 1 }, high: { approvals: 4 } },
    });
    expect(compute({ policy: custom, paths: ['src/a.js'] })).toMatchObject({ tier: 'low', required: 1 });
    expect(compute({ policy: custom, paths: ['migrations/1.sql'] })).toMatchObject({ required: 4 });
    // Zero is a legitimate answer for every tier.
    const none = policyOf({ tiers: { medium: { approvals: 0 }, high: { approvals: 0 } } });
    expect(compute({ policy: none, paths: ['migrations/1.sql'] })).toMatchObject({
      tier: 'high',
      required: 0,
      result: 'not_required',
    });
  });

  it('explains the requirement: the tier, what produced it, who approved and what is missing', () => {
    const state = compute({ approvals: [approval(1)] });
    expect(state).toMatchObject({
      enabled: true,
      result: 'pending',
      tier: 'high',
      required: 2,
      valid: 1,
      missing: 1,
      reviewCurrent: true,
      headSha: head,
      baseRef: 'main',
    });
    expect(state.risk.reasons[0]).toMatchObject({
      code: 'sensitive_path',
      label: 'Schema',
      paths: ['migrations/1.sql'],
    });
    expect(state.reasons).toEqual([
      expect.objectContaining({
        code: 'approvals_missing',
        effect: 'pending',
        tier: 'high',
        required: 2,
        valid: 1,
        missing: 1,
        message:
          'This change is high risk, which asks for 2 human approvals of aaaaaaa against main. 1 approval counts (Ada); 1 more is needed.',
      }),
    ]);
    expect(state.approvals[0]).toMatchObject({
      source: 'briareus',
      by: { userId: 1, name: 'Ada' },
      headSha: head,
      baseRef: 'main',
      counted: true,
      reason: null,
    });
    expect(approvalStatusFor(state)).toEqual({
      state: 'pending',
      description: '1 of 2 human approvals at aaaaaaa (high risk)',
    });
  });

  it('is satisfied once enough people approved the reviewed revision', () => {
    const state = compute({ approvals: [approval(1), approval(2)] });
    expect(state).toMatchObject({ result: 'satisfied', valid: 2, missing: 0, reasons: [] });
    expect(state.explanation).toBe(
      'This change is high risk, which asks for 2 human approvals of aaaaaaa against main. 2 approvals count (Ada, Grace).',
    );
    expect(approvalStatusFor(state)).toEqual({
      state: 'success',
      description: '2 of 2 human approvals at aaaaaaa (high risk)',
    });
  });

  it('never reads a missing approval as a finding or a change to make', () => {
    const state = compute();
    expect(state.reasons.map((r) => r.effect)).toEqual(['pending']);
    expect(approvalStatusFor(state).state).toBe('pending');
    expect(APPROVALS_CONTEXT).toBe('briareus/approvals');
  });
});

describe('an approval bound to its revision', () => {
  it('stops counting when the head moves, and stays on record with why', () => {
    const given = [approval(1), approval(2)];
    const state = compute({
      approvals: given,
      outcome: reviewedAt(head, { headSha: next, stale: true, outcome: 'pending' }),
    });
    expect(state).toMatchObject({ result: 'pending', valid: 0, missing: 2, reviewCurrent: false });
    expect(reasonsOf(state)).toEqual([
      ['Ada', false, 'head_moved'],
      ['Grace', false, 'head_moved'],
    ]);
    expect(state.approvals[0].message).toBe(
      'Approval by Ada not counted: it approves aaaaaaa and the pull request is at bbbbbbb.',
    );
    expect(state.reasons.map((r) => r.code)).toEqual(['approvals_missing', 'review_not_current']);
  });

  it('stops counting when the pull request is retargeted, on the same head', () => {
    const state = compute({
      approvals: [approval(1), approval(2)],
      outcome: reviewedAt(head, { baseRef: 'release', stale: true, outcome: 'pending' }),
    });
    expect(reasonsOf(state)).toEqual([
      ['Ada', false, 'base_changed'],
      ['Grace', false, 'base_changed'],
    ]);
    expect(state.approvals[0].message).toMatch(/given against main and the pull request now targets release/);
  });

  it('keeps counting while only the base branch gained commits', () => {
    // Nothing of the base branch's tip is an input: the same head against the same
    // branch is the same revision, as for the review outcome.
    const state = compute({ approvals: [approval(1), approval(2)] });
    expect(state.result).toBe('satisfied');
  });

  it('counts again for nobody: an approval of the old head does not follow to a new review', () => {
    const state = compute({ approvals: [approval(1), approval(2)], outcome: reviewedAt(next) });
    expect(state).toMatchObject({ result: 'pending', valid: 0, reviewCurrent: true });
    expect(state.reasons.map((r) => r.code)).toEqual(['approvals_missing']);
  });

  it('does not count a withdrawn approval, which stays listed', () => {
    const state = compute({
      approvals: [
        approval(1, {
          status: 'withdrawn',
          withdrawnAt: '2026-11-10T13:00:00.000Z',
          withdrawNote: 'Looked again',
        }),
        approval(2),
      ],
    });
    expect(state).toMatchObject({ valid: 1, result: 'pending' });
    expect(state.approvals[0]).toMatchObject({
      counted: false,
      reason: 'withdrawn',
      withdrawnAt: '2026-11-10T13:00:00.000Z',
      withdrawNote: 'Looked again',
    });
  });

  it('is not satisfied while the review does not cover the revision, whatever was approved', () => {
    // Approvals given on GitHub for a head no review has covered yet.
    const policy = policyOf({ acceptGithubApprovals: true });
    const state = compute({
      policy,
      approvals: [onGithub('octo-reviewer', { headSha: next }), onGithub('mona-reviewer', { headSha: next })],
      outcome: reviewedAt(head, { headSha: next, stale: true, outcome: 'pending' }),
    });
    expect(state).toMatchObject({ valid: 2, missing: 0, reviewCurrent: false, result: 'pending' });
    expect(state.reasons).toEqual([
      expect.objectContaining({
        code: 'review_not_current',
        effect: 'pending',
        message: expect.stringMatching(/covered aaaaaaa against main, not bbbbbbb against main/),
      }),
    ]);
    expect(approvalStatusFor(state)).toEqual({
      state: 'pending',
      description: '2 of 2 human approvals at bbbbbbb (high risk); waiting for a review of this revision',
    });
    // And with no review at all.
    const unreviewed = compute({
      policy,
      approvals: [onGithub('octo-reviewer'), onGithub('mona-reviewer')],
      outcome: { outcome: 'pending', stale: false, reviewed: null, headSha: head, baseRef: 'main' },
    });
    expect(unreviewed.result).toBe('pending');
    expect(unreviewed.reasons.map((r) => r.code)).toEqual(['no_review']);
  });

  it('asks nothing of the review when the tier asks for no approval', () => {
    const state = compute({
      paths: ['src/a.js'],
      outcome: reviewedAt(head, { headSha: next, stale: true, outcome: 'pending' }),
    });
    expect(state).toMatchObject({ result: 'not_required', required: 0 });
    // Nothing waits on the review, so it only explains the status.
    expect(state.reasons).toEqual([expect.objectContaining({ code: 'review_not_current', effect: 'note' })]);
  });

  it('never says success for a revision no review has finished with, whatever its tier asks', () => {
    // No approval is required of a low-risk change; its status still waits for a review.
    for (const outcome of [
      { outcome: 'pending', stale: false, reviewed: null, headSha: head, baseRef: 'main' },
      reviewedAt(head, { headSha: next, stale: true, outcome: 'pending' }),
    ]) {
      const state = compute({ paths: ['src/a.js'], outcome });
      expect(state.result).toBe('not_required');
      expect(approvalStatusFor(state)).toEqual({
        state: 'pending',
        description: `No human approval required at ${outcome.headSha.slice(0, 7)}: low risk; waiting for a review of this revision`,
      });
    }
    expect(approvalStatusFor(compute({ paths: ['src/a.js'] }))).toEqual({
      state: 'success',
      description: 'No human approval required at aaaaaaa: low risk',
    });
  });

  it('does not count a review that is still running as a review of the revision', () => {
    // Two approvals given on GitHub before and while the review of this head runs.
    const policy = policyOf({ acceptGithubApprovals: true });
    const given = [onGithub('octo-reviewer'), onGithub('mona-reviewer')];
    const running = compute({
      policy,
      approvals: given,
      reviewEnded: false,
      outcome: reviewedAt(head, { outcome: 'pending' }),
    });
    expect(running).toMatchObject({ valid: 2, missing: 0, reviewCurrent: false, result: 'pending' });
    expect(running.reasons).toEqual([
      expect.objectContaining({
        code: 'review_running',
        effect: 'pending',
        message:
          'A code review of aaaaaaa against main is still running: approvals make the pull request ready once it has ended.',
      }),
    ]);
    expect(approvalStatusFor(running).state).toBe('pending');
    // Once it has ended the same approvals satisfy it.
    const ended = compute({ policy, approvals: given });
    expect(ended).toMatchObject({ reviewCurrent: true, result: 'satisfied' });
    expect(approvalStatusFor(ended).state).toBe('success');
  });
});

describe('who counts as a person approving', () => {
  it('counts a user’s approval recorded through the API while that user may still act on the project', () => {
    const state = compute({ approvals: [approval(1), approval(3), approval(4), approval(9)] });
    expect(reasonsOf(state)).toEqual([
      ['Ada', true, null],
      ['Linus', false, 'approver_disabled'],
      ['Margaret', false, 'approver_no_access'],
      ['user 9', false, 'approver_gone'],
    ]);
    // And only while which accounts are theirs can be read at all.
    const unknown = compute({
      approvals: [approval(1)],
      directory: {
        ...directory,
        accountsOf: () => {
          throw new Error('Linked GitHub accounts are unavailable');
        },
      },
    });
    expect(reasonsOf(unknown)).toEqual([['Ada', false, 'approver_unconfirmed']]);
  });

  it('counts nobody when the server cannot say who its users are', () => {
    const state = computeApprovals({
      policy: policyOf(),
      risk: riskOf(policyOf(), ['migrations/1.sql']),
      outcome: reviewedAt(),
      approvals: [approval(1)],
    });
    expect(state.valid).toBe(0);
    expect(state.approvals[0].reason).toBe('approver_gone');
  });

  it('counts each person once', () => {
    const state = compute({ approvals: [approval(1), approval(1)] });
    expect(state.valid).toBe(1);
    expect(state.approvals[1]).toMatchObject({ counted: false, reason: 'duplicate' });
  });

  it('does not count an approval of one’s own change unless the project allows it', () => {
    const own = [
      approval(1, { authorship: 'author' }),
      approval(2, { authorship: 'session' }),
      approval(2, { authorship: 'commits', id: 777 }),
    ];
    const state = compute({ approvals: own });
    expect(state.valid).toBe(0);
    expect(state.approvals.map((a) => a.reason)).toEqual(['own_change', 'own_change', 'own_change']);
    expect(state.approvals[0].message).toBe(
      'Approval by Ada not counted: Ada opened this pull request, and this project does not count an approval of one’s own change.',
    );
    expect(state.approvals[1].message).toMatch(/Grace owns a session that committed to this pull request/);
    expect(state.approvals[2].message).toMatch(/Grace has commits in this pull request/);
    const allowed = compute({ policy: policyOf({ allowSelfApproval: true }), approvals: own.slice(0, 2) });
    expect(allowed).toMatchObject({ valid: 2, result: 'satisfied', allowsSelfApproval: true });
  });

  it('counts no approval given on GitHub unless the project accepts those', () => {
    const state = compute({ approvals: [onGithub('octo-reviewer'), onGithub('mona-reviewer')] });
    expect(state).toMatchObject({ valid: 0, acceptsGithubApprovals: false });
    expect(state.approvals[0]).toMatchObject({
      counted: false,
      reason: 'github_not_accepted',
      message:
        'Approval by octo-reviewer not counted: this project counts only approvals recorded through the Briareus API.',
    });
  });

  it('counts an outside collaborator’s approval on GitHub when the project accepts those', () => {
    const state = compute({
      policy: policyOf({ acceptGithubApprovals: true }),
      approvals: [onGithub('octo-reviewer'), approval(2)],
    });
    expect(state).toMatchObject({ valid: 2, result: 'satisfied', acceptsGithubApprovals: true });
    expect(state.approvals[0]).toMatchObject({
      source: 'github',
      by: { userId: null, name: 'octo-reviewer', githubLogin: 'octo-reviewer' },
      counted: true,
    });
  });

  it('never counts a GitHub approval from an account automation acts as, and says why', () => {
    const policy = policyOf({ acceptGithubApprovals: true });
    const state = compute({
      policy,
      approvals: [
        // The account a user linked: sessions run `gh` as it, the label step included.
        onGithub('Ada-Dev', { githubUserId: 101 }),
        // Recorded as automation's when first seen, and no longer linked now.
        onGithub('grace-dev', { automation: 'linked_account' }),
        onGithub('briareus-bot', { automation: 'server_account' }),
        onGithub('dependabot[bot]', { automation: 'bot_account' }),
        // The review's own approval, whatever account it used.
        onGithub('former-owner', { automation: 'review_label_step' }),
        onGithub('drive-by', { association: 'NONE' }),
        onGithub('first-timer', { association: 'CONTRIBUTOR' }),
        onGithub('octo-member', { association: 'MEMBER' }),
      ],
    });
    expect(reasonsOf(state)).toEqual([
      ['Ada-Dev', false, 'linked_account'],
      ['grace-dev', false, 'linked_account'],
      ['briareus-bot', false, 'server_account'],
      ['dependabot[bot]', false, 'bot_account'],
      ['former-owner', false, 'review_label_step'],
      ['drive-by', false, 'not_a_collaborator'],
      ['first-timer', false, 'not_a_collaborator'],
      ['octo-member', false, 'not_a_collaborator'],
    ]);
    expect(state.approvals[0].message).toBe(
      'Approval by Ada-Dev not counted: the account is used by Briareus sessions, so an approval from it on GitHub may be automation’s; its owner can record the approval through the Briareus API.',
    );
    expect(state.approvals[4].message).toBe(
      'Approval by former-owner not counted: it was submitted by a code review’s own label step.',
    );
    expect(state.valid).toBe(0);
  });

  it('lets the owner of a linked account approve through the API instead', () => {
    const state = compute({
      policy: policyOf({ acceptGithubApprovals: true }),
      approvals: [
        onGithub('ada-dev', { githubUserId: 101 }),
        approval(1, { githubLogin: 'ada-dev' }),
        approval(2),
      ],
    });
    expect(reasonsOf(state)).toEqual([
      ['ada-dev', false, 'linked_account'],
      ['Ada', true, null],
      ['Grace', true, null],
    ]);
    expect(state.result).toBe('satisfied');
  });

  it('follows GitHub when an approval there was dismissed or superseded', () => {
    const state = compute({
      policy: policyOf({ acceptGithubApprovals: true }),
      approvals: [
        onGithub('octo-reviewer', { status: 'dismissed' }),
        onGithub('mona-reviewer', { status: 'superseded' }),
      ],
    });
    expect(state.approvals.map((a) => a.reason)).toEqual(['dismissed', 'superseded']);
  });

  it('counts no GitHub approval while GitHub, or who is linked, cannot be read', () => {
    const policy = policyOf({ acceptGithubApprovals: true });
    const given = [onGithub('octo-reviewer'), approval(2)];
    const failed = compute({
      policy,
      approvals: given,
      github: { syncedAt: null, error: 'GitHub answered 502' },
    });
    expect(reasonsOf(failed)).toEqual([
      ['octo-reviewer', false, 'github_unconfirmed'],
      ['Grace', true, null],
    ]);
    expect(failed.reasons.map((r) => r.code)).toEqual(['approvals_missing', 'github_approvals_unread']);
    expect(compute({ policy, approvals: given, github: null }).valid).toBe(1);
    const unknown = compute({
      policy,
      approvals: given,
      directory: {
        ...directory,
        linkedAccounts: () => {
          throw new Error('User credentials are unavailable');
        },
      },
    });
    expect(reasonsOf(unknown)).toEqual([
      ['octo-reviewer', false, 'github_unconfirmed'],
      ['Grace', true, null],
    ]);
  });

  it('does not count a GitHub approval whose base branch the server never saw', () => {
    const state = compute({
      policy: policyOf({ acceptGithubApprovals: true }),
      approvals: [onGithub('octo-reviewer', { baseRef: null })],
    });
    expect(state.approvals[0]).toMatchObject({ counted: false, reason: 'base_changed' });
  });
});

describe('what raises the tier beyond the diff', () => {
  const policy = policyOf({ securitySignalTier: 'high' });

  it('treats an unknown file list as the highest tier and says so', () => {
    const state = compute({
      risk: assessRisk({ policy: policyOf(), complete: false, incomplete: 'github_error' }),
    });
    expect(state).toMatchObject({ tier: 'high', required: 2, result: 'pending' });
    expect(state.reasons.map((r) => [r.code, r.effect])).toEqual([
      ['approvals_missing', 'pending'],
      ['file_list_unknown', 'note'],
    ]);
  });

  it('raises on a security result that is not clean, only when the project says so', () => {
    for (const security of [
      { result: 'failed', counts: { findings: 1 } },
      { result: 'incomplete', counts: { findings: 0 } },
      { result: 'not_run', counts: { findings: 0 } },
      { result: 'passed', counts: { findings: 2 } },
    ]) {
      const state = compute({ policy, paths: ['src/a.js'], security });
      expect(state).toMatchObject({ tier: 'high', required: 2 });
      expect(state.reasons[0]).toMatchObject({ code: 'security_signal', effect: 'note', tier: 'high' });
      // Without the setting the same result changes nothing.
      expect(compute({ paths: ['src/a.js'], security })).toMatchObject({ tier: 'low', required: 0 });
    }
    for (const security of [
      { result: 'passed', counts: { findings: 0 } },
      { result: 'pending', counts: { findings: 0 } },
      { result: 'not_required', counts: { findings: 0 } },
      null,
    ])
      expect(compute({ policy, paths: ['src/a.js'], security }).tier).toBe('low');
  });

  it('never lowers a tier the diff gave', () => {
    const lower = policyOf({ securitySignalTier: 'medium' });
    const state = compute({ policy: lower, security: { result: 'failed', counts: { findings: 1 } } });
    expect(state.tier).toBe('high');
    expect(state.reasons.some((r) => r.code === 'security_signal')).toBe(false);
  });

  it('says which checks the tier made required', () => {
    const strict = policyOf({ tiers: { high: { requireSecurity: true } } });
    expect(compute({ policy: strict }).requiredChecks).toEqual({ security: true });
    expect(compute({ policy: strict, paths: ['src/a.js'] }).requiredChecks).toEqual({ security: false });
  });
});

describe('the approvals GitHub holds, as records', () => {
  // GitHub's user ids, by login, for the accounts these tests name.
  const idOf = (login) =>
    ({ 'ada-dev': 101, 'briareus-bot': 7 })[login.toLowerCase()] ??
    6000 + login.length * 7 + login.charCodeAt(0);
  const review = (id, login, state, over = {}) => ({
    id,
    state,
    commit_id: head,
    submitted_at: '2026-11-10T12:00:00Z',
    author_association: 'COLLABORATOR',
    user: { login, id: idOf(login), type: 'User' },
    ...over,
  });
  const context = {
    headSha: head,
    baseRef: 'main',
    server: { id: 7, login: 'briareus-bot' },
    linked: [{ id: 101, login: 'ada-dev' }],
  };

  it('classifies each approval by whether a person can be told to have given it', () => {
    const { rows } = githubApprovalRows(
      [
        review(1, 'octo-reviewer', 'APPROVED'),
        review(2, 'ada-dev', 'APPROVED'),
        review(3, 'Briareus-Bot', 'APPROVED'),
        review(4, 'renovate[bot]', 'APPROVED', { user: { login: 'renovate[bot]', id: 4242, type: 'Bot' } }),
        review(5, 'mona-reviewer', 'COMMENTED'),
        review(6, 'old-head', 'APPROVED', { commit_id: next }),
      ],
      context,
    );
    expect(rows.map((r) => [r.githubReviewId, r.githubLogin, r.automation, r.status, r.baseRef])).toEqual([
      [1, 'octo-reviewer', null, 'approved', 'main'],
      [2, 'ada-dev', 'linked_account', 'approved', 'main'],
      [3, 'Briareus-Bot', 'server_account', 'approved', 'main'],
      [4, 'renovate[bot]', 'bot_account', 'approved', 'main'],
      // The base branch is only known for an approval of the head being looked at.
      [6, 'old-head', null, 'approved', null],
    ]);
    expect(rows[0]).toMatchObject({
      headSha: head,
      githubUserId: idOf('octo-reviewer'),
      association: 'COLLABORATOR',
      approvedAt: Date.parse('2026-11-10T12:00:00Z'),
    });
  });

  it('takes a person’s latest verdict, and lists what GitHub shows as dismissed', () => {
    const { rows, dismissed } = githubApprovalRows(
      [
        review(1, 'octo-reviewer', 'APPROVED'),
        review(2, 'octo-reviewer', 'CHANGES_REQUESTED'),
        review(3, 'mona-reviewer', 'APPROVED'),
        review(4, 'mona-reviewer', 'COMMENTED'),
        review(5, 'hubot-reviewer', 'DISMISSED'),
      ],
      context,
    );
    expect(rows.map((r) => [r.githubReviewId, r.status])).toEqual([
      [1, 'superseded'],
      [3, 'approved'],
    ]);
    expect(dismissed).toEqual([5]);
  });

  it('marks the approval a review’s label step submitted as the review’s own, by the ids known before it', () => {
    const reviews = [
      review(1, 'ada-dev', 'APPROVED'),
      review(2, 'ada-dev', 'APPROVED'),
      review(3, 'octo-reviewer', 'APPROVED'),
    ];
    const { rows } = githubApprovalRows(reviews, {
      ...context,
      linked: [],
      labelStep: { login: 'ada-dev', known: [1], since: 0 },
    });
    expect(rows.map((r) => [r.githubReviewId, r.automation])).toEqual([
      [1, null],
      [2, 'review_label_step'],
      [3, null],
    ]);
  });

  it('goes by the two clocks when the ids are not known, and by the server’s account when the review used it', () => {
    const since = Date.parse('2026-11-10T12:00:30Z');
    const { rows } = githubApprovalRows(
      [
        review(1, 'briareus-bot', 'APPROVED', { submitted_at: '2026-11-10T11:00:00Z' }),
        review(2, 'briareus-bot', 'APPROVED', { submitted_at: '2026-11-10T12:00:00Z' }),
      ],
      { ...context, labelStep: { login: null, known: null, since } },
    );
    expect(rows.map((r) => r.automation)).toEqual(['server_account', 'review_label_step']);
  });

  it('notes an approver who wrote part of the change', () => {
    const { rows } = githubApprovalRows(
      [
        review(1, 'octo-author', 'APPROVED'),
        review(2, 'octo-committer', 'APPROVED'),
        review(3, 'octo-reviewer', 'APPROVED'),
      ],
      {
        ...context,
        authors: {
          author: { id: idOf('octo-author'), login: 'Octo-Author' },
          commits: [{ id: idOf('octo-committer'), login: 'octo-committer' }],
        },
      },
    );
    expect(rows.map((r) => r.authorship)).toEqual(['author', 'commits', null]);
  });

  it('knows an account by GitHub’s id, not by a login that can be renamed and taken', () => {
    const { rows } = githubApprovalRows(
      [
        // Ada's linked account under a new login, and the server's under one.
        review(1, 'ada-renamed', 'APPROVED', { user: { login: 'ada-renamed', id: 101, type: 'User' } }),
        review(2, 'briareus-two', 'APPROVED', { user: { login: 'briareus-two', id: 7, type: 'User' } }),
        // Somebody else who took the login Ada's account used to have.
        review(3, 'ada-dev', 'APPROVED', { user: { login: 'ada-dev', id: 555, type: 'User' } }),
        // No id at all: the login is all there is to go by.
        review(4, 'ada-dev', 'APPROVED', { user: { login: 'ADA-DEV', type: 'User' } }),
      ],
      context,
    );
    expect(rows.map((r) => [r.githubLogin, r.githubUserId, r.automation])).toEqual([
      ['ada-renamed', 101, 'linked_account'],
      ['briareus-two', 7, 'server_account'],
      ['ada-dev', 555, null],
      ['ADA-DEV', null, 'linked_account'],
    ]);
  });
});

describe('whose change it is', () => {
  const authors = written({
    author: { id: 900, login: 'octo-author' },
    commits: [
      { id: 900, login: 'octo-author' },
      { id: 101, login: 'ada-dev' },
    ],
  });

  it('goes by the accounts on the pull request and its commits, then by sessions', () => {
    expect(authorshipOf({ accounts: [{ id: 900, login: 'someone' }], authors })).toBe('author');
    expect(authorshipOf({ accounts: [{ id: null, login: 'Octo-Author' }], authors })).toBe('author');
    expect(authorshipOf({ accounts: [{ id: 101, login: 'ada-renamed' }], authors })).toBe('commits');
    expect(authorshipOf({ accounts: [{ id: 102, login: 'grace-dev' }], authors, session: true })).toBe(
      'session',
    );
    expect(authorshipOf({ accounts: [], authors, session: true })).toBe('session');
    expect(authorshipOf({ accounts: [{ id: 102, login: 'grace-dev' }], authors })).toBeNull();
    // Without an account nothing on GitHub can be tied to the user.
    expect(authorshipOf({ accounts: [], authors })).toBeNull();
    expect(authorshipOf({ accounts: [{ id: 101, login: 'ada-dev' }], authors: null })).toBeNull();
  });

  it('tells two accounts apart by id where both have one', () => {
    expect(sameAccount({ id: 1, login: 'a' }, { id: 1, login: 'b' })).toBe(true);
    expect(sameAccount({ id: 1, login: 'a' }, { id: 2, login: 'a' })).toBe(false);
    expect(sameAccount({ id: null, login: 'A' }, { id: 2, login: 'a' })).toBe(true);
    expect(sameAccount({ id: null, login: '' }, { id: null, login: '' })).toBe(false);
    expect(sameAccount(null, { id: 1, login: 'a' })).toBe(false);
  });

  it('says when who wrote a pull request is not known in full', () => {
    expect(authorshipGap(written())).toBeNull();
    expect(authorshipGap(null)).toMatch(/could not be read from GitHub/);
    expect(authorshipGap(written({ complete: false }))).toMatch(/more commits than GitHub lists/);
  });

  it('ties a pull request to the owner of the session whose branch became it, while the server has it', () => {
    const sessions = [
      { ownerId: 1, repo: 'acme/shop', prStatus: { number: 7 } },
      // Started on the pull request as an errand: what it did there is on record per commit.
      { ownerId: 2, repo: 'acme/shop', startedOnPr: 7, prStatus: { number: 7 }, activity: 'review' },
      { ownerId: 3, repo: 'acme/other', prStatus: { number: 7 } },
      { ownerId: null, repo: 'acme/shop', prStatus: { number: 7 } },
    ];
    const opened = (userId, prNumber = 7) => openedPull(sessions, { userId, repo: 'Acme/Shop', prNumber });
    expect([1, 2, 3].map((id) => opened(id))).toEqual([true, false, false]);
    expect(opened(1, 8)).toBe(false);
  });
});

describe('an approver who wrote the change', () => {
  // Ada opened the pull request under the account she had linked.
  const hers = written({ author: { id: 101, login: 'ada-dev' }, commits: [{ id: 101, login: 'ada-dev' }] });

  it('is recognised whenever the requirement is computed, not only when the approval was recorded', () => {
    // Recorded with nothing known against it.
    const state = compute({ authors: hers, approvals: [approval(1), approval(2)] });
    expect(reasonsOf(state)).toEqual([
      ['Ada', false, 'own_change'],
      ['Grace', true, null],
    ]);
    expect(state.approvals[0].message).toMatch(/Ada opened this pull request/);
  });

  it('is still recognised after unlinking the account: every account ever linked counts', () => {
    // Ada unlinked before approving: the approval carries no account, the history does.
    const state = compute({
      authors: hers,
      approvals: [approval(1, { githubLogin: null, githubUserId: null, authorship: null })],
    });
    expect(reasonsOf(state)).toEqual([['Ada', false, 'own_change']]);
    // And by the account the approval itself was recorded with, should the history be lost.
    const lost = compute({
      authors: hers,
      directory: { ...directory, accountsOf: () => [{ id: 777, login: 'ada-other' }] },
      approvals: [approval(1, { githubLogin: 'ada-dev', githubUserId: 101 })],
    });
    expect(reasonsOf(lost)).toEqual([['Ada', false, 'own_change']]);
    // A renamed account is the same account.
    const renamed = compute({
      authors: hers,
      directory: { ...directory, accountsOf: () => [{ id: 101, login: 'ada-renamed' }] },
      approvals: [approval(1)],
    });
    expect(reasonsOf(renamed)).toEqual([['Ada', false, 'own_change']]);
  });

  it('is recognised by the commits their sessions made, whatever those sessions were for', () => {
    const state = compute({ workers: [2], approvals: [approval(1), approval(2)] });
    expect(reasonsOf(state)).toEqual([
      ['Ada', true, null],
      ['Grace', false, 'own_change'],
    ]);
    expect(state.approvals[1].message).toMatch(/Grace owns a session that committed to this pull request/);
  });

  it('cannot approve under no account at all', () => {
    const state = compute({ approvals: [approval(5), approval(2)] });
    expect(reasonsOf(state)).toEqual([
      ['Katherine', false, 'no_linked_account'],
      ['Grace', true, null],
    ]);
    // Where the project counts an approval of one's own change and no GitHub approval,
    // nothing depends on whose account is whose.
    const open = compute({
      policy: policyOf({ allowSelfApproval: true }),
      approvals: [approval(5), approval(2)],
    });
    expect(open).toMatchObject({ valid: 2, result: 'satisfied' });
  });

  it('counts for nobody while who wrote the pull request is not known', () => {
    const policy = policyOf({ acceptGithubApprovals: true });
    const given = [approval(2), onGithub('octo-reviewer')];
    for (const authors of [null, written({ complete: false })]) {
      const state = compute({ policy, authors, approvals: given });
      expect(reasonsOf(state)).toEqual([
        ['Grace', false, 'authorship_unknown'],
        ['octo-reviewer', false, 'authorship_unknown'],
      ]);
      expect(state).toMatchObject({ valid: 0, result: 'pending' });
      expect(state.reasons.map((r) => r.code)).toEqual(['approvals_missing', 'authorship_unknown']);
    }
    // A co-author's approval on GitHub does not slip through while the commits are unread.
    const coauthor = compute({
      policy,
      authors: null,
      approvals: [onGithub('octo-pair'), onGithub('mona-reviewer')],
    });
    expect(coauthor.valid).toBe(0);
    // Unless the project counts an approval of one's own change anyway.
    const open = compute({
      policy: policyOf({ acceptGithubApprovals: true, allowSelfApproval: true }),
      authors: null,
      approvals: given,
    });
    expect(open).toMatchObject({ valid: 2, result: 'satisfied' });
  });
});

describe('one person, counted once', () => {
  const policy = policyOf({ acceptGithubApprovals: true });

  it('does not count an API approval beside a GitHub approval from an account that cannot be told apart', () => {
    // Katherine linked no account, records an approval here and approves on GitHub with
    // a collaborator account of her own.
    const state = compute({ policy, approvals: [approval(5), onGithub('katherine-personal')] });
    expect(reasonsOf(state)).toEqual([
      ['Katherine', false, 'no_linked_account'],
      ['katherine-personal', true, null],
    ]);
    expect(state).toMatchObject({ valid: 1, required: 2, result: 'pending' });
    // The same for a project that allows approving one's own change.
    const open = compute({
      policy: policyOf({ acceptGithubApprovals: true, allowSelfApproval: true }),
      approvals: [approval(5), onGithub('katherine-personal')],
    });
    expect(open.valid).toBe(1);
  });

  it('keys both sources on the GitHub account: an account once linked is its owner’s on GitHub too', () => {
    // Grace approved here with grace-dev linked, then unlinked it and approved on GitHub:
    // the history still names the account.
    const state = compute({
      policy,
      approvals: [
        approval(2, { githubLogin: 'grace-dev', githubUserId: 102 }),
        onGithub('grace-dev', { githubUserId: 102 }),
      ],
    });
    expect(reasonsOf(state)).toEqual([
      ['Grace', true, null],
      ['grace-dev', false, 'linked_account'],
    ]);
    // Even with the history gone, the account the approval was recorded with is hers.
    const forgotten = {
      ...directory,
      accountsOf: () => [{ id: 888, login: 'grace-new' }],
      linkedAccounts: () => [],
    };
    const lost = compute({
      policy,
      directory: forgotten,
      approvals: [
        approval(2, { githubLogin: 'grace-dev', githubUserId: 102 }),
        onGithub('grace-renamed', { githubUserId: 102 }),
      ],
    });
    expect(reasonsOf(lost)).toEqual([
      ['Grace', true, null],
      ['grace-renamed', false, 'duplicate'],
    ]);
    // In the other order too.
    const reversed = compute({
      policy,
      directory: forgotten,
      approvals: [
        onGithub('grace-renamed', { githubUserId: 102 }),
        approval(2, { githubLogin: 'grace-dev', githubUserId: 102 }),
      ],
    });
    expect(reasonsOf(reversed)).toEqual([
      ['grace-renamed', true, null],
      ['Grace', false, 'duplicate'],
    ]);
  });

  it('knows a linked account by its id after a rename, and not somebody who took its old login', () => {
    const state = compute({
      policy,
      approvals: [
        onGithub('ada-renamed', { githubUserId: 101 }),
        onGithub('ada-dev', { githubUserId: 555 }),
        onGithub('mona-reviewer'),
      ],
    });
    expect(reasonsOf(state)).toEqual([
      ['ada-renamed', false, 'linked_account'],
      ['ada-dev', true, null],
      ['mona-reviewer', true, null],
    ]);
  });
});
