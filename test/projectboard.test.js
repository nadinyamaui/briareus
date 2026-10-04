import { beforeEach, describe, expect, it, vi } from 'vitest';

const cfg = vi.hoisted(() => ({ githubToken: 'token' }));
vi.mock('../lib/config.js', () => ({ getConfig: () => cfg }));
vi.mock('../lib/github.js', () => ({ githubGraphql: vi.fn() }));
import { githubGraphql } from '../lib/github.js';
import {
  boardInScope,
  boardItem,
  buildColumns,
  columnsShown,
  groupField,
  parseFilter,
  projectBoard,
} from '../lib/projectboard.js';

// A GraphQL refusal as lib/github.js throws it: GitHub's errors, and what
// else resolved beside them.
const refusal = (errors, data = null) =>
  Object.assign(new Error(errors.map((e) => e.message).join('; ')), { status: 200, errors, data });

const VIEW_FILTER =
  'is:issue -status:"Backlog" iteration:@current repo:"acme/core","acme/mobile-app","acme/hq-3.0"';

const status = {
  __typename: 'ProjectV2SingleSelectField',
  id: 'F_status',
  name: 'Status',
  dataType: 'SINGLE_SELECT',
  options: [
    { id: 'o_backlog', name: 'Backlog', color: 'GRAY' },
    { id: 'o_ready', name: 'Ready Backlog', color: 'GRAY' },
    { id: 'o_blocked', name: 'Blocked', color: 'RED' },
    { id: 'o_progress', name: 'In Progress', color: 'YELLOW' },
    { id: 'o_qa', name: 'QA', color: 'PURPLE' },
  ],
};
const priority = {
  __typename: 'ProjectV2SingleSelectField',
  id: 'F_prio',
  name: 'Priority',
  dataType: 'SINGLE_SELECT',
  options: [{ id: 'o_high', name: 'High', color: 'YELLOW' }],
};
const points = { __typename: 'ProjectV2Field', id: 'F_points', name: 'Story Points', dataType: 'NUMBER' };
const fleet = { __typename: 'ProjectV2Field', id: 'F_fleet', name: 'Fleet Size', dataType: 'NUMBER' };
const title = { __typename: 'ProjectV2Field', id: 'F_title', name: 'Title', dataType: 'TITLE' };
const iteration = {
  __typename: 'ProjectV2IterationField',
  id: 'F_iter',
  name: 'Iteration',
  dataType: 'ITERATION',
  configuration: {
    iterations: [
      { id: 'i15', title: 'Iteration 15', startDate: '2026-10-12', duration: 14 },
      { id: 'i14', title: 'Iteration 14', startDate: '2026-09-28', duration: 14 },
    ],
    completedIterations: [
      { id: 'i12', title: 'Iteration 12', startDate: '2026-08-31', duration: 14 },
      { id: 'i13', title: 'Iteration 13', startDate: '2026-09-14', duration: 14 },
    ],
  },
};
const FIELDS = [title, status, priority, points, fleet, iteration];

const ref = (f) => ({ id: f.id, name: f.name });
const select = (f, optionId) => {
  const o = f.options.find((x) => x.id === optionId);
  return { name: o.name, optionId, color: o.color, field: ref(f) };
};
let seq = 0;
const item = ({ statusId = null, pts = null, archived = false, extra = [], content = {} } = {}) => ({
  id: `PVTI_${++seq}`,
  type: 'ISSUE',
  isArchived: archived,
  content: {
    __typename: 'Issue',
    number: seq,
    title: `Issue ${seq}`,
    url: `https://github.com/acme/core/issues/${seq}`,
    issueState: 'OPEN',
    createdAt: '2026-09-30T10:00:00Z',
    author: { login: 'ada' },
    repository: { nameWithOwner: 'acme/core' },
    assignees: { nodes: [] },
    labels: { nodes: [] },
    issueType: null,
    parent: null,
    ...content,
  },
  fieldValues: {
    nodes: [
      { text: `Issue ${seq}`, field: ref(title) },
      ...(statusId ? [select(status, statusId)] : []),
      ...(pts != null ? [{ number: pts, field: ref(points) }] : []),
      ...extra,
    ],
  },
});

