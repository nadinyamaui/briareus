import { describe, it, expect, vi } from 'vitest';

const db = vi.hoisted(() => ({ rows: [], all: [], saved: [] }));

vi.mock('../lib/config.js', () => ({ getConfig: () => ({}) }));
// The catalog behind the estimates has a test file of its own; here the rows
// are handed back untouched so the ledger arithmetic is what is under test.
vi.mock('../lib/prices.js', () => ({ estimateCosts: vi.fn(async (rows) => rows) }));
vi.mock('../lib/db.js', () => ({
  saveTurnUsage: vi.fn(async (row) => {
    db.saved.push(row);
  }),
  loadTurnUsage: vi.fn(async () => db.rows),
  loadAllTurnUsage: vi.fn(async () => db.all),
}));

const {
  turnUsageRecord,
  monthWindow,
  usageWindow,
  aggregateUsage,
  dailyUsage,
  localMonth,
  monthlyUsage,
  projectBreakdown,
  modelUsage,
  activityUsage,
  projectUsage,
  overallUsage,
  recordTurnUsage,
} = await import('../lib/usage.js');
const { loadTurnUsage, loadAllTurnUsage } = await import('../lib/db.js');

describe('turnUsageRecord', () => {
  const job = { id: 'j1', projectId: 7, repo: 'o/r' };
  it('captures what the provider reported, with a null cost when it priced nothing', () => {
    const turn = { inputTokens: 100, outputTokens: 20, costUsd: null, durationMs: 2500 };
    expect(turnUsageRecord(job, turn, { binary: 'codex' }, 'gpt-5', 123)).toEqual({
      projectId: 7,
      jobId: 'j1',
      repo: 'o/r',
      provider: 'codex',
      model: 'gpt-5',
      activity: null,
      inputTokens: 100,
      outputTokens: 20,
      costUsd: null,
      durationMs: 2500,
      at: 123,
    });
  });
  it('files the row under the session’s kind of work', () => {
    const turn = { inputTokens: 1, outputTokens: 1, costUsd: 0.25 };
    const record = turnUsageRecord({ ...job, activity: 'code-review' }, turn, { binary: 'claude' }, 'x');
    expect(record.activity).toBe('code-review');
  });
  it('keeps a reported cost', () => {
    const turn = { inputTokens: 1, outputTokens: 1, costUsd: 0.25 };
    expect(turnUsageRecord(job, turn, { binary: 'claude' }, 'x').costUsd).toBe(0.25);
  });
  it('is null for a turn that reported nothing', () => {
    const turn = { inputTokens: null, outputTokens: null, costUsd: null, durationMs: null };
    expect(turnUsageRecord(job, turn, null, null)).toBeNull();
  });
  it('keeps agent time even when a provider reports no token or cost figures', () => {
    const record = turnUsageRecord(
      job,
      { inputTokens: null, outputTokens: null, costUsd: null, durationMs: 900 },
      null,
      null,
    );
    expect(record).toMatchObject({ projectId: 7, jobId: 'j1', durationMs: 900 });
  });
});

describe('monthWindow', () => {
  it('spans the calendar month around the given instant', () => {
    const now = new Date(2026, 7, 26, 15, 0).getTime();
    const { from, to } = monthWindow(now);
    expect(from).toBe(new Date(2026, 7, 1).getTime());
    expect(to).toBe(new Date(2026, 8, 1).getTime());
    expect(from <= now && now < to).toBe(true);
  });
  it('rolls December into the next year', () => {
    const { to } = monthWindow(new Date(2026, 11, 31).getTime());
    expect(new Date(to).getFullYear()).toBe(2027);
    expect(new Date(to).getMonth()).toBe(0);
  });
});

