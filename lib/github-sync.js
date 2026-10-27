// @ts-check
import { getConfig } from './config.js';
import { activeProjects } from './projects.js';
import { githubRest, githubGraphql } from './github.js';
import { githubStore } from './github-store.js';
import { fetchProjectPulls, invalidateBoard, restCheckRun, restCommitStatus, reviewsOf } from './prboard.js';

export const GITHUB_SYNC_INTERVAL_MS = 60 * 60 * 1000;
const RELATIONS_QUERY = `query($owner: String!, $name: String!, $number: Int!,
  $childCursor: String, $pullCursor: String, $children: Boolean!, $pulls: Boolean!) {
  repository(owner: $owner, name: $name) {
    issueOrPullRequest(number: $number) {
      __typename
      ... on Issue {
        parent { number title url state repository { nameWithOwner } }
        subIssuesSummary { total completed }
        subIssues(first: 100, after: $childCursor) @include(if: $children) {
          pageInfo { hasNextPage endCursor }
          nodes { number title url state repository { nameWithOwner } }
        }
        closedByPullRequestsReferences(first: 100, after: $pullCursor, includeClosedPrs: true) @include(if: $pulls) {
          pageInfo { hasNextPage endCursor }
          nodes { number title url state isDraft repository { nameWithOwner } }
        }
      }
      ... on PullRequest {
        closingIssuesReferences(first: 100, after: $pullCursor) @include(if: $pulls) {
          pageInfo { hasNextPage endCursor }
          nodes { number title url state stateReason repository { nameWithOwner } }
        }
      }
    }
  }
}`;
const EVENTS = new Set([
  'issues',
  'issue_comment',
  'pull_request',
  'pull_request_review',
  'pull_request_review_comment',
  'check_run',
  'check_suite',
  'status',
  'push',
  'label',
  'milestone',
  'sub_issues',
]);

export function githubItemRow(issue, pull = null) {
  const raw = pull || issue;
  const row = {
    kind: pull || issue.pull_request ? 'pull' : 'issue',
    number: issue.number,
    title: raw.title,
    url: raw.html_url,
    body: raw.body || '',
    state: pull?.merged_at ? 'merged' : raw.state,
    stateReason: raw.state_reason || null,
    author: raw.user?.login || null,
    authorAvatar: raw.user?.avatar_url || null,
    assignees: (raw.assignees || []).map((a) => a.login),
    labels: (raw.labels || []).map((l) => ({ id: l.id, name: l.name, color: l.color || '' })),
    milestone: raw.milestone?.title || null,
    milestoneId: raw.milestone?.id,
    comments: raw.comments || 0,
    type: raw.type?.name || null,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
    closedAt: raw.closed_at || null,
  };
  if (!pull) return row;
  return {
    ...row,
    draft: !!pull.draft,
    branch: pull.head?.ref || null,
    baseBranch: pull.base?.ref || null,
    headSha: pull.head?.sha || null,
    baseSha: pull.base?.sha || null,
    crossRepository: !!(pull.head?.repo && pull.base?.repo && pull.head.repo.id !== pull.base.repo.id),
    mergeable: pull.mergeable == null ? 'unknown' : pull.mergeable ? 'mergeable' : 'conflicting',
    additions: pull.additions,
    deletions: pull.deletions,
    changedFiles: pull.changed_files,
    commits: pull.commits,
    mergedAt: pull.merged_at || null,
  };
}

