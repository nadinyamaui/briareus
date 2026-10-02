// @ts-check
// One issue read whole, for a client that draws it the way GitHub does: the
// issue with its project fields, and its timeline a page at a time. Separate
// from the board's polling payload (lib/prboard.js), which carries one row per
// open issue and nothing a row does not show.
import { getConfig } from './config.js';
import { githubGraphql } from './github.js';

// Both reads go through `issueOrPullRequest` rather than `issue`: GitHub numbers
// issues and pull requests from one sequence, and asking for an issue by a pull
// request's number would come back as "not found", which is not what happened.
// Knowing it is a pull request is what lets the answer be the 422 the close
// route gives.
//
// Whatever reads a Projects v2 board sits behind `$withProjects`: it is the
// one part of either query that needs a permission the token .env.example
// describes may not carry (Projects: read). See readIssue below.
const ISSUE_QUERY = `
  query($owner: String!, $name: String!, $number: Int!, $withProjects: Boolean!) {
    repository(owner: $owner, name: $name) {
      issueOrPullRequest(number: $number) {
        __typename
        ... on Issue {
          number
          title
          url
          state
          stateReason(enableDuplicate: true)
          body
          author { login avatarUrl }
          # GitHub allows ten assignees at most, so this page cannot truncate.
          assignees(first: 10) { nodes { login } }
          labels(first: 100) { nodes { name color } }
          milestone { title }
          comments { totalCount }
          createdAt
          updatedAt
          closedAt
          issueType { name }
          parent { number title state url repository { nameWithOwner } }
          subIssuesSummary { total completed }
          subIssues(first: 100) { nodes { number title state url repository { nameWithOwner } } }
          # Closed pull requests too: the Development box on GitHub keeps a pull
          # request that was closed unmerged, and so does this.
          closedByPullRequestsReferences(first: 25, includeClosedPrs: true) {
            nodes { number title state url isDraft repository { nameWithOwner } }
          }
          projectItems(first: 20) @include(if: $withProjects) {
            nodes {
              project { title url }
              fieldValues(first: 50) {
                nodes {
                  ... on ProjectV2ItemFieldSingleSelectValue { name field { ...fieldName } }
                  ... on ProjectV2ItemFieldTextValue { text field { ...fieldName } }
                  ... on ProjectV2ItemFieldNumberValue { number field { ...fieldName } }
                  ... on ProjectV2ItemFieldDateValue { date field { ...fieldName } }
                  ... on ProjectV2ItemFieldIterationValue { title field { ...fieldName } }
                }
              }
            }
          }
        }
      }
    }
  }
  fragment fieldName on ProjectV2FieldConfiguration { ... on ProjectV2FieldCommon { name } }
`;

