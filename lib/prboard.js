// @ts-check
// The project dashboard's pull request and issue lists.
//
// Open pull requests with their labels and recommended next errand, plus the
// repo's open issues on the same payload so the Issues tab costs no extra
// query against the hourly budget.
//
// GraphQL rather than REST, since REST's list endpoint lacks `mergeable` and
// would need a call per pull request.
//
// GraphQL bills by nodes requested (items times their labels), so detailed rows
// come 50 at a time and are paged to the end. The stack walk gets its own
// thin 100-row `stackRefs` page in the same round trip; past that it is not
// paged, and the stack chips say they count only what fits.

import { getConfig } from './config.js';
import { githubGraphql, githubRest } from './github.js';

// The review workflow's labels, hardcoded rather than per-project since the
// app is built around this workflow. A repo without them still gets a board;
// every pull request just reads as not yet reviewed.
export const LABELS = {
  // Waiting on someone else's decision; nothing here is the next move.
  stalled: ['blocked', 'do-not-merge'],
  // Set by a human, who may be ahead of GitHub's own `mergeable`.
  conflicts: ['has-conflicts'],
  // A review left findings that have not been answered yet.
  feedbackGiven: ['feedback-given'],
  // Ready for (another) review.
  needsReview: ['requires-dev-review', 'feedback-implemented'],
  // QA waits for this: a test run is only worth its cost once the code is settled.
  approved: ['code-approved'],
};

// Accepts label objects ({ name, … }) from either GitHub API, or plain names.
export function hasLabel(labels, names) {
  const carried = (labels || []).map((l) => String(l && l.name != null ? l.name : l).toLowerCase());
  return names.some((name) => carried.includes(name));
}

// Both lists in one round trip; `@skip` keeps a later page of one list from
// re-fetching the other.
const QUERY = `
  query($owner: String!, $name: String!, $cursor: String, $issueCursor: String, $skipPulls: Boolean!, $skipIssues: Boolean!) {
    repository(owner: $owner, name: $name) {
      defaultBranchRef @skip(if: $skipPulls) { name }
      stackRefs: pullRequests(states: OPEN, first: 100, orderBy: { field: UPDATED_AT, direction: DESC }) @skip(if: $skipPulls) {
        pageInfo { hasNextPage }
        nodes { number title isDraft headRefName baseRefName isCrossRepository }
      }
      issues(states: OPEN, first: 50, after: $issueCursor, orderBy: { field: UPDATED_AT, direction: DESC }) @skip(if: $skipIssues) {
        pageInfo { hasNextPage endCursor }
        nodes {
          number
          title
          url
          createdAt
          updatedAt
          author { login }
          # GitHub allows ten assignees at most, so this page cannot truncate
          # and the row's "+2" is the whole of what is left.
          assignees(first: 10) { nodes { login } }
          labels(first: 100) { pageInfo { hasNextPage endCursor } nodes { name color } }
          comments { totalCount }
          milestone { title }
          # What makes an epic an epic here: GitHub's own sub-issue link, not a
          # label nor an "[Epic]" written into the title. The child names its
          # parent, which is all the tab needs to nest one issue under another,
          # and the parent carries the summary, which counts the children this
          # board can never see: the ones already closed, and the ones past the
          # walk's last page. Two scalars and a thin parent apiece is cheap
          # against the labels each issue already brings.
          parent { number title url repository { nameWithOwner } }
          subIssuesSummary { total completed percentCompleted }
          # The pull requests that close this issue as GitHub itself sees them,
          # and the only way to learn about one living in another repository, which
          # the rows of this board can never mention. Five is what a row shows;
          # an issue answered by more than that finishes the connection below.
          closedByPullRequestsReferences(first: 5, includeClosedPrs: false) {
            pageInfo { hasNextPage endCursor }
            nodes { number title url isDraft repository { nameWithOwner } }
          }
        }
      }
      pullRequests(states: OPEN, first: 50, after: $cursor, orderBy: { field: UPDATED_AT, direction: DESC }) @skip(if: $skipPulls) {
        pageInfo { hasNextPage endCursor }
        nodes {
          number
          title
          url
          isDraft
          mergeable
          updatedAt
          headRefName
          baseRefName
          author { login }
          # GitHub allows ten assignees at most, so this page cannot truncate
          # and the row's "+2" is the whole of what is left.
          assignees(first: 10) { nodes { login } }
          latestReviews(first: 10) { nodes { author { login } state url } }
          reviewRequests(first: 10) {
            nodes {
              requestedReviewer {
                ... on User { login }
              }
            }
          }
          labels(first: 100) { pageInfo { hasNextPage endCursor } nodes { name color } }
          reviewDecision
          closingIssuesReferences(first: 5) {
            pageInfo { hasNextPage endCursor }
            nodes {
              number
              title
              url
              state
              stateReason
              repository { nameWithOwner }
              labels(first: 10) { nodes { name color } }
            }
          }
          commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
        }
      }
    }
  }`;