describe('parseFilter', () => {
  it('reads negation, quotes and comma lists', () => {
    expect(parseFilter(VIEW_FILTER)).toEqual([
      { negated: false, name: 'is', values: ['issue'] },
      { negated: true, name: 'status', values: ['Backlog'] },
      { negated: false, name: 'iteration', values: ['@current'] },
      { negated: false, name: 'repo', values: ['acme/core', 'acme/mobile-app', 'acme/hq-3.0'] },
    ]);
  });

  it('takes a quoted value with spaces and a quoted field name', () => {
    expect(parseFilter('status:"In Progress",QA "project priority":High')).toEqual([
      { negated: false, name: 'status', values: ['In Progress', 'QA'] },
      { negated: false, name: 'project priority', values: ['High'] },
    ]);
  });

  it('leaves free text out', () => {
    expect(parseFilter('login bug no:assignee')).toEqual([
      { negated: false, name: 'no', values: ['assignee'] },
    ]);
    expect(parseFilter('')).toEqual([]);
    expect(parseFilter(null)).toEqual([]);
  });
});

describe('columnsShown', () => {
  const columns = [
    { id: null, name: 'No Status' },
    { id: 'o_backlog', name: 'Backlog' },
    { id: 'o_ready', name: 'Ready Backlog' },
    { id: 'o_qa', name: 'QA' },
  ];
  const names = (list) => list.map((c) => c.name);

  it('drops a column the filter excludes with a negated status', () => {
    expect(names(columnsShown(columns, status, VIEW_FILTER))).toEqual(['No Status', 'Ready Backlog', 'QA']);
  });

  it('keeps only the columns a status list names, whatever the casing', () => {
    expect(names(columnsShown(columns, status, 'status:qa,"ready backlog"'))).toEqual([
      'No Status',
      'Ready Backlog',
      'QA',
    ]);
  });

  it('ignores qualifiers on other fields', () => {
    expect(columnsShown(columns, status, '-priority:High label:bug')).toEqual(columns);
  });

  it('matches a field with spaces written hyphenated', () => {
    const field = { name: 'Project Status' };
    expect(names(columnsShown(columns, field, '-project-status:QA'))).not.toContain('QA');
  });

  describe('on an iteration field', () => {
    // 4 October 2026 falls in Iteration 14 (28 September for 14 days).
    const now = Date.parse('2026-10-04T12:00:00Z');
    const iterations = [
      { id: null, name: 'No Iteration' },
      { id: 'i13', name: 'Iteration 13' },
      { id: 'i14', name: 'Iteration 14' },
      { id: 'i15', name: 'Iteration 15' },
    ];

    it('works out @current, @previous and @next from the iterations’ dates', () => {
      expect(names(columnsShown(iterations, iteration, 'iteration:@current', now))).toEqual([
        'No Iteration',
        'Iteration 14',
      ]);
      expect(names(columnsShown(iterations, iteration, 'iteration:@previous,@next', now))).toEqual([
        'No Iteration',
        'Iteration 13',
        'Iteration 15',
      ]);
      expect(names(columnsShown(iterations, iteration, '-iteration:@current', now))).toEqual([
        'No Iteration',
        'Iteration 13',
        'Iteration 15',
      ]);
    });

    it('takes the iteration starting today as the current one', () => {
      const monday = Date.parse('2026-10-12T00:30:00Z');
      expect(names(columnsShown(iterations, iteration, 'iteration:@current', monday))).toContain(
        'Iteration 15',
      );
    });

    it('still matches an iteration by its title', () => {
      expect(names(columnsShown(iterations, iteration, 'iteration:"Iteration 13"', now))).toEqual([
        'No Iteration',
        'Iteration 13',
      ]);
    });

    it('leaves a selector it cannot work out to GitHub', () => {
      expect(columnsShown(iterations, iteration, 'iteration:>@current', now)).toEqual(iterations);
      const undated = {
        ...iteration,
        configuration: { iterations: [{ id: 'i14', title: 'Iteration 14', startDate: '2026-09-28' }] },
      };
      expect(columnsShown(iterations, undated, 'iteration:@current', now)).toEqual(iterations);
    });
  });
});

