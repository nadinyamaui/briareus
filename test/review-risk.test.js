import { describe, expect, it } from 'vitest';
import {
  PATH_LIMITS,
  POLICY_LIMITS,
  approvalPolicyOf,
  assessRisk,
  assessRiskInBatches,
  compileGlob,
  effectiveSecurityPolicy,
  globMatches,
  normalizeApprovalPolicy,
  policyFingerprint,
  riskOf,
  riskRaisesSecurity,
} from '../lib/review-risk.js';

const matches = (pattern, path) => globMatches(compileGlob(pattern), path);
const policyOf = (over = {}) => normalizeApprovalPolicy({ enabled: true, ...over });
const file = (path, over = {}) => ({ path, status: 'modified', additions: 1, deletions: 0, ...over });

describe('the glob syntax of a sensitive-path rule', () => {
  it.each([
    // A single name is looked for at every depth, and covers what lies beneath it.
    ['*.pem', 'server.pem', true],
    ['*.pem', 'deploy/certs/server.pem', true],
    ['*.pem', 'deploy/certs/server.pem.txt', false],
    ['*.pem', 'certs.pem/README', true],
    ['secrets', 'secrets', true],
    ['secrets', 'config/secrets/prod.yml', true],
    ['secrets', 'config/secrets.yml', false],
    // A trailing slash says directory: only what is beneath it.
    ['secrets/', 'secrets', false],
    ['secrets/', 'secrets/prod.yml', true],
    ['secrets/', 'app/secrets/prod.yml', true],
    // A leading slash, or a slash inside, anchors at the repository root.
    ['/migrations', 'migrations/001_users.sql', true],
    ['/migrations', 'app/migrations/001_users.sql', false],
    ['config/auth.yml', 'config/auth.yml', true],
    ['config/auth.yml', 'services/api/config/auth.yml', false],
    ['/config/', 'config', false],
    ['/config/', 'config/app.yml', true],
    // `*` and `?` stay inside a segment.
    ['/src/*.js', 'src/a.js', true],
    ['/src/*.js', 'src/lib/a.js', false],
    ['/src/a?.js', 'src/ab.js', true],
    ['/src/a?.js', 'src/a.js', false],
    ['/src/a?.js', 'src/a/.js', false],
    ['/src/*', 'src/lib/a.js', true],
    ['/a*c', 'ac', true],
    ['/a*c', 'abbbc', true],
    ['/a*c', 'abbbd', false],
    // `**` is whole segments: none in the middle, at least one at the end.
    ['/a/**/b', 'a/b', true],
    ['/a/**/b', 'a/x/y/b', true],
    ['/a/**/b', 'a/x/y/c', false],
    ['/a/**', 'a/x', true],
    ['/a/**', 'a', false],
    ['**/auth/**', 'auth/login.js', true],
    ['**/auth/**', 'src/auth/login.js', true],
    ['**/auth/**', 'src/authz/login.js', false],
    ['**', 'anything/at/all.txt', true],
    ['**/*.sql', 'schema.sql', true],
    ['**/*.sql', 'db/migrations/1.sql', true],
    ['/a/**/**/b', 'a/b', true],
    // Case-sensitive, like the paths.
    ['/Dockerfile', 'dockerfile', false],
    // Characters that are special elsewhere are plain here.
    ['/a+b(1).txt', 'a+b(1).txt', true],
    ['/a.b', 'axb', false],
    ['/#notes', '#notes', true],
  ])('%s against %s is %s', (pattern, path, expected) => {
    expect(matches(pattern, path)).toBe(expected);
  });

  it.each([
    ['!secrets', /negation/],
    ['/src/[ab].js', /character classes/],
    ['/src/{a,b}.js', /braces/],
    ['/src/a\\*.js', /escapes/],
    ['/src/**.js', /inside a segment/],
    ['/src/a**', /inside a segment/],
    ['/src//a', /empty segment/],
    ['/src/../a', /`\.\.` segment/],
    ['./src', /`\.` segment/],
    ['/', /names nothing/],
    ['', /non-empty string/],
    [' /src', /whitespace/],
    ['/src\n/a', /control character/],
    ['x'.repeat(POLICY_LIMITS.pattern + 1), /longer than/],
    [42, /non-empty string/],
  ])('refuses %j rather than match it as something else', (pattern, why) => {
    expect(() => compileGlob(pattern)).toThrow(why);
  });

  it('matches no path that is not one', () => {
    const glob = compileGlob('**');
    expect(globMatches(glob, '')).toBe(false);
    expect(globMatches(glob, null)).toBe(false);
  });

  it('stays fast on patterns built to backtrack', () => {
    const started = performance.now();
    // Many stars against a name that almost matches: exponential for a naive matcher.
    const stars = compileGlob(`/${'*a'.repeat(60)}*b`);
    expect(globMatches(stars, 'a'.repeat(4000))).toBe(false);
    expect(globMatches(stars, `${'a'.repeat(4000)}b`)).toBe(true);
    // Many `**` against a deep path that fails at the very end.
    const deep = compileGlob(`${'**/a/'.repeat(30)}**/b`);
    const path = `${'a/'.repeat(600)}c`;
    expect(globMatches(deep, path)).toBe(false);
    expect(globMatches(deep, `${'a/'.repeat(600)}b`)).toBe(true);
    const questions = compileGlob(`/${'?*'.repeat(90)}z`);
    expect(globMatches(questions, 'y'.repeat(3000))).toBe(false);
    expect(performance.now() - started).toBeLessThan(2000);
  });
});

