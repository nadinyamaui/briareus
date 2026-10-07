// @ts-check
// A GitHub Projects v2 board shaped like GitHub's board view: one column per value of
// the group-by field, with its items and number-field totals.
//
// The board is a project setting (`projectBoard`, lib/projects.js), not derived from
// the repo: a board belongs to an org or user and usually spans several repos.
import { getConfig } from './config.js';
import { githubGraphql } from './github.js';

const fail = (status, message) => Object.assign(new Error(message), { status });

// GraphQL takes no variable for a root field, so the owner type (settings restrict it
// to user/organization) is interpolated into the query text.
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

// Issue and PR `state` are different enums, which GraphQL refuses under one name in a
// selection; hence the aliases (as in lib/issueviewer.js).
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

// An unfiltered project can run to thousands of items; 2,000 cards is more than a board
// can show, and past that the answer is marked truncated.
const MAX_PAGES = 20;

// Short cache, as on the PR board: clients poll while the tab is open.
const cache = new Map(); // board key -> { at, value }
const CACHE_MS = 45_000;

const ITEM_TYPES = { ISSUE: 'issue', PULL_REQUEST: 'pull', DRAFT_ISSUE: 'draft', REDACTED: 'redacted' };
const lower = (value) => (value ? String(value).toLowerCase() : null);
const nodes = (conn) => (conn && conn.nodes) || [];

// ---------------------------------------------------------------------------
// the view's filter
// ---------------------------------------------------------------------------

// The filter's `name:value` qualifiers, unquoted: `-status:"Backlog",Done` is
// `{ negated: true, name: 'status', values: ['Backlog', 'Done'] }`. Free text is dropped.
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

// Which group-by columns the filter leaves. GitHub filters the items (see projectBoard)
// but that only empties excluded columns, so the group-by field's own qualifiers are
// read here to drop them, as GitHub's page does.
//
// Relative iteration selectors (`@current`, `@previous`, `@next`) are resolved as of
// `now`. Ones that cannot be (ranges, comparisons) are ignored: a column wrongly kept is
// merely empty, while one wrongly dropped hides cards.
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

// The iteration id a relative selector names as of `now`: null when there is none,
// undefined when it cannot be told.
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

// The column field: the view's group-by (board views use `verticalGroupByFields`, tables
// `groupByFields`) if it is single-select or iteration, since only those have an order
// of their own; otherwise Status.
export function groupField(view, fields) {
  const named = view && (nodes(view.verticalGroupByFields)[0] || nodes(view.groupByFields)[0]);
  const usable = (f) => f && (f.dataType === 'SINGLE_SELECT' || f.dataType === 'ITERATION');
  if (usable(named)) return named;
  return fields.find((f) => f.name === 'Status' && f.dataType === 'SINGLE_SELECT') || null;
}

// Empty columns in the field's order (options as listed, iterations by start date).
// The caller drops completed iterations that end up empty.
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

// The item's option or iteration id, or null for "No <field>".
function columnOf(item, field) {
  if (!field) return null;
  const v = nodes(item.fieldValues).find((n) => n && n.field && n.field.id === field.id);
  return (v && (v.optionId || v.iterationId)) || null;
}

const repoOf = (node) => (node && node.repository && node.repository.nameWithOwner) || null;

// One card. The issue type is not a project field but GitHub shows it like one, so it
// is added as `Type` unless the board already has such a field.
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

// Items into columns in GitHub's order, with every number field totalled on every
// column (zero included) so clients draw the same badges throughout.
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
  // "No <field>" and finished iterations only show when non-empty.
  const kept = columns.filter((c) => (c.id != null && !c.completed) || c.count > 0);
  return columnsShown(kept, field, filter, now).map(({ completed: _, ...c }) => c);
}

// ---------------------------------------------------------------------------
// reading
// ---------------------------------------------------------------------------

const projectKey = (b) => `${b.ownerType}/${b.owner}/${b.number}/`.toLowerCase();
const boardKey = (b) => `${projectKey(b)}${b.view || 0}`;

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

// The project's board, filtered and grouped as its GitHub view is.
//
// GitHub applies the view's filter via `ProjectV2.items(query:)`, which is faithful and
// far cheaper than fetching everything, so `unsupportedFilters` is always empty; it
// stays in the answer for clients.
//
// Projects v2 needs its own token permission (`read:project`), so a refusal is not a
// route failure (as in lib/issueviewer.js): the answer has no columns and
// `projectsError` holds GitHub's reason. Unknown project or view numbers look the same.
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
  // Refusals are not cached, so the next poll sees a fix on GitHub's side.
  if (!value.projectsError) cache.set(key, { at: Date.now(), value });
  return value;
}

// The board as a repo-scoped token may see it, since the read used the server's token:
// cards (and drafts) outside `repos` are dropped, outside parents unnamed, and counts
// and totals recomputed. `repos` null sees all. The shared cached value is not mutated.
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

// ---------------------------------------------------------------------------
// moving a card
// ---------------------------------------------------------------------------