// The timeline kinds this route maps, by GitHub's GraphQL name and the name a
// client is handed, which is the REST timeline's (`commented`, `labeled`, …),
// the one GitHub documents. Asking GitHub for these kinds only, rather than
// filtering afterwards, is what keeps a page at 100 events a client can show:
// a filtered page would come back with holes the size of the subscriptions
// and mentions in it.
export const TIMELINE_KINDS = {
  IssueComment: ['ISSUE_COMMENT', 'commented'],
  LabeledEvent: ['LABELED_EVENT', 'labeled'],
  UnlabeledEvent: ['UNLABELED_EVENT', 'unlabeled'],
  AssignedEvent: ['ASSIGNED_EVENT', 'assigned'],
  UnassignedEvent: ['UNASSIGNED_EVENT', 'unassigned'],
  MilestonedEvent: ['MILESTONED_EVENT', 'milestoned'],
  DemilestonedEvent: ['DEMILESTONED_EVENT', 'demilestoned'],
  RenamedTitleEvent: ['RENAMED_TITLE_EVENT', 'renamed'],
  ClosedEvent: ['CLOSED_EVENT', 'closed'],
  ReopenedEvent: ['REOPENED_EVENT', 'reopened'],
  CrossReferencedEvent: ['CROSS_REFERENCED_EVENT', 'cross-referenced'],
  ReferencedEvent: ['REFERENCED_EVENT', 'referenced'],
  ConnectedEvent: ['CONNECTED_EVENT', 'connected'],
  DisconnectedEvent: ['DISCONNECTED_EVENT', 'disconnected'],
  ParentIssueAddedEvent: ['PARENT_ISSUE_ADDED_EVENT', 'parent_issue_added'],
  ParentIssueRemovedEvent: ['PARENT_ISSUE_REMOVED_EVENT', 'parent_issue_removed'],
  SubIssueAddedEvent: ['SUB_ISSUE_ADDED_EVENT', 'sub_issue_added'],
  SubIssueRemovedEvent: ['SUB_ISSUE_REMOVED_EVENT', 'sub_issue_removed'],
  IssueTypeAddedEvent: ['ISSUE_TYPE_ADDED_EVENT', 'issue_type_added'],
  IssueTypeChangedEvent: ['ISSUE_TYPE_CHANGED_EVENT', 'issue_type_changed'],
  IssueTypeRemovedEvent: ['ISSUE_TYPE_REMOVED_EVENT', 'issue_type_removed'],
  AddedToProjectV2Event: ['ADDED_TO_PROJECT_V2_EVENT', 'added_to_project_v2'],
  RemovedFromProjectV2Event: ['REMOVED_FROM_PROJECT_V2_EVENT', 'removed_from_project_v2'],
  ProjectV2ItemStatusChangedEvent: ['PROJECT_V2_ITEM_STATUS_CHANGED_EVENT', 'project_v2_item_status_changed'],
};

// An issue and a pull request both answer `state`, with two different enums,
// and GraphQL refuses one name with two types in one selection; hence the
// aliases.
const SUBJECT = `
  __typename
  ... on Issue { number title url issueState: state repository { nameWithOwner } }
  ... on PullRequest { number title url pullState: state repository { nameWithOwner } }
`;
const ISSUE_BRIEF = 'number title url repository { nameWithOwner }';

const TIMELINE_QUERY = `
  query($owner: String!, $name: String!, $number: Int!, $skip: Int!, $withProjects: Boolean!, $kinds: [IssueTimelineItemsItemType!]) {
    repository(owner: $owner, name: $name) {
      issueOrPullRequest(number: $number) {
        __typename
        ... on Issue {
          number
          title
          url
          state
          timelineItems(first: 100, skip: $skip, itemTypes: $kinds) {
            pageInfo { hasNextPage }
            nodes {
              __typename
              ... on Node { id }
              ... on IssueComment {
                author { login avatarUrl }
                createdAt updatedAt body url authorAssociation
              }
              ... on LabeledEvent { actor { ...who } createdAt label { name color } }
              ... on UnlabeledEvent { actor { ...who } createdAt label { name color } }
              ... on AssignedEvent { actor { ...who } createdAt assignee { ... on Actor { login } } }
              ... on UnassignedEvent { actor { ...who } createdAt assignee { ... on Actor { login } } }
              ... on MilestonedEvent { actor { ...who } createdAt milestoneTitle }
              ... on DemilestonedEvent { actor { ...who } createdAt milestoneTitle }
              ... on RenamedTitleEvent { actor { ...who } createdAt previousTitle currentTitle }
              ... on ClosedEvent { actor { ...who } createdAt stateReason }
              ... on ReopenedEvent { actor { ...who } createdAt stateReason }
              ... on CrossReferencedEvent { actor { ...who } createdAt source { ${SUBJECT} } }
              ... on ConnectedEvent { actor { ...who } createdAt source { ${SUBJECT} } }
              ... on DisconnectedEvent { actor { ...who } createdAt source { ${SUBJECT} } }
              ... on ReferencedEvent {
                actor { ...who } createdAt
                commit { oid messageHeadline url }
                commitRepository { nameWithOwner }
              }
              ... on ParentIssueAddedEvent { actor { ...who } createdAt parent { ${ISSUE_BRIEF} } }
              ... on ParentIssueRemovedEvent { actor { ...who } createdAt parent { ${ISSUE_BRIEF} } }
              ... on SubIssueAddedEvent { actor { ...who } createdAt subIssue { ${ISSUE_BRIEF} } }
              ... on SubIssueRemovedEvent { actor { ...who } createdAt subIssue { ${ISSUE_BRIEF} } }
              ... on IssueTypeAddedEvent { actor { ...who } createdAt issueType { name } }
              ... on IssueTypeChangedEvent { actor { ...who } createdAt issueType { name } prevIssueType { name } }
              ... on IssueTypeRemovedEvent { actor { ...who } createdAt issueType { name } }
              ... on AddedToProjectV2Event {
                actor { ...who } createdAt
                project @include(if: $withProjects) { title }
              }
              ... on RemovedFromProjectV2Event {
                actor { ...who } createdAt
                project @include(if: $withProjects) { title }
              }
              ... on ProjectV2ItemStatusChangedEvent {
                actor { ...who } createdAt status previousStatus
                project @include(if: $withProjects) { title }
              }
            }
          }
        }
      }
    }
  }
  fragment who on Actor { login avatarUrl }
`;

