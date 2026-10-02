import { beforeEach, describe, expect, it, vi } from 'vitest';

const cfg = vi.hoisted(() => ({ githubToken: 'token' }));
vi.mock('../lib/config.js', () => ({ getConfig: () => cfg }));
vi.mock('../lib/github.js', () => ({ githubRest: vi.fn(), githubGraphql: vi.fn() }));
import { githubGraphql } from '../lib/github.js';
import { issueTimeline, issueView, TIMELINE_KINDS, timelineEvent } from '../lib/issueviewer.js';

const project = { repo: 'owner/repo' };
const answer = (node) => ({ repository: { issueOrPullRequest: node } });
// A GraphQL refusal as lib/github.js throws it: GitHub's errors, and what
// else resolved beside them.
const refusal = (errors, data = null) =>
  Object.assign(new Error(errors.map((e) => e.message).join('; ')), { status: 200, errors, data });

const issue = {
  __typename: 'Issue',
  number: 7,
  title: 'Broken login',
  url: 'https://github.com/owner/repo/issues/7',
  state: 'CLOSED',
  stateReason: 'NOT_PLANNED',
  body: '## Steps',
  author: { login: 'ada', avatarUrl: 'https://avatars/ada' },
  assignees: { nodes: [{ login: 'bob' }] },
  labels: { nodes: [{ name: 'bug', color: 'd73a4a' }] },
  milestone: { title: 'v2' },
  comments: { totalCount: 3 },
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-02T00:00:00Z',
  closedAt: '2026-01-03T00:00:00Z',
  issueType: { name: 'Bug' },
  parent: {
    number: 1,
    title: 'Epic',
    state: 'OPEN',
    url: 'https://github.com/owner/other/issues/1',
    repository: { nameWithOwner: 'owner/other' },
  },
  subIssuesSummary: { total: 2, completed: 1 },
  subIssues: {
    nodes: [
      { number: 8, title: 'Part', state: 'CLOSED', url: 'u8', repository: { nameWithOwner: 'owner/repo' } },
    ],
  },
  closedByPullRequestsReferences: {
    nodes: [
      {
        number: 9,
        title: 'Fix',
        state: 'MERGED',
        url: 'u9',
        isDraft: false,
        repository: { nameWithOwner: 'owner/repo' },
      },
    ],
  },
  projectItems: {
    nodes: [
      {
        project: { title: 'Roadmap', url: 'https://github.com/orgs/owner/projects/1' },
        fieldValues: {
          nodes: [
            { text: 'Broken login', field: { name: 'Title' } },
            { name: 'In progress', field: { name: 'Status' } },
            { name: 'P1', field: { name: 'Priority' } },
            { number: 3, field: { name: 'Size' } },
            { date: '2026-02-01', field: { name: 'Due' } },
            { title: 'Sprint 4', field: { name: 'Iteration' } },
            { text: 'Payments', field: { name: 'Area' } },
            {},
          ],
        },
      },
    ],
  },
};

beforeEach(() => {
  githubGraphql.mockReset();
  cfg.githubToken = 'token';
});