describe('groupField', () => {
  it('takes what a board view groups its columns by', () => {
    const view = { verticalGroupByFields: { nodes: [priority] }, groupByFields: { nodes: [] } };
    expect(groupField(view, FIELDS)).toBe(priority);
  });

  it('takes what a table view groups by when that is all it names', () => {
    const view = { verticalGroupByFields: { nodes: [] }, groupByFields: { nodes: [iteration] } };
    expect(groupField(view, FIELDS)).toBe(iteration);
  });

  it('falls back to Status with no view, or one grouped by a field without an order', () => {
    expect(groupField(null, FIELDS)).toBe(status);
    const view = { verticalGroupByFields: { nodes: [points] }, groupByFields: { nodes: [] } };
    expect(groupField(view, FIELDS)).toBe(status);
  });

  it('answers null for a board with no Status', () => {
    expect(groupField(null, [title, points])).toBe(null);
  });
});

describe('buildColumns', () => {
  beforeEach(() => {
    seq = 0;
  });

  it('puts the columns in the option order, with No Status first only when it holds something', () => {
    const items = [item({ statusId: 'o_qa' }), item({ statusId: 'o_ready' })];
    expect(buildColumns(items, FIELDS, status).map((c) => [c.name, c.count])).toEqual([
      ['Backlog', 0],
      ['Ready Backlog', 1],
      ['Blocked', 0],
      ['In Progress', 0],
      ['QA', 1],
    ]);
    const withNone = buildColumns([...items, item()], FIELDS, status);
    expect(withNone[0]).toMatchObject({ id: null, name: 'No Status', color: null, count: 1 });
  });

  it('carries the option colour and leaves the filtered-out column off', () => {
    const columns = buildColumns([item({ statusId: 'o_blocked' })], FIELDS, status, VIEW_FILTER);
    expect(columns.map((c) => c.name)).not.toContain('Backlog');
    expect(columns.find((c) => c.name === 'Blocked')).toMatchObject({ id: 'o_blocked', color: 'RED' });
  });

  it('keeps the items in the order GitHub gave them', () => {
    const items = [item({ statusId: 'o_qa' }), item({ statusId: 'o_qa' }), item({ statusId: 'o_qa' })];
    const qa = buildColumns(items, FIELDS, status).find((c) => c.name === 'QA');
    expect(qa.items.map((i) => i.number)).toEqual([1, 2, 3]);
  });

  it('totals every number field per column, 0 where nothing is set', () => {
    const items = [
      item({ statusId: 'o_qa', pts: 5 }),
      item({ statusId: 'o_qa', pts: 8 }),
      item({ statusId: 'o_qa' }),
      item({ statusId: 'o_ready', pts: 3 }),
    ];
    const columns = buildColumns(items, FIELDS, status);
    expect(columns.find((c) => c.name === 'QA').sums).toEqual({ 'Story Points': 13, 'Fleet Size': 0 });
    expect(columns.find((c) => c.name === 'Ready Backlog').sums).toEqual({
      'Story Points': 3,
      'Fleet Size': 0,
    });
    expect(columns.find((c) => c.name === 'Blocked').sums).toEqual({ 'Story Points': 0, 'Fleet Size': 0 });
  });

  it('leaves archived items out', () => {
    const columns = buildColumns(
      [item({ statusId: 'o_qa', pts: 5, archived: true }), item({ statusId: 'o_qa', pts: 1 })],
      FIELDS,
      status,
    );
    expect(columns.find((c) => c.name === 'QA')).toMatchObject({ count: 1, sums: { 'Story Points': 1 } });
  });

  it('groups by iteration in start-date order, keeping a finished one only while it holds something', () => {
    const at = (id) => ({ title: id, iterationId: id, field: ref(iteration) });
    const items = [item({ extra: [at('i14')] }), item({ extra: [at('i13')] })];
    expect(buildColumns(items, FIELDS, iteration).map((c) => c.name)).toEqual([
      'Iteration 13',
      'Iteration 14',
      'Iteration 15',
    ]);
  });

  it('keeps the column an iteration:@current filter selected', () => {
    const items = [item({ extra: [{ title: 'Iteration 14', iterationId: 'i14', field: ref(iteration) }] })];
    const now = Date.parse('2026-10-04T12:00:00Z');
    expect(buildColumns(items, FIELDS, iteration, 'iteration:@current', now)).toEqual([
      expect.objectContaining({ id: 'i14', name: 'Iteration 14', count: 1 }),
    ]);
  });

  it('puts everything in one column when the board has nothing to group by', () => {
    const columns = buildColumns([item(), item()], [title, points], null);
    expect(columns).toEqual([
      expect.objectContaining({ id: null, name: 'All items', count: 2, sums: { 'Story Points': 0 } }),
    ]);
  });
});

