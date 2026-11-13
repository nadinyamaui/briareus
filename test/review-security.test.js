import { describe, expect, it, vi } from 'vitest';
import {
  ASSESSMENT_MAX,
  ASSESSMENT_MIN,
  RECORD_BYTES_MAX,
  RECORD_FINDINGS_MAX,
  SECURITY_CATEGORIES,
  SECURITY_POLICIES,
  SECURITY_RESULTS,
  acceptedSecurityRecord,
  computeSecurityResult,
  securityCoverage,
  securityCoverageOf,
  securityPassCompleted,
  securityPolicyOf,
  securityRequirement,
} from '../lib/review-security.js';
import { computeReviewOutcome } from '../lib/review-outcome.js';

const head = 'a'.repeat(40);
const next = 'b'.repeat(40);
const IDS = SECURITY_CATEGORIES.map((c) => c.id);

// The record a security pass writes, every category assessed.
const record = (over = {}) => ({
  head,
  status: 'complete',
  categories: IDS.map((id) => ({
    id,
    applicable: id === 'execution',
    assessment:
      id === 'execution'
        ? 'lib/export.js builds a shell command; traced the filename from the request to spawn().'
        : 'The diff touches only lib/export.js and its test; nothing here reaches this category.',
  })),
  findings: [],
  ...over,
});
const found = (over = {}) => ({
  category: 'execution',
  severity: 'high',
  title: 'Filename reaches the shell unquoted',
  filePath: 'lib/export.js',
  startLine: 12,
  endLine: 14,
  body: 'A name such as `a;id` runs a second command.',
  ...over,
});
const coverage = (findings = []) => securityCoverage(record({ findings }), head);

const stagesAt = (sha, over = {}) =>
  ['discover', 'security', 'publish', 'verify', 'label'].map((stage) => ({
    stage,
    headSha: sha,
    status: 'completed',
    detail: stage === 'security' ? { coverage: coverage() } : null,
    ...(over[stage] || {}),
  }));
const review = (over = {}) => ({ id: 5, status: 'completed', headSha: head, baseRef: 'main', ...over });
// A registered security finding, published as the record's finding of the same number.
const finding = (over = {}) => ({
  id: 1,
  findingRef: 'ref-1',
  title: 'Filename reaches the shell unquoted',
  security: true,
  securityEntry: over.id ?? 1,
  reconciliation: 'new',
  commentId: 501,
  threadId: 'PRRT_1',
  shouldFix: 'optional',
  verification: 'confirmed',
  comments: 'Only reachable by an admin, lib/export.js:12',
  ...over,
});
const result = (input = {}) =>
  computeSecurityResult({ policy: 'required', review: review(), stages: stagesAt(head), ...input });
const codes = (r) => r.reasons.map((reason) => reason.code);

describe('the project’s security policy', () => {
  it('is one of three states, off unless one of the others was set', () => {
    expect(SECURITY_POLICIES).toEqual(['off', 'advisory', 'required']);
    expect(securityPolicyOf({ securityReview: 'advisory' })).toBe('advisory');
    expect(securityPolicyOf({ securityReview: 'required' })).toBe('required');
    for (const project of [
      null,
      {},
      { securityReview: true },
      { securityReview: 'on' },
      { securityReview: '' },
    ])
      expect(securityPolicyOf(project)).toBe('off');
  });
});

