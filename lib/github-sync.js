// @ts-check
import { getConfig } from './config.js';
import { activeProjects } from './projects.js';
import { githubRest, githubGraphql, checkGithubSyncBudget } from './github.js';
import { githubStore } from './github-store.js';
import { ciRunId, ciStore } from './ci-store.js';
import {
  checkFailed,
  fetchProjectPulls,
  invalidateBoard,
  restCheckRun,
  restCommitStatus,
  reviewsOf,
} from './prboard.js';

export const GITHUB_SYNC_INTERVAL_MS = 60 * 60 * 1000;
export const GITHUB_WEBHOOK_INTERVAL_MS = 15_000;
const BOARD_INTERVAL_MS = 60_000;
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
        reviewDecision
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
  'workflow_job',
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
  graphql = (cfg, query, variables) => githubGraphql(cfg, query, variables, { reserve: 500 }),
  store = githubStore,
  ci = ciStore,
  board = (project, options) => fetchProjectPulls(project, { ...options, reserve: 500 }),
  budget = checkGithubSyncBudget,
  invalidate = (repo) => invalidateBoard(repo, { refresh: false }),
  log = (message) => console.error(`github-sync: ${message}`),
  now = Date.now,
} = {}) {
  const queues = new Map();
  const pending = new Map();
  const ciRetries = new Map();
  const ciRecoveryStarts = new Map();
  const ciEarlyTurns = new Map();
  const boardRefreshedAt = new Map();
  const boardTimers = new Map();
  const webhookStartedAt = new Map();
  let timer = null;
  let running = null;
  let stopped = false;

  async function read(path) {
    const res = await rest(config(), 'GET', path, undefined, { conditional: true, reserve: 1000 });
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
    budget();
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
    const ciChecks = [];
    let ciObservedAt;
    let ciPermissionError;
    let target;
    let hasChecks = false;
    const comments = await optional(() => pages(`${root}/issues/${number}/comments`));
    if (comments !== undefined) collections.comments = comments;
    if (pull) {
      collections.reviews = await pages(`${root}/pulls/${number}/reviews`);
      collections.reviewComments = await pages(`${root}/pulls/${number}/comments`);
      collections.commits = await pages(`${root}/pulls/${number}/commits`);
      collections.files = await pages(`${root}/pulls/${number}/files`);
      if (row.headSha) {
        // Order CI by its read time, independently of the older issue inventory.
        ciObservedAt = now();
        target = rememberCiTarget(project, row.headSha, row.branch);
        const checks = await optional(() => pages(`${root}/commits/${row.headSha}/check-runs`, 'check_runs'));
        const statuses = await optional(() => pages(`${root}/commits/${row.headSha}/statuses`));
        if (checks === undefined || statuses === undefined)
          ciPermissionError = Object.assign(new Error(`CI permission missing for ${row.headSha}`), {
            status: 403,
          });
        hasChecks = !!checks?.length;
        ciChecks.push(...(checks || []), ...(statuses || []));
        // Commit statuses are an append-only history. Keep the latest per context.
        const latest = [...new Map((statuses || []).toReversed().map((s) => [s.context, s])).values()];
        // An unreadable check-run list must not erase the previous collection
        // or claim overall success based only on commit statuses.
        if (checks !== undefined && statuses !== undefined) collections.checks = [...checks, ...latest];
        const runs = [...(checks || []).map(restCheckRun), ...latest.map(restCommitStatus)];
        if (checks !== undefined && statuses !== undefined)
          row.checks = runs.some((r) => checkFailed(r.conclusion))
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
    }
    let historyError = ciPermissionError;
    let historyChecks = [];
    if (row.headSha) {
      try {
        historyChecks = hasChecks
          ? await pages(`${root}/commits/${row.headSha}/check-runs?filter=all`, 'check_runs')
          : [];
      } catch (e) {
        // A core cooldown still stops all further REST work. The retained SHA
        // recovers history even if a closed PR is subsequently synchronized.
        if (e.status === 429) throw e;
        historyError ||= e;
      }
    }
    if (pull) {
      // Validate after history pagination as well as the current collections.
      const current = await read(`${root}/pulls/${number}`);
      if (
        current.head?.sha !== pull.head?.sha ||
        current.base?.sha !== pull.base?.sha ||
        current.updated_at !== pull.updated_at
      )
        throw new Error(`Pull request #${number} changed during synchronization; retry required`);
    }
    // History must not change the current PR verdict: old failed attempts
    // remain in the ledger after a successful retry.
    try {
      await ci.save(project.repo, [...ciChecks, ...historyChecks], {
        sha: row.headSha,
        branch: row.branch,
        observedAt: ciObservedAt,
      });
    } catch (e) {
      historyError ||= e;
    }
    // The current collections are complete and validated. History failures have
    // their own retained discovery and must not prevent publishing this snapshot.
    const saved = await store.saveItem(project.repo, row, collections);
    if (saved === false) throw new Error(`Item #${number} changed during synchronization; retry required`);
    // This may be the only collection of a PR's jobs (no workflow_job delivery, as
    // for PRs already open before the subscription), so it names their runners too.
    if (hasChecks) {
      try {
        await optional(() => attributeRunners(project, historyChecks.length ? historyChecks : ciChecks));
      } catch (e) {
        if (e.status === 429) throw e;
        historyError ||= e;
      }
    }
    if (historyError) throw Object.assign(historyError, { ciOnly: true });
    if (target && !target.checkIds?.size && !target.suiteIds?.size)
      acknowledgeCiTarget(project, row.headSha, target);
  }

  async function relations(project, number, isPull) {
    const [owner, name] = project.repo.split('/');
    const links = [],
      children = [];
    let childCursor = null,
      pullCursor = null;
    let wantChildren = !isPull,
      wantPulls = true;
    let parent, summary, reviewDecision;
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
      reviewDecision = node.reviewDecision?.toLowerCase() || null;
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
    return isPull
      ? { issues: links, reviewDecision }
      : { parent, subIssues: summary, subIssueItems: children, pulls: links };
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

  function deferBoard(project, delay) {
    const key = project.repo.toLowerCase();
    if (stopped || boardTimers.has(key)) return;
    const timer = setTimeout(() => {
      boardTimers.delete(key);
      void enqueue(project, async () => {
        // Another batch may have refreshed the board while this task waited.
        await refreshBoard(project, true);
        invalidate(project.repo);
      }).catch((e) => {
        if (e.status === 429 && Number.isFinite(e.retryAt))
          deferBoard(project, Math.max(0, e.retryAt - now()));
        log(`${project.repo}: ${e.message}`);
      });
    }, delay);
    timer.unref?.();
    boardTimers.set(key, timer);
  }

  async function refreshBoard(project, throttle = false) {
    const key = project.repo.toLowerCase();
    const previous = boardRefreshedAt.get(key);
    if (throttle && previous !== undefined && now() - previous < BOARD_INTERVAL_MS) {
      deferBoard(project, BOARD_INTERVAL_MS - (now() - previous));
      return;
    }
    clearTimeout(boardTimers.get(key));
    boardTimers.delete(key);
    const result = await board(project, { complete: true });
    boardRefreshedAt.set(key, now());
    return result;
  }

  async function syncRepository(project) {
    budget();
    const startedAt = now();
    const state = await store.syncState(project.repo);
    // Overlap the watermark by a minute: GitHub timestamps are rounded and
    // records may move between pages while a long initial backfill is running.
    const since = state.synced_at
      ? `&since=${encodeURIComponent(new Date(Number(state.synced_at) - 60000).toISOString())}`
      : '';
    const key = project.repo.toLowerCase();
    const earlyCi = ciEarlyTurns.get(key) || false;
    ciEarlyTurns.set(key, !earlyCi);
    const ciFailures = [];
    // Alternate admission before bulk downloads, including issue-delta work.
    // Advance the turn before a quota abort so both kinds of work get a chance.
    if (earlyCi) await enqueue(project, () => recoverCi(project, ciFailures));
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
      if (!earlyCi) await recoverCi(project, ciFailures);
      const result = await refreshBoard(project);
      invalidate(project.repo);
      if (issues === undefined) throw new Error('Issues permission missing; PR synchronization completed');
      if (result.issuesError || result.issuesTruncated)
        throw new Error(result.issuesError || 'Incomplete GitHub issue board');
      const mirrorFailure = failures.find((e) => !e.ciOnly);
      if (mirrorFailure) throw mirrorFailure;
      ciFailures.push(...failures.filter((e) => e.ciOnly));
      // Only a successful issue/PR pass advances its cursor. Independent CI
      // errors remain visible without replaying successful mirror downloads.
      const ciError = ciFailures.length
        ? `CI collection: ${ciFailures.map((e) => e.message).join('; ')}`
        : null;
      await store.finishSync(project.repo, startedAt);
      if (ciError) {
        log(`${project.repo}: ${ciError}`);
        await store.finishSync(project.repo, null, ciError);
      }
    });
  }

  async function recoverCi(project, ciFailures) {
    const key = project.repo.toLowerCase();
    const recoveries = [
      async () => {
        // Retry discovery failures even when no ledger row was ever written.
        // Bound each hourly pass and rotate failures behind unattempted targets.
        const retries = ciRetries.get(key);
        for (const [sha, target] of [...(retries || [])].slice(0, 100))
          await refreshCiTarget(project, sha, target, ciFailures);
      },
      async () => {
        const pendingChecks = await attemptCi(() => ci.pendingCommits(project.repo), ciFailures);
        for (const pending of pendingChecks || []) {
          ci.markPendingAttempt(project.repo, pending.sha);
          // Completing the last pending row can remove this SHA from selection
          // before another CI source succeeds. Retain it until all reads finish.
          const target =
            ciRetries.get(key)?.get(pending.sha) || rememberCiTarget(project, pending.sha, pending.branch);
          await refreshCiTarget(project, pending.sha, target, ciFailures);
        }
      },
      () => attemptCi(() => refreshDefaultBranch(project, ciFailures), ciFailures),
    ];
    // Rotate the first source before requests can exhaust quota. A costly
    // discovery or pending commit must not monopolize every hourly window.
    const first = ciRecoveryStarts.get(key) || 0;
    ciRecoveryStarts.set(key, (first + 1) % recoveries.length);
    for (let i = 0; i < recoveries.length; i++) await recoveries[(first + i) % recoveries.length]();
  }

  async function inventory(project, read) {
    try {
      return await read();
    } catch (e) {
      // An unavailable REST inventory must not strand the independent GraphQL
      // board. Rate limits retain the outer resource-specific recovery policy.
      if (e.status !== 429)
        await enqueue(project, async () => {
          await refreshBoard(project);
          invalidate(project.repo);
        }).catch((boardError) => log(`${project.repo}: ${boardError.message}`));
      throw e; // Keep the inventory failure and the old hourly cursor.
    }
  }

  async function attemptRefresh(project, number, supplied, failures, observedAt = now()) {
    try {
      await refreshItem(project, number, supplied, observedAt);
      return true;
    } catch (e) {
      // Stop detail requests on rate limits. The outer task can still reconcile
      // the GraphQL board when only the core REST allowance is exhausted.
      if (e.status === 429) throw e;
      failures.push(e);
      return false;
    }
  }

  async function attemptMetadata(project, failures) {
    try {
      await refreshMetadata(project);
      return true;
    } catch (e) {
      if (e.status === 429) throw e;
      failures.push(e);
      return false;
    }
  }

  async function refreshMetadata(project) {
    const root = `/repos/${project.repo}`;
    const labels = await optional(() => pages(`${root}/labels`));
    const milestones = await optional(() => pages(`${root}/milestones?state=all`));
    if (labels !== undefined && milestones !== undefined)
      await store.saveMetadata(project.repo, { labels, milestones });
  }

  async function refreshCommitChecks(project, sha, branch = null, target = null) {
    if (!sha) return;
    const observedAt = now();
    const root = `/repos/${project.repo}/commits/${encodeURIComponent(sha)}`;
    const failures = [];
    const hints = { sha, branch, observedAt };
    // Publish only complete sources, but do not discard one kind when another
    // fails. Permission denials remain visible and retain the discovery too.
    const collect = async (read) => {
      try {
        const rows = await read();
        if (rows.length) await ci.save(project.repo, rows, hints);
        return rows;
      } catch (e) {
        if (e.status === 429) throw e;
        failures.push(e);
      }
    };
    const checks = await collect(() => pages(`${root}/check-runs?filter=all`, 'check_runs'));
    // The delivered checks the commit list omitted are attributed with it.
    const fallbacks = [];
    if (checks) {
      for (const id of target?.checkIds || []) {
        if (checks.some((check) => String(check.id) === id)) continue;
        const rows = await collect(async () => {
          const check = await read(`/repos/${project.repo}/check-runs/${id}`);
          if (check.head_sha !== sha) throw new Error(`Delivered check ${id} has a different commit`);
          return [check];
        });
        if (rows) fallbacks.push(...rows);
      }
      for (const id of target?.suiteIds || []) {
        if (checks.some((check) => String(check.check_suite?.id) === id)) continue;
        const rows = await collect(async () => {
          const rows = await pages(
            `/repos/${project.repo}/check-suites/${id}/check-runs?filter=all`,
            'check_runs',
          );
          if (rows.some((check) => check.head_sha !== sha))
            throw new Error(`Delivered suite ${id} has a different commit`);
          return rows;
        });
        if (rows) fallbacks.push(...rows);
      }
    }
    const statuses = await collect(() => pages(`${root}/statuses`));
    if (checks?.length === 0 && statuses?.length === 0) await ci.save(project.repo, [], hints);
    // Optional enrichment comes last: its rate limit must not starve the statuses.
    if (checks)
      await attemptCi(() => optional(() => attributeRunners(project, [...checks, ...fallbacks])), failures);
    if (failures.length) throw failures[0];
  }

  // workflow_job deliveries name each job's runner; this covers jobs whose
  // delivery was missed or predates the subscription, one jobs list per run.
  // A token without Actions read access leaves them unattributed.
  async function attributeRunners(project, checks) {
    const started = checks.filter(
      (check) =>
        check.app?.slug === 'github-actions' && check.status !== 'queued' && ciRunId(check.details_url),
    );
    if (!started.length) return;
    const missing = new Set(
      await ci.missingRunners(
        project.repo,
        started.map((check) => String(check.id)),
      ),
    );
    const runs = new Set(
      started.filter((check) => missing.has(String(check.id))).map((check) => ciRunId(check.details_url)),
    );
    for (const run of runs)
      await ci.saveRunners(
        project.repo,
        await pages(`/repos/${project.repo}/actions/runs/${run}/jobs?filter=all`, 'jobs'),
        now(),
      );
  }

  function rememberCiTarget(project, sha, branch = null) {
    const key = project.repo.toLowerCase();
    let targets = ciRetries.get(key);
    if (!targets) ciRetries.set(key, (targets = new Map()));
    const previous = targets.get(sha);
    const target = { ...previous, branch: previous?.branch || branch };
    targets.set(sha, target);
    return target;
  }

  function acknowledgeCiTarget(project, sha, target) {
    const key = project.repo.toLowerCase();
    const targets = ciRetries.get(key);
    if (targets?.get(sha) === target) {
      targets.delete(sha);
      if (!targets.size) ciRetries.delete(key);
    }
  }

  async function attemptCi(work, failures) {
    try {
      return await work();
    } catch (e) {
      if (e.status === 429) throw e;
      failures.push(e);
    }
  }

  async function refreshCiTarget(project, sha, target, failures) {
    const key = project.repo.toLowerCase();
    const targets = ciRetries.get(key);
    try {
      await refreshCommitChecks(project, sha, target.branch, target);
      // Each discovery has its own identity: older reads cannot acknowledge a
      // newer webhook registered while this collection was in flight.
      acknowledgeCiTarget(project, sha, target);
    } catch (e) {
      if (targets?.get(sha) === target) {
        targets.delete(sha);
        targets.set(sha, target); // Try other failed discoveries first next hour.
      }
      if (e.status === 429) throw e;
      failures.push(e);
    }
  }

  async function refreshDefaultBranch(project, failures) {
    const repo = await optional(() => read(`/repos/${project.repo}`));
    if (!repo?.default_branch) return;
    const commit = await read(`/repos/${project.repo}/commits/${encodeURIComponent(repo.default_branch)}`);
    if (commit.sha) {
      const key = project.repo.toLowerCase();
      // A retained webhook has its own generation and possibly delivered IDs.
      // Leave it for the retry source instead of replacing or acknowledging it.
      if (ciRetries.get(key)?.has(commit.sha)) return;
      const target = rememberCiTarget(project, commit.sha, repo.default_branch);
      await refreshCiTarget(project, commit.sha, target, failures);
    }
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
          await refreshBoard(project, true);
          invalidate(project.repo);
        }).catch((boardError) => log(`${project.repo}: ${boardError.message}`));
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
    // The job's check_run delivery refreshes the check itself; this one only
    // says where it ran, which the payload carries without an API call.
    if (event === 'workflow_job') {
      if (payload.workflow_job?.id)
        ci.saveRunners(repo, [payload.workflow_job], now()).catch((e) =>
          log(`${repo}: recording CI runner failed: ${e.message}`),
        );
      return;
    }
    let batch = pending.get(repo);
    if (!batch) {
      batch = {
        project,
        numbers: new Set(),
        targets: [],
        ciTargets: new Map(),
        metadata: false,
        timer: null,
      };
      pending.set(repo, batch);
      // Coalesce bursts, including deliveries received during a previous batch.
      // The first batch is prompt; sustained CI traffic runs at most every 15s.
      const delay = Math.max(
        2000,
        (webhookStartedAt.get(repo) ?? -Infinity) + GITHUB_WEBHOOK_INTERVAL_MS - now(),
      );
      batch.timer = setTimeout(() => flush(repo), delay);
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
      (event === 'status' && payload.branches?.length === 1 ? payload.branches[0].name : '') ||
      (event === 'push' && String(payload.ref || '').startsWith('refs/heads/')
        ? payload.ref.slice('refs/heads/'.length)
        : '');
    if (sha || branch) batch.targets.push({ sha, branch });
    // No PR is required: deployments and default-branch CI also feed the ledger.
    // Coalesce matrix-job bursts by commit, rather than spending one API call
    // per job notification; refetching also handles out-of-order deliveries.
    const commit = event === 'push' && !payload.deleted ? payload.after : sha;
    if (['push', 'status', 'check_suite', 'check_run'].includes(event) && commit && !/^0+$/.test(commit)) {
      let retries = ciRetries.get(repo);
      if (!retries) ciRetries.set(repo, (retries = new Map()));
      const previous = batch.ciTargets.get(commit) || retries.get(commit);
      const target = {
        branch: branch || previous?.branch || null,
        checkIds: new Set(previous?.checkIds),
        suiteIds: new Set(previous?.suiteIds),
      };
      if (payload.check_run?.id) target.checkIds.add(String(payload.check_run.id));
      if (payload.check_suite?.id) target.suiteIds.add(String(payload.check_suite.id));
      batch.ciTargets.set(commit, target);
      // Register each discovery before queueing: an older in-flight collection
      // must not acknowledge a newer delivery, even while its batch waits.
      retries.set(commit, target);
    }
  }

  function flush(repo) {
    const project = pending.get(repo)?.project;
    if (!project) return Promise.resolve();
    let attempted;
    return reconcileOnCoreLimit(project, () =>
      enqueue(project, async () => {
        // Keep pending deliveries together while earlier work owns the queue.
        const batch = pending.get(repo);
        if (!batch) return;
        clearTimeout(batch.timer);
        pending.delete(repo);
        attempted = batch;
        webhookStartedAt.set(repo, now());
        budget();
        const failures = [];
        if (batch.metadata && (await attemptMetadata(batch.project, failures))) batch.metadata = false;
        while (batch.targets.length) {
          const target = batch.targets[0];
          for (const number of await store.openPullNumbers(batch.project.repo, target))
            batch.numbers.add(number);
          batch.targets.shift();
        }
        // A retained batch resumes unfinished work instead of spending each
        // replenished window on the same successful prefix.
        for (const number of batch.numbers)
          if (await attemptRefresh(batch.project, number, null, failures)) batch.numbers.delete(number);
        for (const [sha, target] of batch.ciTargets) {
          await refreshCiTarget(batch.project, sha, target, failures);
          if (ciRetries.get(repo)?.get(sha) !== target) batch.ciTargets.delete(sha);
        }
        await refreshBoard(batch.project, true);
        invalidate(batch.project.repo);
        if (failures.length) throw failures[0];
      }),
    ).catch((e) => {
      // Hold one coalesced batch until the allowance resets instead of losing
      // deliveries or letting every new CI event retry an exhausted budget.
      if (!stopped && attempted && e.status === 429 && Number.isFinite(e.retryAt)) {
        const batch = pending.get(repo) || attempted;
        if (batch !== attempted) {
          for (const number of attempted.numbers) batch.numbers.add(number);
          batch.targets.push(...attempted.targets);
          for (const [sha, target] of attempted.ciTargets)
            if (!batch.ciTargets.has(sha)) batch.ciTargets.set(sha, target);
          batch.metadata ||= attempted.metadata;
        }
        clearTimeout(batch.timer);
        pending.set(repo, batch);
        batch.timer = setTimeout(() => flush(repo), Math.max(0, e.retryAt - now()));
        batch.timer.unref?.();
      }
      log(`${repo}: ${e.message}`);
    });
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
    ciRetries.clear();
    ciRecoveryStarts.clear();
    ciEarlyTurns.clear();
    for (const timer of boardTimers.values()) clearTimeout(timer);
    boardTimers.clear();
  }

  return { start, stop, tick, onWebhook, flush };
}

export const githubSync = createGithubSync();