const LABELS_QUERY = `
  query($owner: String!, $name: String!, $number: Int!, $cursor: String!) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: $number) {
        labels(first: 100, after: $cursor) {
          pageInfo { hasNextPage endCursor }
          nodes { name color }
        }
      }
    }
  }`;

const ISSUE_LABELS_QUERY = `
  query($owner: String!, $name: String!, $number: Int!, $cursor: String!) {
    repository(owner: $owner, name: $name) {
      issue(number: $number) {
        labels(first: 100, after: $cursor) {
          pageInfo { hasNextPage endCursor }
          nodes { name color }
        }
      }
    }
  }`;

// The rest of the pull requests closing an issue, past the first five. Bounded
// to three more pages (65 in total).
const ISSUE_PULLS_QUERY = `
  query($owner: String!, $name: String!, $number: Int!, $cursor: String!) {
    repository(owner: $owner, name: $name) {
      issue(number: $number) {
        closedByPullRequestsReferences(first: 20, after: $cursor, includeClosedPrs: false) {
          pageInfo { hasNextPage endCursor }
          nodes { number title url isDraft repository { nameWithOwner } }
        }
      }
    }
  }`;
const ISSUE_PULL_PAGES = 3;

// The rest of a pull request's closing references, past the first five. Asked
// only where needed, since a wider first page multiplies the query's node cost;
// without it the Issues tab would show a sixth linked issue as nobody's work.
const CLOSING_ISSUES_QUERY = `
  query($owner: String!, $name: String!, $number: Int!, $cursor: String!) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: $number) {
        closingIssuesReferences(first: 20, after: $cursor) {
          pageInfo { hasNextPage endCursor }
          nodes {
            number
            title
            url
            state
            stateReason
            repository { nameWithOwner }
            labels(first: 10) { nodes { name color } }
          }
        }
      }
    }
  }`;

// One pull request's detail panel (overview, commits, closed issues, reviews,
// checks) for a board drill-down with no session; sessions get it from the
// sync in lib/jobs.js. One GraphQL round trip instead of the sync's five REST calls.
const DETAIL_QUERY = `
  query($owner: String!, $name: String!, $number: Int!) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: $number) {
        number
        title
        url
        state
        isDraft
        additions
        deletions
        changedFiles
        headRefOid
        headRefName
        baseRefName
        commits(first: 100) {
          totalCount
          nodes { commit { oid messageHeadline url } }
        }
        closingIssuesReferences(first: 10) { nodes { number title state url } }
        reviews(first: 100) { nodes { author { login } state url } }
        head: commits(last: 1) {
          nodes {
            commit {
              statusCheckRollup {
                contexts(first: 100) {
                  nodes {
                    __typename
                    ... on CheckRun { name status conclusion detailsUrl url }
                    ... on StatusContext { context state targetUrl }
                  }
                }
              }
            }
          }
        }
      }
    }
  }`;

const lower = (v) => (v == null ? null : String(v).toLowerCase());

// Conclusions counted as failed everywhere, so the panel and the in-app viewer
// agree (cancelled, skipped and the like are not failures).
const FAILED_CHECK_CONCLUSIONS = ['failure', 'timed_out', 'action_required'];

export function checkFailed(conclusion) {
  return FAILED_CHECK_CONCLUSIONS.includes(conclusion);
}

// Splits a legacy commit status's single state into status + conclusion.
// PENDING/EXPECTED are running; anything but success is a failure.
function commitStatusRow(state, name, url) {
  const running = lower(state) === 'pending' || lower(state) === 'expected';
  return {
    name,
    status: running ? 'in_progress' : 'completed',
    conclusion: running ? null : lower(state) === 'success' ? 'success' : 'failure',
    url: url || null,
    // Shown, but not counted in the CI verdict (ciChecks in lib/jobs.js).
    commitStatus: true,
  };
}

export function restCheckRun(r) {
  return {
    name: r.name,
    status: lower(r.status),
    conclusion: lower(r.conclusion),
    url: r.details_url || r.html_url || null,
  };
}

export function restCommitStatus(r) {
  return commitStatusRow(r.state, r.context, r.target_url);
}

// Flattens a commit's statusCheckRollup (check runs and commit statuses) into
// the panel's row shape; lib/jobs.js uses it too.
export function checkRunsOf(rollup) {
  const nodes = (rollup && rollup.contexts && rollup.contexts.nodes) || [];
  return nodes.map((n) => {
    if (n.__typename === 'CheckRun')
      return {
        name: n.name,
        status: lower(n.status),
        conclusion: lower(n.conclusion),
        url: n.detailsUrl || n.url || null,
        // Only when queried (the session sync, to tell a re-run apart).
        id: n.databaseId ?? null,
        completedAt: n.completedAt ?? null,
      };
    return commitStatusRow(n.state, n.context, n.targetUrl);
  });
}

