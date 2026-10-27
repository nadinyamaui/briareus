import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
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

  it.each(['-', '+', '*', '1.', '2)', '- -', '-\t'])(
    'retains custom results whose header starts on list marker %s',
    async (marker) => {
      const indent = ' '.repeat(marker === '-\t' ? 5 : marker.length + 1);
      gh.comments = [
        sheet([
          '| 1 | API | curl | 200 | ✅ | response.json |',
          '',
          `${marker} | Caso | Conducta | Acción | Esperado | Comprobación | Prueba |`,
          `${indent}|---|---|---|---|---|---|`,
          `${indent}| 2 | UI | Open | Visible | ❌ | saw nothing |`,
        ]),
      ];
      expect(await latestTestVerdict(repo, 5)).toEqual({
        failures: [{ number: '2', scenario: 'UI', expected: 'Visible', evidence: 'saw nothing' }],
        total: 2,
        passed: 1,
        manual: 0,
        incomplete: false,
      });
    },
  );

  it.each([
    ['-     ', '      ', ''],
    ['- ```\n  ', '  ', '\n  ```'],
    ['-     ```\n      ', '      ', '\n      ```'],
  ])('excludes custom list tables inside code: %j', async (prefix, indent, suffix) => {
    gh.comments = [
      sheet([
        '| 1 | API | curl | 200 | ✅ | response.json |',
        '',
        `${prefix}| Caso | Conducta | Acción | Esperado | Comprobación | Prueba |`,
        `${indent}|---|---|---|---|---|---|`,
        `${indent}| 2 | UI | Open | Visible | ❌ | saw nothing |${suffix}`,
      ]),
    ];
    expect(await latestTestVerdict(repo, 5)).toMatchObject({
      failures: [],
      total: 1,
      passed: 1,
      incomplete: false,
    });
  });

  it('keeps custom marker lookahead within the list container', async () => {
    gh.comments = [
      sheet([
        '| 1 | API | curl | 200 | ✅ | response.json |',
        '',
        '| a | b | c | d | e | f |',
        '|---|---|---|---|---|---|',
        '| 200 | Resource | GET | /resource | 200 | response.json |',
        '- | Caso | Conducta | Acción | Esperado | Comprobación | Prueba |',
        '  |---|---|---|---|---|---|',
        '  | 2 | UI | Open | Visible | ❌ | saw nothing |',
      ]),
    ];
    expect(await latestTestVerdict(repo, 5)).toEqual({
      failures: [{ number: '2', scenario: 'UI', expected: 'Visible', evidence: 'saw nothing' }],
      total: 2,
      passed: 1,
      manual: 0,
      incomplete: false,
    });
  });

  it.each(['To be recorded.json', 'Awaiting recording.webm', 'Nothing was tested.json'])(
    'preserves artifact filenames resembling the new absence declarations: %s',
    async (evidence) => {
      gh.comments = [sheet([`| 1 | API | curl | 200 | ✅ | ${evidence} |`])];
      expect(await latestTestVerdict(repo, 5)).toMatchObject({ total: 1, passed: 1, incomplete: false });
    },
  );

  it.each(['To be recorded', 'Awaiting recording', 'N/A pending execution', 'Nothing was tested'])(
    'rejects the remaining whole-cell evidence declarations: %s',
    async (absence) => {
      for (const evidence of [absence, `**${absence}**`, `<span>${absence}</span>`, `Evidence: ${absence}`]) {
        gh.comments = [sheet([`| 1 | API | curl | 200 | ✅ | ${evidence} |`])];
        expect(await latestTestVerdict(repo, 5)).toMatchObject({ total: 1, passed: 0, incomplete: true });
      }
      gh.comments = [
        sheet([`| 1 | Message | Run | Expected message | ✅ | ${absence} was shown as expected |`]),
      ];
      expect(await latestTestVerdict(repo, 5)).toMatchObject({ total: 1, passed: 1, incomplete: false });
    },
  );

  it.each(['To be recorded', 'Awaiting recording'])(
    'preserves retained evidence alongside recording deferral: %s',
    async (absence) => {
      for (const retained of ['response.json', 'curl returned 200 as expected']) {
        for (const evidence of [`${absence}; ${retained}`, `${retained}; ${absence}`]) {
          gh.comments = [sheet([`| 1 | API | curl | 200 | ✅ | ${evidence} |`])];
          expect(await latestTestVerdict(repo, 5)).toMatchObject({ total: 1, passed: 1, incomplete: false });
        }
      }
    },
  );

  it.each([
    'UI run failed',
    'UI has no coverage',
    'UI execution is on hold',
    'UI was abandoned',
    'Nothing was tested',
    'N/A pending execution',
  ])('vetoes unfinished work even with retained response evidence: %s', async (annotation) => {
    for (const [status, evidence] of [
      [`✅ API; ${annotation}`, 'response.json'],
      ['✅ API', `${annotation}; response.json`],
      ['✅ API', `response.json; ${annotation}`],
    ]) {
      gh.comments = [sheet([`| 1 | API and UI | curl then browser | Both work | ${status} | ${evidence} |`])];
      expect(await latestTestVerdict(repo, 5)).toMatchObject({ total: 1, passed: 0, incomplete: true });
    }
  });

  it.each([
    ['Both work', 'UI run completed successfully'],
    ['Both work', 'UI has full coverage'],
    ['HTTP 403', 'UI run failed with 403 Forbidden as expected'],
    ['Abandoned order is displayed', 'UI abandoned order is displayed'],
    ['On hold order is displayed', 'UI on hold order is displayed'],
  ])('preserves completed runs and business observations: %s / %s', async (expected, annotation) => {
    for (const [status, evidence] of [
      [`✅ API; ${annotation}`, 'response.json'],
      ['✅ API', `${annotation}; response.json`],
    ]) {
      gh.comments = [
        sheet([`| 1 | API and UI | curl then browser | ${expected} | ${status} | ${evidence} |`]),
      ];
      expect(await latestTestVerdict(repo, 5)).toMatchObject({ total: 1, passed: 1, incomplete: false });
    }
  });

  it.each(['-- skipped', '--- blocked', '--: not run', '--- never tested'])(
    'reads wordless execution prefixes without losing later failures: %s',
    async (annotation) => {
      for (const [status, evidence] of [
        [`✅ ${annotation}`, 'response.json'],
        ['✅', annotation],
      ]) {
        gh.comments = [
          sheet([
            `| 1 | API | curl /api | 200 | ${status} | ${evidence} |`,
            '| 2 | Failure | curl /api | 200 | ❌ | saw 500 |',
            '| 3 | API | curl /api | 200 | ✅ | response.json |',
          ]),
        ];
        expect(await latestTestVerdict(repo, 5)).toEqual({
          failures: [{ number: '2', scenario: 'Failure', expected: '200', evidence: 'saw 500' }],
          total: 3,
          passed: 1,
          manual: 0,
          incomplete: true,
        });
      }
    },
  );

  it.each([
    'UI status: failed',
    'UI status: blocked',
    'UI status: skipped',
    'UI status: FAIL',
    'FAIL',
    'Manual verification needed',
  ])('keeps explicit execution qualifiers incomplete: %s', async (annotation) => {
    for (const [status, evidence] of [
      [`✅ API; ${annotation}`, 'response.json'],
      ['✅', annotation],
      ['✅', `response.json; ${annotation}`],
    ]) {
      // Bare FAIL is a Status verdict; ordinary Evidence prose keeps its existing contract.
      if (annotation === 'FAIL' && status === '✅') continue;
      gh.comments = [sheet([`| 1 | API and UI | curl then browser | Both work | ${status} | ${evidence} |`])];
      expect(await latestTestVerdict(repo, 5)).toEqual({
        failures: [],
        total: 1,
        passed: 0,
        manual: 0,
        incomplete: true,
      });
    }
  });

  it.each(['Evidence to follow', 'Pending evidence', 'No evidence available for any scenario'])(
    'rejects deferred or universally absent evidence without losing retained observations: %s',
    async (absence) => {
      for (const evidence of [absence, `**${absence}**`, `<span>${absence}</span>`, `Evidence: ${absence}`]) {
        gh.comments = [sheet([`| 1 | API | curl /api | 200 | ✅ | ${evidence} |`])];
        expect(await latestTestVerdict(repo, 5)).toMatchObject({ total: 1, passed: 0, incomplete: true });
      }
      for (const retained of ['response.json', 'curl returned 200 and asserted the response body']) {
        for (const evidence of [`${absence}; ${retained}`, `${retained}; ${absence}`]) {
          gh.comments = [sheet([`| 1 | API | curl /api | 200 | ✅ | ${evidence} |`])];
          expect(await latestTestVerdict(repo, 5)).toMatchObject({ total: 1, passed: 1, incomplete: false });
        }
      }
      gh.comments = [
        sheet([`| 1 | API | curl /api | Expected message | ✅ | ${absence} was displayed as expected |`]),
      ];
      expect(await latestTestVerdict(repo, 5)).toMatchObject({ total: 1, passed: 1, incomplete: false });
    },
  );

  it.each([
    ['Both work', 'UI status: passed', 'response.json'],
    ['Both work', 'UI manual verification passed', 'response.json'],
    ['HTTP 403', 'API status: failed with 403 Forbidden as expected', 'response.json'],
    ['Blocked user receives 403', 'API status: blocked user receives 403', 'response.json'],
    ['Expected message', 'API', 'Manual verification needed was displayed as expected'],
    ['HTTP 200', 'API', 'evidence-to-follow.json'],
    ['HTTP 200', 'API', 'pending-evidence.json'],
  ])('preserves evidenced passing execution qualifiers: %s / %s / %s', async (expected, status, evidence) => {
    gh.comments = [
      sheet([`| 1 | API and UI | curl then browser | ${expected} | ✅ ${status} | ${evidence} |`]),
    ];
    expect(await latestTestVerdict(repo, 5)).toMatchObject({ total: 1, passed: 1, incomplete: false });
  });

  it.each([
    ['Request Timeout', 'API failed with 408 Request Timeout as expected'],
    ['Conflict', 'API failed with 409 Conflict as expected'],
    ['Bad Request', 'API failed with 400 Bad Request as expected'],
    ['Manual approval is required', 'API requires manual approval as expected'],
    ['Manual approval required', 'API requires manual approval as expected'],
  ])('accepts equivalent expected business outcomes: %s', async (expected, outcome) => {
    for (const [status, evidence] of [
      [`✅ ${outcome}`, 'response.json'],
      ['✅', `${outcome}; response.json`],
    ]) {
      for (const unfinished of ['', '; UI not tested', '; UI setup failed']) {
        gh.comments = [
          sheet([
            `| 1 | Negative check | curl then browser | ${expected} | ${status}${unfinished} | ${evidence} |`,
          ]),
        ];
        expect(await latestTestVerdict(repo, 5)).toMatchObject({
          total: 1,
          passed: unfinished ? 0 : 1,
          incomplete: !!unfinished,
        });
      }
    }
  });

  it.each([
    ['HTTP 409 Request Timeout', 'API failed with 408 Request Timeout as expected'],
    ['Request Timeout', 'API failed with 409 Conflict as expected'],
    ['Request Timeout', 'UI setup failed with 408 Request Timeout as expected'],
    ['HTTP 400 Conflict', 'API failed with 409 Conflict as expected'],
    ['HTTP 409 Bad Request', 'API failed with 400 Bad Request as expected'],
    ['Bad Request', 'API failed with 409 Conflict as expected'],
    ['Conflict', 'API failed with 400 Bad Request as expected'],
    ['Conflict', 'UI setup failed with 409 Conflict as expected'],
    ['Automatic approval is required', 'API requires manual approval as expected'],
    ['Manual approval is not required', 'API requires manual approval as expected'],
  ])('keeps mismatched equivalent business outcomes incomplete: %s', async (expected, outcome) => {
    gh.comments = [
      sheet([`| 1 | Negative check | curl then browser | ${expected} | ✅ | ${outcome}; response.json |`]),
    ];
    expect(await latestTestVerdict(repo, 5)).toMatchObject({ total: 1, passed: 0, incomplete: true });
  });

  it.each([
    '❌ UI failed',
    'UI ❌',
    'No test execution occurred',
    'No execution took place because the test environment was unavailable',
    'No requests were executed.',
    'I did not execute this scenario.',
    'Run not attempted due to missing credentials.',
    'Did not execute this scenario',
    'Skipped this scenario',
    'No request was sent',
    'No execution happened',
    'None of the scenarios were executed',
  ])('vetoes explicit nonexecution alongside retained artifacts: %s', async (annotation) => {
    for (const evidence of [
      `response.json; ${annotation}`,
      `${annotation}; response.json`,
      `response.json<br>**${annotation}**`,
      `Evidence: ${annotation}; response.json`,
    ]) {
      gh.comments = [sheet([`| 1 | API and UI | curl then browser | Both work | ✅ API | ${evidence} |`])];
      expect(await latestTestVerdict(repo, 5)).toMatchObject({
        failures: [],
        total: 1,
        passed: 0,
        incomplete: true,
      });
    }
  });

  it.each([
    'No evidence has been gathered',
    'Response evidence will be provided later',
    'No execution happened',
    'None of the scenarios were executed',
  ])('rejects further whole-cell absence declarations: %s', async (absence) => {
    for (const evidence of [absence, `**${absence}**`, `<span>${absence}</span>`, `Evidence: ${absence}`]) {
      gh.comments = [sheet([`| 1 | API | curl | HTTP 200 | ✅ | ${evidence} |`])];
      expect(await latestTestVerdict(repo, 5)).toMatchObject({ total: 1, passed: 0, incomplete: true });
    }
    gh.comments = [sheet([`| 1 | API | curl | Expected message | ✅ | ${absence} was shown as expected |`])];
    expect(await latestTestVerdict(repo, 5)).toMatchObject({ total: 1, passed: 1, incomplete: false });
  });

  it.each(['No evidence has been gathered', 'Response evidence will be provided later'])(
    'preserves separate observations after capture-only absence: %s',
    async (absence) => {
      for (const retained of ['response.json', 'curl returned 200 as expected']) {
        for (const evidence of [`${absence}; ${retained}`, `${retained}; ${absence}`]) {
          gh.comments = [sheet([`| 1 | API | curl | HTTP 200 | ✅ | ${evidence} |`])];
          expect(await latestTestVerdict(repo, 5)).toMatchObject({ total: 1, passed: 1, incomplete: false });
        }
      }
    },
  );

  it.each(['No testing performed', 'Untested', 'unexecuted', 'Manual verification required'])(
    'keeps explicit unexecuted annotations incomplete alongside artifacts: %s',
    async (annotation) => {
      for (const evidence of [
        `response.json; ${annotation}`,
        `${annotation}; response.json`,
        `response.json<br>**${annotation}**`,
      ]) {
        gh.comments = [sheet([`| 1 | API and UI | curl then browser | Both work | ✅ | ${evidence} |`])];
        expect(await latestTestVerdict(repo, 5)).toEqual({
          failures: [],
          total: 1,
          passed: 0,
          manual: 0,
          incomplete: true,
        });
      }
    },
  );

  it.each(['⏳ UI', 'UI ⏳', 'UI —', 'UI not undertaken'])(
    'keeps named pending or unknown subprocedures incomplete: %s',
    async (annotation) => {
      for (const [status, evidence] of [
        [`✅ API; ${annotation}`, 'response.json'],
        ['✅', `response.json; ${annotation}`],
      ]) {
        gh.comments = [
          sheet([`| 1 | API and UI | curl then browser | Both work | ${status} | ${evidence} |`]),
        ];
        expect(await latestTestVerdict(repo, 5)).toMatchObject({ total: 1, passed: 0, incomplete: true });
      }
    },
  );

  it.each(['Will add evidence after deployment', 'Evidence was never gathered'])(
    'rejects promised or ungathered evidence while retaining separate observations: %s',
    async (absence) => {
      for (const evidence of [absence, `**${absence}**`, `<span>${absence}</span>`, `Evidence: ${absence}`]) {
        gh.comments = [sheet([`| 1 | API | curl /api | Works | ✅ | ${evidence} |`])];
        expect(await latestTestVerdict(repo, 5)).toMatchObject({ total: 1, passed: 0, incomplete: true });
      }
      for (const retained of ['response.json', 'curl returned 200 and asserted the response body']) {
        for (const evidence of [`${absence}; ${retained}`, `${retained}; ${absence}`]) {
          gh.comments = [sheet([`| 1 | API | curl /api | Works | ✅ | ${evidence} |`])];
          expect(await latestTestVerdict(repo, 5)).toMatchObject({ total: 1, passed: 1, incomplete: false });
        }
      }
      gh.comments = [
        sheet([`| 1 | API | curl /api | Expected message | ✅ | ${absence} was displayed as expected |`]),
      ];
      expect(await latestTestVerdict(repo, 5)).toMatchObject({ total: 1, passed: 1, incomplete: false });
    },
  );

  it.each([
    ['Unauthorized', 'API failed with 401 Unauthorized as expected'],
    ['Not Found', 'API failed with 404 Not Found as expected'],
    ['Validation rejects malformed payload', 'API failed with 422 validation error as expected'],
    ['UI validation error is shown', 'UI failed validation as expected'],
    ['The connection attempt times out gracefully', 'API timed out as expected'],
  ])('accepts plain-language expected negative observations: %s', async (expected, outcome) => {
    for (const [status, evidence] of [
      [`✅ ${outcome}`, 'response.json'],
      ['✅', `${outcome}; response.json`],
    ]) {
      for (const unfinished of ['', '; UI not tested', '; UI setup failed']) {
        gh.comments = [
          sheet([
            `| 1 | Negative check | curl then browser | ${expected} | ${status}${unfinished} | ${evidence} |`,
          ]),
        ];
        expect(await latestTestVerdict(repo, 5)).toMatchObject({
          total: 1,
          passed: unfinished ? 0 : 1,
          incomplete: !!unfinished,
        });
      }
    }
  });

  it.each([
    ['HTTP 403 Unauthorized', 'API failed with 401 Unauthorized as expected'],
    ['Unauthorized', 'API failed with 500 internal server error as expected'],
    ['HTTP 403 Not Found', 'API failed with 404 Not Found as expected'],
    ['Unauthorized', 'API failed with 404 Not Found as expected'],
    ['Not Found', 'API failed with 403 Forbidden as expected'],
    ['Not Found', 'UI setup failed with 404 Not Found as expected'],
    ['Validation rejects malformed payload', 'API failed with 500 validation error as expected'],
    ['Validation rejects malformed payload', 'UI setup failed as expected'],
    ['HTTP 400 validation error', 'API failed with 422 validation error as expected'],
    ['The connection succeeds', 'API timed out as expected'],
    ['The connection times out gracefully', 'UI setup failed as expected'],
  ])('rejects mismatched plain-language negative observations: %s / %s', async (expected, outcome) => {
    gh.comments = [
      sheet([`| 1 | Negative check | curl then browser | ${expected} | ✅ | ${outcome}; response.json |`]),
    ];
    expect(await latestTestVerdict(repo, 5)).toMatchObject({ total: 1, passed: 0, incomplete: true });
  });

  it.each([
    'Manual verification required',
    'Did not execute any tests',
    'Awaiting manual testing',
    'Not attempted',
    'No curl requests made',
    'The scenario remains untested',
    'Untested',
    'unexecuted',
    'No testing performed',
  ])('rejects whole-cell missing execution evidence: %s', async (evidence) => {
    gh.comments = [sheet([`| 1 | API and UI | curl then browser | Both work | ✅ | ${evidence} |`])];
    expect(await latestTestVerdict(repo, 5)).toEqual({
      failures: [],
      total: 1,
      passed: 0,
      manual: 0,
      incomplete: true,
    });
  });

  it.each([
    ['UI 80% of steps executed', false],
    ['UI only 80 percent of the checks verified', false],
    ['UI 80% of tests completed', false],
    ['UI 80% of assertions checked', false],
    ['UI 80% of scenarios tested', false],
    ['UI 100% of steps executed', true],
    ['UI 100 percent of the checks verified', true],
    ['UI displayed 80% of steps executed as expected', true],
  ])('checks qualified procedure percentages: %s', async (annotation, complete) => {
    for (const [status, evidence] of [
      [`✅ API passed; ${annotation}`, 'response.json'],
      ['✅', `response.json; ${annotation}`],
    ]) {
      gh.comments = [sheet([`| 1 | API and UI | curl then browser | Both work | ${status} | ${evidence} |`])];
      expect(await latestTestVerdict(repo, 5)).toMatchObject({
        total: 1,
        passed: complete ? 1 : 0,
        incomplete: !complete,
      });
    }
  });

  it.each(['outstanding coverage', 'UI will be performed later'])(
    'rejects explicitly outstanding or future coverage: %s',
    async (annotation) => {
      for (const [status, evidence] of [
        [`✅ API passed; ${annotation}`, 'response.json'],
        ['✅', `response.json; ${annotation}`],
      ]) {
        gh.comments = [
          sheet([`| 1 | API and UI | curl then browser | Both work | ${status} | ${evidence} |`]),
        ];
        expect(await latestTestVerdict(repo, 5)).toMatchObject({ total: 1, passed: 0, incomplete: true });
      }
    },
  );

  it.each([
    'Evidence not supplied',
    'TBD after deploy',
    'Evidence was never provided',
    'Evidence was never supplied',
  ])('rejects qualified missing evidence placeholders: %s', async (absence) => {
    for (const evidence of [absence, `**${absence}**`, `Evidence: ${absence}`]) {
      gh.comments = [sheet([`| 1 | API | curl /api | Works | ✅ | ${evidence} |`])];
      expect(await latestTestVerdict(repo, 5)).toMatchObject({ total: 1, passed: 0, incomplete: true });
    }
    for (const retained of ['response.json', 'curl returned 200 and asserted the response body']) {
      for (const evidence of [`${absence}; ${retained}`, `${retained}; ${absence}`]) {
        gh.comments = [sheet([`| 1 | API | curl /api | Works | ✅ | ${evidence} |`])];
        expect(await latestTestVerdict(repo, 5)).toMatchObject({ total: 1, passed: 1, incomplete: false });
      }
    }
  });

  it.each([
    'UI manual verification passed',
    'UI was performed successfully',
    'UI displayed Manual verification required as expected',
    'UI displayed Awaiting manual testing as expected',
    'UI displayed Evidence not supplied as expected',
    'UI displayed TBD after deploy as expected',
    'UI displayed Untested as expected',
    'UI displayed No testing performed as expected',
    'UI displayed Evidence was never provided as expected',
  ])('preserves completed or observed execution declarations: %s', async (annotation) => {
    gh.comments = [
      sheet([`| 1 | API and UI | curl then browser | Both work | ✅ | ${annotation}; response.json |`]),
    ];
    expect(await latestTestVerdict(repo, 5)).toMatchObject({ total: 1, passed: 1, incomplete: false });
  });

  it.each([
    '50% of UI tested',
    'UI 50 percent tested',
    'Browser process exited before testing',
    'API was never called',
    'Pending execution',
    'Pending verification',
    'Partial coverage',
    'Incomplete coverage',
    'Manual verification required',
    'Result: UI tests not executed',
  ])('rejects explicit unfinished execution declarations: %s', async (annotation) => {
    const cases = [[`✅ API; ${annotation}`, 'response.json']];
    // Bare Evidence placeholders can accompany a retained artifact; named unrun procedures cannot.
    if (!/^(?:Pending|Partial|Incomplete|Manual)\b/.test(annotation))
      cases.push(['✅', `${annotation}; response.json`]);
    for (const [status, evidence] of cases) {
      gh.comments = [sheet([`| 1 | API and UI | curl then browser | Both work | ${status} | ${evidence} |`])];
      expect(await latestTestVerdict(repo, 5)).toEqual({
        failures: [],
        total: 1,
        passed: 0,
        manual: 0,
        incomplete: true,
      });
    }
  });

  it.each([
    '100% of UI tested',
    'UI 100 percent tested',
    'Browser process exited after testing',
    'API was called',
    'Result: UI tests executed',
    'UI manual verification passed',
    'UI displayed Pending execution as expected',
    'UI displayed Partial coverage as expected',
    'UI displayed Manual verification required as expected',
    'blocked user receives 403',
    'pending payment is displayed',
  ])('preserves completed coverage and observed business states: %s', async (annotation) => {
    for (const [status, evidence] of [
      [`✅ ${annotation}`, 'response.json'],
      ['✅', `response.json; ${annotation}`],
    ]) {
      for (const unfinished of ['', '; UI not tested']) {
        gh.comments = [
          sheet([
            `| 1 | API and UI | curl then browser | Both work | ${status}${unfinished} | ${evidence} |`,
          ]),
        ];
        expect(await latestTestVerdict(repo, 5)).toMatchObject({
          total: 1,
          passed: unfinished ? 0 : 1,
          incomplete: !!unfinished,
        });
      }
    }
  });

  it.each([
    'UI execution has yet to occur',
    'UI tests scheduled',
    'UI: Error: cannot start browser',
    'UI result: ???',
  ])('rejects unstarted, failed-start and unknown procedures: %s', async (annotation) => {
    for (const retained of ['response.json', '[API](https://example.com/a.json)']) {
      for (const [status, evidence] of [
        [`✅ API; ${annotation}`, retained],
        ['✅ API', `${retained}; ${annotation}`],
      ]) {
        gh.comments = [
          sheet([`| 1 | API and UI | curl then browser | Both work | ${status} | ${evidence} |`]),
        ];
        expect(await latestTestVerdict(repo, 5)).toEqual({
          failures: [],
          total: 1,
          passed: 0,
          manual: 0,
          incomplete: true,
        });
      }
    }
  });

  it.each([
    'UI execution has occurred',
    'UI tests executed',
    'UI displayed execution has yet to occur as expected',
    'UI showed tests scheduled as expected',
    'UI result: ??? was displayed as expected',
  ])('preserves executed procedures and displayed execution wording: %s', async (annotation) => {
    for (const [status, evidence] of [
      [`✅ API; ${annotation}`, 'response.json'],
      ['✅ API', `response.json; ${annotation}`],
    ]) {
      for (const unfinished of ['', '; UI not tested']) {
        gh.comments = [
          sheet([
            `| 1 | API and UI | curl then browser | Both work | ${status}${unfinished} | ${evidence} |`,
          ]),
        ];
        expect(await latestTestVerdict(repo, 5)).toMatchObject({
          total: 1,
          passed: unfinished ? 0 : 1,
          incomplete: !!unfinished,
        });
      }
    }
  });

  it.each([
    'UI only 50% tested',
    'UI only 0% tested',
    'UI only 99.5% tested',
    'UI coverage: only 50%',
    'UI: testing planned',
    'UI testing is planned',
    'UI testing planned for tomorrow',
    'UI did not perform',
    "UI didn't perform",
    'UI 50% tested',
    'UI 0% tested',
    'UI 99.5% tested',
    'UI remaining 2 checks',
    'UI remaining checks: 2',
    'UI remaining 1 test',
    'UI tests 1/2 verified',
    'UI 1 of 2 assertions verified',
    'UI: verified 1 of 2 checks',
    'UI 50% verified',
    'UI partially run',
    'UI checks not all finished',
    'UI checks have not all been finished',
    'API requests were not sent',
  ])('retains partial verification and unsent requests as incomplete: %s', async (annotation) => {
    for (const [status, evidence] of [
      [`✅ API passed; ${annotation}`, 'response.json'],
      ['✅', annotation],
      ['✅', `response.json; ${annotation}`],
    ]) {
      gh.comments = [sheet([`| 1 | API and UI | curl then browser | Both work | ${status} | ${evidence} |`])];
      expect(await latestTestVerdict(repo, 5)).toMatchObject({
        failures: [],
        total: 1,
        passed: 0,
        incomplete: true,
      });
    }
  });

  it.each([
    'UI only 100% tested',
    'UI coverage: only 100%',
    'UI testing performed',
    'UI displayed only 50% tested as expected',
    'UI testing planned was displayed as expected',
    'UI did not perform was shown as expected',
    'UI 100% tested',
    'UI remaining 0 checks',
    'UI remaining checks: 0',
    'UI displayed 50% tested as expected',
    'UI showed remaining 2 checks as expected',
    'UI tests 2/2 verified',
    'UI 2 of 2 assertions verified',
    'UI: verified 2 of 2 checks',
    'UI 100% verified',
    'UI fully run',
    'UI checks all finished',
    'API requests were sent',
    'UI displayed 50% verified as expected',
    'UI showed checks not all finished as expected',
    'API requests were not sent was displayed as expected',
  ])('preserves complete verification and observed execution messages: %s', async (annotation) => {
    for (const [status, evidence] of [
      [`✅ ${annotation}`, 'response.json'],
      ['✅', annotation],
    ]) {
      gh.comments = [sheet([`| 1 | API and UI | curl then browser | Both work | ${status} | ${evidence} |`])];
      expect(await latestTestVerdict(repo, 5)).toMatchObject({ total: 1, passed: 1, incomplete: false });
    }
  });

  it.each(['⚠️ ', '- ', '+ ', '• ', 'NOTE: ', '⚠️ NOTE: '])(
    'recognizes decorated execution subjects in evidence: %s',
    async (prefix) => {
      for (const annotation of ['UI not tested', 'UI not run', 'UI 50% tested', 'UI remaining 2 checks']) {
        gh.comments = [
          sheet([
            `| 1 | API and UI | curl then browser | Both work | ✅ | response.json; ${prefix}${annotation} |`,
          ]),
        ];
        expect(await latestTestVerdict(repo, 5)).toMatchObject({ total: 1, passed: 0, incomplete: true });
      }
      for (const annotation of [
        'UI 100% tested',
        'UI remaining 0 checks',
        'UI displayed not tested as expected',
        'UI showed remaining 2 checks as expected',
        'response.json',
      ]) {
        gh.comments = [
          sheet([
            `| 1 | API and UI | curl then browser | Both work | ✅ | response.json; ${prefix}${annotation} |`,
          ]),
        ];
        expect(await latestTestVerdict(repo, 5)).toMatchObject({ total: 1, passed: 1, incomplete: false });
      }
    },
  );

  it.each(['UI 1/2 steps done', 'UI: done 1 of 2 checks', 'UI unchecked'])(
    'keeps unfinished progress and unchecked procedures incomplete: %s',
    async (annotation) => {
      for (const [status, evidence] of [
        [`✅ API passed; ${annotation}`, 'response.json'],
        ['✅ API passed', `response.json; ${annotation}`],
      ]) {
        gh.comments = [
          sheet([`| 1 | API and UI | curl then browser | Both work | ${status} | ${evidence} |`]),
        ];
        expect(await latestTestVerdict(repo, 5)).toMatchObject({ total: 1, passed: 0, incomplete: true });
      }
    },
  );

  it.each([
    'API: 50% executed',
    'UI 50% done',
    'UI is partially complete',
    'API: 2 of 4 tests finished',
    'API execution did not occur',
    'Execution has yet to start',
    'UI could not get started',
    'UI has been left untested',
    'unknown result',
    'status: unknown',
    'result: unknown',
    '(result unknown)',
  ])('retains explicit progress and unknown verdicts as incomplete: %s', async (annotation) => {
    for (const [status, evidence] of [
      [`✅ API passed; ${annotation}`, 'response.json'],
      ['✅', annotation],
      ['✅', `response.json; ${annotation}`],
    ]) {
      gh.comments = [sheet([`| 1 | API and UI | curl then browser | Both work | ${status} | ${evidence} |`])];
      expect(await latestTestVerdict(repo, 5)).toMatchObject({ total: 1, passed: 0, incomplete: true });
    }
  });

  it.each([
    'API: 100% executed',
    'UI 100% done',
    'UI is complete',
    'API: 4 of 4 tests finished',
    'API execution did occur',
    'Execution has started',
    'UI got started and completed',
    'UI displayed unknown result as expected',
    'UI showed status: unknown as expected',
    'UI displayed 50% done as expected',
  ])('preserves full execution and displayed progress: %s', async (annotation) => {
    for (const [status, evidence] of [
      [`✅ ${annotation}`, 'response.json'],
      ['✅', `response.json; ${annotation}`],
    ]) {
      gh.comments = [sheet([`| 1 | API and UI | curl then browser | Both work | ${status} | ${evidence} |`])];
      expect(await latestTestVerdict(repo, 5)).toMatchObject({ total: 1, passed: 1, incomplete: false });
    }
  });

  it.each([
    'Evidence is not yet ready',
    'No evidence exists for PR #196.',
    'Evidence: none recorded',
    'No evidence for this execution',
    'No evidence has been recorded for this PR.',
    'No evidence has been recorded for the PR',
    'No evidence has been recorded for this pull request',
    'No evidence was collected for the pull request.',
    'Not recorded for this PR',
    'No evidence was attached to the PR',
    'No evidence was attached to the PR.',
    'No evidence was attached to this pull request',
    'No evidence was uploaded to the pull request',
    'Evidence will be uploaded later',
    'No evidence was attached to this comment',
    'Evidence collection is still pending',
    'TODO: run browser checks',
    'No evidence available at this time',
    'No test execution occurred',
    'Pending execution',
    'No requests were executed.',
    'I did not execute this scenario.',
    'Run not attempted due to missing credentials.',
    'The video is unavailable.',
    'TBD (upload pending)',
    'Evidence awaiting upload',
    'Evidence is still pending upload',
    'Waiting for evidence',
    'Evidence was never captured',
    'None available',
    'Execution evidence has been lost',
    'No actual evidence',
    'No execution took place because the test environment was unavailable',
  ])('rejects qualified absence while retaining separate observations: %s', async (absence) => {
    const unexecuted = [
      'No test execution occurred',
      'No requests were executed.',
      'I did not execute this scenario.',
      'Run not attempted due to missing credentials.',
      'No execution took place because the test environment was unavailable',
    ].includes(absence);
    for (const evidence of [absence, `**${absence}**`, `<span>${absence}</span>`, `Evidence: ${absence}`]) {
      gh.comments = [sheet([`| 1 | API | curl | HTTP 200 | ✅ | ${evidence} |`])];
      expect(await latestTestVerdict(repo, 5)).toMatchObject({ total: 1, passed: 0, incomplete: true });
    }
    for (const retained of ['response.json', 'curl returned 200 as expected']) {
      for (const evidence of [`${absence}; ${retained}`, `${retained}; ${absence}`]) {
        gh.comments = [sheet([`| 1 | API | curl | HTTP 200 | ✅ | ${evidence} |`])];
        expect(await latestTestVerdict(repo, 5)).toMatchObject({
          total: 1,
          passed: unexecuted ? 0 : 1,
          incomplete: unexecuted,
        });
      }
    }
    gh.comments = [sheet([`| 1 | API | curl | Expected message | ✅ | ${absence} was shown as expected |`])];
    expect(await latestTestVerdict(repo, 5)).toMatchObject({ total: 1, passed: 1, incomplete: false });
  });

  it.each([
    ['Returns HTTP 429 when rate limited', 'API failed with HTTP 429 rate limited as expected'],
    ['HTTP 400 or HTTP 422 for invalid payload', 'API failed with HTTP 422 as expected'],
    ['HTTP 422 for invalid payload', 'API failed with HTTP 422: name is required'],
    ['The purchase requires manual approval', 'UI requires manual approval as expected'],
    ['Order scheduled for tomorrow', 'UI scheduled for tomorrow as expected'],
    [
      'Cannot start browser message is displayed',
      'UI: Error: cannot start browser was displayed as expected',
    ],
    ['Setup did not succeed message is displayed', 'UI setup did not succeed was displayed as expected'],
    ['HTTP 200 with pending=0', 'API pending=0'],
    ['HTTP 200 with pending-count: 0', 'API pending-count: 0'],
    ['No results, result count=0', 'Nothing matched (asserted result count=0)'],
    ['No request is sent, network request count=0', 'No request was sent (asserted network request count=0)'],
  ])('preserves matching business observations: %s / %s', async (expected, observation) => {
    for (const [status, evidence] of [
      [`✅ ${observation}`, 'response.json'],
      ['✅', `${observation}; video.webm`],
    ]) {
      for (const unfinished of ['', '; UI not tested']) {
        gh.comments = [
          sheet([`| 1 | Negative check | Run check | ${expected} | ${status}${unfinished} | ${evidence} |`]),
        ];
        expect(await latestTestVerdict(repo, 5)).toMatchObject({
          total: 1,
          passed: unfinished ? 0 : 1,
          incomplete: !!unfinished,
        });
      }
    }
    gh.comments = [sheet([`| 1 | Negative check | Run check | ${expected} | ✅ | ${observation} |`])];
    expect(await latestTestVerdict(repo, 5)).toMatchObject({ total: 1, passed: 1, incomplete: false });
  });

  it.each([
    ['HTTP 200', 'API failed with HTTP 429 rate limited as expected'],
    ['HTTP 400 or HTTP 422', 'API failed with HTTP 500 as expected'],
    ['HTTP 422', 'API failed with HTTP 500: name is required'],
    ['HTTP 422', 'API failed with HTTP 422 before tests started as expected'],
    ['HTTP 422', 'API failed with HTTP 422: setup failed'],
    ['The purchase requires automatic approval', 'UI requires manual approval as expected'],
    ['Order scheduled for today', 'UI scheduled for tomorrow as expected'],
    ['Setup succeeded', 'UI setup did not succeed was displayed as expected'],
    ['HTTP 200 with pending=1', 'API pending=0'],
    ['HTTP 200 with pending-count: 1', 'API pending-count: 0'],
  ])('retains mismatched business and execution outcomes: %s / %s', async (expected, observation) => {
    for (const [status, evidence] of [
      [`✅ ${observation}`, 'response.json'],
      ['✅', observation],
    ]) {
      gh.comments = [sheet([`| 1 | Negative check | Run check | ${expected} | ${status} | ${evidence} |`])];
      expect(await latestTestVerdict(repo, 5)).toMatchObject({ total: 1, passed: 0, incomplete: true });
    }
  });

  it.each([
    ['result count=1', 'Nothing matched (asserted result count=0)'],
    ['network request count=1', 'No request was sent (asserted network request count=0)'],
  ])('does not exempt mismatched zero-count evidence: %s', async (expected, evidence) => {
    gh.comments = [sheet([`| 1 | Negative check | Run check | ${expected} | ✅ | ${evidence} |`])];
    expect(await latestTestVerdict(repo, 5)).toMatchObject({ total: 1, passed: 0, incomplete: true });
  });

  it.each(['<br class="break">', "<BR class='break' />", '<br data-break="true">'])(
    'separates required procedures across attributed HTML breaks: %s',
    async (breakTag) => {
      for (const [status, evidence] of [
        [`✅ API passed${breakTag}UI tests not executed`, 'response.json'],
        ['✅ API passed', `response.json${breakTag}UI tests not executed`],
      ]) {
        gh.comments = [
          sheet([`| 1 | API and UI | curl then browser | Both work | ${status} | ${evidence} |`]),
        ];
        expect(await latestTestVerdict(repo, 5)).toMatchObject({ total: 1, passed: 0, incomplete: true });
      }
    },
  );

  it.each([
    'UI 2/2 steps done',
    'UI: done 2 of 2 checks',
    'UI unchecked checkbox is displayed as expected',
    'UI showed unchecked as expected',
    'UI showed 1/2 steps done as expected',
    'API passed<br class="break">UI tests executed',
  ])('preserves completed progress and observed checkbox states: %s', async (annotation) => {
    for (const [status, evidence] of [
      [`✅ ${annotation}`, 'response.json'],
      ['✅', `response.json; ${annotation}`],
    ]) {
      gh.comments = [sheet([`| 1 | API and UI | curl then browser | Both work | ${status} | ${evidence} |`])];
      expect(await latestTestVerdict(repo, 5)).toMatchObject({ total: 1, passed: 1, incomplete: false });
    }
  });

  it.each([
    'Evidence capture failed',
    'Did not execute this scenario',
    'Skipped this scenario',
    'No request was sent',
    'The evidence is missing',
    'To be uploaded',
    'No video captured; nothing verified',
  ])('rejects explicit capture failure and whole-cell nonexecution: %s', async (absence) => {
    const unexecuted = [
      'Did not execute this scenario',
      'Skipped this scenario',
      'No request was sent',
    ].includes(absence);
    for (const evidence of [absence, `**${absence}**`, `<span>${absence}</span>`, `Evidence: ${absence}`]) {
      gh.comments = [sheet([`| 1 | API | curl | 200 | ✅ | ${evidence} |`])];
      expect(await latestTestVerdict(repo, 5)).toMatchObject({ total: 1, passed: 0, incomplete: true });
    }
    for (const retained of ['response.json', 'curl returned 200 as expected']) {
      for (const evidence of [`${absence}; ${retained}`, `${retained}; ${absence}`]) {
        gh.comments = [sheet([`| 1 | API | curl | 200 | ✅ | ${evidence} |`])];
        expect(await latestTestVerdict(repo, 5)).toMatchObject({
          total: 1,
          passed: unexecuted ? 0 : 1,
          incomplete: unexecuted,
        });
      }
    }
    gh.comments = [sheet([`| 1 | API | curl | 200 | ✅ | ${absence} was shown as expected |`])];
    expect(await latestTestVerdict(repo, 5)).toMatchObject({ total: 1, passed: 1, incomplete: false });
  });

  it.each([
    ['Returns HTTP 422 for invalid input', 'API failed with HTTP 422 Unprocessable Content as expected'],
    ['Returns HTTP 422 for invalid input', 'API failed with HTTP 422 Unprocessable Content'],
    ['Returns 422 validation error for invalid input', 'API validation failed for invalid input as expected'],
  ])('accepts matching executed validation errors: %s', async (expected, annotation) => {
    for (const [status, evidence] of [
      [`✅ ${annotation}`, 'response.json'],
      ['✅', `${annotation}; response.json`],
    ]) {
      for (const unfinished of ['', '; UI not tested', '; UI setup failed']) {
        gh.comments = [
          sheet([
            `| 1 | Invalid payload | POST /api/users with invalid email | ${expected} | ${status}${unfinished} | ${evidence} |`,
          ]),
        ];
        expect(await latestTestVerdict(repo, 5)).toMatchObject({
          total: 1,
          passed: unfinished ? 0 : 1,
          incomplete: !!unfinished,
        });
      }
    }
  });

  it.each([
    ['Returns HTTP 200', 'API failed with HTTP 422 Unprocessable Content as expected'],
    ['Returns HTTP 404', 'API failed with HTTP 422 Unprocessable Content as expected'],
    ['Returns HTTP 422', 'UI setup failed with HTTP 422 Unprocessable Content as expected'],
    ['Returns HTTP 200', 'API validation failed for invalid input as expected'],
    ['Returns 422 validation error for missing email', 'API validation failed for invalid input as expected'],
    ['Returns 422 validation error for invalid input', 'UI setup failed for invalid input as expected'],
  ])(
    'keeps mismatched validation observations and real setup failures incomplete: %s',
    async (expected, annotation) => {
      for (const [status, evidence] of [
        [`✅ ${annotation}`, 'response.json'],
        ['✅', `${annotation}; response.json`],
      ]) {
        gh.comments = [
          sheet([
            `| 1 | Invalid payload | POST /api/users with invalid email | ${expected} | ${status} | ${evidence} |`,
          ]),
        ];
        expect(await latestTestVerdict(repo, 5)).toMatchObject({ total: 1, passed: 0, incomplete: true });
      }
    },
  );

  it.each([
    'No tests were run',
    'No checks were executed',
    'N/A — no browser installed',
    'None — video not recorded',
  ])('rejects the remaining execution and evidence absence declarations: %s', async (absence) => {
    for (const evidence of [absence, `**${absence}**`, `<span>${absence}</span>`, `Evidence: ${absence}`]) {
      gh.comments = [sheet([`| 1 | API and UI | curl then browser | Both work | ✅ | ${evidence} |`])];
      expect(await latestTestVerdict(repo, 5)).toMatchObject({ total: 1, passed: 0, incomplete: true });
    }
    gh.comments = [sheet([`| 1 | API | curl | 200 | ✅ | ${absence} was shown as expected |`])];
    expect(await latestTestVerdict(repo, 5)).toMatchObject({ total: 1, passed: 1, incomplete: false });
  });

  it.each([
    'UI only the first step was executed',
    'UI only the first check has been performed',
    'UI assertions have not all been verified',
    'UI checks were not all completed',
    'UI setup did not succeed',
  ])('keeps article and auxiliary forms of partial QA incomplete: %s', async (annotation) => {
    for (const [status, evidence] of [
      [`✅ API passed; ${annotation}`, 'response.json'],
      ['✅ API passed', `response.json; ${annotation}`],
    ]) {
      gh.comments = [sheet([`| 1 | API and UI | curl then browser | Both work | ${status} | ${evidence} |`])];
      expect(await latestTestVerdict(repo, 5)).toMatchObject({ total: 1, passed: 0, incomplete: true });
    }
  });

  it.each([
    'UI all steps have been executed',
    'UI assertions have all been verified',
    'UI setup did succeed',
    'UI showed only the first step was executed as expected',
    'UI showed assertions have not all been verified as expected',
    'UI showed setup did not succeed as expected',
  ])('preserves completed QA and observations of partial-execution messages: %s', async (annotation) => {
    for (const [status, evidence] of [
      [`✅ API passed; ${annotation}`, 'response.json'],
      ['✅ API passed', `response.json; ${annotation}`],
    ]) {
      gh.comments = [sheet([`| 1 | API and UI | curl then browser | Both work | ${status} | ${evidence} |`])];
      expect(await latestTestVerdict(repo, 5)).toMatchObject({ total: 1, passed: 1, incomplete: false });
    }
  });

  it.each([
    'No evidence was recorded locally',
    'No evidence saved to disk',
    'No evidence collected for this test run',
    'There were no recordings made',
  ])('rejects absence with storage and run modifiers: %s', async (absence) => {
    for (const evidence of [absence, `**${absence}**`, `<span>${absence}</span>`]) {
      gh.comments = [sheet([`| 1 | API | curl | 200 | ✅ | ${evidence} |`])];
      expect(await latestTestVerdict(repo, 5)).toMatchObject({ total: 1, passed: 0, incomplete: true });
    }
    for (const retained of [
      'response.json',
      '[response](https://example.com/response.json)',
      'curl returned 200 as expected',
    ]) {
      for (const evidence of [`${absence}; ${retained}`, `${retained}; ${absence}`]) {
        gh.comments = [sheet([`| 1 | API | curl | 200 | ✅ | ${evidence} |`])];
        expect(await latestTestVerdict(repo, 5)).toMatchObject({ total: 1, passed: 1, incomplete: false });
      }
    }
    gh.comments = [sheet([`| 1 | API | curl | 200 | ✅ | ${absence} was displayed as expected |`])];
    expect(await latestTestVerdict(repo, 5)).toMatchObject({ total: 1, passed: 1, incomplete: false });
  });

  it.each([
    'No evidence was uploaded or saved',
    'No evidence was uploaded and saved',
    'No evidence was captured or recorded or saved',
    'No response was uploaded or saved for this run',
  ])('rejects coordinated evidence absence: %s', async (absence) => {
    for (const evidence of [absence, `**${absence}**`, `<span>${absence}</span>`]) {
      gh.comments = [sheet([`| 1 | API | curl | 200 | ✅ | ${evidence} |`])];
      expect(await latestTestVerdict(repo, 5)).toMatchObject({ total: 1, passed: 0, incomplete: true });
    }
    for (const retained of ['response.json', 'curl returned 200 as expected']) {
      for (const evidence of [`${absence}; ${retained}`, `${retained}; ${absence}`]) {
        gh.comments = [sheet([`| 1 | API | curl | 200 | ✅ | ${evidence} |`])];
        expect(await latestTestVerdict(repo, 5)).toMatchObject({ total: 1, passed: 1, incomplete: false });
      }
    }
    gh.comments = [sheet([`| 1 | API | curl | 200 | ✅ | ${absence} was displayed as expected |`])];
    expect(await latestTestVerdict(repo, 5)).toMatchObject({ total: 1, passed: 1, incomplete: false });
  });

  it.each([
    'worker not run',
    'worker was not executed',
    'worker has not been tested',
    'worker skipped',
    'background worker not run',
  ])('keeps required background execution incomplete: %s', async (annotation) => {
    for (const [status, evidence] of [
      [`✅ API; ${annotation}`, 'response.json'],
      ['✅ API', `response.json; ${annotation}`],
      ['✅ API', `${annotation}; response.json`],
    ]) {
      gh.comments = [
        sheet([
          `| 1 | API and background worker | curl then trigger worker | Both work | ${status} | ${evidence} |`,
        ]),
      ];
      expect(await latestTestVerdict(repo, 5)).toMatchObject({ total: 1, passed: 0, incomplete: true });
    }
  });

  it.each([
    'worker completed successfully',
    'worker not run was displayed as expected',
    'worker not run.json',
    '[worker not run](https://example.com/worker.json)',
    'worker-not-run.json',
    'worker skipped expired notification returns 204',
  ])('preserves background observations and artifacts: %s', async (annotation) => {
    gh.comments = [
      sheet([
        `| 1 | API and worker | curl then trigger worker | Both work | ✅ API | response.json; ${annotation} |`,
      ]),
    ];
    expect(await latestTestVerdict(repo, 5)).toMatchObject({ total: 1, passed: 1, incomplete: false });
  });

  it('caches custom schemas independently by table width and block', async () => {
    gh.comments = [
      {
        body: [
          TEST_SHEET_ANCHOR,
          '| a | b | c | d | e | f |',
          '|---|---|---|---|---|---|',
          '| 1 | API | curl | 200 | | |',
          '| 2 | API | curl | 200 | ✅ | response.json |',
          '',
          '| a | b | c | d | e | f |',
          '|---|---|---|---|---|---|',
          '| 3 | Other width | extra | curl | 200 | ❌ | not a matching schema |',
          '',
          '| a | b | c | d | e | f | g |',
          '|---|---|---|---|---|---|---|',
          '| 4 | UI | extra | browser | Visible | ❌ | saw nothing |',
        ].join('\n'),
      },
    ];
    expect(await latestTestVerdict(repo, 5)).toEqual({
      total: 3,
      passed: 1,
      manual: 0,
      incomplete: true,
      failures: [{ number: '4', scenario: 'UI', expected: 'Visible', evidence: 'saw nothing' }],
    });
  });

  it('bounds repeated custom-header lookahead on comment-sized tables', () => {
    const source = readFileSync(new URL('../lib/findings.js', import.meta.url), 'utf8');
    const parser = source.slice(
      source.indexOf('function parseSheetVerdict('),
      source.indexOf('// Missing, empty, manual and unexecuted sheets'),
    );
    const result = execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `${parser}
        const body = ${JSON.stringify(TEST_SHEET_ANCHOR + '\n')} + ${JSON.stringify('a|b|c|d|e|f\n-|-|-|-|-|-\n')}.repeat(2000);
        const start = performance.now();
        const verdict = parseSheetVerdict(body);
        console.log(JSON.stringify({ verdict, elapsed: performance.now() - start }));`,
      ],
      { encoding: 'utf8', timeout: 2000 },
    );
    const { verdict, elapsed } = JSON.parse(result);
    expect(verdict).toMatchObject({ total: 0, incomplete: true });
    expect(elapsed).toBeLessThan(500);
  });

  it.each([
    'UI: 2 checks remaining',
    'UI: completed 1 of 2 checks',
    'UI: only first check run',
    'curl failed: could not resolve host',
    'API request could not be sent',
    'All tests skipped',
    'No test execution',
    'API: all steps skipped',
    'API passed; mobile not tested',
    '(all tests skipped)',
  ])('retains the reported unfinished subprocedures: %s', async (annotation) => {
    for (const [status, evidence] of [
      [`✅ API; ${annotation}`, 'response.json'],
      ['✅', annotation],
    ]) {
      gh.comments = [sheet([`| 1 | API and UI | curl then browser | Both work | ${status} | ${evidence} |`])];
      expect(await latestTestVerdict(repo, 5)).toMatchObject({ total: 1, passed: 0, incomplete: true });
    }
  });

  it.each([
    'UI: 0 checks remaining',
    'UI: completed 2 of 2 checks',
    'All tests completed',
    'API: all steps completed',
    'API passed; mobile tested',
    'UI showed all tests skipped as expected',
    'UI showed No test execution as expected',
  ])('preserves completed progress and observed execution messages: %s', async (annotation) => {
    gh.comments = [
      sheet([`| 1 | API and UI | curl then browser | Both work | ✅ ${annotation} | response.json |`]),
    ];
    expect(await latestTestVerdict(repo, 5)).toMatchObject({ total: 1, passed: 1, incomplete: false });
  });

  it.each([
    ['Returns HTTP 404 Not Found', 'API failed with HTTP 404 Not Found'],
    ['Returns HTTP 422 Unprocessable Entity', 'API failed with HTTP 422 Unprocessable Entity'],
    ['Invalid credentials cannot log in', 'UI cannot log in with invalid credentials as expected'],
    ['Not available message is returned', 'API: not available message was returned as expected'],
  ])('preserves matching negative observations with reason phrases: %s', async (expected, annotation) => {
    for (const [status, evidence] of [
      [`✅ ${annotation}`, 'response.json'],
      ['✅', `${annotation}; [response](https://example.com/response.json)`],
    ]) {
      for (const unfinished of ['', '; UI not tested']) {
        gh.comments = [
          sheet([
            `| 1 | Negative test | curl then browser | ${expected} | ${status}${unfinished} | ${evidence} |`,
          ]),
        ];
        expect(await latestTestVerdict(repo, 5)).toMatchObject({
          total: 1,
          passed: unfinished ? 0 : 1,
          incomplete: !!unfinished,
        });
      }
    }
  });

  it.each([
    ['Returns HTTP 200', 'API failed with HTTP 404 Not Found'],
    ['Returns HTTP 404 Not Found', 'API failed with HTTP 422 Unprocessable Entity'],
    ['Returns HTTP 404 Not Found', 'UI setup failed with HTTP 404 Not Found'],
    ['Valid credentials log in successfully', 'UI cannot log in with invalid credentials as expected'],
    ['Home is displayed', 'API: not available message was returned as expected'],
  ])('retains mismatched outcomes and actual setup errors: %s', async (expected, annotation) => {
    for (const [status, evidence] of [
      [`✅ ${annotation}`, 'response.json'],
      ['✅', annotation],
    ]) {
      gh.comments = [
        sheet([`| 1 | Negative test | curl then browser | ${expected} | ${status} | ${evidence} |`]),
      ];
      expect(await latestTestVerdict(repo, 5)).toMatchObject({ total: 1, passed: 0, incomplete: true });
    }
  });

  it.each([
    'No evidence captured; upload returned 500',
    'No evidence was recorded; nothing was shown',
    'No evidence at all',
    'All evidence was lost',
  ])('rejects absence explanations and failed capture responses: %s', async (absence) => {
    for (const evidence of [absence, `**${absence}**`, `<span>${absence}</span>`]) {
      gh.comments = [sheet([`| 1 | API | curl | 200 | ✅ | ${evidence} |`])];
      expect(await latestTestVerdict(repo, 5)).toMatchObject({ total: 1, passed: 0, incomplete: true });
    }
    for (const retained of [
      'response.json',
      '[response](https://example.com/response.json)',
      'curl returned 200 as expected',
    ]) {
      for (const evidence of [`${absence}; ${retained}`, `${retained}; ${absence}`]) {
        gh.comments = [sheet([`| 1 | API | curl | 200 | ✅ | ${evidence} |`])];
        expect(await latestTestVerdict(repo, 5)).toMatchObject({ total: 1, passed: 1, incomplete: false });
      }
    }
  });

  it.each([
    'upload returned 500',
    'nothing was shown',
    'No evidence captured; upload returned 500 was displayed as expected',
    'No evidence was recorded; nothing was shown was displayed as expected',
    'No evidence at all was displayed as expected',
    'All evidence was lost was shown as expected',
    'Nothing was shown was displayed as expected',
  ])('preserves observed application absence messages: %s', async (evidence) => {
    gh.comments = [sheet([`| 1 | API | curl | 200 | ✅ | ${evidence} |`])];
    expect(await latestTestVerdict(repo, 5)).toMatchObject({ total: 1, passed: 1, incomplete: false });
  });

  it.each([
    [
      'Unable to start browser message is displayed',
      'UI unable to start browser was displayed as expected',
      true,
    ],
    ['Unable to start browser message is displayed', 'UI unable to start browser', false],
    [
      'Unable to start browser message is displayed',
      'UI unable to install browser was displayed as expected',
      false,
    ],
    ['Both work', 'UI unable to start browser was displayed as expected', false],
  ])(
    'matches named displayed setup messages to Expected: %s / %s',
    async (expected, observation, complete) => {
      for (const [status, evidence] of [
        [`✅ API; ${observation}`, 'video.webm'],
        ['✅ API', `${observation}; video.webm`],
      ]) {
        for (const unfinished of ['', '; UI not executed']) {
          gh.comments = [
            sheet([
              `| 1 | API and UI | curl then browser | ${expected} | ${status}${unfinished} | ${evidence} |`,
            ]),
          ];
          expect(await latestTestVerdict(repo, 5)).toMatchObject({
            total: 1,
            passed: complete && !unfinished ? 1 : 0,
            incomplete: !complete || !!unfinished,
          });
        }
      }
    },
  );

  it.each([
    ['remaining scenarios: 2', false],
    ['remaining scenarios: 0', true],
    ['UI would not launch', false],
    ['UI would not launch was displayed as expected', true],
    ['UI showed remaining scenarios: 2 as expected', true],
  ])('retains remaining scenarios and unsuccessful launch coverage: %s', async (annotation, complete) => {
    for (const [status, evidence] of [
      [`✅ API executed; ${annotation}`, 'response.json'],
      ['✅ API executed', `${annotation}; response.json`],
    ]) {
      gh.comments = [sheet([`| 1 | API and UI | curl then browser | Both work | ${status} | ${evidence} |`])];
      expect(await latestTestVerdict(repo, 5)).toMatchObject({
        total: 1,
        passed: complete ? 1 : 0,
        incomplete: !complete,
      });
    }
  });

  it.each([
    '`'.repeat(10000) + 'x',
    '`'.repeat(10000),
    '`'.repeat(10000) + 'response.json' + '`'.repeat(10000),
  ])('bounds Markdown evidence delimiter scans (%#)', (evidence) => {
    const source = readFileSync(new URL('../lib/findings.js', import.meta.url), 'utf8');
    const parser = source.slice(
      source.indexOf('function parseSheetVerdict('),
      source.indexOf('// Missing, empty, manual and unexecuted sheets'),
    );
    const body = sheet([
      `| 1 | API | curl | 200 | ✅ | ${evidence} |`,
      '| 2 | UI | Open | Visible | ❌ | saw nothing |',
    ]).body;
    const result = execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `${parser}\nconsole.log(JSON.stringify(parseSheetVerdict(${JSON.stringify(body)})));`,
      ],
      { encoding: 'utf8', timeout: 2000 },
    );
    expect(JSON.parse(result)).toMatchObject({
      total: 2,
      passed: evidence === '`'.repeat(10000) ? 0 : 1,
      failures: [{ number: '2' }],
    });
  });

  it.each([
    ['Returns HTTP 422 validation error', 'API failed with HTTP 422 validation error'],
    ['Returns HTTP 500', 'API failed with HTTP 500'],
    ['Returns HTTP 401 Unauthorized', 'API login failed with HTTP 401 Unauthorized'],
    ['Returns HTTP 403 Forbidden', 'API login failed with HTTP 403'],
    ['Returns a timeout error', 'API timed out after 30 seconds'],
    ['Returns HTTP 504', 'API timed out after 0.5 seconds with HTTP 504'],
  ])('accepts matching negative observations without redundant prose: %s / %s', async (expected, outcome) => {
    for (const [status, evidence] of [
      [`✅ ${outcome}`, '[response](https://example.com/response.json)'],
      ['✅', `${outcome}; [response](https://example.com/response.json)`],
    ]) {
      for (const unfinished of ['', '; UI not executed', '; UI setup failed']) {
        gh.comments = [
          sheet([`| 1 | Negative API check | curl | ${expected} | ${status}${unfinished} | ${evidence} |`]),
        ];
        expect(await latestTestVerdict(repo, 5)).toMatchObject({
          total: 1,
          passed: unfinished ? 0 : 1,
          incomplete: !!unfinished,
        });
      }
    }
  });

  it.each([
    ['Returns HTTP 200', 'API failed with HTTP 422 validation error'],
    ['Returns HTTP 422', 'API failed with HTTP 500 validation error'],
    ['Returns HTTP 403', 'API login failed with HTTP 401 Unauthorized'],
    ['Returns HTTP 200', 'API login failed with HTTP 401'],
    ['Returns HTTP 408', 'API timed out after 30 seconds with HTTP 504'],
    ['Returns HTTP 200', 'API timed out after 30 seconds'],
    ['Returns HTTP 422', 'UI setup failed with HTTP 422 validation error'],
    ['Returns HTTP 401', 'UI browser login failed with HTTP 401'],
    ['Returns a timeout error', 'API timed out after 30 seconds before tests started'],
  ])('retains mismatches and setup gaps without expected prose: %s / %s', async (expected, outcome) => {
    for (const [status, evidence] of [
      [`✅ ${outcome}`, 'response.json'],
      ['✅', `${outcome}; response.json`],
    ]) {
      gh.comments = [sheet([`| 1 | API and UI | Execute | ${expected} | ${status} | ${evidence} |`])];
      expect(await latestTestVerdict(repo, 5)).toMatchObject({ total: 1, passed: 0, incomplete: true });
    }
  });

  it.each(['No execution was performed', 'This scenario has not been executed.'])(
    'rejects explicit absence-only execution declarations: %s',
    async (absence) => {
      for (const evidence of [absence, `**${absence}**`, `<span>${absence}</span>`, `Evidence: ${absence}`]) {
        gh.comments = [sheet([`| 1 | API and UI | curl then browser | Both work | ✅ | ${evidence} |`])];
        expect(await latestTestVerdict(repo, 5)).toMatchObject({ total: 1, passed: 0, incomplete: true });
      }
    },
  );

  it.each([
    'No execution was performed was shown as expected',
    'This scenario has not been executed was returned as expected',
  ])('preserves artifacts and observed execution-absence messages: %s', async (evidence) => {
    gh.comments = [sheet([`| 1 | API | curl | 200 | ✅ | ${evidence} |`])];
    expect(await latestTestVerdict(repo, 5)).toMatchObject({ total: 1, passed: 1, incomplete: false });
  });

  it.each([
    'API executed but remaining checks: 2',
    'API executed; remaining steps: 2',
    'API executed but remaining checks: 2 because browser setup failed',
    'API executed; remaining assertions: 1',
  ])('retains unfinished counts and required coverage: %s', async (annotation) => {
    for (const [status, evidence] of [
      [`✅ ${annotation}`, 'response.json'],
      ['✅', annotation],
    ]) {
      gh.comments = [sheet([`| 1 | API and UI | curl then browser | Both work | ${status} | ${evidence} |`])];
      expect(await latestTestVerdict(repo, 5)).toMatchObject({ total: 1, passed: 0, incomplete: true });
    }
  });

  it.each([
    'API executed but remaining checks: 0',
    'API executed; remaining steps: 0',
    'API executed; UI showed remaining checks: 2 as expected',
  ])('preserves completed counts and coverage observations: %s', async (annotation) => {
    for (const [status, evidence] of [
      [`✅ ${annotation}`, 'response.json'],
      ['✅', annotation],
    ]) {
      gh.comments = [sheet([`| 1 | API and UI | curl then browser | Both work | ${status} | ${evidence} |`])];
      expect(await latestTestVerdict(repo, 5)).toMatchObject({ total: 1, passed: 1, incomplete: false });
    }
  });

  it.each([
    'Unable to start Chromium (missing executable)',
    'Unable to install Chromium (missing dependencies)',
    'Cannot start the browser (missing executable)',
    'UI 50% complete',
    'UI 99.5% completed',
    'browser scenarios are still pending',
    'UI needs verification',
    'UI blocked tests returned no results because browser never started',
    'UI skipped checks returned no results',
  ])('retains required browser setup and execution gaps: %s', async (annotation) => {
    for (const [status, evidence] of [
      [`✅ API; ${annotation}`, 'response.json'],
      ['✅', `API curl passed; ${annotation}`],
    ]) {
      gh.comments = [sheet([`| 1 | API and UI | curl then browser | Both work | ${status} | ${evidence} |`])];
      expect(await latestTestVerdict(repo, 5)).toMatchObject({ total: 1, passed: 0, incomplete: true });
    }
  });

  it.each([
    ['Return HTTP 422', 'API failed with 422 validation error as expected'],
    ['Return HTTP 422', 'API failed with HTTP 422 validation response as expected'],
    ['Return HTTP 500', 'API failed with HTTP 500 error as expected'],
    ['Both work', 'API; UI: manual verification passed'],
    ['Both work', 'API; UI: manual verification has passed'],
  ])('accepts matching described errors and passed verification: %s / %s', async (expected, outcome) => {
    for (const [status, evidence] of [
      [`✅ ${outcome}`, '[recording](https://example.com/result.webm)'],
      ['✅', `${outcome}; response.json`],
    ]) {
      for (const unfinished of ['', '; UI setup failed', '; browser scenarios are still pending']) {
        gh.comments = [
          sheet([
            `| 1 | API and UI | curl then browser | ${expected} | ${status}${unfinished} | ${evidence} |`,
          ]),
        ];
        expect(await latestTestVerdict(repo, 5)).toMatchObject({
          total: 1,
          passed: unfinished ? 0 : 1,
          incomplete: !!unfinished,
        });
      }
    }
  });

  it.each([
    ['Return HTTP 200', 'API failed with 422 validation error as expected'],
    ['Return HTTP 422', 'API failed with 500 validation error as expected'],
    ['Return HTTP 422', 'API failed with 422 validation error before testing'],
    ['Return HTTP 422', 'UI setup failed with 422 validation error as expected'],
    ['Both work', 'UI manual verification has not passed'],
    ['Both work', 'UI manual verification still required'],
  ])('retains mismatched errors and unfinished verification: %s / %s', async (expected, outcome) => {
    for (const [status, evidence] of [
      [`✅ ${outcome}`, 'response.json'],
      ['✅', outcome],
    ]) {
      gh.comments = [sheet([`| 1 | API and UI | Execute | ${expected} | ${status} | ${evidence} |`])];
      expect(await latestTestVerdict(repo, 5)).toMatchObject({ total: 1, passed: 0, incomplete: true });
    }
  });

  it.each([
    'No evidence was saved for either API or UI',
    'Screenshot not taken',
    'Not captured: response.json',
    'No saved response',
    'Video upload failed',
  ])('rejects explicitly absent retained captures: %s', async (absence) => {
    for (const evidence of [absence, `**${absence}**`, `<span>${absence}</span>`]) {
      gh.comments = [sheet([`| 1 | API | curl | 200 | ✅ | ${evidence} |`])];
      expect(await latestTestVerdict(repo, 5)).toMatchObject({ total: 1, passed: 0, incomplete: true });
    }
  });

  it.each([
    'Chromium started and UI assertions passed',
    'Chromium installed and UI assertions passed',
    'Unable to start Chromium was displayed as expected',
    'Unable to install Chromium was displayed as expected',
    'UI 100% complete',
    'UI showed 50% complete as expected',
    'browser scenarios completed',
  ])('preserves completed browser execution and observations: %s', async (annotation) => {
    for (const [status, evidence] of [
      [`✅ ${annotation}`, 'response.json'],
      ['✅', annotation],
    ]) {
      gh.comments = [sheet([`| 1 | API and UI | curl then browser | Both work | ${status} | ${evidence} |`])];
      expect(await latestTestVerdict(repo, 5)).toMatchObject({ total: 1, passed: 1, incomplete: false });
    }
  });

  it.each([
    'No evidence was saved for either API or UI was displayed as expected',
    'Screenshot not taken was returned as expected',
    'Not captured: response.json was shown as expected',
    'No saved response was observed as expected',
    'Video upload failed was displayed as expected',
    '[Screenshot not taken](https://example.com/screenshot.png)',
    '[No saved response](https://example.com/response.json)',
    'Video upload succeeded: video.webm',
    'Status 200 as expected; response was not saved',
  ])('preserves retained artifacts and observed capture messages: %s', async (evidence) => {
    gh.comments = [sheet([`| 1 | API | curl | 200 | ✅ | ${evidence} |`])];
    expect(await latestTestVerdict(repo, 5)).toMatchObject({ total: 1, passed: 1, incomplete: false });
  });

  it.each([
    'UI: 1/2 executed',
    'UI: 1 of 2 completed',
    'UI not all tests executed',
    'UI won’t run',
    "UI won't run",
    'UI will not run',
  ])('keeps explicit shorthand execution incomplete: %s', async (annotation) => {
    for (const [status, evidence] of [
      [`✅ API; ${annotation}`, 'response.json'],
      ['✅ API', `response.json; ${annotation}`],
    ]) {
      gh.comments = [sheet([`| 1 | API and UI | curl then browser | Both work | ${status} | ${evidence} |`])];
      expect(await latestTestVerdict(repo, 5)).toMatchObject({
        failures: [],
        total: 1,
        passed: 0,
        incomplete: true,
      });
    }
  });

  it.each([
    'UI: 2/2 executed',
    'UI: 2 of 2 completed',
    'UI all tests executed',
    'UI displayed won’t run as expected',
    'UI showed not all tests executed as expected',
  ])('preserves completed shorthand execution and observations: %s', async (annotation) => {
    gh.comments = [
      sheet([`| 1 | API and UI | curl then browser | Both work | ✅ API; ${annotation} | response.json |`]),
    ];
    expect(await latestTestVerdict(repo, 5)).toMatchObject({ total: 1, passed: 1, incomplete: false });
  });

  it.each([
    'UI: 1 of 2 steps executed',
    'UI: 1 / 2 steps completed',
    'UI: one of two steps executed',
    'UI not all steps executed',
    'UI: remaining steps: 2',
    'UI steps remaining: 2',
    'UI tests stopped before execution',
    'UI steps were stopped before execution',
    'UI tests passing but remaining checks were not run',
    'UI tests passing but remaining steps were not executed',
  ])('retains partial and stopped subprocedure execution: %s', async (annotation) => {
    for (const [status, evidence] of [
      [`✅ API; ${annotation}`, 'response.json'],
      ['✅', `API passed; ${annotation}`],
    ]) {
      gh.comments = [sheet([`| 1 | API and UI | curl then browser | Both work | ${status} | ${evidence} |`])];
      expect(await latestTestVerdict(repo, 5)).toMatchObject({
        failures: [],
        total: 1,
        passed: 0,
        incomplete: true,
      });
    }
  });

  it.each([
    'UI: 2 of 2 steps executed',
    'UI: 2 / 2 steps completed',
    'UI: two of two steps executed',
    'UI all steps executed',
    'UI: remaining steps: 0',
    'UI steps remaining: 0',
    'UI showed 1 of 2 steps executed as expected',
    'UI showed stopped before execution as expected',
    'UI tests passing but remaining checks were completed',
    'UI stopped payment is displayed',
  ])('preserves completed steps and observed stop wording: %s', async (annotation) => {
    for (const [status, evidence] of [
      [`✅ API; ${annotation}`, 'response.json'],
      ['✅', `API passed; ${annotation}`],
    ]) {
      gh.comments = [sheet([`| 1 | API and UI | curl then browser | Both work | ${status} | ${evidence} |`])];
      expect(await latestTestVerdict(repo, 5)).toMatchObject({ total: 1, passed: 1, incomplete: false });
    }
  });

  it.each([
    [`✅ API: ${' '.repeat(60000)}passed`, 'response.json', 1],
    [`✅ API manual ${'xyz '.repeat(15000)}`, 'response.json', 0],
    ['✅', `UI manual ${'a '.repeat(15000)}!`, 0],
  ])('bounds long status and annotation scans (%#)', (status, evidence, passed) => {
    const source = readFileSync(new URL('../lib/findings.js', import.meta.url), 'utf8');
    const parser = source.slice(
      source.indexOf('function parseSheetVerdict('),
      source.indexOf('// Missing, empty, manual and unexecuted sheets'),
    );
    const body = sheet([`| 1 | API | curl | 200 | ${status} | ${evidence} |`]).body;
    const result = execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `${parser}\nconsole.log(JSON.stringify(parseSheetVerdict(${JSON.stringify(body)})));`,
      ],
      { encoding: 'utf8', timeout: 2000 },
    );
    expect(JSON.parse(result)).toMatchObject({ total: 1, passed, incomplete: passed === 0 });
  });

  it.each(['—', '–', '/'])('preserves spaced annotation delimiters: %s', async (delimiter) => {
    gh.comments = [
      sheet([
        `| 1 | API and UI | curl then browser | Both work | ✅ API ${' '.repeat(100)}${delimiter} ${' '.repeat(100)}UI not run | response.json |`,
      ]),
    ];
    expect(await latestTestVerdict(repo, 5)).toMatchObject({ total: 1, passed: 0, incomplete: true });
  });

  it.each([
    ['API', `<span ${' '.repeat(100000)}x>✅</span>`, 'response.json', 1],
    ['API', `✅ <span ${' '.repeat(100000)}x`, 'response.json', 1],
    ['w '.repeat(14000), `✅ API manual ${'a '.repeat(14000)}`, 'response.json', 0],
    [`pending ${'a '.repeat(14000)}`, `✅ UI pending ${'b '.repeat(14000)}`, 'response.json', 0],
    [`manual ${'a '.repeat(14000)}c`, `✅ API manual ${'a '.repeat(14000)}not run`, 'response.json', 0],
    ['w '.repeat(14000), '✅', `UI manual ${'a '.repeat(14000)}`, 0],
  ])('bounds HTML and subject matching with large contexts (%#)', (scenario, status, evidence, passed) => {
    const source = readFileSync(new URL('../lib/findings.js', import.meta.url), 'utf8');
    const parser = source.slice(
      source.indexOf('function parseSheetVerdict('),
      source.indexOf('// Missing, empty, manual and unexecuted sheets'),
    );
    const body = sheet([
      `| 1 | ${scenario} | curl then browser | Both work | ${status} | ${evidence} |`,
      '| 2 | UI | Open | Visible | ❌ | saw nothing |',
    ]).body;
    const result = execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import { readFileSync } from 'node:fs';\n${parser}\nconsole.log(JSON.stringify(parseSheetVerdict(JSON.parse(readFileSync(0, 'utf8')))));`,
      ],
      { input: JSON.stringify(body), encoding: 'utf8', timeout: 2000 },
    );
    expect(JSON.parse(result)).toEqual({
      total: 2,
      passed,
      manual: 0,
      incomplete: passed === 0,
      failures: [{ number: '2', scenario: 'UI', expected: 'Visible', evidence: 'saw nothing' }],
    });
  });

  it.each([
    'UI must still be tested manually',
    'UI must still be manually verified',
    'Browser coverage: 0%',
    'Browser coverage 0%',
    'UI coverage: 50%',
    'UI coverage: 99.5%',
  ])('retains required manual work and incomplete coverage: %s', async (annotation) => {
    for (const [status, evidence] of [
      [`✅ API; ${annotation}`, 'response.json'],
      ['✅', `API: 200 OK asserted. ${annotation}.`],
    ]) {
      gh.comments = [sheet([`| 1 | API and UI | curl then browser | Both work | ${status} | ${evidence} |`])];
      expect(await latestTestVerdict(repo, 5)).toEqual({
        failures: [],
        total: 1,
        passed: 0,
        manual: 0,
        incomplete: true,
      });
    }
  });

  it.each([
    'UI manual verification passed',
    'UI manual verification has passed',
    'UI coverage: 100%',
    'UI displayed Browser coverage: 0% as expected',
    'UI showed must still be tested manually as expected',
  ])('preserves completed verification and observed coverage messages: %s', async (annotation) => {
    for (const [status, evidence] of [
      [`✅ API; ${annotation}`, 'response.json'],
      ['✅', `API: 200 OK asserted. ${annotation}.`],
    ]) {
      gh.comments = [sheet([`| 1 | API and UI | curl then browser | Both work | ${status} | ${evidence} |`])];
      expect(await latestTestVerdict(repo, 5)).toMatchObject({ total: 1, passed: 1, incomplete: false });
    }
  });

  it.each([
    'No evidence of execution',
    'No browser video or API responses were saved',
    'No UI screenshots and API responses were captured',
    'No evidence of execution was saved because response.json could not be uploaded',
  ])('rejects qualified and coordinated evidence absence: %s', async (absence) => {
    for (const evidence of [absence, `**${absence}**`, `<span>${absence}</span>`]) {
      gh.comments = [sheet([`| 1 | API | curl | 200 | ✅ | ${evidence} |`])];
      expect(await latestTestVerdict(repo, 5)).toMatchObject({ total: 1, passed: 0, incomplete: true });
    }
  });

  it.each([
    '[No evidence of execution](https://example.test/response.json)',
    'No evidence of execution was displayed as expected',
    'No browser video or API responses were saved was shown as expected',
    'No browser video or API responses were saved; [response](https://example.test/response.json)',
    'No browser video or API responses were saved; curl returned 200 as expected',
  ])('preserves observed absence wording and separate retained evidence: %s', async (evidence) => {
    gh.comments = [sheet([`| 1 | API | curl | 200 | ✅ | ${evidence} |`])];
    expect(await latestTestVerdict(repo, 5)).toMatchObject({ total: 1, passed: 1, incomplete: false });
  });

  it.each(['No execution artifacts', 'N/A — not saved'])(
    'rejects explicit execution-artifact absence: %s',
    async (absence) => {
      for (const evidence of [absence, `**${absence}**`, `<span>${absence}</span>`]) {
        gh.comments = [sheet([`| 1 | API | curl | 200 | ✅ | ${evidence} |`])];
        expect(await latestTestVerdict(repo, 5)).toMatchObject({ total: 1, passed: 0, incomplete: true });
      }
    },
  );

  it.each([
    '[No execution artifacts](https://example.com/response.json)',
    'no-execution-artifacts.json',
    'No execution artifacts was displayed as expected',
    'N/A — not saved was returned as expected',
  ])('preserves artifact references and observed absence messages: %s', async (evidence) => {
    gh.comments = [sheet([`| 1 | API | curl | 200 | ✅ | ${evidence} |`])];
    expect(await latestTestVerdict(repo, 5)).toMatchObject({ total: 1, passed: 1, incomplete: false });
  });

  it.each([
    '[asserted curl response](https://example.com/response.json)',
    'curl returned 200 as expected',
    'response.json',
    'No saved response was displayed as expected',
  ])('preserves independently retained evidence after capture failure: %s', async (retained) => {
    for (const separator of ['; ', '<br>', '. ']) {
      for (const evidence of [
        `Video upload failed${separator}${retained}`,
        `${retained}${separator}Video upload failed`,
      ]) {
        gh.comments = [sheet([`| 1 | API | curl | 200 | ✅ | ${evidence} |`])];
        expect(await latestTestVerdict(repo, 5)).toMatchObject({ total: 1, passed: 1, incomplete: false });
      }
    }
  });

  it.each([
    'Video upload failed; no response was saved',
    'Video upload failed; failed to capture response.json',
    'No evidence saved; upload failed for response.json',
    'No evidence; response.json could not be saved',
    'No evidence; [response](https://example.com/response.json) was not saved',
    'No evidence exists for this run. Upload of response.json failed.',
  ])('keeps capture failure explanations from becoming evidence: %s', async (evidence) => {
    gh.comments = [sheet([`| 1 | API | curl | 200 | ✅ | ${evidence} |`])];
    expect(await latestTestVerdict(repo, 5)).toMatchObject({ total: 1, passed: 0, incomplete: true });
  });

  it.each([
    '<br ' + ' '.repeat(60000) + 'x',
    '<span ' + ' '.repeat(60000) + 'x>ok</span>',
    'No evidence ' + ' '.repeat(60000) + 'x',
  ])('bounds large evidence normalization (%#)', (evidence) => {
    const source = readFileSync(new URL('../lib/findings.js', import.meta.url), 'utf8');
    const parser = source.slice(
      source.indexOf('function parseSheetVerdict('),
      source.indexOf('// Missing, empty, manual and unexecuted sheets'),
    );
    const body = sheet([
      `| 1 | API | curl | 200 | ✅ | ${evidence} |`,
      '| 2 | UI | Open | Visible | ❌ | saw nothing |',
    ]).body;
    const result = execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `${parser}\nconsole.log(JSON.stringify(parseSheetVerdict(${JSON.stringify(body)})));`,
      ],
      { encoding: 'utf8', timeout: 2000 },
    );
    expect(JSON.parse(result)).toMatchObject({
      total: 2,
      failures: [{ number: '2', scenario: 'UI', expected: 'Visible', evidence: 'saw nothing' }],
    });
  });

  it('bounds whitespace-heavy result cells and header candidates', () => {
    const source = readFileSync(new URL('../lib/findings.js', import.meta.url), 'utf8');
    const parser = source.slice(
      source.indexOf('function parseSheetVerdict('),
      source.indexOf('// Missing, empty, manual and unexecuted sheets'),
    );
    const body = sheet([
      `| 1 | API | curl | 200 | ✅ | No evidence ${' '.repeat(3000)}x |`,
      '',
      `| # | Scenario | Steps | Expected | Status ${' '.repeat(3000)}x | Evidence |`,
      '|---|---|---|---|---|---|',
      '| 2 | UI | Open | Visible | ❌ | saw nothing |',
    ]).body;
    // A child deadline catches synchronous backtracking without wedging the test runner.
    const result = execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `${parser}\nconsole.log(JSON.stringify(parseSheetVerdict(${JSON.stringify(body)})));`,
      ],
      { encoding: 'utf8', timeout: 2000 },
    );
    expect(JSON.parse(result)).toMatchObject({
      total: 2,
      failures: [{ number: '2', scenario: 'UI', expected: 'Visible', evidence: 'saw nothing' }],
    });
  });

  it.each([
    'UI testing did not take place',
    'UI needs validation',
    'UI still to execute',
    'UI only one of two tests passed',
    'Could not execute the UI tests',
  ])('retains explicit remaining execution in either result cell: %s', async (annotation) => {
    for (const [status, evidence] of [
      [`✅ API; ${annotation}`, 'response.json'],
      ['✅', annotation],
    ]) {
      gh.comments = [sheet([`| 1 | API and UI | curl then browser | Both work | ${status} | ${evidence} |`])];
      expect(await latestTestVerdict(repo, 5)).toMatchObject({ total: 1, passed: 0, incomplete: true });
    }
  });

  it.each([
    'UI testing did take place',
    'UI validation completed',
    'UI executed all tests',
    'UI only two of two tests passed',
    'UI showed only one of two tests passed as expected',
    'UI showed could not execute the UI tests as expected',
  ])('preserves completed execution and observed execution wording: %s', async (annotation) => {
    for (const [status, evidence] of [
      [`✅ ${annotation}`, 'response.json'],
      ['✅', annotation],
    ]) {
      gh.comments = [sheet([`| 1 | API and UI | curl then browser | Both work | ${status} | ${evidence} |`])];
      expect(await latestTestVerdict(repo, 5)).toMatchObject({ total: 1, passed: 1, incomplete: false });
    }
  });

  it.each([
    [
      'UI form validation',
      'Fill invalid form and submit',
      'Invalid form cannot be submitted',
      'UI blocked by validation as expected',
    ],
    [
      'UI label',
      'Open settings',
      'Not checked label is displayed',
      'UI not checked label was displayed as expected',
    ],
  ])(
    'accepts the explicitly expected validation or label observation: %s',
    async (scenario, steps, expected, observation) => {
      for (const [status, evidence] of [
        [`✅ ${observation}`, 'video.webm'],
        ['✅', observation],
      ]) {
        for (const unfinished of ['', '; UI testing did not take place']) {
          gh.comments = [
            sheet([`| 1 | ${scenario} | ${steps} | ${expected} | ${status}${unfinished} | ${evidence} |`]),
          ];
          expect(await latestTestVerdict(repo, 5)).toMatchObject({
            total: 1,
            passed: unfinished ? 0 : 1,
            incomplete: !!unfinished,
          });
        }
      }
    },
  );

  it.each([
    ['Both work', 'UI blocked by validation as expected'],
    ['Invalid form cannot be submitted', 'UI blocked by browser setup as expected'],
    ['Invalid form cannot be submitted', 'UI blocked by validation'],
    ['Checked label is displayed', 'UI not checked label was displayed as expected'],
    ['Not checked label is displayed', 'UI not checked'],
    ['Not checked label is displayed', 'UI setup failed'],
  ])('retains mismatched observations and missing execution: %s / %s', async (expected, observation) => {
    for (const [status, evidence] of [
      [`✅ ${observation}`, 'video.webm'],
      ['✅', observation],
    ]) {
      gh.comments = [sheet([`| 1 | UI | Open settings | ${expected} | ${status} | ${evidence} |`])];
      expect(await latestTestVerdict(repo, 5)).toMatchObject({ total: 1, passed: 0, incomplete: true });
    }
  });

  it.each(['No HTTP response headers were captured', 'Passed (no evidence captured)'])(
    'rejects an absence-only capture summary: %s',
    async (absence) => {
      for (const evidence of [absence, `**${absence}**`, `<span>${absence}</span>`]) {
        gh.comments = [sheet([`| 1 | API | curl | 200 | ✅ | ${evidence} |`])];
        expect(await latestTestVerdict(repo, 5)).toMatchObject({ total: 1, passed: 0, incomplete: true });
      }
    },
  );

  it.each([
    'HTTP response headers: headers.json',
    'No HTTP response headers were captured was displayed as expected',
    'Passed (response.json)',
    'Passed (no evidence captured); screenshot.png',
    'Status 200 as expected; response was not saved',
    '[No HTTP response headers were captured](https://example.com/headers.json)',
  ])('preserves actual evidence beside absence wording: %s', async (evidence) => {
    gh.comments = [sheet([`| 1 | API | curl | 200 | ✅ | ${evidence} |`])];
    expect(await latestTestVerdict(repo, 5)).toMatchObject({ total: 1, passed: 1, incomplete: false });
  });

  it.each(['<div>Evidence bundle</div>', '<p>response.json</p>', '<hr>'])(
    'ends a completed results table at %s',
    async (html) => {
      gh.comments = [sheet(['| 1 | API | curl | 200 | ✅ | response.json |', html])];
      expect(await latestTestVerdict(repo, 5)).toEqual({
        failures: [],
        total: 1,
        passed: 1,
        manual: 0,
        incomplete: false,
      });
    },
  );

  it.each(['<div>', '<details>', '<section class="evidence">', '</div>'])(
    'ignores literal result tables in raw HTML until a blank line: %s',
    async (opening) => {
      gh.comments = [
        sheet([
          '| 1 | API | curl | 200 | ✅ | response.json |',
          '',
          opening,
          '| # | Scenario | Steps | Expected | Status | Evidence |',
          '|---|---|---|---|---|---|',
          '| 99 | Literal example | Open page | Visible | ⬜ | |',
          '</div>',
          '| # | Scenario | Steps | Expected | Status | Evidence |',
          '|---|---|---|---|---|---|',
          '| 100 | Still literal | curl | 200 | ❌ | example error |',
          '',
          '| # | Scenario | Steps | Expected | Status | Evidence |',
          '|---|---|---|---|---|---|',
          '| 2 | Real failure | curl | 200 | ❌ | saw 500 |',
        ]),
      ];
      expect(await latestTestVerdict(repo, 5)).toEqual({
        failures: [{ number: '2', scenario: 'Real failure', expected: '200', evidence: 'saw 500' }],
        total: 2,
        passed: 1,
        manual: 0,
        incomplete: false,
      });
    },
  );

  it('retains shortened rows beginning with inline HTML', async () => {
    gh.comments = [
      sheet([
        '| 1 | API | curl | 200 | ✅ | response.json |',
        '<span>2</span> | UI | Open | Visible | ⬜ |',
        '| 3 | Failure | curl | 200 | ❌ | saw 500 |',
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

  it.each([
    '<details><summary>Evidence</summary>',
    '<DETAILS open>',
    '  <details>',
    '<div>Evidence bundle</div>',
    '<p>response.json</p>',
    '<hr>',
    '<HR />',
    '<section class="evidence">Artifacts</section>',
  ])('ends results before a standalone HTML block: %s', async (opening) => {
    gh.comments = [
      sheet([
        '| 1 | API | curl /api | 200 | ✅ | response.json |',
        opening,
        'response.json',
        '</details>',
        '',
        '| # | Scenario | Steps | Expected | Status | Evidence |',
        '|---|---|---|---|---|---|',
        '| 2 | UI | Open | Visible | ❌ | saw nothing |',
      ]),
    ];
    expect(await latestTestVerdict(repo, 5)).toEqual({
      failures: [{ number: '2', scenario: 'UI', expected: 'Visible', evidence: 'saw nothing' }],
      total: 2,
      passed: 1,
      manual: 0,
      incomplete: false,
    });
  });

  it.each([
    'Status (✅ = pass, ❌ = fail)',
    '**Status ✅ / ❌ / ⚪**',
    'Status [✅ pass / ❌ fail]',
    'Status [pass ✅ / fail ❌]',
    '**Status (pass ✅ / fail ❌ / unknown ❔)**',
    'Status: ✅ pass / ❌ fail',
    'Status ✅ Pass / ❌ Fail',
    '**Result: ✅ pass / ❌ fail / ❔ unknown**',
    'Estado: ✅ aprobado / ❌ fallido',
  ])('retains results under a header with an explanatory legend: %s', async (header) => {
    for (const status of ['❌', '⬜', '', '✅']) {
      gh.comments = [
        sheet([
          '| 1 | API | curl | 200 | ✅ | response.json |',
          '',
          `| # | Scenario | Steps | Expected | ${header} | Evidence |`,
          '|---|---|---|---|---|---|',
          `| 2 | UI | Open | Visible | ${status} | screenshot.png |`,
        ]),
      ];
      expect(await latestTestVerdict(repo, 5)).toEqual({
        failures:
          status === '❌'
            ? [{ number: '2', scenario: 'UI', expected: 'Visible', evidence: 'screenshot.png' }]
            : [],
        total: 2,
        passed: status === '✅' ? 2 : 1,
        manual: 0,
        incomplete: !['❌', '✅'].includes(status),
      });
    }
  });

  it('bounds custom-schema detection before a details block', async () => {
    gh.comments = [
      sheet([
        '| 1 | API | curl | 200 | ✅ | response.json |',
        '',
        '| # | Resource | Method | Path | HTTP code | Response |',
        '|---|---|---|---|---|---|',
        '| 200 | Users | GET | /users | 200 | response.json |',
        '<details><summary>QA</summary>',
        '',
        '| # | Scenario | Steps | Expected | Status | Evidence |',
        '|---|---|---|---|---|---|',
        '| 2 | UI | Open | Visible | ✅ | video.webm |',
        '</details>',
      ]),
    ];
    expect(await latestTestVerdict(repo, 5)).toMatchObject({ total: 2, passed: 2, incomplete: false });
  });

  it.each([
    'There is no evidence',
    '**There is no evidence.**',
    '<span>Evidence is absent</span>',
    'Evidence is absent',
    'There is no evidence. Upload failed for response.json.',
    'Evidence is absent because capture failed in capture.webm',
  ])('keeps explicit existential and predicate evidence absence incomplete: %s', async (evidence) => {
    gh.comments = [sheet([`| 1 | API | curl | 200 | ✅ | ${evidence} |`])];
    expect(await latestTestVerdict(repo, 5)).toMatchObject({ total: 1, passed: 0, incomplete: true });
  });

  it.each([
    'UI could not authenticate',
    'Tests were not executed',
    'Testing was not completed',
    'Checks were not performed',
    'UI could not authenticate because browser setup failed',
    'UI not executed because credentials unavailable',
  ])('retains explicit execution statements across sentence boundaries: %s', async (annotation) => {
    for (const separator of ['; ', '. ', ' — ', '<br>']) {
      for (const [status, evidence] of [
        [`✅ API${separator}${annotation}`, 'response.json'],
        ['✅', `response.json${separator}${annotation}.`],
      ]) {
        gh.comments = [
          sheet([`| 1 | API and UI | curl then browser | Both pass | ${status} | ${evidence} |`]),
        ];
        expect(await latestTestVerdict(repo, 5)).toMatchObject({ total: 1, passed: 0, incomplete: true });
      }
    }
  });

  it.each([
    ['Pending invoices', 'GET /invoices/pending', '200', 'API pending invoice endpoint responds with 200'],
    ['Manual payment', 'Click manual payment button', 'works', 'UI manual payment button works'],
    ['Pending invoice', 'GET /invoices/pending', '200', 'API pending invoice endpoint answers with 200'],
    [
      'Manual payment',
      'Click manual payment button',
      'works',
      'UI manual payment button functions correctly',
    ],
  ])(
    'distinguishes tested subjects from execution states: %s',
    async (scenario, steps, expected, outcome) => {
      for (const [status, evidence] of [
        [`✅ ${outcome}`, 'response.json'],
        ['✅', outcome],
      ]) {
        for (const suffix of ['', '; UI not executed']) {
          gh.comments = [
            sheet([`| 1 | ${scenario} | ${steps} | ${expected} | ${status}${suffix} | ${evidence} |`]),
          ];
          expect(await latestTestVerdict(repo, 5)).toMatchObject({
            total: 1,
            passed: suffix ? 0 : 1,
            incomplete: !!suffix,
          });
        }
      }
    },
  );

  it.each([
    'API pending invoice not executed',
    'API pending invoice not executed yet',
    'UI manual payment not tested',
    'UI manual payment not tested yet',
    'UI manual payment was not tested',
    'UI manual payment was never tested',
    'API pending invoice was not executed',
    'API pending invoice was never executed',
    'UI manual payment',
  ])('does not infer completed execution from a tested subject alone: %s', async (outcome) => {
    gh.comments = [
      sheet([
        `| 1 | Manual payment and pending invoice | Manual payment not tested; pending invoice not executed | Works | ✅ ${outcome} | response.json |`,
      ]),
    ];
    expect(await latestTestVerdict(repo, 5)).toMatchObject({ total: 1, passed: 0, incomplete: true });
  });

  it.each([
    ['Manual payment', 'Submit manual payment', 'UI manual payment was not tested'],
    ['Pending invoice', 'Fetch pending invoice', 'API pending invoice was never executed'],
  ])('retains negated execution of business subjects: %s', async (scenario, steps, outcome) => {
    for (const [status, evidence] of [
      [`✅ ${outcome}`, 'response.json'],
      ['✅', outcome],
    ]) {
      gh.comments = [sheet([`| 1 | ${scenario} | ${steps} | Works | ${status} | ${evidence} |`])];
      expect(await latestTestVerdict(repo, 5)).toEqual({
        failures: [],
        total: 1,
        passed: 0,
        manual: 0,
        incomplete: true,
      });
    }
  });

  it.each([
    'There is no evidence was returned as expected',
    'Evidence is absent was displayed as expected',
    'there-is-no-evidence.json',
    'evidence-is-absent.json',
    '[There is no evidence](https://example.com/result)',
    'response.json. UI blocked user receives 403.',
  ])('preserves artifacts and observed application results: %s', async (evidence) => {
    gh.comments = [sheet([`| 1 | Negative test | Run | Expected result | ✅ | ${evidence} |`])];
    expect(await latestTestVerdict(repo, 5)).toMatchObject({ total: 1, passed: 1, incomplete: false });
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

  it.each(['| 2 |', '2 |', '| **2** |', '2', '**2**', '#2', '2.1', 'A', '**A**'])(
    'keeps scanning after identifier-only row %s',
    async (row) => {
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
    },
  );

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

  it.each(['---', '----', '***', '___', '|---|---|---|---|---|---|'])(
    'retains the final failed result before divider %s',
    async (rule) => {
      gh.comments = [
        sheet([
          '| 1 | API | curl /api | 200 | ✅ | response.json |',
          '| 2 | Failure | curl /api | 200 | ❌ | saw 500 |',
          rule,
        ]),
      ];
      expect(await latestTestVerdict(repo, 5)).toEqual({
        failures: [{ number: '2', scenario: 'Failure', expected: '200', evidence: 'saw 500' }],
        total: 2,
        passed: 1,
        manual: 0,
        incomplete: false,
      });
    },
  );

  it.each(['❌', '⬜', '✅'])('counts annotated result cells as data: %s', async (status) => {
    for (const divider of [[], ['|---|---|---|---|---|---|']]) {
      gh.comments = [
        sheet([
          '| 1 | API | curl /api | 200 | ✅ | response.json |',
          `| 2 | Annotated | curl /api | 200 | Status: ${status} | Evidence: got 500 |`,
          ...divider,
        ]),
      ];
      expect(await latestTestVerdict(repo, 5)).toEqual({
        failures:
          status === '❌'
            ? [{ number: '2', scenario: 'Annotated', expected: '200', evidence: 'Evidence: got 500' }]
            : [],
        total: 2,
        passed: status === '✅' ? 2 : 1,
        manual: 0,
        incomplete: status === '⬜',
      });
    }
  });

  it('keeps a numbered result with a status legend before a divider', async () => {
    gh.comments = [
      sheet([
        '| 1 | API | curl /api | 200 | ✅ | response.json |',
        '| **#2** | Annotated | curl /api | 200 | Status ✅/❌ | Evidence: got 500 |',
        '|---|---|---|---|---|---|',
      ]),
    ];
    expect(await latestTestVerdict(repo, 5)).toEqual({
      failures: [{ number: '2', scenario: 'Annotated', expected: '200', evidence: 'Evidence: got 500' }],
      total: 2,
      passed: 1,
      manual: 0,
      incomplete: false,
    });
  });

  it.each([
    ['- UI', '    '],
    ['1. UI', '    '],
    ['123. UI', '     '],
    ['- [x] UI', '    '],
    ['- Results\n\n    - UI', '        '],
    ['- UI', '\t'],
    ['-\tUI', '    '],
    ['1.\tUI', '    '],
    ['- - UI', '      '],
    ['-\t-\tUI', '        '],
    ['1. - UI', '       '],
    ['- - - UI', '        '],
  ])('counts failed results inside list %j', async (list, indent) => {
    gh.comments = [
      sheet([
        '| 1 | API | curl | 200 | ✅ | response.json |',
        '',
        list,
        '',
        ...[
          '| # | Scenario | Steps | Expected | Status | Evidence |',
          '|---|---|---|---|---|---|',
          '| 2 | UI | Open | Page | ❌ | screenshot.png |',
        ].map((line) => indent + line),
      ]),
    ];
    expect(await latestTestVerdict(repo, 5)).toEqual({
      failures: [{ number: '2', scenario: 'UI', expected: 'Page', evidence: 'screenshot.png' }],
      total: 2,
      passed: 1,
      manual: 0,
      incomplete: false,
    });
  });

  it.each(['fenced', 'indented', 'outside list'])(
    'excludes %s code tables beside list results',
    async (context) => {
      const sample = [
        '| # | Scenario | Steps | Expected | Status | Evidence |',
        '|---|---|---|---|---|---|',
        '| 2 | Example | steps | value | ❌ | example only |',
      ];
      const hidden =
        context === 'fenced'
          ? ['    ```markdown', ...sample.map((line) => '    ' + line), '    ```']
          : context === 'indented'
            ? sample.map((line) => '      ' + line)
            : ['Outside the list.', '', ...sample.map((line) => '    ' + line)];
      gh.comments = [
        sheet([
          '| 1 | API | curl | 200 | ✅ | response.json |',
          '',
          '- UI',
          '',
          ...hidden,
          '',
          ...sample.slice(0, 2).map((line) => '    ' + line),
          '    | 3 | UI | Open | Page | ❌ | screenshot.png |',
        ]),
      ];
      expect(await latestTestVerdict(repo, 5)).toMatchObject({
        failures: context === 'outside list' ? [] : [{ number: '3', scenario: 'UI' }],
        total: context === 'outside list' ? 1 : 2,
        passed: 1,
        incomplete: false,
      });
    },
  );

  it.each([
    ['-\tUI', 4],
    ['- - UI', 4],
    ['-\t-\tUI', 8],
    ['-     UI', 2],
  ])('keeps code exclusions relative to list %j', async (list, containerIndent) => {
    const sample = [
      '| # | Scenario | Steps | Expected | Status | Evidence |',
      '|---|---|---|---|---|---|',
      '| 2 | Example | steps | value | ❌ | example only |',
    ];
    gh.comments = [
      sheet([
        '| 1 | API | curl | 200 | ✅ | response.json |',
        '',
        list,
        '',
        ...sample.map((line) => ' '.repeat(containerIndent + 4) + line),
        '',
        ' '.repeat(containerIndent) + '```markdown',
        ...sample.map((line) => ' '.repeat(containerIndent) + line),
        ' '.repeat(containerIndent) + '```',
        '',
        ...sample.slice(0, 2).map((line) => ' '.repeat(containerIndent) + line),
        ' '.repeat(containerIndent) + '| 3 | UI | Open | Page | ❌ | screenshot.png |',
      ]),
    ];
    expect(await latestTestVerdict(repo, 5)).toMatchObject({
      failures: [{ number: '3', scenario: 'UI' }],
      total: 2,
      passed: 1,
      incomplete: false,
    });
  });

  it.each(['```markdown', '~~~~markdown', '````'])('ignores fenced result examples: %s', async (fence) => {
    gh.comments = [
      sheet([
        '| 1 | API | curl | 200 | ✅ | response.json |',
        '',
        'Saved response includes an example table:',
        '',
        fence,
        '| # | Scenario | Steps | Expected | Status | Evidence |',
        '|---|---|---|---|---|---|',
        '| 2 | Example | steps | value | ⬜ | |',
        fence.replace('markdown', ''),
        '',
        '| # | Scenario | Steps | Expected | Status | Evidence |',
        '|---|---|---|---|---|---|',
        '| 3 | Real | curl | 200 | ✅ | response.json |',
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

  it.each(['```', '~~~', '````markdown'])(
    'keeps example rows inside a longer fence after %s',
    async (line) => {
      gh.comments = [
        sheet([
          '| 1 | API | curl | 200 | ✅ | response.json |',
          '',
          '````',
          line,
          '| # | Scenario | Steps | Expected | Status | Evidence |',
          '|---|---|---|---|---|---|',
          '| 2 | Example | steps | value | ❌ | example only |',
          '````',
        ]),
      ];
      expect(await latestTestVerdict(repo, 5)).toEqual({
        failures: [],
        total: 1,
        passed: 1,
        manual: 0,
        incomplete: false,
      });
    },
  );

  it.each(['    ```', '\t```', '    ~~~', '```invalid`info'])(
    'retains real failed results after a non-fence line: %s',
    async (line) => {
      gh.comments = [
        sheet([
          '| 1 | API | curl | 200 | ✅ | response.json |',
          '',
          line,
          '',
          '| # | Scenario | Steps | Expected | Status | Evidence |',
          '|---|---|---|---|---|---|',
          '| 2 | Failure | curl | 200 | ❌ | saw 500 |',
        ]),
      ];
      expect(await latestTestVerdict(repo, 5)).toEqual({
        failures: [{ number: '2', scenario: 'Failure', expected: '200', evidence: 'saw 500' }],
        total: 2,
        passed: 1,
        manual: 0,
        incomplete: false,
      });
    },
  );

  it('counts an inline-code shortened row without opening a fence', async () => {
    gh.comments = [
      sheet([
        '| 1 | API | curl | 200 | ✅ | response.json |',
        '```2```',
        '| 3 | Failure | curl | 200 | ❌ | saw 500 |',
      ]),
    ];
    expect(await latestTestVerdict(repo, 5)).toMatchObject({
      failures: [{ number: '3', scenario: 'Failure', expected: '200', evidence: 'saw 500' }],
      total: 3,
      passed: 1,
      incomplete: true,
    });
  });

  it.each(['comment', 'comment with fence', '    ', '\t', 'pre', 'PRE', 'textarea', 'script', 'style'])(
    'ignores literal sample tables in %j context and resumes real results',
    async (context) => {
      const header = '| # | Scenario | Steps | Expected | Status | Evidence |';
      const divider = '|---|---|---|---|---|---|';
      const sample = [header, divider, '| 2 | Example | steps | value | ⬜ | |'];
      const hidden = context.startsWith('comment')
        ? ['<!--', ...(context.endsWith('fence') ? ['```markdown', ...sample, '```'] : sample), '-->']
        : /^\s+$/.test(context)
          ? sample.map((line) => context + line)
          : [`<${context}>`, ...sample, `</${context}>`];
      for (const status of ['✅', '❌']) {
        gh.comments = [
          sheet([
            '| 1 | API | curl | 200 | ✅ | response.json |',
            '',
            ...hidden,
            '',
            header,
            divider,
            `| 3 | Real | curl | 200 | ${status} | response.json |`,
          ]),
        ];
        expect(await latestTestVerdict(repo, 5)).toEqual({
          failures:
            status === '❌'
              ? [{ number: '3', scenario: 'Real', expected: '200', evidence: 'response.json' }]
              : [],
          total: 2,
          passed: status === '✅' ? 2 : 1,
          manual: 0,
          incomplete: false,
        });
      }
    },
  );

  it.each([' ```markdown', '   ~~~markdown'])(
    'ignores examples inside a valid indented fence: %s',
    async (fence) => {
      gh.comments = [
        sheet([
          '| 1 | API | curl | 200 | ✅ | response.json |',
          '',
          fence,
          '    ' + fence.trim().replace('markdown', ''),
          '| # | Scenario | Steps | Expected | Status | Evidence |',
          '|---|---|---|---|---|---|',
          '| 2 | Example | steps | value | ❌ | example only |',
          fence.replace('markdown', ''),
        ]),
      ];
      expect(await latestTestVerdict(repo, 5)).toMatchObject({
        failures: [],
        total: 1,
        passed: 1,
        incomplete: false,
      });
    },
  );

  it('counts an unnumbered result row and retains a later failure', async () => {
    gh.comments = [
      sheet([
        '| 1 | API | curl | 200 | ✅ | response.json |',
        '| | UI | Open profile | Profile visible | ⬜ | |',
        '| 3 | Failure | curl | 200 | ❌ | saw 500 |',
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

  it.each(['', 'A', '**API**'])('retains results after scenario identifier %j', async (identifier) => {
    gh.comments = [
      sheet([
        '| 1 | API | curl | 200 | ✅ | response.json |',
        `| ${identifier} | UI | Open | Shown | ⬜ | |`,
        '| 3 | Bad | curl | 200 | ❌ | 500 |',
      ]),
    ];
    expect(await latestTestVerdict(repo, 5)).toEqual({
      failures: [{ number: '3', scenario: 'Bad', expected: '200', evidence: '500' }],
      total: 3,
      passed: 1,
      manual: 0,
      incomplete: true,
    });
  });

  it.each([
    '| A | UI | Open | visible | ⬜ |',
    '| | UI | Open | visible | ⬜ |',
    '| A | UI | Open | visible |',
    '| A | UI | Open |',
    '| A | UI |',
    '| A |',
  ])('retains later failures after shortened nonnumeric row %s', async (row) => {
    gh.comments = [
      sheet([
        '| 1 | API | curl | 200 | ✅ | response.json |',
        row,
        '| 3 | Failure | curl | 200 | ❌ | saw 500 |',
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

  it.each([
    '✅ API; UI never tested',
    '✅ API; UI not covered',
    '✅ API; UI skipped on this host',
    '✅ API; UI blocked waiting for credentials',
    '✅ API; Firefox was never executed after setup',
    '✅ API; browser skipped until credentials arrive',
    '✅ API; **UI blocked** awaiting a test account',
    '✅ Verified API blocked by authorization policy; expected 403 received; UI never tested',
  ])('does not certify missing execution regardless of its explanation: %s', async (status) => {
    gh.comments = [
      sheet([`| 1 | Mixed API/UI | curl then browser | Both work | ${status} | response.json |`]),
    ];
    expect(await latestTestVerdict(repo, 5)).toEqual({
      failures: [],
      total: 1,
      passed: 0,
      manual: 0,
      incomplete: true,
    });
  });

  it.each([
    ['✅ Verified API blocked by authorization policy; expected 403 received', true],
    ['✅ Verified API blocked by authorization policy; expected 403 received; UI not run', false],
  ])(
    'preserves verified authorization results while checking remaining coverage: %s',
    async (status, passed) => {
      gh.comments = [
        sheet([
          `| 1 | Authorization | curl without permission | 403 blocked by policy | ${status} | response.json |`,
        ]),
      ];
      expect(await latestTestVerdict(repo, 5)).toMatchObject({
        total: 1,
        passed: passed ? 1 : 0,
        incomplete: !passed,
      });
    },
  );

  it.each([
    '| # | Scenario | Steps | Expected | Status (✅/❌) | Evidence |',
    '| # | Scenario | Steps | Expected | **Status (✅ / ❌)** | _Evidence_ |',
    '| # | Scenario | Steps | Expected | Status [✅/❌] | Evidence |',
    '| # | Scenario | Steps | Expected | Status ✅/❌ | Evidence |',
    '| # | Scenario | Steps | Expected | **Status ✅/❌** | _Evidence_ |',
    '| # | Scenario | Steps | Expected | Status | Video |',
    '| Case | Scenario | Request | Response | **Result** | _Video / response_ |',
    '| # | Scenario | Steps | Expected | Result | Evidence |',
    '| # | Escenario | Pasos | Esperado | Estado | Evidencia |',
    '| Case | Scenario | Request | Response | **Result (status)** | _Evidence / video_ |',
    '| # | Scenario | Steps | Expected | Status | Evidence / video |',
    '| # | Scenario | Steps | Expected | Status (result) | Evidence |',
    '| # | Scenario | Steps | Expected | **Status (result)** | _Evidence / video_ |',
    '| Case | Scenario | Request | Response | **Status** | _Evidence (video)_ |',
    '| Case | Scenario | Steps | Expected | Status | Evidence |',
    '| **Case** | API scenario | Request | Response | **Status** | _Evidence_ |',
    '| Test case | Scenario | Steps | Expected | Status | Evidence |',
    '| ID | API scenario | Request | Expected | Status | Evidence |',
    '| **ID** | Case | Request | Response | **Status** | _Evidence_ |',
    '| No. | Scenario | Steps | Expected | Status | Evidence |',
    '| **No.** | Case | Request | Response | **Status** | _Evidence_ |',
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

  it.each([
    '| # | Scenario | Steps | Expected | Statut | Preuve |',
    '| **ID** | Cas | Requête | Attendu | **Statut** | _Preuve_ |',
    '| 番号 | シナリオ | 手順 | 期待値 | 結果 | 証拠 |',
  ])('recognizes numbered QA results independently of header language: %s', async (header) => {
    const table = [header, '|---|---|---|---|---|---|'];
    gh.comments = [
      sheet([
        '| 1 | API | curl | 200 | ✅ | response.json |',
        '',
        ...table,
        '| 2 | Pending | curl | 200 | | |',
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
    gh.comments = [
      { body: [TEST_SHEET_ANCHOR, ...table, '| 1 | API | curl | 200 | ✅ | response.json |'].join('\n') },
    ];
    expect(await latestTestVerdict(repo, 5)).toMatchObject({ total: 1, passed: 1, incomplete: false });
  });

  it.each([
    '| N. | Scenario | Passi | Atteso | Stato | Prova |',
    '| **N.** | Scenario | Passi | Atteso | **Stato** | _Prova_ |',
    '| Nr. | Szenario | Schritte | Erwartet | Status | Nachweis |',
    '| **Nr.** | Szenario | Schritte | Erwartet | **Status** | _Nachweis_ |',
    '| Nº | Scénario | Étapes | Attendu | Statut | Preuve |',
    '| **ID** | Cas | Requête | Attendu | **Statut** | _Preuve_ |',
    '| 番号 | シナリオ | 手順 | 期待値 | 結果 | 証拠 |',
  ])('counts localized unexecuted results without known QA markers: %s', async (header) => {
    for (const status of ['', '🟢']) {
      gh.comments = [
        sheet([
          '| 1 | API | curl | 200 | ✅ | response.json |',
          '',
          header,
          '|---|---|---|---|---|---|',
          `| 2 | New endpoint | curl /new | 200 | ${status} | ${status ? 'response.json' : ''} |`,
        ]),
      ];
      expect(await latestTestVerdict(repo, 5)).toEqual({
        failures: [],
        total: 2,
        passed: 1,
        manual: 0,
        incomplete: true,
      });
    }
  });

  it.each([
    '| Nº | Cenário | Passos | Esperado | Situação | Evidências |',
    '| **Nº** | Cenário | Passos | Esperado | **Situação** | _Evidências_ |',
    '| № | Сценарий | Шаги | Ожидаемо | Результат | Доказательство |',
    '| **№** | Сценарий | Шаги | Ожидаемо | **Результат** | _Доказательство_ |',
  ])('retains localized results independently of execution status: %s', async (header) => {
    for (const status of ['', 'unknown', '❌', '✅']) {
      gh.comments = [
        sheet([
          '| 1 | API | curl | 200 | ✅ | response.json |',
          '',
          header,
          '|---|---|---|---|---|---|',
          `| 2 | API | curl | 200 | ${status} | ${status ? 'response.json' : ''} |`,
        ]),
      ];
      expect(await latestTestVerdict(repo, 5)).toEqual({
        failures:
          status === '❌'
            ? [{ number: '2', scenario: 'API', expected: '200', evidence: 'response.json' }]
            : [],
        total: 2,
        passed: status === '✅' ? 2 : 1,
        manual: 0,
        incomplete: !['❌', '✅'].includes(status),
      });
    }
  });

  it('does not infer QA results from an unrelated numbered six-column table', async () => {
    gh.comments = [
      sheet([
        '| 1 | API | curl | 200 | ✅ | response.json |',
        '',
        '| # | Resource | Method | Path | HTTP code | Response |',
        '|---|---|---|---|---|---|',
        '| 200 | Users | GET | /users | 200 | response.json |',
      ]),
    ];
    expect(await latestTestVerdict(repo, 5)).toMatchObject({ total: 1, passed: 1, incomplete: false });
  });

  it.each([
    '| # | Scenario | Steps | Expected | Outcome | Proof |',
    '| **ID** | API scenario | Request | Response | **Outcome** | _Proof_ |',
  ])('recognizes the scenario schema without relying on result markers: %s', async (header) => {
    for (const status of ['', 'unknown', '🟢', '❌', '✅']) {
      gh.comments = [
        sheet([
          '| 1 | API | curl | 200 | ✅ | response.json |',
          '',
          header,
          '|---|---|---|---|---|---|',
          `| 2 | UI | Open page | Visible | ${status} | screenshot.png |`,
        ]),
      ];
      expect(await latestTestVerdict(repo, 5)).toEqual({
        failures:
          status === '❌'
            ? [{ number: '2', scenario: 'UI', expected: 'Visible', evidence: 'screenshot.png' }]
            : [],
        total: 2,
        passed: status === '✅' ? 2 : 1,
        manual: 0,
        incomplete: !['❌', '✅'].includes(status),
      });
    }
  });

  it('recognizes a custom table with a shortened inline-code row before its failure', async () => {
    gh.comments = [
      {
        body: [
          TEST_SHEET_ANCHOR,
          '| # | Scenario | Steps | Expected | Statut | Preuve |',
          '|---|---|---|---|---|---|',
          '```1```',
          '| 2 | Failure | curl | 200 | ❌ | saw 500 |',
        ].join('\n'),
      },
    ];
    expect(await latestTestVerdict(repo, 5)).toEqual({
      failures: [{ number: '2', scenario: 'Failure', expected: '200', evidence: 'saw 500' }],
      total: 2,
      passed: 0,
      manual: 0,
      incomplete: true,
    });
  });

  it.each(['---', '## More results', '<!-- separate table -->', '```'])(
    'bounds custom-schema detection before %s',
    async (boundary) => {
      gh.comments = [
        sheet([
          '| 1 | API | curl | 200 | ✅ | response.json |',
          '',
          '| # | Resource | Method | Path | HTTP code | Response |',
          '|---|---|---|---|---|---|',
          '| 200 | Users | GET | /users | 200 | response.json |',
          boundary,
          '| # | Scenario | Steps | Expected | Statut | Preuve |',
          '|---|---|---|---|---|---|',
          '| 2 | Failure | curl | 200 | ❌ | saw 500 |',
          ...(boundary === '```' ? ['```'] : []),
        ]),
      ];
      expect(await latestTestVerdict(repo, 5)).toMatchObject({
        total: boundary === '```' ? 1 : 2,
        passed: 1,
        incomplete: false,
      });
    },
  );

  it.each([['Method'], ['Environment'], ['**Method**', '`Environment`']])(
    'reads results with extra columns %j',
    async (...extraHeaders) => {
      const header = `| Case | Scenario | ${extraHeaders.join(' | ')} | Steps | Expected | **Status** | _Evidence_ |`;
      const extraCells = extraHeaders.map(() => 'curl').join(' | ');
      const rows = [
        header,
        `|${Array(6 + extraHeaders.length)
          .fill('---')
          .join('|')}|`,
      ];
      gh.comments = [
        sheet([
          '| 1 | Browser | Open | Shown | ✅ | video |',
          '',
          ...rows,
          `| 2 | API | ${extraCells} | GET /api | 200 | ❌ | got 500 |`,
          '| 3 | UI |',
        ]),
      ];
      expect(await latestTestVerdict(repo, 5)).toEqual({
        failures: [{ number: '2', scenario: 'API', expected: '200', evidence: 'got 500' }],
        total: 3,
        passed: 1,
        manual: 0,
        incomplete: true,
      });
      gh.comments = [
        {
          body: [
            TEST_SHEET_ANCHOR,
            ...rows,
            `| 1 | API | ${extraCells} | GET /api | 200 | ✅ | response.json |`,
          ].join('\n'),
        },
      ];
      expect(await latestTestVerdict(repo, 5)).toMatchObject({ total: 1, passed: 1, incomplete: false });
      gh.comments = [
        {
          body: [TEST_SHEET_ANCHOR, ...rows, `| 1 | API | ${extraCells} | GET /api | 200 | ✅ |`].join('\n'),
        },
      ];
      expect(await latestTestVerdict(repo, 5)).toMatchObject({ total: 1, passed: 0, incomplete: true });
    },
  );

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

  it.each(['</details>', '</DETAILS>', '  </details>'])(
    'ends collapsible results at %s without counting a phantom scenario',
    async (closingTag) => {
      const wrapped = sheet(['| 1 | API | curl /api | 200 | ✅ | response.json |', closingTag]);
      wrapped.body = '<details>\n<summary>QA</summary>\n\n' + wrapped.body;
      gh.comments = [wrapped];
      expect(await latestTestVerdict(repo, 5)).toEqual({
        failures: [],
        total: 1,
        passed: 1,
        manual: 0,
        incomplete: false,
      });
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

  it.each([
    '- API assertions were checked.',
    '> Evidence is attached above.',
    '1. Response header values verified.',
    '2. Response header values verified.',
    '2) Response header values verified.',
  ])('ends results before the Markdown block %s', async (boundary) => {
    gh.comments = [sheet(['| 1 | API | curl /api | 200 | ✅ | response.json |', boundary])];
    expect(await latestTestVerdict(repo, 5)).toMatchObject({ total: 1, passed: 1, incomplete: false });
    gh.comments[0].body += '\n\n' + sheet(['| 2 | Failure | curl /api | 200 | ❌ | saw 500 |']).body;
    expect(await latestTestVerdict(repo, 5)).toMatchObject({
      failures: [{ number: '2', scenario: 'Failure', expected: '200', evidence: 'saw 500' }],
      total: 2,
      passed: 1,
      incomplete: false,
    });
  });

  it.each(['✅', '⬜', '❌'])('ignores a standalone pre sample with status %s', async (status) => {
    gh.comments = [
      {
        body: `${TEST_SHEET_ANCHOR}\n<pre>\n${sheet([`| 1 | Example | curl | 200 | ${status} | response.json |`]).body}\n</pre>`,
      },
    ];
    expect(await latestTestVerdict(repo, 5)).toEqual({
      failures: [],
      total: 0,
      passed: 0,
      manual: 0,
      incomplete: true,
    });
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
    'Could not capture response.json',
    '**Could not capture response.json**',
    '<span>Could not capture response.json</span>',
    'Unable to save response.json',
    'Could not record video.webm',
    'Nothing was recorded',
    'Nothing was captured.',
    '**Nothing was recorded**',
    'Nothing was saved: response.json could not be created',
    'No evidence: could not save response.json',
    'No evidence. Could not save response.json',
    '**No evidence: could not save response.json**',
    '<span>No video. Could not save capture.webm</span>',
    'No evidence was captured because upload failed for response.json',
    'No video was recorded because capture failed in capture.webm',
    '**No evidence was captured because upload failed for response.json**',
    '<span>No video was recorded because capture failed in capture.webm</span>',
    'Evidence was not captured because upload failed for response.json',
    'Evidence has not been captured',
    'No response body captured',
    'No screenshots recorded',
    'Video could not be recorded',
    'No evidence was obtained',
    '**Evidence has not been captured.**',
    '<span>Video could not be recorded</span>',
    'Evidence unavailable because upload failed',
    'Evidence unavailable (upload failed)',
    'No HTTP responses recorded',
    '**Evidence unavailable because upload failed.**',
    '<span>Evidence unavailable (upload failed)</span>',
    '<span>No HTTP responses recorded</span>',
    'Evidence not yet available',
    '**Evidence not yet available.**',
    '<span>Evidence not yet available</span>',
    'No execution evidence',
    '**No execution evidence.**',
    '<span>No execution evidence</span>',
    'Not uploaded',
    '**Not uploaded.**',
    '<span>Not uploaded</span>',
    'Not recorded yet',
    '**Not recorded yet.**',
    '<span>No evidence has been uploaded yet</span>',
    'No evidence has been uploaded yet',
    'Evidence was not generated',
    '**Evidence was not generated.**',
    '<span>Evidence was not produced</span>',
    'Could not run: credentials missing',
    '**Could not run: credentials missing**',
    '<span>Could not run: credentials missing</span>',
    'No evidence was generated',
    '**No evidence was generated.**',
    '<span>No evidence could be produced</span>',
    'No evidence could be produced',
    'pending',
    'Upload pending',
    'N/A (no browser)',
    'No recording due to browser crash',
    'No evidence was produced',
    '**No evidence was produced.**',
    '<span>No evidence has been produced</span>',
    'Not run due to missing node.js',
    'No video was recorded because capture failed in capture.js',
    '**Not run due to missing node.js**',
    '<span>No video was recorded because capture failed in capture.js</span>',
    'Evidence was not uploaded',
    'No video was recorded',
    'Not run due to missing credentials',
    'Not tested on this host',
    'Skipped because browser failed',
    '**Evidence was not uploaded.**',
    '<span>No video was recorded</span>',
    '![]()',
    'No evidence (upload failed)',
    'Not run; credentials missing',
    '**No evidence (upload failed)**',
    '<span>Not run; credentials missing</span>',
    'No evidence; upload failed',
    'Not tested (credentials missing)',
    'No evidence uploaded',
    'Evidence unavailable',
    '**No evidence uploaded.**',
    '<span>Evidence unavailable</span>',
    'No evidence has been uploaded',
    'Evidence is unavailable',
    'No evidence saved',
    'No evidence: browser unavailable',
    'No evidence captured because the upload failed',
    'Not run — missing browser',
    'Not verified because browser is unavailable',
    '**No evidence saved.**',
    '<span>No evidence captured because the upload failed</span>',
    'No evidence was collected',
    'No evidence has been collected',
    '**No evidence was collected.**',
    'Evidence pending',
    '<span>Evidence pending</span>',
    'Not tested — browser unavailable',
    'Not tested - browser unavailable',
    '![ ]()',
    '**![]()**',
    'Not executed: browser unavailable',
    'Not executed because browser unavailable',
    'API passed; UI skipped (browser unavailable)',
    'No evidence attached',
    '<span/>',
    '<img src="">',
    '<img src="" />',
    "<img src='   '>",
    '<img>',
    '<img src="" alt=" ">',
    'not captured',
    'not available',
    'N/A - not recorded',
    '**not captured**',
    '<span>not available</span>',
    '<span class="evidence" />',
    '<hr>',
    '<hr />',
    '[]()',
    '<div>[]()<span/></div>',
    '&#8203;',
    '&#x200B;',
    '\u200b',
    '**<hr>&#8203;[]()**',
    '<span></span>',
    '<div><br></div>',
    '&ensp;',
    '&emsp;',
    '&#8194;',
    '&#x2003;',
    '<div><span>&thinsp;</span></div>',
    '<span class="evidence">**TODO**</span>',
    '<div></div><span>_N/A_</span>',
    '<br>',
    '<br/>',
    '<br />',
    '&nbsp;',
    '&#160;',
    '&#xA0;',
    '<!-- TODO -->',
    '**<br>&nbsp;<!-- TODO -->**',
    '<!-- note --> _N/A_ <br>',
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
    'No evidence exists',
    'Evidence missing',
    'Evidence not available',
    'No artifacts',
    '**No evidence exists.**',
    '<span>Evidence is missing</span>',
    'Evidence was not available',
    'No artifacts uploaded',
    'No evidence available',
    'No evidence collected',
    'not collected',
    'N/A - not collected',
    '**No evidence collected.**',
    '<span>No evidence collected</span>',
    'No evidence available.',
    'No evidence saved because browser<br>is unavailable',
    'no evidence',
    'NO EVIDENCE PROVIDED',
    '**No evidence available**',
    '<span>No evidence available</span>',
    'not run',
    'not yet run',
    '_not executed_',
    'not tested',
    'No evidence is available',
    'No evidence is available. Upload failed for response.json.',
    '**No evidence is available**',
    '<span>No evidence is available</span>',
    'No screenshots are available',
    'Unable to capture evidence',
    'Unable to capture evidence. Upload failed for response.json.',
    '**Unable to capture evidence**',
    '<span>Unable to capture evidence</span>',
    'Unable to save recording because capture failed for capture.webm',
    'No evidence attached. Upload failed.',
    'No evidence attached. Upload failed for response.json.',
    'Evidence missing. Upload failed.',
    'No video was recorded. Capture failed in capture.webm.',
    'Not saved.',
    '**Not saved.**',
    'Not saved. Upload failed.',
    'Not saved. Upload failed for response.json',
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
    '✅ API manual refund processed successfully',
    '✅ UI regression tests pending payment shown correctly',
    '✅ UI smoke tests manual payment saved successfully',
    '✅ API blocked user forbidden with 403',
    '✅ API: blocked recently revoked user forbidden with 403',
    '✅ UI pending payment renders correctly',
    '✅ API manual refund succeeds',
    '✅ UI pending payment persists successfully',
    '✅ API blocked user returned 403',
    '✅ UI pending payment displayed correctly',
    '✅ UI tests pending payment shown correctly',
    '✅ UI manual payment saved successfully',
    '✅ API manual refund completed successfully',
    '✅ API blocked user sees 403',
    '✅ API blocked user denied with 403',
    '✅ API blocked user rejected with 403',
    '✅ API: blocked recently revoked user rejected with 403',
    '✅ GET /health; POST /orders returns 201',
    '✅ POST /api/orders returns 201',
    '✅ GET / returns 200',
    '✅ API blocked user cannot access /admin',
    '✅ API blocked user cannot enter /admin',
    '✅ API: blocked recently revoked user cannot enter /admin',
    "✅ API blocked user can't enter /admin",
    '✅ UI failed account returns 403',
    '✅ UI pending payment shown correctly',
    '✅ UI pending payment remains visible',
    '✅ API: blocked recently revoked user denied with 403',
    '✅ UI: pending payment remains visible',
    '✅ UI manual payment is recorded',
    '✅ API blocked user is not allowed',
    '✅ UI pending payment is shown as required',
    '✅ API blocked user gets 403',
    '✅ UI pending payment displays correctly',
    '✅ UI pending payment appears',
    '✅ API: blocked revoked user gets 403',
    '✅ UI unknown route returns 404',
    '✅ UI failed payment is displayed',
    '✅ API incomplete profile returns 422',
    '✅ API blocked user is denied with 403',
    '✅ API: blocked revoked user was denied with 403',
    '✅ API skipped expired notification is ignored',
    '✅ API blocked revoked user returns 403',
    '✅ API: blocked recently revoked user receives 403',
    '✅ API skipped expired payment notification returns 204',
    '✅ API manual payment is displayed',
    '✅ UI tests verify unknown route returns 404',
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
    [
      'Fetch manual payment',
      'GET /payments/1 for existing manual payment',
      'HTTP 200 with manual payment',
      '✅ API manual payment fetched successfully',
      'response.json',
    ],
    [
      'Read pending invoice',
      'GET /invoices/1 for pending invoice',
      'HTTP 200 with pending invoice',
      '✅ API pending invoice retrieved successfully',
      'response.json',
    ],
    [
      'Manual payment deletion',
      'DELETE /payments/1 for existing manual payment',
      'HTTP 204 and payment deleted',
      '✅ API manual payment deleted successfully',
      'response.json',
    ],
    [
      'Pending invoice payment',
      'POST /invoices/1/pay for pending invoice',
      'HTTP 200 and paid invoice',
      '✅ API pending invoice paid successfully',
      'response.json',
    ],
    [
      'Cancelled order refund',
      'POST /orders/1/refund for cancelled order',
      'HTTP 200 and refunded order',
      '✅ API cancelled order refunded successfully',
      'response.json',
    ],
    [
      'Manual payment creation',
      'POST /payments with manual=true',
      'HTTP 201 and persisted payment',
      '✅ API manual payment created successfully',
      'response.json',
    ],
    [
      'Pending payment update',
      'PATCH /payments/1',
      'HTTP 200 and persisted payment',
      '✅ API pending payment updated successfully',
      'response.json',
    ],
    [
      'Manual payment',
      'POST /payments with manual=true',
      'HTTP 201 and persisted payment',
      '✅ API manual payment submitted successfully',
      'response.json',
    ],
    [
      'Reject invalid request',
      'POST /users with invalid email; check HTTP 422 validation response',
      'HTTP 422 and validation error',
      '✅ API validation failed as expected',
      'response.json',
    ],
    [
      'Queue a pending job',
      'POST /jobs',
      'HTTP 202 queued',
      '✅ API pending jobs queued correctly',
      'response.json',
    ],
    [
      'Manual refund',
      'POST /refunds with manual=true',
      'HTTP 200 approved',
      '✅ API manual refund approved with 200',
      'response.json',
    ],
    [
      'Manual refund',
      'POST /refunds with manual=true',
      'HTTP 202 accepted',
      '✅ API manual refund accepted with 202',
      'response.json',
    ],
    [
      'Sold out',
      'Open product with stock=0, try Buy',
      'Purchase is refused for unavailable product',
      '✅ UI unavailable product cannot be purchased',
      'checkout.webm',
    ],
    [
      'Optional nickname is omitted',
      'POST /users with nickname key absent',
      '200 and persisted user',
      '✅ API omitted optional field returns 200',
      'response.json',
    ],
    [
      'Accept terms validation',
      'Open checkout, leave terms unchecked, click Pay',
      'Cannot complete checkout without accepting terms',
      '✅ UI cannot finish checkout without accepting terms',
      'checkout.webm',
    ],
  ])(
    'accepts observed negative-test outcomes for %s',
    async (scenario, steps, expected, status, evidence) => {
      for (const suffix of ['', '; UI not fully tested']) {
        gh.comments = [
          sheet([`| 1 | ${scenario} | ${steps} | ${expected} | ${status}${suffix} | ${evidence} |`]),
        ];
        expect(await latestTestVerdict(repo, 5)).toMatchObject({
          failures: [],
          total: 1,
          passed: suffix ? 0 : 1,
          incomplete: !!suffix,
        });
      }
      gh.comments = [
        sheet([`| 1 | ${scenario} | ${steps} | ${expected} | ✅ | ${status.replace('✅ ', '')} |`]),
      ];
      expect(await latestTestVerdict(repo, 5)).toMatchObject({ total: 1, passed: 1, incomplete: false });
    },
  );

  it.each([
    [
      'Invalid password',
      'Submit bad credentials',
      'Login failed error is shown',
      'UI login failed as expected',
      '[video](https://x/login.webm)',
    ],
    [
      'Invalid password',
      'Submit bad credentials',
      '401 Unauthorized',
      'API login failed as expected',
      'response.json',
    ],
    [
      'Wrong password rejected',
      'Enter wrong password',
      'Login fails',
      'UI login failed as expected',
      'login.webm',
    ],
    [
      'Timeout shown',
      'Request slow upstream',
      'Timeout error is displayed',
      'UI timed out error was displayed as expected',
      'video.webm',
    ],
    [
      'Admin denied',
      'Open /admin',
      'User cannot access /admin',
      'UI cannot access /admin as expected',
      'access.webm',
    ],
    [
      'Admin denied',
      'Open /admin/settings',
      'User cannot access /admin/settings',
      'UI cannot access /admin/settings as expected',
      'access.webm',
    ],
    [
      'Admin API denied',
      'Open /api/UI',
      'User cannot access /api/UI',
      'UI cannot access /api/UI as expected',
      'access.webm',
    ],
    ['Gateway timeout', 'Request slow upstream', 'HTTP 504', 'API timed out as expected', 'response.json'],
    [
      'Request timeout',
      'Request slow upstream',
      'Timeout error is returned',
      'API timed out as expected',
      'response.json',
    ],
  ])(
    'accepts the observed expected execution error for %s',
    async (scenario, steps, expected, outcome, artifact) => {
      for (const [status, evidence] of [
        [`✅ ${outcome}`, artifact],
        ['✅', outcome],
      ]) {
        for (const unfinished of ['', '; UI not run', '; UI setup failed']) {
          gh.comments = [
            sheet([`| 1 | ${scenario} | ${steps} | ${expected} | ${status}${unfinished} | ${evidence} |`]),
          ];
          expect(await latestTestVerdict(repo, 5)).toMatchObject({
            total: 1,
            passed: unfinished ? 0 : 1,
            incomplete: !!unfinished,
          });
        }
      }
    },
  );

  it.each([
    [
      'Offline error',
      'Disconnect network then open app',
      'UI cannot connect; offline error is shown',
      'UI cannot connect as expected',
      'offline.webm',
    ],
    [
      'Terms required',
      'Leave terms unchecked then click Pay',
      'Cannot complete checkout',
      'UI cannot complete checkout as expected',
      'checkout.webm',
    ],
    [
      'Terms required',
      'Leave terms unchecked then click Pay',
      'Cannot finish checkout',
      'API cannot finish checkout as expected',
      'response.json',
    ],
    [
      'Deleted page',
      'Delete page then open it',
      'Page cannot load after deletion',
      'UI cannot load page as expected',
      'video.webm',
    ],
    [
      'Browser compatibility',
      'Open using unsupported browser',
      'Browser is not supported',
      'Browser not supported as expected',
      'result.json',
    ],
  ])(
    'accepts observed expected restrictions for %s',
    async (scenario, steps, expected, outcome, artifact) => {
      for (const [status, evidence] of [
        [`✅ ${outcome}`, artifact],
        ['✅', `${outcome}; ${artifact}`],
      ]) {
        for (const [statusSuffix, evidenceSuffix] of [
          ['', ''],
          ['; UI never opened', ''],
          ['', '; UI never launched'],
          ['; UI setup failed', ''],
          ['; frontend not run', ''],
          ['', '; UI browser crashed before testing'],
        ]) {
          gh.comments = [
            sheet([
              `| 1 | ${scenario} | ${steps} | ${expected} | ${status}${statusSuffix} | ${evidence}${evidenceSuffix} |`,
            ]),
          ];
          const incomplete = !!(statusSuffix || evidenceSuffix);
          expect(await latestTestVerdict(repo, 5)).toMatchObject({
            total: 1,
            passed: incomplete ? 0 : 1,
            incomplete,
          });
        }
      }
    },
  );

  it.each([
    ['HTTP 401 and invalid credentials shown', 'UI login failed with HTTP 401 as expected'],
    ['HTTP 401 and invalid credentials shown', 'UI login failed: invalid credentials error was displayed'],
    ['401 Unauthorized', 'API login failed with HTTP 401 Unauthorized as expected'],
    ['Incorrect password error is shown', 'UI login failed: incorrect password error was shown'],
  ])('accepts an observed login rejection: %s / %s', async (expected, outcome) => {
    for (const [status, evidence] of [
      [`✅ ${outcome}`, '[video](https://example.com/login.webm)'],
      ['✅', `${outcome}; [video](https://example.com/login.webm)`],
    ]) {
      for (const [statusSuffix, evidenceSuffix] of [
        ['', ''],
        ['; UI browser tests were not run', ''],
        ['', '; UI assertions were never executed'],
        ['; UI setup failed', ''],
      ]) {
        gh.comments = [
          sheet([
            `| 1 | Invalid password | Submit bad credentials | ${expected} | ${status}${statusSuffix} | ${evidence}${evidenceSuffix} |`,
          ]),
        ];
        const incomplete = !!(statusSuffix || evidenceSuffix);
        expect(await latestTestVerdict(repo, 5)).toMatchObject({
          failures: [],
          total: 1,
          passed: incomplete ? 0 : 1,
          incomplete,
        });
      }
    }
  });

  it.each([
    ['HTTP 403 Forbidden', 'API login failed with HTTP 403 as expected'],
    ['HTTP 404 Not Found', 'API login failed with HTTP 404 as expected'],
    ['HTTP 504', 'API timed out with HTTP 504 as expected'],
    ['HTTP 408', 'API timed out with HTTP 408 as expected'],
  ])('accepts matching observed HTTP errors: %s / %s', async (expected, outcome) => {
    for (const [status, evidence] of [
      [`✅ ${outcome}`, 'response.json'],
      ['✅', `${outcome}; response.json`],
    ]) {
      for (const unfinished of ['', '; UI tests unverified', '; UI setup failed']) {
        gh.comments = [
          sheet([
            `| 1 | Negative API check | POST /login or slow upstream | ${expected} | ${status}${unfinished} | ${evidence} |`,
          ]),
        ];
        expect(await latestTestVerdict(repo, 5)).toMatchObject({
          failures: [],
          total: 1,
          passed: unfinished ? 0 : 1,
          incomplete: !!unfinished,
        });
      }
    }
  });

  it.each([
    ['Return HTTP 500 and display fallback error', 'API failed with HTTP 500 as expected'],
    ['API request is rejected with 422', 'API failed as expected (422 validation response)'],
    ['Return HTTP 409', 'API failed as expected (HTTP 409 response)'],
    ['Return HTTP 503', 'API failed with HTTP 503 as expected'],
    ['Return a timeout error', 'API timed out after 30 seconds as expected'],
    ['Return a timeout error', 'API timed out after 0.5 seconds as expected'],
    ['Return a timeout error', 'API timed out after 500 ms as expected'],
    ['Return HTTP 504', 'API timed out after 30 seconds with HTTP 504 as expected'],
  ])('accepts matching expected API error outcomes: %s / %s', async (expected, outcome) => {
    for (const [status, evidence] of [
      [`✅ ${outcome}`, 'response.json'],
      ['✅', `${outcome}; response.json`],
    ]) {
      for (const [statusSuffix, evidenceSuffix] of [
        ['', ''],
        ['; UI not run', ''],
        ['', '; UI setup failed'],
        ['', '; Unable to launch Chromium (missing executable).'],
      ]) {
        gh.comments = [
          sheet([
            `| 1 | Negative API check | Request failing upstream | ${expected} | ${status}${statusSuffix} | ${evidence}${evidenceSuffix} |`,
          ]),
        ];
        const incomplete = !!(statusSuffix || evidenceSuffix);
        expect(await latestTestVerdict(repo, 5)).toMatchObject({
          failures: [],
          total: 1,
          passed: incomplete ? 0 : 1,
          incomplete,
        });
      }
    }
  });

  it.each([
    ['HTTP 200', 'API failed with HTTP 500 as expected'],
    ['HTTP 422', 'API failed with HTTP 500 as expected'],
    ['HTTP 500', 'API failed as expected (422 validation response)'],
    ['HTTP 200', 'API failed as expected (422 validation response)'],
    ['HTTP 422', 'API failed as expected (422 checks were not run)'],
    ['HTTP 500', 'API failed with HTTP 500 before tests started'],
    ['HTTP 500', 'UI browser startup failed with HTTP 500 as expected'],
    ['HTTP 500', 'UI setup failed as expected (500 response)'],
    ['HTTP 200', 'API timed out after 30 seconds as expected'],
    ['HTTP 408', 'API timed out after 30 seconds with HTTP 504 as expected'],
    ['Return a timeout error', 'API timed out after 30 seconds before tests started'],
  ])('keeps unexpected API errors and setup failures incomplete: %s / %s', async (expected, outcome) => {
    for (const [status, evidence] of [
      [`✅ ${outcome}`, 'response.json'],
      ['✅', `${outcome}; response.json`],
    ]) {
      gh.comments = [sheet([`| 1 | Negative API check | Execute | ${expected} | ${status} | ${evidence} |`])];
      expect(await latestTestVerdict(repo, 5)).toMatchObject({
        failures: [],
        total: 1,
        passed: 0,
        incomplete: true,
      });
    }
  });

  it.each([
    'Unable to launch Chromium (missing executable).',
    'Cannot launch Chrome (missing executable).',
    'Could not launch Firefox (missing executable).',
    "Couldn't launch browser (missing executable).",
    '**Unable to launch Chromium** (missing executable).',
    '<strong>Unable to launch Chromium</strong> (missing executable).',
  ])('keeps blocked browser launches incomplete: %s', async (outcome) => {
    for (const [status, evidence] of [
      [`✅ API passed; ${outcome}`, 'response.json'],
      ['✅', `API curl passed; ${outcome}`],
    ]) {
      gh.comments = [sheet([`| 1 | API and UI | curl then browser | Both work | ${status} | ${evidence} |`])];
      expect(await latestTestVerdict(repo, 5)).toMatchObject({
        failures: [],
        total: 1,
        passed: 0,
        incomplete: true,
      });
    }
  });

  it.each([
    'Chromium launched and UI assertions passed',
    'Unable to launch Chromium was displayed as expected',
  ])('preserves completed browser-launch observations: %s', async (outcome) => {
    gh.comments = [
      sheet([
        `| 1 | Browser launch | Launch Chromium | Show launch result | ✅ | API curl passed; ${outcome}; screenshot.png |`,
      ]),
    ];
    expect(await latestTestVerdict(repo, 5)).toMatchObject({
      failures: [],
      total: 1,
      passed: 1,
      incomplete: false,
    });
  });

  it.each([
    ['UI connects normally', 'UI cannot connect as expected'],
    ['Cannot complete registration', 'UI cannot complete checkout as expected'],
    ['Cannot finish checkout', 'UI cannot finish checkout before tests started'],
    ['UI cannot connect', 'UI cannot connect because browser setup failed'],
    ['Page loads normally', 'UI cannot load page as expected'],
    ['Page cannot open after deletion', 'UI cannot load page as expected'],
    ['Browser is supported', 'Browser not supported as expected'],
    ['Page cannot load after deletion', 'UI cannot load page before tests started'],
    ['Page cannot load after deletion', 'UI could not load the app because browser setup failed'],
    ['HTTP 200', 'UI login failed with HTTP 401 as expected'],
    ['HTTP 401', 'UI login failed with HTTP 500 as expected'],
    ['HTTP 403 and invalid credentials shown', 'UI login failed with HTTP 401 as expected'],
    ['HTTP 200', 'UI login failed: invalid credentials error was displayed'],
    ['HTTP 401', 'UI login failed with HTTP 401 before tests started'],
    ['HTTP 401', 'UI browser login failed with HTTP 401 as expected'],
    ['HTTP 401', 'UI browser login failed: invalid credentials error was displayed'],
    ['200 OK', 'API login failed as expected'],
    ['HTTP 200', 'API timed out as expected'],
    ['HTTP 200', 'API timed out with HTTP 504 as expected'],
    ['HTTP 408', 'API timed out with HTTP 504 as expected'],
    ['HTTP 504', 'API timed out with HTTP 408 as expected'],
    ['HTTP 401', 'API login failed with HTTP 403 as expected'],
    ['HTTP 403', 'API login failed with HTTP 401 as expected'],
    ['HTTP 403', 'API login failed with HTTP 403 before tests started'],
    ['HTTP 504', 'API timed out with HTTP 504 before tests started'],
    ['HTTP 504', 'UI browser startup failed with HTTP 504 as expected'],
    ['HTTP 200', 'UI timed out error was displayed as expected'],
    ['Timeout error is displayed', 'UI timed out before tests started'],
    ['Login fails', 'UI browser login failed as expected'],
    ['HTTP 504', 'UI setup failed as expected'],
    ['401 Unauthorized', 'UI browser startup failed as expected'],
    ['401 Unauthorized', 'UI login failed before tests started'],
  ])('does not exempt setup failures or unexpected errors: %s / %s', async (expected, outcome) => {
    for (const [status, evidence] of [
      [`✅ ${outcome}`, 'response.json'],
      ['✅', outcome],
    ]) {
      gh.comments = [sheet([`| 1 | Negative check | Execute | ${expected} | ${status} | ${evidence} |`])];
      expect(await latestTestVerdict(repo, 5)).toMatchObject({ total: 1, passed: 0, incomplete: true });
    }
  });

  it.each([
    ['✅ API passed; UI never opened', 'response.json'],
    ['✅ API passed; UI never launched', 'response.json'],
    ['✅ API passed; UI not opened', 'response.json'],
    ['✅ API passed; UI not launched', 'response.json'],
    ['✅ API', 'response.json; UI never opened'],
    ['✅ API', 'response.json; UI never launched'],
    ['✅ API', 'response.json; UI not opened'],
    ['✅ API', 'response.json; UI not launched'],
    ['✅ API / ❔ UI', 'response.json'],
    ['✅ / ⚪', 'response.json'],
    ['✅ / ❔', 'response.json'],
    ['✅ API passed; UI did not get tested', 'response.json'],
    ['✅ API', 'response.json; UI did not get tested'],
    ['✅', 'The browser could not be started.'],
    ['✅ API', 'response.json; The browser could not be started.'],
    ['✅ API', 'response.json; ❔ UI'],
    ['✅ API / ⚪ UI', 'response.json'],
  ])('does not certify unknown or explicitly unexecuted portions: %s / %s', async (status, evidence) => {
    gh.comments = [sheet([`| 1 | API and UI | curl then browser | Both work | ${status} | ${evidence} |`])];
    expect(await latestTestVerdict(repo, 5)).toEqual({
      failures: [],
      total: 1,
      passed: 0,
      manual: 0,
      incomplete: true,
    });
  });

  it.each([
    ['HTTP 404', 'API cannot access another tenant record (404 returned as expected)', 'response.json'],
    [
      'HTTP 404 Not Found',
      'API cannot access another tenant record; HTTP 404 Not Found returned as expected',
      'response.json',
    ],
    [
      'HTTP 403 forbidden',
      'API cannot access admin endpoint; HTTP 403 Forbidden returned as expected',
      'response.json',
    ],
    [
      'HTTP 401 unauthorized',
      'API cannot access admin endpoint; HTTP 401 Unauthorized received as expected',
      'response.json',
    ],
    [
      'forbidden (HTTP 403)',
      'API cannot access admin endpoint; HTTP 403 returned as expected',
      'response.json',
    ],
    [
      'Access denied (HTTP 403)',
      'API cannot access admin endpoint; HTTP 403 returned as expected',
      'response.json',
    ],
    ['403 forbidden', 'API cannot access admin endpoint; HTTP 403 returned as expected', 'response.json'],
    ['HTTP 404', 'API cannot load deleted record (404 returned as expected)', 'response.json'],
    ['HTTP 403', 'UI cannot navigate to admin page (403 returned as expected)', 'video.webm'],
    ['HTTP 401', 'UI cannot authenticate (401 returned as expected)', 'response.json'],
    ['HTTP 401', 'UI could not authenticate (401 returned as expected)', 'response.json'],
    ['Access denied', 'UI cannot open admin dashboard; access denied as expected', 'video.webm'],
  ])('accepts an observed expected access restriction: %s', async (expected, outcome, artifact) => {
    for (const [status, evidence] of [
      [`✅ ${outcome}`, artifact],
      ['✅', outcome],
    ]) {
      for (const missing of ['', '; UI could not load the app']) {
        gh.comments = [
          sheet([
            `| 1 | Unauthorized user | Log in as viewer and GET /admin | ${expected} | ${status}${missing} | ${evidence} |`,
          ]),
        ];
        expect(await latestTestVerdict(repo, 5)).toMatchObject({
          total: 1,
          passed: missing ? 0 : 1,
          incomplete: !!missing,
        });
      }
    }
  });

  it.each([
    ['HTTP 403 forbidden', '✅ API cannot access another tenant record (404 returned as expected)'],
    ['HTTP 404', '✅ API cannot access another tenant record (403 returned as expected)'],
    ['HTTP 404', '✅ API cannot access another tenant record'],
    ['HTTP 404', '✅ API cannot load deleted record (403 returned as expected)'],
    ['HTTP 403', '✅ UI cannot navigate to admin page (404 returned as expected)'],
    ['HTTP 401', '✅ UI cannot authenticate (403 returned as expected)'],
    ['HTTP 401', '✅ UI cannot authenticate'],
    ['HTTP 404', '✅ API cannot load deleted record'],
    ['HTTP 403', '✅ UI cannot navigate to admin page'],
    ['HTTP 401 unauthorized', '✅ API cannot access admin endpoint; HTTP 403 Forbidden returned as expected'],
    ['HTTP 403 forbidden', '✅ API cannot access admin endpoint; HTTP 401 Unauthorized returned as expected'],
    ['200 OK', '✅ API cannot access admin endpoint; HTTP 403 returned as expected'],
    ['401 unauthorized', '✅ API cannot access admin endpoint; HTTP 403 returned as expected'],
    ['forbidden (HTTP 401)', '✅ API cannot access admin endpoint; HTTP 403 returned as expected'],
    ['403 forbidden', '✅ API cannot access admin endpoint'],
    ['Access denied', '✅ API; UI could not access the app because browser connection was refused'],
  ])('keeps an unobserved or unexpected restriction incomplete: %s / %s', async (expected, status) => {
    gh.comments = [sheet([`| 1 | Mixed | curl then browser | ${expected} | ${status} | response.json |`])];
    expect(await latestTestVerdict(repo, 5)).toMatchObject({ total: 1, passed: 0, incomplete: true });
  });

  it.each([
    ['Blocked login', 'Blocked user cannot log in', 'UI blocked user cannot log in'],
    ['Pending task', 'HTTP 202 queued', 'API pending task enqueued successfully'],
    ['Pending order', 'Pending order exists in the list', 'UI pending order exists in the list'],
    ['Manual payment', 'Payment can be submitted', 'UI manual payment can be submitted'],
    ['Optional field', 'Unavailable optional field omitted', 'UI unavailable optional field omitted'],
    ['Manual refund', 'Refund successful', 'API manual refund successful'],
    ['Manual refund', 'Refund successful', 'API manual refund refunded successfully'],
    ['Blocked user', 'Redirect to login', 'UI blocked user redirected to login'],
  ])(
    'accepts executed business outcomes for %s while retaining missing coverage',
    async (scenario, expected, outcome) => {
      for (const [status, evidence] of [
        [`✅ ${outcome}`, 'response.json'],
        ['✅', outcome],
      ]) {
        for (const missing of ['', '; UI not able to run']) {
          gh.comments = [
            sheet([`| 1 | ${scenario} | Run procedure | ${expected} | ${status}${missing} | ${evidence} |`]),
          ];
          expect(await latestTestVerdict(repo, 5)).toMatchObject({
            total: 1,
            passed: missing ? 0 : 1,
            incomplete: !!missing,
          });
        }
      }
    },
  );

  it.each([
    '✅ not yet tested',
    '✅ partially tested',
    '✅ API; not yet tested',
    '✅ API<br>**partially tested**',
    '✅ has not yet been tested',
    '✅ only partly executed',
  ])('keeps subjectless unfinished execution incomplete: %s', async (status) => {
    gh.comments = [sheet([`| 1 | Scenario | Run | Works | ${status} | response.json |`])];
    expect(await latestTestVerdict(repo, 5)).toEqual({
      failures: [],
      total: 1,
      passed: 0,
      manual: 0,
      incomplete: true,
    });
  });

  it.each([
    '✅ API; UI needs to run',
    '✅ API; UI needs a browser',
    '✅ API; UI not assessed',
    '✅ API; UI ⏸️',
    '✅ API / UI ❎',
    '✅ API manual payment fetched successfully; UI needs to run',
    '✅ API pending invoice retrieved successfully; UI not assessed',
    '✅ API; UI requires browser installation',
    '✅ API; UI browser not installed',
    '✅ API; UI will need browser testing',
    '✅ API; UI cancelled',
    '✅ API; UI canceled due to server outage',
    '✅ API; API cancelled due to server outage',
    '✅ API manual payment deleted successfully; UI requires browser installation',
    '✅ API pending invoice paid successfully; UI cancelled',
    '✅ API; UI could not navigate to /settings',
    '✅ API; UI browser dependency missing',
    '✅ API; UI ⚪ pending',
    '✅ API; Skipped UI because browser failed',
    '✅ API; Blocked UI because browser failed',
    '✅ API; UI will be tested manually',
    '✅ API; UI could not be launched',
    '✅ API; UI not applicable on this host',
    '✅ API; UI no browser available',
    '✅ API; UI - not run',
    '✅ API; Safari not installed',
    '✅ API; UI could not render',
    '✅ API; UI blocked browser startup returns 500',
    '✅ API; UI blocked login returns 500',
    '✅ API; UI navigation failed before execution',
    '✅ API; UI was not possible on this host',
    '✅ API; UI: TODO',
    '✅ API<br>**UI navigation** failed before execution',
    '✅ API pending task enqueued successfully; UI navigation failed before execution',
    '✅ UI blocked user cannot log in; UI was not possible on this host',
    '✅ API; UI execution timed out before tests started',
    '✅ API; UI tests crashed before execution',
    '✅ API; UI execution aborted',
    '✅ API; UI did not succeed',
    '✅ API; UI cannot perform tests',
    '✅ API; UI could not load the app',
    '✅ API; UI could not be performed',
    '✅ API; UI execution was unsuccessful',
    '✅ API; browser: could not connect',
    '✅ API; UI could not access the app because browser connection was refused',
    '✅ API; browser could not connect to http://localhost:4300',
    '✅ API; UI could not access the app; browser connection was refused',
    '✅ API; UI could not open browser',
    '✅ API; UI not able to run',
    '✅ API; UI not supported on this host',
    '✅ API; UI could not be opened',
    '✅ API; UI not reviewed',
    '✅ API; UI blocked when browser returns 500',
    '✅ API; UI skipped when browser returns 500',
    '✅ API; UI blocked whenever browser returns 500',
    '✅ API; UI blocked while browser returns 500',
    '✅ API; UI blocked during setup returns 500',
    '✅ API; UI could not complete',
    '✅ API; UI not reached because browser crashed',
    '✅ API; UI blocked after login returns 500',
    '✅ API; Browser coverage: skipped',
    '✅ API; UI not evaluated',
    '✅ API; UI regression tests not run',
    '✅ API; UI smoke tests were skipped',
    '✅ API<br>**UI regression tests** were not fully tested',
    '✅ API manual refund processed successfully; UI smoke tests were skipped',
    '✅ API; UI not fully tested',
    '✅ API; UI partially tested',
    '✅ API; browser could not launch',
    '✅ API; UI not running',
    '✅ API; UI has not been fully tested',
    '✅ API; UI only partially tested',
    '✅ API; browser couldn’t launch',
    '✅ API; UI partly executed',
    '✅ API; UI not completely verified',
    '✅ API; UI omitted optional checks',
    '✅ API; UI cannot finish checkout after setup failed',
  ])('retains incomplete execution coverage in status and evidence: %s', async (annotation) => {
    for (const [status, evidence] of [
      [annotation, 'response.json'],
      ['✅ API', annotation.replace('✅ API; ', '')],
    ]) {
      gh.comments = [
        sheet([`| 1 | Mixed API/UI | curl then browser | Both work | ${status} | ${evidence} |`]),
      ];
      expect(await latestTestVerdict(repo, 5)).toEqual({
        failures: [],
        total: 1,
        passed: 0,
        manual: 0,
        incomplete: true,
      });
    }
  });

  it('does not let an API checkmark certify an unknown UI result', async () => {
    gh.comments = [
      sheet(['| 1 | Mixed API/UI | curl then browser | Both work | ✅ API; 🟢 UI | response.json |']),
    ];
    expect(await latestTestVerdict(repo, 5)).toEqual({
      failures: [],
      total: 1,
      passed: 0,
      manual: 0,
      incomplete: true,
    });
  });

  it.each([
    '✅ API; UI tests not successful',
    '✅ API; UI validation not run',
    '✅ API; UI still needs to be tested',
    '✅ API; UI cannot finish',
    '✅ API; UI omitted',
    '✅ API; UI 🚫',
    '✅ API<br>**UI validation** was not run',
    '✅ API (UI still needs to be tested)',
    '✅ API/UI cannot finish after setup',
    '✅ API blocked user forbidden with 403; UI validation not run',
    '✅ API; UI verification pending',
    '✅ API; UI test execution not run',
    '✅ API; UI would require manual testing',
    '✅ API; UI blocked — login page displays a 500',
    '✅ API; UI tests were blocked — browser returns an error during setup',
    '✅ (partial)',
    '✅ API; UI tests NOT_RUN',
    '✅ API; UI test execution has not been run',
    '✅ API<br>**UI test execution** was not run',
    '✅ API (UI would require manual testing)',
    '✅ API; UI blocked: login page displays a 500',
    '✅ API; UI blocked - login page displays a 500',
    '✅ API manual refund succeeds; UI test execution not run',
    '✅ UI pending payment persists successfully; UI would require manual testing',
    '✅ API; UI did not finish',
    '✅ API; UI tests were deferred',
    '✅ API; failed UI',
    '✅ API; UI was not exercised',
    '✅ API; UI has not passed',
    '✅ API; UI attempted but blocked',
    '✅ API; UI tests have not passed',
    '✅ API; UI waiting for browser',
    '✅ API; UI test suite not run',
    '✅ API; UI must be tested manually',
    '✅ API; UI tests did not finish',
    '✅ API; UI has yet to be tested',
    '✅ API; UI testing is awaiting credentials',
    '✅ API; UI not finished',
    '✅ API; UI must be manually verified',
    '✅ UI pending payment renders correctly; UI verification pending',
    '✅ UI manual payment saved successfully; UI was not exercised',
    '✅ API manual refund completed successfully; UI has not passed',
    '✅ API blocked user sees 403; UI attempted but blocked',
    '✅ API; UI not checked',
    '✅ API; UI to be tested',
    '✅ API; UI unable to run',
    '✅ API; UI never ran',
    '✅ API; UI not done',
    '✅ API; UI not passing',
    '✅ API; UI failed to return expected result',
    '✅ API<br>**UI tests** are to be tested',
    '✅ API (UI unable to run)',
    '✅ API/UI failed to return expected result',
    '✅ API blocked user cannot enter /admin; UI not done',
    '✅ API; UI has been skipped',
    '✅ API; UI has been blocked by unavailable credentials',
    '✅ API; UI could not start',
    '✅ API; Playwright not run',
    '✅ API; E2E not run',
    '✅ API<br>**UI tests** have been skipped',
    '✅ API/E2E not run',
    '✅ GET /health; POST /orders not tested',
    '✅ GET /health; POST /api/orders not tested',
    '✅ GET /health / UI tests not run',
    '✅ GET / not tested',
    '✅ API blocked user rejected with 403; UI has been skipped',
    '✅ API; UI needs manual verification',
    "✅ API; UI wasn't run",
    '✅ API; UI could not be checked',
    '✅ API; UI excluded',
    '✅ API; UI tests did not pass',
    '✅ API; UI tests still pending',
    '✅ API; UI remains untested',
    '✅ API; UI testing is not complete',
    '✅ API<br>**UI tests** are still pending',
    '✅ API/UI checks were not checked',
    '✅ API (UI remains untested)',
    '✅ API blocked user denied with 403; UI not checked',
    '✅ API blocked user cannot access /admin; UI needs manual verification',
    "✅ UI pending payment shown correctly; UI wasn't run",
    '✅ UI pending payment remains visible; UI testing is not complete',
    '✅ API; UI manual verification is required',
    '✅ API; UI pending while credentials are missing',
    '✅ API; UI testing has not been run',
    '✅ API; UI did not run',
    '✅ API; UI requires a manual check',
    '✅ API; UI manual verification is still required',
    '✅ API; UI pending while credentials are currently unavailable',
    '✅ API (UI testing has not yet been executed)',
    '✅ API/UI did not execute',
    '✅ API<br>**UI testing** was not performed',
    '✅ API and UI requires a manual check',
    '✅ API blocked user is denied with 403; UI manual verification is required',
    '✅ API; UI untested',
    '✅ API; UI not started',
    '✅ API; UI has not yet been tested',
    '✅ API; UI unknown on this host',
    '✅ API (UI tests have not yet been executed)',
    '✅ API/UI automation not yet started',
    '✅ API<br>Firefox untested on this host',
    '✅ API; **UI checks** are unknown on this host',
    '✅ API blocked user gets 403; UI not started',
    '✅ UI pending payment displays correctly; browser untested',
    '✅ UI pending payment appears; UI has not yet been tested',
    '✅ API; UI pending browser setup',
    '✅ API; UI tests are in progress',
    '✅ API; UI manual testing required',
    '✅ API; UI not completed',
    '✅ API; UI incomplete',
    '✅ API; UI could not execute',
    '✅ API; UI failed',
    '✅ API; UI checks could not be completed',
    '✅ API<br>UI pending browser setup',
    '✅ API (UI tests are in progress)',
    '✅ API/UI manual testing required',
    '✅ API blocked user is denied with 403; UI failed',
    '✅ API; UI blocked by credentials that are missing',
    '✅ API; UI skipped waiting until browser is available',
    '✅ API; UI cannot be tested',
    '✅ API; UI automation not run',
    '✅ API; UI: tests were not executed',
    '✅ API; UI execution pending',
    '✅ API; UI has not been tested',
    '✅ API; UI tests cannot be executed on this host',
    '✅ API; UI: automation was not run',
    '✅ API blocked user is denied with 403; UI cannot be tested',
    '✅ API blocked user is denied with 403; UI automation not run',
    '✅ API blocked user is denied with 403; UI blocked waiting for credentials',
    '✅ API; UI tests not run',
    '✅ API; UI tests were not executed',
    '✅ API; UI not performed',
    '✅ API; UI requires manual testing',
    '✅ API; UI N/A',
    '✅ API; UI 🔴',
    '✅ API; **UI tests** were not executed on this host',
    '✅ API; browser checks are not performed',
    '✅ API blocked revoked user returns 403; UI tests not run',
    '✅ API blocked revoked user returns 403; UI blocked waiting for credentials',
    '✅ API; UI unavailable on this host',
    '✅ API; UI not available',
    '✅ API; UI could not run',
    "✅ API; UI couldn't run",
    '✅ API; **UI blocked**',
    '✅ API; _UI unavailable_ on this host',
    "✅ API; `UI couldn't run`",
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

  it.each([
    'UI no tests were run',
    'UI 0 tests executed',
    'UI still to do',
    'UI ✋ manual',
    'no UI testing',
    'UI did not even start',
    'UI results unknown',
    'UI <em>not run</em>',
    'UI <strong>did not even launch</strong>',
    'UI could not reach app',
    'UI browser crashed before testing',
    'UI browser tests did not happen',
    'frontend not run',
    'UI browser tests were not run',
    'UI Playwright tests were not executed',
    'UI browser automation was skipped',
    'UI assertions not executed',
    'UI assertions skipped',
    'UI assertions were never executed',
    'UI browser regression tests have not been run',
    'UI Playwright assertions were not checked',
    'UI has yet to run',
    'UI could not be exercised',
    'UI missing credentials prevents execution',
    'UI browser connection refused',
    'UI not validated',
    'UI is not runnable',
    'UI not yet validated',
    '⚪ UI',
    'UI could not log in',
    "UI couldn't log in",
    'UI setup failed',
    'UI browser failed to launch',
    'UI blocked since login page returns 500',
    'UI skipped since browser setup failed',
    'UI blocked since login page loaded an error',
    'UI browser setup failed',
  ])('keeps unfinished procedures incomplete in status and evidence: %s', async (annotation) => {
    for (const [status, evidence] of [
      [`✅ API; ${annotation}`, 'response.json'],
      ['✅ API', `response.json; ${annotation}`],
    ]) {
      gh.comments = [sheet([`| 1 | API and UI | curl then browser | Both work | ${status} | ${evidence} |`])];
      expect(await latestTestVerdict(repo, 5)).toEqual({
        failures: [],
        total: 1,
        passed: 0,
        manual: 0,
        incomplete: true,
      });
    }
  });

  it.each([
    'UI will run after deployment',
    'UI scheduled for tomorrow',
    'UI never began',
    'UI: no checks were attempted',
    'UI tests will execute after deployment',
    'UI checks will be run after deployment',
    'UI testing will begin after deployment',
    'UI will start after deployment',
    'UI has not begun',
    "UI hasn't begun",
    'UI testing has not yet begun',
    'UI tests have never begun',
  ])('keeps future and not-begun execution incomplete: %s', async (annotation) => {
    for (const [status, evidence] of [
      [`✅ API; ${annotation}`, 'response.json'],
      ['✅ API', `response.json; ${annotation}`],
    ]) {
      gh.comments = [sheet([`| 1 | API and UI | curl then browser | Both work | ${status} | ${evidence} |`])];
      expect(await latestTestVerdict(repo, 5)).toEqual({
        failures: [],
        total: 1,
        passed: 0,
        manual: 0,
        incomplete: true,
      });
    }
  });

  it.each([
    'UI ran after deployment',
    'UI tests were executed after deployment',
    'UI displayed will run after deployment as expected',
    'UI showed has not begun as expected',
    'UI has not begun message is displayed',
  ])('preserves completed execution and observed future wording: %s', async (annotation) => {
    for (const [status, evidence] of [
      [`✅ API; ${annotation}`, 'response.json'],
      ['✅ API', `response.json; ${annotation}`],
    ]) {
      gh.comments = [sheet([`| 1 | API and UI | curl then browser | Both work | ${status} | ${evidence} |`])];
      expect(await latestTestVerdict(repo, 5)).toMatchObject({ total: 1, passed: 1, incomplete: false });
    }
  });

  it.each([
    'UI: not actually tested',
    'UI tests were not actually executed',
    'UI: never actually verified',
    'UI: only 1 of 2 checks completed',
    'UI: only 1 / 2 tests run',
    'UI: only 2 of 3 assertions were performed',
  ])('keeps qualified unfinished procedures incomplete: %s', async (annotation) => {
    for (const [status, evidence] of [
      [`✅ API passed; ${annotation}`, 'response.json'],
      ['✅ API passed', `response.json; ${annotation}`],
    ]) {
      gh.comments = [sheet([`| 1 | API and UI | curl then browser | Both pass | ${status} | ${evidence} |`])];
      expect(await latestTestVerdict(repo, 5)).toEqual({
        failures: [],
        total: 1,
        passed: 0,
        manual: 0,
        incomplete: true,
      });
    }
  });

  it.each([
    'UI 1/5 tests run',
    'UI 1 of 2 tests passed',
    'API 1 of 2 assertions succeeded',
    'UI: 1 of 2 scenarios executed',
    'UI 1 / 2 scenarios attempted',
    'UI 1 of 5 checks executed',
    'UI 5 / 10 checks executed',
    'UI tests remaining: 4',
    'UI checks remaining: 1',
    'UI assertions remaining: 2',
    'UI: 0/5 tests run',
    'UI 0/5 tests run',
    'UI 0 / 5 checks executed',
    'UI 0  /  5 checks executed',
    'UI 0 of 5 tests run',
    'UI 0 of 12 assertions were performed',
    'UI tests: 0/5 tests have been completed',
    '**UI: 0/5 tests run**',
  ])('keeps incomplete required execution counts incomplete: %s', async (annotation) => {
    for (const [status, evidence] of [
      [`✅ API; ${annotation}`, 'response.json'],
      ['✅', `API response.json; ${annotation}`],
    ]) {
      gh.comments = [sheet([`| 1 | API and UI | curl and browser | Both work | ${status} | ${evidence} |`])];
      expect(await latestTestVerdict(repo, 5)).toEqual({
        failures: [],
        total: 1,
        passed: 0,
        manual: 0,
        incomplete: true,
      });
    }
  });

  it.each([
    'UI only 1/2 checks successful',
    'UI only 1 of 2 checks were successful',
    'UI tests disabled',
    'UI tests failing',
    'UI tests have errors',
  ])('retains partial and unsuccessful procedure outcomes: %s', async (annotation) => {
    for (const [status, evidence] of [
      [`✅ API; ${annotation}`, 'response.json'],
      ['✅ API', `response.json; ${annotation}`],
    ]) {
      gh.comments = [sheet([`| 1 | API and UI | curl and browser | Both pass | ${status} | ${evidence} |`])];
      expect(await latestTestVerdict(repo, 5)).toEqual({
        failures: [],
        total: 1,
        passed: 0,
        manual: 0,
        incomplete: true,
      });
    }
  });

  it.each([
    'UI tests successful',
    'UI only 2/2 checks successful',
    'UI 2 of 2 checks were successful',
    'UI tests ran successfully',
    'UI disabled user receives 403',
    'UI failing payment is displayed',
    'UI tests have errors was shown as expected',
    'UI showed only 1/2 checks successful as expected',
    'UI: only 2 of 2 checks completed',
    'UI: only 2 / 2 tests run',
    'UI: only 3 of 3 assertions were performed',
    'UI displayed not actually tested as expected',
    'UI showed only 1 of 2 checks completed as expected',
    'UI 10/10 checks executed',
    'UI 2 of 2 tests passed',
    'API 2 of 2 assertions succeeded',
    'UI 2 of 2 scenarios executed',
    'UI 2 / 2 scenarios attempted',
    'UI checks were attempted',
    'UI showed 1 of 2 tests passed as expected',
    'UI showed scheduled for tomorrow as expected',
    'UI 12 of 12 assertions were performed',
    'UI tests remaining: 0',
    'UI checks remaining: 0',
    'UI showed 1/5 tests run as expected',
    'UI showed tests remaining: 4 as expected',
    'UI 5/5 tests run',
    'UI 5 / 5 tests run',
    'UI 5 of 5 checks executed',
    'UI 0 assertions',
    'UI 0 failures observed',
    'UI showed 0/5 tests run as expected',
  ])('preserves completed counts and observed zero counts: %s', async (annotation) => {
    for (const [status, evidence] of [
      [`✅ API; ${annotation}`, 'response.json'],
      ['✅', `API response.json; ${annotation}`],
    ]) {
      gh.comments = [sheet([`| 1 | API and UI | curl and browser | Both work | ${status} | ${evidence} |`])];
      expect(await latestTestVerdict(repo, 5)).toMatchObject({ total: 1, passed: 1, incomplete: false });
    }
  });

  it.each([
    'UI TBD',
    'UI ❗ not executed',
    'UI ⚫ blocked',
    'UI to be done',
    'UI outstanding',
    'UI testing has not taken place',
    'UI is not being tested',
  ])('retains pending and decorated unfinished procedures: %s', async (annotation) => {
    for (const [status, evidence] of [
      [`✅ API / ${annotation}`, 'response.json'],
      ['✅ API', `response.json; ${annotation}`],
    ]) {
      gh.comments = [sheet([`| 1 | API and UI | curl then browser | Both work | ${status} | ${evidence} |`])];
      expect(await latestTestVerdict(repo, 5)).toMatchObject({ total: 1, passed: 0, incomplete: true });
    }
  });

  it.each(['UI outstanding balance is displayed', 'UI TBD label is shown', 'UI ❗ icon is displayed'])(
    'preserves completed business observations: %s',
    async (annotation) => {
      gh.comments = [
        sheet([
          `| 1 | Business state | Run procedure | State is displayed | ✅ ${annotation} | response.json |`,
        ]),
      ];
      expect(await latestTestVerdict(repo, 5)).toMatchObject({ total: 1, passed: 1, incomplete: false });
    },
  );

  it.each([
    'Could not run UI tests because Chromium is unavailable',
    'Could not execute browser checks because no browser is installed',
    "Couldn't run UI tests because Chromium is unavailable",
    'Unable to execute browser checks because no browser is installed',
    'UI yet untested',
    'UI awaits manual testing',
  ])('retains inverted inability and pending execution clauses: %s', async (annotation) => {
    for (const [status, evidence] of [
      [`✅ API; ${annotation}`, 'response.json'],
      ['✅', `[API response](https://example.test/response.json); ${annotation}`],
    ]) {
      gh.comments = [sheet([`| 1 | API and UI | curl and browser | Both work | ${status} | ${evidence} |`])];
      expect(await latestTestVerdict(repo, 5)).toEqual({
        failures: [],
        total: 1,
        passed: 0,
        manual: 0,
        incomplete: true,
      });
    }
  });

  it.each([
    'UI yet untested label is displayed',
    'UI awaits manual testing label is shown',
    'Could not run UI tests was displayed as expected',
    'Could not execute browser checks was returned as expected',
  ])('preserves observed pending and inability messages: %s', async (evidence) => {
    gh.comments = [sheet([`| 1 | Negative test | Run | Expected message | ✅ | ${evidence} |`])];
    expect(await latestTestVerdict(repo, 5)).toMatchObject({ total: 1, passed: 1, incomplete: false });
  });

  it.each([' but ', ', but ', '; but '])(
    'retains unfinished contrastive procedure clauses with %s',
    async (separator) => {
      for (const [status, evidence] of [
        [`✅ API passed${separator}UI could not launch`, 'response.json'],
        ['✅', `API passed${separator}UI could not launch`],
      ]) {
        gh.comments = [
          sheet([`| 1 | API and UI | curl then browser | Both work | ${status} | ${evidence} |`]),
        ];
        expect(await latestTestVerdict(repo, 5)).toMatchObject({ total: 1, passed: 0, incomplete: true });
      }
    },
  );

  it.each([
    [
      'Read manual payment',
      'GET /payments/1 for existing manual payment',
      'HTTP 200 with manual payment',
      'API manual payment read successfully',
    ],
    [
      'Handle pending payment',
      'POST /payments/1/settle',
      'HTTP 200 and settled payment',
      'API pending payment handled successfully',
    ],
    [
      'Fetch manual payment',
      'GET /payments/1',
      'HTTP 200 with manual payment',
      'API manual payment loaded successfully',
    ],
    [
      'Download pending invoice',
      'GET /invoices/1/pdf',
      'HTTP 200 and invoice PDF downloaded',
      'API pending invoice downloaded successfully',
    ],
  ])('accepts completed business observations for %s', async (scenario, steps, expected, outcome) => {
    for (const [status, evidence] of [
      [`✅ ${outcome}`, 'response.json'],
      ['✅', outcome],
    ]) {
      for (const missing of ['', '; UI setup failed', '; UI blocked since login page returns 500']) {
        gh.comments = [
          sheet([`| 1 | ${scenario} | ${steps} | ${expected} | ${status}${missing} | ${evidence} |`]),
        ];
        expect(await latestTestVerdict(repo, 5)).toMatchObject({
          failures: [],
          total: 1,
          passed: missing ? 0 : 1,
          incomplete: !!missing,
        });
      }
    }
  });

  it.each([
    ['Connection refused error is displayed', 'connection refused error was displayed as expected', true],
    ['Connection refused error is displayed', 'connection refused error was shown as expected', true],
    ['Connection refused error is displayed', 'connection refused error was displayed', true],
    ['Connection refused error is displayed', 'connection refused', false],
    ['Connection refused error is displayed', 'browser connection refused', false],
    ['Connection refused error is displayed', 'setup failed: connection refused', false],
    ['Timeout error is displayed', 'connection refused error was displayed as expected', false],
  ])(
    'distinguishes observed connection errors from missing execution: %s / %s',
    async (expected, observation, completed) => {
      for (const [status, evidence] of [
        [`✅ UI ${observation}`, 'video.webm'],
        ['✅', `UI ${observation}; video.webm`],
      ]) {
        for (const unfinished of ['', '; UI not run', '; no UI testing']) {
          gh.comments = [
            sheet([
              `| 1 | Connect to unavailable database | POST /connections/test | ${expected} | ${status}${unfinished} | ${evidence} |`,
            ]),
          ];
          expect(await latestTestVerdict(repo, 5)).toMatchObject({
            total: 1,
            passed: completed && !unfinished ? 1 : 0,
            incomplete: !completed || !!unfinished,
          });
        }
      }
    },
  );

  it.each([
    ['Not available message displayed', 'not available message was displayed as expected', true],
    ['Not available message displayed', 'not available message was shown', true],
    ['Not available error displayed', 'not available error was observed as expected', true],
    ['Timeout message displayed', 'not available message was displayed as expected', false],
    ['Not available message displayed', 'not available', false],
    ['Not available message displayed', 'not available because browser setup failed', false],
    ['Not available message displayed', 'setup failed: not available message was displayed', false],
  ])(
    'matches observed availability messages to Expected: %s / %s',
    async (expected, observation, completed) => {
      for (const [status, evidence] of [
        [`✅ UI ${observation}`, 'screenshot.png'],
        ['✅', `UI ${observation}; screenshot.png`],
      ]) {
        for (const unfinished of ['', '; UI not run']) {
          gh.comments = [
            sheet([
              `| 1 | Unavailable item | Open item | ${expected} | ${status}${unfinished} | ${evidence} |`,
            ]),
          ];
          expect(await latestTestVerdict(repo, 5)).toMatchObject({
            total: 1,
            passed: completed && !unfinished ? 1 : 0,
            incomplete: !completed || !!unfinished,
          });
        }
      }
    },
  );

  it.each(['UI needs to run', 'UI needs a browser', 'UI not assessed', 'UI ⏸️', 'UI ❎'])(
    'retains unfinished execution declared in evidence: %s',
    async (annotation) => {
      gh.comments = [
        sheet([`| 1 | API and UI | curl then browser | Both pass | ✅ | response.json; ${annotation} |`]),
      ];
      expect(await latestTestVerdict(repo, 5)).toEqual({
        failures: [],
        total: 1,
        passed: 0,
        manual: 0,
        incomplete: true,
      });
    },
  );

  it.each([
    'No evidence is present',
    'No screenshot was taken',
    'No record of execution',
    'Responses were not saved',
    'Artifacts are missing',
    '**Responses were not saved**',
    '<span>No evidence is present</span>',
    'No evidence was ever captured',
    'No video has yet been recorded',
    'No video has ever been recorded',
    'No evidence has actually been collected',
    'No evidence was ever captured: upload failed for response.json',
    'No evidence whatsoever',
    'not applicable',
    '**No evidence was ever captured**',
    '<span>No video has yet been recorded</span>',
    'Failed to capture response.json',
    'Capture of response.json failed',
    'Evidence deleted before upload',
    'Unrecorded',
    '**Failed to capture response.json**',
    '<span>Capture of response.json failed</span>',
    'Evidence was deleted before upload',
    'Unrecorded.',
  ])('keeps explicit failed capture and deleted evidence incomplete: %s', async (evidence) => {
    gh.comments = [sheet([`| 1 | API | curl /api | 200 | ✅ | ${evidence} |`])];
    expect(await latestTestVerdict(repo, 5)).toMatchObject({ total: 1, passed: 0, incomplete: true });
  });

  it.each([
    'Response bodies and headers were not saved',
    'No response bodies or headers were captured',
    'HTTP response bodies and headers were not retained',
    'No HTTP response body or headers were recorded',
    'Response bodies and headers were not saved: response.json',
    'No response bodies or headers were captured, upload failed for response.json',
    'Response bodies and headers: not saved',
  ])('rejects coordinated response evidence absence: %s', async (absence) => {
    for (const evidence of [absence, `**${absence}**`, `<span>${absence}</span>`]) {
      gh.comments = [sheet([`| 1 | API | curl /api | 200 | ✅ | ${evidence} |`])];
      expect(await latestTestVerdict(repo, 5)).toEqual({
        failures: [],
        total: 1,
        passed: 0,
        manual: 0,
        incomplete: true,
      });
    }
  });

  it.each([
    'Response bodies and headers were saved: response.json',
    'Response bodies and headers were not saved was displayed as expected',
    'No response bodies or headers were captured was returned as expected',
    'response-bodies-and-headers-not-saved.json',
    'no-response-bodies-or-headers-captured.json',
    '[Response bodies and headers were not saved](https://example.com/response.json)',
    '[No response bodies or headers were captured](https://example.com/response.json)',
    'Response bodies and headers: response.json',
  ])('preserves response artifacts and observed absence messages: %s', async (evidence) => {
    gh.comments = [sheet([`| 1 | API | curl /api | Expected message | ✅ | ${evidence} |`])];
    expect(await latestTestVerdict(repo, 5)).toMatchObject({ total: 1, passed: 1, incomplete: false });
  });

  it.each([
    'No evidence was retained',
    'No evidence exists for API or UI',
    'No evidence available for API',
    'No evidence was kept',
    'No HTTP headers captured',
    'HTTP headers were not kept',
    'HTTP headers: not kept',
    'No evidence exists for API or UI: response.json',
    'No HTTP headers captured: response.json',
    'No evidence exists for this scenario',
    'No evidence exists for this test',
    'No evidence exists for this check',
    'Pending upload',
    'Not recorded for this run',
    'Not captured for this scenario',
    'Evidence was lost',
    'UI screenshot unavailable',
    'N/A because no execution environment',
    'No evidence was retained: could not save response.json',
    'Evidence was lost: response.json',
  ])('rejects whole-cell evidence absence: %s', async (absence) => {
    for (const evidence of [absence, `**${absence}**`, `<span>${absence}</span>`]) {
      gh.comments = [sheet([`| 1 | API | curl /api | 200 | ✅ | ${evidence} |`])];
      expect(await latestTestVerdict(repo, 5)).toMatchObject({
        failures: [],
        total: 1,
        passed: 0,
        incomplete: true,
      });
    }
  });

  it.each([
    'No evidence exists and no response was saved',
    'Evidence is unavailable and upload failed',
    'N/A / no evidence',
  ])('rejects coordinated evidence absence: %s', async (absence) => {
    for (const evidence of [absence, `**${absence}**`, `<span>${absence}</span>`]) {
      gh.comments = [sheet([`| 1 | API and UI | curl and browser | Both pass | ✅ | ${evidence} |`])];
      expect(await latestTestVerdict(repo, 5)).toEqual({
        failures: [],
        total: 1,
        passed: 0,
        manual: 0,
        incomplete: true,
      });
    }
    for (const evidence of [
      `${absence}; response.json`,
      `response.json; ${absence}`,
      `${absence}; curl returned 200 as expected`,
      `curl returned 200 as expected; ${absence}`,
      `${absence} was shown as expected`,
    ]) {
      gh.comments = [sheet([`| 1 | API | curl /api | Expected message | ✅ | ${evidence} |`])];
      expect(await latestTestVerdict(repo, 5)).toMatchObject({ total: 1, passed: 1, incomplete: false });
    }
  });

  it.each([
    'No evidence exists and response.json',
    'Evidence is unavailable and curl returned 200 as expected',
    'N/A / [response](https://example.com/response.json)',
    'No evidence exists for API or UI was displayed as expected',
    'No evidence was kept was returned as expected',
    'No HTTP headers captured was shown as expected',
    '[No evidence exists for API or UI](https://example.com/response.json)',
    '[No HTTP headers captured](https://example.com/headers.json)',
    'no-http-headers-captured.json',
    'HTTP headers: headers.json',
    'HTTP headers were kept: headers.json',
  ])('preserves artifacts and observed qualified absence wording: %s', async (evidence) => {
    gh.comments = [sheet([`| 1 | API | curl /api | Expected message | ✅ | ${evidence} |`])];
    expect(await latestTestVerdict(repo, 5)).toMatchObject({ total: 1, passed: 1, incomplete: false });
  });

  it.each([
    'UI tests unverified',
    'UI execution prevented by missing credentials',
    'UI tests were not carried out',
    'UI tests could not proceed',
    'UI tests did not proceed',
    'UI testing has not occurred',
    'UI could not test because browser unavailable',
    'Could not test UI because browser credentials are missing',
    'unable to verify UI because browser unavailable',
  ])('retains explicit missing execution: %s', async (annotation) => {
    for (const [status, evidence] of [
      [`✅ API; ${annotation}`, 'response.json'],
      ['✅', `API response.json; ${annotation}`],
      ['✅', annotation],
    ]) {
      gh.comments = [sheet([`| 1 | API and UI | curl and browser | Both work | ${status} | ${evidence} |`])];
      expect(await latestTestVerdict(repo, 5)).toMatchObject({
        failures: [],
        total: 1,
        passed: 0,
        incomplete: true,
      });
    }
  });

  it.each([
    'No evidence was retained was displayed as expected',
    'No evidence exists for this scenario was returned as expected',
    'Pending upload was shown as expected',
    'Not recorded for this run was observed as expected',
    'Evidence was lost was displayed as expected',
    'UI screenshot unavailable was shown as expected',
    'N/A because no execution environment was returned as expected',
    'Could not test UI was displayed as expected',
    'UI unverified user was denied as expected',
    'UI prevented duplicate payment as expected',
    'Unable to verify UI was returned as expected',
    'no-evidence-was-retained.json',
    'pending-upload.json',
    '[Evidence was lost](https://example.test/result)',
    '[UI screenshot unavailable](https://example.test/result)',
  ])('preserves observed messages and artifacts for absence wording: %s', async (evidence) => {
    gh.comments = [sheet([`| 1 | API | curl /api | Expected message | ✅ | ${evidence} |`])];
    expect(await latestTestVerdict(repo, 5)).toMatchObject({ total: 1, passed: 1, incomplete: false });
  });

  it.each([
    'No evidence saved, upload failed',
    'No evidence was supplied',
    'Evidence: none',
    'Video: not recorded',
    '**No evidence saved, upload failed**',
    '<span>No evidence was supplied</span>',
    'No evidence was supplied, upload failed for response.json',
    '&mdash;',
    '&ndash;',
    '&hellip;',
    '&#8212;',
    '&#x2014;',
    '&#8230;',
    '**&mdash;**',
    '<span>&#x2014;</span>',
  ])('keeps labeled absence and encoded placeholders incomplete: %s', async (evidence) => {
    gh.comments = [sheet([`| 1 | API | curl /api | 200 | ✅ | ${evidence} |`])];
    expect(await latestTestVerdict(repo, 5)).toMatchObject({ total: 1, passed: 0, incomplete: true });
  });

  it.each([
    'Evidence: not retained',
    'Video: not attached',
    'Evidence: was not saved',
    'Evidence: has not been retained',
    'Video: could not be recorded',
    'Evidence: not retained: response.json',
    'Evidence: missing',
    'Evidence: absent',
    'Video: unavailable',
    'Video: lost',
    'Responses: unavailable',
  ])('preserves labeled evidence absence: %s', async (absence) => {
    for (const evidence of [absence, `**${absence}**`, `<span>${absence}</span>`]) {
      gh.comments = [sheet([`| 1 | API | curl /api | 200 | ✅ | ${evidence} |`])];
      expect(await latestTestVerdict(repo, 5)).toEqual({
        failures: [],
        total: 1,
        passed: 0,
        manual: 0,
        incomplete: true,
      });
    }
  });

  it.each([
    'Evidence: not retained was displayed as expected',
    'Video: not attached was shown as expected',
    'Evidence: was not saved was returned as expected',
    'Evidence: not-retained.json',
    'Video: [not attached](https://example.com/video.webm)',
    'Evidence: response.json',
    'Video: missing.webm',
    'Evidence: absent.json',
    'Video: unavailable.webm',
    'Video: lost.webm',
    'Responses: unavailable.json',
    'Evidence: missing was returned as expected',
    'Video: unavailable was shown as expected',
    'Video: [unavailable](https://example.com/video.webm)',
  ])('preserves labeled artifacts and absence observations: %s', async (evidence) => {
    gh.comments = [sheet([`| 1 | API | curl /api | Expected message | ✅ | ${evidence} |`])];
    expect(await latestTestVerdict(repo, 5)).toMatchObject({ total: 1, passed: 1, incomplete: false });
  });

  it.each([
    'Evidence not retained',
    'Evidence was not retained',
    '**Evidence not retained**',
    '<span>Evidence not retained</span>',
    'No evidence exists for this run',
    '**No evidence exists for this run**',
    '<span>No evidence exists for this run</span>',
    'No evidence exists for this run. Upload of response.json failed.',
  ])('keeps unretained and run-qualified evidence absent: %s', async (evidence) => {
    gh.comments = [sheet([`| 1 | API | curl /api | 200 | ✅ | ${evidence} |`])];
    expect(await latestTestVerdict(repo, 5)).toMatchObject({ total: 1, passed: 0, incomplete: true });
  });

  it.each([
    'Evidence not retained was displayed as expected',
    'No evidence exists for this run was returned as expected',
    'evidence-not-retained.json',
    '[Evidence not retained](https://example.com/result)',
    '[No evidence exists for this run](https://example.com/result)',
    'No evidence was supplied was shown as expected',
    'No evidence saved, upload failed was returned as expected',
    'no-evidence-was-supplied.json',
    'Evidence: response.json',
    'Video: capture.webm',
    'Evidence: none was displayed as expected',
    '[No evidence was supplied](https://example.com/result)',
    'response&mdash;body.json',
    'No evidence is present was shown as expected',
    'No screenshot was taken was displayed as expected',
    'No record of execution was returned as expected',
    'Responses were not saved was displayed as expected',
    'Artifacts are missing were shown as expected',
    'no-record-of-execution.txt',
    'no-screenshot-was-taken.png',
    '[Artifacts are missing](https://example.com/result)',
    'no-evidence-whatsoever.json',
    '[No evidence whatsoever](https://example.com/result)',
    'No evidence whatsoever was shown as expected',
    'No evidence was ever captured was displayed as expected',
    'No video has yet been recorded was returned as expected',
    'Not applicable was observed as expected',
    'unrecorded.json',
    'failed-to-capture-response.json',
    'capture-of-response-failed.json',
    'evidence-deleted-before-upload.json',
    '[Failed to capture response.json](https://example.com/result)',
    'Failed to capture response.json was displayed as expected',
    'Capture of response.json failed was shown as expected',
    'Evidence deleted before upload was returned as expected',
    'Unrecorded was observed as expected',
    'response.json',
    'capture.webm',
    'no-evidence-was-captured.json',
    'No evidence was captured because upload failed for response.json was returned as expected',
    '[No evidence was captured](https://example.com/response.json)',
    'evidence-has-not-been-captured.json',
    'no-response-body-captured.json',
    'no-screenshots-recorded.png',
    'video-could-not-be-recorded.webm',
    'no-evidence-was-obtained.txt',
    '[Video could not be recorded](https://example.com/result)',
    'Evidence has not been captured was returned as expected',
    'No response body captured was shown as expected',
    'No screenshots recorded was displayed as expected',
    'Video could not be recorded was observed as expected',
    'No evidence was obtained was returned as expected',
    'evidence-unavailable-because-upload-failed.json',
    'no-http-responses-recorded.json',
    '[Evidence unavailable (upload failed)](https://example.com/result)',
    'Evidence unavailable because upload failed was returned as expected',
    'No HTTP responses recorded was shown as expected',
    'evidence-not-yet-available.json',
    'no-execution-evidence.webm',
    'not uploaded.json',
    '[Evidence not yet available](https://example.com/result)',
    '[No execution evidence](https://example.com/result)',
    '[Not uploaded](https://example.com/result)',
    'Evidence not yet available was returned as expected',
    'No execution evidence was shown as expected',
    'Not uploaded was displayed as expected',
    'not recorded yet.json',
    'No evidence has been uploaded yet was returned as expected',
    '[Not recorded yet](https://example.com/result)',
    'evidence-was-not-generated.json',
    'could-not-run.webm',
    'Evidence was not generated was returned as expected',
    'Could not run: credentials missing was returned as expected',
    '[Evidence was not generated](https://example.com/result)',
    '[Could not run: credentials missing](https://example.com/result)',
    'no-evidence-was-generated.json',
    'upload-pending.webm',
    'No evidence was generated was returned as expected',
    'No recording due to browser crash was returned as expected',
    '[No evidence was generated](https://example.com/result)',
    'no-evidence-was-produced.json',
    'No evidence was produced was returned as expected',
    '[No evidence was produced](https://example.com/result)',
    'not-run-due-to-missing-node.js',
    'capture.js',
    '[capture.js](https://example.com/capture.js)',
    'evidence-was-not-uploaded.json',
    'no-video-was-recorded.webm',
    'not run due to missing credentials.json',
    'Evidence was not uploaded was returned as expected',
    'No video was recorded was returned as expected',
    'Not tested on this host was returned as expected',
    'Skipped because browser failed was returned as expected',
    '[Evidence was not uploaded](https://example.com/result)',
    '<img src="https://example.com/screenshot.png" />',
    'no evidence (upload failed).json',
    'Not run was returned as expected',
    '[No evidence (upload failed)](https://example.com/result)',
    'no-artifacts.json',
    'Evidence missing was returned as expected',
    'No evidence exists was returned as expected',
    'Evidence not available was returned as expected',
    'No artifacts was returned as expected',
    '[Evidence missing](https://example.com/result)',
    'no-evidence-uploaded.json',
    'evidence-unavailable.json',
    'No evidence uploaded was returned as expected',
    'Evidence unavailable was returned as expected',
    '[Evidence unavailable](https://example.com/result)',
    'API manual refund processed successfully',
    'API_not_running.json',
    'API blocked user forbidden with 403',
    'no-evidence-saved.json',
    'No evidence saved was returned as expected',
    'UI validation passed',
    'API blocked user returned 403',
    'UI pending payment displayed correctly',
    'API manual refund succeeds',
    'UI pending payment persists successfully',
    'No evidence was collected was returned as expected',
    'Evidence pending was returned as expected',
    'evidence-pending.json',
    'not tested.json',
    '<img src="" alt="response screenshot">',
    '<img srcset="screenshot.png 1x">',
    'not executed.json',
    'UI pending payment renders correctly',
    'not captured.json',
    'not available was returned as expected',
    '![screenshot](https://example.com/screenshot.png)',
    '[evidence](#)',
    '<span/>response.json<hr>',
    'response&#8203;.json',
    'no-evidence-available.json',
    'not run.json',
    'No evidence available was returned as expected',
    'No evidence collected was returned as expected',
    'no-evidence-collected.json',
    'Asserted the job was not run',
    '[response.json]()',
    '<span>response.json</span>',
    '<div><a href="https://example.com/result">response.json</a></div>',
    '<img src="https://example.com/screenshot.png">',
    '<https://example.com/result>',
    '_response.json_',
    '**asserted HTTP 200**',
    '`response.json`',
    '~~response.json~~',
    '<!-- saved --> response.json<br>',
    '[response](https://example.com/result)',
    'No evidence attached was returned as expected. response.json records the assertion.',
    'Not saved was displayed as expected',
    'not saved.json',
    '[Not saved](https://example.com/result)',
    'No evidence attached. Upload failed. was returned as expected',
    'The UI setup failed message was displayed as expected',
    'No evidence is available was returned as expected',
    'Unable to capture evidence was displayed as expected',
    '[Unable to capture evidence](https://example.com/result)',
    'unable-to-capture-evidence.json',
  ])('accepts formatted execution evidence: %s', async (evidence) => {
    gh.comments = [sheet([`| 1 | API | curl /api | 200 | ✅ | ${evidence} |`])];
    expect(await latestTestVerdict(repo, 5)).toMatchObject({ passed: 1, incomplete: false });
  });

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

describe('review follow-ups posted by the session owner', () => {
  beforeEach(() => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-09-08T11:05:00Z'));
  });
  afterEach(() => vi.restoreAllMocks());

  it.each([
    ['unrelated reply', { in_reply_to_id: 99, user: { login: 'someone-else' } }],
    ['different file', { path: 'lib/unrelated.js' }],
    ['different author', { user: { login: 'someone-else' } }],
    ['before the review', { created_at: '2026-09-08T08:00:00Z' }],
    ['after review capture', { created_at: '2026-09-08T12:00:00Z' }],
    ['reply on a different file', { in_reply_to_id: 99, path: 'lib/unrelated.js' }],
    ['reply before the review', { in_reply_to_id: 99, created_at: '2026-09-08T08:00:00Z' }],
    ['reply after review capture', { in_reply_to_id: 99, created_at: '2026-09-08T12:00:00Z' }],
    ['reply without the title', { in_reply_to_id: 99, body: 'Done.' }],
  ])('does not bind a %s as the inline publication', async (_label, overrides) => {
    const finding = { title: 'Race in the retry loop', file: 'lib/x.js', line: 12 };
    gh.comments = [
      {
        ...findingsComment([finding]),
        user: { login: 'server-account' },
        created_at: '2026-09-08T11:00:00Z',
      },
    ];
    gh.reviewComments = [
      {
        id: 101,
        path: finding.file,
        line: finding.line,
        body: finding.title,
        user: { login: 'owner-account' },
        created_at: '2026-09-08T10:00:00Z',
        ...overrides,
      },
    ];
    const [published] = await latestReviewFindings(repo, 5, {
      since: '2026-09-08T09:00:00Z',
      authorLogin: 'owner-account',
    });
    expect(published.reviewAuthorLogin).toBe('server-account');
    expect(published).not.toHaveProperty('reviewCommentId');
  });

  it('does not bind an unrelated reply that only shares the declared location', async () => {
    const finding = { title: 'Race in the retry loop', file: 'lib/x.js', line: 12 };
    gh.comments = [{ ...findingsComment([finding]), user: { login: 'ana' } }];
    gh.reviewComments = [
      {
        id: 91,
        in_reply_to_id: 90,
        path: finding.file,
        line: finding.line,
        body: 'Done.',
        user: { login: 'unrelated-user' },
        created_at: '2026-09-08T10:00:00Z',
      },
    ];
    const [published] = await latestReviewFindings(repo, 5, { since: '2026-09-08T09:00:00Z' });
    expect(published.reviewAuthorLogin).toBe('ana');
    expect(published).not.toHaveProperty('reviewCommentId');
    await expect(
      replyOnFindingThread(repo, 5, published, 'Noted', {
        since: '2026-09-08T09:00:00Z',
        authorLogin: published.reviewAuthorLogin,
      }),
    ).rejects.toThrow(/no comment/);
    expect(gh.writes).toEqual([]);
  });

  it.each(['reply', 'delete'])(
    'uses the review author for %s and ignores unrelated replies',
    async (action) => {
      const finding = { title: 'Race in the retry loop', file: 'lib/x.js', line: 12 };
      const comment = {
        path: finding.file,
        line: finding.line,
        body: finding.title,
        created_at: '2026-09-08T10:00:00Z',
      };
      gh.reviewComments = [
        { ...comment, id: 90, created_at: '2026-09-01T10:00:00Z' },
        { ...comment, id: 91, in_reply_to_id: 90, user: { login: 'unrelated-user' } },
        { ...comment, id: 92, in_reply_to_id: 90, user: { login: 'Ana' } },
      ];
      gh.comments = [{ ...findingsComment([finding]), user: { login: 'ana' } }];
      const [published] = await latestReviewFindings(repo, 5);
      expect(published.reviewAuthorLogin).toBe('ana');
      gh.comments = [];
      const options = {
        since: '2026-09-08T09:00:00Z',
        authorLogin: published.reviewAuthorLogin,
      };
      if (action === 'reply') {
        await replyOnFindingThread(repo, 5, finding, 'Noted', options);
        expect(gh.writes[0]).toMatchObject({
          method: 'POST',
          url: `/repos/${repo}/pulls/5/comments/90/replies`,
        });
      } else {
        expect((await deleteFindingFromReview(repo, 5, finding, options)).commentDeleted).toBe(true);
        expect(gh.writes[0]).toMatchObject({ method: 'DELETE', url: `/repos/${repo}/pulls/comments/92` });
      }
      gh.writes = [];
      gh.reviewComments.pop();
      if (action === 'reply') {
        await expect(replyOnFindingThread(repo, 5, finding, 'Noted', options)).rejects.toThrow(/no comment/);
      } else {
        expect((await deleteFindingFromReview(repo, 5, finding, options)).commentDeleted).toBe(false);
      }
      expect(gh.writes).toEqual([]);
    },
  );
});