describe('reading an issue', () => {
  it('reads it in one round trip, with its project fields', async () => {
    githubGraphql.mockResolvedValue(answer(issue));
    const { issue: out } = await issueView(project, 7);
    expect(githubGraphql).toHaveBeenCalledOnce();
    expect(githubGraphql.mock.calls[0][2]).toEqual({
      owner: 'owner',
      name: 'repo',
      number: 7,
      withProjects: true,
    });
    expect(out).toEqual({
      number: 7,
      title: 'Broken login',
      url: 'https://github.com/owner/repo/issues/7',
      state: 'closed',
      stateReason: 'not_planned',
      body: '## Steps',
      author: 'ada',
      authorAvatar: 'https://avatars/ada',
      assignees: ['bob'],
      labels: [{ name: 'bug', color: 'd73a4a' }],
      milestone: 'v2',
      comments: 3,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-02T00:00:00Z',
      closedAt: '2026-01-03T00:00:00Z',
      type: 'Bug',
      parent: {
        number: 1,
        title: 'Epic',
        state: 'open',
        url: 'https://github.com/owner/other/issues/1',
        repo: 'owner/other',
      },
      subIssues: {
        total: 2,
        completed: 1,
        items: [{ number: 8, title: 'Part', state: 'closed', url: 'u8', repo: 'owner/repo' }],
      },
      pulls: [{ number: 9, title: 'Fix', state: 'merged', url: 'u9', repo: 'owner/repo', draft: false }],
      projects: [
        {
          title: 'Roadmap',
          url: 'https://github.com/orgs/owner/projects/1',
          status: 'In progress',
          fields: [
            { name: 'Priority', value: 'P1' },
            { name: 'Size', value: 3 },
            { name: 'Due', value: '2026-02-01' },
            { name: 'Iteration', value: 'Sprint 4' },
            { name: 'Area', value: 'Payments' },
          ],
        },
      ],
    });
    expect(out).not.toHaveProperty('projectsError');
  });

  it('answers a bare issue with empty lists rather than missing ones', async () => {
    githubGraphql.mockResolvedValue(
      answer({
        __typename: 'Issue',
        number: 3,
        title: 'T',
        url: 'u',
        state: 'OPEN',
        stateReason: null,
        body: null,
        author: null,
        createdAt: 'c',
        updatedAt: 'u',
        closedAt: null,
        issueType: null,
        parent: null,
        subIssuesSummary: { total: 0, completed: 0 },
      }),
    );
    expect((await issueView(project, 3)).issue).toMatchObject({
      body: '',
      author: null,
      stateReason: null,
      type: null,
      parent: null,
      subIssues: { total: 0, completed: 0, items: [] },
      pulls: [],
      projects: [],
      assignees: [],
      labels: [],
      milestone: null,
      comments: 0,
    });
  });

  it('keeps the issue when GitHub refuses only the project part, and says why', async () => {
    const { projectItems: _, ...rest } = issue;
    githubGraphql.mockRejectedValue(
      refusal(
        [
          {
            type: 'FORBIDDEN',
            message: 'Resource not accessible by personal access token',
            path: ['repository', 'issueOrPullRequest', 'projectItems', 'nodes', 0, 'project'],
          },
        ],
        answer({ ...rest, projectItems: { nodes: [{ project: null, fieldValues: { nodes: [] } }] } }),
      ),
    );
    const { issue: out } = await issueView(project, 7);
    expect(githubGraphql).toHaveBeenCalledOnce();
    expect(out.title).toBe('Broken login');
    expect(out.projects).toEqual([]);
    expect(out.projectsError).toBe('Resource not accessible by personal access token');
  });

  it('reads again without the projects when the token’s scopes refuse the whole query', async () => {
    const { projectItems: _, ...rest } = issue;
    githubGraphql
      .mockRejectedValueOnce(
        refusal([{ type: 'INSUFFICIENT_SCOPES', message: "The 'projectItems' field requires read:project" }]),
      )
      .mockResolvedValueOnce(answer(rest));
    const { issue: out } = await issueView(project, 7);
    expect(githubGraphql.mock.calls.map((c) => c[2].withProjects)).toEqual([true, false]);
    expect(out.number).toBe(7);
    expect(out.projects).toEqual([]);
    expect(out.projectsError).toBe("The 'projectItems' field requires read:project");
  });

  it('fails as 502 when the read without projects fails too', async () => {
    githubGraphql.mockRejectedValue(refusal([{ type: 'SOMETHING', message: 'Boom' }]));
    await expect(issueView(project, 7)).rejects.toMatchObject({
      status: 502,
      message: 'GitHub refused reading the issue: Boom',
    });
  });

  it('answers 422 for a pull request’s number', async () => {
    githubGraphql.mockResolvedValue(answer({ __typename: 'PullRequest' }));
    await expect(issueView(project, 9)).rejects.toMatchObject({
      status: 422,
      message: '#9 is a pull request, not an issue',
    });
  });

  it('answers 404 for a number that is neither, and for a repository GitHub does not show', async () => {
    githubGraphql.mockRejectedValue(
      refusal(
        [{ type: 'NOT_FOUND', message: 'Could not resolve', path: ['repository', 'issueOrPullRequest'] }],
        { repository: { issueOrPullRequest: null } },
      ),
    );
    await expect(issueView(project, 404)).rejects.toMatchObject({
      status: 404,
      message: 'There is no issue #404 in owner/repo',
    });
    githubGraphql.mockRejectedValue(
      refusal([{ type: 'NOT_FOUND', message: 'No repo', path: ['repository'] }]),
    );
    await expect(issueView(project, 4)).rejects.toMatchObject({
      status: 404,
      message: 'GitHub has no repository owner/repo',
    });
    githubGraphql.mockResolvedValue(answer(null));
    await expect(issueView(project, 4)).rejects.toMatchObject({ status: 404 });
  });

  it('keeps a rate limit’s own status', async () => {
    githubGraphql.mockRejectedValue(
      Object.assign(new Error('Rate limited'), { status: 429, rateLimited: true }),
    );
    await expect(issueView(project, 7)).rejects.toMatchObject({ status: 429, rateLimited: true });
  });

  it('turns a failure GitHub gave no GraphQL errors for into a 502', async () => {
    githubGraphql.mockRejectedValue(Object.assign(new Error('GitHub GraphQL answered 401'), { status: 401 }));
    await expect(issueView(project, 7)).rejects.toMatchObject({ status: 502 });
  });

  it('refuses a number that is not one, and a server without a token', async () => {
    await expect(issueView(project, 0)).rejects.toMatchObject({ status: 400 });
    await expect(issueView(project, NaN)).rejects.toMatchObject({ status: 400 });
    cfg.githubToken = '';
    await expect(issueView(project, 7)).rejects.toMatchObject({ status: 503 });
    expect(githubGraphql).not.toHaveBeenCalled();
  });
});

