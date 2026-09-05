import { describe, it, expect, vi, beforeEach } from 'vitest';

const gh = vi.hoisted(() => ({ graphql: vi.fn() }));

vi.mock('../lib/config.js', () => ({
  getConfig: () => ({ githubToken: 'tok' }),
}));

vi.mock('../lib/github.js', () => ({
  githubGraphql: (...args) => gh.graphql(...args),
}));

import { hasLabel, LABELS, projectPulls, pullOverview } from '../lib/prboard.js';

describe('hasLabel', () => {
  it('takes the label objects GitHub hands back', () => {
    expect(hasLabel([{ name: 'Blocked' }], LABELS.stalled)).toBe(true);
  });

  it('takes plain names too, case-insensitively', () => {
    expect(hasLabel(['FEEDBACK-GIVEN'], LABELS.feedbackGiven)).toBe(true);
  });

  it('answers false for no labels at all', () => {
    expect(hasLabel(null, LABELS.approved)).toBe(false);
    expect(hasLabel([], LABELS.approved)).toBe(false);
  });
});

// A GraphQL node as the board query returns it, with just enough shape.
function prNode({
  number = 1,
  title = 'A change',
  labels = [],
  mergeable = 'MERGEABLE',
  author = 'dev',
  rollup = 'SUCCESS',
  issues = [],
  assignees = [],
  reviewers = [],
  reviewRequests = [],
  reviewDecision = null,
  draft = false,
} = {}) {
  return {
    number,
    title,
    url: `https://github.com/acme/shop/pull/${number}`,
    isDraft: draft,
    mergeable,
    updatedAt: '2026-08-20T10:00:00Z',
    headRefName: `feature/${number}`,
    baseRefName: 'main',
    author: author ? { login: author } : null,
    assignees: { nodes: assignees.map((login) => ({ login })) },
    latestReviews: {
      nodes: reviewers.map(({ login, state, url = null }) => ({ author: { login }, state, url })),
    },
    reviewRequests: {
      nodes: reviewRequests.map((login) => ({ requestedReviewer: login ? { login } : {} })),
    },
    labels: { nodes: labels.map((name) => ({ name, color: 'ededed' })) },
    isCrossRepository: false,
    reviewDecision,
    closingIssuesReferences: { nodes: issues },
    commits: { nodes: rollup ? [{ commit: { statusCheckRollup: { state: rollup } } }] : [] },
  };
}

// The module caches per repo, so a unique repo per test keeps them isolated.
let n = 0;
function project(overrides = {}) {
  return { repo: `acme/shop-${n++}`, label: 'Shop', reviewAuthor: '', ...overrides };
}

// An open issue as the same query returns it, beside the pull requests.
function issueNode({
  number = 9,
  title = 'Something is broken',
  labels = [],
  author = 'reporter',
  assignees = [],
  comments = 0,
  milestone = null,
  closedBy = [],
  parent = null,
  subIssues = null,
} = {}) {
  return {
    number,
    title,
    url: `https://github.com/acme/shop/issues/${number}`,
    createdAt: '2026-08-01T10:00:00Z',
    updatedAt: '2026-08-20T10:00:00Z',
    author: author ? { login: author } : null,
    assignees: { nodes: assignees.map((login) => ({ login })) },
    labels: { nodes: labels.map((name) => ({ name, color: 'ededed' })) },
    comments: { totalCount: comments },
    milestone: milestone ? { title: milestone } : null,
    parent: parent
      ? {
          number: parent.number,
          title: parent.title || 'The epic',
          url: `https://github.com/${parent.repo || 'acme/shop'}/issues/${parent.number}`,
          repository: { nameWithOwner: parent.repo || 'acme/shop' },
        }
      : null,
    subIssuesSummary: subIssues
      ? { total: subIssues.total, completed: subIssues.completed, percentCompleted: 0 }
      : { total: 0, completed: 0, percentCompleted: 0 },
    closedByPullRequestsReferences: {
      nodes: closedBy.map(({ number: n, repo, draft = false, title = 'Elsewhere' }) => ({
        number: n,
        title,
        url: `https://github.com/${repo}/pull/${n}`,
        isDraft: draft,
        repository: { nameWithOwner: repo },
      })),
    },
  };
}

// The board asks for the pull request rows, a wider page carrying only what the
// stack walk reads, and the open issues, all in the one query. The two pull
// request pages are the same list unless a test says so.
function serve(nodes, defaultBranch = 'main', hasNextPage = false, refs = nodes, issues = []) {
  gh.graphql.mockResolvedValue({
    repository: {
      defaultBranchRef: { name: defaultBranch },
      stackRefs: { pageInfo: { hasNextPage }, nodes: refs },
      pullRequests: { pageInfo: { hasNextPage: false, endCursor: null }, nodes },
      issues: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: issues },
    },
  });
}

beforeEach(() => gh.graphql.mockReset());