describe('the project’s approval policy', () => {
  it('is nothing unless given, and fills in what a given one leaves out', () => {
    expect(normalizeApprovalPolicy(null)).toBeNull();
    expect(normalizeApprovalPolicy('')).toBeNull();
    expect(normalizeApprovalPolicy(undefined)).toBeNull();
    expect(policyOf()).toEqual({
      enabled: true,
      tiers: {
        low: { approvals: 0, requireSecurity: false },
        medium: { approvals: 1, requireSecurity: false },
        high: { approvals: 2, requireSecurity: false },
      },
      rules: [],
      thresholds: {},
      acceptGithubApprovals: false,
      allowSelfApproval: false,
      securitySignalTier: null,
    });
  });

  it('counts only while it is switched on', () => {
    const stored = normalizeApprovalPolicy({ enabled: false, rules: [{ pattern: '/db/', tier: 'high' }] });
    expect(stored.rules).toHaveLength(1);
    expect(approvalPolicyOf({ approvalPolicy: stored })).toBeNull();
    expect(approvalPolicyOf({ approvalPolicy: null })).toBeNull();
    expect(approvalPolicyOf({})).toBeNull();
    expect(approvalPolicyOf({ approvalPolicy: policyOf() })).toMatchObject({ enabled: true });
    // A row somebody wrote by hand, short of what the rules read, is no policy.
    for (const partial of [
      { enabled: true },
      { enabled: true, tiers: {}, rules: [], thresholds: {} },
      { enabled: true, tiers: policyOf().tiers, thresholds: {} },
      { enabled: true, tiers: policyOf().tiers, rules: [] },
      [],
      'on',
    ])
      expect(approvalPolicyOf({ approvalPolicy: partial })).toBeNull();
  });

  it('keeps a rule as written, with its tier, label and own count', () => {
    const policy = policyOf({
      tiers: { high: { approvals: 2, requireSecurity: true } },
      rules: [
        { pattern: '/migrations/', tier: 'high', label: ' Schema ', approvals: 3 },
        { pattern: '*.pem', tier: 'medium' },
      ],
      thresholds: { medium: { files: 30 }, high: { files: 100, lines: 3000 } },
      acceptGithubApprovals: true,
      allowSelfApproval: true,
      securitySignalTier: 'medium',
    });
    expect(policy.rules).toEqual([
      { pattern: '/migrations/', tier: 'high', label: 'Schema', approvals: 3 },
      { pattern: '*.pem', tier: 'medium', label: '', approvals: null },
    ]);
    expect(policy.thresholds).toEqual({
      medium: { files: 30, lines: null },
      high: { files: 100, lines: 3000 },
    });
    expect(policy).toMatchObject({
      acceptGithubApprovals: true,
      allowSelfApproval: true,
      securitySignalTier: 'medium',
    });
    expect(riskRaisesSecurity(policy)).toBe(true);
    expect(riskRaisesSecurity(policyOf())).toBe(false);
    expect(riskRaisesSecurity(null)).toBe(false);
  });

  it.each([
    [[], /must be an object/],
    ['on', /must be an object/],
    [{}, /enabled must be true or false/],
    [{ enabled: 'true' }, /enabled must be true or false/],
    [{ enabled: true, tier: {} }, /unknown fields: tier/],
    [{ enabled: true, tiers: { critical: { approvals: 3 } } }, /unknown fields: critical/],
    [{ enabled: true, tiers: { high: { approvals: 11 } } }, /whole number from 0 to 10/],
    [{ enabled: true, tiers: { high: { approvals: '2' } } }, /whole number/],
    [{ enabled: true, tiers: { high: { approvals: 1.5 } } }, /whole number/],
    [{ enabled: true, tiers: { high: { requireSecurty: true } } }, /unknown fields: requireSecurty/],
    [{ enabled: true, tiers: { high: { requireSecurity: 'yes' } } }, /requireSecurity must be true or false/],
    // A higher tier never asks for less.
    [{ enabled: true, tiers: { medium: { approvals: 2 }, high: { approvals: 1 } } }, /cannot ask for fewer/],
    [{ enabled: true, tiers: { low: { approvals: 1 }, medium: { approvals: 0 } } }, /cannot ask for fewer/],
    [{ enabled: true, tiers: { medium: { requireSecurity: true } } }, /cannot require less/],
    [{ enabled: true, rules: {} }, /rules must be a list/],
    [{ enabled: true, rules: ['/a'] }, /rules\[0\] must be an object/],
    [{ enabled: true, rules: [{ pattern: '!a', tier: 'high' }] }, /rules\[0\]: .*negation/],
    [
      { enabled: true, rules: [{ pattern: '/a', tier: 'critical' }] },
      /tier must be one of low, medium, high/,
    ],
    [{ enabled: true, rules: [{ pattern: '/a' }] }, /tier must be one of/],
    [{ enabled: true, rules: [{ pattern: '/a', tier: 'high', paths: [] }] }, /unknown fields: paths/],
    [{ enabled: true, rules: [{ pattern: '/a', tier: 'high', label: 7 }] }, /label must be text/],
    [{ enabled: true, rules: [{ pattern: '/a', tier: 'high', label: 'x'.repeat(81) }] }, /label is longer/],
    // A rule's own count can only raise its tier's.
    [{ enabled: true, rules: [{ pattern: '/a', tier: 'high', approvals: 1 }] }, /can only raise the count/],
    [
      { enabled: true, rules: Array.from({ length: 51 }, (_, i) => ({ pattern: `/a${i}`, tier: 'high' })) },
      /more than 50 rules/,
    ],
    [{ enabled: true, thresholds: { low: { files: 1 } } }, /unknown fields: low/],
    [{ enabled: true, thresholds: { high: { files: 0 } } }, /at least 1/],
    [{ enabled: true, thresholds: { high: { size: 3 } } }, /unknown fields: size/],
    [{ enabled: true, thresholds: { medium: { files: 50 }, high: { files: 10 } } }, /starts later/],
    [{ enabled: true, acceptGithubApprovals: 1 }, /acceptGithubApprovals must be true or false/],
    [{ enabled: true, allowSelfApproval: 'no' }, /allowSelfApproval must be true or false/],
    [{ enabled: true, securitySignalTier: 'severe' }, /securitySignalTier must be one of/],
  ])('refuses %j', (input, why) => {
    expect(() => normalizeApprovalPolicy(input)).toThrow(why);
    try {
      normalizeApprovalPolicy(input);
    } catch (e) {
      expect(e.status).toBe(400);
    }
  });

  it('names the rules an assessment is made under, and nothing else', () => {
    const base = policyOf({ rules: [{ pattern: '/db/', tier: 'high' }] });
    expect(policyFingerprint(base)).toBe(
      policyFingerprint(policyOf({ rules: [{ pattern: '/db/', tier: 'high' }] })),
    );
    // Who may approve does not change how risky a diff is.
    expect(policyFingerprint({ ...base, acceptGithubApprovals: true, allowSelfApproval: true })).toBe(
      policyFingerprint(base),
    );
    expect(policyFingerprint(policyOf({ rules: [{ pattern: '/db/', tier: 'medium' }] }))).not.toBe(
      policyFingerprint(base),
    );
    expect(policyFingerprint(policyOf({ ...base, tiers: { high: { approvals: 3 } } }))).not.toBe(
      policyFingerprint(base),
    );
  });
});