describe('boardInScope', () => {
  const card = (repo, pts, parent = null) => ({
    repo,
    parent: parent && { repo: parent, number: 1, title: 'Epic', url: 'u' },
    fields: [{ name: 'Story Points', value: pts }],
  });
  const board = () => ({
    project: { title: 'Board', url: 'u' },
    columns: [
      {
        id: null,
        name: 'No Status',
        count: 1,
        sums: { 'Story Points': 5 },
        items: [card('acme/mobile-app', 5)],
      },
      {
        id: 'o_qa',
        name: 'QA',
        count: 4,
        sums: { 'Story Points': 10 },
        items: [
          card('acme/core', 1, 'acme/mobile-app'),
          card('acme/mobile-app', 2),
          card(null, 3),
          card('acme/core', 4, 'acme/core'),
        ],
      },
    ],
  });

  it('answers the whole board to a token that sees everything', () => {
    const whole = board();
    expect(boardInScope(whole, null)).toBe(whole);
  });

  it('keeps only the cards of the token’s repositories, recounting each column', () => {
    const whole = board();
    const scoped = boardInScope(whole, ['acme/core']);
    expect(scoped.columns).toEqual([
      expect.objectContaining({ id: 'o_qa', count: 2, sums: { 'Story Points': 5 } }),
    ]);
    expect(scoped.columns[0].items.map((c) => c.repo)).toEqual(['acme/core', 'acme/core']);
    // A parent in a repository the token cannot see is not named.
    expect(scoped.columns[0].items[0].parent).toBeNull();
    expect(scoped.columns[0].items[1].parent).toMatchObject({ repo: 'acme/core' });
    // The shared, cached answer is left as it was.
    expect(whole).toEqual(board());
  });
});

describe('boardItem', () => {
  beforeEach(() => {
    seq = 0;
  });

  it('shapes a card the way the board draws it', () => {
    const node = item({
      statusId: 'o_qa',
      pts: 3,
      extra: [
        select(priority, 'o_high'),
        { title: 'Iteration 14', iterationId: 'i14', field: ref(iteration) },
        { date: '2026-10-01', field: { id: 'F_start', name: 'Start date' } },
      ],
      content: {
        assignees: { nodes: [{ login: 'bob', avatarUrl: 'https://avatars/bob' }] },
        labels: { nodes: [{ name: 'bug', color: 'd73a4a' }] },
        issueType: { name: 'Bug', color: 'RED' },
        parent: {
          number: 40,
          title: 'Epic',
          url: 'https://github.com/acme/core/issues/40',
          repository: { nameWithOwner: 'acme/core' },
        },
      },
    });
    expect(boardItem(node, status)).toEqual({
      id: 'PVTI_1',
      type: 'issue',
      repo: 'acme/core',
      number: 1,
      title: 'Issue 1',
      url: 'https://github.com/acme/core/issues/1',
      state: 'open',
      createdAt: '2026-09-30T10:00:00Z',
      author: 'ada',
      assignees: [{ login: 'bob', avatarUrl: 'https://avatars/bob' }],
      labels: [{ name: 'bug', color: 'd73a4a' }],
      parent: { repo: 'acme/core', number: 40, title: 'Epic', url: 'https://github.com/acme/core/issues/40' },
      fields: [
        { name: 'Story Points', value: 3 },
        { name: 'Priority', value: 'High', color: 'YELLOW' },
        { name: 'Iteration', value: 'Iteration 14' },
        { name: 'Start date', value: '2026-10-01' },
        { name: 'Type', value: 'Bug', color: 'RED' },
      ],
    });
  });

  it('reads a pull request and a draft', () => {
    const pull = {
      id: 'PVTI_p',
      type: 'PULL_REQUEST',
      content: {
        number: 9,
        title: 'Fix',
        url: 'u9',
        pullState: 'MERGED',
        repository: { nameWithOwner: 'acme/core' },
      },
      fieldValues: { nodes: [] },
    };
    expect(boardItem(pull, status)).toMatchObject({ type: 'pull', state: 'merged', parent: null });
    const draft = {
      id: 'PVTI_d',
      type: 'DRAFT_ISSUE',
      content: { title: 'Idea', createdAt: '2026-09-01T00:00:00Z', creator: { login: 'eve' } },
      fieldValues: { nodes: [] },
    };
    expect(boardItem(draft, status)).toMatchObject({
      type: 'draft',
      repo: null,
      number: null,
      url: null,
      state: null,
      title: 'Idea',
      author: 'eve',
      assignees: [],
      labels: [],
    });
  });
});