const actor = { login: 'ada', avatarUrl: 'https://avatars/ada' };
const at = '2026-01-01T00:00:00Z';
const node = (__typename, extra = {}) => ({
  __typename,
  id: `id-${__typename}`,
  actor,
  createdAt: at,
  ...extra,
});
const timelineIssue = (nodes, hasNextPage = false) =>
  answer({
    __typename: 'Issue',
    number: 7,
    title: 'Broken login',
    url: 'u7',
    state: 'OPEN',
    timelineItems: { pageInfo: { hasNextPage }, nodes },
  });

describe('mapping timeline events', () => {
  const base = { actor: 'ada', actorAvatar: 'https://avatars/ada', createdAt: at };
  const otherIssue = { number: 2, title: 'Other', url: 'u2', repository: { nameWithOwner: 'owner/repo' } };
  const cases = [
    [
      {
        __typename: 'IssueComment',
        id: 'c1',
        author: actor,
        createdAt: at,
        updatedAt: 'later',
        body: 'Same here',
        url: 'cu',
        authorAssociation: 'MEMBER',
      },
      {
        id: 'c1',
        kind: 'commented',
        body: 'Same here',
        url: 'cu',
        updatedAt: 'later',
        authorAssociation: 'MEMBER',
      },
    ],
    [
      node('LabeledEvent', { label: { name: 'bug', color: 'red' } }),
      { kind: 'labeled', label: { name: 'bug', color: 'red' } },
    ],
    [
      node('UnlabeledEvent', { label: { name: 'bug', color: 'red' } }),
      { kind: 'unlabeled', label: { name: 'bug', color: 'red' } },
    ],
    [node('AssignedEvent', { assignee: { login: 'bob' } }), { kind: 'assigned', assignee: 'bob' }],
    [node('UnassignedEvent', { assignee: { login: 'bob' } }), { kind: 'unassigned', assignee: 'bob' }],
    [node('MilestonedEvent', { milestoneTitle: 'v2' }), { kind: 'milestoned', milestone: 'v2' }],
    [node('DemilestonedEvent', { milestoneTitle: 'v2' }), { kind: 'demilestoned', milestone: 'v2' }],
    [
      node('RenamedTitleEvent', { previousTitle: 'Old', currentTitle: 'New' }),
      { kind: 'renamed', from: 'Old', to: 'New' },
    ],
    [node('ClosedEvent', { stateReason: 'COMPLETED' }), { kind: 'closed', stateReason: 'completed' }],
    [node('ReopenedEvent', { stateReason: 'REOPENED' }), { kind: 'reopened', stateReason: 'reopened' }],
    [
      node('CrossReferencedEvent', {
        source: {
          __typename: 'PullRequest',
          number: 9,
          title: 'Fix',
          url: 'u9',
          pullState: 'MERGED',
          repository: { nameWithOwner: 'owner/repo' },
        },
      }),
      {
        kind: 'cross-referenced',
        source: { kind: 'pull', number: 9, title: 'Fix', state: 'merged', url: 'u9', repo: 'owner/repo' },
      },
    ],
    [
      node('ConnectedEvent', {
        source: {
          __typename: 'Issue',
          number: 2,
          title: 'Other',
          url: 'u2',
          issueState: 'OPEN',
          repository: { nameWithOwner: 'owner/other' },
        },
      }),
      {
        kind: 'connected',
        source: { kind: 'issue', number: 2, title: 'Other', state: 'open', url: 'u2', repo: 'owner/other' },
      },
    ],
    [node('DisconnectedEvent', { source: null }), { kind: 'disconnected', source: null }],
    [
      node('ReferencedEvent', {
        commit: { oid: 'abc', messageHeadline: 'Fix #7', url: 'cu' },
        commitRepository: { nameWithOwner: 'owner/repo' },
      }),
      { kind: 'referenced', commit: { sha: 'abc', message: 'Fix #7', url: 'cu', repo: 'owner/repo' } },
    ],
    [
      node('ParentIssueAddedEvent', { parent: otherIssue }),
      { kind: 'parent_issue_added', issue: { number: 2, title: 'Other', url: 'u2', repo: 'owner/repo' } },
    ],
    [
      node('ParentIssueRemovedEvent', { parent: otherIssue }),
      { kind: 'parent_issue_removed', issue: { number: 2, title: 'Other', url: 'u2', repo: 'owner/repo' } },
    ],
    [
      node('SubIssueAddedEvent', { subIssue: otherIssue }),
      { kind: 'sub_issue_added', issue: { number: 2, title: 'Other', url: 'u2', repo: 'owner/repo' } },
    ],
    [
      node('SubIssueRemovedEvent', { subIssue: otherIssue }),
      { kind: 'sub_issue_removed', issue: { number: 2, title: 'Other', url: 'u2', repo: 'owner/repo' } },
    ],
    [node('IssueTypeAddedEvent', { issueType: { name: 'Bug' } }), { kind: 'issue_type_added', type: 'Bug' }],
    [
      node('IssueTypeChangedEvent', { issueType: { name: 'Bug' }, prevIssueType: { name: 'Task' } }),
      { kind: 'issue_type_changed', type: 'Bug', previousType: 'Task' },
    ],
    [
      node('IssueTypeRemovedEvent', { issueType: { name: 'Bug' } }),
      { kind: 'issue_type_removed', type: 'Bug' },
    ],
    [
      node('AddedToProjectV2Event', { project: { title: 'Roadmap' } }),
      { kind: 'added_to_project_v2', project: 'Roadmap' },
    ],
    [
      node('RemovedFromProjectV2Event', { project: null }),
      { kind: 'removed_from_project_v2', project: null },
    ],
    [
      node('ProjectV2ItemStatusChangedEvent', {
        project: { title: 'Roadmap' },
        status: 'Done',
        previousStatus: 'Todo',
      }),
      { kind: 'project_v2_item_status_changed', project: 'Roadmap', status: 'Done', previousStatus: 'Todo' },
    ],
  ];

  it.each(cases.map(([raw, expected]) => ({ type: raw.__typename, raw, expected })))(
    'maps $type',
    ({ raw, expected }) => {
      expect(timelineEvent(raw)).toEqual({ id: raw.id, ...base, ...expected });
    },
  );

  it('covers every kind it asks GitHub for', () => {
    expect(new Set(cases.map(([raw]) => raw.__typename))).toEqual(new Set(Object.keys(TIMELINE_KINDS)));
  });

  it('skips a kind it does not map rather than failing', () => {
    expect(timelineEvent(node('SubscribedEvent'))).toBeNull();
    expect(timelineEvent(null)).toBeNull();
  });

  it('names a deleted account as null', () => {
    expect(timelineEvent({ ...node('LabeledEvent', { label: null }), actor: null })).toMatchObject({
      actor: null,
      actorAvatar: null,
      label: null,
    });
  });
});