describe('aggregateUsage', () => {
  it('counts distinct sessions and sums tokens and cost', () => {
    const t = aggregateUsage([
      { jobId: 'a', inputTokens: 100, outputTokens: 10, costUsd: 0.5, durationMs: 1000 },
      { jobId: 'a', inputTokens: 200, outputTokens: 20, costUsd: 0.25, durationMs: 2000 },
      { jobId: 'b', inputTokens: 50, outputTokens: null, costUsd: 0.1, durationMs: 500 },
    ]);
    expect(t).toEqual({
      turns: 3,
      sessions: 2,
      inputTokens: 350,
      outputTokens: 30,
      totalTokens: 380,
      durationMs: 3500,
      costUsd: 0.85,
      unpricedTurns: 0,
      estimatedTurns: 0,
    });
  });
  it('leaves cost null when no turn was priced, and counts the unpriced ones', () => {
    const t = aggregateUsage([
      { jobId: 'a', inputTokens: 1, outputTokens: 1, costUsd: null },
      { jobId: 'b', inputTokens: 1, outputTokens: 1, costUsd: null },
    ]);
    expect(t.costUsd).toBeNull();
    expect(t.unpricedTurns).toBe(2);
  });
  it('sums only the priced turns when providers are mixed', () => {
    const t = aggregateUsage([
      { jobId: 'a', inputTokens: 1, outputTokens: 1, costUsd: 2 },
      { jobId: 'b', inputTokens: 1, outputTokens: 1, costUsd: null },
    ]);
    expect(t.costUsd).toBe(2);
    expect(t.unpricedTurns).toBe(1);
  });
  it('counts the estimated turns inside the total separately from the unpriced ones', () => {
    const t = aggregateUsage([
      { jobId: 'a', inputTokens: 1, outputTokens: 1, costUsd: 2 },
      { jobId: 'b', inputTokens: 1, outputTokens: 1, costUsd: 1, costEstimated: true },
      { jobId: 'c', inputTokens: 1, outputTokens: 1, costUsd: null },
    ]);
    expect(t.costUsd).toBe(3);
    expect(t.estimatedTurns).toBe(1);
    expect(t.unpricedTurns).toBe(1);
  });
  it('is all zeros for an empty month', () => {
    expect(aggregateUsage([])).toEqual({
      turns: 0,
      sessions: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      durationMs: 0,
      costUsd: null,
      unpricedTurns: 0,
      estimatedTurns: 0,
    });
  });
});

describe('dailyUsage', () => {
  const { from, to } = monthWindow(new Date(2026, 7, 15).getTime());
  it('buckets turns by local calendar day and keeps the quiet days at zero', () => {
    const rows = [
      { at: new Date(2026, 7, 3, 9, 30).getTime(), inputTokens: 100, outputTokens: 10, costUsd: 0.5 },
      { at: new Date(2026, 7, 3, 23, 59).getTime(), inputTokens: 50, outputTokens: 5, costUsd: null },
      { at: new Date(2026, 7, 20).getTime(), inputTokens: 1, outputTokens: 1, costUsd: null },
    ];
    const days = dailyUsage(rows, from, to);
    expect(days).toHaveLength(31); // August, every day present
    expect(days[0]).toEqual({
      date: '2026-08-01',
      turns: 0,
      totalTokens: 0,
      costUsd: null,
      unpricedTurns: 0,
      estimatedTurns: 0,
    });
    // The day's cost is partial: one of its two turns carried no price, and
    // the count says so, the same disclosure the month totals make.
    expect(days[2]).toEqual({
      date: '2026-08-03',
      turns: 2,
      totalTokens: 165,
      costUsd: 0.5,
      unpricedTurns: 1,
      estimatedTurns: 0,
    });
    expect(days[19].turns).toBe(1);
  });
  it('drops a row outside the window instead of inventing a day for it', () => {
    const days = dailyUsage(
      [{ at: new Date(2026, 6, 31).getTime(), inputTokens: 9, outputTokens: 0 }],
      from,
      to,
    );
    expect(days.every((d) => d.turns === 0)).toBe(true);
  });
});

describe('modelUsage', () => {
  it('groups by provider and model, biggest token spender first', () => {
    const rows = [
      { jobId: 'a', provider: 'claude', model: 'opus', inputTokens: 10, outputTokens: 1, costUsd: 1 },
      { jobId: 'b', provider: 'claude', model: 'opus', inputTokens: 20, outputTokens: 2, costUsd: null },
      { jobId: 'b', provider: 'codex', model: 'gpt-5', inputTokens: 500, outputTokens: 50, costUsd: null },
    ];
    const models = modelUsage(rows);
    expect(models.map((m) => m.model)).toEqual(['gpt-5', 'opus']);
    expect(models[1]).toMatchObject({
      provider: 'claude',
      model: 'opus',
      turns: 2,
      sessions: 2,
      totalTokens: 33,
      costUsd: 1,
      unpricedTurns: 1,
    });
    expect(models[0].costUsd).toBeNull();
  });
  it('folds rows with no provider or model into one unnamed group', () => {
    const models = modelUsage([
      { jobId: 'a', provider: null, model: null, inputTokens: 1, outputTokens: 1 },
      { jobId: 'a', provider: null, model: null, inputTokens: 1, outputTokens: 1 },
    ]);
    expect(models).toHaveLength(1);
    expect(models[0]).toMatchObject({ provider: null, model: null, turns: 2 });
  });
});