// The panel's check counts over the rows checkRunsOf made.
export function checksSummary(runs) {
  return {
    total: runs.length,
    passed: runs.filter((r) => r.conclusion === 'success').length,
    failed: runs.filter((r) => checkFailed(r.conclusion)).length,
    pending: runs.filter((r) => r.status !== 'completed').length,
    runs,
  };
}

// The panel's commit rows; the session sync uses it too.
export function commitsOf(nodes) {
  return nodes.map((n) => ({
    sha: n.commit.oid,
    message: String(n.commit.messageHeadline || '').slice(0, 140),
    url: n.commit.url,
  }));
}

// The issues a pull request closes (its "Development" links on GitHub).
export function closingIssuesOf(nodes) {
  return nodes.map((i) => ({
    number: i.number,
    title: i.title,
    state: lower(i.state),
    url: i.url,
  }));
}

// One standing verdict per reviewer, folded chronologically: a plain comment
// never overrides a verdict (as on GitHub), a dismissal clears it. Also used by
// the session sync in lib/jobs.js.
export function reviewsOf(pr) {
  const latest = new Map(); // login -> { user, state, url }
  for (const r of (pr.reviews && pr.reviews.nodes) || []) {
    const state = lower(r.state);
    if (!r.author || state === 'pending') continue;
    const verdict = state === 'approved' || state === 'changes_requested';
    const cur = latest.get(r.author.login);
    if (
      cur &&
      !verdict &&
      state !== 'dismissed' &&
      (cur.state === 'approved' || cur.state === 'changes_requested')
    )
      continue;
    latest.set(r.author.login, {
      user: r.author.login,
      state: verdict ? state : 'commented',
      url: r.url || null,
    });
  }
  return [...latest.values()];
}

// Standing verdicts plus pending review requests; a re-request takes
// precedence over an older verdict.
function reviewersOf(pr) {
  const reviewers = new Map(); // folded name -> { user, state, url }
  for (const review of reviewsOf({ reviews: pr.latestReviews })) {
    reviewers.set(review.user.toLowerCase(), review);
  }
  for (const request of (pr.reviewRequests && pr.reviewRequests.nodes) || []) {
    const target = request && request.requestedReviewer;
    // Naming a team needs read:org, so only individual reviewers are shown.
    const user = target && target.login;
    if (!user) continue;
    reviewers.set(String(user).toLowerCase(), { user, state: 'requested', url: null });
  }
  return [...reviewers.values()];
}

export async function pullOverview(project, number) {
  const cfg = getConfig();
  if (!cfg.githubToken) throw new Error('No GITHUB_TOKEN is configured, so the pull request cannot be read');
  const [owner, name] = project.repo.split('/');
  const data = await githubGraphql(cfg, DETAIL_QUERY, { owner, name, number });
  const pr = data && data.repository && data.repository.pullRequest;
  if (!pr) throw new Error(`GitHub has no pull request ${project.repo}#${number}`);

  const headCommit = ((pr.head && pr.head.nodes) || [])[0];
  const runs = checkRunsOf(headCommit && headCommit.commit && headCommit.commit.statusCheckRollup);
  return {
    number: pr.number,
    url: pr.url,
    title: pr.title,
    state: lower(pr.state), // open / closed / merged
    draft: !!pr.isDraft,
    headSha: pr.headRefOid,
    headRef: pr.headRefName,
    baseRef: pr.baseRefName,
    additions: pr.additions,
    deletions: pr.deletions,
    changedFiles: pr.changedFiles,
    commits: (pr.commits && pr.commits.totalCount) ?? null,
    commitList: commitsOf((pr.commits && pr.commits.nodes) || []),
    issues: closingIssuesOf((pr.closingIssuesReferences && pr.closingIssuesReferences.nodes) || []),
    reviews: reviewsOf(pr),
    checks: checksSummary(runs),
    syncedAt: new Date().toISOString(),
  };
}

// How many 50-issue pages one board load will walk. Two covers every repo this
// app is pointed at with one request, and caps the pathological one (thousands
// of open issues) at one extra round trip instead of a hundred. Newest updated
// first, so what is cut is the stalest end of the list. Every page is GraphQL
// budget the review sessions share, on a load that repeats while a board is
// open.
const ISSUE_PAGES = 2;

// The board polls while it is open, and the pull requests of a repo do not
// move every minute. Two minutes is still fresh enough for a list that a
// person reads and then acts on, and halves what an open board costs.
const cache = new Map(); // repo (lowercased) -> { at, value }
const CACHE_MS = 120_000;
// `fresh` skips the cache, but not one this young: a client that asks for
// fresh on every poll (or a burst of reloads) would otherwise spend a full
// board query each time, all of it on the same answer.
const FRESH_MIN_MS = 15_000;
// A load already running for a repo is shared by every caller that arrives
// while it runs, rather than each one starting the same walk.
const loading = new Map(); // repo (lowercased) -> Promise

function invalidateBoard(repo) {
  const key = repo.toLowerCase();
  cache.delete(key);
  // Existing callers may finish their read, but later callers need a new load.
  loading.delete(key);
}