describe('the coverage record', () => {
  it('names the risks the issue asks for, each with what it covers', () => {
    expect(IDS).toEqual([
      'permissions',
      'secrets',
      'isolation',
      'execution',
      'untrusted_input',
      'dependencies',
    ]);
    const covers = Object.fromEntries(SECURITY_CATEGORIES.map((c) => [c.id, c.covers]));
    expect(covers.permissions).toMatch(/authorization/);
    expect(covers.secrets).toMatch(/credentials/);
    expect(covers.isolation).toMatch(/tenant isolation/);
    for (const risk of ['shell', 'SQL', 'path traversal', 'SSRF', 'deserialization', 'template'])
      expect(covers.execution).toContain(risk);
    expect(covers.untrusted_input).toMatch(/untrusted input/);
    expect(covers.dependencies).toMatch(/supply chain/);
  });

  it('is kept as the categories assessed, with the findings counted by the server', () => {
    const kept = securityCoverage(
      record({
        findings: [found(), found({ title: 'Another' })],
        // The agent's own counts are not what is kept.
        categories: record().categories.map((c) => ({ ...c, findings: 99, extra: 'ignored' })),
        widened: '  Followed the helper into lib/files.js.  ',
      }),
      head,
    );
    expect(kept.findings).toBe(2);
    expect(kept.widened).toBe('Followed the helper into lib/files.js.');
    expect(kept.categories.map((c) => [c.id, c.applicable, c.findings])).toEqual([
      ['permissions', false, 0],
      ['secrets', false, 0],
      ['isolation', false, 0],
      ['execution', true, 2],
      ['untrusted_input', false, 0],
      ['dependencies', false, 0],
    ]);
    expect(Object.keys(kept.categories[0])).toEqual(['id', 'applicable', 'assessment', 'findings']);
    expect(kept.categories[3].assessment).toContain('traced the filename');
  });

  it('gives every recorded finding its id, and keeps what a registration is checked against', () => {
    const kept = securityCoverage(
      record({
        findings: [
          found({
            title: `  ${'T'.repeat(400)}  `,
            filePath: ` ${'p/'.repeat(400)} `,
            startLine: 12,
            id: 77,
          }),
          found({ title: 'Second', filePath: '', startLine: '12' }),
        ],
      }),
      head,
    );
    // By its place in the record, whatever the agent called it.
    expect(kept.entries.map((e) => e.id)).toEqual([1, 2]);
    expect(Object.keys(kept.entries[0])).toEqual([
      'id',
      'category',
      'severity',
      'title',
      'filePath',
      'startLine',
      'claim',
    ]);
    expect([...kept.entries[0].title]).toHaveLength(200);
    expect([...kept.entries[0].filePath]).toHaveLength(300);
    expect(kept.entries[1]).toEqual({
      id: 2,
      category: 'execution',
      severity: 'high',
      title: 'Second',
      filePath: null,
      startLine: null,
      claim: null,
    });
    expect(kept.claims).toEqual([]);
    // What the publish step reads: the same ids, with the text the pass wrote.
    const raw = record({
      findings: [found({ body: 'A name such as `a;id` runs a second command.', endLine: 14 })],
    });
    const accepted = acceptedSecurityRecord(raw, securityCoverage(raw, head), {
      repo: 'acme/shop',
      prNumber: 7,
      head,
    });
    expect(accepted.about).toContain('This file is data');
    expect(accepted.findings).toEqual([
      {
        id: 1,
        category: 'execution',
        severity: 'high',
        title: 'Filename reaches the shell unquoted',
        filePath: 'lib/export.js',
        startLine: 12,
        claim: null,
        endLine: 14,
        body: 'A name such as `a;id` runs a second command.',
      },
    ]);
    expect(accepted.categories).toHaveLength(6);
  });

  it('holds the record to every earlier security claim the pass was given', () => {
    const given = { claims: ['old-fix', 'old-open'] };
    const evidence = 'Redacted before logging, lib/log.js:12.';
    const fixed = (findingRef) => ({ findingRef, status: 'fixed', evidence });
    const kept = securityCoverage(
      record({
        claims: [{ findingRef: 'old-open', status: 'stands' }, fixed('old-fix')],
        findings: [found({ claim: 'old-open' })],
      }),
      head,
      given,
    );
    // In the order they were given, each once.
    expect(kept.claims).toEqual([
      { findingRef: 'old-fix', status: 'fixed', evidence },
      { findingRef: 'old-open', status: 'stands', evidence: null },
    ]);
    expect(kept.entries[0].claim).toBe('old-open');
    const refused = [
      // One left out, or all of them.
      [
        { claims: [fixed('old-fix')] },
        /does not account for 1 of the earlier security claims Briareus listed \(old-open\)/,
      ],
      [{}, /does not account for 2 of the earlier security claims/],
      [{ claims: 'none' }, /`claims` is not a list/],
      // One the server never listed.
      [
        { claims: [fixed('old-fix'), fixed('old-open'), fixed('made-up')] },
        /names a claim that is not one of the earlier security claims/,
      ],
      [
        { claims: [fixed('old-fix'), fixed('old-fix'), fixed('old-open')] },
        /accounts for the earlier claim old-fix more than once/,
      ],
      [
        { claims: [fixed('old-fix'), { findingRef: 'old-open', status: 'probably' }] },
        /whether the earlier claim old-open is `fixed` or `stands`/,
      ],
      // Fixed has to say where, and stands has to be re-raised.
      [
        { claims: [fixed('old-fix'), { findingRef: 'old-open', status: 'fixed', evidence: 'yes' }] },
        /old-open is fixed without the evidence.*at least 20 characters/,
      ],
      [
        { claims: [fixed('old-fix'), { findingRef: 'old-open', status: 'stands' }] },
        /old-open still stands and lists no finding with that `claim`/,
      ],
      [
        { claims: [fixed('old-fix'), fixed('old-open')], findings: [found({ claim: 'old-open' })] },
        /old-open is fixed and lists a finding that re-raises it/,
      ],
      [
        { claims: [fixed('old-fix'), fixed('old-open')], findings: [found({ claim: 'made-up' })] },
        /names a `claim` that is not one of the earlier/,
      ],
    ];
    for (const [over, why] of refused) expect(() => securityCoverage(record(over), head, given)).toThrow(why);
    // With no claim given, a record that names one is refused, and one without any is fine.
    expect(() => securityCoverage(record({ claims: [fixed('old-fix')] }), head)).toThrow(
      /names a claim that is not/,
    );
    expect(securityCoverage(record({ claims: [] }), head).claims).toEqual([]);
  });

  it('says which rule a refused record broke, and whether asking again could help', () => {
    const tooShort = record({
      categories: record().categories.map((c) =>
        c.id === 'secrets' ? { ...c, assessment: 'Docs-only change.' } : c,
      ),
    });
    let refusal;
    try {
      securityCoverage(tooShort, head);
    } catch (e) {
      refusal = e;
    }
    // The rule is in the refusal, so the one correction can state it.
    expect(refusal.message).toBe(
      'The security record gives no assessment of the secrets category: why it does not apply has to be said, in at least 20 characters',
    );
    expect(refusal.blocked).toBeUndefined();
    // A pass that says it could not do its work is not asked for its record again.
    try {
      securityCoverage(record({ status: 'blocked', blocker: 'No diff' }), head);
    } catch (e) {
      refusal = e;
    }
    expect(refusal).toMatchObject({
      blocked: true,
      message: 'The security pass reported itself blocked: No diff',
    });
    expect(RECORD_FINDINGS_MAX).toBe(100);
    expect(RECORD_BYTES_MAX).toBe(1024 * 1024);
  });

  it('never works over more of an agent’s text than it can keep', () => {
    // A record is capped before it is parsed (lib/jobs.js); what is in it is cut without
    // first spreading megabytes into an array of characters.
    const seen = [];
    const original = String.prototype.toWellFormed;
    const spy = vi.spyOn(String.prototype, 'toWellFormed').mockImplementation(function () {
      seen.push(this.length);
      return original.call(this);
    });
    try {
      const huge = 'x'.repeat(3 * 1024 * 1024);
      const kept = securityCoverage(
        record({
          categories: record().categories.map((c) => ({ ...c, assessment: huge })),
          findings: [found({ title: huge, filePath: huge })],
          widened: huge,
        }),
        head,
      );
      expect([...kept.widened]).toHaveLength(ASSESSMENT_MAX);
      expect([...kept.entries[0].title]).toHaveLength(200);
    } finally {
      spy.mockRestore();
    }
    expect(seen.length).toBeGreaterThan(0);
    expect(Math.max(...seen)).toBeLessThanOrEqual(ASSESSMENT_MAX * 2 + 2);
  });

  it('accepts a pass that found nothing only with every category assessed', () => {
    expect(coverage()).toMatchObject({ findings: 0, widened: null });
    // Zero findings and nothing else is not a record.
    expect(() => securityCoverage({ head, status: 'complete', findings: [] }, head)).toThrow(
      /needs its categories and its findings/,
    );
    expect(() => securityCoverage(record({ categories: [] }), head)).toThrow(
      'does not assess the permissions category',
    );
    const without = (id) => record({ categories: record().categories.filter((c) => c.id !== id) });
    expect(() => securityCoverage(without('dependencies'), head)).toThrow(
      'does not assess the dependencies category',
    );
  });

  it('refuses a record that does not establish that the pass looked', () => {
    const withCategory = (id, change) =>
      record({ categories: record().categories.map((c) => (c.id === id ? { ...c, ...change } : c)) });
    const refused = [
      [null, /not a JSON object/],
      [[], /not a JSON object/],
      ['complete', /not a JSON object/],
      [record({ head: next }), /names a different one/],
      [record({ head: undefined }), /missing its head/],
      [record({ status: 'blocked', blocker: 'No access to the diff' }), /blocked: No access to the diff/],
      [record({ status: 'blocked' }), /blocked: no details given/],
      // A blocker beside a "complete" status is still a blocker.
      [record({ blocker: 'Half of it' }), /blocked: Half of it/],
      [record({ status: 'done' }), /does not say the pass is complete/],
      [record({ findings: undefined }), /needs its categories and its findings/],
      [withCategory('secrets', { applicable: 'no' }), /whether the secrets category applies/],
      // "Not applicable" has to be justified, and an assessment has to say something.
      [
        withCategory('secrets', { assessment: '' }),
        /no assessment of the secrets category: why it does not apply/,
      ],
      [withCategory('secrets', { assessment: 'n/a' }), /no assessment of the secrets category/],
      [
        withCategory('execution', { assessment: '   ' }),
        /no assessment of the execution category: what was examined/,
      ],
      [
        record({ categories: [...record().categories, record().categories[0]] }),
        /assesses the permissions category more than once/,
      ],
      [record({ findings: [found({ category: 'style' })] }), /names no category/],
      [
        record({ findings: [found({ severity: 'blocker' })] }),
        /lacks its severity \(one of critical, high, medium, low\) or its title/,
      ],
      [
        record({ findings: [found({ title: ' ' })] }),
        /lacks its severity \(one of critical, high, medium, low\) or its title/,
      ],
      [record({ findings: [null] }), /names no category/],
      // A finding under a category the record says the change does not touch.
      [
        record({ findings: [found({ category: 'secrets' })] }),
        /under secrets, which it records as not applicable/,
      ],
      [record({ findings: Array.from({ length: 101 }, () => found()) }), /more than 100 findings/],
    ];
    for (const [bad, why] of refused) expect(() => securityCoverage(bad, head)).toThrow(why);
    expect(() => securityCoverage(record(), '')).toThrow(/missing its head/);
    expect('n/a'.length).toBeLessThan(ASSESSMENT_MIN);
  });

  it('clips what the agent wrote and never keeps half a character', () => {
    const long = `${'x'.repeat(ASSESSMENT_MAX - 2)}😀😀😀`;
    const kept = securityCoverage(
      record({
        categories: record().categories.map((c) => (c.id === 'secrets' ? { ...c, assessment: long } : c)),
      }),
      head,
    );
    const assessment = kept.categories.find((c) => c.id === 'secrets').assessment;
    expect([...assessment]).toHaveLength(ASSESSMENT_MAX);
    // Every category at its longest, in the widest characters, still fits the stage
    // row's TEXT detail it is kept in.
    const widest = securityCoverage(
      record({
        categories: record().categories.map((c) => ({ ...c, assessment: '😀'.repeat(5000) })),
        widened: '😀'.repeat(5000),
      }),
      head,
    );
    expect(Buffer.byteLength(JSON.stringify({ coverage: widest }))).toBeLessThan(65535);
    expect(assessment.isWellFormed()).toBe(true);
    expect(assessment.endsWith('…')).toBe(true);
  });

  it('says whether a review has a completed pass behind it', () => {
    expect(securityPassCompleted(stagesAt(head), head)).toBe(true);
    expect(securityPassCompleted(stagesAt(head), next)).toBe(false);
    expect(securityPassCompleted(stagesAt(head), null)).toBe(false);
    expect(securityPassCompleted([], head)).toBe(false);
    expect(
      securityPassCompleted(
        stagesAt(head).filter((s) => s.stage !== 'security'),
        head,
      ),
    ).toBe(false);
    for (const status of ['pending', 'running', 'failed'])
      expect(securityPassCompleted(stagesAt(head, { security: { status } }), head)).toBe(false);
    // Completed by name only: the coverage is what a completed pass is.
    expect(securityPassCompleted(stagesAt(head, { security: { detail: null } }), head)).toBe(false);
  });
});