describe('activityUsage', () => {
  it('groups by the kind of work, biggest spend first', () => {
    const rows = [
      { jobId: 'a', activity: 'chat', inputTokens: 900, outputTokens: 90, costUsd: 0.1 },
      { jobId: 'b', activity: 'code-review', inputTokens: 10, outputTokens: 1, costUsd: 2 },
      { jobId: 'c', activity: 'code-review', inputTokens: 20, outputTokens: 2, costUsd: 1 },
    ];
    const activities = activityUsage(rows);
    // Cost outranks tokens: this table answers "where did the money go", and
    // the cheap-but-chatty session must not sit above the expensive review.
    expect(activities.map((a) => a.activity)).toEqual(['code-review', 'chat']);
    expect(activities[0]).toMatchObject({
      activity: 'code-review',
      sessions: 2,
      turns: 2,
      totalTokens: 33,
      costUsd: 3,
    });
  });
  it('ranks unpriced groups by tokens among themselves', () => {
    const rows = [
      { jobId: 'a', activity: 'qa', inputTokens: 5, outputTokens: 5, costUsd: null },
      { jobId: 'b', activity: 'chat', inputTokens: 500, outputTokens: 50, costUsd: null },
    ];
    expect(activityUsage(rows).map((a) => a.activity)).toEqual(['chat', 'qa']);
  });
  it('keeps rows written before the ledger carried an activity, under null', () => {
    const activities = activityUsage([
      { jobId: 'a', inputTokens: 1, outputTokens: 1, costUsd: 0.5 },
      { jobId: 'a', activity: null, inputTokens: 1, outputTokens: 1, costUsd: null },
    ]);
    expect(activities).toHaveLength(1);
    expect(activities[0]).toMatchObject({ activity: null, turns: 2, costUsd: 0.5, unpricedTurns: 1 });
  });
});

describe('projectUsage', () => {
  it('queries the current month for the repo and returns the totals', async () => {
    db.rows = [{ jobId: 'a', inputTokens: 5, outputTokens: 5, costUsd: null, durationMs: 1234 }];
    const now = new Date(2026, 2, 15).getTime();
    const project = { id: 7, repo: 'o/r' };
    const u = await projectUsage(project, now);
    const { from, to } = monthWindow(now);
    expect(loadTurnUsage).toHaveBeenCalledWith(7, 'o/r', from, to);
    expect(u).toMatchObject({
      repo: 'o/r',
      from,
      to,
      sessions: 1,
      totalTokens: 10,
      durationMs: 1234,
      costUsd: null,
    });
  });
  it('carries the dashboard breakdowns: one bucket per day, the model and activity groups', async () => {
    const now = new Date(2026, 2, 15).getTime();
    db.rows = [
      {
        jobId: 'a',
        provider: 'claude',
        model: 'opus',
        activity: 'qa',
        inputTokens: 5,
        outputTokens: 5,
        at: now,
      },
    ];
    const u = await projectUsage({ id: 7, repo: 'o/r' }, now);
    expect(u.daily).toHaveLength(31); // March
    expect(u.today).toBe('2026-03-15'); // the server's calendar, for the chart's future check
    expect(u.daily[14]).toMatchObject({ turns: 1, totalTokens: 10 });
    expect(u.models).toEqual([expect.objectContaining({ provider: 'claude', model: 'opus', turns: 1 })]);
    expect(u.activities).toEqual([expect.objectContaining({ activity: 'qa', turns: 1 })]);
  });
});

describe('usageWindow', () => {
  const now = new Date(2026, 0, 20, 9, 0).getTime(); // January, so `prev` crosses a year

  it('spans last month for `prev`', () => {
    const w = usageWindow('prev', now);
    expect(w).toEqual({
      period: 'prev',
      from: new Date(2025, 11, 1).getTime(),
      to: new Date(2026, 0, 1).getTime(),
    });
  });
  // Recut on every call rather than once per pane: a dashboard left open across
  // midnight on the 1st asks again on its next refresh and gets the window the
  // picker now means, instead of sitting on the one it was opened in.
  it('recuts both month windows when the calendar rolls over', () => {
    const before = new Date(2026, 0, 31, 23, 59).getTime();
    const after = new Date(2026, 1, 1, 0, 1).getTime();
    expect(usageWindow('month', before).from).toBe(new Date(2026, 0, 1).getTime());
    expect(usageWindow('month', after).from).toBe(new Date(2026, 1, 1).getTime());
    expect(usageWindow('prev', before).from).toBe(new Date(2025, 11, 1).getTime());
    expect(usageWindow('prev', after).from).toBe(new Date(2026, 0, 1).getTime());
  });
  it('leaves all time unbounded rather than starting it at the epoch', () => {
    expect(usageWindow('all', now)).toEqual({ period: 'all', from: null, to: null });
  });
  it('reads anything it does not know as this month', () => {
    expect(usageWindow('last-tuesday', now)).toEqual({ period: 'month', ...monthWindow(now) });
  });
});

