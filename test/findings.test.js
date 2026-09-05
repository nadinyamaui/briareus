import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TEST_SHEET_ANCHOR, FIXES_ANCHOR } from '../lib/markers.js';

// What the GitHub mock serves, per test: the PR's issue comments, and a log of
// every write the module makes back.
// `fail` makes writes of one method come back refused, for the paths that have
// to survive GitHub saying no.
// `files` is the PR's changed paths, or null for a GitHub that will not say,
// which is the case the out-of-diff rule has to fail open on.
const gh = vi.hoisted(() => ({ comments: [], writes: [], token: 'tok', fail: '', files: null }));
const db = vi.hoisted(() => ({ decisions: new Map() }));

vi.mock('../lib/config.js', () => ({
  getConfig: () => ({ githubToken: gh.token }),
}));

vi.mock('../lib/github.js', () => ({
  githubRest: vi.fn(async (cfg, method, url, body) => {
    if (method === 'GET' && /\/comments\?/.test(url)) {
      return { ok: true, status: 200, json: async () => gh.comments };
    }
    if (method === 'GET' && /\/pulls\/\d+\/files\?/.test(url)) {
      if (gh.files === null) return { ok: false, status: 500, json: async () => ({}) };
      const page = Number(new URL(url, 'https://x').searchParams.get('page'));
      return {
        ok: true,
        status: 200,
        json: async () => (page === 1 ? gh.files.map((filename) => ({ filename })) : []),
      };
    }
    gh.writes.push({ method, url, body });
    if (gh.fail === method) return { ok: false, status: 500, json: async () => ({}) };
    return { ok: true, status: method === 'POST' ? 201 : 200, json: async () => ({}) };
  }),
}));

vi.mock('../lib/db.js', () => ({
  loadFindingDecisions: vi.fn(async () => new Map(db.decisions)),
  saveFindingDecision: vi.fn(async ({ key, decision, severity, title }) => {
    db.decisions.set(key, { key, decision, severity, title });
  }),
}));

import {
  findingKey,
  getFindings,
  latestReviewFindings,
  latestTestFailures,
  decideFinding,
  queueFindingsForFix,
  sortFindingsForFix,
  recordTriage,
  DECISIONS,
} from '../lib/findings.js';

// The module caches per repo#pr, so a unique repo per test keeps them isolated.
let n = 0;
let repo;
beforeEach(() => {
  repo = `owner/repo-${n++}`;
  gh.comments = [];
  gh.writes = [];
  gh.token = 'tok';
  gh.fail = '';
  gh.files = null;
  db.decisions = new Map();
});

function findingsComment(entries, id = 1) {
  return { id, body: `Review summary\n\n<!-- reviewer:findings ${JSON.stringify(entries)} -->` };
}

describe('findingKey', () => {
  it('is 12 hex chars keyed on the normalized title', () => {
    expect(findingKey('SQL injection in login')).toMatch(/^[0-9a-f]{12}$/);
  });

  it('ignores case and whitespace so the three carriers of a title agree', () => {
    expect(findingKey('  SQL   Injection ')).toBe(findingKey('sql injection'));
  });

  it('differs for different titles', () => {
    expect(findingKey('a')).not.toBe(findingKey('b'));
  });
});