function labelsOf(pr) {
  return ((pr.labels && pr.labels.nodes) || []).map((l) => ({ name: l.name, color: l.color }));
}

// The issues this pull request closes, with their state and labels (a
// `blocked` issue says a lot about the pull request). Each carries its repo,
// since "Fixes acme/other#17" must not match this repo's #17.
function issuesOf(pr) {
  return ((pr.closingIssuesReferences && pr.closingIssuesReferences.nodes) || []).map((i) => ({
    number: i.number,
    title: i.title,
    url: i.url,
    repo: (i.repository && i.repository.nameWithOwner) || null,
    // open / closed, and why it closed: completed vs not_planned.
    state: String(i.state || '').toLowerCase(),
    stateReason: i.stateReason ? String(i.stateReason).toLowerCase() : null,
    labels: ((i.labels && i.labels.nodes) || []).map((l) => ({ name: l.name, color: l.color })),
  }));
}

// One open issue as the Issues tab draws it.
function issueRow(issue) {
  return {
    number: issue.number,
    title: issue.title,
    url: issue.url,
    author: (issue.author && issue.author.login) || null,
    assignees: ((issue.assignees && issue.assignees.nodes) || []).map((a) => a.login),
    labels: ((issue.labels && issue.labels.nodes) || []).map((l) => ({ name: l.name, color: l.color })),
    comments: (issue.comments && issue.comments.totalCount) || 0,
    milestone: (issue.milestone && issue.milestone.title) || null,
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
    // The parent epic, in any repository; the tab nests or links to it.
    parent: issue.parent
      ? {
          number: issue.parent.number,
          title: issue.parent.title,
          url: issue.parent.url,
          repo: (issue.parent.repository && issue.parent.repository.nameWithOwner) || null,
        }
      : null,
    // Null unless an epic. Counts every child, including closed, cross-repo and
    // unpaged ones, so `open` can exceed the rows nested under it.
    subIssues:
      issue.subIssuesSummary && issue.subIssuesSummary.total
        ? {
            total: issue.subIssuesSummary.total,
            completed: issue.subIssuesSummary.completed,
            open: issue.subIssuesSummary.total - issue.subIssuesSummary.completed,
          }
        : null,
    // Open pull requests closing this issue, from GitHub's backward link (the
    // only way to see other repos' ones); projectPulls adds this repo's rows.
    pulls: ((issue.closedByPullRequestsReferences && issue.closedByPullRequestsReferences.nodes) || []).map(
      (p) => ({
        number: p.number,
        title: p.title,
        url: p.url,
        draft: !!p.isDraft,
        repo: (p.repository && p.repository.nameWithOwner) || null,
      }),
    ),
  };
}

function checksOf(pr) {
  const commit = ((pr.commits && pr.commits.nodes) || [])[0];
  const rollup = commit && commit.commit && commit.commit.statusCheckRollup;
  return rollup ? String(rollup.state).toLowerCase() : null; // success / failure / pending / error / expected
}

// Which errand to highlight; the row offers all of them regardless, so a
// stale label costs only a highlight. Stalled wins (no move to make), then
// conflicts, since nothing else is worth doing until the branch can merge.
function recommend({ conflicting, labels }) {
  const any = (list) => hasLabel(labels, list);
  if (any(LABELS.stalled)) return null;
  if (conflicting || any(LABELS.conflicts)) return 'solve-conflicts';
  if (any(LABELS.feedbackGiven)) return 'implement-feedback';
  if (any(LABELS.approved)) return 'qa';
  if (any(LABELS.needsReview)) return 'review';
  // No labels at all: nobody has reviewed it yet.
  if (!(labels || []).length) return 'review';
  return null;
}

// Long-lived branches are never a stack base, or a promotion PR (`develop →
// main`) would make every feature PR on `develop` look stacked on it. The
// release/hotfix forms need the slash, so `release-notes-rewrite` still stacks.
const TRUNK =
  /^(?:main|master|trunk|dev|develop|development|stage|staging|preprod|prod|production|qa|next)$/i;
function isTrunk(branch, defaultBranch) {
  const name = String(branch || '');
  if (defaultBranch && name.toLowerCase() === String(defaultBranch).toLowerCase()) return true;
  return TRUNK.test(name) || /^(?:release|hotfix)\//i.test(name);
}

