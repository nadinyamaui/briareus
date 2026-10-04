// @ts-check
// A GitHub Projects v2 board, read whole and shaped for drawing: one column per
// value of the view's group-by field, each with its items and the totals of
// the board's number fields, the way GitHub draws a board view. Read-only:
// moving a card is GitHub's to do for now.
//
// The board is the project's own setting (`projectBoard` on lib/projects.js),
// not something derived from the repository: a Projects v2 board belongs to an
// organization or a user and usually spans several repositories.
import { getConfig } from './config.js';
import { githubGraphql } from './github.js';

const fail = (status, message) => Object.assign(new Error(message), { status });

// The root a board hangs off is chosen by the owner type, which the settings
// hold to these two words, so it is safe to put into the query text; GraphQL
// takes no variable for a root field.
const FIELD = `
  fragment field on ProjectV2FieldConfiguration {
    __typename
    ... on ProjectV2FieldCommon { id name dataType }
    ... on ProjectV2SingleSelectField { options { id name color } }
    ... on ProjectV2IterationField {
      configuration {
        iterations { id title startDate duration }
        completedIterations { id title startDate duration }
      }
    }
  }
`;

const metaQuery = (root) => `
  query($login: String!, $number: Int!, $view: Int!, $withView: Boolean!) {
    owner: ${root}(login: $login) {
      projectV2(number: $number) {
        title
        url
        view(number: $view) @include(if: $withView) {
          name
          number
          layout
          filter
          verticalGroupByFields(first: 1) { nodes { ...field } }
          groupByFields(first: 1) { nodes { ...field } }
        }
        fields(first: 50) { nodes { ...field } }
      }
    }
  }
  ${FIELD}
`;

// An issue and a pull request both answer `state`, with two different enums,
// and GraphQL refuses one name with two types in one selection; hence the
// aliases, as in lib/issueviewer.js.
const itemsQuery = (root) => `
  query($login: String!, $number: Int!, $query: String, $after: String) {
    owner: ${root}(login: $login) {
      projectV2(number: $number) {
        items(first: 100, after: $after, query: $query) {
          pageInfo { hasNextPage endCursor }
          nodes {
            id
            type
            isArchived
            content {
              __typename
              ... on Issue {
                number title url issueState: state createdAt
                author { login }
                repository { nameWithOwner }
                assignees(first: 10) { nodes { login avatarUrl } }
                labels(first: 20) { nodes { name color } }
                issueType { name color }
                parent { number title url repository { nameWithOwner } }
              }
              ... on PullRequest {
                number title url pullState: state createdAt
                author { login }
                repository { nameWithOwner }
                assignees(first: 10) { nodes { login avatarUrl } }
                labels(first: 20) { nodes { name color } }
              }
              ... on DraftIssue {
                title createdAt
                creator { login }
                assignees(first: 10) { nodes { login avatarUrl } }
              }
            }
            fieldValues(first: 50) {
              nodes {
                ... on ProjectV2ItemFieldSingleSelectValue { name optionId color field { ...fieldRef } }
                ... on ProjectV2ItemFieldTextValue { text field { ...fieldRef } }
                ... on ProjectV2ItemFieldNumberValue { number field { ...fieldRef } }
                ... on ProjectV2ItemFieldDateValue { date field { ...fieldRef } }
                ... on ProjectV2ItemFieldIterationValue { title iterationId field { ...fieldRef } }
              }
            }
          }
        }
      }
    }
  }
  fragment fieldRef on ProjectV2FieldConfiguration { ... on ProjectV2FieldCommon { id name } }
`;

// A board is a few hundred items once its view's filter is applied, but a
// project with no view named, or a view with no filter, is the whole project,
// which can run to thousands. Twenty pages is two thousand cards, more than a
// board can show; past that the answer says it was cut.
const MAX_PAGES = 20;

// The same short cache the pull request board keeps, for the same reason: a
// client polls while the tab is open, and a board does not move every few
// seconds.
const cache = new Map(); // board key -> { at, value }
const CACHE_MS = 45_000;

const ITEM_TYPES = { ISSUE: 'issue', PULL_REQUEST: 'pull', DRAFT_ISSUE: 'draft', REDACTED: 'redacted' };
const lower = (value) => (value ? String(value).toLowerCase() : null);
const nodes = (conn) => (conn && conn.nodes) || [];

// ---------------------------------------------------------------------------
// the view's filter
// ---------------------------------------------------------------------------