const fail = (status, message) => Object.assign(new Error(message), { status });
const lower = (value) => (value ? String(value).toLowerCase() : null);
const repoOf = (node) => (node && node.repository && node.repository.nameWithOwner) || null;
const brief = (i) => ({
  number: i.number,
  title: i.title,
  state: lower(i.state),
  url: i.url,
  repo: repoOf(i),
});

// Whether every error GitHub gave sits under a Projects v2 read, which is
// what a token without Projects: read gets for a query that otherwise
// resolved: the error and the rest of the answer beside it.
const onlyProjectsFailed = (errors) =>
  Array.isArray(errors) &&
  errors.length > 0 &&
  errors.every(
    (err) => Array.isArray(err && err.path) && err.path.some((p) => p === 'projectItems' || p === 'project'),
  );

// One read of an issue (or of what turned out to be a pull request), with the
// project parts if GitHub lets the token have them and without them if not.
//
// Projects v2 data is the one thing in these reads that needs a permission of
// its own, and the token .env.example has described for months does not
// carry it. So the reads never fail over it, the same way the board never
// fails over issues: GitHub answers a fine-grained token's refusal with an
// error under the project field and everything else resolved, which is kept
// as is; a classic token missing `read:project` is refused before anything
// resolves, which costs a second read without the project fields. Either way
// the refusal travels as `projectsError` for the client to explain.
//
// That second read is also what a failure for any other reason gets, and it
// then fails the same way again, which is what is reported: a retry that went
// through says the project fields were what GitHub would not answer.
async function readIssue(cfg, query, variables, doing) {
  const ask = (withProjects) => githubGraphql(cfg, query, { ...variables, withProjects });
  let data;
  let projectsError = null;
  try {
    data = await ask(true);
  } catch (e) {
    if (!e || !e.errors) throw unreachable(e, doing);
    notFound(e.errors, variables);
    if (e.data && e.data.repository && e.data.repository.issueOrPullRequest && onlyProjectsFailed(e.errors)) {
      data = e.data;
    } else {
      try {
        data = await ask(false);
      } catch (again) {
        if (again && again.errors) notFound(again.errors, variables);
        throw unreachable(again, doing);
      }
    }
    projectsError = e.message;
  }
  const node = data && data.repository && data.repository.issueOrPullRequest;
  if (!node)
    throw fail(404, `There is no issue #${variables.number} in ${variables.owner}/${variables.name}`);
  if (node.__typename === 'PullRequest')
    throw fail(422, `#${variables.number} is a pull request, not an issue`);
  return { node, projectsError };
}

// GitHub answers a number that is neither an issue nor a pull request, and a
// repository the token cannot see, with a NOT_FOUND error and no data.
function notFound(errors, { owner, name, number }) {
  const missing = errors.find((err) => err && err.type === 'NOT_FOUND');
  if (!missing) return;
  const repoMissing = Array.isArray(missing.path) && missing.path.length === 1;
  throw fail(
    404,
    repoMissing
      ? `GitHub has no repository ${owner}/${name}`
      : `There is no issue #${number} in ${owner}/${name}`,
  );
}