describe('latestReviewFindings', () => {
  it('parses the newest findings block, sorted by severity then title', async () => {
    gh.comments = [
      findingsComment([{ title: 'Old finding', severity: 'critical' }], 1),
      findingsComment(
        [
          { title: 'B minor thing', severity: 'low' },
          { title: 'A big thing', severity: 'critical', file: 'lib/x.js', line: 10 },
          { title: 'Same rank', severity: 'critical' },
        ],
        2,
      ),
    ];
    const found = await latestReviewFindings(repo, 5);
    expect(found.map((f) => f.title)).toEqual(['A big thing', 'Same rank', 'B minor thing']);
    expect(found[0]).toMatchObject({ severity: 'critical', file: 'lib/x.js', line: 10 });
  });

  it('an empty block means "this review found nothing", not "fall back"', async () => {
    gh.comments = [findingsComment([{ title: 'Older finding' }], 1), findingsComment([], 2)];
    expect(await latestReviewFindings(repo, 5)).toEqual([]);
  });

  it('answers an empty list when no review declared anything', async () => {
    gh.comments = [{ id: 1, body: 'just a human comment' }];
    expect(await latestReviewFindings(repo, 5)).toEqual([]);
  });

  it('defaults a made-up severity to medium and drops a bad line number', async () => {
    gh.comments = [findingsComment([{ title: 'T', severity: 'catastrophic', line: -3 }])];
    const [f] = await latestReviewFindings(repo, 5);
    expect(f.severity).toBe('medium');
    expect(f.line).toBeNull();
  });

  it('caps a runaway title at 200 characters and skips entries without one', async () => {
    gh.comments = [findingsComment([{ title: 'x'.repeat(500) }, { severity: 'high' }, { title: '   ' }])];
    const found = await latestReviewFindings(repo, 5);
    expect(found).toHaveLength(1);
    expect(found[0].title).toHaveLength(200);
  });

  it('refuses to run without a GitHub token', async () => {
    gh.token = '';
    await expect(latestReviewFindings(repo, 5)).rejects.toThrow(/GITHUB_TOKEN/);
  });

  it('`since` ignores blocks older than the review that just ran', async () => {
    gh.comments = [
      { ...findingsComment([{ title: 'Round 1 finding' }], 1), created_at: '2026-01-01T10:00:00Z' },
      { id: 2, body: 'a review that published no block', created_at: '2026-01-01T12:00:00Z' },
    ];
    expect(await latestReviewFindings(repo, 5, { since: '2026-01-01T11:00:00Z' })).toEqual([]);
    expect(await latestReviewFindings(repo, 5, { since: '2026-01-01T09:00:00Z' })).toHaveLength(1);
  });

  it('a comment with no timestamp is read as usual rather than dropped', async () => {
    gh.comments = [findingsComment([{ title: 'Undated' }], 1)];
    expect(await latestReviewFindings(repo, 5, { since: '2026-01-01T09:00:00Z' })).toHaveLength(1);
  });
});

describe('getFindings', () => {
  it('merges declared findings with stored decisions and checklist ticks', async () => {
    const keyA = findingKey('Finding A');
    db.decisions.set(keyA, { decision: 'fix' });
    gh.comments = [
      findingsComment([
        { title: 'Finding A', severity: 'high' },
        { title: 'Finding B', severity: 'low' },
      ]),
      {
        id: 9,
        html_url: 'https://x/9',
        body: `${FIXES_ANCHOR}\n- [x] **HIGH**: Finding A <!-- fix:${keyA} -->`,
      },
    ];
    const { findings, fixesUrl } = await getFindings(repo, 5, { fresh: true });
    expect(fixesUrl).toBe('https://x/9');
    expect(findings).toHaveLength(2);
    expect(findings[0]).toMatchObject({ title: 'Finding A', decision: 'fix', fixed: true });
    expect(findings[1]).toMatchObject({ title: 'Finding B', decision: null, fixed: false });
  });

  it('a later review re-declaring a title overrides the earlier entry', async () => {
    gh.comments = [
      findingsComment([{ title: 'Same title', severity: 'low' }], 1),
      findingsComment([{ title: 'Same title', severity: 'critical' }], 2),
    ];
    const { findings } = await getFindings(repo, 5, { fresh: true });
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe('critical');
  });
});

describe('latestTestFailures', () => {
  const sheet = (rows) => ({
    id: 3,
    body: [
      TEST_SHEET_ANCHOR,
      '## Test sheet',
      '',
      '| # | Scenario | Steps | Expected | Status | Evidence |',
      '|---|----------|-------|----------|--------|----------|',
      ...rows,
    ].join('\n'),
  });

  it('reads only the ❌ rows off the newest sheet', async () => {
    gh.comments = [
      sheet([
        '| 1 | Login works | Open /login | Signed in | ✅ | [▶ video](u) |',
        '| 2 | Bad password | Open /login | Error shown | ❌ | typed wrong error |',
        '| 3 | Manual only | — | — | 🖐 | |',
      ]),
    ];
    const failures = await latestTestFailures(repo, 5);
    expect(failures).toEqual([
      { number: '2', scenario: 'Bad password', expected: 'Error shown', evidence: 'typed wrong error' },
    ]);
  });

  it('reads a row with stray pipes in its prose from both ends', async () => {
    gh.comments = [sheet(['| 4 | Piped | Run `a | b` then `c | d` | Output shown | ❌ | saw nothing |'])];
    const [failure] = await latestTestFailures(repo, 5);
    expect(failure.number).toBe('4');
    expect(failure.expected).toBe('Output shown');
    expect(failure.evidence).toBe('saw nothing');
  });

  it('never reports the header row, even with a ❌ elsewhere in the table', async () => {
    gh.comments = [sheet(['| 1 | Fails | steps | Expected | ❌ | note |'])];
    const failures = await latestTestFailures(repo, 5);
    expect(failures.every((f) => /^\d+$/.test(f.number))).toBe(true);
  });

  it('no sheet at all answers with an empty list', async () => {
    gh.comments = [{ id: 1, body: 'no sheet here' }];
    expect(await latestTestFailures(repo, 5)).toEqual([]);
  });
});