describe('the risk of a change', () => {
  const policy = policyOf({
    tiers: { high: { approvals: 2, requireSecurity: true } },
    rules: [
      { pattern: '/migrations/', tier: 'high', label: 'Schema' },
      { pattern: '*.pem', tier: 'high', approvals: 3 },
      { pattern: '/config/', tier: 'medium', label: 'Configuration' },
    ],
    thresholds: { medium: { files: 4 }, high: { lines: 500 } },
  });

  it('is low when no rule or threshold applies, and says so', () => {
    const risk = assessRisk({ policy, files: [file('src/cart.js'), file('README.md')] });
    expect(risk).toMatchObject({
      tier: 'low',
      unknown: false,
      approvals: 0,
      requireSecurity: false,
      files: 2,
    });
    expect(risk.reasons).toEqual([
      expect.objectContaining({
        code: 'no_rule_matched',
        tier: 'low',
        message: expect.stringMatching(/2 changed files/),
      }),
    ]);
  });

  it('takes the highest tier any matched rule names, and says which rule matched which files', () => {
    const risk = assessRisk({
      policy,
      files: [file('config/app.yml'), file('migrations/002_orders.sql'), file('migrations/003_items.sql')],
    });
    expect(risk).toMatchObject({ tier: 'high', approvals: 2, requireSecurity: true });
    expect(risk.reasons).toEqual([
      expect.objectContaining({
        code: 'sensitive_path',
        rule: 1,
        pattern: '/migrations/',
        label: 'Schema',
        tier: 'high',
        matched: 2,
        paths: ['migrations/002_orders.sql', 'migrations/003_items.sql'],
        message: expect.stringMatching(/2 changed files match Schema \(`\/migrations\/`\), a high-risk path/),
      }),
      expect.objectContaining({ code: 'sensitive_path', rule: 3, tier: 'medium', paths: ['config/app.yml'] }),
    ]);
  });

  it('adds a matched rule’s own approval count to its tier’s', () => {
    const risk = assessRisk({ policy, files: [file('deploy/server.pem')] });
    expect(risk).toMatchObject({ tier: 'high', approvals: 3 });
    expect(risk.reasons[0]).toMatchObject({
      rule: 2,
      approvals: 3,
      message: expect.stringMatching(/asks for 3 approvals/),
    });
  });

  it('counts a rename out of a sensitive path as much as one into it', () => {
    const out = assessRisk({
      policy,
      files: [file('archive/001_users.sql', { status: 'renamed', previousPath: 'migrations/001_users.sql' })],
    });
    expect(out.tier).toBe('high');
    expect(out.reasons[0]).toMatchObject({
      rule: 1,
      matched: 1,
      paths: [],
      renamedFrom: [{ from: 'migrations/001_users.sql', to: 'archive/001_users.sql' }],
      message: expect.stringMatching(/migrations\/001_users\.sql \(moved to archive\/001_users\.sql\)/),
    });
    const into = assessRisk({
      policy,
      files: [file('config/flags.yml', { status: 'renamed', previousPath: 'docs/flags.yml' })],
    });
    expect(into.tier).toBe('medium');
    expect(into.reasons[0]).toMatchObject({ rule: 3, paths: ['config/flags.yml'], renamedFrom: [] });
  });

  it('raises the tier on size alone', () => {
    const many = assessRisk({ policy, files: ['a', 'b', 'c', 'd'].map((name) => file(`src/${name}.js`)) });
    expect(many.tier).toBe('medium');
    expect(many.reasons).toEqual([
      expect.objectContaining({ code: 'size_files', tier: 'medium', threshold: 4, value: 4 }),
    ]);
    const large = assessRisk({ policy, files: [file('src/a.js', { additions: 400, deletions: 100 })] });
    expect(large).toMatchObject({ tier: 'high', lines: 500 });
    expect(large.reasons).toEqual([
      expect.objectContaining({ code: 'size_lines', tier: 'high', threshold: 500, value: 500 }),
    ]);
    expect(assessRisk({ policy, files: [file('src/a.js', { additions: 499 })] }).tier).toBe('low');
  });

  it('treats a file list that is not the whole change as the highest tier, never as low', () => {
    for (const incomplete of [
      'github_error',
      'too_many_files',
      'list_incomplete',
      'head_moved',
      'not_assessed',
    ]) {
      const risk = assessRisk({ policy, files: [file('README.md')], complete: false, incomplete });
      expect(risk).toMatchObject({ tier: 'high', unknown: true, approvals: 2, requireSecurity: true });
      expect(risk.reasons[0]).toMatchObject({ code: 'file_list_unknown', tier: 'high', why: incomplete });
      expect(risk.reasons.some((r) => r.code === 'no_rule_matched')).toBe(false);
    }
    // What was read is still listed, and a rule's own count still applies.
    const partial = assessRisk({
      policy,
      files: [file('a.pem')],
      complete: false,
      incomplete: 'github_error',
      detail: 'GitHub answered 502',
    });
    expect(partial.approvals).toBe(3);
    expect(partial.reasons.map((r) => r.code)).toEqual(['file_list_unknown', 'sensitive_path']);
    expect(partial.reasons[0].message).toMatch(
      /GitHub could not be read: GitHub answered 502.*treated as high risk/,
    );
    // With no files at all, too.
    expect(assessRisk({ policy: policyOf(), complete: false })).toMatchObject({ tier: 'high', approvals: 2 });
  });

  it('lists a bounded number of paths and counts them all', () => {
    const files = Array.from({ length: 45 }, (_, i) => file(`migrations/${i}.sql`));
    const [reason] = assessRisk({ policy, files }).reasons;
    expect(reason.matched).toBe(45);
    expect(reason.paths).toHaveLength(20);
    expect(reason.message).toMatch(/, …\.$/);
    const long = assessRisk({ policy, files: [file(`migrations/${'x'.repeat(500)}.sql`)] });
    expect(long.reasons[0].paths[0]).toHaveLength(300);
  });
});