// Anything else GitHub refused is a failure upstream, not the client's, so it
// goes out as 502 with GitHub's own words; a rate limit keeps its 429. A
// GraphQL error carries the HTTP status it came with, which is 200 for a
// query that ran and failed, and must not reach the client as a success.
function unreachable(e, doing) {
  if (e && e.rateLimited) return e;
  return fail(502, `GitHub refused ${doing}: ${(e && e.message) || 'no answer'}`);
}

function setup(project, number) {
  if (!Number.isInteger(number) || number < 1) throw fail(400, 'The issue number must be a whole number');
  const cfg = getConfig();
  if (!cfg.githubToken) throw fail(503, 'No GITHUB_TOKEN is configured');
  const [owner, name] = project.repo.split('/');
  return { cfg, owner, name };
}

// One project item: the board it is on, its Status, and the rest of its
// fields by name. Status travels on its own because it is the one field every
// board has and a client shows first; the Title field is the issue's own title
// again and is left out.
function projectItem(item) {
  const fields = [];
  let status = null;
  for (const v of (item.fieldValues && item.fieldValues.nodes) || []) {
    const name = v && v.field && v.field.name;
    if (!name || name === 'Title') continue;
    const value = v.name ?? v.text ?? v.number ?? v.date ?? v.title ?? null;
    if (value == null) continue;
    if (name === 'Status') status = String(value);
    else fields.push({ name, value });
  }
  return {
    title: (item.project && item.project.title) || '',
    url: (item.project && item.project.url) || null,
    status,
    fields,
  };
}

// The issue in full, in one round trip (two when the token may not read
// projects; see readIssue).
export async function issueView(project, number) {
  const { cfg, owner, name } = setup(project, number);
  const { node: i, projectsError } = await readIssue(
    cfg,
    ISSUE_QUERY,
    { owner, name, number },
    'reading the issue',
  );
  const summary = i.subIssuesSummary || { total: 0, completed: 0 };
  return {
    issue: {
      number: i.number,
      title: i.title,
      url: i.url,
      state: lower(i.state),
      stateReason: lower(i.stateReason),
      body: i.body || '',
      author: (i.author && i.author.login) || null,
      authorAvatar: (i.author && i.author.avatarUrl) || null,
      assignees: ((i.assignees && i.assignees.nodes) || []).map((a) => a.login),
      labels: ((i.labels && i.labels.nodes) || []).map((l) => ({ name: l.name, color: l.color })),
      milestone: (i.milestone && i.milestone.title) || null,
      comments: (i.comments && i.comments.totalCount) || 0,
      createdAt: i.createdAt,
      updatedAt: i.updatedAt,
      closedAt: i.closedAt || null,
      type: (i.issueType && i.issueType.name) || null,
      parent: i.parent ? brief(i.parent) : null,
      subIssues: {
        total: summary.total || 0,
        completed: summary.completed || 0,
        items: ((i.subIssues && i.subIssues.nodes) || []).map(brief),
      },
      pulls: ((i.closedByPullRequestsReferences && i.closedByPullRequestsReferences.nodes) || []).map(
        (p) => ({ ...brief(p), draft: !!p.isDraft }),
      ),
      projects: projectsError ? [] : ((i.projectItems && i.projectItems.nodes) || []).map(projectItem),
      ...(projectsError ? { projectsError } : {}),
    },
  };
}

const subject = (s) =>
  s && s.number != null
    ? {
        kind: s.__typename === 'PullRequest' ? 'pull' : 'issue',
        number: s.number,
        title: s.title,
        state: lower(s.issueState || s.pullState),
        url: s.url,
        repo: repoOf(s),
      }
    : null;
const issueBrief = (i) => (i ? { number: i.number, title: i.title, url: i.url, repo: repoOf(i) } : null);
const projectTitle = (e) => (e.project && e.project.title) || null;