// Everything a move needs in one read: project, group-by field, and the item's project
// and repository.
const moveQuery = (root) => `
  query($login: String!, $number: Int!, $view: Int!, $withView: Boolean!, $item: ID!) {
    owner: ${root}(login: $login) {
      projectV2(number: $number) {
        id
        view(number: $view) @include(if: $withView) {
          verticalGroupByFields(first: 1) { nodes { ...field } }
          groupByFields(first: 1) { nodes { ...field } }
        }
        fields(first: 50) { nodes { ...field } }
      }
    }
    item: node(id: $item) {
      ... on ProjectV2Item {
        id
        project { id }
        content {
          ... on Issue { repository { nameWithOwner } }
          ... on PullRequest { repository { nameWithOwner } }
        }
      }
    }
  }
  ${FIELD}
`;

const SET_VALUE = `
  mutation($project: ID!, $item: ID!, $field: ID!, $value: ProjectV2FieldValue!) {
    updateProjectV2ItemFieldValue(
      input: { projectId: $project, itemId: $item, fieldId: $field, value: $value }
    ) { projectV2Item { id } }
  }
`;

const CLEAR_VALUE = `
  mutation($project: ID!, $item: ID!, $field: ID!) {
    clearProjectV2ItemFieldValue(input: { projectId: $project, itemId: $item, fieldId: $field }) {
      projectV2Item { id }
    }
  }
`;

// Actionable GraphQL error types map to 403/404; anything else is a 502.
function moveRefused(e, doing) {
  if (!e || !e.errors) {
    if (e && e.rateLimited) return e;
    return fail(502, `GitHub refused ${doing}: ${(e && e.message) || 'no answer'}`);
  }
  const types = e.errors.map((x) => x && x.type);
  const status = types.some((t) => t === 'INSUFFICIENT_SCOPES' || t === 'FORBIDDEN')
    ? 403
    : types.includes('NOT_FOUND')
      ? 404
      : 502;
  return fail(status, `GitHub refused ${doing}: ${e.message}`);
}

// Move a card by setting the group-by field to the column's option or iteration, or
// clearing it (`columnId` null). Columns are resolved as GET /project-board does, so
// any drawn column is a valid target.
//
// A repo-scoped token may only move cards it can see, and gets a 404 otherwise.
// Writing needs Projects: write (classic `project`); a refusal is a 403.
export async function moveBoardItem(project, input, { repos = null } = {}) {
  const bad = (message) => fail(400, message);
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw bad('Expected a JSON object');
  const { itemId, columnId } = input;
  if (typeof itemId !== 'string' || !itemId.trim()) throw bad('Name the card to move in `itemId`');
  if (!('columnId' in input) || (columnId !== null && (typeof columnId !== 'string' || !columnId.trim())))
    throw bad('Name the column to move it to in `columnId`, or null for the “No …” column');
  const board = project && project.projectBoard;
  if (!board) throw fail(404, `${project ? project.repo : 'This project'} has no Projects board set up`);
  const cfg = getConfig();
  if (!cfg.githubToken) throw fail(503, 'No GITHUB_TOKEN is configured');

  const root = board.ownerType === 'user' ? 'user' : 'organization';
  let data;
  try {
    data = await githubGraphql(cfg, moveQuery(root), {
      login: board.owner,
      number: board.number,
      view: board.view || 0,
      withView: !!board.view,
      item: itemId,
    });
  } catch (e) {
    // Errors only on the `item` path mean the card is missing, not the board.
    const p = e && e.data && e.data.owner && e.data.owner.projectV2;
    if (!(p && e.errors && e.errors.every((x) => x && x.path && x.path[0] === 'item'))) {
      throw moveRefused(e, 'reading the project board');
    }
    data = e.data;
  }
  const p = data && data.owner && data.owner.projectV2;
  if (!p) throw fail(404, `GitHub has no project ${board.number} for ${board.owner}`);
  const item = data.item;
  const content = item && item.content;
  const repo = content && content.repository && content.repository.nameWithOwner;
  if (!item || !item.project || item.project.id !== p.id || (repos && !(repo && repos.includes(repo))))
    throw fail(404, 'No such card on this board');

  const field = groupField(board.view ? p.view : null, nodes(p.fields));
  if (!field) throw fail(422, 'This board has no Status field to move cards along');
  const columns = emptyColumns(field);
  const column = columns.find((c) => c.id === columnId);
  if (!column) throw fail(422, `No such column on this board's ${field.name} field`);

  const ids = { project: p.id, item: item.id, field: field.id };
  try {
    if (columnId === null) await githubGraphql(cfg, CLEAR_VALUE, ids);
    else {
      const value =
        field.dataType === 'ITERATION' ? { iterationId: columnId } : { singleSelectOptionId: columnId };
      await githubGraphql(cfg, SET_VALUE, { ...ids, value });
    }
  } catch (e) {
    throw moveRefused(e, 'moving the card');
  }
  // Drop every cached view of the project, not just this one.
  const prefix = projectKey(board);
  for (const key of cache.keys()) if (key.startsWith(prefix)) cache.delete(key);
  return { item: { id: item.id, columnId, column: column.name, field: field.name } };
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
