// @ts-check
// One issue read whole for a client that draws it like GitHub: the issue with its project
// fields, and its timeline a page at a time. Separate from the board's polling payload
// (lib/prboard.js).
import { getConfig } from './config.js';
import { githubGraphql } from './github.js';

// Both reads use `issueOrPullRequest` rather than `issue`: issues and pull requests share
// one number sequence, and asking for an issue by a PR's number answers "not found" when
// the right answer is the close route's 422.
//
// Projects v2 reads sit behind `$withProjects`, since they need a permission (Projects:
// read) the documented token may lack. See readIssue.
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

// The timeline kinds this route maps, GraphQL name to the REST timeline name a client
// sees. Asking GitHub for only these kinds, rather than filtering afterwards, keeps a
// page at 100 showable events instead of one with holes in it.
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

// Issue and pull request `state` are different enums, and GraphQL refuses one name with
// two types in a selection; hence the aliases.
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

// Whether every error sits under a Projects v2 read: what a token without Projects: read
// gets for a query that otherwise resolved.
const onlyProjectsFailed = (errors) =>
  Array.isArray(errors) &&
  errors.length > 0 &&
  errors.every(
    (err) => Array.isArray(err && err.path) && err.path.some((p) => p === 'projectItems' || p === 'project'),
  );

// One read of an issue (or what turned out to be a pull request), with project parts if
// the token may read them. Projects never fail the read: a fine-grained token's refusal
// comes back as an error beside resolved data, which is kept; a classic token missing
// `read:project` is refused outright, which costs a second read without project fields.
// Either way the refusal travels as `projectsError`. Any other failure also gets the
// retry, fails again, and that failure is what is reported.
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

// GitHub answers both an unknown number and an invisible repository with NOT_FOUND and
// no data.
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

// Anything else is an upstream failure: 502 with GitHub's words, a rate limit keeps its
// 429. A GraphQL error carries HTTP 200, which must not reach the client as a success.
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

// One project item: its board, its Status (every board has it and clients show it first)
// and the rest of its fields by name. The Title field repeats the issue title and is left
// out.
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

// The issue in full in one round trip (two when the token may not read projects).
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
  // A commit references an issue this way, so this carries the commit, not a `source`.
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

// One timeline node as a client gets it, or null for an unmapped kind (should GitHub ever
// send one; skipping beats failing the page).
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

// One page of the timeline, oldest first, 100 events a page, paged like the PR lists.
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