describe('queueFindingsForFix', () => {
  const round = [
    { key: findingKey('Needs fixing'), severity: 'high', title: 'Needs fixing' },
    { key: findingKey('Also this'), severity: 'low', title: 'Also this' },
  ];

  it('writes the checklist so the fix turn has somewhere to mark them solved', async () => {
    gh.comments = [
      findingsComment([
        { title: 'Needs fixing', severity: 'high', file: 'lib/x.js', line: 3 },
        { title: 'Also this', severity: 'low' },
      ]),
    ];
    const { kept, error } = await queueFindingsForFix(repo, 5, round);
    expect(kept).toHaveLength(2);
    expect(error).toBeNull();
    const post = gh.writes.find((w) => w.method === 'POST');
    expect(post.url).toBe(`/repos/${repo}/issues/5/comments`);
    expect(post.body.body).toContain('- [ ] **HIGH**: Needs fixing (`lib/x.js:3`)');
    expect(post.body.body).toContain('- [ ] **LOW**: Also this');
    // Recorded as fix-decided, which is what keeps them on the checklist for
    // the rounds after this one.
    expect([...db.decisions.values()].map((d) => d.decision)).toEqual(['fix', 'fix']);
  });

  it('leaves out, and hands back nothing for, a finding a person already dismissed', async () => {
    gh.comments = [findingsComment([{ title: 'Needs fixing' }, { title: 'Also this' }])];
    db.decisions.set(findingKey('Needs fixing'), { decision: 'dismissed' });
    db.decisions.set(findingKey('Also this'), { decision: 'optional' });
    expect((await queueFindingsForFix(repo, 5, round)).kept).toEqual([]);
    expect(gh.writes).toEqual([]); // nothing changed, so the PR is not touched
  });

  it('keeps the ticks a previous round already made', async () => {
    gh.comments = [
      findingsComment([{ title: 'Needs fixing' }, { title: 'Also this' }]),
      {
        id: 9,
        body: `${FIXES_ANCHOR}\n- [x] **HIGH**: Needs fixing <!-- fix:${findingKey('Needs fixing')} -->`,
      },
    ];
    db.decisions.set(findingKey('Needs fixing'), { decision: 'fix' });
    await queueFindingsForFix(repo, 5, round);
    const patch = gh.writes.find((w) => w.method === 'PATCH');
    expect(patch.url).toBe(`/repos/${repo}/issues/comments/9`);
    expect(patch.body.body).toContain(
      `- [x] **MEDIUM**: Needs fixing <!-- fix:${findingKey('Needs fixing')} -->`,
    );
    expect(patch.body.body).toContain('- [ ] **MEDIUM**: Also this');
  });

  it('re-listing a round it already listed writes nothing new', async () => {
    gh.comments = [findingsComment([{ title: 'Needs fixing' }, { title: 'Also this' }])];
    db.decisions.set(findingKey('Needs fixing'), { decision: 'fix' });
    db.decisions.set(findingKey('Also this'), { decision: 'fix' });
    expect((await queueFindingsForFix(repo, 5, round)).kept).toHaveLength(2);
    expect(gh.writes).toEqual([]);
  });

  // The caller sends `kept` to be fixed, so a checklist GitHub refused must
  // still answer the round filtered against the verdicts somebody gave.
  it('a failed checklist write is reported, not thrown, and still filters', async () => {
    gh.comments = [findingsComment([{ title: 'Needs fixing' }, { title: 'Also this' }])];
    gh.fail = 'POST';
    db.decisions.set(findingKey('Also this'), { decision: 'dismissed' });
    const { kept, error } = await queueFindingsForFix(repo, 5, round);
    expect(kept.map((f) => f.title)).toEqual(['Needs fixing']);
    expect(error).toMatch(/GitHub answered 500/);
  });
});