describe('reading an issue’s timeline', () => {
  it('asks for the mapped kinds only, oldest first, and skips what GitHub sends besides', async () => {
    githubGraphql.mockResolvedValue(
      timelineIssue([node('ClosedEvent', { stateReason: 'COMPLETED' }), node('SubscribedEvent')]),
    );
    const out = await issueTimeline(project, 7);
    const variables = githubGraphql.mock.calls[0][2];
    expect(variables).toMatchObject({ owner: 'owner', name: 'repo', number: 7, skip: 0, withProjects: true });
    expect(variables.kinds).toEqual(Object.values(TIMELINE_KINDS).map(([type]) => type));
    expect(out).toEqual({
      issue: { number: 7, title: 'Broken login', state: 'open', url: 'u7' },
      events: [
        {
          id: 'id-ClosedEvent',
          kind: 'closed',
          actor: 'ada',
          actorAvatar: 'https://avatars/ada',
          createdAt: at,
          stateReason: 'completed',
        },
      ],
      nextPage: null,
    });
  });

  it('pages 100 at a time and offers the next page while GitHub has more', async () => {
    githubGraphql.mockResolvedValue(timelineIssue([node('LabeledEvent', { label: null })], true));
    expect((await issueTimeline(project, 7, { page: 3 })).nextPage).toBe(4);
    expect(githubGraphql.mock.calls[0][2].skip).toBe(200);
    expect((await issueTimeline(project, 7, { page: 30 })).nextPage).toBeNull();
  });

  it('refuses a page outside 1–30', async () => {
    for (const page of [0, 31, 1.5, NaN])
      await expect(issueTimeline(project, 7, { page })).rejects.toMatchObject({
        status: 400,
        message: 'Invalid page',
      });
    expect(githubGraphql).not.toHaveBeenCalled();
  });

  it('keeps the timeline when the project titles are refused, and says why', async () => {
    githubGraphql
      .mockRejectedValueOnce(refusal([{ type: 'INSUFFICIENT_SCOPES', message: 'Needs read:project' }]))
      .mockResolvedValueOnce(timelineIssue([node('AddedToProjectV2Event')]));
    const out = await issueTimeline(project, 7);
    expect(githubGraphql.mock.calls[1][2].withProjects).toBe(false);
    expect(out.events[0]).toMatchObject({ kind: 'added_to_project_v2', project: null });
    expect(out.projectsError).toBe('Needs read:project');
  });

  it('answers 422 for a pull request and 404 for an unknown number', async () => {
    githubGraphql.mockResolvedValue(answer({ __typename: 'PullRequest' }));
    await expect(issueTimeline(project, 9)).rejects.toMatchObject({ status: 422 });
    githubGraphql.mockRejectedValue(
      refusal([
        { type: 'NOT_FOUND', message: 'Could not resolve', path: ['repository', 'issueOrPullRequest'] },
      ]),
    );
    await expect(issueTimeline(project, 404)).rejects.toMatchObject({ status: 404 });
  });
});