describe('an assessment of many files', () => {
  const pems = policyOf({
    rules: Array.from({ length: 50 }, (_, i) => ({ pattern: i ? `*.pem${i}` : '*.pem', tier: 'medium' })),
  });

  it('does not match a path too long to match, and never ignores it', () => {
    const deep = Array.from({ length: PATH_LIMITS.segments + 1 }, () => 'a').join('/');
    const long = `src/${'x'.repeat(PATH_LIMITS.length)}.js`;
    for (const path of [deep, long]) {
      const risk = assessRisk({ policy: pems, files: [file('README.md'), file(path)] });
      expect(risk).toMatchObject({ tier: 'high', unknown: false, files: 2 });
      expect(risk.reasons).toEqual([
        expect.objectContaining({
          code: 'path_unassessable',
          tier: 'high',
          matched: 1,
          message: expect.stringMatching(/1 changed file has a path too long.*treated as high risk/),
        }),
      ]);
      expect(risk.reasons[0].paths[0].length).toBeLessThanOrEqual(300);
    }
    // The path a renamed file had counts the same.
    expect(
      assessRisk({ policy: pems, files: [file('a.txt', { status: 'renamed', previousPath: deep })] }).tier,
    ).toBe('high');
    // At the limits themselves a path is matched like any other.
    const edge = Array.from({ length: PATH_LIMITS.segments }, () => 'a').join('/');
    expect(assessRisk({ policy: pems, files: [file(edge)] })).toMatchObject({ tier: 'low' });
    expect(assessRisk({ policy: pems, files: [file(`${edge.slice(0, -1)}x.pem`)] })).toMatchObject({
      tier: 'medium',
    });
    expect(assessRisk({ policy: pems, files: [file('x'.repeat(PATH_LIMITS.length))] }).tier).toBe('low');
  });

  it('stays quick on the paths that once took it half a minute', () => {
    // Fifty rules against three thousand paths of two thousand one-character segments.
    const path = Array.from({ length: 2000 }, () => 'a').join('/');
    const files = Array.from({ length: 3000 }, (_, i) => file(`${path}/${i}.pem`));
    const started = performance.now();
    const risk = assessRisk({ policy: pems, files });
    expect(performance.now() - started).toBeLessThan(1500);
    expect(risk).toMatchObject({ tier: 'high', files: 3000 });
    expect(risk.reasons[0]).toMatchObject({ code: 'path_unassessable', matched: 3000 });
    expect(risk.reasons[0].paths).toHaveLength(20);
  });

  it('lets the event loop through while it works, and comes to the same answer', async () => {
    const secrets = policyOf({
      rules: Array.from({ length: 50 }, (_, i) => ({ pattern: `*secret*x${i}*`, tier: 'medium' })),
    });
    const files = Array.from({ length: 3000 }, (_, i) =>
      file(`services/billing/src/handlers/payments/provider-${i}/webhook-signature-check.test.js`),
    );
    let turns = 0;
    let worst = 0;
    let last = performance.now();
    const timer = setInterval(() => {
      const now = performance.now();
      worst = Math.max(worst, now - last);
      last = now;
      turns++;
    }, 1);
    try {
      const risk = await assessRiskInBatches({ policy: secrets, files });
      expect(risk).toEqual(assessRisk({ policy: secrets, files }));
      expect(risk).toMatchObject({ tier: 'low', files: 3000 });
    } finally {
      clearInterval(timer);
    }
    // Other work got its turns, and never waited long for one.
    expect(turns).toBeGreaterThan(3);
    expect(worst).toBeLessThan(250);
  });

  it('assesses in batches what it assesses at once', async () => {
    const policy = policyOf({
      rules: [{ pattern: '/migrations/', tier: 'high', label: 'Schema' }],
      thresholds: { medium: { files: 2 } },
    });
    const files = [file('migrations/1.sql'), file('src/a.js', { additions: 5 })];
    expect(await assessRiskInBatches({ policy, files })).toEqual(assessRisk({ policy, files }));
    expect(
      await assessRiskInBatches({ policy, files, complete: false, incomplete: 'too_many_files' }),
    ).toEqual(assessRisk({ policy, files, complete: false, incomplete: 'too_many_files' }));
  });
});