describe('projectPulls', () => {
  it('paginates the complete open pull request list', async () => {
    const first = prNode({ number: 1 });
    const second = prNode({ number: 51 });
    gh.graphql
      .mockResolvedValueOnce({
        repository: {
          defaultBranchRef: { name: 'main' },
          stackRefs: { pageInfo: { hasNextPage: false }, nodes: [first, second] },
          pullRequests: { pageInfo: { hasNextPage: true, endCursor: 'page-2' }, nodes: [first] },
        },
      })
      .mockResolvedValueOnce({
        repository: {
          pullRequests: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [second] },
        },
      });

    const { pulls } = await projectPulls(project());
    expect(pulls.map((p) => p.number)).toEqual([1, 51]);
    expect(gh.graphql.mock.calls[1][2]).toMatchObject({ cursor: 'page-2' });
  });

  it('paginates every label used by filters and recommendations', async () => {
    const node = prNode({ labels: ['first'] });
    node.labels.pageInfo = { hasNextPage: true, endCursor: 'labels-2' };
    gh.graphql
      .mockResolvedValueOnce({
        repository: {
          defaultBranchRef: { name: 'main' },
          stackRefs: { pageInfo: { hasNextPage: false }, nodes: [node] },
          pullRequests: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [node] },
        },
      })
      .mockResolvedValueOnce({
        repository: {
          pullRequest: {
            labels: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [{ name: 'feedback-given', color: 'ededed' }],
            },
          },
        },
      });

    const { pulls } = await projectPulls(project());
    expect(pulls[0].labels.map((label) => label.name)).toEqual(['first', 'feedback-given']);
    expect(pulls[0].recommended).toBe('implement-feedback');
    expect(gh.graphql.mock.calls[1][2]).toMatchObject({ number: 1, cursor: 'labels-2' });
  });

  it('maps a pull request row for the board', async () => {
    serve([
      prNode({
        labels: ['requires-dev-review'],
        assignees: ['nadin'],
        reviewers: [
          { login: 'ana', state: 'APPROVED', url: 'review-url' },
          { login: 'bo', state: 'CHANGES_REQUESTED' },
        ],
        reviewRequests: ['bo', null],
        reviewDecision: 'REVIEW_REQUIRED',
        issues: [
          {
            number: 9,
            title: 'Bug',
            url: 'u',
            state: 'OPEN',
            stateReason: 'REOPENED',
            labels: { nodes: [{ name: 'p1', color: 'ff0000' }] },
          },
        ],
      }),
    ]);
    const { pulls } = await projectPulls(project());
    expect(pulls[0]).toMatchObject({
      number: 1,
      branch: 'feature/1',
      baseBranch: 'main',
      assignees: ['nadin'],
      reviewers: [
        { user: 'ana', state: 'approved', url: 'review-url' },
        { user: 'bo', state: 'requested', url: null },
      ],
      mergeable: 'mergeable',
      checks: 'success',
      reviewDecision: 'review_required',
      recommended: 'review',
    });
    expect(pulls[0].issues[0]).toMatchObject({ number: 9, state: 'open', stateReason: 'reopened' });
  });

  it('lists every author and names the one the board opens on', async () => {
    // The narrowing is the board's, not this function's: it hands back the
    // repo's whole open list plus the configured author for the picker to start
    // on, so that pick can be widened without a round trip to GitHub.
    serve([prNode({ number: 1, author: 'TheBot' }), prNode({ number: 2, author: 'someone-else' })]);
    const { pulls, author } = await projectPulls(project({ reviewAuthor: 'thebot' }));
    expect(author).toBe('thebot');
    expect(pulls.map((p) => p.number)).toEqual([1, 2]);
    expect(pulls.map((p) => p.author)).toEqual(['TheBot', 'someone-else']);
  });

  describe('open issues', () => {
    it('carries them on the same payload as the pull requests, in one call', async () => {
      serve(
        [prNode({ number: 1 })],
        'main',
        false,
        [prNode({ number: 1 })],
        [issueNode({ number: 9, labels: ['bug'], assignees: ['nadin'], comments: 3, milestone: 'v2' })],
      );
      const { issues } = await projectPulls(project());
      expect(gh.graphql).toHaveBeenCalledTimes(1);
      expect(issues[0]).toMatchObject({
        number: 9,
        title: 'Something is broken',
        author: 'reporter',
        assignees: ['nadin'],
        labels: [{ name: 'bug', color: 'ededed' }],
        comments: 3,
        milestone: 'v2',
        pulls: [],
      });
    });

    it('carries the sub-issue link both ways, so the tab can nest an epic', async () => {
      serve(
        [],
        'main',
        false,
        [],
        [
          issueNode({ number: 75, title: 'The platform', subIssues: { total: 8, completed: 3 } }),
          issueNode({ number: 90, parent: { number: 75, title: 'The platform' } }),
        ],
      );
      const { issues } = await projectPulls(project());
      const epic = issues.find((i) => i.number === 75);
      // GitHub's own count, over every child: the closed ones and any this
      // walk never listed are in it, which is the point of carrying it.
      expect(epic.subIssues).toEqual({ total: 8, completed: 3, open: 5 });
      expect(epic.parent).toBeNull();
      const child = issues.find((i) => i.number === 90);
      expect(child.subIssues).toBeNull();
      expect(child.parent).toMatchObject({ number: 75, title: 'The platform', repo: 'acme/shop' });
    });

    it('leaves an ordinary issue with no epic of its own', async () => {
      serve([], 'main', false, [], [issueNode({ number: 9 })]);
      const { issues } = await projectPulls(project());
      expect(issues[0].subIssues).toBeNull();
      expect(issues[0].parent).toBeNull();
    });

    it('names the open pull requests that close each issue', async () => {
      const p = project();
      const pr = prNode({
        number: 4,
        draft: true,
        issues: [{ number: 9, title: 'Something is broken', url: 'u', state: 'OPEN', labels: { nodes: [] } }],
      });
      // #7 is nobody's: an issue with no pull request on it is the work that has
      // not been started, which is what the tab is opened to find.
      serve([pr], 'main', false, [pr], [issueNode({ number: 9 }), issueNode({ number: 7 })]);
      const { issues } = await projectPulls(p);
      expect(issues.find((i) => i.number === 9).pulls).toEqual([
        {
          number: 4,
          title: 'A change',
          url: 'https://github.com/acme/shop/pull/4',
          draft: true,
          repo: p.repo,
        },
      ]);
      expect(issues.find((i) => i.number === 7).pulls).toEqual([]);
    });

    it('stops walking the issues rather than holding the board for a hundred pages', async () => {
      // A repo with thousands of open issues: every page is a round trip the
      // pull requests wait behind, on a load that repeats every minute.
      const pr = prNode({ number: 1 });
      const issuePage = (cursor) => ({
        repository: {
          issues: { pageInfo: { hasNextPage: true, endCursor: cursor }, nodes: [issueNode({ number: 1 })] },
        },
      });
      gh.graphql
        .mockResolvedValueOnce({
          repository: {
            defaultBranchRef: { name: 'main' },
            stackRefs: { pageInfo: { hasNextPage: false }, nodes: [pr] },
            pullRequests: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [pr] },
            issues: { pageInfo: { hasNextPage: true, endCursor: 'i-2' }, nodes: [issueNode({ number: 9 })] },
          },
        })
        .mockResolvedValueOnce(issuePage('i-3'))
        .mockResolvedValueOnce(issuePage('i-4'))
        .mockResolvedValueOnce(issuePage('i-5'))
        .mockResolvedValue(issuePage('i-6'));

      const { pulls, issues, issuesTruncated } = await projectPulls(project());
      expect(pulls.map((p) => p.number)).toEqual([1]);
      // Four pages: the one that came with the pull requests and three more.
      expect(gh.graphql).toHaveBeenCalledTimes(4);
      expect(issues.length).toBe(4);
      expect(issuesTruncated).toBe(true);
    });

    it('keeps what it has when a later issue page fails', async () => {
      const pr = prNode({ number: 1 });
      gh.graphql
        .mockResolvedValueOnce({
          repository: {
            defaultBranchRef: { name: 'main' },
            stackRefs: { pageInfo: { hasNextPage: false }, nodes: [pr] },
            pullRequests: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [pr] },
            issues: { pageInfo: { hasNextPage: true, endCursor: 'i-2' }, nodes: [issueNode({ number: 9 })] },
          },
        })
        .mockRejectedValueOnce(
          Object.assign(new Error('Resource not accessible by personal access token'), {
            errors: [{ path: ['repository', 'issues'], message: 'nope' }],
            data: { repository: {} },
          }),
        );

      const { pulls, issues, issuesTruncated, issuesError } = await projectPulls(project());
      expect(pulls.map((p) => p.number)).toEqual([1]);
      expect(issues.map((i) => i.number)).toEqual([9]);
      expect(issuesTruncated).toBe(true);
      expect(issuesError).toBeNull();
    });

    it('keeps the board when the token may not read the issues', async () => {
      // GraphQL answers a field the token cannot read with an error *and* the
      // rest of the data. A token set up the way .env.example describes has no
      // say over issues, and losing the whole board over a tab it never asked
      // for is not an acceptable upgrade.
      const pr = prNode({ number: 1 });
      const denied = Object.assign(new Error('Resource not accessible by personal access token'), {
        errors: [
          {
            type: 'FORBIDDEN',
            path: ['repository', 'issues'],
            message: 'Resource not accessible by personal access token',
          },
        ],
        data: {
          repository: {
            defaultBranchRef: { name: 'main' },
            stackRefs: { pageInfo: { hasNextPage: false }, nodes: [pr] },
            pullRequests: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [pr] },
            issues: null,
          },
        },
      });
      gh.graphql.mockRejectedValueOnce(denied);

      const { pulls, issues, issuesError } = await projectPulls(project());
      expect(pulls.map((p) => p.number)).toEqual([1]);
      expect(issues).toEqual([]);
      expect(issuesError).toBe('Resource not accessible by personal access token');
    });

    it('still fails the board when the pull requests are what could not be read', async () => {
      const denied = Object.assign(new Error('Could not resolve to a Repository'), {
        errors: [{ type: 'NOT_FOUND', path: ['repository'], message: 'Could not resolve to a Repository' }],
        data: { repository: null },
      });
      gh.graphql.mockRejectedValueOnce(denied);
      await expect(projectPulls(project())).rejects.toThrow('Could not resolve to a Repository');
    });

    it('still fails the board when something other than the issues failed', async () => {
      // A resolver or permission error under stackRefs leaves the pull requests
      // half-read. Forgiving it would cache that half and report nothing worse
      // than a missing tab.
      const pr = prNode({ number: 1 });
      const broken = Object.assign(new Error('Something went wrong while executing your query'), {
        errors: [{ path: ['repository', 'stackRefs'], message: 'Something went wrong' }],
        data: {
          repository: {
            defaultBranchRef: { name: 'main' },
            stackRefs: null,
            pullRequests: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [pr] },
            issues: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
          },
        },
      });
      gh.graphql.mockRejectedValueOnce(broken);
      await expect(projectPulls(project())).rejects.toThrow('Something went wrong');
    });

    it('finishes an issue’s label list, which the tab filters on', async () => {
      const pr = prNode({ number: 1 });
      const issue = issueNode({ number: 9, labels: ['first'] });
      issue.labels.pageInfo = { hasNextPage: true, endCursor: 'labels-2' };
      gh.graphql
        .mockResolvedValueOnce({
          repository: {
            defaultBranchRef: { name: 'main' },
            stackRefs: { pageInfo: { hasNextPage: false }, nodes: [pr] },
            pullRequests: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [pr] },
            issues: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [issue] },
          },
        })
        .mockResolvedValueOnce({
          repository: {
            issue: {
              labels: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [{ name: 'p1', color: 'ff0000' }],
              },
            },
          },
        });

      const { issues } = await projectPulls(project());
      expect(issues[0].labels.map((l) => l.name)).toEqual(['first', 'p1']);
      expect(gh.graphql.mock.calls[1][2]).toMatchObject({ number: 9, cursor: 'labels-2' });
    });

    it('names a pull request in another repository that closes an issue here', async () => {
      // No row of this board can mention it (the board only lists this repo's
      // pull requests) so the issue carries GitHub's own backward link.
      const p = project();
      const pr = prNode({
        number: 4,
        issues: [
          {
            number: 9,
            title: 'Ours',
            url: 'u',
            state: 'OPEN',
            repository: { nameWithOwner: p.repo },
            labels: { nodes: [] },
          },
        ],
      });
      const issue = issueNode({
        number: 9,
        closedBy: [
          // The same local pull request the row names, and one from elsewhere.
          { number: 4, repo: p.repo, title: 'A change' },
          { number: 88, repo: 'acme/other', title: 'From elsewhere', draft: true },
        ],
      });
      serve([pr], 'main', false, [pr], [issue]);
      const { issues } = await projectPulls(p);
      // The local pull request is one link seen twice, not two.
      expect(issues[0].pulls).toEqual([
        {
          number: 4,
          title: 'A change',
          url: `https://github.com/${p.repo}/pull/4`,
          draft: false,
          repo: p.repo,
        },
        {
          number: 88,
          title: 'From elsewhere',
          url: 'https://github.com/acme/other/pull/88',
          draft: true,
          repo: 'acme/other',
        },
      ]);
    });

    it('pages the pull requests answering one issue', async () => {
      // Five is what the board asks for up front; a sixth that lives in another
      // repository is invisible from the rows, so the connection is finished.
      const p = project();
      const pr = prNode({ number: 1 });
      const issue = issueNode({ number: 9, closedBy: [{ number: 1, repo: p.repo, title: 'A change' }] });
      issue.closedByPullRequestsReferences.pageInfo = { hasNextPage: true, endCursor: 'prs-2' };
      gh.graphql
        .mockResolvedValueOnce({
          repository: {
            defaultBranchRef: { name: 'main' },
            stackRefs: { pageInfo: { hasNextPage: false }, nodes: [pr] },
            pullRequests: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [pr] },
            issues: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [issue] },
          },
        })
        .mockResolvedValueOnce({
          repository: {
            issue: {
              closedByPullRequestsReferences: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [
                  {
                    number: 88,
                    title: 'From elsewhere',
                    url: 'https://github.com/acme/other/pull/88',
                    isDraft: false,
                    repository: { nameWithOwner: 'acme/other' },
                  },
                ],
              },
            },
          },
        });

      const { issues } = await projectPulls(p);
      expect(issues[0].pulls.map((x) => `${x.repo}#${x.number}`)).toEqual([`${p.repo}#1`, 'acme/other#88']);
      expect(gh.graphql.mock.calls[1][2]).toMatchObject({ number: 9, cursor: 'prs-2' });
    });

    it('ignores a closing reference into another repository', async () => {
      // "Fixes acme/other#9" is not this list's #9, however it is numbered.
      const p = project();
      const pr = prNode({
        number: 4,
        issues: [
          {
            number: 9,
            title: 'Someone else’s',
            url: 'u',
            state: 'OPEN',
            repository: { nameWithOwner: 'acme/other' },
            labels: { nodes: [] },
          },
          {
            number: 12,
            title: 'Ours',
            url: 'u',
            state: 'OPEN',
            repository: { nameWithOwner: p.repo.toUpperCase() },
            labels: { nodes: [] },
          },
        ],
      });
      serve([pr], 'main', false, [pr], [issueNode({ number: 9 }), issueNode({ number: 12 })]);
      const { issues } = await projectPulls(p);
      expect(issues.find((i) => i.number === 9).pulls).toEqual([]);
      expect(issues.find((i) => i.number === 12).pulls.map((x) => x.number)).toEqual([4]);
    });

    it('pages a pull request’s closing references before linking them', async () => {
      // A pull request closing more than the five references the board asks for
      // up front: the sixth issue is still that pull request's work, and reading
      // only the first page would put it on the tab as nobody's.
      const pr = prNode({
        number: 4,
        issues: [{ number: 9, title: 'One', url: 'u', state: 'OPEN', labels: { nodes: [] } }],
      });
      pr.closingIssuesReferences.pageInfo = { hasNextPage: true, endCursor: 'refs-2' };
      gh.graphql
        .mockResolvedValueOnce({
          repository: {
            defaultBranchRef: { name: 'main' },
            stackRefs: { pageInfo: { hasNextPage: false }, nodes: [pr] },
            pullRequests: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [pr] },
            issues: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [issueNode({ number: 9 }), issueNode({ number: 20 })],
            },
          },
        })
        .mockResolvedValueOnce({
          repository: {
            pullRequest: {
              closingIssuesReferences: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [{ number: 20, title: 'Six', url: 'u', state: 'OPEN', labels: { nodes: [] } }],
              },
            },
          },
        });

      const { pulls, issues } = await projectPulls(project());
      expect(pulls[0].issues.map((i) => i.number)).toEqual([9, 20]);
      expect(issues.find((i) => i.number === 20).pulls.map((p) => p.number)).toEqual([4]);
      expect(gh.graphql.mock.calls[1][2]).toMatchObject({ number: 4, cursor: 'refs-2' });
    });

    it('pages the issues without paying for the pull requests again', async () => {
      const pr = prNode({ number: 1 });
      gh.graphql
        .mockResolvedValueOnce({
          repository: {
            defaultBranchRef: { name: 'main' },
            stackRefs: { pageInfo: { hasNextPage: false }, nodes: [pr] },
            pullRequests: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [pr] },
            issues: {
              pageInfo: { hasNextPage: true, endCursor: 'issues-2' },
              nodes: [issueNode({ number: 9 })],
            },
          },
        })
        .mockResolvedValueOnce({
          repository: {
            issues: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [issueNode({ number: 51 })] },
          },
        });

      const { pulls, issues } = await projectPulls(project());
      expect(pulls.map((p) => p.number)).toEqual([1]);
      expect(issues.map((i) => i.number)).toEqual([9, 51]);
      expect(gh.graphql.mock.calls[1][2]).toMatchObject({
        issueCursor: 'issues-2',
        skipIssues: false,
        skipPulls: true,
      });
    });
  });

  describe('stacked pull requests', () => {
    // #1 → main, #2 → feature/1, #3 → feature/2.
    const stacked = () => {
      const a = prNode({ number: 1 });
      const b = prNode({ number: 2 });
      const c = prNode({ number: 3 });
      b.baseRefName = 'feature/1';
      c.baseRefName = 'feature/2';
      return [a, b, c];
    };

    it('numbers each pull request in its chain the way GitHub does', async () => {
      serve(stacked());
      const { pulls } = await projectPulls(project());
      const by = new Map(pulls.map((p) => [p.number, p.stack]));
      expect(by.get(1)).toMatchObject({ position: 1, total: 3 });
      expect(by.get(2)).toMatchObject({ position: 2, total: 3 });
      expect(by.get(3)).toMatchObject({ position: 3, total: 3 });
      // The stack itself travels once, keyed by id, not once per row.
      const { stacks } = await projectPulls(project());
      expect(Object.keys(stacks)).toEqual(['1']);
      expect(stacks[by.get(2).id].map((p) => p.number)).toEqual([1, 2, 3]);
      expect(stacks[by.get(2).id].map((p) => p.depth)).toEqual([1, 2, 3]);
      expect(new Set(pulls.map((p) => p.stack.id))).toEqual(new Set([1]));
    });

    it('leaves a lone pull request unstacked', async () => {
      serve([prNode({ number: 1 })]);
      const { pulls } = await projectPulls(project());
      expect(pulls[0].stack).toBeNull();
    });

    it('numbers a chain that runs through another author’s branch', async () => {
      // The board's author picker can hide #1 without renumbering #2 and #3:
      // the stack is walked over every open pull request, whoever opened it.
      const [a, b, c] = stacked();
      a.author = { login: 'someone-else' };
      serve([a, b, c]);
      const { pulls } = await projectPulls(project({ reviewAuthor: 'dev' }));
      const by = new Map(pulls.map((p) => [p.number, p.stack]));
      expect(by.get(2)).toMatchObject({ position: 2, total: 3 });
      expect(by.get(3)).toMatchObject({ position: 3, total: 3 });
    });

    it('gives every row of one stack the same total', async () => {
      const [a, b, c] = stacked();
      const d = prNode({ number: 4 });
      d.baseRefName = 'feature/1'; // a second branch off #1
      serve([a, b, c, d]);
      const { pulls, stacks } = await projectPulls(project());
      const by = new Map(pulls.map((p) => [p.number, p.stack]));
      expect([1, 2, 3, 4].map((n) => by.get(n).total)).toEqual([4, 4, 4, 4]);
      // Depth in the stack, so the two branches off #1 both read 2/4.
      expect([1, 2, 3, 4].map((n) => by.get(n).position)).toEqual([1, 2, 3, 2]);
      expect([1, 2, 3, 4].map((n) => by.get(n).id)).toEqual([1, 1, 1, 1]);
      expect(stacks[1].map((p) => [p.number, p.depth])).toEqual([
        [1, 1],
        [2, 2],
        [3, 3],
        [4, 2],
      ]);
    });

    it('carries a side branch that is itself a stack, not just its bottom', async () => {
      const [a, b, c] = stacked();
      const d = prNode({ number: 4 });
      const e = prNode({ number: 5 });
      d.baseRefName = 'feature/1';
      e.baseRefName = 'feature/4';
      serve([a, b, c, d, e]);
      const { pulls, stacks } = await projectPulls(project());
      const by = new Map(pulls.map((p) => [p.number, p.stack]));
      // #5 hangs off #1 through #4 just as much as #3 does through #2.
      expect(stacks[by.get(1).id].map((p) => p.number)).toEqual([1, 2, 3, 4, 5]);
      expect(by.get(5)).toMatchObject({ position: 3, total: 5, id: 1 });
    });

    it('shows no stack at all for a ring of bases', async () => {
      const a = prNode({ number: 1 });
      const b = prNode({ number: 2 });
      a.baseRefName = 'feature/2';
      b.baseRefName = 'feature/1';
      serve([a, b]);
      const { pulls } = await projectPulls(project());
      expect(pulls.map((p) => p.stack)).toEqual([null, null]);
    });

    it('survives a cycle the base walk cannot see', async () => {
      // Two open pull requests may share a head branch, so `byHead` and
      // `childrenOf` can disagree: h1 → main, h1 → h2 and h2 → h1 leave no
      // ring in the base walk but a loop in the child walk.
      const a = prNode({ number: 20 });
      const b = prNode({ number: 21 });
      const c = prNode({ number: 22 });
      a.headRefName = 'h1';
      b.headRefName = 'h1';
      b.baseRefName = 'h2';
      c.headRefName = 'h2';
      c.baseRefName = 'h1';
      serve([a, b, c]);
      const { pulls } = await projectPulls(project());
      expect(pulls.map((p) => p.number)).toEqual([20, 21, 22]);
    });

    it('does not let a shadowed head adopt another pull request children', async () => {
      // Same branch, two bases: only the pull request `byHead` holds owns the
      // children sitting on that branch name.
      const a = prNode({ number: 10 });
      const b = prNode({ number: 11 });
      const c = prNode({ number: 12 });
      a.headRefName = 'feature/api';
      b.headRefName = 'feature/api';
      b.baseRefName = 'release/2';
      c.baseRefName = 'feature/api';
      // The lower number owns the shared branch, whichever order GitHub
      // lists the two in: the chip must not move between refreshes.
      for (const nodes of [
        [a, b, c],
        [b, a, c],
      ]) {
        serve(nodes);
        const { pulls } = await projectPulls(project());
        const by = new Map(pulls.map((p) => [p.number, p.stack]));
        expect(by.get(11)).toBeNull();
        expect(by.get(10)).toMatchObject({ position: 1, total: 2 });
        expect(by.get(12)).toMatchObject({ position: 2, total: 2 });
      }
    });

    it('never folds a ring into the stack of a pull request sitting above it', async () => {
      const a = prNode({ number: 1 });
      const b = prNode({ number: 2 });
      const c = prNode({ number: 3 });
      a.headRefName = 'h1';
      a.baseRefName = 'h2';
      b.headRefName = 'h2';
      b.baseRefName = 'h1';
      c.headRefName = 'h3';
      c.baseRefName = 'h1';
      serve([a, b, c]);
      const { pulls, stacks } = await projectPulls(project());
      const by = new Map(pulls.map((p) => [p.number, p.stack]));
      expect(by.get(1)).toBeNull();
      expect(by.get(2)).toBeNull();
      // #3 stands on the ring, so the stack under it stops there: numbering it
      // would have to call one of #1 / #2 the bottom, and neither is.
      expect(by.get(3)).toBeNull();
      expect(stacks).toEqual({});
    });

    it('marks a stack that stands on a ring as partial', async () => {
      const a = prNode({ number: 1 });
      const b = prNode({ number: 2 });
      const c = prNode({ number: 3 });
      const d = prNode({ number: 4 });
      a.headRefName = 'h1';
      a.baseRefName = 'h2';
      b.headRefName = 'h2';
      b.baseRefName = 'h1';
      c.headRefName = 'h3';
      c.baseRefName = 'h1'; // on the ring
      d.headRefName = 'h4';
      d.baseRefName = 'h3'; // and #4 on #3
      serve([a, b, c, d]);
      const { pulls, stacks } = await projectPulls(project());
      const by = new Map(pulls.map((p) => [p.number, p.stack]));
      expect(by.get(3)).toMatchObject({ position: 1, total: 2, partial: true });
      expect(by.get(4)).toMatchObject({ position: 2, total: 2, partial: true });
      // The ring is nowhere in the chain, and keeps no chip of its own.
      expect(stacks[by.get(3).id].map((p) => p.number)).toEqual([3, 4]);
      expect([by.get(1), by.get(2)]).toEqual([null, null]);
    });

    it('walks a pull request the rows do not include', async () => {
      // #2 is on the walk's wider page but past the rows': the stack it links
      // still numbers #1 and #3, and the tooltip can name the link between.
      const [a, b, c] = stacked();
      serve([a, c], 'main', false, [a, b, c]);
      const { pulls, stacks } = await projectPulls(project());
      expect(pulls.map((p) => p.number)).toEqual([1, 3]);
      const by = new Map(pulls.map((p) => [p.number, p.stack]));
      expect(by.get(3)).toMatchObject({ position: 3, total: 3 });
      expect(stacks[by.get(3).id].map((p) => p.number)).toEqual([1, 2, 3]);
    });

    it('keeps a stack on a branch merely named like a release', async () => {
      const a = prNode({ number: 1 });
      const b = prNode({ number: 2 });
      a.headRefName = 'release-notes-rewrite';
      b.headRefName = 'copy-edits';
      b.baseRefName = 'release-notes-rewrite';
      // A gitflow release branch is still long-lived and still no one's base.
      const c = prNode({ number: 3 });
      const d = prNode({ number: 4 });
      c.headRefName = 'release/2';
      d.baseRefName = 'release/2';
      serve([a, b, c, d]);
      const { pulls } = await projectPulls(project());
      const by = new Map(pulls.map((p) => [p.number, p.stack]));
      expect(by.get(1)).toMatchObject({ position: 1, total: 2 });
      expect(by.get(2)).toMatchObject({ position: 2, total: 2 });
      expect([by.get(3), by.get(4)]).toEqual([null, null]);
    });

    it('says a stack may be longer when the page did not hold every pull request', async () => {
      serve(stacked(), 'main', true);
      const { pulls } = await projectPulls(project());
      expect(pulls.map((p) => p.stack.partial)).toEqual([true, true, true]);
    });

    it('carries only what the tooltip prints', async () => {
      serve(stacked());
      const { pulls, stacks } = await projectPulls(project());
      expect(pulls[0].stack.partial).toBe(false);
      expect(Object.keys(stacks[pulls[0].stack.id][0]).sort()).toEqual(['depth', 'draft', 'number', 'title']);
    });

    it('says which members of a stack are drafts', async () => {
      // The tooltip names a draft member so the reader can tell that a stack
      // cannot merge from the bottom up yet without opening every row.
      const [a, b] = stacked();
      b.isDraft = true;
      serve([a, b]);
      const { pulls, stacks } = await projectPulls(project());
      expect(stacks[pulls[0].stack.id].map((p) => p.draft)).toEqual([false, true]);
    });

    it('does not let a fork head adopt an in-repo pull request children', async () => {
      const [a, b, c] = stacked();
      const fork = prNode({ number: 9 });
      fork.isCrossRepository = true;
      fork.headRefName = 'feature/2';
      serve([a, b, c, fork]);
      const { pulls } = await projectPulls(project());
      const by = new Map(pulls.map((p) => [p.number, p.stack]));
      expect(by.get(9)).toBeNull();
      expect(by.get(3)).toMatchObject({ position: 3, total: 3 });
    });

    it('lists the stack in the same order whatever order GitHub lists it in', async () => {
      // #1 carries two branches of equal depth: #2→#3 and #4→#5.
      const build = () => {
        const one = prNode({ number: 1 });
        const kids = [2, 3, 4, 5].map((n) => prNode({ number: n }));
        kids[0].baseRefName = 'feature/1';
        kids[1].baseRefName = 'feature/2';
        kids[2].baseRefName = 'feature/1';
        kids[3].baseRefName = 'feature/4';
        return [one, ...kids];
      };
      const chainFor = async (nodes) => {
        serve(nodes);
        const { pulls, stacks } = await projectPulls(project());
        return stacks[pulls.find((p) => p.number === 1).stack.id].map((p) => p.number);
      };
      expect(await chainFor(build())).toEqual([1, 2, 3, 4, 5]);
      expect(await chainFor(build().reverse())).toEqual([1, 2, 3, 4, 5]);
    });

    it('never treats a long-lived branch as a stack base', async () => {
      // develop → main, with two feature pull requests based on develop. They
      // merge *into* develop, ahead of it, so nothing here is a stack.
      const promotion = prNode({ number: 1 });
      promotion.headRefName = 'develop';
      const [x, y] = [prNode({ number: 2 }), prNode({ number: 3 })];
      x.baseRefName = 'develop';
      y.baseRefName = 'develop';
      serve([promotion, x, y]);
      const { pulls, stacks } = await projectPulls(project());
      expect(pulls.map((p) => p.stack)).toEqual([null, null, null]);
      expect(stacks).toEqual({});
    });

    it('takes the repo default branch as long-lived whatever it is called', async () => {
      const promotion = prNode({ number: 1 });
      promotion.headRefName = 'shipit';
      const feature = prNode({ number: 2 });
      feature.baseRefName = 'shipit';
      serve([promotion, feature], 'shipit');
      const { pulls } = await projectPulls(project());
      expect(pulls.map((p) => p.stack)).toEqual([null, null]);
    });

    it('never treats a fork branch as a base of this repo', async () => {
      // alice:main → main: its head is a branch of the fork, not of this repo,
      // so no in-repo pull request based on `main` is stacked on it.
      const fork = prNode({ number: 1 });
      fork.isCrossRepository = true;
      fork.headRefName = 'main';
      serve([fork, prNode({ number: 2 }), prNode({ number: 3 })]);
      const { pulls } = await projectPulls(project());
      expect(pulls.map((p) => p.stack)).toEqual([null, null, null]);
    });

    it('still stacks a fork pull request onto an in-repo branch', async () => {
      const base = prNode({ number: 1 });
      const fork = prNode({ number: 2 });
      fork.isCrossRepository = true;
      fork.baseRefName = 'feature/1';
      serve([base, fork]);
      const { pulls } = await projectPulls(project());
      expect(pulls.map((p) => p.stack.position)).toEqual([1, 2]);
    });
  });

  it('throws when GitHub has no such repository', async () => {
    gh.graphql.mockResolvedValue({ repository: null });
    await expect(projectPulls(project())).rejects.toThrow(/no repository/);
  });

  it('a pull request with no rollup has null checks', async () => {
    serve([prNode({ rollup: null })]);
    const { pulls } = await projectPulls(project());
    expect(pulls[0].checks).toBeNull();
  });

  describe('the recommendation', () => {
    async function recommendedFor(node) {
      serve([node]);
      const { pulls } = await projectPulls(project());
      return pulls[0].recommended;
    }

    it('blocked outranks everything: no next move at all', async () => {
      expect(
        await recommendedFor(
          prNode({
            labels: ['blocked', 'has-conflicts', 'feedback-given'],
            mergeable: 'CONFLICTING',
          }),
        ),
      ).toBeNull();
    });

    it('conflicts come before review work, from the API or from the label', async () => {
      expect(await recommendedFor(prNode({ mergeable: 'CONFLICTING', labels: ['feedback-given'] }))).toBe(
        'solve-conflicts',
      );
      expect(await recommendedFor(prNode({ labels: ['has-conflicts', 'feedback-given'] }))).toBe(
        'solve-conflicts',
      );
    });

    it('UNKNOWN mergeable is GitHub still computing, not a conflict', async () => {
      expect(await recommendedFor(prNode({ mergeable: 'UNKNOWN' }))).toBeNull();
    });

    it('feedback-given asks for the feedback to be implemented', async () => {
      expect(await recommendedFor(prNode({ labels: ['feedback-given'] }))).toBe('implement-feedback');
    });

    it("approved code is QA's cue, even when a review label also sits there", async () => {
      expect(await recommendedFor(prNode({ labels: ['code-approved', 'requires-dev-review'] }))).toBe('qa');
    });

    it('either review label asks for a review', async () => {
      expect(await recommendedFor(prNode({ labels: ['requires-dev-review'] }))).toBe('review');
      expect(await recommendedFor(prNode({ labels: ['feedback-implemented'] }))).toBe('review');
    });

    it('a label-less pull request gets no recommendation', async () => {
      expect(await recommendedFor(prNode())).toBeNull();
    });
  });

  it('caches per repo until asked for fresh', async () => {
    const p = project();
    serve([prNode({ number: 1 })]);
    await projectPulls(p);
    serve([prNode({ number: 2 })]);
    const cached = await projectPulls(p);
    expect(cached.pulls[0].number).toBe(1); // still the cached board
    const fresh = await projectPulls(p, { fresh: true });
    expect(fresh.pulls[0].number).toBe(2);
  });
});