describe('the security result', () => {
  it('has its own values', () => {
    expect(SECURITY_RESULTS).toEqual([
      'not_required',
      'not_run',
      'pending',
      'incomplete',
      'failed',
      'passed',
    ]);
  });

  it('is not required where no pass was asked for and none ran', () => {
    const withoutPass = stagesAt(head).filter((s) => s.stage !== 'security');
    for (const input of [
      { policy: 'off', stages: withoutPass },
      { policy: 'off', review: null, stages: [] },
      { policy: 'off', stages: [], review: review({ status: 'running' }) },
      { policy: 'off', stages: withoutPass, current: { headSha: next } },
      // An unknown policy is no policy.
      { policy: 'sometimes', stages: withoutPass },
      { policy: undefined, stages: withoutPass },
    ]) {
      const r = result(input);
      expect(r).toMatchObject({ result: 'not_required', policy: 'off', blocking: false, stale: false });
      expect(r.reasons).toEqual([]);
      expect(r.stage).toBeNull();
      expect(r.coverage).toBeNull();
    }
  });

  it('reports no required pass for an off policy when the stage never ran', () => {
    for (const status of ['completed', 'failed', 'running']) {
      const r = result({
        policy: 'off',
        review: review({ status }),
        stages: stagesAt(head, { security: { status: 'pending', headSha: null, detail: null } }),
      });
      expect(r).toMatchObject({ result: 'not_required', blocking: false, stage: 'pending', coverage: null });
      expect(r.reasons).toEqual([]);
    }
    for (const policy of ['advisory', 'required']) {
      const r = result({ policy, stages: stagesAt(head, { security: { status: 'pending', detail: null } }) });
      expect(r.result).toBe('incomplete');
      expect(codes(r)).toEqual(['stage_not_run']);
    }
  });

  it('is not run, never passed, when the policy asks for a pass the review ran without', () => {
    const withoutPass = stagesAt(head).filter((s) => s.stage !== 'security');
    for (const policy of ['advisory', 'required']) {
      // A review from before security passes existed has no stage rows at all.
      for (const stages of [withoutPass, []]) {
        const r = result({ policy, stages });
        expect(r.result).toBe('not_run');
        expect(codes(r)).toEqual(['security_not_run']);
        expect(r.reasons[0].message).toBe(
          'The review of aaaaaaa ran without a security pass: the project did not ask for one when it started, or it predates security reviews. Run the review again.',
        );
        expect(r.blocking).toBe(policy === 'required');
        expect(r.stage).toBeNull();
      }
      // Also while that review still runs: it is not going to run one.
      expect(result({ policy, stages: withoutPass, review: review({ status: 'running' }) }).result).toBe(
        'not_run',
      );
    }
  });

  it('is pending while there is nothing to judge', () => {
    const none = result({ review: null, stages: [] });
    expect(none).toMatchObject({ result: 'pending', stale: false, blocking: true, headSha: null });
    expect(codes(none)).toEqual(['no_review']);
    const running = result({
      review: review({ status: 'running' }),
      stages: stagesAt(head, { security: { status: 'running', detail: null } }),
    });
    expect(running).toMatchObject({ result: 'pending', stale: false, stage: 'running' });
    expect(codes(running)).toEqual(['review_running']);
    // A review still running whose pass already failed is still pending until it ends.
    expect(
      result({
        review: review({ status: 'running' }),
        stages: stagesAt(head, { security: { status: 'failed', detail: { error: 'x' } } }),
      }).result,
    ).toBe('pending');
  });

  it('carries over, not stale, to a rebase of what the pass read', () => {
    const rebased = { headSha: next, baseRef: 'main' };
    const carried = result({ current: rebased, carried: rebased });
    expect(carried).toMatchObject({ result: 'passed', stale: false, headSha: head });
    expect(carried.reasons.at(-1)).toMatchObject({ code: 'carried_over', effect: 'note' });
    expect(carried.reasons.at(-1).message).toContain('the security pass covered aaaaaaa');
    expect(result({ current: { headSha: 'c'.repeat(40), baseRef: 'main' }, carried: rebased }).stale).toBe(
      true,
    );
  });

  it('goes stale, and pending, when the head moves or the base branch changes', () => {
    const moved = result({ current: { headSha: next, baseRef: 'main' } });
    expect(moved).toMatchObject({ result: 'pending', stale: true, headSha: head });
    expect(codes(moved)).toEqual(['head_moved']);
    expect(moved.reasons[0].message).toBe(
      'The pull request head is bbbbbbb; the security pass covered aaaaaaa.',
    );
    const retargeted = result({ current: { headSha: head, baseRef: 'release' } });
    expect(retargeted).toMatchObject({ result: 'pending', stale: true });
    expect(codes(retargeted)).toEqual(['base_changed']);
    expect(retargeted.reasons[0].message).toBe(
      'The pull request now targets release; the security pass was against main.',
    );
    // The same revision is not stale, and neither is an unknown one.
    expect(result({ current: { headSha: head, baseRef: 'main' } })).toMatchObject({
      result: 'passed',
      stale: false,
    });
    expect(result({ current: null }).result).toBe('passed');
    // A pass that had passed is not passed on another head, even for a failed one.
    expect(result({ findings: [finding({ shouldFix: 'fix' })], current: { headSha: next } }).result).toBe(
      'pending',
    );
  });

  it('passes on a completed pass with its coverage and nothing left open', () => {
    const clean = result();
    expect(clean).toMatchObject({
      policy: 'required',
      result: 'passed',
      blocking: false,
      stale: false,
      reasons: [],
      reviewId: 5,
      headSha: head,
      stage: 'completed',
      counts: { findings: 0, fix: 0, optional: 0, dismissed: 0, suppressed: 0, unverified: 0 },
    });
    expect(clean.coverage.categories).toHaveLength(6);
    // Verified Optional and Dismissed findings alone pass.
    const settled = result({
      stages: stagesAt(head, { security: { detail: { coverage: coverage([found(), found(), found()]) } } }),
      findings: [
        finding({ id: 1, findingRef: 'r1', shouldFix: 'optional', verification: 'plausible' }),
        finding({ id: 2, findingRef: 'r2', shouldFix: 'dismiss', verification: 'confirmed' }),
        finding({
          id: 3,
          findingRef: 'r3',
          reconciliation: 'suppressed',
          commentId: null,
          threadId: null,
          shouldFix: 'dismiss',
        }),
      ],
      standing: { fix: [], unverified: [], settled: ['r3'] },
    });
    expect(settled.result).toBe('passed');
    expect(settled.counts).toEqual({
      findings: 3,
      fix: 0,
      optional: 1,
      dismissed: 1,
      suppressed: 1,
      unverified: 0,
    });
  });

  it('is incomplete when the pass itself did not complete, whatever it found', () => {
    const cases = [
      [
        { security: { status: 'pending', detail: null } },
        'stage_not_run',
        'The security pass did not run for aaaaaaa.',
      ],
      [
        {
          security: {
            status: 'failed',
            detail: { error: 'The security pass left no record, or one that is not JSON' },
          },
        },
        'stage_failed',
        'The security pass failed: The security pass left no record, or one that is not JSON',
      ],
      [{ security: { status: 'failed', detail: null } }, 'stage_failed', 'The security pass failed.'],
      // Still "running" on a review that ended: stopped, or cut off by a restart.
      [
        { security: { status: 'running', detail: null } },
        'stage_interrupted',
        'The security pass was interrupted before it finished.',
      ],
      // A record for another head completes nothing.
      [{ security: { headSha: next } }, 'stage_not_run', 'The security pass did not run for aaaaaaa.'],
      // Completed with nothing to show for it: zero findings is not completion.
      [
        { security: { detail: null } },
        'coverage_missing',
        'The security pass left no coverage record for aaaaaaa, so it does not show what it looked at.',
      ],
      [{ security: { detail: { coverage: { categories: [], findings: 0 } } } }, 'coverage_missing', null],
      [
        { security: { detail: { coverage: { ...coverage(), categories: coverage().categories.slice(1) } } } },
        'coverage_missing',
        null,
      ],
    ];
    for (const [over, code, message] of cases) {
      const r = result({ stages: stagesAt(head, over) });
      expect(r.result, code).toBe('incomplete');
      expect(codes(r)).toEqual([code]);
      expect(r.reasons[0]).toMatchObject({ effect: 'incomplete', stage: 'security' });
      if (message) expect(r.reasons[0].message).toBe(message);
      expect(r.blocking).toBe(true);
    }
  });

  it('holds security findings to the evidence rule of the outcome', () => {
    const one = (over) =>
      result({
        stages: stagesAt(head, { security: { detail: { coverage: coverage([found()]) } } }),
        findings: [finding(over)],
      });
    // A required fix fails the pass, confirmed or not.
    for (const verification of ['confirmed', 'plausible', null]) {
      const failed = one({ shouldFix: 'fix', verification });
      expect(failed.result).toBe('failed');
      expect(failed.reasons).toEqual([
        expect.objectContaining({
          code: 'fix_required',
          effect: 'failed',
          findingId: 1,
          findingRef: 'ref-1',
        }),
      ]);
      expect(failed.counts.fix).toBe(1);
    }
    // Unverified, and dismissed without proof, are incomplete.
    expect(codes(one({ shouldFix: null }))).toEqual(['finding_without_verdict']);
    expect(codes(one({ shouldFix: 'optional', verification: null }))).toEqual(['finding_unverified']);
    expect(codes(one({ shouldFix: 'optional', comments: null }))).toEqual(['finding_unverified']);
    expect(codes(one({ shouldFix: 'dismiss', verification: 'plausible' }))).toEqual(['dismissal_unproven']);
    expect(codes(one({ shouldFix: 'dismiss', verification: 'confirmed', comments: '' }))).toEqual([
      'finding_unverified',
    ]);
    for (const over of [
      { shouldFix: null },
      { shouldFix: 'optional', verification: null },
      { shouldFix: 'dismiss', verification: 'plausible' },
    ]) {
      expect(one(over).result).toBe('incomplete');
      expect(one(over).reasons[0].effect).toBe('incomplete');
    }
    // Registered as posted and never found on the pull request.
    expect(codes(one({ threadId: null }))).toEqual(['finding_unlinked']);
    // A suppressed duplicate rests on a decision that is itself established.
    const suppressed = {
      reconciliation: 'suppressed',
      commentId: null,
      threadId: null,
      shouldFix: 'dismiss',
    };
    expect(codes(one(suppressed))).toEqual(['prior_decision_unverified']);
    // Incomplete outranks failed, and every reason is listed.
    const both = result({
      stages: stagesAt(head, { security: { detail: { coverage: coverage([found(), found()]) } } }),
      findings: [finding({ shouldFix: 'fix' }), finding({ id: 2, findingRef: 'ref-2', shouldFix: null })],
    });
    expect(both.result).toBe('incomplete');
    expect(codes(both)).toEqual(['fix_required', 'finding_without_verdict']);
  });

  it('judges only the findings and claims the server marked', () => {
    const unmarked = finding({
      id: 2,
      findingRef: 'ref-2',
      security: false,
      shouldFix: 'fix',
      title: 'Off by one',
    });
    const typed = finding({ id: 3, findingRef: 'ref-3', security: false, type: 'security', shouldFix: null });
    const r = result({
      findings: [unmarked, typed],
      standing: {
        fix: [{ findingRef: 'old-1', title: 'General fix owed' }],
        unverified: [{ findingRef: 'old-2', title: 'General claim' }],
      },
    });
    // The free-text type is not the mark, and a general fix is the outcome's to count.
    expect(r).toMatchObject({ result: 'passed', reasons: [] });
    expect(r.counts.findings).toBe(0);
  });

  it('counts what earlier rounds left on a security claim', () => {
    const owed = result({
      standing: {
        fix: [
          { findingRef: 'old-1', title: 'Token logged', threadId: 'PRRT_9', security: true },
          { findingRef: 'old-2', title: 'General fix owed' },
        ],
        unverified: [],
      },
    });
    expect(owed.result).toBe('failed');
    expect(owed.reasons).toEqual([
      expect.objectContaining({
        code: 'fix_owed',
        effect: 'failed',
        findingRef: 'old-1',
        message: '"Token logged" is a required fix still owed from an earlier review.',
      }),
    ]);
    const unproven = result({
      standing: {
        fix: [],
        unverified: [
          {
            findingRef: 'old-3',
            title: 'SSRF',
            verdict: 'dismiss',
            missing: ['verification'],
            security: true,
          },
        ],
      },
    });
    expect(unproven.result).toBe('incomplete');
    expect(codes(unproven)).toEqual(['earlier_finding_unverified']);
    // This review answering for the claim lists it once.
    const answered = result({
      stages: stagesAt(head, { security: { detail: { coverage: coverage([found()]) } } }),
      findings: [finding({ findingRef: 'old-1', shouldFix: 'fix' })],
      standing: { fix: [{ findingRef: 'old-1', title: 'Token logged', security: true }], unverified: [] },
    });
    expect(codes(answered)).toEqual(['fix_required']);
  });

  it('is incomplete until what the pass recorded reached the pull request', () => {
    const recorded = {
      security: {
        detail: { coverage: coverage([found(), found({ title: 'Path is not checked' }), found()]) },
      },
    };
    const missing = result({ stages: stagesAt(head, recorded), findings: [finding()] });
    expect(missing.result).toBe('incomplete');
    expect(missing.reasons).toEqual([
      {
        code: 'findings_missing',
        effect: 'incomplete',
        stage: 'security',
        message:
          'The security pass recorded 3 finding(s), and 2 of them were not registered: #2 "Path is not checked", #3 "Filename reaches the shell unquoted".',
        recorded: 3,
        registered: 1,
        entries: [
          { id: 2, title: 'Path is not checked' },
          { id: 3, title: 'Filename reaches the shell unquoted' },
        ],
      },
    ]);
    for (const status of ['pending', 'running', 'failed']) {
      const unpublished = result({
        stages: stagesAt(head, { ...recorded, publish: { status } }),
        findings: [],
      });
      expect(unpublished.result).toBe('incomplete');
      expect(unpublished.reasons).toEqual([
        {
          code: 'findings_unpublished',
          effect: 'incomplete',
          stage: 'security',
          message: 'The security pass recorded 3 finding(s), and the review’s publish step did not complete.',
          recorded: 3,
        },
      ]);
    }
    // All of them registered, the report's own security findings beside them: fine.
    const all = result({
      stages: stagesAt(head, recorded),
      findings: [
        ...[1, 2, 3].map((id) => finding({ id, findingRef: `r${id}` })),
        finding({ id: 4, findingRef: 'r4', securityEntry: null }),
      ],
    });
    expect(all).toMatchObject({ result: 'passed', counts: { findings: 4, optional: 4 } });
  });

  it('does not pass a pass that found nothing when the review never published', () => {
    // The pass looked and recorded no finding, and publication then failed, stopped or
    // never started: nobody was told anything, and the result does not say passed.
    for (const status of ['pending', 'running', 'failed']) {
      const r = result({ stages: stagesAt(head, { publish: { status } }) });
      expect(r.result, status).toBe('incomplete');
      expect(r.reasons).toEqual([
        {
          code: 'publication_incomplete',
          effect: 'incomplete',
          stage: 'security',
          message:
            'The review’s publish step did not complete, so what its security pass amounts to was never published.',
          recorded: 0,
        },
      ]);
      expect(r.blocking).toBe(true);
    }
    // A publish step recorded for another head published nothing of this one either.
    expect(result({ stages: stagesAt(head, { publish: { headSha: next } }) }).result).toBe('incomplete');
    expect(result({ stages: stagesAt(head).filter((s) => s.stage !== 'publish') }).result).toBe('incomplete');
    expect(result().result).toBe('passed');
  });

  describe('each finding of the record, accounted for by the registration that names it', () => {
    const one = { security: { detail: { coverage: coverage([found({ title: 'New critical defect' })]) } } };
    const withFindings = (findings, standing) =>
      result({ stages: stagesAt(head, one), findings, ...(standing ? { standing } : {}) });

    it('is not satisfied by a mark another finding inherited', () => {
      // The recorded finding was never registered. A finding of the provider's report was
      // registered as suppressed against an earlier dismissed security claim, and carries
      // that claim's mark: one marked finding, one recorded finding, and nothing published.
      const inherited = finding({
        id: 7,
        findingRef: 'old-dismissed',
        securityEntry: null,
        reconciliation: 'suppressed',
        commentId: null,
        threadId: null,
        shouldFix: 'dismiss',
      });
      const r = withFindings([inherited], { fix: [], unverified: [], settled: ['old-dismissed'] });
      expect(r.result).toBe('incomplete');
      expect(r.reasons).toEqual([
        expect.objectContaining({
          code: 'findings_missing',
          recorded: 1,
          registered: 0,
          entries: [{ id: 1, title: 'New critical defect' }],
        }),
      ]);
      // So the outcome of a project that requires the pass cannot pass on it.
      const outcome = computeReviewOutcome({
        review: review(),
        stages: stagesAt(head, one),
        findings: [inherited],
        standing: { fix: [], unverified: [], settled: ['old-dismissed'] },
        requirements: [securityRequirement(r)],
      });
      expect(outcome.outcome).toBe('incomplete');
      expect(outcome.reasons.map((reason) => reason.requirement)).toEqual(['security']);
    });

    it('is not satisfied by a finding marked security that names no finding of the record', () => {
      const nit = finding({ id: 8, findingRef: 'nit', securityEntry: null, title: 'Unrelated nit' });
      const r = withFindings([nit]);
      expect(r.result).toBe('incomplete');
      expect(codes(r)).toEqual(['findings_missing']);
      // It is a security finding all the same: counted, and held to the evidence rule.
      expect(r.counts).toMatchObject({ findings: 1, optional: 1 });
      const fix = withFindings([finding({ id: 1 }), { ...nit, shouldFix: 'fix' }]);
      expect(fix.result).toBe('failed');
      expect(codes(fix)).toEqual(['fix_required']);
    });

    it('is not satisfied by a registration that names another finding of the record', () => {
      const two = { security: { detail: { coverage: coverage([found(), found({ title: 'Second' })]) } } };
      const r = result({
        stages: stagesAt(head, two),
        // Two marked findings, both published as the first.
        findings: [finding({ id: 1 }), finding({ id: 2, findingRef: 'r2', securityEntry: 1 })],
      });
      expect(r.result).toBe('incomplete');
      expect(r.reasons[0]).toMatchObject({
        code: 'findings_missing',
        registered: 1,
        entries: [{ id: 2, title: 'Second' }],
      });
      // An entry the record does not have accounts for nothing either.
      expect(withFindings([finding({ securityEntry: 9 })]).result).toBe('incomplete');
    });

    it('is satisfied by its own registration, however that was reconciled', () => {
      for (const reconciliation of ['new', 'adopted', 'revisit'])
        expect(withFindings([finding({ reconciliation })]).result, reconciliation).toBe('passed');
      const suppressed = finding({
        findingRef: 'old-1',
        reconciliation: 'suppressed',
        commentId: null,
        threadId: null,
        shouldFix: 'dismiss',
      });
      // Suppressed against a decision that is itself established: accounted for and cleared.
      expect(withFindings([suppressed], { fix: [], unverified: [], settled: ['old-1'] })).toMatchObject({
        result: 'passed',
        counts: { suppressed: 1 },
      });
      // Against one that was never proven: accounted for, and not cleared.
      const unproven = withFindings([suppressed], {
        fix: [],
        unverified: [{ findingRef: 'old-1', security: true, verdict: 'dismiss', missing: ['verification'] }],
      });
      expect(unproven.result).toBe('incomplete');
      expect(codes(unproven)).toEqual(['prior_decision_unverified']);
    });

    it('needs the ids the server gave: a coverage without them is no coverage', () => {
      const { entries: _entries, ...counted } = coverage([found()]);
      for (const kept of [
        counted,
        { ...counted, entries: [] },
        { ...counted, entries: [{ id: 0, title: 'x' }] },
        { ...coverage([found(), found()]), entries: [{ id: 1 }, { id: 1 }] },
      ]) {
        const stages = stagesAt(head, { security: { detail: { coverage: kept } } });
        expect(codes(result({ stages, findings: [finding()] }))).toEqual(['coverage_missing']);
        expect(securityCoverageOf(stages, head)).toBeNull();
      }
    });
  });

  describe('a security fix whose thread was resolved', () => {
    const claim = { findingRef: 'old-fix', title: 'Token logged', threadId: 'PRRT_9', security: true };
    const checked = (claims, findings = []) =>
      stagesAt(head, {
        security: {
          detail: { coverage: securityCoverage(record({ claims, findings }), head, { claims: ['old-fix'] }) },
        },
      });
    const fixed = [
      { findingRef: 'old-fix', status: 'fixed', evidence: 'Redacted before logging, lib/log.js:12.' },
    ];

    it('is not settled by the thread: the pass has to confirm the fix in the code it reviewed', () => {
      // The author resolved the thread and pushed; this round's pass was clean and never
      // looked at the claim.
      const r = result({ addressed: [claim] });
      expect(r.result).toBe('incomplete');
      expect(r.reasons).toEqual([
        {
          code: 'security_fix_unchecked',
          effect: 'incomplete',
          stage: 'security',
          message:
            '"Token logged" was a required fix whose thread was resolved, and the security pass of this review did not confirm the fix in the code it reviewed.',
          findingRef: 'old-fix',
          threadId: 'PRRT_9',
          title: 'Token logged',
        },
      ]);
      expect(r.blocking).toBe(true);
      expect(securityRequirement(r)).toMatchObject({ id: 'security', outcome: 'incomplete' });
    });

    it('is settled once the record says where the fix is', () => {
      const r = result({ stages: checked(fixed), addressed: [claim] });
      expect(r).toMatchObject({ result: 'passed', reasons: [] });
      expect(r.coverage.claims).toEqual(fixed);
      // Another claim's check does not cover this one.
      const other = { ...claim, findingRef: 'old-other', title: 'Key in the URL' };
      expect(codes(result({ stages: checked(fixed), addressed: [claim, other] }))).toEqual([
        'security_fix_unchecked',
      ]);
    });

    it('stays open when the pass found it standing and nothing reopened it', () => {
      const stands = [{ findingRef: 'old-fix', status: 'stands' }];
      const reraise = [found({ title: 'Token logged again', claim: 'old-fix' })];
      const stages = checked(stands, reraise);
      // The record's finding was registered as a new claim: the old one still reads as addressed.
      const elsewhere = result({
        stages,
        findings: [finding({ findingRef: 'new-ref' })],
        addressed: [claim],
      });
      expect(elsewhere.result).toBe('incomplete');
      expect(elsewhere.reasons.map((r) => [r.code, r.message])).toEqual([
        [
          'security_fix_unchecked',
          '"Token logged" was a required fix whose thread was resolved, the security pass found it still standing, and no finding of this review reopened it.',
        ],
      ]);
      // Reopened as the claim it is, the finding answers for it.
      for (const reconciliation of ['revisit', 'adopted']) {
        const reopened = result({
          stages,
          findings: [finding({ findingRef: 'old-fix', reconciliation, shouldFix: 'fix' })],
          addressed: [claim],
        });
        expect(reopened.result).toBe('failed');
        expect(codes(reopened)).toEqual(['fix_required']);
      }
      // A suppressed duplicate only repeats the claim: it confirms nothing.
      const repeated = result({
        stages,
        findings: [
          finding({
            findingRef: 'old-fix',
            reconciliation: 'suppressed',
            commentId: null,
            threadId: null,
            shouldFix: 'dismiss',
          }),
        ],
        standing: { fix: [], unverified: [], settled: ['old-fix'] },
        addressed: [claim],
      });
      expect(codes(repeated)).toEqual(['security_fix_unchecked']);
    });

    it('is the pull request’s to answer, not one stored review’s own reading', () => {
      expect(result({ own: true, addressed: [claim] }).result).toBe('passed');
    });
  });

  it('is judged on its evidence whatever the policy is, and blocks only when required', () => {
    const failing = {
      stages: stagesAt(head, { security: { detail: { coverage: coverage([found()]) } } }),
      findings: [finding({ shouldFix: 'fix' })],
    };
    const interrupted = { stages: stagesAt(head, { security: { status: 'running', detail: null } }) };
    for (const [input, expected] of [
      [failing, 'failed'],
      [interrupted, 'incomplete'],
      [{}, 'passed'],
    ]) {
      for (const policy of ['off', 'advisory', 'required']) {
        const r = result({ ...input, policy });
        expect(r.result).toBe(expected);
        expect(r.policy).toBe(policy);
        expect(r.blocking).toBe(policy === 'required' && expected !== 'passed');
      }
    }
  });

  it('reads the label step’s moment without the review having ended', () => {
    const running = review({ status: 'running' });
    const stages = stagesAt(head, { label: { status: 'pending' } });
    expect(result({ review: running, stages }).result).toBe('pending');
    expect(result({ review: running, stages, provisional: true }).result).toBe('passed');
    expect(
      result({
        review: running,
        stages: stagesAt(head, {
          label: { status: 'pending' },
          security: { status: 'failed', detail: { error: 'x' } },
        }),
        provisional: true,
      }).result,
    ).toBe('incomplete');
  });

  it('reads one stored review by itself: no staleness, and no other round’s claims', () => {
    const own = result({
      own: true,
      current: { headSha: next, baseRef: 'release' },
      standing: {
        fix: [{ findingRef: 'old-1', title: 'Token logged', security: true }],
        unverified: [{ findingRef: 'old-2', title: 'SSRF', security: true }],
      },
    });
    expect(own).toMatchObject({ result: 'passed', stale: false, reasons: [] });
    // Its own findings still count, and a suppressed one still rests on the claim.
    const failed = result({
      own: true,
      stages: stagesAt(head, { security: { detail: { coverage: coverage([found()]) } } }),
      findings: [finding({ shouldFix: 'fix' })],
    });
    expect(failed.result).toBe('failed');
    const suppressed = result({
      own: true,
      findings: [
        finding({
          findingRef: 'old-1',
          reconciliation: 'suppressed',
          commentId: null,
          threadId: null,
          shouldFix: 'dismiss',
        }),
      ],
      standing: { fix: [], unverified: [], settled: ['old-1'] },
    });
    expect(suppressed).toMatchObject({ result: 'passed', counts: { suppressed: 1 } });
    expect(result({ own: true, review: review({ status: 'running' }) }).result).toBe('pending');
  });
});