// The filter's `name:value` qualifiers, with their negation and their comma
// lists, quotes taken off: `-status:"Backlog",Done` is
// `{ negated: true, name: 'status', values: ['Backlog', 'Done'] }`. Free text
// and anything else that is not a qualifier is left out.
export function parseFilter(filter) {
  const out = [];
  const value = '(?:"[^"]*"|[^\\s,"]+)';
  const re = new RegExp(`(^|\\s)(-?)([A-Za-z0-9_-]+|"[^"]+"):(${value}(?:,${value})*)`, 'g');
  for (const m of String(filter || '').matchAll(re)) {
    out.push({
      negated: m[2] === '-',
      name: m[3].replace(/"/g, ''),
      values: [...m[4].matchAll(new RegExp(value, 'g'))].map((v) => v[0].replace(/"/g, '')),
    });
  }
  return out;
}

// GitHub writes a field with spaces in its name as the name hyphenated
// (`project-priority:high`), or quoted; both mean the same field.
const sameName = (qualifier, field) =>
  qualifier.toLowerCase().replace(/\s+/g, '-') === field.toLowerCase().replace(/\s+/g, '-');

// Which of the group-by field's columns the filter leaves on the board.
// GitHub applies the filter to the items itself (see projectBoard), which
// empties a column the filter excludes but does not remove it, so a board
// filtered `-status:Backlog` would still draw an empty Backlog column that
// GitHub's own page does not. A qualifier on the group-by field says which
// columns those are. Only the group-by field's own qualifiers are read here;
// every other part of the filter is GitHub's.
//
// An iteration field's relative selectors (`iteration:@current`, `@previous`,
// `@next`) name an iteration by date rather than by title, so they are worked
// out from the field's own iterations as of `now`. A selector that cannot be
// (a range, a comparison, an iteration with no duration) leaves its qualifier
// unread: GitHub has applied it to the items already, and a column wrongly
// kept is only an empty one, where one wrongly dropped hides cards.
export function columnsShown(columns, field, filter, now = Date.now()) {
  if (!field) return columns;
  const said = [];
  for (const q of parseFilter(filter)) {
    if (!sameName(q.name, field.name)) continue;
    const values = q.values.map((v) => {
      if (!/^@|[<>*]|\.\./.test(v)) return { name: v.toLowerCase() };
      const id = relativeIteration(field, v, now);
      return id === undefined ? undefined : { id };
    });
    if (values.every((v) => v !== undefined)) said.push({ negated: q.negated, values });
  }
  return columns.filter((column) => {
    if (column.id == null) return true;
    const name = column.name.toLowerCase();
    return said.every(
      (q) => q.values.some((v) => (v.id !== undefined ? v.id === column.id : v.name === name)) !== q.negated,
    );
  });
}

// The id of the iteration `@current`, `@previous` or `@next` names on an
// iteration field as of `now`, null when there is none (between iterations,
// say), or undefined when it cannot be told.
const DAY_MS = 86_400_000;
function relativeIteration(field, selector, now) {
  const which = selector.toLowerCase();
  if (field.dataType !== 'ITERATION' || !['@current', '@previous', '@next'].includes(which)) return undefined;
  const config = field.configuration || {};
  const all = [...(config.completedIterations || []), ...(config.iterations || [])].map((i) => {
    const start = Date.parse(i.startDate);
    return { id: i.id, start, end: start + Number(i.duration) * DAY_MS };
  });
  if (!all.length || all.some((i) => !Number.isFinite(i.end))) return undefined;
  all.sort((a, b) => a.start - b.start);
  // GitHub's iterations run whole days, from the start date's midnight UTC.
  const today = Date.parse(new Date(now).toISOString().slice(0, 10));
  let found;
  if (which === '@current') found = all.find((i) => i.start <= today && today < i.end);
  else if (which === '@next') found = all.find((i) => i.start > today);
  else found = all.filter((i) => i.end <= today).pop();
  return found ? found.id : null;
}

// ---------------------------------------------------------------------------
// shaping
// ---------------------------------------------------------------------------

// The field a board's columns come from: what the view groups by (a board view
// puts it in `verticalGroupByFields`, a table in `groupByFields`), or Status
// when the view names none or there is no view. Only a single-select or an
// iteration field makes columns with an order of their own; a view grouped by
// anything else (assignees, repository, …) is drawn by Status instead.
export function groupField(view, fields) {
  const named = view && (nodes(view.verticalGroupByFields)[0] || nodes(view.groupByFields)[0]);
  const usable = (f) => f && (f.dataType === 'SINGLE_SELECT' || f.dataType === 'ITERATION');
  if (usable(named)) return named;
  return fields.find((f) => f.name === 'Status' && f.dataType === 'SINGLE_SELECT') || null;
}

// The columns before any item is placed, in the field's own order: a
// single-select's options as Settings lists them, an iteration field's
// iterations by start date. A completed iteration only gets a column when
// something is still in it, which the caller decides once the items are in.
function emptyColumns(field) {
  if (!field) return [{ id: null, name: 'All items', color: null }];
  const none = { id: null, name: `No ${field.name}`, color: null };
  if (field.dataType === 'SINGLE_SELECT') {
    return [none, ...(field.options || []).map((o) => ({ id: o.id, name: o.name, color: o.color || null }))];
  }
  const config = field.configuration || {};
  const iterations = [
    ...(config.completedIterations || []).map((i) => ({ ...i, completed: true })),
    ...(config.iterations || []),
  ].sort((a, b) => String(a.startDate).localeCompare(String(b.startDate)));
  return [
    none,
    ...iterations.map((i) => ({ id: i.id, name: i.title, color: null, completed: !!i.completed })),
  ];
}

function cardFields(item, field) {
  const out = [];
  for (const v of nodes(item.fieldValues)) {
    const name = v && v.field && v.field.name;
    if (!name || name === 'Title' || (field && v.field.id === field.id)) continue;
    if (v.name != null) out.push({ name, value: v.name, color: v.color || null });
    else if (v.text != null) out.push({ name, value: v.text });
    else if (v.number != null) out.push({ name, value: v.number });
    else if (v.date != null) out.push({ name, value: v.date });
    else if (v.title != null) out.push({ name, value: v.title });
  }
  return out;
}

// The column an item belongs in: the option or iteration its group-by value
// names, or null for "No <field>".
function columnOf(item, field) {
  if (!field) return null;
  const v = nodes(item.fieldValues).find((n) => n && n.field && n.field.id === field.id);
  return (v && (v.optionId || v.iterationId)) || null;
}

const repoOf = (node) => (node && node.repository && node.repository.nameWithOwner) || null;

// One card. The issue's GitHub issue type (Bug, Feature, …) is not a project
// field but GitHub draws it beside them, so it travels among them as `Type`,
// unless the board has a field of that name already.
export function boardItem(item, field) {
  const c = item.content || {};
  const fields = cardFields(item, field);
  if (c.issueType && !fields.some((f) => f.name === 'Type')) {
    fields.push({ name: 'Type', value: c.issueType.name, color: c.issueType.color || null });
  }
  const who = c.author || c.creator;
  return {
    id: item.id,
    type: ITEM_TYPES[item.type] || lower(item.type),
    repo: repoOf(c),
    number: c.number ?? null,
    title: c.title ?? null,
    url: c.url || null,
    state: lower(c.issueState || c.pullState),
    createdAt: c.createdAt || null,
    author: (who && who.login) || null,
    assignees: nodes(c.assignees).map((a) => ({ login: a.login, avatarUrl: a.avatarUrl || null })),
    labels: nodes(c.labels).map((l) => ({ name: l.name, color: l.color })),
    parent: c.parent
      ? { repo: repoOf(c.parent), number: c.parent.number, title: c.parent.title, url: c.parent.url }
      : null,
    fields,
  };
}

// The items into their columns, in the order GitHub gave them (the board's own
// order), with every number field totalled per column whether or not anything
// in it is set, so a client draws the same badges on every column.
export function buildColumns(items, fields, field, filter = '', now = Date.now()) {
  const numberFields = fields.filter((f) => f.dataType === 'NUMBER').map((f) => f.name);
  const columns = emptyColumns(field).map((c) => ({
    ...c,
    count: 0,
    sums: Object.fromEntries(numberFields.map((n) => [n, 0])),
    items: [],
  }));
  const byId = new Map(columns.map((c) => [c.id, c]));
  for (const item of items) {
    if (!item || item.isArchived) continue;
    const column = byId.get(columnOf(item, field)) || byId.get(null);
    const card = boardItem(item, field);
    column.items.push(card);
    column.count++;
    for (const f of card.fields) if (f.name in column.sums) column.sums[f.name] += Number(f.value) || 0;
  }
  // "No <field>" and a finished iteration only earn a column by holding
  // something; GitHub's page does the same with the first by default.
  const kept = columns.filter((c) => (c.id != null && !c.completed) || c.count > 0);
  return columnsShown(kept, field, filter, now).map(({ completed: _, ...c }) => c);
}

// ---------------------------------------------------------------------------
// reading
// ---------------------------------------------------------------------------

const boardKey = (b) => `${b.ownerType}/${b.owner}/${b.number}/${b.view || 0}`.toLowerCase();

// Every item the filter lets through, a page at a time.
async function readItems(cfg, root, variables, query) {
  const items = [];
  let after = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const data = await githubGraphql(cfg, itemsQuery(root), { ...variables, query: query || null, after });
    const conn = data && data.owner && data.owner.projectV2 && data.owner.projectV2.items;
    if (!conn) break;
    items.push(...nodes(conn));
    if (!conn.pageInfo || !conn.pageInfo.hasNextPage) return { items, truncated: false };
    after = conn.pageInfo.endCursor;
  }
  return { items, truncated: !!after };
}

// The project's board, filtered and grouped the way its view is on GitHub.
//
// The filter is GitHub's to apply: `ProjectV2.items` takes the view's filter
// text as its `query` and answers with what the view shows, every qualifier
// included (`iteration:@current`, `-status:`, `repo:` lists, `no:`, …), which
// is both more faithful than parsing it here and far cheaper: the board this
// was built for is 110 items out of a project of 1,550. So no qualifier is
// ever left unapplied, and `unsupportedFilters` stays empty; it is in the
// answer so a client written against it need not change if that stops being
// true.
//
// Projects v2 needs a permission of its own (a classic token's `read:project`,
// or Projects: read on the owner for a fine-grained token or an App), which
// the token .env.example has long described does not carry. So, as in
// lib/issueviewer.js, GitHub refusing the read is not a failure of the route:
// the answer comes back with no columns and `projectsError` holding GitHub's
// reason. A project or view number GitHub cannot resolve is answered the same
// way, since GitHub does not tell that apart from one the token may not see.
export async function projectBoard(project, { fresh = false } = {}) {
  const board = project && project.projectBoard;
  if (!board) throw fail(404, `${project ? project.repo : 'This project'} has no Projects board set up`);
  const cfg = getConfig();
  if (!cfg.githubToken) throw fail(503, 'No GITHUB_TOKEN is configured');
  const key = boardKey(board);
  const hit = cache.get(key);
  if (!fresh && hit && Date.now() - hit.at < CACHE_MS) return hit.value;

  let value;
  try {
    value = await readBoard(cfg, board);
  } catch (e) {
    if (!e || !e.errors) {
      if (e && e.rateLimited) throw e;
      throw fail(502, `GitHub refused reading the project board: ${(e && e.message) || 'no answer'}`);
    }
    value = refused(e.message);
  }
  // A refusal is not cached: it is fixed on GitHub's side, and the next poll
  // should see the fix.
  if (!value.projectsError) cache.set(key, { at: Date.now(), value });
  return value;
}

// The board as a token held to some repositories may see it: a board spans
// several repositories, and the read above is the server's own token, so a
// card from a repository outside `repos` is left off (and a draft, which
// belongs to none), a parent outside them is not named, and each column's
// count and totals are those of what is left. `repos` null is a token that
// sees everything. The cached answer is shared and is not changed.
export function boardInScope(value, repos) {
  if (!repos || !value || !value.columns) return value;
  const inScope = (repo) => !!repo && repos.includes(repo);
  const columns = value.columns.map((column) => {
    const items = column.items
      .filter((card) => inScope(card.repo))
      .map((card) => (card.parent && !inScope(card.parent.repo) ? { ...card, parent: null } : card));
    const sums = Object.fromEntries(Object.keys(column.sums).map((n) => [n, 0]));
    for (const card of items)
      for (const f of card.fields) if (f.name in sums) sums[f.name] += Number(f.value) || 0;
    return { ...column, count: items.length, sums, items };
  });
  // "No <field>" only earns a column by holding something (buildColumns).
  return { ...value, columns: columns.filter((c) => c.id != null || c.count > 0) };
}

const refused = (projectsError) => ({
  project: null,
  view: null,
  groupBy: null,
  columns: [],
  truncated: false,
  unsupportedFilters: [],
  projectsError,
});

async function readBoard(cfg, board) {
  const root = board.ownerType === 'user' ? 'user' : 'organization';
  const variables = { login: board.owner, number: board.number };
  const meta = await githubGraphql(cfg, metaQuery(root), {
    ...variables,
    view: board.view || 0,
    withView: !!board.view,
  });
  const p = meta && meta.owner && meta.owner.projectV2;
  if (!p) return refused(`GitHub has no project ${board.number} for ${board.owner}`);
  const view = board.view ? p.view : null;
  const fields = nodes(p.fields);
  const field = groupField(view, fields);
  const filter = (view && view.filter) || '';
  const { items, truncated } = await readItems(cfg, root, variables, filter);
  return {
    project: { title: p.title, url: p.url },
    view: view
      ? { name: view.name, number: view.number, filter, url: `${p.url}/views/${view.number}` }
      : null,
    groupBy: field ? field.name : null,
    columns: buildColumns(items, fields, field, filter),
    truncated,
    unsupportedFilters: [],
    projectsError: null,
  };
}
