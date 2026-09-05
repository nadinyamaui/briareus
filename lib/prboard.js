// @ts-check
// The project dashboard's pull request and issue lists.
//
// Clicking a project's name in the sidebar opens a board of its open pull
// requests rather than a session: what is waiting, what each one's labels say
// about it, and which of the app's own errands is the obvious next move on it.
// The repo's open issues ride along on the same payload: the ⊙ Issues tab is
// the other half of "what is open here", and asking GitHub a second time for it
// would spend a second hourly-budget slice on a question one query can answer.
//
// GraphQL answers the whole board. REST would need a call per pull
// request to learn whether it conflicts (the list endpoint does not carry
// `mergeable`), and a board of twenty pull requests refreshed every minute is
// not worth twenty round trips.
//
// GraphQL is billed by nodes requested, and it is the issues-times-their-labels
// product, not the number of pull requests, that decides what a refresh costs
// against the hourly budget, so the detailed rows come 50 at a time and are
// paged until the open list is complete. The stack walk
// wants to see further than that, and gets its own wider page in the same round
// trip: `stackRefs` asks for 100 pull requests carrying nothing but the four
// fields the walk reads, which is 100 nodes rather than the ~4,100 a second
// detailed page would be. A repo with more open pull requests than even that is
// not paged through: `hasNextPage` comes back instead, and the stack chips say
// they are counting only what fits.

import { getConfig } from './config.js';
import { githubGraphql } from './github.js';

// The labels the review workflow speaks in, taken from what the repos actually
// carry. The workflow they encode (a review posts findings and hands the pull
// request back with `feedback-given`; the developer answers them and asks for
// review again with `feedback-implemented` / `requires-dev-review`; a finished
// one is `code-approved`) is the one this app was built around, so they are
// named here rather than made a per-project setting nobody would fill in
// differently. A repo that does not use them still gets a board: every row
// keeps every action, and only the recommendation goes quiet.
export const LABELS = {
  // Waiting on someone else's decision; nothing here is the next move.
  stalled: ['blocked', 'do-not-merge'],
  // The branch cannot merge. GitHub's own `mergeable` says this too, but the
  // label is set by a human who saw it first and may be ahead of the API.
  conflicts: ['has-conflicts'],
  // A review left findings that have not been answered yet.
  feedbackGiven: ['feedback-given'],
  // Ready for (another) review.
  needsReview: ['requires-dev-review', 'feedback-implemented'],
  // The code has been approved. This is what QA waits for: the test sheet and
  // the test run are only worth the clone, the database server and the video
  // recording once the change itself is settled.
  approved: ['code-approved'],
};

// Whether a pull request carries any of the given labels. Takes the label
// objects both GitHub APIs hand back ({ name, … }) as well as plain names.
export function hasLabel(labels, names) {
  const carried = (labels || []).map((l) => String(l && l.name != null ? l.name : l).toLowerCase());
  return names.some((name) => carried.includes(name));
}

// Both lists in one round trip, and both paged by it: `@skip` is what keeps the
// second page of one from re-fetching the other, which on a repo with 60 pull
// requests and 20 issues would pay for the issues twice.
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

// The rest of the pull requests closing one issue, for the issue answered by
// more than the five the board asks for up front. Bounded like the issue walk
// itself: three further pages is 65 open pull requests on a single issue, past
// which the tab is not what anybody is reading to understand it.
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

// The rest of a pull request's closing references, for the rare one that closes
// more than the five the board asks for up front. Five is what a row can show
// without burying itself, and paging every pull request to 20 would multiply the
// query's node count by the labels under each reference for a case that almost
// never happens, so the wide page is asked for only where it is needed. The
// Issues tab is why it is asked for at all: an issue linked sixth on a pull
// request would otherwise read as nobody's work.
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

// One pull request in the detail the right-hand panel shows: the overview
// numbers, its commits, the issues it closes, every reviewer's standing verdict
// and every CI check. The session panel gets this from the per-session GitHub
// sync (lib/jobs.js); a pull request the board is drilled into has no session
// to hang it on, so it is fetched here: one GraphQL round trip, same as the
// board itself, instead of the five REST calls the sync makes.
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
                    ... on CheckRun { name status conclusion detailsUrl }
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