describe('what the security result asks of the review outcome', () => {
  const requirement = (input) => securityRequirement(result(input));

  it('asks nothing unless the project requires the pass and it has not passed', () => {
    expect(requirement({})).toBeNull();
    const interrupted = { stages: stagesAt(head, { security: { status: 'running', detail: null } }) };
    expect(requirement({ ...interrupted, policy: 'advisory' })).toBeNull();
    expect(requirement({ ...interrupted, policy: 'off' })).toBeNull();
    expect(requirement({ policy: 'off', stages: [] })).toBeNull();
  });

  it('maps a failed pass to changes required and everything else to incomplete', () => {
    expect(
      requirement({ stages: stagesAt(head, { security: { status: 'running', detail: null } }) }),
    ).toEqual({
      id: 'security',
      outcome: 'incomplete',
      message:
        'The required security review is incomplete: The security pass was interrupted before it finished.',
    });
    expect(requirement({ stages: stagesAt(head).filter((s) => s.stage !== 'security') })).toEqual({
      id: 'security',
      outcome: 'incomplete',
      message:
        'The required security review did not run: The review of aaaaaaa ran without a security pass: the project did not ask for one when it started, or it predates security reviews. Run the review again.',
    });
    const failed = requirement({
      stages: stagesAt(head, { security: { detail: { coverage: coverage([found(), found()]) } } }),
      findings: [
        finding({ shouldFix: 'fix' }),
        finding({ id: 2, findingRef: 'r2', shouldFix: 'fix', title: 'Token logged' }),
      ],
    });
    expect(failed).toEqual({
      id: 'security',
      outcome: 'changes_required',
      message:
        'The required security review failed: "Filename reaches the shell unquoted" is a required fix. (+1 more)',
    });
    expect(requirement({ review: null, stages: [] })).toMatchObject({ outcome: 'pending' });
  });

  it('blocks the outcome through its requirements, and only there', () => {
    const stages = stagesAt(head, { security: { status: 'failed', detail: { error: 'No record' } } });
    const base = { review: review(), stages, findings: [], current: { headSha: head, baseRef: 'main' } };
    // The pass's stage row is not one of the outcome's required stages.
    expect(computeReviewOutcome(base)).toMatchObject({ outcome: 'passed', reasons: [] });
    const required = securityRequirement(result({ stages }));
    const blocked = computeReviewOutcome({ ...base, requirements: [required] });
    expect(blocked.outcome).toBe('incomplete');
    expect(blocked.reasons).toEqual([
      {
        code: 'requirement_unmet',
        effect: 'incomplete',
        requirement: 'security',
        message: 'The required security review is incomplete: The security pass failed: No record',
      },
    ]);
  });
});