// Stacked pull requests: one whose base is another open pull request's head,
// shown like GitHub's "2/3".
//
// The walk covers every open pull request, not just the author's. The page is
// bounded and newest-first, so a missing link may split a stack anywhere; when
// the page was full every stack is marked `partial`.
//
// Each stack is a tree, listed depth-first from its root, so every row of it
// quotes the same `total` and its own depth as `position`.
//
// Fork heads are never a base (`alice:main` is not this repo's `main`), though
// a fork pull request can still sit on top of a stack.
function stacksOf(nodes, defaultBranch, truncated = false) {
  const byHead = new Map(); // head branch -> pr
  for (const pr of nodes) {
    if (pr.isCrossRepository) continue;
    if (isTrunk(pr.headRefName, defaultBranch)) continue;
    // A shared head branch goes to the lower number, a tie-break that does not
    // move with every push the way the newest-first order would.
    const held = byHead.get(pr.headRefName);
    if (!held || pr.number < held.number) byHead.set(pr.headRefName, pr);
  }

  // A ring of bases has no bottom, so its members are never stacked, and a
  // chain running into one is cut there and marked `partial`.
  const inRing = (pr) => {
    const seen = new Set([pr.number]);
    let cur = byHead.get(pr.baseRefName);
    while (cur) {
      if (cur.number === pr.number) return true;
      if (seen.has(cur.number)) return false;
      seen.add(cur.number);
      cur = byHead.get(cur.baseRefName);
    }
    return false;
  };
  const ringed = new Set(nodes.filter(inRing).map((pr) => pr.number));

  // Resolving parents through `byHead` keeps a pull request in one stack only.
  const parentOf = new Map(); // pr number -> the pr under it
  const cut = new Set(); // prs whose base is real but cannot be numbered
  for (const pr of nodes) {
    if (ringed.has(pr.number)) continue;
    const parent = byHead.get(pr.baseRefName);
    if (!parent || parent.number === pr.number) continue;
    if (ringed.has(parent.number)) cut.add(pr.number);
    else parentOf.set(pr.number, parent);
  }
  const childrenOf = new Map(); // pr number -> the prs sitting on it
  for (const pr of nodes) {
    const parent = parentOf.get(pr.number);
    if (!parent) continue;
    const list = childrenOf.get(parent.number) || [];
    list.push(pr);
    childrenOf.set(parent.number, list);
  }
  // By number, so side branches do not swap places in the tooltip on each push.
  for (const list of childrenOf.values()) list.sort((a, b) => a.number - b.number);

  // `parentOf` should be acyclic, but a loop here would crash the whole board,
  // so the walk is guarded anyway.
  const rootOf = (pr) => {
    const seen = new Set([pr.number]);
    let cur = pr;
    for (;;) {
      const up = parentOf.get(cur.number);
      if (!up || seen.has(up.number)) return cur;
      seen.add(up.number);
      cur = up;
    }
  };

  // Only what the stack tooltip prints; `draft` shows lower members that block
  // merging from the bottom up.
  const brief = (p, depth) => ({
    number: p.number,
    title: p.title,
    draft: !!p.isDraft,
    // 1 for the bottom of the stack, +1 for each pull request above it.
    depth,
  });
  const walk = (pr, depth, out, seen) => {
    if (seen.has(pr.number)) return;
    seen.add(pr.number);
    out.push({ pr, depth });
    for (const child of childrenOf.get(pr.number) || []) walk(child, depth + 1, out, seen);
  };

  const chains = new Map(); // root pr number -> every pull request of that stack
  const placed = new Map(); // pr number -> { position, total, id }
  const done = new Set();
  for (const pr of nodes) {
    const root = rootOf(pr);
    if (done.has(root.number)) continue;
    done.add(root.number);
    const tree = [];
    walk(root, 1, tree, new Set());
    if (tree.length < 2) continue;
    // A full page or a ring cut means the numbering may not cover the whole
    // stack, and the chip says so.
    const partial = truncated || tree.some(({ pr: p }) => cut.has(p.number));
    chains.set(
      root.number,
      tree.map(({ pr: p, depth }) => brief(p, depth)),
    );
    for (const { pr: p, depth } of tree) {
      placed.set(p.number, { position: depth, total: tree.length, id: root.number, partial });
    }
  }
  // Stacks travel once, keyed by id, rather than copied onto every row.
  return { chains, placed };
}

// Runs the board query, forgiving only a token that can read pull requests but
// not issues (the fine-grained token .env.example describes). GraphQL then
// returns an error plus the rest, which is kept and reported as `issuesError`.
// Any error outside `repository.issues` is rethrown, so half-read pull requests
// are never cached.
const onlyIssuesFailed = (errors) =>
  Array.isArray(errors) &&
  errors.length > 0 &&
  errors.every((err) => {
    const path = err && err.path;
    return Array.isArray(path) && path[0] === 'repository' && path[1] === 'issues';
  });

async function boardQuery(cfg, variables) {
  try {
    return { data: await githubGraphql(cfg, QUERY, variables), issuesError: null };
  } catch (e) {
    // `repository` itself has to have resolved.
    const partial = e && e.data && e.data.repository;
    if (variables.skipIssues || !partial || !onlyIssuesFailed(e.errors)) throw e;
    return { data: e.data, issuesError: e.message };
  }
}

