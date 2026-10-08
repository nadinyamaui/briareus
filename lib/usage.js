// @ts-check
import {
  saveTurnUsage,
  loadTurnUsage,
  loadAllTurnUsage,
  loadJobTurnUsage,
  loadTurnUsageCalibration,
} from './db.js';
import { estimateCosts } from './prices.js';

// The per-turn spend ledger and its sums. Rows hang off the stable project id, so
// deleting a session keeps its stats. Kept apart from jobs.js so it tests in isolation.

// The turn as one ledger row, or null when nothing was reported (a canceled turn):
// a row of NULLs would only inflate the session count.
export function turnUsageRecord(job, turn, provider, model, now = Date.now()) {
  const inputTokens = turn.inputTokens ?? null;
  const outputTokens = turn.outputTokens ?? null;
  const cachedInputTokens = turn.cachedInputTokens ?? null;
  const costUsd = turn.costUsd ?? null;
  const durationMs = turn.durationMs ?? null;
  if (inputTokens == null && outputTokens == null && costUsd == null && durationMs == null) return null;
  return {
    projectId: job.projectId ?? null,
    jobId: job.id,
    repo: job.repo ?? null,
    provider: provider?.binary ?? null,
    accountId: provider?.id ?? null,
    accountLabel: provider?.label ?? null,
    sessionTitle: job.title ?? null,
    model: model ?? null,
    // The session's kind of work ('code-review', 'qa', a board action id, 'chat', ...),
    // applied to every turn, so a review's publish turn is still review spend.
    activity: job.activity ?? null,
    inputTokens,
    outputTokens,
    cachedInputTokens,
    ...(turn.longInputTokens != null
      ? {
          longInputTokens: turn.longInputTokens,
          longCachedInputTokens: turn.longCachedInputTokens,
          longOutputTokens: turn.longOutputTokens,
        }
      : {}),
    // Provider-reported only, never estimated: estimates are added at read time
    // (lib/prices.js) and marked as such.
    costUsd,
    durationMs,
    at: now,
  };
}

// A dashboard period as a half-open epoch-millis window in local time. `all` has null
// bounds so the query can omit the range; an unknown period falls back to this month.
export function usageWindow(period = 'month', now = Date.now(), range = {}) {
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  if (['today', '7d', '30d'].includes(period)) {
    const from = new Date(today);
    from.setDate(from.getDate() - (period === '7d' ? 6 : period === '30d' ? 29 : 0));
    const to = new Date(today);
    to.setDate(to.getDate() + 1);
    return { period, from: +from, to: +to };
  }
  if (period === 'custom') {
    const parse = (value) => {
      if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value))
        throw new Error('Choose a valid start and end date.');
      const [y, m, d] = value.split('-').map(Number);
      const date = new Date(y, m - 1, d);
      if (localDate(+date) !== value) throw new Error('Choose a valid date.');
      return date;
    };
    const from = parse(range.from);
    const to = parse(range.to);
    to.setDate(to.getDate() + 1);
    if (+from >= +to || +to - +from > 366 * 86400000) throw new Error('Choose a range of 1–366 days.');
    return { period, from: +from, to: +to };
  }
  if (period === 'all') return { period: 'all', from: null, to: null };
  const back = period === 'prev' ? 1 : 0;
  const d = new Date(now);
  return {
    period: back ? 'prev' : 'month',
    from: new Date(d.getFullYear(), d.getMonth() - back, 1).getTime(),
    to: new Date(d.getFullYear(), d.getMonth() - back + 1, 1).getTime(),
  };
}

// [start of this month, start of next month).
export function monthWindow(now = Date.now()) {
  const { from, to } = usageWindow('month', now);
  return { from, to };
}

// Sum ledger rows. Cost sums only priced rows and stays null when none were, so the UI
// can tell "free" from "unpriced"; `unpricedTurns` and `estimatedTurns` qualify the total.
export function aggregateUsage(rows) {
  const sessions = new Set();
  let inputTokens = 0;
  let outputTokens = 0;
  let costUsd = null;
  let durationMs = 0;
  let unpricedTurns = 0;
  let estimatedTurns = 0;
  for (const r of rows) {
    sessions.add(r.jobId);
    inputTokens += r.inputTokens || 0;
    outputTokens += r.outputTokens || 0;
    durationMs += r.durationMs || 0;
    if (r.costUsd == null) unpricedTurns++;
    else {
      costUsd = (costUsd || 0) + r.costUsd;
      if (r.costEstimated) estimatedTurns++;
    }
  }
  return {
    turns: rows.length,
    sessions: sessions.size,
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    durationMs,
    costUsd,
    unpricedTurns,
    estimatedTurns,
  };
}