// ---- one pull request, in the detail the right-hand panel draws ----

function detail(overrides = {}) {
  gh.graphql.mockResolvedValue({
    repository: {
      pullRequest: {
        number: 7,
        title: 'A change',
        url: 'https://gh/pr/7',
        state: 'OPEN',
        isDraft: false,
        additions: 12,
        deletions: 3,
        changedFiles: 2,
        headRefOid: 'abc123',
        headRefName: 'feature',
        baseRefName: 'master',
        commits: {
          totalCount: 1,
          nodes: [{ commit: { oid: 'abc123', messageHeadline: 'Fix it', url: 'https://gh/c' } }],
        },
        closingIssuesReferences: {
          nodes: [{ number: 4, title: 'Broken', state: 'OPEN', url: 'https://gh/i/4' }],
        },
        reviews: { nodes: [] },
        head: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: [] } } } }] },
        ...overrides,
      },
    },
  });
}

describe('pullOverview', () => {
  it('maps the overview the panel shows', async () => {
    detail();
    const pr = await pullOverview(project(), 7);
    expect(pr).toMatchObject({
      number: 7,
      state: 'open',
      headRef: 'feature',
      baseRef: 'master',
      additions: 12,
      deletions: 3,
      changedFiles: 2,
      commits: 1,
    });
    expect(pr.commitList).toEqual([{ sha: 'abc123', message: 'Fix it', url: 'https://gh/c' }]);
    expect(pr.issues).toEqual([{ number: 4, title: 'Broken', state: 'open', url: 'https://gh/i/4' }]);
  });

  it('counts check runs and legacy commit statuses alike', async () => {
    detail({
      head: {
        nodes: [
          {
            commit: {
              statusCheckRollup: {
                contexts: {
                  nodes: [
                    {
                      __typename: 'CheckRun',
                      name: 'unit',
                      status: 'COMPLETED',
                      conclusion: 'SUCCESS',
                      detailsUrl: 'u',
                    },
                    {
                      __typename: 'CheckRun',
                      name: 'e2e',
                      status: 'COMPLETED',
                      conclusion: 'TIMED_OUT',
                      detailsUrl: null,
                    },
                    {
                      __typename: 'CheckRun',
                      name: 'build',
                      status: 'IN_PROGRESS',
                      conclusion: null,
                      detailsUrl: null,
                    },
                    { __typename: 'StatusContext', context: 'ci/legacy', state: 'PENDING', targetUrl: 't' },
                  ],
                },
              },
            },
          },
        ],
      },
    });
    const { checks } = await pullOverview(project(), 7);
    expect(checks).toMatchObject({ total: 4, passed: 1, failed: 1, pending: 2 });
    expect(checks.runs[1]).toEqual({ name: 'e2e', status: 'completed', conclusion: 'timed_out', url: null });
    expect(checks.runs[3]).toEqual({
      name: 'ci/legacy',
      status: 'in_progress',
      conclusion: null,
      url: 't',
    });
  });

  it('keeps one verdict per reviewer: a comment leaves it standing, a dismissal drops it', async () => {
    detail({
      reviews: {
        nodes: [
          { author: { login: 'ana' }, state: 'APPROVED', url: 'a' },
          { author: { login: 'ana' }, state: 'COMMENTED', url: 'b' },
          { author: { login: 'bo' }, state: 'CHANGES_REQUESTED', url: 'c' },
          { author: { login: 'bo' }, state: 'DISMISSED', url: 'd' },
          { author: null, state: 'COMMENTED', url: 'e' },
        ],
      },
    });
    const { reviews } = await pullOverview(project(), 7);
    expect(reviews).toEqual([
      { user: 'ana', state: 'approved', url: 'a' },
      { user: 'bo', state: 'commented', url: 'd' },
    ]);
  });

  it('says so when GitHub has no such pull request', async () => {
    gh.graphql.mockResolvedValue({ repository: { pullRequest: null } });
    await expect(pullOverview(project({ repo: 'acme/shop' }), 9)).rejects.toThrow('acme/shop#9');
  });
});