// GitHub's two kinds of check on one commit, flattened into the one row shape
// the panel draws: a legacy commit status has no separate status/conclusion, so
// its single state is split into the two.
function checkRunsOf(pr) {
  const commit = ((pr.head && pr.head.nodes) || [])[0];
  const rollup = commit && commit.commit && commit.commit.statusCheckRollup;
  const nodes = (rollup && rollup.contexts && rollup.contexts.nodes) || [];
  return nodes.map((n) => {
    if (n.__typename === 'CheckRun')
      return {
        name: n.name,
        status: lower(n.status),
        conclusion: lower(n.conclusion),
        url: n.detailsUrl || null,
      };
    const running = n.state === 'PENDING' || n.state === 'EXPECTED';
    return {
      name: n.context,
      status: running ? 'in_progress' : 'completed',
      conclusion: running ? null : n.state === 'SUCCESS' ? 'success' : 'failure',
      url: n.targetUrl || null,
    };
  });
}

// One standing verdict per reviewer, folded chronologically exactly the way
// lib/jobs.js folds the REST answer: a real verdict replaces anything earlier
// from the same reviewer, a plain comment never overrides one, and a dismissal
// clears the standing verdict.
function reviewsOf(pr) {
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

// The people currently responsible for a review, plus the latest standing
// verdict from anyone who already reviewed. A re-request takes precedence over
// an older verdict: it is the current state the PR list needs to communicate.
function reviewersOf(pr) {
  const reviewers = new Map(); // folded name -> { user, state, url }
  for (const review of reviewsOf({ reviews: pr.latestReviews })) {
    reviewers.set(review.user.toLowerCase(), review);
  }
  for (const request of (pr.reviewRequests && pr.reviewRequests.nodes) || []) {
    const target = request && request.requestedReviewer;
    // Team identity fields require read:org even on public repositories. A
    // repo-scoped token can still read the request but not name that team, so
    // keep the board usable and show the individual reviewers it can identify.
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

  const runs = checkRunsOf(pr);
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
    commitList: ((pr.commits && pr.commits.nodes) || []).map((n) => ({
      sha: n.commit.oid,
      message: String(n.commit.messageHeadline || '').slice(0, 140),
      url: n.commit.url,
    })),
    issues: ((pr.closingIssuesReferences && pr.closingIssuesReferences.nodes) || []).map((i) => ({
      number: i.number,
      title: i.title,
      state: lower(i.state),
      url: i.url,
    })),
    reviews: reviewsOf(pr),
    checks: {
      total: runs.length,
      passed: runs.filter((r) => r.conclusion === 'success').length,
      failed: runs.filter((r) => ['failure', 'timed_out', 'action_required'].includes(r.conclusion)).length,
      pending: runs.filter((r) => r.status !== 'completed').length,
      runs,
    },
    syncedAt: new Date().toISOString(),
  };
}

// How many 50-issue pages one board load will walk. Four covers every repo this
// app is pointed at with one request, and caps the pathological one (thousands
// of open issues) at three extra round trips instead of a hundred. Newest
// updated first, so what is cut is the stalest end of the list.
const ISSUE_PAGES = 4;

// A short cache: the board polls while it is open, and the pull requests of a
// repo do not move every few seconds.
const cache = new Map(); // repo (lowercased) -> { at, value }
const CACHE_MS = 45_000;

function labelsOf(pr) {
  return ((pr.labels && pr.labels.nodes) || []).map((l) => ({ name: l.name, color: l.color }));
}

// The issues this pull request closes when it merges: "Closes #123" in the
// body, or an issue linked by hand. Their own state is worth carrying: an
// issue still open with `blocked` on it says more about the pull request than
// anything on the pull request itself does.
//
// A closing keyword can name an issue in another repository ("Fixes acme/other#17"),
// so each reference says which repository it belongs to. Without that, the
// Issues tab matching these back to its own list by number alone would hand
// this repo's #17 to a pull request that closes somebody else's.
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

// One open issue as the Issues tab draws it. Its label list is finished the way
// a pull request's is: the tab's label picker is built from these and filters on
// them, so a label past the first page would be missing from the picker and,
// once another issue put it there, would hide this issue from its own label.
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
    // The issue this one is a sub-issue of, whatever repository it lives in.
    // The tab nests under it when it is on the list too, and links to it when
    // it is not: a child of a closed epic still says whose work it is part of.
    parent: issue.parent
      ? {
          number: issue.parent.number,
          title: issue.parent.title,
          url: issue.parent.url,
          repo: (issue.parent.repository && issue.parent.repository.nameWithOwner) || null,
        }
      : null,
    // Set only on an epic: an issue with no sub-issues has nothing to say here,
    // and `null` is what the tab reads as "an ordinary issue". `total` counts
    // every child, closed ones included, so `open` is how much of the epic is
    // still work — which is not the number of rows nested under it, since a
    // child in another repository or past the issue walk's last page is
    // counted here and drawn nowhere.
    subIssues:
      issue.subIssuesSummary && issue.subIssuesSummary.total
        ? {
            total: issue.subIssuesSummary.total,
            completed: issue.subIssuesSummary.completed,
            open: issue.subIssuesSummary.total - issue.subIssuesSummary.completed,
          }
        : null,
    // Which open pull requests are already closing this issue: the answer the
    // tab is really asked for. GitHub's own backward link is what starts it,
    // because a pull request in another repository can close an issue here and
    // no row of this board would ever mention it. The rows fill in the rest
    // below: they are this repo's complete open list, paged, where this
    // connection stops at five.
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

// Which of the board's three errands this pull request is asking for. Nothing
// here blocks the other two (the row offers all of them whatever this says)
// so a stale label costs a highlight, never an action.
//
// Conflicts come first among the work, on purpose: a pull request that cannot
// merge is not worth reviewing or fixing until it can, and the branch a fix
// turn would push to is the one that conflicts. Ahead of all of it sits
// `blocked`: a pull request waiting on someone else's decision has no next
// move this app can make.
function recommend({ conflicting, labels }) {
  const any = (list) => hasLabel(labels, list);
  if (any(LABELS.stalled)) return null;
  if (conflicting || any(LABELS.conflicts)) return 'solve-conflicts';
  if (any(LABELS.feedbackGiven)) return 'implement-feedback';
  // Approved code is QA's cue, so the board
  // recommends by hand what it would otherwise start on its own.
  if (any(LABELS.approved)) return 'qa';
  if (any(LABELS.needsReview)) return 'review';
  return null;
}

// Branches a repo keeps open for good are never read as a stack base. A pull
// request that promotes one into another (`develop → main`, `main →
// production`, `release/2 → main`) has an in-repo head like any other, so
// without this every feature pull request based on `develop` would come out
// stacked on it, backwards, since those merge *into* `develop`, before it and
// not after. The repo's own default branch is asked for by the query; the rest
// is the naming every repo that keeps such a branch uses, with the slash
// gitflow spells them with, since `release-notes-rewrite` is an ordinary
// feature branch and stacking on it has to keep working.
const TRUNK =
  /^(?:main|master|trunk|dev|develop|development|stage|staging|preprod|prod|production|qa|next)$/i;
function isTrunk(branch, defaultBranch) {
  const name = String(branch || '');
  if (defaultBranch && name.toLowerCase() === String(defaultBranch).toLowerCase()) return true;
  return TRUNK.test(name) || /^(?:release|hotfix)\//i.test(name);
}

// Stacked pull requests: a branch whose base is another open pull request's
// head. GitHub shows such a pull request as "2/3" in its own list, and the
// board wants the same: a row is much easier to read once it says it is the
// middle of a stack and cannot merge before the one under it.
//
// The walk covers every open pull request the board query returned, not just
// the author's, because a stack built on a teammate's branch is still a stack;
// the author filter is applied afterwards, to the rows. That query is bounded
// (`first`, newest first), so a stack can reach past the page, and since the
// order is by last push, the link that drops off is as likely to be the middle
// of the stack as its bottom, leaving two halves that do not know about each
// other. There is no numbering that survives that, so when the page was full
// every stack is marked `partial` and the chip stops claiming certainty.
//
// What comes out is a *tree*, not a chain: one entry per connected group of
// pull requests, listed depth-first from its root, each carrying the `depth`
// that put it there. Every row of one group therefore quotes the same `total`,
// the size of the whole stack, and `position` is how deep this row sits in
// it. Numbering the longest path through each row instead would let two rows
// of one stack disagree about how tall it is, and would leave a side branch's
// own children off the tooltip entirely.
//
// Only same-repo heads can be stacked on: a fork pull request's `headRefName`
// is a branch inside the fork, so treating it as a branch of this repo would
// make one `alice:main → main` pull request look like the base of every other
// open row. Such a pull request can still be the *top* of a stack, since its base is
// a branch of this repo; it just never becomes anyone's base here.
function stacksOf(nodes, defaultBranch, truncated = false) {
  const byHead = new Map(); // head branch -> pr
  for (const pr of nodes) {
    if (pr.isCrossRepository) continue;
    if (isTrunk(pr.headRefName, defaultBranch)) continue;
    // Two open pull requests may share a head branch. The lower number owns it;
    // any tie-break would do, as long as it is not the query's newest-first
    // order, which would move the chip from one row to the other whenever
    // somebody pushed.
    const held = byHead.get(pr.headRefName);
    if (!held || pr.number < held.number) byHead.set(pr.headRefName, pr);
  }

  // A pull request whose bases lead back to *itself* has no bottom and no top,
  // and any numbering of it would be a lie in both directions: GitHub shows no
  // stack there and neither does the board. Nor does a chain that merely passes
  // *through* a ring: folding the ring's members in would order them by
  // whichever link the walk reached last and call one of them the bottom, which
  // is the same lie one level up. So the ring is found first, and a stack that
  // runs into one stops there and says it is `partial`.
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

  // The one pull request this one sits on. A head kept out of `byHead` (a
  // fork's, a trunk, or one shadowed by a lower-numbered pull request on the
  // same branch) owns none of the children sitting on that branch name, so
  // going through `byHead` is what keeps a pull request out of two stacks at
  // once.
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
  // By number, not by however the newest-first query happened to order them:
  // two side branches would otherwise swap places in the tooltip every time
  // someone pushed to one of them.
  for (const list of childrenOf.values()) list.sort((a, b) => a.number - b.number);

  // Cutting the rings above leaves `parentOf` acyclic, but the two graphs are
  // built from different maps and an unguarded walk that met a loop would be a
  // stack overflow taking the whole board down rather than one chip.
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

  // Only what the tooltip prints: `stackChip` in public/developer.js is the one
  // consumer, and a `title=` attribute has nothing to do with a url or a branch
  // name. `draft` earns its place: a stack whose lower members are still
  // drafts cannot merge from the bottom up, and the tooltip is where that reads.
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
    // What the board can see is not always the whole stack: a page that ran out
    // of room may have dropped a link (the query is newest-first, so it is the
    // middle of a long-lived stack that goes first, which silently splits it in
    // two), and a stack standing on a ring was cut off at the ring. Either way
    // the numbering below is of what is on the board, not of the stack, and the
    // chip says so rather than reading as certain.
    const partial = truncated || tree.some(({ pr: p }) => cut.has(p.number));
    chains.set(
      root.number,
      tree.map(({ pr: p, depth }) => brief(p, depth)),
    );
    for (const { pr: p, depth } of tree) {
      placed.set(p.number, { position: depth, total: tree.length, id: root.number, partial });
    }
  }
  // The stacks themselves travel once, keyed by id, rather than a copy per row:
  // a repo where one branch carries the whole page would otherwise serialize
  // the chain N times over on a response the board polls every minute.
  return { chains, placed };
}