// The two rules that keep a review loop from feeding on its own fixes: what a
// later round is allowed to send back to be implemented, and what it only
// records. See lib/jobs.js for where the floor comes from.
describe('sortFindingsForFix: the split as advice, nothing written', () => {
  const round = [
    { key: findingKey('Needs fixing'), severity: 'high', title: 'Needs fixing' },
    { key: findingKey('Also this'), severity: 'low', title: 'Also this' },
    { key: findingKey('Elsewhere'), severity: 'high', title: 'Elsewhere', file: 'lib/other.js' },
  ];

  it('splits the round the way queueFindingsForFix would, and records nothing', async () => {
    gh.files = ['lib/x.js'];
    const { kept, parked } = await sortFindingsForFix(repo, 5, round, { severityFloor: 'medium' });
    expect(kept.map((f) => f.title)).toEqual(['Needs fixing']);
    expect(parked.map((f) => [f.title, f.reason])).toEqual([
      ['Also this', 'severity'],
      ['Elsewhere', 'out-of-diff'],
    ]);
    expect(db.decisions.size).toBe(0);
    expect(gh.writes).toEqual([]);
  });

  it('leaves out a finding somebody already ruled on, and keeps one they asked to fix', async () => {
    gh.files = ['lib/x.js'];
    db.decisions.set(findingKey('Needs fixing'), { decision: 'dismissed' });
    db.decisions.set(findingKey('Also this'), { decision: 'fix' });
    const { kept, parked } = await sortFindingsForFix(repo, 5, round, { severityFloor: 'medium' });
    expect(kept.map((f) => f.title)).toEqual(['Also this']);
    expect(parked.map((f) => f.title)).toEqual(['Elsewhere']);
  });
});

describe('recordTriage: the orchestrator’s verdicts on a round', () => {
  const round = [
    { key: findingKey('Needs fixing'), severity: 'high', title: 'Needs fixing', file: 'lib/x.js', line: 3 },
    { key: findingKey('Also this'), severity: 'low', title: 'Also this' },
    { key: findingKey('Elsewhere'), severity: 'medium', title: 'Elsewhere', file: 'lib/other.js' },
  ];
  const verdicts = () => [
    { ...round[0], decision: 'fix' },
    { ...round[1], decision: 'dismissed', reason: 'a note on generated code' },
    { ...round[2], decision: 'optional', reason: 'next branch' },
  ];

  it('records every verdict, lists the fix on the checklist and says the rest on the pull request', async () => {
    gh.comments = [
      findingsComment(round.map(({ title, severity, file, line }) => ({ title, severity, file, line }))),
    ];
    const { error } = await recordTriage(repo, 5, verdicts(), { round: 2 });
    expect(error).toBeNull();
    expect([...db.decisions.values()].map((d) => d.decision)).toEqual(['fix', 'dismissed', 'optional']);
    const posts = gh.writes.filter((w) => w.method === 'POST');
    expect(posts).toHaveLength(2);
    expect(posts[0].body.body).toContain(FIXES_ANCHOR);
    expect(posts[0].body.body).toContain('- [ ] **HIGH**: Needs fixing (`lib/x.js:3`)');
    expect(posts[0].body.body).not.toContain('Also this');
    expect(posts[1].url).toBe(`/repos/${repo}/issues/5/comments`);
    expect(posts[1].body.body).toContain('## Review triage (round 2)');
    expect(posts[1].body.body).toContain('- **LOW**: Also this — dismissed: a note on generated code');
    expect(posts[1].body.body).toContain(
      '- **MEDIUM**: Elsewhere (`lib/other.js`) — left optional: next branch',
    );
    expect(posts[1].body.body).not.toContain('Needs fixing');
  });

  it('overturns an earlier automatic verdict, which the loop’s own split never does', async () => {
    gh.comments = [findingsComment([{ title: 'Also this', severity: 'low' }])];
    db.decisions.set(findingKey('Also this'), { decision: 'optional' });
    await recordTriage(repo, 5, [{ ...round[1], decision: 'fix' }]);
    expect(db.decisions.get(findingKey('Also this')).decision).toBe('fix');
    // And the reverse: an automatic pass leaves that fix verdict alone.
    await queueFindingsForFix(repo, 5, [round[1]], { severityFloor: 'medium' });
    expect(db.decisions.get(findingKey('Also this')).decision).toBe('fix');
  });

  it('posts no triage comment when everything was kept', async () => {
    gh.comments = [findingsComment([{ title: 'Needs fixing', severity: 'high' }])];
    await recordTriage(repo, 5, [{ ...round[0], decision: 'fix' }]);
    expect(gh.writes.filter((w) => w.method === 'POST')).toHaveLength(1); // the checklist alone
  });

  it('a comment GitHub refused is reported, not thrown, and the verdicts still hold', async () => {
    gh.comments = [findingsComment([{ title: 'Also this', severity: 'low' }])];
    gh.fail = 'POST';
    const { error } = await recordTriage(repo, 5, [{ ...round[1], decision: 'dismissed', reason: 'x' }]);
    expect(error).toMatch(/GitHub answered 500 writing the triage comment/);
    expect(db.decisions.get(findingKey('Also this')).decision).toBe('dismissed');
  });
});