describe('monthlyUsage', () => {
  it('buckets by calendar month from the oldest row to the newest, gaps included', () => {
    const rows = [
      { at: new Date(2026, 0, 5).getTime(), inputTokens: 10, outputTokens: 1, costUsd: 0.5 },
      { at: new Date(2026, 2, 9).getTime(), inputTokens: 20, outputTokens: 2, costUsd: null },
      { at: new Date(2026, 2, 28).getTime(), inputTokens: 5, outputTokens: 0, costUsd: 0.25 },
    ];
    const months = monthlyUsage(rows);
    expect(months.map((m) => m.date)).toEqual(['2026-01', '2026-02', '2026-03']);
    expect(months[0]).toEqual({
      date: '2026-01',
      turns: 1,
      totalTokens: 11,
      costUsd: 0.5,
      unpricedTurns: 0,
      estimatedTurns: 0,
    });
    expect(months[1].turns).toBe(0); // the quiet month is still drawn
    expect(months[2]).toEqual({
      date: '2026-03',
      turns: 2,
      totalTokens: 27,
      costUsd: 0.25,
      unpricedTurns: 1,
      estimatedTurns: 0,
    });
  });
  it('is empty for an empty ledger rather than inventing a month', () => {
    expect(monthlyUsage([])).toEqual([]);
  });
  it('names a month on the local calendar', () => {
    expect(localMonth(new Date(2026, 7, 31, 23, 30).getTime())).toBe('2026-08');
  });
});

describe('projectBreakdown', () => {
  const projects = [
    { id: 1, repo: 'o/one', label: 'One' },
    { id: 2, repo: 'o/two', label: 'Two' },
  ];

  it('groups by the stable project id, biggest token spender first', () => {
    const rows = [
      { projectId: 1, repo: 'o/one', jobId: 'a', inputTokens: 10, outputTokens: 1, costUsd: 0.5 },
      { projectId: 2, repo: 'o/two', jobId: 'b', inputTokens: 500, outputTokens: 50, costUsd: null },
      { projectId: 2, repo: 'o/two', jobId: 'c', inputTokens: 1, outputTokens: 1, costUsd: 1 },
    ];
    const out = projectBreakdown(rows, projects);
    expect(out.map((p) => p.label)).toEqual(['Two', 'One']);
    expect(out[0]).toMatchObject({
      projectId: 2,
      repo: 'o/two',
      gone: false,
      sessions: 2,
      turns: 2,
      totalTokens: 552,
      costUsd: 1,
      unpricedTurns: 1,
    });
  });

  it('keeps a project renamed since the turns were written in one group', () => {
    const rows = [
      { projectId: 1, repo: 'o/old-name', jobId: 'a', inputTokens: 10, outputTokens: 0 },
      { projectId: 1, repo: 'o/one', jobId: 'b', inputTokens: 10, outputTokens: 0 },
    ];
    const one = projectBreakdown(rows, projects).find((p) => p.projectId === 1);
    expect(one).toMatchObject({ repo: 'o/one', turns: 2, sessions: 2, totalTokens: 20 });
  });

  it('claims rows written before project_id existed by repository name', () => {
    const rows = [{ projectId: null, repo: 'O/ONE', jobId: 'a', inputTokens: 4, outputTokens: 0 }];
    const out = projectBreakdown(rows, projects);
    expect(out[0]).toMatchObject({ projectId: 1, label: 'One', turns: 1 });
    expect(out.some((p) => p.gone)).toBe(false);
  });

  it('gives a repository re-added to Settings the history of the row it replaced', () => {
    // Project 1 was deleted and set up again as project 5 on the same repo. The
    // turns were spent on that repository either way, so they belong to the one
    // live row for it rather than to a greyed-out twin beside it.
    const readded = [{ id: 5, repo: 'o/one', label: 'One' }];
    const rows = [
      { projectId: 1, repo: 'o/one', jobId: 'a', inputTokens: 10, outputTokens: 0, costUsd: 1 },
      { projectId: 5, repo: 'o/one', jobId: 'b', inputTokens: 4, outputTokens: 0, costUsd: 2 },
    ];
    const out = projectBreakdown(rows, readded);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      projectId: 5,
      gone: false,
      sessions: 2,
      turns: 2,
      totalTokens: 14,
      costUsd: 3,
    });
  });

  it('still counts the turns of a project that has been deleted from Settings', () => {
    const rows = [
      { projectId: 9, repo: 'o/gone', jobId: 'a', inputTokens: 100, outputTokens: 10, costUsd: 2 },
      { projectId: 9, repo: 'o/gone', jobId: 'b', inputTokens: 1, outputTokens: 1, costUsd: null },
    ];
    const out = projectBreakdown(rows, projects);
    const gone = out.find((p) => p.gone);
    expect(gone).toMatchObject({
      projectId: null,
      repo: 'o/gone',
      label: 'o/gone',
      sessions: 2,
      turns: 2,
      totalTokens: 112,
      costUsd: 2,
      unpricedTurns: 1,
    });
  });

  it('lists a configured project that spent nothing, at zero', () => {
    const out = projectBreakdown([], projects);
    expect(out.map((p) => p.label)).toEqual(['One', 'Two']);
    expect(out[0]).toMatchObject({ turns: 0, sessions: 0, totalTokens: 0, costUsd: null });
  });
});