// Every open pull request of one project, newest first, unfiltered: the client
// filters by author and label, starting on the configured `author`. The repo's
// open issues come on the same payload (see boardQuery for a token that cannot
// read them).
export async function projectPulls(project, { fresh = false } = {}) {
  const cfg = getConfig();
  if (!cfg.githubToken)
    throw new Error('No GITHUB_TOKEN is configured, so the pull requests cannot be listed');
  const key = project.repo.toLowerCase();
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < (fresh ? FRESH_MIN_MS : CACHE_MS)) return hit.value;
  const running = loading.get(key);
  if (running) return running;
  const load = loadPulls(cfg, project)
    .then((value) => {
      // Only the current load may publish: a mutation can invalidate this one
      // and start a replacement before it finishes.
      if (loading.get(key) === load) cache.set(key, { at: Date.now(), value });
      return value;
    })
    .finally(() => {
      if (loading.get(key) === load) loading.delete(key);
    });
  loading.set(key, load);
  return load;
}

async function loadPulls(cfg, project) {
  const [owner, name] = project.repo.split('/');
  let { data, issuesError } = await boardQuery(cfg, {
    owner,
    name,
    cursor: null,
    issueCursor: null,
    skipPulls: false,
    skipIssues: false,
  });
  const repository = data && data.repository;
  if (!repository) throw new Error(`GitHub has no repository ${project.repo}`);

  const nodes = [...(repository.pullRequests.nodes || [])];
  const issueNodes = [...((repository.issues && repository.issues.nodes) || [])];
  let pullsPage = repository.pullRequests.pageInfo;
  let issuesPage = (repository.issues && repository.issues.pageInfo) || null;
  let issuePages = 1; // the first came back with the pull requests
  let issuesTruncated = false;
  // Each list fetches only while it has pages left; the other is skipped.
  for (;;) {
    const morePulls = !!(pullsPage && pullsPage.hasNextPage);
    // Pull requests are walked to the end; issues can number thousands, so
    // they stop at ISSUE_PAGES and the tab says the list is cut.
    const moreIssues = !issuesError && !!(issuesPage && issuesPage.hasNextPage);
    if (moreIssues && issuePages >= ISSUE_PAGES) issuesTruncated = true;
    const fetchIssues = moreIssues && !issuesTruncated;
    if (!morePulls && !fetchIssues) break;
    const page = await boardQuery(cfg, {
      owner,
      name,
      cursor: morePulls ? pullsPage.endCursor : null,
      issueCursor: fetchIssues ? issuesPage.endCursor : null,
      skipPulls: !morePulls,
      skipIssues: !fetchIssues,
    });
    // A later issue page failing just cuts the issue list short.
    if (page.issuesError) {
      issuesTruncated = true;
      issuesPage = null;
    }
    if (morePulls) {
      const connection = page.data && page.data.repository && page.data.repository.pullRequests;
      if (!connection) throw new Error(`GitHub returned an incomplete pull request page for ${project.repo}`);
      nodes.push(...(connection.nodes || []));
      pullsPage = connection.pageInfo;
    }
    if (fetchIssues && !page.issuesError) {
      const connection = page.data && page.data.repository && page.data.repository.issues;
      if (!connection) throw new Error(`GitHub returned an incomplete issue page for ${project.repo}`);
      issueNodes.push(...(connection.nodes || []));
      issuesPage = connection.pageInfo;
      issuePages += 1;
    }
  }

  // Label lists past GraphQL's max page are finished, since filtering and
  // recommendations treat them as complete.
  for (const pr of nodes) {
    let labelsPage = pr.labels && pr.labels.pageInfo;
    while (labelsPage && labelsPage.hasNextPage) {
      const page = await githubGraphql(cfg, LABELS_QUERY, {
        owner,
        name,
        number: pr.number,
        cursor: labelsPage.endCursor,
      });
      const connection =
        page && page.repository && page.repository.pullRequest && page.repository.pullRequest.labels;
      if (!connection)
        throw new Error(`GitHub returned an incomplete label page for ${project.repo}#${pr.number}`);
      pr.labels.nodes.push(...(connection.nodes || []));
      labelsPage = connection.pageInfo;
    }

    // Likewise closing references, which the Issues tab reads backwards.
    let issueRefsPage = pr.closingIssuesReferences && pr.closingIssuesReferences.pageInfo;
    while (issueRefsPage && issueRefsPage.hasNextPage) {
      const page = await githubGraphql(cfg, CLOSING_ISSUES_QUERY, {
        owner,
        name,
        number: pr.number,
        cursor: issueRefsPage.endCursor,
      });
      const connection =
        page &&
        page.repository &&
        page.repository.pullRequest &&
        page.repository.pullRequest.closingIssuesReferences;
      if (!connection)
        throw new Error(`GitHub returned an incomplete closing issue page for ${project.repo}#${pr.number}`);
      pr.closingIssuesReferences.nodes.push(...(connection.nodes || []));
      issueRefsPage = connection.pageInfo;
    }
  }

  // Issue labels too: the Issues tab's label picker filters on them.
  for (const issue of issueNodes) {
    let labelsPage = issue.labels && issue.labels.pageInfo;
    while (labelsPage && labelsPage.hasNextPage) {
      const page = await githubGraphql(cfg, ISSUE_LABELS_QUERY, {
        owner,
        name,
        number: issue.number,
        cursor: labelsPage.endCursor,
      });
      const connection = page && page.repository && page.repository.issue && page.repository.issue.labels;
      if (!connection)
        throw new Error(`GitHub returned an incomplete label page for ${project.repo}#${issue.number}`);
      issue.labels.nodes.push(...(connection.nodes || []));
      labelsPage = connection.pageInfo;
    }

    // Pull requests closing it past the first five, mainly for other repos'
    // ones, which the rows below cannot supply.
    let pullsRefPage = issue.closedByPullRequestsReferences && issue.closedByPullRequestsReferences.pageInfo;
    for (let fetched = 0; pullsRefPage && pullsRefPage.hasNextPage && fetched < ISSUE_PULL_PAGES; fetched++) {
      const page = await githubGraphql(cfg, ISSUE_PULLS_QUERY, {
        owner,
        name,
        number: issue.number,
        cursor: pullsRefPage.endCursor,
      });
      const connection =
        page &&
        page.repository &&
        page.repository.issue &&
        page.repository.issue.closedByPullRequestsReferences;
      if (!connection)
        throw new Error(
          `GitHub returned an incomplete closing pull request page for ${project.repo}#${issue.number}`,
        );
      issue.closedByPullRequestsReferences.nodes.push(...(connection.nodes || []));
      pullsRefPage = connection.pageInfo;
    }
  }

  // The stack walk's own wider page.
  const refs = repository.stackRefs || { nodes: [] };
  const defaultBranch = (repository.defaultBranchRef && repository.defaultBranchRef.name) || null;
  // More open pull requests than even that page holds: a stack may reach past it.
  const truncated = !!(refs.pageInfo && refs.pageInfo.hasNextPage);
  const { chains, placed } = stacksOf(refs.nodes || [], defaultBranch, truncated);
  const shown = new Set(); // the stacks the rows below actually reference
  const rows = nodes.map((pr) => {
    const labels = labelsOf(pr);
    // UNKNOWN means GitHub is still computing; it is not "conflicting".
    const mergeable = String(pr.mergeable || 'UNKNOWN').toLowerCase();
    const conflicting = mergeable === 'conflicting';
    const stack = placed.get(pr.number) || null;
    if (stack) shown.add(stack.id);
    return {
      number: pr.number,
      title: pr.title,
      url: pr.url,
      draft: !!pr.isDraft,
      author: (pr.author && pr.author.login) || null,
      assignees: ((pr.assignees && pr.assignees.nodes) || []).map((a) => a.login),
      reviewers: reviewersOf(pr),
      issues: issuesOf(pr),
      branch: pr.headRefName,
      baseBranch: pr.baseRefName,
      updatedAt: pr.updatedAt,
      labels,
      mergeable,
      checks: checksOf(pr),
      // APPROVED / CHANGES_REQUESTED / REVIEW_REQUIRED / null
      reviewDecision: pr.reviewDecision ? String(pr.reviewDecision).toLowerCase() : null,
      recommended: recommend({ conflicting, labels }),
      // null unless stacked; `id` keys into the payload's `stacks`.
      stack: stack || null,
    };
  });

  // Adds this repo's rows to each issue's pull requests from their closing
  // references, which are complete where the backward link stops at five.
  const issues = issueNodes.map(issueRow);
  const byNumber = new Map(issues.map((i) => [i.number, i]));
  const here = project.repo.toLowerCase();
  const seen = new Map(
    issues.map((i) => [
      i,
      new Set(i.pulls.map((p) => `${(p.repo || project.repo).toLowerCase()}#${p.number}`)),
    ]),
  );
  for (const pr of rows) {
    for (const linked of pr.issues) {
      // Skip other repositories' issues; a missing repo means this one.
      if (linked.repo && linked.repo.toLowerCase() !== here) continue;
      const issue = byNumber.get(linked.number);
      if (!issue) continue;
      // The backward link may already have named it.
      if (seen.get(issue).has(`${here}#${pr.number}`)) continue;
      seen.get(issue).add(`${here}#${pr.number}`);
      issue.pulls.push({
        number: pr.number,
        title: pr.title,
        url: pr.url,
        draft: pr.draft,
        repo: project.repo,
      });
    }
  }

  return {
    repo: project.repo,
    label: project.label,
    // Not a filter that was applied, but the one the board's author picker opens on.
    author: project.reviewAuthor || null,
    pulls: rows,
    issues,
    // Set when the token could not read issues, so the tab does not claim none.
    issuesError: issuesError || null,
    // More open issues than one load walks.
    issuesTruncated,
    // Stack id -> every pull request in it, bottom first.
    stacks: Object.fromEntries([...shown].map((id) => [id, chains.get(id) || []])),
    syncedAt: new Date().toISOString(),
  };
}