// What each kind adds to the fields every event has.
const DETAIL = {
  commented: (e) => ({
    body: e.body || '',
    url: e.url,
    updatedAt: e.updatedAt,
    authorAssociation: e.authorAssociation || null,
  }),
  labeled: (e) => ({ label: e.label ? { name: e.label.name, color: e.label.color } : null }),
  assigned: (e) => ({ assignee: (e.assignee && e.assignee.login) || null }),
  milestoned: (e) => ({ milestone: e.milestoneTitle || null }),
  renamed: (e) => ({ from: e.previousTitle, to: e.currentTitle }),
  closed: (e) => ({ stateReason: lower(e.stateReason) }),
  'cross-referenced': (e) => ({ source: subject(e.source) }),
  // A commit is what references an issue this way, not an issue or a pull
  // request, so this one carries the commit rather than a `source`.
  referenced: (e) => ({
    commit: e.commit
      ? {
          sha: e.commit.oid,
          message: e.commit.messageHeadline || '',
          url: e.commit.url,
          repo: repoOf({ repository: e.commitRepository }),
        }
      : null,
  }),
  parent_issue_added: (e) => ({ issue: issueBrief(e.parent) }),
  sub_issue_added: (e) => ({ issue: issueBrief(e.subIssue) }),
  issue_type_added: (e) => ({ type: (e.issueType && e.issueType.name) || null }),
  issue_type_changed: (e) => ({
    type: (e.issueType && e.issueType.name) || null,
    previousType: (e.prevIssueType && e.prevIssueType.name) || null,
  }),
  added_to_project_v2: (e) => ({ project: projectTitle(e) }),
  project_v2_item_status_changed: (e) => ({
    project: projectTitle(e),
    status: e.status || null,
    previousStatus: e.previousStatus || null,
  }),
};
// The other half of each pair reads the same fields.
Object.assign(DETAIL, {
  unlabeled: DETAIL.labeled,
  unassigned: DETAIL.assigned,
  demilestoned: DETAIL.milestoned,
  reopened: DETAIL.closed,
  connected: DETAIL['cross-referenced'],
  disconnected: DETAIL['cross-referenced'],
  parent_issue_removed: DETAIL.parent_issue_added,
  sub_issue_removed: DETAIL.sub_issue_added,
  issue_type_removed: DETAIL.issue_type_added,
  removed_from_project_v2: DETAIL.added_to_project_v2,
});

// One timeline node as a client gets it, or null for a kind not mapped here
// (GitHub only sends those if it starts answering with types the filter did
// not ask for; skipping one beats failing the page).
export function timelineEvent(node) {
  const known = node && TIMELINE_KINDS[node.__typename];
  if (!known) return null;
  const kind = known[1];
  const who = node.author || node.actor;
  return {
    id: node.id,
    kind,
    actor: (who && who.login) || null,
    actorAvatar: (who && who.avatarUrl) || null,
    createdAt: node.createdAt,
    ...DETAIL[kind](node),
  };
}

// One page of the issue's timeline, oldest first, 100 events to the page and
// paged the way the pull request lists are (1–30).
export async function issueTimeline(project, number, { page = 1 } = {}) {
  if (!Number.isInteger(page) || page < 1 || page > 30) throw fail(400, 'Invalid page');
  const { cfg, owner, name } = setup(project, number);
  const kinds = Object.values(TIMELINE_KINDS).map(([type]) => type);
  const { node: i, projectsError } = await readIssue(
    cfg,
    TIMELINE_QUERY,
    { owner, name, number, skip: (page - 1) * 100, kinds },
    'reading the issue timeline',
  );
  const items = i.timelineItems || { nodes: [], pageInfo: {} };
  return {
    issue: { number: i.number, title: i.title, state: lower(i.state), url: i.url },
    events: (items.nodes || []).map(timelineEvent).filter(Boolean),
    nextPage: items.pageInfo && items.pageInfo.hasNextPage && page < 30 ? page + 1 : null,
    ...(projectsError ? { projectsError } : {}),
  };
}
