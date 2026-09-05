// @ts-check
import { saveTurnUsage, loadTurnUsage, loadAllTurnUsage } from './db.js';
import { estimateCosts } from './prices.js';

// The per-turn spend ledger and the sums drawn from it. Each row belongs to the
// stable project id as well as naming the originating session, so the session
// can be deleted without deleting its stats. This module stays separate so its
// pure parts can be tested without jobs.js's process orchestration around them.

// The turn as one ledger row, or null when the provider reported nothing worth
// keeping: a canceled turn that never reached its result message has no usage
// to record, and a row of NULLs would only inflate the session count.
export function turnUsageRecord(job, turn, provider, model, now = Date.now()) {
  const inputTokens = turn.inputTokens ?? null;
  const outputTokens = turn.outputTokens ?? null;
  const costUsd = turn.costUsd ?? null;
  const durationMs = turn.durationMs ?? null;
  if (inputTokens == null && outputTokens == null && costUsd == null && durationMs == null) return null;
  return {
    projectId: job.projectId ?? null,
    jobId: job.id,
    repo: job.repo ?? null,
    provider: provider?.binary ?? null,
    model: model ?? null,
    // What kind of work the turn paid for (jobs.js names it at creation):
    // 'code-review', 'qa', a board action's id, 'orchestrator', 'worker' or
    // 'chat'. A session records every turn under its own kind, so a review's
    // publish turn is still review spend.
    activity: job.activity ?? null,
    inputTokens,
    outputTokens,
    // The provider's own figure or nothing: a CLI that does not price its
    // turns leaves this null, and the ledger never stores a number nobody
    // charged. What the dashboard shows for those turns is put on them when
    // the rows are read (lib/prices.js) and marked as the estimate it is, so
    // the record itself stays what the providers said.
    costUsd,
    durationMs,
    at: now,
  };
}

// One of the main dashboard's three windows (`month`, `prev` or `all`, the
// ids its picker is built on) as an epoch-millis half-open window in local
// time, the same clock the person reading "this month" is on. All time has no
// bounds at all rather than a `from` of 0, so the query can leave the range off
// entirely. An unknown period is this month, so a hand-typed query string
// cannot produce a window nothing can be said about.
export function usageWindow(period = 'month', now = Date.now()) {
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

// Sum a set of ledger rows. Tokens add up across every row; cost adds up only
// over the rows that carry one, and `costUsd` stays null when none did so the
// UI can tell "free" from "unpriced". `unpricedTurns` says how many rows the
// cost total is missing, and `estimatedTurns` how many of the ones in it were
// priced from the catalog rather than by their provider, so a total nobody was
// invoiced for never reads as one that somebody was.
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

// "2026-08-03": the calendar day as this process's zone reads it. The daily
// buckets travel as these strings, not epochs: an epoch for "midnight here"
// re-read by a browser in another zone lands on the previous or next day.
export function localDate(at) {
  const d = new Date(at);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// The month bucketed by local calendar day, for the dashboard's daily chart.
// Every day of [from, to) is present, zeros included: a chart that skips the
// quiet days reads as a shorter month than the one it draws.
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
    // Cost follows aggregateUsage's rule: the sum of what was priced, with the
    // unpriced turns counted so the day can wear the same `+` the totals do.
    if (r.costUsd == null) day.unpricedTurns += 1;
    else {
      day.costUsd = (day.costUsd || 0) + r.costUsd;
      if (r.costEstimated) day.estimatedTurns += 1;
    }
  }
  return [...days.values()];
}

// "2026-08": the calendar month, cut on the same clock as localDate and
// travelling as a string for the same reason.
export function localMonth(at) {
  return localDate(at).slice(0, 7);
}

// dailyUsage's shape, one bucket per calendar month from the oldest row to the
// newest. This is what "all time" charts: a bar per day over a year of history
// is a thousand hairlines nobody can read a shape out of. The span comes from
// the rows themselves, since the window has no bounds to walk.
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

