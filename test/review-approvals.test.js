import { describe, expect, it } from 'vitest';
import {
  APPROVALS_CONTEXT,
  approvalStatusFor,
  authorshipOf,
  computeApprovals,
  githubApprovalRows,
  ownsWorkOn,
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
const directory = {
  user: (id) =>
    ({
      1: { id: 1, name: 'Ada', disabled: false },
      2: { id: 2, name: 'Grace', disabled: false },
      3: { id: 3, name: 'Linus', disabled: true },
      4: { id: 4, name: 'Margaret', disabled: false },
    })[id] || null,
  mayApprove: (id) => id !== 4,
  linkedLogins: () => ['ada-dev'],
};
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
  githubReviewId: 9000 + ids,
  status: 'approved',
  headSha: head,
  baseRef: 'main',
  association: 'COLLABORATOR',
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
    security: input.security || null,
    approvals: input.approvals || [],
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
    expect(state).toMatchObject({ result: 'not_required', reasons: [] });
    expect(approvalStatusFor(state)).toEqual({
      state: 'success',
      description: 'No human approval required at bbbbbbb: low risk',
    });
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
    expect(state.approvals[1].message).toMatch(/Grace owns a session that worked on this pull request/);
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
        onGithub('Ada-Dev'),
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
      ['octo-member', true, null],
    ]);
    expect(state.approvals[0].message).toBe(
      'Approval by Ada-Dev not counted: the account is used by Briareus sessions, so an approval from it on GitHub may be automation’s; its owner can record the approval through the Briareus API.',
    );
    expect(state.approvals[4].message).toBe(
      'Approval by former-owner not counted: it was submitted by a code review’s own label step.',
    );
    expect(state.valid).toBe(1);
  });

  it('lets the owner of a linked account approve through the API instead', () => {
    const state = compute({
      policy: policyOf({ acceptGithubApprovals: true }),
      approvals: [onGithub('ada-dev'), approval(1, { githubLogin: 'ada-dev' }), approval(2)],
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
        linkedLogins: () => {
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
  const review = (id, login, state, over = {}) => ({
    id,
    state,
    commit_id: head,
    submitted_at: '2026-11-10T12:00:00Z',
    author_association: 'COLLABORATOR',
    user: { login, type: 'User' },
    ...over,
  });
  const context = { headSha: head, baseRef: 'main', serverLogin: 'briareus-bot', linkedLogins: ['Ada-Dev'] };

  it('classifies each approval by whether a person can be told to have given it', () => {
    const { rows } = githubApprovalRows(
      [
        review(1, 'octo-reviewer', 'APPROVED'),
        review(2, 'ada-dev', 'APPROVED'),
        review(3, 'Briareus-Bot', 'APPROVED'),
        review(4, 'renovate[bot]', 'APPROVED', { user: { login: 'renovate[bot]', type: 'Bot' } }),
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
      linkedLogins: [],
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
      { ...context, author: 'Octo-Author', commitAuthors: ['octo-committer'] },
    );
    expect(rows.map((r) => r.authorship)).toEqual(['author', 'commits', null]);
  });
});

describe('whose change it is', () => {
  it('goes by the linked account on the pull request and its commits, then by sessions', () => {
    expect(authorshipOf({ login: 'Ada-Dev', author: 'ada-dev' })).toBe('author');
    expect(authorshipOf({ login: 'ada-dev', author: 'octo', commitAuthors: ['octo', 'ADA-dev'] })).toBe(
      'commits',
    );
    expect(authorshipOf({ login: 'ada-dev', author: 'octo', commitAuthors: ['octo'], session: true })).toBe(
      'session',
    );
    expect(authorshipOf({ login: null, author: 'octo', commitAuthors: ['octo'], session: true })).toBe(
      'session',
    );
    expect(authorshipOf({ login: 'ada-dev', author: 'octo', commitAuthors: ['octo'] })).toBeNull();
    // Without a linked account nothing on GitHub can be tied to the user.
    expect(authorshipOf({ login: null, author: null, commitAuthors: [] })).toBeNull();
  });

  it('ties a pull request to the owner of a session that worked on it, not of one that only read it', () => {
    const sessions = [
      { ownerId: 1, repo: 'acme/shop', prStatus: { number: 7 } },
      { ownerId: 2, repo: 'acme/shop', startedOnPr: 7, activity: 'review' },
      { ownerId: 3, repo: 'acme/shop', startedOnPr: 7, activity: 'test-run' },
      { ownerId: 4, repo: 'acme/shop', startedOnPr: 7, preview: true },
      { ownerId: 5, repo: 'acme/shop', startedOnPr: 7, activity: 'fix-checks' },
      { ownerId: 6, repo: 'acme/other', prStatus: { number: 7 } },
      { ownerId: null, repo: 'acme/shop', prStatus: { number: 7 } },
    ];
    const owns = (userId, prNumber = 7) => ownsWorkOn(sessions, { userId, repo: 'Acme/Shop', prNumber });
    expect([1, 2, 3, 4, 5, 6].map((id) => owns(id))).toEqual([true, false, false, false, true, false]);
    expect(owns(1, 8)).toBe(false);
  });
});