describe('queueFindingsForFix: what a round may hand back', () => {
  const round = [
    { key: findingKey('Needs fixing'), severity: 'high', title: 'Needs fixing' },
    { key: findingKey('Also this'), severity: 'low', title: 'Also this' },
  ];

  it('parks a finding below the round’s severity floor instead of implementing it', async () => {
    gh.comments = [findingsComment([{ title: 'Needs fixing' }, { title: 'Also this' }])];
    const { kept, parked } = await queueFindingsForFix(repo, 5, round, { severityFloor: 'medium' });
    expect(kept.map((f) => f.title)).toEqual(['Needs fixing']);
    expect(parked.map((f) => [f.title, f.reason])).toEqual([['Also this', 'severity']]);
    // Recorded as optional, so it stays visible in the panel and a later round
    // reads that verdict rather than offering it again.
    expect(db.decisions.get(findingKey('Also this')).decision).toBe('optional');
  });

  it('keeps a parked finding off the required-fixes checklist', async () => {
    gh.comments = [findingsComment([{ title: 'Needs fixing' }, { title: 'Also this' }])];
    await queueFindingsForFix(repo, 5, round, { severityFloor: 'medium' });
    const post = gh.writes.find((w) => w.method === 'POST');
    expect(post.body.body).toContain('Needs fixing');
    expect(post.body.body).not.toContain('Also this');
  });

  it('implements everything at the default floor, which is what round one runs on', async () => {
    gh.comments = [findingsComment([{ title: 'Needs fixing' }, { title: 'Also this' }])];
    const { kept, parked } = await queueFindingsForFix(repo, 5, round);
    expect(kept).toHaveLength(2);
    expect(parked).toEqual([]);
  });

  it('parks a finding on a file the pull request does not change', async () => {
    gh.comments = [findingsComment([{ title: 'Needs fixing' }, { title: 'Also this' }])];
    gh.files = ['lib/x.js'];
    const { kept, parked } = await queueFindingsForFix(repo, 5, [
      { ...round[0], file: 'lib/x.js' },
      { ...round[1], severity: 'high', file: 'lib/elsewhere.js' },
    ]);
    expect(kept.map((f) => f.title)).toEqual(['Needs fixing']);
    expect(parked.map((f) => f.reason)).toEqual(['out-of-diff']);
  });

  it('reads ./lib/x.js and lib/x.js as the same file', async () => {
    gh.comments = [findingsComment([{ title: 'Needs fixing' }])];
    gh.files = ['lib/x.js'];
    const { parked } = await queueFindingsForFix(repo, 5, [{ ...round[0], file: './lib/x.js' }]);
    expect(parked).toEqual([]);
  });

  it('keeps a finding that names no file at all: there is nothing to place it outside', async () => {
    gh.comments = [findingsComment([{ title: 'Needs fixing' }])];
    gh.files = ['lib/x.js'];
    expect((await queueFindingsForFix(repo, 5, [round[0]])).kept).toHaveLength(1);
  });

  // Parking is the destructive direction here: a real finding held back
  // because a listing failed is worse than one extra fix turn.
  it('fails open on the diff when GitHub will not list the files', async () => {
    gh.comments = [findingsComment([{ title: 'Needs fixing' }])];
    gh.files = null;
    const { kept, parked } = await queueFindingsForFix(repo, 5, [{ ...round[0], file: 'lib/gone.js' }]);
    expect(kept).toHaveLength(1);
    expect(parked).toEqual([]);
  });

  it('honours a fix verdict somebody gave, however low the finding', async () => {
    gh.comments = [findingsComment([{ title: 'Also this' }])];
    gh.files = ['lib/x.js'];
    db.decisions.set(findingKey('Also this'), { decision: 'fix' });
    const { kept } = await queueFindingsForFix(repo, 5, [{ ...round[1], file: 'lib/elsewhere.js' }], {
      severityFloor: 'critical',
    });
    expect(kept.map((f) => f.title)).toEqual(['Also this']);
  });

  it('never re-offers a finding it parked on an earlier round', async () => {
    gh.comments = [findingsComment([{ title: 'Also this' }])];
    const first = await queueFindingsForFix(repo, 5, [round[1]], { severityFloor: 'medium' });
    expect(first.parked).toHaveLength(1);
    const second = await queueFindingsForFix(repo, 5, [round[1]], { severityFloor: 'medium' });
    expect(second.kept).toEqual([]);
    expect(second.parked).toEqual([]); // already decided, so not even re-parked
  });
});