const CLOSE_REASONS = ['completed', 'not_planned'];

// Both resource types use GitHub's issues API for labels and assignees.
// Send only supplied fields: [] clears a list, while omission keeps it.
export async function updateGithubItem(project, number, kind, input = {}) {
  const bad = (message) => Object.assign(new Error(message), { status: 400 });
  if (!Number.isSafeInteger(number) || number < 1) throw bad('The number must be a positive whole number');
  if (!['pr', 'issue'].includes(kind)) throw bad('Unknown resource type');
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw bad('Expected a JSON object');
  const allowed = [
    'title',
    'body',
    'labels',
    'assignees',
    ...(kind === 'issue' ? ['state', 'stateReason'] : []),
  ];
  const fields = Object.keys(input).filter((key) => !['repo', kind].includes(key));
  if (!fields.length) throw bad('Supply at least one field to update');
  if (fields.some((key) => !allowed.includes(key))) throw bad('Unknown update field');
  const patch = {};
  for (const field of fields) {
    const value = input[field];
    if (field === 'title' && (typeof value !== 'string' || !value.trim()))
      throw bad('The title must be a non-empty string');
    if (field === 'body' && typeof value !== 'string') throw bad('The body must be a string');
    if (['labels', 'assignees'].includes(field)) {
      if (!Array.isArray(value) || value.some((v) => typeof v !== 'string' || !v.trim()))
        throw bad(`The ${field} must be an array of non-empty strings`);
      if (field === 'assignees' && value.length > 10) throw bad('At most ten assignees are allowed');
    }
    if (field === 'state' && !['open', 'closed'].includes(value))
      throw bad('The state must be open or closed');
    if (field === 'stateReason' && ![...CLOSE_REASONS, 'reopened', null].includes(value))
      throw bad('The stateReason must be completed, not_planned, reopened or null');
    patch[field === 'stateReason' ? 'state_reason' : field] = value;
  }
  const cfg = getConfig();
  if (!cfg.githubToken) throw Object.assign(new Error('No GITHUB_TOKEN is configured'), { status: 503 });
  const path = `/repos/${project.repo}/issues/${number}`;
  const current = await githubRest(cfg, 'GET', path);
  const item = await current.json().catch(() => ({}));
  if (!current.ok) throw issueRefused(current, item, 'reading the item');
  if (!!item.pull_request !== (kind === 'pr'))
    throw Object.assign(new Error(`#${number} is not ${kind === 'pr' ? 'a pull request' : 'an issue'}`), {
      status: 422,
    });
  const response = await githubRest(cfg, 'PATCH', path, patch);
  const updated = await response.json().catch(() => ({}));
  if (!response.ok) throw issueRefused(response, updated, 'updating the item');
  invalidateBoard(project.repo);
  return {
    [kind]: {
      number: updated.number,
      title: updated.title,
      body: updated.body || '',
      state: updated.state,
      stateReason: updated.state_reason || null,
      url: updated.html_url,
      labels: (updated.labels || []).map((label) => ({ name: label.name, color: label.color })),
      assignees: (updated.assignees || []).map((assignee) => assignee.login),
    },
  };
}