describe('the assessment that stands for a revision', () => {
  const policy = policyOf({ rules: [{ pattern: '/db/', tier: 'medium' }] });
  const head = 'a'.repeat(40);
  const stored = {
    headSha: head,
    baseRef: 'main',
    policyHash: policyFingerprint(policy),
    assessment: assessRisk({ policy, files: [file('src/a.js')] }),
    observedAt: '2026-11-10T12:00:00.000Z',
  };

  it('is the stored one for the same head, base branch and policy', () => {
    expect(riskOf(policy, stored, { headSha: head, baseRef: 'main' })).toMatchObject({
      tier: 'low',
      unknown: false,
      assessedAt: '2026-11-10T12:00:00.000Z',
    });
    expect(riskOf(null, stored, { headSha: head })).toBeNull();
  });

  it('is unknown, and so the highest tier, for any other revision or policy', () => {
    for (const [record, revision, why] of [
      [null, { headSha: head, baseRef: 'main' }, 'not_assessed'],
      [stored, { headSha: 'b'.repeat(40), baseRef: 'main' }, 'not_assessed'],
      [stored, { headSha: head, baseRef: 'release' }, 'not_assessed'],
      [stored, { headSha: null }, 'not_assessed'],
      [{ ...stored, policyHash: 'other' }, { headSha: head, baseRef: 'main' }, 'policy_changed'],
    ]) {
      const risk = riskOf(policy, record, revision);
      expect(risk).toMatchObject({ tier: 'high', unknown: true, assessedAt: null });
      expect(risk.reasons[0].why).toBe(why);
    }
  });
});