describe('projectBoard', () => {
  let n = 0;
  const board = (extra = {}) => ({
    repo: 'acme/core',
    projectBoard: { owner: `acme${++n}`, ownerType: 'organization', number: 1, view: 42, ...extra },
  });
  const meta = (view = {}) => ({
    owner: {
      projectV2: {
        title: 'HQ Board',
        url: 'https://github.com/orgs/acme/projects/1',
        view: {
          name: 'This Iteration',
          number: 42,
          layout: 'BOARD_LAYOUT',
          filter: VIEW_FILTER,
          verticalGroupByFields: { nodes: [status] },
          groupByFields: { nodes: [] },
          ...view,
        },
        fields: { nodes: FIELDS },
      },
    },
  });
  const page = (nodes, endCursor = null) => ({
    owner: { projectV2: { items: { pageInfo: { hasNextPage: !!endCursor, endCursor }, nodes } } },
  });

  beforeEach(() => {
    vi.mocked(githubGraphql).mockReset();
    cfg.githubToken = 'token';
    seq = 0;
  });

  it('hands the view’s filter to GitHub and pages through every item', async () => {
    vi.mocked(githubGraphql)
      .mockResolvedValueOnce(meta())
      .mockResolvedValueOnce(page([item({ statusId: 'o_qa', pts: 2 })], 'c1'))
      .mockResolvedValueOnce(page([item({ statusId: 'o_qa', pts: 3 }), item({ statusId: 'o_blocked' })]));
    const answer = await projectBoard(board());

    const calls = vi.mocked(githubGraphql).mock.calls;
    expect(calls).toHaveLength(3);
    expect(calls[0][1]).toMatch(/organization\(login: \$login\)/);
    expect(calls[0][2]).toMatchObject({ number: 1, view: 42, withView: true });
    // iteration:@current and the negated status travel to GitHub as written,
    // which works out the current iteration and applies the rest.
    expect(calls[1][2]).toMatchObject({ query: VIEW_FILTER, after: null });
    expect(calls[2][2]).toMatchObject({ query: VIEW_FILTER, after: 'c1' });

    expect(answer).toMatchObject({
      project: { title: 'HQ Board', url: 'https://github.com/orgs/acme/projects/1' },
      view: {
        name: 'This Iteration',
        number: 42,
        filter: VIEW_FILTER,
        url: 'https://github.com/orgs/acme/projects/1/views/42',
      },
      groupBy: 'Status',
      truncated: false,
      unsupportedFilters: [],
      projectsError: null,
    });
    expect(answer.columns.map((c) => [c.name, c.count, c.sums['Story Points']])).toEqual([
      ['Ready Backlog', 0, 0],
      ['Blocked', 1, 0],
      ['In Progress', 0, 0],
      ['QA', 2, 5],
    ]);
  });

  it('reads a user’s board with no view: no filter, grouped by Status', async () => {
    vi.mocked(githubGraphql)
      .mockResolvedValueOnce(meta())
      .mockResolvedValueOnce(page([item({ statusId: 'o_backlog' })]));
    const answer = await projectBoard(board({ ownerType: 'user', view: null }));
    const calls = vi.mocked(githubGraphql).mock.calls;
    expect(calls[0][1]).toMatch(/user\(login: \$login\)/);
    expect(calls[0][2]).toMatchObject({ withView: false });
    expect(calls[1][2]).toMatchObject({ query: null });
    expect(answer.view).toBe(null);
    expect(answer.columns.find((c) => c.name === 'Backlog').count).toBe(1);
  });

  it('answers a refusal with projectsError rather than failing, and does not cache it', async () => {
    const scopes =
      "Your token has not been granted the required scopes to execute this query. The 'projectV2' field requires one of the following scopes: ['read:project']";
    const project = board();
    vi.mocked(githubGraphql).mockRejectedValueOnce(
      refusal([{ type: 'INSUFFICIENT_SCOPES', message: scopes }], null),
    );
    expect(await projectBoard(project)).toEqual({
      project: null,
      view: null,
      groupBy: null,
      columns: [],
      truncated: false,
      unsupportedFilters: [],
      projectsError: scopes,
    });
    vi.mocked(githubGraphql).mockResolvedValueOnce(meta()).mockResolvedValueOnce(page([]));
    expect((await projectBoard(project)).projectsError).toBe(null);
  });

  it('answers a project GitHub cannot resolve the same way', async () => {
    vi.mocked(githubGraphql).mockRejectedValueOnce(
      refusal(
        [
          {
            type: 'NOT_FOUND',
            path: ['owner', 'projectV2'],
            message: 'Could not resolve to a ProjectV2 with the number 9.',
          },
        ],
        { owner: { projectV2: null } },
      ),
    );
    expect((await projectBoard(board({ number: 9 }))).projectsError).toBe(
      'Could not resolve to a ProjectV2 with the number 9.',
    );
    vi.mocked(githubGraphql).mockResolvedValueOnce({ owner: null });
    expect((await projectBoard(board())).projectsError).toMatch(/GitHub has no project 1 for acme/);
  });

  it('passes a rate limit on and turns any other failure into a 502', async () => {
    const limited = Object.assign(new Error('GitHub graphql rate limit exhausted'), {
      status: 429,
      rateLimited: true,
    });
    vi.mocked(githubGraphql).mockRejectedValueOnce(limited);
    await expect(projectBoard(board())).rejects.toBe(limited);
    vi.mocked(githubGraphql).mockRejectedValueOnce(
      Object.assign(new Error('GitHub GraphQL answered 401'), { status: 401 }),
    );
    await expect(projectBoard(board())).rejects.toMatchObject({
      status: 502,
      message: 'GitHub refused reading the project board: GitHub GraphQL answered 401',
    });
  });

  it('serves a second read from the cache unless asked for a fresh one', async () => {
    const project = board();
    vi.mocked(githubGraphql).mockResolvedValue(page([]));
    vi.mocked(githubGraphql).mockResolvedValueOnce(meta());
    const first = await projectBoard(project);
    expect(await projectBoard(project)).toBe(first);
    expect(githubGraphql).toHaveBeenCalledTimes(2);
    vi.mocked(githubGraphql).mockResolvedValueOnce(meta());
    await projectBoard(project, { fresh: true });
    expect(githubGraphql).toHaveBeenCalledTimes(4);
  });

  it('stops at twenty pages and says so', async () => {
    vi.mocked(githubGraphql)
      .mockResolvedValueOnce(meta())
      .mockImplementation(async () => page([item({ statusId: 'o_qa' })], 'more'));
    const answer = await projectBoard(board());
    expect(githubGraphql).toHaveBeenCalledTimes(21);
    expect(answer.truncated).toBe(true);
    expect(answer.columns.find((c) => c.name === 'QA').count).toBe(20);
  });

  it('refuses a project with no board, and a server with no token', async () => {
    await expect(projectBoard({ repo: 'acme/core', projectBoard: null })).rejects.toMatchObject({
      status: 404,
      message: 'acme/core has no Projects board set up',
    });
    cfg.githubToken = '';
    await expect(projectBoard(board())).rejects.toMatchObject({ status: 503 });
    expect(githubGraphql).not.toHaveBeenCalled();
  });
});