// The ledger grouped by the project the turns were spent on: the main
// dashboard's table.
//
// A row finds its project by the stable id first, which is what keeps the
// history of a project renamed since those turns were written in one group
// rather than splitting it across the old repo name and the new one.
//
// Failing that it matches on repository, and deliberately so for two different
// rows: one written before `project_id` existed, which carries no id at all,
// and one whose id belonged to a project since deleted from Settings and
// re-added. Both are turns spent on that repository, and the repository is what
// a reader means by "the project": a Settings row deleted and recreated is a
// config gesture, not a second project, and splitting a repo's history into a
// live row and a greyed-out twin because of one would be the wrong answer.
//
// Turns no configured project claims at all are still kept, under the
// repository they name and flagged `gone`: a project deleted from Settings
// takes no money back, and a total that quietly dropped its history would be
// the wrong number. Every configured project is listed too, at zero when it
// spent nothing, since "this project ran nothing this month" is an answer, not an
// omission.
export function projectBreakdown(rows, projects = []) {
  const byId = new Map(projects.map((p) => [p.id, p]));
  const byRepo = new Map(projects.map((p) => [String(p.repo || '').toLowerCase(), p]));
  const groups = new Map(); // "p:<id>" / "r:<repo>" -> { project, repo, rows }
  const group = (project, repo) => {
    const key = project ? `p:${project.id}` : `r:${String(repo || '').toLowerCase()}`;
    if (!groups.has(key)) groups.set(key, { project, repo: project ? project.repo : repo || null, rows: [] });
    return groups.get(key);
  };
  for (const p of projects) group(p, p.repo);
  for (const r of rows) {
    const project = byId.get(r.projectId) || byRepo.get(String(r.repo || '').toLowerCase()) || null;
    group(project, r.repo).rows.push(r);
  }
  return [...groups.values()]
    .map((g) => ({
      projectId: g.project ? g.project.id : null,
      repo: g.repo,
      label: g.project ? g.project.label : g.repo || 'unknown',
      gone: !g.project,
      ...aggregateUsage(g.rows),
    }))
    .sort((a, b) => b.totalTokens - a.totalTokens || a.label.localeCompare(b.label));
}

// The same rows grouped by provider+model, biggest spender first: the
// dashboard's breakdown table. Cost keeps aggregateUsage's rule: null until a
// turn in the group actually carried a price.
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
      return { provider: provider || null, model: model || null, ...aggregateUsage(group) };
    })
    .sort((a, b) => b.totalTokens - a.totalTokens);
}

// The same rows grouped by the kind of work they paid for, biggest spend
// first: what "where did the money go" reads. Cost outranks tokens in the sort
// because that is the question this table answers; both fall back through
// aggregateUsage's rules. Rows written before the ledger carried an activity
// group under null, which the UI labels rather than guessing what they were.
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
  // priced turns beside them. See lib/prices.js.
  const rows = await estimateCosts(await loadTurnUsage(project.id, project.repo, from, to), now);
  return {
    repo: project.repo,
    from,
    to,
    ...aggregateUsage(rows),
    daily: dailyUsage(rows, from, to),
    // Which of those buckets is still ahead is this clock's call too, and the
    // chart must not judge "future" against a browser clock in another zone.
    today: localDate(now),
    models: modelUsage(rows),
    activities: activityUsage(rows),
  };
}

// Every project at once, over one of usageWindow's windows: the main
// dashboard. Deleted sessions count here as they do everywhere: the ledger is
// written independently of the session record, so trashing a conversation
// leaves the tokens it burned on its project's total.
export async function overallUsage(projects, period = 'month', now = Date.now()) {
  const window = usageWindow(period, now);
  const rows = await estimateCosts(await loadAllTurnUsage(window.from, window.to), now);
  // Days over a bounded month, months over the whole history; see
  // monthlyUsage. Which one the payload carries is on it, since the axis and
  // the "not yet" cut differ.
  const unit = window.from == null ? 'month' : 'day';
  return {
    ...window,
    // What the window is called, named here rather than left to the reader.
    // `from` is midnight on the 1st of *this* process's calendar, and a browser
    // west of it reads that instant as the month before, so August's totals would
    // wear July's name. All time has no month to name, so it is null.
    month: window.from == null ? null : localMonth(window.from),
    unit,
    buckets: unit === 'day' ? dailyUsage(rows, window.from, window.to) : monthlyUsage(rows),
    // The server's calendar again: the chart must not judge "future" against a
    // browser clock in another zone.
    today: localDate(now),
    ...aggregateUsage(rows),
    projects: projectBreakdown(rows, projects),
    models: modelUsage(rows),
    activities: activityUsage(rows),
  };
}

// Written independently from the session record: deleting that record never
// targets this project ledger.
export function recordTurnUsage(job, turn, provider, model) {
  const row = turnUsageRecord(job, turn, provider, model);
  if (!row) return;
  saveTurnUsage(row).catch((e) => console.error(`turn usage not recorded for ${job.id}: ${e.message}`));
}