describe('what the risk makes required of the review', () => {
  const policy = policyOf({ tiers: { high: { requireSecurity: true } } });
  const high = assessRisk({ policy, complete: false });
  const low = assessRisk({ policy, files: [file('a.js')] });

  it('raises an advisory or absent security pass to required on a tier that requires it', () => {
    expect(effectiveSecurityPolicy({ securityReview: 'advisory' }, high)).toEqual({
      policy: 'required',
      raisedBy: 'high',
    });
    expect(effectiveSecurityPolicy({ securityReview: 'off' }, high)).toEqual({
      policy: 'required',
      raisedBy: 'high',
    });
    expect(effectiveSecurityPolicy({}, high)).toEqual({ policy: 'required', raisedBy: 'high' });
  });

  it('never lowers the project’s own policy, and leaves it alone otherwise', () => {
    expect(effectiveSecurityPolicy({ securityReview: 'required' }, low)).toEqual({
      policy: 'required',
      raisedBy: null,
    });
    expect(effectiveSecurityPolicy({ securityReview: 'required' }, high)).toEqual({
      policy: 'required',
      raisedBy: null,
    });
    expect(effectiveSecurityPolicy({ securityReview: 'advisory' }, low)).toEqual({
      policy: 'advisory',
      raisedBy: null,
    });
    expect(effectiveSecurityPolicy({ securityReview: 'off' }, low)).toEqual({
      policy: 'off',
      raisedBy: null,
    });
    expect(effectiveSecurityPolicy({ securityReview: 'advisory' }, null)).toEqual({
      policy: 'advisory',
      raisedBy: null,
    });
  });
});
