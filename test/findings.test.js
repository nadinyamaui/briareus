import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TEST_SHEET_ANCHOR, FIXES_ANCHOR } from '../lib/markers.js';

// The GitHub mock, per test: the PR's issue comments and a log of every write back. `fail`
// refuses writes of one method. `files` is the PR's changed paths, or null when GitHub will
// not say (the out-of-diff rule must fail open). `reviewComments` are the inline diff
// comments, the only place a finding can be deleted from.
const gh = vi.hoisted(() => ({
  comments: [],
  reviewComments: [],
  writes: [],
  token: 'tok',
  fail: '',
  files: null,
  // What a write comes back with, for the calls that read their answer.
  created: {},
  // The token's own login, or null when GitHub will not say.
  viewer: 'reviewer-bot',
}));
const db = vi.hoisted(() => ({ decisions: new Map() }));

vi.mock('../lib/config.js', () => ({
  getConfig: () => ({ githubToken: gh.token }),
}));

vi.mock('../lib/github.js', () => ({
  viewerLogin: vi.fn(async () => gh.viewer),
  githubRest: vi.fn(async (cfg, method, url, body) => {
    if (method === 'GET' && /\/pulls\/\d+\/comments\?/.test(url)) {
      const page = Number(new URL(url, 'https://x').searchParams.get('page'));
      return { ok: true, status: 200, json: async () => (page === 1 ? gh.reviewComments : []) };
    }
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
    return { ok: true, status: method === 'POST' ? 201 : 200, json: async () => gh.created };
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
  findingUrl,
  getFindings,
  latestReviewFindings,
  latestReviewDeclaration,
  latestTestVerdict,
  decideFinding,
  queueFindingsForFix,
  sortFindingsForFix,
  recordTriage,
  postTriageNotes,
  deleteFindingFromReview,
  replyOnFindingThread,
  DECISIONS,
} from '../lib/findings.js';

// The module caches per repo#pr, so a unique repo per test keeps them isolated.
let n = 0;
let repo;
beforeEach(() => {
  repo = `owner/repo-${n++}`;
  gh.comments = [];
  gh.reviewComments = [];
  gh.writes = [];
  gh.token = 'tok';
  gh.fail = '';
  gh.files = null;
  gh.created = {};
  gh.viewer = 'reviewer-bot';
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

describe('findingUrl', () => {
  it('anchors the pull request diff on the file and its line', () => {
    expect(findingUrl('owner/repo', 7, 'app/Models/User.php', 42)).toBe(
      'https://github.com/owner/repo/pull/7/files#diff-37a2d7d879a7de3f7d73b2975cd22be9f41ec10c334a0dda9ad1e869332e4ecb' +
        'R42',
    );
  });

  it('reads a ./-prefixed path as the same file the diff names', () => {
    expect(findingUrl('owner/repo', 7, './app/Models/User.php', 42)).toBe(
      findingUrl('owner/repo', 7, 'app/Models/User.php', 42),
    );
  });

  it('drops the line anchor when the finding gives no line', () => {
    expect(findingUrl('owner/repo', 7, 'a.js', null)).not.toMatch(/R/);
  });

  it('falls back to the diff itself when the finding names no file', () => {
    expect(findingUrl('owner/repo', 7, null, null)).toBe('https://github.com/owner/repo/pull/7/files');
  });
});

describe('latestReviewFindings', () => {
  it('preserves verified value assessments and does not trust incomplete ones', async () => {
    const assessment = {
      verified: true,
      evidence: ' lib/x.js:10 reachable failure ',
      worthFixing: false,
      reason: ' Cost exceeds impact ',
    };
    gh.comments = [
      findingsComment([
        { title: 'Assessed', assessment },
        { title: 'Missing evidence', assessment: { ...assessment, evidence: '' } },
        { title: 'Not verified', assessment: { ...assessment, verified: false } },
        { title: 'Not boolean', assessment: { ...assessment, worthFixing: 'false' } },
        { title: 'Legacy' },
      ]),
    ];
    const findings = await latestReviewFindings(repo, 5);
    expect(findings.find((f) => f.title === 'Assessed').assessment).toEqual({
      verified: true,
      evidence: 'lib/x.js:10 reachable failure',
      worthFixing: false,
      reason: 'Cost exceeds impact',
    });
    expect(findings.filter((f) => f.title !== 'Assessed').every((f) => !f.assessment)).toBe(true);
  });
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

  it('reports incomplete verification instead of falling back to an older clean review', async () => {
    gh.comments = [
      { ...findingsComment([], 1), created_at: '2026-01-01T10:00:00Z' },
      {
        id: 2,
        body: 'Verification unavailable. <!-- reviewer:incomplete -->',
        created_at: '2026-01-01T12:00:00Z',
      },
    ];
    await expect(latestReviewFindings(repo, 5)).rejects.toMatchObject({
      name: 'ReviewIncompleteError',
    });
    await expect(latestReviewFindings(repo, 5, { since: '2026-01-01T11:00:00Z' })).rejects.toMatchObject({
      name: 'ReviewIncompleteError',
    });
    expect(await latestReviewFindings(repo, 5, { since: '2026-01-01T13:00:00Z' })).toEqual([]);
    gh.comments.push(findingsComment([], 3));
    expect(await latestReviewFindings(repo, 5)).toEqual([]);
  });

  it('declares a round clean only for a well-formed empty block', async () => {
    gh.comments = [findingsComment([{ title: 'Older finding' }], 1), findingsComment([], 2)];
    expect(await latestReviewDeclaration(repo, 5)).toEqual({ findings: [], clean: true });
    gh.comments = [findingsComment([{ title: 'Found' }], 1)];
    expect(await latestReviewDeclaration(repo, 5)).toMatchObject({ clean: false });
    gh.comments = [{ id: 1, body: '<!-- reviewer:findings\nnot json\n-->' }];
    expect(await latestReviewDeclaration(repo, 5)).toEqual({ findings: [], clean: false });
    gh.comments = [{ id: 1, body: 'just a human comment' }];
    expect(await latestReviewDeclaration(repo, 5)).toEqual({ findings: [], clean: false });
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
    expect(findings[0]).toMatchObject({
      title: 'Finding A',
      decision: 'fix',
      fixed: true,
      url: findingUrl(repo, 5, null, null),
    });
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

describe('latestTestVerdict', () => {
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
    const { failures } = await latestTestVerdict(repo, 5);
    expect(failures).toEqual([
      { number: '2', scenario: 'Bad password', expected: 'Error shown', evidence: 'typed wrong error' },
    ]);
  });

  it('reproduces one browser pass plus nine manual API rows without inventing failures', async () => {
    gh.comments = [
      sheet([
        '| 1 | Profile | Open profile | Permission | ✅ | [video](u) |',
        ...Array.from({ length: 9 }, (_, i) => `| ${i + 2} | API | GET /api | 200 | 🖐 | |`),
      ]),
    ];
    expect(await latestTestVerdict(repo, 5)).toEqual({
      failures: [],
      total: 10,
      passed: 1,
      manual: 9,
      incomplete: true,
    });
  });

  it.each([
    '| 2 | API | curl /api | 200 | ⬜ |',
    '2 | API | curl /api | 200 | ⬜',
    '2 | API | curl /api | 200 | ✅ | response.json',
    '| 2 | API | curl /api | 200 | ✅ |',
    '| 2 | API | curl /api | 200 |',
    '2 | API | curl /api | 200',
    '| 2 | UI pending | Open /settings |',
    '2 | UI pending | Open /settings',
    '| 2 | UI pending |',
    '2 | UI pending',
  ])('counts shortened scenario rows: %s', async (row) => {
    gh.comments = [sheet(['| 1 | API | curl /api | 200 | ✅ | response.json |', row])];
    const verdict = await latestTestVerdict(repo, 5);
    expect(verdict.total).toBe(2);
    expect(verdict.passed).toBe(row.includes('response.json') ? 2 : 1);
    expect(verdict.incomplete).toBe(!row.includes('response.json'));
  });

  it.each(['| 2 |', '2 |', '| **2** |'])('keeps scanning after number-only row %s', async (row) => {
    gh.comments = [
      sheet([
        '| 1 | API | curl /api | 200 | ✅ | response.json |',
        row,
        '| 3 | Failure | curl /api | 200 | ❌ | saw 500 |',
      ]),
    ];
    expect(await latestTestVerdict(repo, 5)).toEqual({
      failures: [{ number: '3', scenario: 'Failure', expected: '200', evidence: 'saw 500' }],
      total: 3,
      passed: 1,
      manual: 0,
      incomplete: true,
    });
  });

  it('keeps failed scenarios after empty table spacer rows', async () => {
    gh.comments = [
      sheet([
        '| 1 | API | curl /api | 200 | ✅ | response.json |',
        '| | | | | | |',
        '| 2 | Failure | curl /api | 200 | ❌ | saw 500 |',
        '| | | | | | |',
        '| 3 | UI | Open profile | Permission | ⬜ | |',
      ]),
    ];
    expect(await latestTestVerdict(repo, 5)).toEqual({
      failures: [{ number: '2', scenario: 'Failure', expected: '200', evidence: 'saw 500' }],
      total: 3,
      passed: 1,
      manual: 0,
      incomplete: true,
    });
  });

  it.each([
    '| # | Scenario | Request | Expected | Status | Evidence |',
    '| **#** | Case | Request | Response | **Status** | _Evidence_ |',
    '| `#` | Scenario | Steps | Expected | ~~Status~~ | **`Evidence`** |',
  ])('recognizes custom and formatted results headers: %s', async (header) => {
    const rows = [header, '|---|---|---|---|---|---|'];
    gh.comments = [
      sheet([
        '| 1 | Browser | Open profile | Permission | ✅ | video |',
        '',
        ...rows,
        '| 2 | Failure | curl /api | 200 | ❌ | saw 500 |',
      ]),
    ];
    expect(await latestTestVerdict(repo, 5)).toEqual({
      failures: [{ number: '2', scenario: 'Failure', expected: '200', evidence: 'saw 500' }],
      total: 2,
      passed: 1,
      manual: 0,
      incomplete: false,
    });
    gh.comments = [
      { body: [TEST_SHEET_ANCHOR, ...rows, '| 1 | API | curl | 200 | ✅ | response.json |'].join('\n') },
    ];
    expect(await latestTestVerdict(repo, 5)).toMatchObject({ total: 1, passed: 1, incomplete: false });
  });

  it.each(['', '\n', '\nSaved response summary\n'])(
    'ignores a separate evidence table after scenarios: %j',
    async (gap) => {
      gh.comments = [
        sheet([
          '| 1 | API | curl /api | 200 | ✅ | response.json |',
          ...(gap ? [gap] : []),
          '| Status | Meaning |',
          '|---|---|',
          '| 200 | Expected OK |',
        ]),
      ];
      expect(await latestTestVerdict(repo, 5)).toMatchObject({ total: 1, passed: 1, incomplete: false });
    },
  );

  it('ignores numeric prose rows outside the scenario table', async () => {
    gh.comments = [
      sheet([
        '| 1 | API | curl /api | 200 | ✅ | response.json |',
        '',
        'Saved responses:',
        '| 200 | Expected OK |',
      ]),
    ];
    expect(await latestTestVerdict(repo, 5)).toMatchObject({ total: 1, passed: 1, incomplete: false });
  });

  it.each(['**2**', '2.', '_2_', '`2`', '~~2~~', '**2.**', '#2', '2a', '2.1', '**2.1**'])(
    'preserves failed and subsequent scenarios after formatted number %s',
    async (number) => {
      gh.comments = [
        sheet([
          '| 1 | API | curl /api | 200 | ✅ | response.json |',
          `| ${number} | Failure | curl /api | 200 | ❌ | saw 500 |`,
          '| 3 | UI | Open profile | Permission | ⬜ | |',
        ]),
      ];
      expect(await latestTestVerdict(repo, 5)).toEqual({
        failures: [
          {
            number: number.replace(/[^0-9]/g, ''),
            scenario: 'Failure',
            expected: '200',
            evidence: 'saw 500',
          },
        ],
        total: 3,
        passed: 1,
        manual: 0,
        incomplete: true,
      });
    },
  );

  it('keeps escaped Markdown pipes inside their cells', async () => {
    gh.comments = [
      sheet([
        '| 1 | API | curl /api | 200 | ✅ | Asserted `name=a\\|b` in [response](https://example.com/ok) |',
        '| 2 | API | curl /api | name=a\\|b | ❌ | saw a\\|c |',
      ]),
    ];
    expect(await latestTestVerdict(repo, 5)).toEqual({
      failures: [{ number: '2', scenario: 'API', expected: 'name=a\\|b', evidence: 'saw a\\|c' }],
      total: 2,
      passed: 1,
      manual: 0,
      incomplete: false,
    });
  });

  it('accepts a fully executed API and UI sheet with evidence', async () => {
    gh.comments = [
      sheet([
        '| 1 | API | curl /api | 200 with expected JSON | ✅ | [responses and assertions](u) |',
        '| 2 | UI | Open profile | Permission | ✅ | [video](u) |',
      ]),
    ];
    expect(await latestTestVerdict(repo, 5)).toEqual({
      failures: [],
      total: 2,
      passed: 2,
      manual: 0,
      incomplete: false,
    });
  });

  it.each([
    ['🖐️', 'Intentionally excluded: requires a physical device', 1],
    ['⬜', '', 0],
    ['unknown', '', 0],
    ['✅', '', 0],
  ])('keeps %s incomplete even with an intentional exemption reason', async (status, evidence, manual) => {
    gh.comments = [sheet([`| 1 | Procedure | Steps | Expected | ${status} | ${evidence} |`])];
    expect(await latestTestVerdict(repo, 5)).toEqual({
      failures: [],
      total: 1,
      passed: 0,
      manual,
      incomplete: true,
    });
  });

  it('accepts annotated passes but keeps mixed executed/unexecuted rows incomplete', async () => {
    gh.comments = [
      sheet([
        '| 1 | API | curl /api | 200 | ✅ API curl | response.json |',
        '| 2 | Mixed | API and UI | Both work | ✅ API curl; ⬜ profile UI | response.json |',
      ]),
    ];
    expect(await latestTestVerdict(repo, 5)).toEqual({
      failures: [],
      total: 2,
      passed: 1,
      manual: 0,
      incomplete: true,
    });
  });

  it.each([
    '—',
    '–',
    '-',
    '...',
    '…',
    'N/A',
    'none',
    'TBD',
    'TODO',
    '_N/A_',
    '**TODO**',
    '`N/A`',
    '***—***',
    '**`none`**',
    '~~TBD~~',
    '~~**N/A**~~',
  ])('keeps placeholder evidence incomplete: %s', async (evidence) => {
    gh.comments = [sheet([`| 1 | API | curl /api | 200 | ✅ | ${evidence} |`])];
    expect(await latestTestVerdict(repo, 5)).toMatchObject({ total: 1, passed: 0, incomplete: true });
  });

  it.each(['⚠️ UI blocked', '⏭️ UI skipped', 'UI blocked', 'UI skipped', '⬜ UI', '❓ UI unknown'])(
    'keeps a partially executed row incomplete: %s',
    async (procedure) => {
      gh.comments = [
        sheet([`| 1 | Mixed | API and UI | Both work | ✅ API; ${procedure} | response.json |`]),
      ];
      expect(await latestTestVerdict(repo, 5)).toMatchObject({ total: 1, passed: 0, incomplete: true });
    },
  );

  it.each([
    '✅ API<br>UI blocked',
    '✅ API<br/>UI blocked',
    '✅ API, UI skipped',
    '✅ API / unknown UI',
    '✅ API / UI pending',
    '✅ API, UI not run',
  ])('keeps explicit incomplete annotations incomplete: %s', async (status) => {
    gh.comments = [sheet([`| 1 | Mixed | API and UI | Both work | ${status} | response.json |`])];
    expect(await latestTestVerdict(repo, 5)).toEqual({
      failures: [],
      total: 1,
      passed: 0,
      manual: 0,
      incomplete: true,
    });
  });

  it.each([
    '✅ request from blocked user was blocked',
    '✅ user not verified is denied',
    '✅ API blocked user returns 403',
    '✅ UI pending payment is shown',
    '✅ API: blocked user returns 403',
    '✅ UI: pending payment is shown',
    '✅ payment remains pending',
    '✅ unknown route returns 404',
    '✅ blocked user receives 403',
    '✅ pending payment is displayed',
    '✅ manual payment is displayed',
    '✅ GET /api/unknown returns 404',
    '✅ unknown route returns 404; ✅ blocked user receives 403',
    '✅ API, ✅ UI',
    '✅ API / ✅ UI',
    '✅ API<br>✅ UI',
    '✅ HTTP 200, response body verified',
    '✅ returns 200; JSON matches',
    '✅ Chromium, Firefox',
    '✅ returns name, email and status',
    '✅ blocked user receives 403; response verified',
  ])('accepts evidenced passing scenario descriptions: %s', async (status) => {
    gh.comments = [sheet([`| 1 | Procedure | Steps | Expected | ${status} | response.json |`])];
    expect(await latestTestVerdict(repo, 5)).toEqual({
      failures: [],
      total: 1,
      passed: 1,
      manual: 0,
      incomplete: false,
    });
  });

  it.each([
    '✅ API; UI not run on this host',
    '✅ API; UI blocked by missing credentials',
    '✅ API; UI blocked by unavailable credentials',
    '✅ API; UI was skipped for this run',
    '✅ API; browser not run',
    '✅ API; UI could not be tested',
    '✅ API; UI not yet tested',
    '✅ API; UI pending execution',
    '✅ API; UI not run — no browser',
    '✅ API; UI not run while browser starts',
    '✅ API; UI was not tested after setup failed',
    '✅ API; browser could not be verified without credentials',
    '✅ API; UI skipped for lack of access',
    '✅ API; UI blocked by setup failure',
    '✅ API; UI was skipped',
    '✅ API; UI: skipped',
    '✅ API; UI is pending',
    '✅ API; UI: skipped (browser unavailable)',
    '✅ API; UI unavailable',
    '✅ API; Firefox not attempted',
    '✅ API; UI was not tested: browser unavailable',
    '✅ API; UI is blocked because credentials are unavailable',
    '✅ API; UI blocked: browser unavailable',
    '✅ API; UI pending (needs browser)',
    '✅ API; UI skipped due to unavailable credentials',
    '✅ API (UI blocked: browser unavailable)',
    '✅ API/UI pending (needs browser)',
    '✅ API<br>UI skipped due to unavailable credentials',
    '✅ API; blocked UI: browser unavailable',
    '✅ API; pending: needs browser',
    '✅ API; skipped because credentials are unavailable',
    '✅ API (UI not run)',
    '✅ API/UI not run',
    '✅ API and UI manual',
    '✅ API 🟡 UI pending',
    '✅ API, UI manual',
    '✅ API / 🚧 UI',
    '✅ API / UI not verified',
    '✅ API<br>UI manual',
    '✅ API; UI in progress',
    '✅ API / ✅ 🚧 UI',
    '✅ unknown route returns 404, UI manual',
    '✅ blocked user receives 403 / UI not verified',
    '✅ pending payment is displayed<br/>UI skipped',
  ])('keeps unexecuted subprocedures incomplete: %s', async (status) => {
    gh.comments = [sheet([`| 1 | Mixed | API and UI | Both work | ${status} | response.json |`])];
    expect(await latestTestVerdict(repo, 5)).toEqual({
      failures: [],
      total: 1,
      passed: 0,
      manual: 0,
      incomplete: true,
    });
  });

  it.each(['_response.json_', '**asserted HTTP 200**', '`response.json`', '~~response.json~~'])(
    'accepts formatted execution evidence: %s',
    async (evidence) => {
      gh.comments = [sheet([`| 1 | API | curl /api | 200 | ✅ | ${evidence} |`])];
      expect(await latestTestVerdict(repo, 5)).toMatchObject({ passed: 1, incomplete: false });
    },
  );

  it('accepts multiple evidenced passing subprocedures', async () => {
    gh.comments = [
      sheet(['| 1 | Mixed | API and UI | Both work | ✅ API; ✅ UI | response.json and video |']),
    ];
    expect(await latestTestVerdict(repo, 5)).toMatchObject({ total: 1, passed: 1, incomplete: false });
  });

  it('does not fall back to an older passing sheet when the newest is empty', async () => {
    gh.comments = [sheet(['| 1 | Old | Steps | Expected | ✅ | evidence |']), sheet([])];
    expect(await latestTestVerdict(repo, 5)).toMatchObject({ total: 0, incomplete: true });
  });

  it('reads a row with stray pipes in its prose from both ends', async () => {
    gh.comments = [sheet(['| 4 | Piped | Run `a | b` then `c | d` | Output shown | ❌ | saw nothing |'])];
    const {
      failures: [failure],
    } = await latestTestVerdict(repo, 5);
    expect(failure.number).toBe('4');
    expect(failure.expected).toBe('Output shown');
    expect(failure.evidence).toBe('saw nothing');
  });

  it('never reports the header row, even with a ❌ elsewhere in the table', async () => {
    gh.comments = [sheet(['| 1 | Fails | steps | Expected | ❌ | note |'])];
    const { failures } = await latestTestVerdict(repo, 5);
    expect(failures.every((f) => /^\d+$/.test(f.number))).toBe(true);
  });

  it('no sheet at all is incomplete', async () => {
    gh.comments = [{ id: 1, body: 'no sheet here' }];
    expect(await latestTestVerdict(repo, 5)).toMatchObject({ failures: [], total: 0, incomplete: true });
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

// The two rules that keep a review loop from feeding on its own fixes: what a later round may
// send to be fixed, and what it only records. The floor comes from lib/jobs.js.
describe('sortFindingsForFix: the split as advice, nothing written', () => {
  it('parks a confirmed finding whose fix is not worthwhile, regardless of severity', async () => {
    const finding = {
      title: 'Expensive low-impact remedy',
      severity: 'high',
      assessment: {
        verified: true,
        evidence: 'Reachable failure',
        worthFixing: false,
        reason: 'Risk exceeds benefit',
      },
    };
    const { kept, parked } = await sortFindingsForFix(repo, 5, [finding]);
    expect(kept).toEqual([]);
    expect(parked).toEqual([{ ...finding, reason: 'value' }]);
    expect(gh.writes).toEqual([]);
  });
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

  it('says the round’s note on the pull request even when every finding was kept', async () => {
    gh.comments = [findingsComment([{ title: 'Needs fixing', severity: 'high' }])];
    await recordTriage(repo, 5, [{ ...round[0], decision: 'fix' }], { note: 'Mind the migration order' });
    const posts = gh.writes.filter((w) => w.method === 'POST');
    expect(posts).toHaveLength(2);
    expect(posts[1].body.body).toContain('sent every one of them to be fixed');
    expect(posts[1].body.body).toContain('**Note:** Mind the migration order');
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

describe('postTriageNotes: the comments saved on a held round before it is completed', () => {
  const findings = [
    {
      key: 'a1',
      severity: 'high',
      title: 'Needs fixing',
      file: 'lib/x.js',
      line: 3,
      decision: 'fix',
      reason: 'Do it first',
    },
    { key: 'a2', severity: 'low', title: 'Also this', decision: null, reason: '' },
    {
      key: 'a3',
      severity: 'medium',
      title: 'Elsewhere',
      file: 'lib/o.js',
      decision: 'dismissed',
      reason: 'Not in scope',
    },
  ];

  it('posts one comment with the reasons typed so far and the note', async () => {
    await postTriageNotes(repo, 5, 'sess-1', findings, { note: 'Merge after #4', round: 2 });
    const posts = gh.writes.filter((w) => w.method === 'POST');
    expect(posts).toHaveLength(1);
    expect(posts[0].url).toBe(`/repos/${repo}/issues/5/comments`);
    const body = posts[0].body.body;
    expect(body).toContain('<!-- reviewer:triage-notes sess-1 -->');
    expect(body).toContain('## Review triage notes (round 2)');
    expect(body).toContain('- **HIGH**: Needs fixing (`lib/x.js:3`) — to fix: Do it first');
    expect(body).toContain('- **MEDIUM**: Elsewhere (`lib/o.js`) — dismissed: Not in scope');
    expect(body).not.toContain('Also this'); // nothing was typed on it
    expect(body).toContain('**Note:** Merge after #4');
  });

  it('rewrites its own comment on the next save instead of stacking another', async () => {
    gh.comments = [
      { id: 40, body: 'unrelated' },
      { id: 41, html_url: 'https://gh/c/41', body: '<!-- reviewer:triage-notes sess-1 -->\nold' },
      { id: 42, body: '<!-- reviewer:triage-notes other -->\nsomeone else’s round' },
    ];
    const url = await postTriageNotes(repo, 5, 'sess-1', findings, {});
    expect(url).toBe('https://gh/c/41');
    expect(gh.writes).toEqual([
      expect.objectContaining({ method: 'PATCH', url: `/repos/${repo}/issues/comments/41` }),
    ]);
    expect(gh.writes[0].body.body).toContain('## Review triage notes\n');
    expect(gh.writes[0].body.body).toContain("reading this round's findings");
  });

  // A hand-started review has no rounds to number, so its notes comment says
  // "review" where a loop round's says "round".
  it('says review, not round, on a hand-started review’s notes', async () => {
    await postTriageNotes(repo, 5, 'sess-1', findings, { round: 1, standalone: true });
    const body = gh.writes.find((w) => w.method === 'POST').body.body;
    expect(body).toContain('## Review triage notes\n');
    expect(body).toContain("reading this review's findings");
  });

  it('removes the comment when a save leaves nothing to say, and posts none when there never was', async () => {
    gh.comments = [{ id: 41, body: '<!-- reviewer:triage-notes sess-1 -->\nold' }];
    expect(await postTriageNotes(repo, 5, 'sess-1', [{ ...findings[1] }], { note: '  ' })).toBeNull();
    expect(gh.writes).toEqual([
      expect.objectContaining({ method: 'DELETE', url: `/repos/${repo}/issues/comments/41` }),
    ]);
    gh.writes = [];
    gh.comments = [];
    expect(await postTriageNotes(repo, 5, 'sess-1', [], {})).toBeNull();
    expect(gh.writes).toEqual([]);
  });

  it('throws when GitHub refuses the write, for the caller to report', async () => {
    gh.fail = 'POST';
    await expect(postTriageNotes(repo, 5, 'sess-1', findings, {})).rejects.toThrow(
      /GitHub answered 500 writing the triage notes comment/,
    );
  });
});

describe('deleteFindingFromReview', () => {
  const entries = [
    { severity: 'high', title: 'Race in the retry loop', file: 'lib/x.js', line: 12 },
    { severity: 'low', title: 'Duplicated helper', file: 'public/y.js', line: 40 },
  ];
  const race = {
    key: findingKey('Race in the retry loop'),
    title: 'Race in the retry loop',
    file: 'lib/x.js',
    line: 12,
  };
  const inline = (extra = {}) => ({
    id: 101,
    path: 'lib/x.js',
    line: 12,
    body: '**HIGH**: Race in the retry loop\n\nIt can spin forever.',
    html_url: 'https://gh/r/101',
    created_at: '2026-09-08T10:00:00Z',
    ...extra,
  });

  it('deletes the finding’s own comment and stops the review declaring it', async () => {
    gh.comments = [findingsComment(entries, 7)];
    gh.reviewComments = [inline(), { id: 102, path: 'public/y.js', line: 40, body: 'Duplicated helper' }];

    const out = await deleteFindingFromReview(repo, 5, race);

    expect(out).toEqual({ commentDeleted: true, undeclared: true, warning: null });
    expect(gh.writes[0]).toMatchObject({ method: 'DELETE', url: `/repos/${repo}/pulls/comments/101` });
    expect(gh.writes[1]).toMatchObject({ method: 'PATCH', url: `/repos/${repo}/issues/comments/7` });
    const rewritten = gh.writes[1].body.body;
    expect(rewritten).toContain('Duplicated helper'); // the other finding stands
    expect(rewritten).not.toContain('Race in the retry loop');
    expect(rewritten).toContain('Review summary'); // the prose the review wrote is not touched
    expect(gh.writes).toHaveLength(2);
  });

  it('finds the comment by its title when the line it was written against has moved', async () => {
    gh.comments = [findingsComment(entries, 7)];
    gh.reviewComments = [inline({ line: null, original_line: 99 })];

    const out = await deleteFindingFromReview(repo, 5, race);

    expect(out.commentDeleted).toBe(true);
    expect(gh.writes[0]).toMatchObject({ method: 'DELETE', url: `/repos/${repo}/pulls/comments/101` });
  });

  it('undeclares a finding the review only listed in its summary, deleting nothing', async () => {
    gh.comments = [findingsComment(entries, 7)];
    gh.reviewComments = [];

    const out = await deleteFindingFromReview(repo, 5, race);

    expect(out).toEqual({ commentDeleted: false, undeclared: true, warning: null });
    expect(gh.writes.map((w) => w.method)).toEqual(['PATCH']);
  });

  it('never touches a comment posted before the review began', async () => {
    gh.comments = [findingsComment(entries, 7)];
    gh.reviewComments = [inline({ created_at: '2026-09-01T10:00:00Z' })];

    const out = await deleteFindingFromReview(repo, 5, race, { since: '2026-09-08T09:00:00Z' });

    expect(out.commentDeleted).toBe(false);
    expect(gh.writes.map((w) => w.method)).toEqual(['PATCH']);
  });

  it('never touches a reply on a thread', async () => {
    gh.comments = [findingsComment(entries, 7)];
    gh.reviewComments = [inline({ id: 103, in_reply_to_id: 101 })];

    expect((await deleteFindingFromReview(repo, 5, race)).commentDeleted).toBe(false);
    expect(gh.writes.map((w) => w.method)).toEqual(['PATCH']);
  });

  // A still-unfixed earlier finding is restated as a reply on its old thread.
  it('deletes only the follow-up reply of a restated finding, never its thread', async () => {
    gh.comments = [findingsComment(entries, 7)];
    gh.reviewComments = [
      inline({ created_at: '2026-09-01T10:00:00Z' }),
      inline({
        id: 103,
        in_reply_to_id: 101,
        user: { login: 'Reviewer-Bot' },
        body: 'Follow-up: still unfixed.',
      }),
    ];

    const out = await deleteFindingFromReview(repo, 5, race, { since: '2026-09-08T09:00:00Z' });

    expect(out.commentDeleted).toBe(true);
    expect(gh.writes[0]).toMatchObject({ method: 'DELETE', url: `/repos/${repo}/pulls/comments/103` });
    expect(gh.writes.map((w) => w.method)).toEqual(['DELETE', 'PATCH']);
  });

  // A lineless restated finding must not take the one new comment on its file,
  // which belongs to another finding.
  it("never takes another finding's comment for a lineless restated finding", async () => {
    gh.comments = [findingsComment(entries, 7)];
    gh.reviewComments = [
      inline({ id: 90, line: 30, body: 'Old thread', created_at: '2026-09-01T10:00:00Z' }),
      inline({ id: 104, line: 5, body: '**LOW**: Unused import' }),
      inline({
        id: 105,
        in_reply_to_id: 90,
        line: 30,
        user: { login: 'reviewer-bot' },
        body: 'Follow-up: Race in the retry loop is still there.',
      }),
    ];

    await deleteFindingFromReview(repo, 5, { ...race, line: null }, { since: '2026-09-08T09:00:00Z' });

    expect(gh.writes[0]).toMatchObject({ method: 'DELETE', url: `/repos/${repo}/pulls/comments/105` });
  });

  // Same, with a follow-up that does not quote the title: the new comment is
  // the file's only top-level one, yet it belongs to another finding.
  it("never takes another finding's comment for a lineless restated finding whose follow-up omits the title", async () => {
    gh.comments = [findingsComment(entries, 7)];
    gh.reviewComments = [
      inline({ id: 90, line: 30, body: 'Old thread', created_at: '2026-09-01T10:00:00Z' }),
      inline({
        id: 105,
        in_reply_to_id: 90,
        line: 30,
        user: { login: 'reviewer-bot' },
        body: 'Follow-up: still unfixed.',
      }),
      inline({ id: 106, line: 5, body: '**LOW**: Unused import' }),
    ];

    const out = await deleteFindingFromReview(
      repo,
      5,
      { ...race, line: null },
      { since: '2026-09-08T09:00:00Z' },
    );

    expect(out.commentDeleted).toBe(false);
    expect(gh.writes.map((w) => w.method)).toEqual(['PATCH']);
  });

  // A finding listed only in the summary must not take another restated
  // finding's follow-up, even when it is the only new comment on the file.
  it("never takes another restated finding's follow-up for a lineless summary-only finding", async () => {
    gh.comments = [findingsComment(entries, 7)];
    gh.reviewComments = [
      inline({ id: 90, line: 30, body: 'Old thread', created_at: '2026-09-01T10:00:00Z' }),
      inline({
        id: 105,
        in_reply_to_id: 90,
        line: 30,
        user: { login: 'reviewer-bot' },
        body: 'Follow-up: Unused import is still there.',
      }),
    ];

    const out = await deleteFindingFromReview(
      repo,
      5,
      { ...race, line: null },
      { since: '2026-09-08T09:00:00Z' },
    );

    expect(out.commentDeleted).toBe(false);
    expect(gh.writes.map((w) => w.method)).toEqual(['PATCH']);
  });

  it("never touches someone else's reply posted since the review began", async () => {
    gh.comments = [findingsComment(entries, 7)];
    gh.reviewComments = [
      inline({ id: 90, body: 'Old thread', created_at: '2026-09-01T10:00:00Z' }),
      // The author answers on the old thread before the review's follow-up.
      inline({ id: 91, in_reply_to_id: 90, user: { login: 'pr-author' }, body: 'Not a bug.' }),
      inline({
        id: 105,
        in_reply_to_id: 90,
        user: { login: 'reviewer-bot' },
        body: 'Follow-up: still unfixed.',
        created_at: '2026-09-08T10:05:00Z',
      }),
    ];

    await deleteFindingFromReview(repo, 5, race, { since: '2026-09-08T09:00:00Z' });

    expect(gh.writes[0]).toMatchObject({ method: 'DELETE', url: `/repos/${repo}/pulls/comments/105` });
  });

  // A dashboard Reply sits beside the finding's only comment on its file.
  it("still takes a lineless finding's only top-level comment after a reply on it", async () => {
    gh.comments = [findingsComment(entries, 7)];
    gh.reviewComments = [
      inline({ body: 'It can spin forever.' }),
      inline({
        id: 102,
        in_reply_to_id: 101,
        user: { login: 'reviewer-bot' },
        body: 'Will fix.',
        created_at: '2026-09-08T11:00:00Z',
      }),
    ];

    const out = await deleteFindingFromReview(
      repo,
      5,
      { ...race, line: null },
      { since: '2026-09-08T09:00:00Z' },
    );

    expect(out.commentDeleted).toBe(true);
    expect(gh.writes[0]).toMatchObject({ method: 'DELETE', url: `/repos/${repo}/pulls/comments/101` });
  });

  // Another finding's follow-up on an old thread at the same line comes first.
  it("never takes another finding's follow-up at the same line as its own comment", async () => {
    gh.comments = [findingsComment(entries, 7)];
    gh.reviewComments = [
      inline({ id: 90, body: 'Old thread', created_at: '2026-09-01T10:00:00Z' }),
      inline({
        id: 105,
        in_reply_to_id: 90,
        user: { login: 'reviewer-bot' },
        body: 'Follow-up: still unfixed.',
        created_at: '2026-09-08T10:05:00Z',
      }),
      inline({ id: 106, created_at: '2026-09-08T10:06:00Z' }),
    ];

    await deleteFindingFromReview(repo, 5, race, { since: '2026-09-08T09:00:00Z' });

    expect(gh.writes[0]).toMatchObject({ method: 'DELETE', url: `/repos/${repo}/pulls/comments/106` });
  });

  it('deletes nothing when comments from two threads share the line and neither quotes the title', async () => {
    gh.comments = [findingsComment(entries, 7)];
    gh.reviewComments = [
      inline({ id: 90, body: 'Old thread', created_at: '2026-09-01T10:00:00Z' }),
      inline({
        id: 105,
        in_reply_to_id: 90,
        user: { login: 'reviewer-bot' },
        body: 'Follow-up: still unfixed.',
        created_at: '2026-09-08T10:05:00Z',
      }),
      inline({ id: 106, body: 'Off by one.', created_at: '2026-09-08T10:06:00Z' }),
    ];

    const out = await deleteFindingFromReview(repo, 5, race, { since: '2026-09-08T09:00:00Z' });

    expect(out.commentDeleted).toBe(false);
    expect(gh.writes.map((w) => w.method)).toEqual(['PATCH']);
  });

  it('counts no reply at all when the token’s own login cannot be read', async () => {
    gh.viewer = null;
    gh.comments = [findingsComment(entries, 7)];
    gh.reviewComments = [
      inline({ created_at: '2026-09-01T10:00:00Z' }),
      inline({ id: 103, in_reply_to_id: 101, user: { login: 'reviewer-bot' }, body: 'Follow-up.' }),
    ];

    const out = await deleteFindingFromReview(repo, 5, race, { since: '2026-09-08T09:00:00Z' });

    expect(out.commentDeleted).toBe(false);
    expect(gh.writes.map((w) => w.method)).toEqual(['PATCH']);
  });

  it('warns when the block cannot be rewritten: the comment is already gone', async () => {
    gh.comments = [findingsComment(entries, 7)];
    gh.reviewComments = [inline()];
    gh.fail = 'PATCH';

    const out = await deleteFindingFromReview(repo, 5, race);

    expect(out.commentDeleted).toBe(true);
    expect(out.undeclared).toBe(false);
    expect(out.warning).toMatch(/answered 500 rewriting the review's findings block/);
  });

  it('fails without touching the block when the comment cannot be deleted', async () => {
    gh.comments = [findingsComment(entries, 7)];
    gh.reviewComments = [inline()];
    gh.fail = 'DELETE';

    await expect(deleteFindingFromReview(repo, 5, race)).rejects.toThrow(
      /answered 500 deleting the finding's review comment/,
    );
    expect(gh.writes.map((w) => w.method)).toEqual(['DELETE']);
  });
});

describe('replyOnFindingThread', () => {
  const race = {
    key: findingKey('Race in the retry loop'),
    title: 'Race in the retry loop',
    file: 'lib/x.js',
    line: 12,
  };
  const inline = (extra = {}) => ({
    id: 101,
    path: 'lib/x.js',
    line: 12,
    body: '**HIGH**: Race in the retry loop',
    html_url: 'https://gh/r/101',
    created_at: '2026-09-08T10:00:00Z',
    ...extra,
  });

  it("replies under the finding's own comment, with the pull request in the path", async () => {
    gh.reviewComments = [inline()];
    gh.created = { html_url: 'https://gh/r/101#reply' };

    const out = await replyOnFindingThread(repo, 5, race, '  Fine for me, this is a one-time command  ');

    expect(out).toEqual({ url: 'https://gh/r/101#reply' });
    expect(gh.writes).toEqual([
      {
        method: 'POST',
        url: `/repos/${repo}/pulls/5/comments/101/replies`,
        body: { body: 'Fine for me, this is a one-time command' },
      },
    ]);
  });

  it('falls back to the thread itself when the reply comes back without a url', async () => {
    gh.reviewComments = [inline()];

    expect(await replyOnFindingThread(repo, 5, race, 'Noted')).toEqual({ url: 'https://gh/r/101' });
  });

  it('writes nothing for an empty reply, or a finding with no thread of its own', async () => {
    gh.reviewComments = [inline()];
    await expect(replyOnFindingThread(repo, 5, race, '   ')).rejects.toThrow(/Write something/);

    gh.reviewComments = [];
    await expect(replyOnFindingThread(repo, 5, race, 'Noted')).rejects.toThrow(
      /no comment of its own on PR #5/,
    );
    expect(gh.writes).toEqual([]);
  });

  it("replies under a restated finding's thread root, not under its follow-up", async () => {
    gh.reviewComments = [
      inline({ created_at: '2026-09-01T10:00:00Z' }),
      inline({
        id: 103,
        in_reply_to_id: 101,
        user: { login: 'Reviewer-Bot' },
        body: 'Follow-up: still unfixed.',
      }),
    ];

    await replyOnFindingThread(repo, 5, race, 'Noted', { since: '2026-09-08T09:00:00Z' });

    expect(gh.writes).toEqual([
      { method: 'POST', url: `/repos/${repo}/pulls/5/comments/101/replies`, body: { body: 'Noted' } },
    ]);
  });

  it('replies under its own new comment, not under a follow-up at the same line', async () => {
    gh.reviewComments = [
      inline({ id: 90, body: 'Old thread', created_at: '2026-09-01T10:00:00Z' }),
      inline({
        id: 105,
        in_reply_to_id: 90,
        user: { login: 'reviewer-bot' },
        body: 'Follow-up: still unfixed.',
        created_at: '2026-09-08T10:05:00Z',
      }),
      inline({ id: 106, created_at: '2026-09-08T10:06:00Z' }),
    ];

    await replyOnFindingThread(repo, 5, race, 'Noted', { since: '2026-09-08T09:00:00Z' });

    expect(gh.writes).toEqual([
      { method: 'POST', url: `/repos/${repo}/pulls/5/comments/106/replies`, body: { body: 'Noted' } },
    ]);
  });

  it("replies again on a lineless finding's only comment after an earlier reply", async () => {
    gh.reviewComments = [
      inline({ body: 'It can spin forever.' }),
      inline({
        id: 102,
        in_reply_to_id: 101,
        user: { login: 'reviewer-bot' },
        body: 'Noted',
        created_at: '2026-09-08T11:00:00Z',
      }),
    ];

    await replyOnFindingThread(repo, 5, { ...race, line: null }, 'Still noted', {
      since: '2026-09-08T09:00:00Z',
    });

    expect(gh.writes).toEqual([
      { method: 'POST', url: `/repos/${repo}/pulls/5/comments/101/replies`, body: { body: 'Still noted' } },
    ]);
  });

  it("never replies under someone else's reply on an unrelated thread at the same line", async () => {
    gh.reviewComments = [
      inline({ id: 90, body: 'Unrelated old thread', created_at: '2026-09-01T10:00:00Z' }),
      inline({ id: 91, in_reply_to_id: 90, user: { login: 'pr-author' }, body: 'Done.' }),
    ];

    await expect(
      replyOnFindingThread(repo, 5, race, 'Noted', { since: '2026-09-08T09:00:00Z' }),
    ).rejects.toThrow(/no comment of its own on PR #5/);
    expect(gh.writes).toEqual([]);
  });

  it('says what GitHub refused', async () => {
    gh.reviewComments = [inline()];
    gh.fail = 'POST';

    await expect(replyOnFindingThread(repo, 5, race, 'Noted')).rejects.toThrow(
      /answered 500 replying on the finding's thread/,
    );
  });
});