describe('decideFinding', () => {
  it('rejects a decision outside the vocabulary', async () => {
    await expect(decideFinding(repo, 5, 'abc', 'maybe')).rejects.toThrow(/not a decision/);
    expect(DECISIONS).toEqual(['fix', 'optional', 'dismissed']);
  });

  it('rejects a key that is no longer on the pull request', async () => {
    gh.comments = [findingsComment([{ title: 'Real' }])];
    await expect(decideFinding(repo, 5, 'ffffffffffff', 'fix')).rejects.toThrow(/no longer/);
  });

  it('a fix decision writes the checklist comment onto the PR', async () => {
    gh.comments = [findingsComment([{ title: 'Needs fixing', severity: 'high' }])];
    const key = findingKey('Needs fixing');
    const result = await decideFinding(repo, 5, key, 'fix');
    const post = gh.writes.find((w) => w.method === 'POST');
    expect(post.url).toBe(`/repos/${repo}/issues/5/comments`);
    expect(post.body.body).toContain(FIXES_ANCHOR);
    expect(post.body.body).toContain(`<!-- fix:${key} -->`);
    expect(post.body.body).toContain('- [ ] **HIGH**: Needs fixing');
    expect(result.findings[0]).toMatchObject({ decision: 'fix' });
  });

  it('a title with a comment marker in it cannot eat the checklist line', async () => {
    // Only an opening marker: a `-->` inside a title would terminate the
    // findings block itself, so such a title never survives to this point.
    const title = 'Weird <!-- title';
    gh.comments = [findingsComment([{ title, severity: 'low' }])];
    await decideFinding(repo, 5, findingKey(title), 'fix');
    const post = gh.writes.find((w) => w.method === 'POST');
    const line = post.body.body.split('\n').find((l) => l.startsWith('- [ ]'));
    // The only HTML comment left on the line is the fix key itself.
    expect(line.match(/<!--/g)).toHaveLength(1);
    expect(line).toContain(`fix:${findingKey(title)}`);
  });

  it('clearing the last fix decision deletes the checklist instead of leaving it', async () => {
    const key = findingKey('Only one');
    db.decisions.set(key, { decision: 'fix' });
    gh.comments = [
      findingsComment([{ title: 'Only one', severity: 'medium' }]),
      { id: 77, body: `${FIXES_ANCHOR}\n- [ ] **MEDIUM**: Only one <!-- fix:${key} -->` },
    ];
    db.decisions.set(key, { decision: null });
    await decideFinding(repo, 5, key, null);
    const del = gh.writes.find((w) => w.method === 'DELETE');
    expect(del.url).toBe(`/repos/${repo}/issues/comments/77`);
  });
});