describe('overallUsage', () => {
  const projects = [{ id: 1, repo: 'o/one', label: 'One' }];

  it('sums every project over the picked month and buckets it by day', async () => {
    const now = new Date(2026, 2, 15).getTime();
    db.all = [
      {
        projectId: 1,
        repo: 'o/one',
        jobId: 'a',
        provider: 'claude',
        model: 'opus',
        activity: 'implement-feedback',
        inputTokens: 5,
        outputTokens: 5,
        costUsd: 0.5,
        at: now,
      },
      {
        projectId: 9,
        repo: 'o/gone',
        jobId: 'b',
        provider: 'codex',
        model: 'gpt-5',
        activity: 'chat',
        inputTokens: 1,
        outputTokens: 1,
        costUsd: null,
        at: now,
      },
    ];
    const u = await overallUsage(projects, 'month', now);
    const { from, to } = monthWindow(now);
    expect(loadAllTurnUsage).toHaveBeenCalledWith(from, to);
    expect(u).toMatchObject({
      period: 'month',
      from,
      to,
      unit: 'day',
      today: '2026-03-15',
      // Named on this process's calendar, not left for a browser west of it to
      // read back off `from` and call February.
      month: '2026-03',
      turns: 2,
      sessions: 2,
      totalTokens: 12,
    });
    expect(u.buckets).toHaveLength(31); // March
    expect(u.buckets[14]).toMatchObject({ turns: 2, totalTokens: 12 });
    expect(u.projects.map((p) => p.label)).toEqual(['One', 'o/gone']);
    expect(u.models.map((m) => m.model)).toEqual(['opus', 'gpt-5']);
    expect(u.activities.map((a) => a.activity)).toEqual(['implement-feedback', 'chat']);
  });

  it('asks for the whole ledger and buckets it by month for all time', async () => {
    db.all = [
      {
        projectId: 1,
        repo: 'o/one',
        jobId: 'a',
        inputTokens: 5,
        outputTokens: 5,
        at: new Date(2025, 10, 2).getTime(),
      },
      {
        projectId: 1,
        repo: 'o/one',
        jobId: 'a',
        inputTokens: 5,
        outputTokens: 5,
        at: new Date(2026, 0, 2).getTime(),
      },
    ];
    const u = await overallUsage(projects, 'all', new Date(2026, 0, 20).getTime());
    expect(loadAllTurnUsage).toHaveBeenCalledWith(null, null);
    expect(u).toMatchObject({ period: 'all', from: null, to: null, unit: 'month', turns: 2, sessions: 1 });
    expect(u.month).toBeNull(); // all time has no month to name
    expect(u.buckets.map((b) => b.date)).toEqual(['2025-11', '2025-12', '2026-01']);
  });

  it('names last month on this calendar too', async () => {
    db.all = [];
    const u = await overallUsage(projects, 'prev', new Date(2026, 0, 20).getTime());
    expect(u.month).toBe('2025-12');
  });
});

describe('recordTurnUsage', () => {
  it('writes a row for a reporting turn and skips a silent one', async () => {
    db.saved = [];
    const job = { id: 'j', projectId: 7, repo: 'o/r' };
    recordTurnUsage(job, { inputTokens: 1, outputTokens: 2, costUsd: 0.1 }, { binary: 'claude' }, 'm');
    recordTurnUsage(job, { inputTokens: null, outputTokens: null, costUsd: null }, null, null);
    await Promise.resolve();
    expect(db.saved).toHaveLength(1);
    expect(db.saved[0]).toMatchObject({
      projectId: 7,
      jobId: 'j',
      provider: 'claude',
      model: 'm',
      costUsd: 0.1,
    });
  });
});