function issueRefused(res, body, doing) {
  const status = [403, 404, 410, 422].includes(res.status) ? res.status : 502;
  const reason = body.message || `GitHub answered ${res.status}`;
  return Object.assign(new Error(`GitHub refused ${doing}: ${reason}`), { status });
}

// Close an issue like GitHub's "Close with comment": comment first, so it reads
// above the close. The issues endpoint would close pull requests too, so the
// number is checked first and a pull request refused before anything is written.
export async function closeIssue(project, number, { reason = 'completed', comment = '' } = {}) {
  if (!CLOSE_REASONS.includes(reason))
    throw Object.assign(new Error(`The reason must be one of ${CLOSE_REASONS.join(', ')}`), { status: 400 });
  const cfg = getConfig();
  if (!cfg.githubToken) throw Object.assign(new Error('No GITHUB_TOKEN is configured'), { status: 503 });
  const path = `/repos/${project.repo}/issues/${number}`;

  const current = await githubRest(cfg, 'GET', path);
  const issue = await current.json().catch(() => ({}));
  if (!current.ok) throw issueRefused(current, issue, 'reading the issue');
  if (issue.pull_request)
    throw Object.assign(new Error(`#${number} is a pull request, not an issue`), { status: 422 });

  if (comment) {
    const posted = await githubRest(cfg, 'POST', `${path}/comments`, { body: comment });
    if (!posted.ok) throw issueRefused(posted, await posted.json().catch(() => ({})), 'the comment');
  }
  const res = await githubRest(cfg, 'PATCH', path, { state: 'closed', state_reason: reason });
  const closed = await res.json().catch(() => ({}));
  if (!res.ok) throw issueRefused(res, closed, 'closing the issue');
  invalidateBoard(project.repo);
  return {
    issue: {
      number: closed.number,
      state: closed.state,
      stateReason: closed.state_reason || null,
      closedAt: closed.closed_at || null,
      url: closed.html_url,
    },
  };
}