// One queue per repository orders hourly work and webhook refreshes. Fetching
// authoritative data also makes duplicate/out-of-order deliveries harmless.
export function createGithubSync({
  projects = activeProjects,
  config = getConfig,
  rest = githubRest,
  graphql = (cfg, query, variables) => githubGraphql(cfg, query, variables),
  store = githubStore,
  board = fetchProjectPulls,
  invalidate = (repo) => invalidateBoard(repo, { refresh: false }),
  log = (message) => console.error(`github-sync: ${message}`),
  now = Date.now,
} = {}) {
  const queues = new Map();
  const pending = new Map();
  let timer = null;
  let running = null;
  let stopped = false;

  async function read(path) {
    const res = await rest(config(), 'GET', path);
    if (!res.ok)
      throw Object.assign(new Error(`GitHub answered ${res.status} reading ${path.split('?')[0]}`), {
        status: res.status,
      });
    return res.json();
  }

  async function pages(path, field = null) {
    const rows = [];
    for (let page = 1; ; page++) {
      const body = await read(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
      const batch = field ? body[field] : body;
      if (!Array.isArray(batch)) throw new Error(`GitHub returned an incomplete list for ${path}`);
      rows.push(...batch);
      if (batch.length < 100) return rows;
    }
  }

  // Plain 403s are missing enrichment permissions; rate limits are thrown by
  // githubRest as 429 and must still abort without publishing partial lists.
  async function optional(read) {
    try {
      return await read();
    } catch (e) {
      if (e.status !== 403) throw e;
      return undefined;
    }
  }

  async function refreshItem(project, number, supplied = null, observedAt = now()) {
    const root = `/repos/${project.repo}`;
    let issue, pull;
    try {
      issue = supplied || (await optional(() => read(`${root}/issues/${number}`)));
    } catch (e) {
      // Deleted/transferred issues are no longer members of this repository.
      if (e.status === 404 || e.status === 410) return store.hideItem(project.repo, number, observedAt);
      throw e;
    }
    if (!issue) {
      // The token may read PRs while Issues is disabled. A failed PR lookup in
      // this case says nothing about an existing issue's board membership.
      try {
        pull = await read(`${root}/pulls/${number}`);
      } catch (e) {
        if (e.status === 404 || e.status === 410) return;
        throw e;
      }
      issue = pull;
    } else pull = issue.pull_request ? await read(`${root}/pulls/${number}`) : null;
    /** @type {any} */
    const row = { ...githubItemRow(issue, pull), observedAt, sourceUpdatedAt: issue.updated_at };
    try {
      Object.assign(row, await relations(project, number, !!pull));
    } catch (e) {
      if (
        !pull ||
        (e.status !== 403 && (!e.errors?.length || !e.errors.every((error) => error.type === 'FORBIDDEN')))
      )
        throw e;
      // Closing issue references require the optional Issues permission.
    }
    /** @type {any} */
    const collections = {};
    const comments = await optional(() => pages(`${root}/issues/${number}/comments`));
    if (comments !== undefined) collections.comments = comments;
    if (pull) {
      collections.reviews = await pages(`${root}/pulls/${number}/reviews`);
      collections.reviewComments = await pages(`${root}/pulls/${number}/comments`);
      collections.commits = await pages(`${root}/pulls/${number}/commits`);
      collections.files = await pages(`${root}/pulls/${number}/files`);
      if (row.headSha) {
        const checks = await optional(() => pages(`${root}/commits/${row.headSha}/check-runs`, 'check_runs'));
        const statuses = await optional(() => pages(`${root}/commits/${row.headSha}/statuses`));
        // Commit statuses are an append-only history. Keep the latest per context.
        const latest = [...new Map((statuses || []).toReversed().map((s) => [s.context, s])).values()];
        // An unreadable check-run list must not erase the previous collection
        // or claim overall success based only on commit statuses.
        if (checks !== undefined && statuses !== undefined) collections.checks = [...checks, ...latest];
        const runs = [...(checks || []).map(restCheckRun), ...latest.map(restCommitStatus)];
        if (checks !== undefined && statuses !== undefined)
          row.checks = runs.some((r) => ['failure', 'timed_out', 'action_required'].includes(r.conclusion))
            ? 'failure'
            : runs.some((r) => r.status !== 'completed')
              ? 'pending'
              : runs.length
                ? 'success'
                : null;
      }
      row.reviewers = reviewsOf({
        reviews: {
          nodes: collections.reviews.map((r) => ({
            author: r.user,
            state: r.state,
            url: r.html_url,
          })),
        },
      });
      for (const r of pull.requested_reviewers || []) {
        row.reviewers = row.reviewers.filter((v) => v.user.toLowerCase() !== r.login.toLowerCase());
        row.reviewers.push({ user: r.login, state: 'requested', url: null });
      }
      // The paginated REST lists are not a snapshot: a push or retarget while
      // downloading must not publish files/reviews under the wrong revision.
      const current = await read(`${root}/pulls/${number}`);
      if (
        current.head?.sha !== pull.head?.sha ||
        current.base?.sha !== pull.base?.sha ||
        current.updated_at !== pull.updated_at
      )
        throw new Error(`Pull request #${number} changed during synchronization; retry required`);
    }
    const saved = await store.saveItem(project.repo, row, collections);
    if (saved === false) throw new Error(`Item #${number} changed during synchronization; retry required`);
  }

  async function relations(project, number, isPull) {
    const [owner, name] = project.repo.split('/');
    const links = [],
      children = [];
    let childCursor = null,
      pullCursor = null;
    let wantChildren = !isPull,
      wantPulls = true;
    let parent, summary;
    const brief = (node) => ({
      number: node.number,
      title: node.title,
      url: node.url,
      state: node.state?.toLowerCase() || 'open',
      repo: node.repository?.nameWithOwner || project.repo,
      ...(node.stateReason ? { stateReason: node.stateReason.toLowerCase() } : {}),
      ...(node.isDraft !== undefined ? { draft: !!node.isDraft } : {}),
    });
    do {
      const data = await graphql(config(), RELATIONS_QUERY, {
        owner,
        name,
        number,
        childCursor,
        pullCursor,
        children: wantChildren,
        pulls: wantPulls,
      });
      const node = data?.repository?.issueOrPullRequest;
      if (!node || node.__typename !== (isPull ? 'PullRequest' : 'Issue'))
        throw new Error(`GitHub returned incomplete relationships for ${project.repo}#${number}`);
      parent = node.parent ? brief(node.parent) : null;
      summary = node.subIssuesSummary || null;
      const pullRefs = isPull ? node.closingIssuesReferences : node.closedByPullRequestsReferences;
      if (wantPulls) {
        if (!pullRefs?.nodes) throw new Error('GitHub returned an incomplete linked item page');
        links.push(...pullRefs.nodes.map(brief));
        wantPulls = !!pullRefs.pageInfo?.hasNextPage;
        const cursor = pullRefs.pageInfo?.endCursor;
        if (wantPulls && (!cursor || cursor === pullCursor))
          throw new Error('GitHub returned an invalid linked item cursor');
        pullCursor = cursor || null;
      }
      if (wantChildren) {
        if (!node.subIssues?.nodes) throw new Error('GitHub returned an incomplete sub-issue page');
        children.push(...node.subIssues.nodes.map(brief));
        wantChildren = !!node.subIssues.pageInfo?.hasNextPage;
        const cursor = node.subIssues.pageInfo?.endCursor;
        if (wantChildren && (!cursor || cursor === childCursor))
          throw new Error('GitHub returned an invalid sub-issue cursor');
        childCursor = cursor || null;
      }
    } while (wantPulls || wantChildren);
    return isPull ? { issues: links } : { parent, subIssues: summary, subIssueItems: children, pulls: links };
  }

  function enqueue(project, fn) {
    const key = project.repo.toLowerCase();
    const previous = queues.get(key) || Promise.resolve();
    const work = previous
      .catch(() => {})
      .then(fn)
      .catch(async (e) => {
        await store.finishSync(project.repo, null, e.message).catch(() => {});
        throw e;
      });
    queues.set(key, work);
    // Attach both handlers immediately, including for fire-and-forget callers.
    work.then(
      () => {
        if (queues.get(key) === work) queues.delete(key);
      },
      () => {
        if (queues.get(key) === work) queues.delete(key);
      },
    );
    return work;
  }

  async function syncRepository(project) {
    const startedAt = now();
    const state = await store.syncState(project.repo);
    // Overlap the watermark by a minute: GitHub timestamps are rounded and
    // records may move between pages while a long initial backfill is running.
    const since = state.synced_at
      ? `&since=${encodeURIComponent(new Date(Number(state.synced_at) - 60000).toISOString())}`
      : '';
    const root = `/repos/${project.repo}`;
    const issues = await inventory(project, () =>
      optional(() => pages(`${root}/issues?state=all&sort=updated&direction=asc${since}`)),
    );
    const synced = await store.syncedItems(project.repo);
    const refreshed = new Set();
    const failures = [];
    for (const issue of issues || []) {
      // A large initial history can span several rate-limit windows. Completed
      // items survive failures and are skipped on retry rather than starting over.
      if (synced.get(issue.number) === issue.updated_at) continue;
      await enqueue(project, () => attemptRefresh(project, issue.number, issue, failures, startedAt));
      refreshed.add(issue.number);
    }
    // CI and review requests can change without updating issue.updated_at.
    // Refresh every open PR as well, even if the hourly issue delta was empty.
    const pulls = await inventory(project, () =>
      pages(`${root}/pulls?state=${issues === undefined ? 'all' : 'open'}`),
    );
    for (const pull of pulls)
      if (
        !refreshed.has(pull.number) &&
        (pull.state === 'open' || synced.get(pull.number) !== pull.updated_at)
      )
        await enqueue(project, () => attemptRefresh(project, pull.number, null, failures));
    await enqueue(project, async () => {
      await attemptMetadata(project, failures);
      const result = await board(project, { complete: true });
      invalidate(project.repo);
      if (issues === undefined) throw new Error('Issues permission missing; PR synchronization completed');
      if (result.issuesError || result.issuesTruncated)
        throw new Error(result.issuesError || 'Incomplete GitHub issue board');
      if (failures.length) throw failures[0];
      // Only a fully successful pass advances the cursor. A failed pass can be
      // repeated without losing a closed PR or an update between two pages.
      await store.finishSync(project.repo, startedAt);
    });
  }

  async function inventory(project, read) {
    try {
      return await read();
    } catch (e) {
      // An unavailable REST inventory must not strand the independent GraphQL
      // board. Rate limits retain the outer resource-specific recovery policy.
      if (e.status !== 429)
        await enqueue(project, async () => {
          await board(project, { complete: true });
          invalidate(project.repo);
        }).catch((boardError) => log(`${project.repo}: ${boardError.message}`));
      throw e; // Keep the inventory failure and the old hourly cursor.
    }
  }

  async function attemptRefresh(project, number, supplied, failures, observedAt = now()) {
    try {
      await refreshItem(project, number, supplied, observedAt);
    } catch (e) {
      // Stop detail requests on rate limits. The outer task can still reconcile
      // the GraphQL board when only the core REST allowance is exhausted.
      if (e.status === 429) throw e;
      failures.push(e);
    }
  }

  async function attemptMetadata(project, failures) {
    try {
      await refreshMetadata(project);
    } catch (e) {
      if (e.status === 429) throw e;
      failures.push(e);
    }
  }

  async function refreshMetadata(project) {
    const root = `/repos/${project.repo}`;
    const labels = await optional(() => pages(`${root}/labels`));
    const milestones = await optional(() => pages(`${root}/milestones?state=all`));
    if (labels !== undefined && milestones !== undefined)
      await store.saveMetadata(project.repo, { labels, milestones });
  }

  async function reconcileOnCoreLimit(project, work) {
    try {
      return await work();
    } catch (e) {
      // GitHub tracks core and GraphQL cooldowns separately. Do no more REST
      // work, but do not strand current boards behind bulk detail downloads.
      // Queue this outside the failed task so it cannot wait on itself.
      if (e.status === 429 && e.resource === 'core')
        await enqueue(project, async () => {
          await board(project, { complete: true });
          invalidate(project.repo);
        });
      throw e; // Preserve the failure and the old hourly cursor.
    }
  }

  function tick() {
    if (running) return running;
    if (!config().githubToken || stopped) return Promise.resolve();
    running = (async () => {
      const seen = new Set();
      for (const project of projects()) {
        const key = project.repo.toLowerCase();
        if (seen.has(key) || stopped) continue;
        seen.add(key);
        try {
          await reconcileOnCoreLimit(project, () => syncRepository(project));
        } catch (e) {
          await store.finishSync(project.repo, null, e.message).catch(() => {});
          log(`${project.repo}: ${e.message}`);
        }
      }
    })().finally(() => {
      running = null;
    });
    return running;
  }

  function onWebhook(event, payload) {
    if (stopped || !EVENTS.has(event) || !config().githubToken) return;
    const repo = payload.repository?.full_name?.toLowerCase();
    const project = projects().find((p) => p.repo.toLowerCase() === repo);
    if (!project) return;
    let batch = pending.get(repo);
    if (!batch) {
      batch = { project, numbers: new Set(), targets: [], metadata: false, timer: null };
      pending.set(repo, batch);
      // Coalesce bursts of labels, CI completions and review comments.
      batch.timer = setTimeout(() => flush(repo), 2000);
      batch.timer.unref?.();
    }
    const number = payload.pull_request?.number || payload.issue?.number;
    if (Number.isSafeInteger(number) && number > 0) batch.numbers.add(number);
    if (event === 'label' || event === 'milestone') batch.metadata = true;
    for (const [item, hint] of [
      [payload.parent_issue, payload.parent_issue_repo?.full_name],
      [payload.sub_issue, repo],
    ]) {
      if (!Number.isSafeInteger(item?.number) || item.number < 1) continue;
      const targetRepo =
        /^https:\/\/github\.com\/([^/]+\/[^/]+)\/issues\//.exec(item.html_url || '')?.[1] || hint || repo;
      if (targetRepo.toLowerCase() === repo) batch.numbers.add(item.number);
      else onWebhook('issues', { repository: { full_name: targetRepo }, issue: item });
    }
    for (const p of payload.check_run?.pull_requests || payload.check_suite?.pull_requests || [])
      if (Number.isSafeInteger(p.number) && p.number > 0) batch.numbers.add(p.number);
    const sha = payload.check_run?.head_sha || payload.check_suite?.head_sha || payload.sha || '';
    const branch =
      payload.check_run?.check_suite?.head_branch ||
      payload.check_suite?.head_branch ||
      (event === 'push' ? String(payload.ref || '').replace(/^refs\/heads\//, '') : '');
    if (sha || branch) batch.targets.push({ sha, branch });
  }

  function flush(repo) {
    const batch = pending.get(repo);
    if (!batch) return Promise.resolve();
    clearTimeout(batch.timer);
    pending.delete(repo);
    return reconcileOnCoreLimit(batch.project, () =>
      enqueue(batch.project, async () => {
        const failures = [];
        if (batch.metadata) await attemptMetadata(batch.project, failures);
        for (const target of batch.targets) {
          for (const number of await store.openPullNumbers(batch.project.repo, target))
            batch.numbers.add(number);
        }
        for (const number of batch.numbers) await attemptRefresh(batch.project, number, null, failures);
        await board(batch.project, { complete: true });
        invalidate(batch.project.repo);
        if (failures.length) throw failures[0];
      }),
    ).catch((e) => log(`${repo}: ${e.message}`));
  }

  function start() {
    if (timer) return;
    stopped = false;
    void tick();
    timer = setInterval(() => {
      void tick();
    }, GITHUB_SYNC_INTERVAL_MS);
    timer.unref?.();
  }

  function stop() {
    stopped = true;
    clearInterval(timer);
    timer = null;
    for (const batch of pending.values()) clearTimeout(batch.timer);
    pending.clear();
  }

  return { start, stop, tick, onWebhook, flush };
}

export const githubSync = createGithubSync();