// The board's own read of the query, and the one thing it forgives: a token
// allowed the pull requests but not the issues.
//
// The token .env.example describes (fine-grained, Pull requests + Contents)
// has no say over issues, and GraphQL answers a field like that with an error
// *and* everything else it resolved. Letting that error out would mean the day
// this connection was added, an install that had been running for months lost
// its whole board over a tab it never asked for. So a failure that left the
// pull requests standing is kept, and travels to the browser as `issuesError`
// for the tab to explain itself with. Anything else (the repo gone, the token
// revoked, a rate limit) is the caller's to hear about, unchanged. So is a
// failure anywhere else in the query: GraphQL names the field each error came
// from, and one raised under `stackRefs` or a row's checks would leave the pull
// requests themselves half-read: cached half-read, and reported as nothing
// worse than a missing tab. Only a query whose every error is the issues' own
// is forgiven.
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
    // `repository` itself has to have resolved: with every error under the
    // issues, whatever else the page asked for is in there beside them, whether
    // that is the pull requests or, on a later page, nothing at all.
    const partial = e && e.data && e.data.repository;
    if (variables.skipIssues || !partial || !onlyIssuesFailed(e.errors)) throw e;
    return { data: e.data, issuesError: e.message };
  }
}

// Every open pull request of one project, newest first. The whole open list,
// not just the configured PR author's: the board filters by author and by label
// in the browser now, and narrowing here would leave those pickers with one
// name in them and no way to widen. The author still travels on the payload:
// it is what the board's author filter starts on, since whose work this
// dashboard exists to move along has not changed, only how hard the answer is
// to undo.
//
// With no author in it the cache key is now honestly just the repo: two
// projects pointing at one repo used to share whichever of their two boards
// was fetched first.
//
// The repo's open issues come back on the same payload, so the board's three tabs
// are served by this one call, so opening ⊙ Issues costs GitHub nothing. A token
// that may not read them costs the tab and nothing else: see boardQuery below.
export async function projectPulls(project, { fresh = false } = {}) {
  const cfg = getConfig();
  if (!cfg.githubToken)
    throw new Error('No GITHUB_TOKEN is configured, so the pull requests cannot be listed');
  const key = project.repo.toLowerCase();
  const hit = cache.get(key);
  if (!fresh && hit && Date.now() - hit.at < CACHE_MS) return hit.value;

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
  // Whichever list still has a page left asks for it; the other is skipped, so
  // a repo long in one and short in the other pays only for what is missing.
  for (;;) {
    const morePulls = !!(pullsPage && pullsPage.hasNextPage);
    // The open pull requests are walked to the end: that list is the board,
    // and a repo does not keep thousands of them open. The issues can be
    // thousands, and every page of them is a round trip the pull requests wait
    // behind, on a load that repeats every minute whether or not anybody opens
    // the tab. So they stop at ISSUE_PAGES and the tab says the list is cut,
    // the same bargain the stack walk's own page strikes.
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
    // A later page of issues failing where the first one did not: the tab keeps
    // what it has and says it is cut short, rather than the board failing over
    // the half of the query it is not for.
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

  // A label can sit beyond GraphQL's maximum connection page even though the
  // board treats each row's label list as complete for filtering and workflow
  // recommendations. Finish those uncommon long connections explicitly.
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

    // And the same for the issues it closes: the Issues tab reads this link
    // backwards to say which pull request is already answering an issue, so a
    // sixth reference left unread would put an issue on the tab as nobody's
    // work while a pull request was busy closing it.
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

  // And an issue's own labels, for the same reason the pull requests' are
  // finished: the Issues tab's label picker is built from these lists and
  // filters on them, so one that stopped short would leave a label out of the
  // picker and hide its own issue once another issue put that label there.
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

    // And the pull requests answering it, for an issue that more than five are
    // closing. The rows below name this repo's own whatever this connection
    // held, so what these pages are really for is the sixth pull request that
    // lives in another repository, invisible from this board any other way.
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

  // The walk's own page: wider than the rows, and every pull request on it,
  // including the ones no row is drawn for.
  const refs = repository.stackRefs || { nodes: [] };
  const defaultBranch = (repository.defaultBranchRef && repository.defaultBranchRef.name) || null;
  // More open pull requests than even that page holds: a stack may reach past it.
  const truncated = !!(refs.pageInfo && refs.pageInfo.hasNextPage);
  const { chains, placed } = stacksOf(refs.nodes || [], defaultBranch, truncated);
  const shown = new Set(); // the stacks the rows below actually reference
  const rows = nodes.map((pr) => {
    const labels = labelsOf(pr);
    // UNKNOWN is GitHub still computing the merge; it is not "conflicting",
    // and calling it that would recommend a merge turn for nothing.
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
      // null unless this pull request is part of a stack. `id` looks the
      // stack itself up in `stacks` on the payload.
      stack: stack || null,
    };
  });

  // Which open pull requests are already working on each issue. Each issue came
  // back carrying GitHub's own backward link, which is where a pull request in
  // another repository can be seen at all; the rows add this repo's own, read
  // off `closingIssuesReferences` rather than asked for again: the same link
  // from the other end, and complete where the backward one stops at five.
  // Only issues on the board can be pointed at: a pull request closing an issue
  // that is already closed has nothing here to attach to, which is right, since
  // that issue is not on this tab either.
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
      // A reference into another repository is not this list's #17, whatever it
      // is numbered. An older reference with no repository named at all is one
      // of this repo's own: the field is only ever missing from a payload
      // written before it was asked for.
      if (linked.repo && linked.repo.toLowerCase() !== here) continue;
      const issue = byNumber.get(linked.number);
      if (!issue) continue;
      // The backward link may already have named it; the two are one link.
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

  const value = {
    repo: project.repo,
    label: project.label,
    // Not a filter that was applied, but the one the board's author picker opens on.
    author: project.reviewAuthor || null,
    pulls: rows,
    // Every open issue of the repo, newest first, each naming the open pull
    // requests that say they close it.
    issues,
    // Why that list is empty when it is not the repo that is: the token could
    // not read the issues. The tab prints this rather than claiming there are
    // none, and the pull requests are unaffected.
    issuesError: issuesError || null,
    // The repo has more open issues than one board load walks. The tab says so
    // rather than passing the newest few hundred off as all of them.
    issuesTruncated,
    // Stack id -> every pull request in it, bottom first. Carried once beside
    // the rows: each row names its stack by id, so a tall stack costs the
    // payload one copy of itself rather than one per row on it.
    stacks: Object.fromEntries([...shown].map((id) => [id, chains.get(id) || []])),
    syncedAt: new Date().toISOString(),
  };
  cache.set(key, { at: Date.now(), value });
  return value;
}