// "2026-08-03" in this process's zone. Buckets travel as strings, not epochs, since a
// browser in another zone would read local midnight as a different day.
function localDate(at) {
  const d = new Date(at);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// Rows bucketed by local day over [from, to), empty days included so the chart
// does not look shorter than the window.
export function dailyUsage(rows, from, to) {
  const days = new Map(); // "YYYY-MM-DD" -> the bucket
  for (const d = new Date(from); d.getTime() < to; d.setDate(d.getDate() + 1)) {
    days.set(localDate(d), {
      date: localDate(d),
      turns: 0,
      totalTokens: 0,
      costUsd: null,
      unpricedTurns: 0,
      estimatedTurns: 0,
    });
  }
  for (const r of rows) {
    const day = days.get(localDate(r.at));
    if (!day) continue;
    day.turns += 1;
    day.totalTokens += (r.inputTokens || 0) + (r.outputTokens || 0);
    // Same cost rule as aggregateUsage.
    if (r.costUsd == null) day.unpricedTurns += 1;
    else {
      day.costUsd = (day.costUsd || 0) + r.costUsd;
      if (r.costEstimated) day.estimatedTurns += 1;
    }
  }
  return [...days.values()];
}

// "2026-08", on the same clock as localDate.
export function localMonth(at) {
  return localDate(at).slice(0, 7);
}

// dailyUsage per calendar month, spanning the rows themselves: the "all time" chart,
// where daily bars would be unreadable.
export function monthlyUsage(rows) {
  if (!rows.length) return [];
  let min = Infinity;
  let max = -Infinity;
  for (const r of rows) {
    if (r.at < min) min = r.at;
    if (r.at > max) max = r.at;
  }
  const months = new Map(); // "YYYY-MM" -> the bucket
  const first = new Date(min);
  for (
    const d = new Date(first.getFullYear(), first.getMonth(), 1);
    d.getTime() <= max;
    d.setMonth(d.getMonth() + 1)
  ) {
    months.set(localMonth(d), {
      date: localMonth(d),
      turns: 0,
      totalTokens: 0,
      costUsd: null,
      unpricedTurns: 0,
      estimatedTurns: 0,
    });
  }
  for (const r of rows) {
    const month = months.get(localMonth(r.at));
    if (!month) continue;
    month.turns += 1;
    month.totalTokens += (r.inputTokens || 0) + (r.outputTokens || 0);
    if (r.costUsd == null) month.unpricedTurns += 1;
    else {
      month.costUsd = (month.costUsd || 0) + r.costUsd;
      if (r.costEstimated) month.estimatedTurns += 1;
    }
  }
  return [...months.values()];
}

// The dashboard's filter keys. A project key matches projectBreakdown's grouping (id
// when configured, else repo) so filter and table agree; a model key includes the
// provider, since two providers can sell the same model id.
export function projectFilterKey(project, repo) {
  return project ? `p:${project.id}` : `r:${String(repo || '').toLowerCase()}`;
}

export function modelFilterKey(provider, model) {
  return `${provider || ''}|${model || ''}`;
}

// Which configured project owns a row, by projectBreakdown's rule.
function projectFinder(projects) {
  const byId = new Map(projects.map((p) => [p.id, p]));
  const byRepo = new Map(projects.map((p) => [String(p.repo || '').toLowerCase(), p]));
  return (row) => byId.get(row.projectId) || byRepo.get(String(row.repo || '').toLowerCase()) || null;
}

// The rows a dashboard pick leaves. A pick matching nothing yields nothing rather than
// being ignored, so a total never shows under a label that does not describe it.
export function filterUsageRows(rows, projects = [], filter = {}) {
  if (!Object.values(filter).some((value) => (Array.isArray(value) ? value.length : value))) return rows;
  const owner = projectFinder(projects);
  const matches = (pick, key) =>
    !pick || (Array.isArray(pick) ? !pick.length || pick.includes(key) : pick === key);
  return rows.filter(
    (r) =>
      matches(filter.project, projectFilterKey(owner(r), r.repo)) &&
      matches(filter.model, modelFilterKey(r.provider, r.model)) &&
      matches(filter.provider, r.provider || 'unknown') &&
      matches(filter.activity, r.activity || 'unknown') &&
      matches(filter.account, r.accountId == null ? 'unknown' : String(r.accountId)) &&
      matches(filter.session, r.jobId),
  );
}

export function sessionUsage(rows) {
  const groups = new Map();
  for (const row of rows) {
    if (!groups.has(row.jobId)) groups.set(row.jobId, []);
    groups.get(row.jobId).push(row);
  }
  return [...groups]
    .map(([key, turns]) => ({
      key,
      label: turns.findLast((r) => r.sessionTitle)?.sessionTitle || key,
      repo: turns[0].repo,
      ...aggregateUsage(turns),
    }))
    .sort((a, b) => (b.costUsd ?? -1) - (a.costUsd ?? -1) || b.totalTokens - a.totalTokens);
}

export function usageInsights(rows) {
  const total = aggregateUsage(rows);
  const timed = rows.filter((r) => r.durationMs != null);
  return {
    costPerSession: total.costUsd == null ? null : total.costUsd / total.sessions,
    costPerTurn: total.costUsd == null ? null : total.costUsd / total.turns,
    averageDurationMs: timed.length ? timed.reduce((sum, r) => sum + r.durationMs, 0) / timed.length : null,
    reportedTurns: total.turns - total.estimatedTurns - total.unpricedTurns,
    timedTurns: timed.length,
  };
}

// Picker options, from the unfiltered window so a pick never removes itself or its
// siblings from the list. Options carry tokens so pickers sort by spend like the tables.
export function usageFilterOptions(rows, projects = []) {
  const choices = (key, label) => [
    ...new Map(rows.map((r) => [key(r), { key: key(r), label: label(r) }])).values(),
  ];
  return {
    providers: choices(
      (r) => r.provider || 'unknown',
      (r) => r.provider || 'Unattributed',
    ),
    activities: choices(
      (r) => r.activity || 'unknown',
      (r) => r.activity || 'Unattributed',
    ),
    accounts: choices(
      (r) => (r.accountId == null ? 'unknown' : String(r.accountId)),
      (r) =>
        r.accountId == null
          ? 'Unattributed (older usage)'
          : `${r.accountLabel || 'Account'} (#${r.accountId})`,
    ),
    sessions: sessionUsage(rows).map(({ key, label }) => ({ key, label })),
    projects: projectBreakdown(rows, projects).map(({ key, label, repo, gone, totalTokens }) => ({
      key,
      label,
      repo,
      gone,
      totalTokens,
    })),
    models: modelUsage(rows).map(({ key, provider, model, totalTokens }) => ({
      key,
      provider,
      model,
      totalTokens,
    })),
  };
}

// The ledger grouped by project: the main dashboard's table.
//
// A row matches by stable id first, so a renamed repo stays one group. Failing that it
// matches by repo, for rows without an id and rows whose project was deleted and
// re-added in Settings, which is still the same project to a reader.
//
// Unclaimed turns are kept under their repo, flagged `gone`, so totals never drop
// history. Every configured project is listed, at zero if it spent nothing.
export function projectBreakdown(rows, projects = []) {
  const owner = projectFinder(projects);
  const groups = new Map(); // projectFilterKey -> { project, repo, rows }
  const group = (project, repo) => {
    const key = projectFilterKey(project, repo);
    if (!groups.has(key))
      groups.set(key, { key, project, repo: project ? project.repo : repo || null, rows: [] });
    return groups.get(key);
  };
  for (const p of projects) group(p, p.repo);
  for (const r of rows) group(owner(r), r.repo).rows.push(r);
  return [...groups.values()]
    .map((g) => ({
      // What the dashboard filters this row's project by; see projectFilterKey.
      key: g.key,
      projectId: g.project ? g.project.id : null,
      repo: g.repo,
      label: g.project ? g.project.label : g.repo || 'unknown',
      gone: !g.project,
      ...aggregateUsage(g.rows),
    }))
    .sort((a, b) => b.totalTokens - a.totalTokens || a.label.localeCompare(b.label));
}

// Rows grouped by provider+model, biggest spender first.
export function modelUsage(rows) {
  const groups = new Map(); // "provider\nmodel" -> its rows
  for (const r of rows) {
    const key = `${r.provider || ''}\n${r.model || ''}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  return [...groups]
    .map(([key, group]) => {
      const [provider, model] = key.split('\n');
      return {
        // What the dashboard filters this row by; see modelFilterKey.
        key: modelFilterKey(provider, model),
        provider: provider || null,
        model: model || null,
        ...aggregateUsage(group),
      };
    })
    .sort((a, b) => b.totalTokens - a.totalTokens);
}

// Rows grouped by CLI, biggest token spender first; unrecorded providers group under null.
export function providerUsage(rows) {
  const groups = new Map(); // provider (or '') -> its rows
  for (const r of rows) {
    const key = r.provider || '';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  return [...groups]
    .map(([key, group]) => ({ provider: key || null, ...aggregateUsage(group) }))
    .sort((a, b) => b.totalTokens - a.totalTokens);
}

// Rows grouped by kind of work, sorted by cost first since this table answers "where
// did the money go". Rows without an activity group under null.
export function activityUsage(rows) {
  const groups = new Map(); // activity id (or '') -> its rows
  for (const r of rows) {
    const key = r.activity || '';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  return [...groups]
    .map(([key, group]) => ({ activity: key || null, ...aggregateUsage(group) }))
    .sort((a, b) => (b.costUsd || 0) - (a.costUsd || 0) || b.totalTokens - a.totalTokens);
}

export async function projectUsage(project, now = Date.now()) {
  const { from, to } = monthWindow(now);
  // The catalog fills in what the providers left null, over this window's rows
  // and no others: the cache share it prices them with is measured from the
  // turns beside them that recorded their cache reads. See lib/prices.js.
  const rows = await estimateCosts(await loadTurnUsage(project.id, project.repo, from, to), now);
  return {
    repo: project.repo,
    from,
    to,
    ...aggregateUsage(rows),
    daily: dailyUsage(rows, from, to),
    // Server-side "today" so the chart does not judge the future by a browser's zone.
    today: localDate(now),
    providers: providerUsage(rows),
    models: modelUsage(rows),
    activities: activityUsage(rows),
  };
}

// Every project over one usageWindow: the main dashboard. Deleted sessions still count.
export async function overallUsage(projects, period = 'month', now = Date.now(), filter = {}) {
  const window = usageWindow(period, now, filter);
  const all = await estimateCosts(await loadAllTurnUsage(window.from, window.to), now);
  // Pickers come from the whole window, numbers from the filtered rows. Both keys are
  // echoed back since either can outlive what it named (a retired model, a deleted project).
  const project = Array.isArray(filter.project) && !filter.project.length ? null : filter.project || null;
  const model = filter.model || null;
  const options = usageFilterOptions(all, projects);
  const rows = filterUsageRows(all, projects, filter);
  // With a project pick, list only the picked projects, not every other one at zero.
  const listed = project
    ? projects.filter((p) =>
        (Array.isArray(project) ? project : [project]).includes(projectFilterKey(p, p.repo)),
      )
    : projects;
  // Compare the elapsed part of the current month with the same part of last
  // month; completed months compare their full calendar windows.
  let comparison = null;
  if (window.from != null && window.from < now) {
    let from, to;
    const currentTo = Math.min(window.to, now);
    if (window.period === 'month' || window.period === 'prev') {
      const start = new Date(window.from);
      from = +new Date(start.getFullYear(), start.getMonth() - 1, 1);
      to =
        window.period === 'prev'
          ? window.from
          : Math.min(window.from, from + Math.max(0, currentTo - window.from));
    } else {
      const end = new Date(window.from);
      const days = Math.round((window.to - window.from) / 86400000);
      const start = new Date(end);
      start.setDate(start.getDate() - days);
      from = +start;
      to = Math.min(+end, from + Math.max(0, currentTo - window.from));
    }
    const previous = await estimateCosts(await loadAllTurnUsage(from, to), now);
    comparison = {
      from,
      to,
      partial: currentTo < window.to,
      ...aggregateUsage(filterUsageRows(previous, projects, filter)),
    };
  }
  // Days over a bounded window, months over all time; `unit` says which.
  const unit = window.from == null ? 'month' : 'day';
  return {
    ...window,
    // Named server-side: a browser west of here would read `from` as the previous month.
    month: window.from == null ? null : localMonth(window.from),
    unit,
    buckets: unit === 'day' ? dailyUsage(rows, window.from, window.to) : monthlyUsage(rows),
    // Server-side "today", as in projectUsage.
    today: localDate(now),
    ...aggregateUsage(rows),
    projects: projectBreakdown(rows, listed),
    providers: providerUsage(rows),
    models: modelUsage(rows),
    activities: activityUsage(rows),
    insights: usageInsights(rows),
    topSessions: sessionUsage(rows).slice(0, 10),
    comparison,
    filter: { ...filter, project, model },
    options,
  };
}

// Read-side cost estimates for session records, whose stored totals stay
// provider-reported (null for Codex). A lifetime aggregate calibrates them; the rows
// stay attached so each transcript footer can show its own estimate.
let calibrationRows = null;
let calibrationLoad = null;
let calibrationRevision = 0;

async function usageCalibrationRows() {
  if (calibrationRows) return calibrationRows;
  if (!calibrationLoad) {
    calibrationLoad = (async () => {
      // If a write lands during the aggregate query, retry once the ledger is
      // quiet rather than caching a snapshot that may or may not contain it.
      for (;;) {
        const revision = calibrationRevision;
        const rows = await loadTurnUsageCalibration();
        if (revision !== calibrationRevision) continue;
        calibrationRows = rows;
        return rows;
      }
    })().finally(() => {
      calibrationLoad = null;
    });
  }
  return calibrationLoad;
}

// Only for tests: the calibration is process-wide state.
export function resetUsageCalibration() {
  calibrationRows = null;
  calibrationLoad = null;
  calibrationRevision = 0;
}

export async function jobUsageEstimates(jobIds, now = Date.now()) {
  const requested = new Set((jobIds || []).filter(Boolean));
  if (!requested.size) return new Map();
  const [requestedRows, calibration] = await Promise.all([
    loadJobTurnUsage([...requested]),
    usageCalibrationRows(),
  ]);
  const rows = await estimateCosts(requestedRows, now, calibration);
  const groups = new Map();
  for (const row of rows) {
    if (!requested.has(row.jobId)) continue;
    if (!groups.has(row.jobId)) groups.set(row.jobId, []);
    groups.get(row.jobId).push(row);
  }
  const result = new Map();
  for (const [jobId, group] of groups) {
    const estimated = group.filter((row) => row.costEstimated);
    result.set(jobId, {
      estimatedCostUsd: estimated.length ? estimated.reduce((sum, row) => sum + row.costUsd, 0) : null,
      estimatedTurns: estimated.length,
      unpricedTurns: group.filter((row) => row.costUsd == null).length,
      rows: group,
    });
  }
  return result;
}

// Pair result events with ledger rows by time to show estimates without mutating
// stored events. Results without usage produced no row and must not consume one.
export function estimateEventCosts(events, rows) {
  const available = [...(rows || [])];
  return events.map((event) => {
    if (event.kind !== 'result' || event.costUsd != null || !available.length) return event;
    if (event.inputTokens == null && event.outputTokens == null && event.durationMs == null) return event;
    const at = Date.parse(event.t || '');
    let best = 0;
    if (Number.isFinite(at)) {
      for (let i = 1; i < available.length; i++) {
        if (Math.abs(available[i].at - at) >= Math.abs(available[best].at - at)) break;
        best = i;
      }
    }
    const [row] = available.splice(best, 1);
    if (!row?.costEstimated) return event;
    return { ...event, costUsd: row.costUsd, costEstimated: true };
  });
}

// Independent of the session record, so deleting a session keeps its spend.
export async function recordTurnUsage(job, turn, provider, model) {
  const row = turnUsageRecord(job, turn, provider, model);
  if (!row) return;
  // Waits up to a second so the result footer can read the row, but a stalled pool
  // must not hold the turn hostage; after that the write finishes in the background.
  return new Promise((resolve) => {
    let waiting = true;
    const timer = setTimeout(() => {
      waiting = false;
      resolve(false);
    }, 1000);
    timer.unref?.();
    saveTurnUsage(row)
      .then(() => {
        if (row.costUsd == null && row.inputTokens > 0 && row.cachedInputTokens != null) {
          calibrationRevision++;
          // Invalidate rather than append: the aggregate may already include this row.
          calibrationRows = null;
        }
      })
      .catch((e) => console.error(`turn usage not recorded for ${job.id}: ${e.message}`))
      .finally(() => {
        clearTimeout(timer);
        if (waiting) resolve(true);
      });
  });
}
