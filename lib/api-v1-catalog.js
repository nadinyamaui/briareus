// @ts-check
// The client API's contract as data: every /api/v1 route, its inputs and answer.
// The gateway (lib/api-v1.js) and the OpenAPI document and docs reference
// (lib/api-v1-docs.js) are all built from it, so they cannot disagree. No imports.

// A type is written the way the reference prints it: `string`, `integer`,
// `number`, `boolean`, `object`, an object named in OBJECTS, `a|b|c` for one
// of several strings, with `[]` after it for a list and `?` for "or null".

// What a field means wherever it appears. A route whose field means something
// else says so in its own `fields`.
export const FIELDS = {
  // ---- query ----
  repo: ['string', 'A project, as `owner/name`'],
  fresh: ['0|1', '`1` skips the server’s short cache and reads again'],
  page: ['integer', 'Which page of 100 rows, 1–30; 1 when absent'],
  headSha: ['string', 'The `pr.headSha` of an earlier page; 409 if the pull request has moved since'],
  baseSha: ['string', 'The `pr.baseSha` of an earlier page; 409 if the pull request has moved since'],
  since: ['integer', 'Only transcript lines whose `seq` is above this; 0 when absent'],
  all: ['0|1', '`1` includes the lines a Clear or a compaction hid'],
  name: ['string', 'The file’s name'],
  transcripts: ['0|1', '`1` also sends a `transcript` event for every transcript line'],
  period: ['today|7d|30d|month|prev|all|custom', 'The window; `month` when absent'],
  from: ['string', 'First day, `YYYY-MM-DD`, with `period=custom`'],
  to: ['string', 'Last day, `YYYY-MM-DD`, with `period=custom`'],
  project: ['string', 'Only this project; a key from the response’s `options.projects`. Repeatable'],
  account: ['string', 'Only this account; a key from `options.accounts`. Repeatable'],
  session: ['string', 'Only this session; a key from `options.sessions`. Repeatable'],
  // ---- starting work ----
  prompt: ['string', 'The first message to the agent'],
  provider: ['integer', 'A provider id from `GET /runtimes`; the project’s configured runtime when absent'],
  model: ['string', 'A model of that provider; its default when absent'],
  effort: ['string', 'An effort that model offers; its default when absent'],
  branch: ['string', 'An existing branch to work on; a fresh branch off the default one when absent'],
  prNumber: ['integer', 'The pull request the work is about'],
  qa: ['boolean', 'Start a QA run on `branch`: a test sheet, then its execution'],
  local: ['boolean', 'Work in the project’s local checkout instead of a workspace clone'],
  orchestrator: ['boolean', 'Start a supervisor that runs worker sessions instead of editing code'],
  workerRuntime: ['object', '`{ providerId, model, effort }` an orchestrator’s workers default to'],
  attachments: ['string[]', 'Upload ids from `POST /uploads`'],
  qaLoop: ['boolean', 'Run QA after the task settles'],
  activity: ['string', 'What to file the spend under; `issue` is the only value taken'],
  action: ['string', 'An errand id from `GET /actions`'],
  input: ['string', 'The answer to what the errand asks, when it asks something'],
  // ---- sessions ----
  text: ['string', 'The text'],
  title: ['string', 'The new title'],
  autoCompact: ['boolean', 'Whether the session compacts itself when its context fills'],
  compactInstructions: ['string', 'What every compaction of this session must keep; empty clears it'],
  pinned: ['boolean', 'Pin the session so it leads the session list, or unpin it'],
  profile: ['string', 'One of the project’s run profiles; the one served last when absent'],
  on: ['boolean', 'Armed or not'],
  pr: ['string', 'A pull request number or URL'],
  verdicts: [
    'object[]',
    'One `{ key, decision, reason }` per finding; decision is `fix`, `optional`, `dismissed` or null',
  ],
  note: ['string', 'A note to post with the verdicts'],
  key: ['string', 'The finding’s `key`'],
  decision: ['fix|optional|dismissed?', 'The verdict; null clears it'],
  fingerprint: ['string', 'The `fingerprint` of the recovery report this resumes from'],
  uploadId: ['string', 'The annotated screenshot, from `POST /uploads`'],
  url: ['string', 'The preview page the feedback is about'],
  width: ['integer', 'Screenshot width in image pixels'],
  height: ['integer', 'Screenshot height in image pixels'],
  x: ['number', 'The marked point, from the screenshot’s left edge'],
  y: ['number', 'The marked point, from the screenshot’s top edge'],
  // ---- pull requests ----
  method: ['squash|merge|rebase', 'How to merge; `squash` when absent'],
  baseRef: ['string', 'The base branch the pull request was read with'],
  // ---- settings ----
  ids: ['integer[]', 'Every id, in the new order'],
  values: ['object', 'Template text keyed by template id; an empty string restores the built-in'],
  label: ['string', 'A name to show'],
  repos: ['string[]', 'Projects, as `owner/name`'],
  permission: ['read|manage|admin', 'What the token may do'],
  days: ['integer', 'Days until it expires, 1–365'],
  enabled: ['boolean', 'Switched on or not'],
  draining: ['boolean', 'Whether to stop accepting new work'],
  planId: ['string', 'The `id` of the plan from `POST /deployments/plan`'],
};

const str = (about) => ['string', about];
const id = (about) => ['integer', about];

const CI_METRICS = {
  total: ['integer', 'Distinct observed executions (legacy statuses: one per SHA/context)'],
  pending: ['integer', 'Queued, waiting or running checks'],
  succeeded: ['integer', 'Completed successfully'],
  failed: ['integer', 'Failure, error, timeout, startup failure or action required'],
  cancelled: ['integer', 'Cancelled executions'],
  skipped: ['integer', 'Skipped or neutral executions'],
  other: ['integer', 'Other terminal conclusions, including a missing conclusion'],
  successRate: ['number?', 'succeeded / (succeeded + failed), 0–1; null without decided results'],
  timed: ['integer', 'Executions with valid start and completion timestamps'],
  avgDurationMs: ['number?', 'Mean duration of timed executions; null when none'],
  maxDurationMs: ['number?', 'Longest timed execution; null when none'],
  totalDurationMs: ['number', 'Sum of timed execution durations, not wall time or billed minutes'],
  pricedDurationMs: ['number', 'Part of totalDurationMs run on a runner group that has an hourly rate'],
  unpricedDurationMs: ['number', 'Part of totalDurationMs with no runner recorded or no rate for its group'],
  cost: [
    'number?',
    'pricedDurationMs at each group’s hourly rate, in `currency`; null when nothing is priced',
  ],
  lastObservedAt: ['integer?', 'Most recent successful observation, epoch milliseconds'],
};

// The objects the routes hand back. Each lists the fields a client can rely
// on; the server may send more, and a client ignores what it does not know.
export const OBJECTS = {
  CiMetrics: { about: 'CI/CD metrics for observed GitHub checks.', fields: CI_METRICS },
  CiDailyMetrics: {
    about: 'One non-empty UTC day.',
    fields: { day: str('UTC date, YYYY-MM-DD'), ...CI_METRICS },
  },
  CiRepositoryMetrics: {
    about: 'Metrics for one repository.',
    fields: { repo: str('owner/name'), ...CI_METRICS },
  },
  CiNamedMetrics: {
    about: 'Metrics for one check name and GitHub App.',
    fields: {
      name: str('Check name or status context'),
      app: ['string?', 'GitHub App slug, if available'],
      ...CI_METRICS,
    },
  },
  CiRunnerGroupMetrics: {
    about: 'Metrics for one GitHub Actions runner group; null holds checks without a recorded runner.',
    fields: { runnerGroup: ['string?', 'Runner group name as GitHub reports it'], ...CI_METRICS },
  },
  CiRunnerMetrics: {
    about: 'Metrics for one runner (the machine or slot that ran the jobs) within its group.',
    fields: {
      runnerGroup: ['string?', 'Runner group name'],
      runnerName: ['string?', 'Runner name'],
      ...CI_METRICS,
    },
  },
  CiRunner: {
    about: 'Where a GitHub Actions job ran.',
    fields: {
      name: ['string?', 'Runner name; null when the job never got one'],
      group: ['string?', 'Runner group name, e.g. Default or GitHub Actions'],
      labels: ['string[]', 'The labels the job asked for'],
    },
  },
  CiRates: {
    about: 'Hourly cost per runner group, applied to job durations when CI cost is reported.',
    fields: {
      currency: str('Three-letter currency code; USD by default'),
      groups: ['object', 'Runner group name → cost per runner-hour (≥ 0); a group not listed is unpriced'],
    },
  },
  CiRun: {
    about: 'A durable observed GitHub check, retained across PR head changes and core restarts.',
    fields: {
      repo: str('owner/name'),
      kind: ['check_run|status', 'GitHub Checks or legacy commit status'],
      id: str('GitHub ID; for legacy statuses, the latest transition ID'),
      name: str('Check name or status context'),
      app: ['string?', 'GitHub App slug'],
      headSha: str('Commit SHA'),
      branch: ['string?', 'Branch hint when known; a SHA can belong to multiple branches'],
      status: str('GitHub check status; legacy pending maps to in_progress'),
      conclusion: ['string?', 'GitHub conclusion or legacy state'],
      url: ['string?', 'Details URL'],
      startedAt: ['integer?', 'Start, epoch milliseconds'],
      completedAt: ['integer?', 'Completion, epoch milliseconds'],
      durationMs: ['integer?', 'Completion minus start; unavailable for legacy statuses'],
      runner: ['CiRunner?', 'The runner, for GitHub Actions jobs once recorded'],
      cost: ['number?', 'durationMs at the runner group’s hourly rate, in `currency`; null when unpriced'],
      runAt: ['integer', 'Start, legacy creation time or first observation, epoch milliseconds'],
      observedAt: ['integer', 'Last accepted observation, epoch milliseconds'],
    },
  },
  HomeAssistantData: {
    about:
      'A JSON object of Home Assistant service or event data. Field names and values depend on the selected service or event; entity_id may be a string or an array of entity IDs.',
    fields: {},
  },
  HomeAssistantEntity: {
    about: 'A Home Assistant entity read live through the operator bridge.',
    fields: {
      id: ['string', 'Home Assistant entity_id, such as light.kitchen'],
      name: ['string', 'Friendly name, or the entity ID'],
      state: ['string', 'Current state, including unknown or unavailable'],
      attributes: ['object', 'Domain-specific attributes from Home Assistant'],
      lastChanged: ['string?', 'ISO timestamp of the last state change'],
      lastUpdated: ['string?', 'ISO timestamp of the last state or attribute update'],
    },
  },
  Client: {
    about: 'A token’s own record. The token itself is shown once, when it is created.',
    fields: {
      id: str('Its id'),
      userId: id('The user it belongs to'),
      label: str('The name it was given'),
      permission: [
        'read|manage|admin',
        'What it may do; an admin token held by a member acts as `manage`, held to its projects',
      ],
      repos: ['string[]', 'The projects it is held to; empty for an admin token, which is held to none'],
      createdAt: id('When it was issued, epoch milliseconds'),
      expiresAt: id('When it stops working, epoch milliseconds'),
      lastUsedAt: [
        'integer?',
        'Last recorded authenticated request, epoch milliseconds; saved at most once per minute, null until recorded',
      ],
    },
  },
  User: {
    about:
      'A person who shares this server. Every token belongs to one, and acts as them; a disabled user’s tokens stop working.',
    fields: {
      id: id('Its id'),
      name: str('The name it was given, unique on this server'),
      role: [
        'admin|member',
        'An admin runs the server and reaches every project; a member only what they are given',
      ],
      disabled: ['boolean', 'Disabled on the server: their tokens answer 401 until they are enabled again'],
    },
  },
  HomeAssistantConnection: {
    about: 'Your own Home Assistant on this server, if you connected one. The token is never sent back.',
    fields: {
      connected: ['boolean', 'Whether one is stored'],
      url: ['string?', 'Its address'],
    },
  },
  GithubIdentity: {
    about: 'Your own GitHub account on this server, if you connected one. The token is never sent back.',
    fields: {
      connected: ['boolean', 'Whether a token is stored'],
      login: ['string?', 'The GitHub login it belongs to'],
    },
  },
  Share: {
    about: 'One project or server shared with one user.',
    fields: {
      kind: ['project|dbServer|sshServer|mcpServer|forgeAccount|envoyerAccount', 'What is shared'],
      id: str('Its id, as a string'),
      userId: id('The user it is shared with'),
    },
  },
  ProjectSummary: {
    about: 'A project as a session picker needs it.',
    fields: {
      repo: str('`owner/name`'),
      label: str('Its display name'),
      hasLocal: ['boolean', 'Whether it has a local checkout a session can work in'],
      actionProviderId: ['integer?', 'The provider its PR actions run on'],
      actionModel: str('That runtime’s model, or empty'),
      actionEffort: str('That runtime’s effort, or empty'),
      runProfiles: ['string[]', 'The names ▶ Run offers, the default first'],
      hasBoard: ['boolean', 'Whether it names a Projects v2 board, read with `GET /project-board`'],
    },
  },
  Session: {
    about:
      'A conversation with an agent. The record is pushed whole on every change, so replace your copy rather than merging.',
    fields: {
      id: str('Its id'),
      title: str('Its title'),
      repo: str('The project it belongs to'),
      ownerId: [
        'integer?',
        'The user who owns it: who started it, or the owner of the session it was started for (a QA run, an orchestrator’s worker); null for work nobody started. A member sees only their own sessions and ownerless ones',
      ],
      status: [
        'queued|preparing|running|idle|closed|failed|interrupted',
        '`idle` is waiting for a message; `closed` has released its workspace and can be reopened',
      ],
      error: ['string?', 'Why it failed'],
      activity: str('What its spend is filed under: `chat`, `qa`, `orchestrator`, an errand id, …'),
      provider: str('The provider’s label'),
      providerId: id('The provider’s id'),
      model: str('The model it runs on'),
      effort: str('The effort it runs at'),
      branch: ['string?', 'The branch its workspace is on'],
      baseBranch: ['string?', 'The branch that one was cut from'],
      startBranch: ['string?', 'The existing branch it was started on, if any'],
      local: ['boolean', 'Whether it works in the project’s local checkout'],
      createdAt: str('ISO time it was created'),
      pinnedAt: [
        'string?',
        'ISO time it was pinned; absent when not pinned. Pinned sessions lead the list, the most recently pinned first',
      ],
      startedAt: ['string?', 'ISO time its current turn started'],
      endedAt: ['string?', 'ISO time it last settled'],
      turns: id('Turns run so far'),
      costUsd: ['number?', 'What this conversation spent, when its provider prices turns'],
      inputTokens: ['integer?', 'Input tokens consumed'],
      outputTokens: ['integer?', 'Output tokens consumed'],
      contextTokens: ['integer?', 'The live context size'],
      contextWindow: ['integer?', 'The model’s context window'],
      usage: [
        'object',
        'Spend including every session it ordered: `sessions`, `costUsd`, `estimatedCostUsd`, tokens, `durationMs`',
      ],
      awaitingAnswer: ['boolean', 'Whether the agent asked a question and is waiting'],
      mailWake: [
        'object',
        'Optional email wake configuration { rules, perHour, maxTurns }; seen ids and pending email bodies are private',
      ],
      queued: ['object[]', 'Messages waiting for the turn to end, each `{ text }`; absent when none'],
      liveInput: ['boolean', 'Whether a message sent now goes into the running turn rather than the queue'],
      lastText: ['string?', 'The opening of the agent’s latest message'],
      lastTool: ['string?', 'The tool the running turn is on'],
      subagents: ['object[]', 'The sub-agents working right now, each `{ id, name, summary, startedAt }`'],
      backgroundTasks: [
        'object[]',
        'Background work the running turn still waits on (sub-agents, Monitors, background shell commands), each `{ name, summary }`; while it is non-empty and the agent is not speaking, the session is waiting rather than thinking',
      ],
      prStatus: ['object?', 'Its pull request, once it has one: number, URL, state, checks and reviews'],
      serveLinks: ['object[]?', 'Where ▶ Run is serving its checkout, each `{ url }`; null when not running'],
      browser: [
        'object?',
        'The shared browser, `{ running }`, when it is switched on; null when off. Switched on and not running, the next turn starts it',
      ],
      qaLoop: ['object?', 'The QA loop’s state when armed'],
      orchestrator: ['boolean', 'Whether it is a supervisor of worker sessions'],
      parentId: ['string?', 'The orchestrator it works for'],
      canCompact: ['boolean', 'Whether `POST /sessions/{id}/compact` would run now'],
      compacting: ['boolean', 'Whether a compaction is running'],
      autoCompactAt: ['integer?', 'The context size at which it compacts itself'],
      hiddenLines: ['integer', 'How many transcript lines a Clear or compaction hid; absent when none'],
    },
  },
  Browser: {
    about:
      'A session’s shared browser: the Chromium its agent drives and a client watches and drives too, at the same time and on the same tabs.',
    fields: {
      on: [
        'boolean',
        'Whether it is switched on for the session; the next turn starts one that is on and down',
      ],
      running: ['boolean', 'Whether it is up right now'],
      tabs: ['BrowserTab[]', 'Its open tabs, oldest first'],
      active: ['string?', 'The `id` of the tab in view: the one frames show and input goes to'],
    },
  },
  SessionStats: {
    about:
      'What an open session costs the machine right now: every process it spawned (the agent’s turn or a setup step, the ▶ Run server, the shared browser) and the disk its workspace takes. Sampled every `HostStats.intervalMs`.',
    fields: {
      sessionId: str('The session'),
      at: id('When it was sampled, epoch milliseconds'),
      cpuPercent: [
        'number?',
        'CPU over the last interval, where 100 is one core busy; null on the first sample after a restart',
      ],
      memoryBytes: id('Resident memory of its processes together'),
      processes: id('How many processes it runs'),
      roles: [
        'object',
        'The same three figures for each kind of process running, keyed `agent`, `serve` and `browser`; a kind with nothing running is absent',
      ],
      disk: ['SessionDisk?', 'The size of its workspace; null until first measured'],
    },
  },
  SessionDisk: {
    about: 'The disk a session’s workspace clone takes, re-measured every few minutes.',
    fields: {
      bytes: id('Its size on disk, including ignored files such as node_modules'),
      measuredAt: id('When it was measured, epoch milliseconds'),
    },
  },
  SessionStatsSample: {
    about: 'One point of a session’s stats history.',
    fields: {
      at: id('When it was sampled, epoch milliseconds'),
      cpuPercent: ['number?', 'CPU over the interval before it, where 100 is one core busy'],
      memoryBytes: id('Resident memory of its processes together'),
      processes: id('How many processes it ran'),
    },
  },
  HostStats: {
    about: 'The machine the sessions share, for scaling session figures against.',
    fields: {
      cpus: id('Logical CPU cores'),
      loadAverage: ['number[]', 'Load over the last 1, 5 and 15 minutes'],
      memoryBytes: id('Total memory'),
      freeMemoryBytes: id('Memory free right now'),
      intervalMs: id('How often sessions are sampled'),
    },
  },
  ServerStats: {
    about:
      'The machine and the Briareus server on it, for a dashboard. Sampled every `host.intervalMs`, like session stats.',
    fields: {
      host: [
        'HostStats',
        'The machine; here it also carries `cpuPercent`, all cores together over the last interval where 100 is every core busy, and `uptimeSeconds`',
      ],
      process: [
        'object',
        'The Briareus server process: `cpuPercent` (100 is one core busy), `memoryBytes` resident, `heapUsedBytes`, `heapTotalBytes`, `uptimeSeconds` and `nodeVersion`',
      ],
      disks: [
        'object[]',
        'The disks sessions write to, each `{ label, totalBytes, freeBytes, usedBytes }`; `label` is `workspaces` (the clones) or `files` (published files and recordings), and a disk holding both is listed once, under `workspaces`',
      ],
      sessions: [
        'object',
        'The open sessions of this token’s projects together: `open`, `cpuPercent`, `memoryBytes`, `processes` and `diskBytes` (their workspaces as last measured)',
      ],
      history: [
        'ServerStatsSample[]',
        'The last hour, oldest first; it starts over when the server restarts',
      ],
    },
  },
  ServerStatsSample: {
    about: 'One point of the server’s stats history.',
    fields: {
      at: id('When it was sampled, epoch milliseconds'),
      cpuPercent: [
        'number?',
        'The Briareus process’s CPU over the interval before it, where 100 is one core busy',
      ],
      memoryBytes: id('The Briareus process’s resident memory'),
      hostCpuPercent: [
        'number?',
        'The machine’s CPU over the interval before it, where 100 is every core busy',
      ],
      freeMemoryBytes: id('The machine’s free memory'),
      loadAverage: ['number', 'The machine’s 1-minute load'],
    },
  },
  BrowserTab: {
    about: 'A tab of the shared browser.',
    fields: {
      id: str('Its id'),
      url: str('What it shows'),
      title: str('Its page title'),
    },
  },
  BrowserFrame: {
    about:
      'One picture of the tab in view. `width` × `height` is the page’s viewport in CSS pixels, the space input coordinates are in; a client showing the image at another size scales its pointer back to it.',
    fields: {
      data: str('A JPEG, base64'),
      width: id('The viewport’s width'),
      height: id('The viewport’s height'),
      tab: str('The tab it shows'),
    },
  },
  TranscriptEvent: {
    about:
      'One line of a session’s transcript. `kind` says how to read the rest; ignore kinds you do not know.',
    fields: {
      seq: id('Its position in the session’s log; the cursor for `since` and `Last-Event-ID`'),
      t: str('ISO time'),
      kind: [
        'string',
        '`user` a message sent in; `text` the agent speaking; `ask` a question to answer; `tool` and `tool_error` a tool call; `result` the end of a turn; `status` a status change; `btw` a side question and `btw_answer` its answer, both outside the conversation; `info`, `cmd`, `git`, `setup`, `stderr` and `claude` are log lines',
      ],
      text: str('The line’s text, on most kinds'),
      status: str('On `status`: the session’s new status'),
      attachments: ['object[]', 'On `user`: the files sent, each `{ name }`'],
      via: str('On `user`: `webhook` or `instruction` when it was not typed'),
      name: str('On `tool`: the tool’s name'),
      links: ['object[]', 'On `info`: links ▶ Run published'],
      hidden: ['boolean', 'On `info`: this line stands in for lines a Clear or compaction hid'],
      id: str('On `btw` and `btw_answer`: pairs a side question with its answer'),
      isError: [
        'boolean',
        'On `result`: the turn failed; on `btw_answer`: the text says why there is no answer',
      ],
      costUsd: ['number?', 'On `result` and `btw_answer`: what it cost'],
      durationMs: ['integer', 'On `result` and `btw_answer`: how long it ran'],
      inputTokens: ['integer', 'On `result`'],
      outputTokens: ['integer', 'On `result`'],
    },
  },
  PullRequest: {
    about: 'A pull request as GitHub has it right now.',
    fields: {
      number: id('Its number'),
      title: str('Its title'),
      body: str('Its description, markdown'),
      url: str('Its page on GitHub'),
      author: str('Who opened it'),
      state: ['open|draft|closed|merged', 'Where it stands'],
      headRef: str('The branch it merges from'),
      baseRef: str('The branch it merges into'),
      headSha: str('The head commit; pass it back to pin later reads and to merge'),
      baseSha: str('The base commit'),
      additions: id('Lines added'),
      deletions: id('Lines removed'),
      changedFiles: id('Files changed'),
      updatedAt: str('ISO time of its last change'),
      mergeable: ['boolean?', 'null while GitHub is still working it out; false means conflicts'],
      mergeableState: str('GitHub’s `mergeable_state`'),
      mergeMethods: [
        'string[]',
        'The merge methods the repository allows; absent on reads pinned with `headSha`',
      ],
    },
  },
  PullOverview: {
    about: 'A pull request’s standing, in one read.',
    fields: {
      number: id('Its number'),
      title: str('Its title'),
      url: str('Its page on GitHub'),
      state: ['open|closed|merged', 'Where it stands'],
      draft: ['boolean', 'Whether it is a draft'],
      headSha: str('The head commit'),
      headRef: str('The branch it merges from'),
      baseRef: str('The branch it merges into'),
      additions: id('Lines added'),
      deletions: id('Lines removed'),
      changedFiles: id('Files changed'),
      commits: ['integer?', 'How many commits it has'],
      commitList: [
        'object[]',
        'Up to 100 of them, each `{ sha, message, url }`, message cut to its first line',
      ],
      issues: ['object[]', 'The issues it closes, each `{ number, title, state, url }`'],
      reviews: ['object[]', 'The latest verdict per reviewer, each `{ user, state, url }`'],
      checks: ['object', '`{ total, passed, failed, pending, runs }`'],
      syncedAt: str('ISO time this was read'),
    },
  },
  File: {
    about: 'A changed file.',
    fields: {
      filename: str('Its path'),
      previousFilename: ['string?', 'Its old path, when renamed'],
      status: str('`added`, `modified`, `removed`, `renamed`, …'),
      additions: id('Lines added'),
      deletions: id('Lines removed'),
      patch: ['string?', 'The unified diff; null for a binary file or a diff GitHub would not render'],
      url: str('The file on GitHub at this revision'),
    },
  },
  Commit: {
    about: 'A commit.',
    fields: {
      sha: str('Its SHA'),
      message: str('Its full message'),
      author: str('The author’s GitHub login, or the name on the commit when there is none'),
      date: ['string?', 'ISO time it was authored'],
      url: str('Its page on GitHub'),
    },
  },
  CommitDetail: {
    about: 'A commit with what it changed.',
    fields: {
      sha: str('Its SHA'),
      message: str('Its full message'),
      author: str('The author’s GitHub login, or the name on the commit'),
      date: ['string?', 'ISO time it was authored'],
      url: str('Its page on GitHub'),
      parents: ['string[]', 'Its parents’ SHAs'],
      additions: ['integer?', 'Lines added'],
      deletions: ['integer?', 'Lines removed'],
    },
  },
  TreeEntry: {
    about: 'A file or folder of a repository.',
    fields: {
      path: str('Its path from the repository’s root'),
      type: ['blob|tree', '`tree` for a folder, `blob` for a file'],
      size: ['integer?', 'A file’s size in bytes; absent for a folder'],
    },
  },
  RepoFile: {
    about: 'One file of a repository, as text.',
    fields: {
      path: str('Its path from the repository’s root'),
      ref: str('The `ref` it was read at, as given; empty for the default branch'),
      size: id('Its size in bytes'),
      content: ['string?', 'Its text; null when it is binary or too large'],
      binary: ['boolean', 'It does not read as UTF-8 text'],
      tooLarge: ['boolean', 'It is over 1 MB, and only its size is sent'],
      url: ['string?', 'The file on GitHub'],
    },
  },
  Check: {
    about: 'A check run or commit status on a pull request’s head.',
    fields: {
      name: str('Its name'),
      status: str('`queued`, `in_progress` or `completed`'),
      conclusion: ['string?', '`success`, `failure`, `cancelled`, … once completed'],
      failed: ['boolean', 'Whether the conclusion counts as a failure'],
      url: ['string?', 'Its details page'],
      app: str('What ran it'),
      description: str('Its one-line summary'),
      startedAt: ['string?', 'ISO time'],
      completedAt: ['string?', 'ISO time'],
    },
  },
  Comment: {
    about: 'A comment in a pull request’s conversation.',
    fields: {
      id: id('Its id'),
      author: str('Who wrote it'),
      body: str('Its text, markdown'),
      createdAt: str('ISO time'),
      updatedAt: str('ISO time'),
      url: str('Its place on GitHub'),
    },
  },
  Review: {
    about: 'A submitted review.',
    fields: {
      id: id('Its id'),
      author: str('The reviewer'),
      state: str('`approved`, `changes_requested`, `commented`, `dismissed` or `pending`'),
      body: str('Its summary, markdown'),
      commitSha: ['string?', 'The commit it was made on'],
      submittedAt: ['string?', 'ISO time'],
      url: str('Its place on GitHub'),
    },
  },
  ReviewComment: {
    about: 'A comment on a line of a pull request’s diff.',
    fields: {
      id: id('Its id'),
      reviewId: ['integer?', 'The review it belongs to'],
      inReplyTo: ['integer?', 'The comment it answers'],
      author: str('Who wrote it'),
      body: str('Its text, markdown'),
      path: str('The file'),
      line: ['integer?', 'The line; null once a later push moved the code'],
      originalLine: ['integer?', 'The line when it was written'],
      side: ['string?', '`LEFT` for the old side of the diff, `RIGHT` for the new'],
      diffHunk: str('The diff around it'),
      commitSha: ['string?', 'The commit it was made on'],
      createdAt: str('ISO time'),
      updatedAt: str('ISO time'),
      url: str('Its place on GitHub'),
    },
  },
  CodeReview: {
    about: 'A code review a session ran on a pull request, as Briareus stored it.',
    fields: {
      id: id('Its id'),
      sessionId: str('The review session, which keeps its transcript after it closes'),
      projectId: ['integer?', 'Its project'],
      repo: str('The project, as `owner/name`'),
      prNumber: ['integer?', 'The pull request'],
      branch: str('The branch it checked out'),
      headSha: ['string?', 'The commit it reviewed, once the checkout was verified'],
      userId: ['integer?', 'Who started it'],
      providerId: ['integer?', 'The provider it ran on'],
      provider: str('The provider’s label when it ran'),
      model: str('The model; empty for the provider’s default'),
      effort: str('The effort; empty for the default'),
      inputTokens: ['integer?', 'Tokens read, summed over its turns'],
      outputTokens: ['integer?', 'Tokens written, summed over its turns'],
      costUsd: ['number?', 'What it cost in US dollars'],
      costEstimated: [
        'boolean',
        'Whether `costUsd` includes catalog estimates for a provider that reports none',
      ],
      unpricedTurns: id('Turns no price covered, left out of `costUsd`'),
      status: ['running|completed|failed', 'Whether it is still running, finished, or died before finishing'],
      handlingStatus: [
        'pending|handled',
        'Whether someone has addressed the findings or decided not to fix them; explicitly set by a client, pending by default and after a rerun',
      ],
      summary: ['string?', 'The summary comment it posted on the pull request, Markdown'],
      completedAt: ['string?', 'ISO time'],
      createdAt: str('ISO time'),
      updatedAt: str('ISO time'),
      findings: ['CodeReviewFinding[]', 'What it found, in the order it registered them'],
    },
  },
  CodeReviewFinding: {
    about: 'One finding a code review registered.',
    fields: {
      id: id('Its id'),
      severity: ['critical|high|medium|low', 'How bad it is'],
      type: str('What kind of defect: `correctness`, `security`, `efficiency`, …; may be empty'),
      shouldFix: [
        'fix|optional|dismiss?',
        'The verification step’s verdict on whether the pull request must change; null until it ruled',
      ],
      verification: [
        'confirmed|plausible?',
        'Whether an independent check reproduced it or it is only likely',
      ],
      title: str('Its one-line statement'),
      body: ['string?', 'Its explanation, Markdown'],
      filePath: ['string?', 'The file it is in'],
      startLine: ['integer?', 'Its first line'],
      endLine: ['integer?', 'Its last line'],
      comments: ['string?', 'Why the verdict is what it is, e.g. why it is not worth fixing'],
      createdAt: str('ISO time'),
      updatedAt: str('ISO time'),
    },
  },
  ClosedIssue: {
    about: 'An issue as closing it left it.',
    fields: {
      number: id('Its number'),
      state: ['closed', 'Always `closed`'],
      stateReason: ['completed|not_planned?', 'Why it was closed'],
      closedAt: ['string?', 'When, ISO 8601'],
      url: str('The issue on GitHub'),
    },
  },
  UpdatedGithubItem: {
    about:
      'The fields returned after editing an issue or pull request; read the resource again for its full detail.',
    fields: {
      number: id('Its number'),
      title: str('Its title'),
      body: str('Its description, markdown; empty when it has none'),
      state: ['open|closed', 'Its issue state; a merged pull request is also closed here'],
      stateReason: ['completed|not_planned|reopened?', 'Why it was closed or reopened, when available'],
      url: str('Its page on GitHub'),
      labels: ['object[]', 'Each `{ name, color }`'],
      assignees: ['string[]', 'Their logins'],
    },
  },
  Issue: {
    about: 'An issue as GitHub has it right now, with what its page on GitHub shows beside the body.',
    fields: {
      number: id('Its number'),
      title: str('Its title'),
      url: str('Its page on GitHub'),
      state: ['open|closed', 'Where it stands'],
      stateReason: ['completed|not_planned|duplicate|reopened?', 'Why it was last closed or reopened'],
      body: str('Its description, markdown; empty when it has none'),
      author: ['string?', 'Who opened it; null for a deleted account'],
      authorAvatar: ['string?', 'Their avatar’s URL'],
      assignees: ['string[]', 'Their logins'],
      labels: ['object[]', 'Each `{ name, color }`, as on the board’s rows'],
      milestone: ['string?', 'Its milestone’s title'],
      comments: id('How many comments it has'),
      createdAt: str('ISO time'),
      updatedAt: str('ISO time'),
      closedAt: ['string?', 'ISO time it was last closed'],
      type: ['string?', 'Its GitHub issue type, such as `Bug` or `Feature`'],
      parent: ['IssueRef?', 'The issue it is a sub-issue of, in whatever repository'],
      subIssues: [
        'object',
        '`{ total, completed, items }`: counts of every sub-issue, and up to 100 of them as `IssueRef`s',
      ],
      pulls: [
        'object[]',
        'Up to 25 pull requests linked to close it (GitHub’s Development box), each an `IssueRef` with `draft`',
      ],
      projects: [
        'object[]',
        'One `{ title, url, status, fields }` per Projects v2 board it is on. `status` is its Status, or null; `fields` is every other set single-select, text, number, date and iteration field as `{ name, value }`. Empty when the token may not read projects',
      ],
      projectsError: [
        'string',
        'Present only when GitHub refused the project read, which needs Projects: read on the server’s token: GitHub’s reason. Everything else is still read',
      ],
    },
  },
  BoardColumn: {
    about: 'One column of a Projects v2 board: one value of the field the view groups by.',
    fields: {
      id: ['string?', 'The single-select option or iteration it stands for; null for the “No …” column'],
      name: str('Its heading, such as `In Progress`, or `No Status` for the items without a value'),
      color: [
        'string?',
        'A single-select option’s colour as GitHub names it: `GRAY`, `BLUE`, `GREEN`, `YELLOW`, `ORANGE`, `RED`, `PINK` or `PURPLE`',
      ],
      count: id('How many items it holds'),
      sums: [
        'object',
        'Every number field of the board totalled over its items, keyed by field name, such as `{ "Story Points": 21 }`; 0 where nothing is set',
      ],
      items: ['BoardItem[]', 'Its cards, in the board’s own order'],
    },
  },
  BoardItem: {
    about: 'One card of a Projects v2 board.',
    fields: {
      id: str('The project item’s node id'),
      type: ['issue|pull|draft|redacted', 'What it is; `redacted` is an item the token may not see'],
      repo: ['string?', 'Its repository, `owner/name`; null for a draft'],
      number: ['integer?', 'Its number; null for a draft'],
      title: ['string?', 'Its title'],
      url: ['string?', 'Its page on GitHub; null for a draft'],
      state: ['string?', '`open` or `closed`, and `merged` for a pull request; null for a draft'],
      createdAt: ['string?', 'ISO time'],
      author: ['string?', 'Who opened it, or created the draft'],
      assignees: ['object[]', 'Each `{ login, avatarUrl }`'],
      labels: ['object[]', 'Each `{ name, color }`, colour as hex'],
      parent: ['object?', 'The issue it is a sub-issue of (its epic): `{ repo, number, title, url }`'],
      fields: [
        'object[]',
        'Its set single-select, text, number, date and iteration fields as `{ name, value }`, single-selects with the option’s `color`; the issue’s GitHub issue type comes as `Type`. The Title and the group-by field are left out',
      ],
    },
  },
  IssueRef: {
    about: 'An issue or pull request another one points to.',
    fields: {
      number: id('Its number'),
      title: str('Its title'),
      state: str('`open` or `closed`; for a pull request also `merged`'),
      url: str('Its page on GitHub'),
      repo: ['string?', 'Its repository, `owner/name`: not always this project’s'],
    },
  },
  TimelineEvent: {
    about:
      'One entry of an issue’s timeline: a comment or an event. `kind` says which fields beside the first five it carries; ignore kinds you do not know. The kinds read are `commented`, `labeled`, `unlabeled`, `assigned`, `unassigned`, `milestoned`, `demilestoned`, `renamed`, `closed`, `reopened`, `cross-referenced`, `referenced`, `connected`, `disconnected`, `parent_issue_added`, `parent_issue_removed`, `sub_issue_added`, `sub_issue_removed`, `issue_type_added`, `issue_type_changed`, `issue_type_removed`, `added_to_project_v2`, `removed_from_project_v2` and `project_v2_item_status_changed`.',
    fields: {
      id: str('Its GitHub node id'),
      kind: str('What happened, named as GitHub’s REST timeline names it'),
      actor: ['string?', 'Who did it, or wrote it; null for a deleted account'],
      actorAvatar: ['string?', 'Their avatar’s URL'],
      createdAt: str('ISO time'),
      body: str('On `commented`: the comment, markdown'),
      url: str('On `commented`: its place on GitHub'),
      updatedAt: str('On `commented`: ISO time of its last edit'),
      authorAssociation: str('On `commented`: `OWNER`, `MEMBER`, `CONTRIBUTOR`, `NONE`, …'),
      label: ['object?', 'On `labeled`, `unlabeled`: `{ name, color }`'],
      assignee: ['string?', 'On `assigned`, `unassigned`: their login'],
      milestone: ['string?', 'On `milestoned`, `demilestoned`: its title'],
      from: str('On `renamed`: the old title'),
      to: str('On `renamed`: the new title'),
      stateReason: [
        'string?',
        'On `closed`, `reopened`: `completed`, `not_planned`, `duplicate` or `reopened`',
      ],
      source: [
        'object?',
        'On `cross-referenced`, `connected`, `disconnected`: what points here, an `IssueRef` with `kind` `issue` or `pull`',
      ],
      commit: [
        'object?',
        'On `referenced`: the commit that mentions the issue, `{ sha, message, url, repo }`, message cut to its first line',
      ],
      issue: [
        'object?',
        'On `parent_issue_*`: the parent; on `sub_issue_*`: the sub-issue. `{ number, title, url, repo }`',
      ],
      type: ['string?', 'On `issue_type_*`: the type set, or removed'],
      previousType: ['string?', 'On `issue_type_changed`: the type before'],
      project: [
        'string?',
        'On the `*_project_v2` kinds: the board’s title; null when the token may not read projects',
      ],
      status: ['string?', 'On `project_v2_item_status_changed`: the new Status'],
      previousStatus: ['string?', 'On `project_v2_item_status_changed`: the Status before'],
    },
  },
  Project: {
    about: 'A project’s full settings. A body may carry any of these; what it leaves out keeps its value.',
    fields: {
      id: id('Its id; not in `defaults` or a create body'),
      repo: str('`owner/name`'),
      label: str('Its display name'),
      enabled: ['boolean', 'Whether sessions can start on it'],
      mailToolsEnabled: [
        'boolean',
        'Allow interactive sessions in this project to access their owner’s connected mailboxes; false by default',
      ],
      whatsappToolsEnabled: [
        'boolean',
        'Allow interactive sessions in this project to read, answer and mark read the operator’s WhatsApp chats; false by default',
      ],
      printToolsEnabled: [
        'boolean',
        'Allow interactive sessions in this project to print their files on the server’s CUPS printers; false by default',
      ],
      homeAssistantToolsEnabled: [
        'boolean',
        'Allow interactive sessions in this project to read and control their owner’s connected Home Assistant; false by default',
      ],
      sortOrder: id('Its place in the list'),
      setupCommands: ['string[]', 'Run to prepare a checkout'],
      phpBinDir: str(''),
      localDir: str('Its local checkout, if any'),
      localSessionLimit: [
        'integer',
        'How many Local mode sessions may work in the local checkout at once, 1 to 10, or 0 for no limit (1 by default); more queue until one closes',
      ],
      autoUpdate: ['boolean', 'Whether a merged pull request updates the local checkout'],
      updateCommands: ['string[]', 'Run in the local checkout after it updates'],
      dbPoolEnabled: ['boolean', 'Whether its sessions claim a database server'],
      dbPoolDatabase: str(''),
      dbRestoreSql: str(''),
      databaseBackupEnabled: [
        'boolean',
        'Back up the main local checkout database daily to R2, compressed and encrypted with CREDENTIALS_KEY; defaults to false for new projects',
      ],
      dbExtensions: ['string[]', ''],
      envTemplate: str('The `.env` written into a checkout'),
      runCommands: ['string[]', 'What ▶ Run runs'],
      runProfiles: str(''),
      babysitPrs: [
        'boolean',
        'Every 15 minutes, resolve conflicts and failing checks on the project’s action runtime; defaults to false',
      ],
      qaTestRun: ['boolean', ''],
      qaNotes: str(''),
      testSheetInstructions: str(''),
      prAuthor: str(''),
      actionProviderId: ['integer?', 'The provider PR actions run on'],
      actionModel: str(''),
      actionEffort: str(''),
      workerProviderId: ['integer?', ''],
      workerModel: str(''),
      workerEffort: str(''),
      isSelf: ['boolean', 'Whether this project is Briareus itself'],
      stepRuntimes: ['object', 'A runtime per errand step'],
      promptTemplates: ['object', 'Per-project prompt overrides'],
      projectBoard: [
        'object?',
        'The GitHub Projects v2 board `GET /project-board` draws: `{ owner, ownerType, number, view }`, where `owner` is an organization or user login, `ownerType` is `organization` (the default) or `user`, `number` is the project’s number and `view` an optional view number whose filter and grouping the board follows. Null, or a blank owner and number, for none',
      ],
      createdAt: str('ISO time; set by the server'),
      updatedAt: str('ISO time; set by the server'),
    },
  },
  Provider: {
    about: 'A provider row: one login or endpoint of one CLI. A body may carry any of the first nine fields.',
    fields: {
      id: id('Its id; set by the server'),
      label: str('Its display name'),
      binary: ['claude|codex|grok|opencode|dsh|qwen', 'Which CLI runs it'],
      active: ['boolean', 'Whether sessions can start on it'],
      baseUrl: str('A custom endpoint, or empty'),
      apiKey: str('The key for that endpoint, or empty. Returned as stored'),
      models: ['string[]', 'Models to offer; the CLI’s own list when empty'],
      efforts: ['string[]', 'Efforts to offer; the CLI’s own when empty'],
      defaultModel: str(''),
      defaultEffort: str(''),
      sortOrder: id('Its place in the list'),
      hasLogin: ['boolean', 'Whether a login is stored for it; the login itself never leaves the server'],
      loginDir: str('Where its CLI keeps its login on the server'),
      createdAt: str('ISO time'),
      updatedAt: str('ISO time'),
    },
  },
  DbServer: {
    about: 'A database server sessions can claim, one session at a time.',
    fields: {
      id: id('Its id; set by the server'),
      label: str('Its display name'),
      host: str('Its host'),
      port: id('Its port'),
      username: str('The user sessions connect as'),
      password: str('That user’s password. Returned as stored'),
      enabled: ['boolean', 'Whether it is in the pool'],
      sortOrder: id('Its place in the list'),
    },
  },
  ForgeAccount: {
    about: 'A Laravel Forge organization the server calls Forge for, with the token it calls with.',
    fields: {
      id: id('Its id; set by the server'),
      label: str('Its display name; the organization when left empty'),
      organization: str('The organization’s slug, from `forge.laravel.com/<organization>/…`'),
      token: str(
        'A Forge API token for it. Write-only: stored encrypted and never sent back; empty or absent keeps the stored one',
      ),
      hasToken: ['boolean', 'Whether a token is stored; read-only'],
      repos: ['string[]', 'The projects it is available to, as `owner/name`, each an existing project'],
    },
  },
  ForgeServer: {
    about:
      'A server in a Laravel Forge account’s organization. The rest of Forge’s attributes come along, named as Forge names them.',
    fields: {
      id: id('Its Forge id'),
      name: str('Its name'),
      ip_address: str('Its public address'),
      provider: str('The cloud it runs on'),
      region: str('Its region'),
      php_version: str('Its default PHP'),
      is_ready: ['boolean', 'Whether Forge has finished provisioning it'],
    },
  },
  ForgeSite: {
    about: 'A site on a Forge server, with the rest of Forge’s attributes named as Forge names them.',
    fields: {
      id: id('Its Forge id'),
      name: str('Its domain'),
      status: str('Forge’s state for it'),
      url: str('Where it answers'),
      repository: ['object?', 'The repository it deploys, as Forge describes it'],
      deployment_status: ['string?', 'The deployment under way, if any'],
      quick_deploy: ['boolean', 'Whether a push deploys it'],
    },
  },
  EnvoyerAccount: {
    about: 'A Laravel Envoyer account, and the one project whose clients may use it.',
    fields: {
      id: id('Its id; set by the server'),
      label: str('Its display name'),
      repo: str('The project it is available to'),
      token: str(
        'Its Envoyer API token. Write-only: stored encrypted and never returned; left out of an update, the stored one stays',
      ),
    },
  },
  MailAccount: {
    about:
      'A mailbox connected with its provider’s own sign-in, whose messages the server keeps synced. Its tokens are stored encrypted and never sent back.',
    fields: {
      id: id('Its id; set by the server'),
      provider: ['gmail|outlook', 'Where the mailbox is'],
      access: [
        'read|manage',
        'Read-only or consented sending and filing; existing connections remain read-only',
      ],
      email: str('Its address, as the provider names it'),
      label: str('A name to show; empty for none'),
      enabled: ['boolean', 'Whether the periodic sync includes it'],
      syncDays: id('How many days back its messages are kept, 1–365'),
      status: [
        'connected|reauth',
        '`reauth` once the provider stopped honouring its sign-in (revoked, expired, a password change): connect it again with its `accountId`',
      ],
      syncing: ['boolean', 'Whether a sync pass is running now'],
      lastSyncAt: ['integer?', 'When the last pass that succeeded finished, epoch milliseconds'],
      lastSyncError: ['string?', 'Why the last pass failed; null once one succeeds'],
      push: ['object', '{ active, expiresAt, lastError } for provider push registration; no secrets'],
      messages: id('How many of its messages are synced'),
      unread: id('How many of those are unread in the inbox'),
      createdAt: id('Epoch milliseconds'),
      updatedAt: id('Epoch milliseconds'),
    },
  },
  MailAddress: {
    about: 'A sender or a recipient.',
    fields: { name: str('The display name; empty when there is none'), address: str('The address') },
  },
  MailAttachment: {
    about: 'An attachment, described: its content is not synced.',
    fields: {
      id: ['string?', 'The provider’s id for it'],
      name: str('Its file name'),
      mimeType: str('Its type'),
      size: id('Its size in bytes, as the provider reports it'),
    },
  },
  MailMessageSummary: {
    about: 'A synced message as a list shows it, without its body.',
    fields: {
      accountId: id('The `MailAccount` it was synced from'),
      id: str(
        'The provider’s id for it; URL-encode it in a path, since an Outlook id may hold `/`, `+` and `=`',
      ),
      threadId: str('Its conversation: Gmail’s thread, Outlook’s conversation'),
      receivedAt: id('When it arrived, epoch milliseconds'),
      from: ['MailAddress', 'Who sent it'],
      to: ['MailAddress[]', ''],
      cc: ['MailAddress[]', ''],
      replyTo: ['MailAddress[]', 'Where replies go, when not to the sender'],
      subject: str('Its subject'),
      snippet: str('The start of its text, as the provider previews it'),
      labels: [
        'string[]',
        'Gmail: its labels by name (`INBOX`, `SENT`, `IMPORTANT`, `CATEGORY_UPDATES`, your own, …). Outlook: its folder’s name, then its categories',
      ],
      inInbox: ['boolean', 'Whether it is in the inbox'],
      isRead: ['boolean', ''],
      isStarred: ['boolean', 'Starred on Gmail, flagged on Outlook'],
      attachments: ['MailAttachment[]', ''],
      webUrl: ['string?', 'Where the provider’s own web app opens it'],
    },
  },
  MailMessage: {
    about: 'One synced message, with its body.',
    fields: {
      accountId: id('The `MailAccount` it was synced from'),
      id: str('The provider’s id for it'),
      threadId: str('Its conversation'),
      receivedAt: id('When it arrived, epoch milliseconds'),
      from: ['MailAddress', 'Who sent it'],
      to: ['MailAddress[]', ''],
      cc: ['MailAddress[]', ''],
      replyTo: ['MailAddress[]', ''],
      subject: str('Its subject'),
      snippet: str('The start of its text'),
      labels: ['string[]', 'As on `MailMessageSummary`'],
      inInbox: ['boolean', ''],
      isRead: ['boolean', ''],
      isStarred: ['boolean', ''],
      attachments: ['MailAttachment[]', ''],
      webUrl: ['string?', ''],
      messageId: ['string?', 'Its `Message-ID` header'],
      body: ['MailBody', 'What it says'],
    },
  },
  MailBody: {
    about: 'A message’s content, as synced.',
    fields: {
      text: [
        'string?',
        'The plain-text part; for a message sent as HTML only, that HTML rendered as text. Null when it has neither',
      ],
      html: [
        'string?',
        'The HTML part exactly as the sender wrote it: render it sandboxed, with scripts and remote content blocked',
      ],
      truncated: ['boolean', 'Whether `text` or `html` was cut at 500,000 characters'],
    },
  },
  SshServer: {
    about: 'A server an agent may run commands on, with approval.',
    fields: {
      id: id('Its id; set by the server'),
      label: str('Its display name'),
      repo: str('The project whose sessions may use it'),
      host: str('Its host'),
      port: id('Its port'),
      username: str('The user to connect as'),
      identityFile: str('The private key file on the Briareus server'),
      password: str(
        'SSH password (max 1023 UTF-8 bytes, no NUL or newlines). Write-only, stored encrypted; omitted keeps the stored value, empty clears it. When set, uses password authentication instead of a key. Requires CREDENTIALS_KEY',
      ),
      hasPassword: ['boolean', 'Whether an SSH password is stored; set by the server'],
      sudoPassword: str(
        'Sudo password, separate from SSH authentication. Write-only, encrypted; omit to preserve, empty to clear',
      ),
      hasSudoPassword: ['boolean', 'Whether a sudo password is stored; set by the server'],
      permissionMode: ['ask|allow', '`ask` waits for approval of every command; `allow` runs them'],
      enabled: ['boolean', 'Whether agents may use it'],
      monitoringEnabled: [
        'boolean',
        'Accept outbound HTTPS telemetry from the separate briareus-monitor service; false by default. Issue a per-server monitor token and install the service once over SSH. No periodic SSH connections. Disabled servers reject telemetry',
      ],
      dbHost: str('Where its database listens, as seen from the server itself; `127.0.0.1` by default'),
      dbPort: id('Its database’s port; 3306 by default'),
      dbUsername: str(
        'The database user. Write-only: stored encrypted and read back through `GET …/db-credentials`. Empty clears the login',
      ),
      dbPassword: str('That user’s password. Write-only, stored encrypted; left out, the stored one stays'),
      hasDbCredentials: ['boolean', 'Whether a database login is stored; set by the server'],
    },
  },
  SshResourceSample: {
    about:
      'One minute of telemetry pushed by the installed service; missing samples remain gaps. CPU/network rates are null until two valid counter samples exist on the same boot.',
    fields: {
      at: ['integer', 'Minute bucket as Unix milliseconds, stamped by Briareus'],
      metrics: [
        'SshResourceMetrics?',
        'Null when collection failed; never represent missing metrics as zero',
      ],
      error: ['string?', 'Reserved; null for received samples'],
    },
  },
  SshResourceMetrics: {
    about: 'Linux host resources, independent of coding sessions.',
    fields: {
      uptimeSeconds: ['number', 'Host uptime in seconds'],
      cpu: [
        'object',
        '{ cores, loadAverage: [1m, 5m, 15m], usagePercent }; usagePercent is 0–100 across all cores, or null without a valid baseline',
      ],
      memory: [
        'object',
        '{ totalBytes, availableBytes, usedBytes, usedPercent, swapTotalBytes, swapUsedBytes }; used excludes reclaimable memory using MemAvailable',
      ],
      disks: [
        'object[]',
        'Local mounted filesystems: { mount, device, filesystem, totalBytes, usedBytes, availableBytes, usedPercent }; excludes network/automount filesystems, deduplicates bind mounts',
      ],
      network: [
        'object[]',
        'Per-interface { name, rxBytes, txBytes, rxBytesPerSecond, txBytesPerSecond }; rates average between samples, null after restart/counter reset, loopback excluded; do not sum virtual and physical interfaces',
      ],
    },
  },
  SshResourceServer: {
    about: 'A server visible to the caller, without SSH credentials or identity paths.',
    fields: {
      id: ['integer', 'SSH server id'],
      label: str('Display name'),
      repo: str('Project'),
      enabled: ['boolean', 'SSH server enabled'],
      monitoringEnabled: ['boolean', 'Telemetry opted in'],
      latest: ['SshResourceSample?', 'Latest received sample, or null'],
      stale: ['boolean', 'No sample or more than two minutes old'],
    },
  },
  WhatsAppAccount: {
    about: 'A phone linked to the operator’s WAHA server, independent of projects and agent sessions.',
    fields: {
      id: str('The WAHA session name; default for the free Core edition'),
      status: str('WAHA connection state, including STOPPED, STARTING, SCAN_QR_CODE, WORKING and FAILED'),
      me: ['object?', 'Linked identity { id, name }, or null before pairing'],
    },
  },
  WhatsAppMessage: {
    about: 'A WhatsApp message, with engine internals and private media URLs omitted.',
    fields: {
      id: str('Opaque message ID; merge refreshed history by this ID'),
      timestamp: ['number', 'Unix timestamp in seconds'],
      from: str('Sender chat ID'),
      to: str('Recipient chat ID'),
      fromMe: ['boolean', 'Sent by the linked account'],
      participant: str('Author in a group chat, when available'),
      text: str('Text or media caption'),
      hasMedia: ['boolean', 'Has a downloadable attachment'],
      media: ['object?', 'Attachment { mimetype, filename }; download through the media endpoint'],
      ack: ['number?', 'Delivery state: -1 error, 0 pending, 1 server, 2 delivered, 3 read, 4 played'],
      replyTo: ['WhatsAppQuote?', 'Quoted context, or null when absent'],
    },
  },
  WhatsAppQuote: {
    about:
      'Quoted context for display even when the original is outside loaded history. Its engine identifier may be a raw stanza ID, not a full WhatsAppMessage.id; do not pass it as the outgoing replyTo. Use a full message ID from history to send a quoted reply.',
    fields: {
      id: ['string?', 'Engine quote identifier, when available; may differ from the full message ID'],
      participant: str('Quoted author, when available'),
      text: str('Quoted text or media caption, when available'),
      hasMedia: ['boolean', 'Quoted message contains media; private media URLs are omitted'],
    },
  },
  SlackWorkspace: {
    about:
      'A Slack workspace the operator reads and replies in through the core inbox, plus optional access for project sessions; messages go out as the user who installed the Slack app.',
    fields: {
      id: id('Its id; set by the server'),
      label: str('Its display name; the workspace’s name when left empty'),
      token: str(
        'A Slack user token (`xoxp-…`) with chat:write, users:read, channels:read, groups:read, im:read, mpim:read, im:write, mpim:write, channels:write, groups:write, im:history, mpim:history, channels:history and groups:history. Write-only: checked with Slack, stored encrypted and never returned; empty or absent keeps the stored one',
      ),
      signingSecret: str(
        'The Slack app’s signing secret for live inbox events and session replies through `eventsUrl`. Write-only, stored encrypted; empty or absent keeps the stored one',
      ),
      projects: [
        'object[]',
        'The projects that may send through it, each `{ repo, channels, directMessages, permissionMode }`: `channels` the channel names or ids it may post to, `directMessages` whether it may write to people (true when absent), `permissionMode` `ask` (each message waits for approval, the default) or `allow`. A project is in one workspace at most',
      ],
      team: str('The workspace’s name, from Slack; read-only'),
      teamId: str('The workspace’s Slack id; read-only'),
      user: str('Whose account the messages go out as; read-only'),
      userId: str('That user’s Slack id; read-only'),
      url: str('The workspace’s address; read-only'),
      hasToken: ['boolean', 'Whether a token is stored; read-only'],
      hasSigningSecret: [
        'boolean',
        'Whether a signing secret is stored for live inbox events and session replies; read-only',
      ],
      eventsUrl: str(
        'The Request URL to give the Slack app’s Event Subscriptions, subscribed on behalf of users to message.im, message.mpim, message.channels and message.groups; read-only',
      ),
    },
  },
  McpServer: {
    about:
      'An MCP server whose tools Claude and Codex sessions get beside Briareus’s own. A remote one is reached through Briareus, which adds its credentials, so a sign-in serves every provider account.',
    fields: {
      id: id('Its id; set by the server'),
      name: str(
        'What the tools are filed under (`mcp__<name>__…`): letters, digits, `_` and `-`, unique, none of Briareus’s own',
      ),
      label: str('Its display name; the name when left empty'),
      transport: [
        'http|stdio',
        '`http` for a remote server (Streamable HTTP), `stdio` for a command run beside each session',
      ],
      url: str('A remote server’s endpoint; https, or http on the Briareus machine itself'),
      command: str('What starts a stdio server'),
      args: ['string[]', 'That command’s arguments'],
      repos: ['string[]', 'The projects whose sessions get it; empty for every project'],
      enabled: ['boolean', 'Whether sessions get it'],
      headers: [
        'object',
        'Headers sent to a remote server, `{ name: value }`, e.g. an API key. Write-only, stored encrypted; present replaces the whole set. An `Authorization` header here means no OAuth sign-in',
      ],
      env: [
        'object',
        'Environment for a stdio server, `{ NAME: value }`. Write-only, stored encrypted; present replaces the whole set',
      ],
      oauthClientId: str(
        'An OAuth client to sign in as, for a server that does not let clients register themselves; empty to register automatically',
      ),
      oauthClientSecret: str('That client’s secret. Write-only, stored encrypted'),
      oauthScope: str('The scopes to ask for; empty for what the server asks for'),
      oauthClientName: str(
        'The client name Briareus registers under; `Briareus` when empty. For a server that only lets clients it knows register (Meta takes names starting with `Claude Code`)',
      ),
      oauthRedirect: [
        'callback|loopback',
        '`callback` returns the sign-in to Briareus by itself; `loopback` registers a `http://127.0.0.1:<port>/callback` redirect, for a server that only allows those, and the address the browser ends on is pasted back through `POST …/finish-sign-in`',
      ],
      auth: ['none|oauth', 'How Briareus authenticates to it; set by the server'],
      status: [
        'unchecked|ready|needs-sign-in|error',
        'Whether it works: `needs-sign-in` until someone opens `signInUrl`; set by the server',
      ],
      error: str('Why it does not, when it does not; set by the server'),
      checkedAt: ['integer?', 'When it was last checked, epoch milliseconds'],
      signedInAt: ['integer?', 'When the last OAuth sign-in completed, epoch milliseconds'],
      signedIn: ['boolean', 'Whether an OAuth sign-in is stored; set by the server'],
      signInUrl: [
        'string?',
        'Open this in a browser to sign in. Valid for 15 minutes; the provider returns to `PUBLIC_BASE_URL/webhooks/mcp-oauth/callback`, which finishes the setup. Null when no sign-in is under way',
      ],
      signInNeedsPaste: [
        'boolean',
        'Whether the sign-in under way ends on a page that does not load, whose address must go to `POST …/finish-sign-in`; set by the server',
      ],
      headerNames: ['string[]', 'The names of the stored headers; set by the server'],
      envNames: ['string[]', 'The names of the stored environment variables; set by the server'],
      hasOAuthClientSecret: ['boolean', 'Whether a client secret is stored; set by the server'],
    },
  },
  DbCredentials: {
    about: 'An SSH server’s database login, opened. Reach `host`:`port` through a tunnel over that server.',
    fields: {
      host: str('Where the database listens, as seen from the server'),
      port: id('Its port'),
      username: str('The database user'),
      password: str('That user’s password'),
    },
  },
  Workspace: {
    about: 'A workspace clone slot.',
    fields: {
      slot: str('Its name'),
      repo: str('The project it is a clone of'),
      index: id('Its number among that project’s slots'),
      dir: str('Its directory on the server'),
      branch: ['string?', 'The branch checked out'],
      head: ['string?', 'The commit checked out'],
      dirty: ['boolean', 'Whether it has uncommitted changes'],
      sizeKb: ['integer?', 'Its size on disk'],
      setup: ['object?', 'What its last setup installed'],
      vendor: ['boolean', 'Whether it has a `vendor/` tree'],
      nodeModules: ['boolean', 'Whether it has a `node_modules/` tree'],
      claimedBy: ['object?', 'The session holding it'],
      error: ['string?', 'Why it could not be read'],
    },
  },
  Memory: {
    about: 'Something a project’s agents remember between sessions.',
    fields: {
      id: id('Its id; set by the server'),
      repo: str('The project it belongs to'),
      name: str('Its name, a slug unique within the project'),
      type: ['user|feedback|project|reference', 'What kind of fact it is; `project` when absent'],
      description: str('One line saying what it holds'),
      body: str('The memory itself'),
      jobId: ['string?', 'The session that last wrote it; null when edited by hand'],
      createdAt: str('ISO time'),
      updatedAt: str('ISO time'),
    },
  },
  SavedPrompt: {
    about: 'A prompt kept for the composer.',
    fields: {
      id: id('Its id; set by the server'),
      title: str('Its title'),
      body: str('The prompt'),
      repo: ['string?', 'The project that offers it; null offers it everywhere'],
      sortOrder: ['integer?', 'Its place in the list; last when absent'],
    },
  },
  Webhook: {
    about:
      'A session’s webhook: where an outside system posts to wake it, and the limits its turns run under.',
    fields: {
      armed: ['boolean', 'Whether deliveries are accepted'],
      perHour: id('Deliveries taken in any one hour'),
      maxTurns: id('Turns deliveries may start in a row with no word from the operator; 0 means unlimited'),
      sshUnattended: [
        'boolean',
        'Whether an SSH server in `allow` mode runs commands unapproved in a turn a delivery started',
      ],
      instructions: ['boolean', 'Whether the second, instructions webhook is on'],
      whatsappGroup: [
        'string?',
        'WhatsApp group ID ending in @g.us, or null to unlink; requires an armed webhook and WhatsApp tools enabled for the project',
      ],
      whatsappAccount: ['string', 'WAHA account for the linked group; default is default'],
      url: str('Where a sender posts; not in a body'),
      key: ['string?', 'The key a sender signs with; null while unarmed; not in a body'],
      instructionsUrl: str('Where instructions are posted; not in a body'),
      instructionsKey: ['string?', 'The instructions webhook’s key; not in a body'],
      held: id('Deliveries waiting; not in a body'),
      paused: ['object?', 'Why deliveries are paused; not in a body'],
    },
  },
};

// One route. `path` is under /api/v1; `to` is the dashboard handler's path, or null
// when the gateway answers itself. `access` is the least permission allowed. `scope`
// holds a project-limited token (admin tokens are not limited): `repo` means the
// request names a project (query for GET/DELETE, else body) that must be its own,
// `session` means :id is a session of its projects, `any` means nothing to check.
//
// `query`/`body` name accepted fields and `required` the mandatory ones (handlers
// validate, not the gateway); `fields` overrides a field's meaning; `bodyObject`
// names an OBJECTS body; `returns` is a type or `{ key: type }`. For the gateway:
// `params` copies a path parameter into query or body, `set` adds fixed query
// values, `raw` takes the body as bytes, `stream` marks SSE, and `runtime` fills
// in the project's provider when a start names none.
/** @returns {Record<string, any>} */
function route(id, method, path, to, access, scope, summary, extra = {}) {
  return { id, method, path, to, access, scope, summary, ...extra };
}

const RUNTIME = ['provider', 'model', 'effort'];
const REVIEW_FINDING_FIELDS = [
  'severity',
  'type',
  'shouldFix',
  'verification',
  'title',
  'body',
  'filePath',
  'startLine',
  'endLine',
  'comments',
];
const SESSION = { session: 'Session' };
const OK = { ok: 'boolean' };
const CI_QUERY = [
  'repo',
  'since',
  'until',
  'kind',
  'branch',
  'name',
  'status',
  'conclusion',
  'runnerGroup',
  'runner',
];
const CI_FIELDS = {
  repo: ['string', 'Optional repository; absent means all projects visible to the token'],
  since: ['integer', 'Inclusive epoch milliseconds; defaults to 30 days before until'],
  until: ['integer', 'Exclusive epoch milliseconds; defaults to now; maximum window 366 days'],
  kind: ['check_run|status', 'check_run by default; legacy statuses are reported separately'],
  branch: ['string', 'Exact branch hint'],
  name: ['string', 'Exact check name or status context'],
  status: ['string', 'Exact execution status'],
  conclusion: ['string', 'Exact conclusion'],
  runnerGroup: ['string', 'Exact runner group name'],
  runner: ['string', 'Exact runner name'],
  limit: ['integer', 'Page size, 1–100; default 50'],
  offset: ['integer', 'Offset, 0–100000; default 0'],
};
const camel = (name) => name.replace(/[-/](.)/g, (_, c) => c.toUpperCase());

const pullList = (section, summary, returns, query = ['page']) =>
  route(
    `pulls.${camel(section)}`,
    'GET',
    `/pulls/:number/${section}`,
    '/api/pr/view',
    'read',
    'repo',
    summary,
    {
      params: { number: 'pr' },
      set: { section },
      query: ['repo', ...query, 'headSha', 'baseSha'],
      required: ['repo'],
      returns: { pr: 'PullRequest', ...returns },
    },
  );
const sessionAction = (name, to, summary, extra = {}) =>
  route(
    `sessions.${camel(name)}`,
    'POST',
    `/sessions/:id/${name}`,
    `/api/dev/sessions/:id/${to}`,
    'manage',
    'session',
    summary,
    {
      returns: SESSION,
      ...extra,
    },
  );
// The four routes every settings list has. `one` and `many` are the keys the
// handler answers under.
const crud = (name, path, to, object, one, many, { defaults = true } = {}) => [
  route(
    `${name}.list`,
    'GET',
    path,
    to,
    'admin',
    'any',
    `List every ${one}${defaults ? ', with the values a new one starts from' : ''}`,
    {
      returns: { [many]: `${object}[]`, ...(defaults ? { defaults: object } : {}) },
    },
  ),
  route(`${name}.create`, 'POST', path, to, 'admin', 'any', `Add a ${one}`, {
    bodyObject: object,
    returns: { [one]: object },
    status: 201,
  }),
  route(`${name}.update`, 'PUT', `${path}/:id`, `${to}/:id`, 'admin', 'any', `Change a ${one}`, {
    bodyObject: object,
    returns: { [one]: object },
  }),
  route(`${name}.delete`, 'DELETE', `${path}/:id`, `${to}/:id`, 'admin', 'any', `Remove a ${one}`, {
    returns: OK,
  }),
];
const admin = (id, method, path, to, summary, extra = {}) =>
  route(id, method, path, to, 'admin', 'any', summary, extra);
// A route over what belongs to the caller themselves (their mail): any user reaches it,
// held to their own by its handler, so an admin has no wider reach than a member.
const personal =
  (access, scope) =>
  (id, method, path, to, summary, extra = {}) =>
    route(id, method, path, to, access, scope, summary, extra);
const FORGE_CURSOR = ['string', 'The `nextCursor` of the page before; the first page when absent'];
const FORGE_NOTES =
  '100 to a page. 404 when the account is not there, 502 when Forge refuses its token, 429 when Forge is rate limiting it (60 calls a minute).';
const FORGE_SCRIPT = { content: 'string', autoSource: 'boolean' };
const ENVOYER_AT = '/envoyer/accounts/:id/projects';
const homeAssistant = (id, method, suffix, summary, extra = {}) =>
  personal(method === 'GET' ? 'read' : 'manage', 'any')(
    `homeAssistant.${id}`,
    method,
    `/home-assistant${suffix}`,
    `/api/home-assistant${suffix}`,
    summary,
    {
      notes:
        'Your own Home Assistant, connected with PUT /me/home-assistant (the original operator, the first user whatever their role, also has the one HOME_ASSISTANT_URL and HOME_ASSISTANT_TOKEN set on the server); independent of projects and agent sessions. `read` reads, `manage` calls services and fires events. When unconfigured, GET /home-assistant returns 200 with configured:false and connected:false; other endpoints return 503. 502 for connection failures or rejected upstream credentials, 404 when missing. No automatic retries for actions: after an ambiguous failure, read the entity state before retrying. Poll entities while visible for current state; no event subscription is provided.',
      ...extra,
    },
  );
const WHATSAPP_NOTES =
  'Your own inbox: only the accounts you own, whatever your role (`read` to read, `manage` to link, send or mark read); another user’s answers 404. Starting an account nobody owns makes it yours; `default` belongs to the first admin. WAHA Core allows only `default`, so other users need WAHA Plus to link a phone. No project or agent session is needed. WAHA owns history and linked devices. 503 if not configured, 502 if WAHA is unavailable or rejects its key, 409 for an invalid account state, 429 for rate limits. Refresh account status and the first conversation/history page every 5 seconds while visible; merge messages by ID and reload on reconnect. Do not automatically retry sends after an ambiguous failure.';
const whatsapp = (id, method, suffix, summary, extra = {}) =>
  personal(method === 'GET' ? 'read' : 'manage', 'any')(
    `whatsapp.${id}`,
    method,
    `/whatsapp/accounts${suffix}`,
    `/api/whatsapp/accounts${suffix}`,
    summary,
    {
      notes: WHATSAPP_NOTES,
      ...extra,
    },
  );
const WHATSAPP_PAGE = {
  limit: ['integer', 'Page size, 1–100; 50 by default'],
  offset: ['integer', 'The previous page’s nextOffset, 0–100000; omit for the first page'],
};
const SLACK_AT = '/slack/workspaces/:id';
const SLACK_PAGE = {
  cursor: ['string', 'The `nextCursor` of the previous page; omit for the first page'],
  limit: ['integer', 'Items to request, 1–200; 100 for directories and 15 for message history by default'],
};
const SLACK_HISTORY = {
  ...SLACK_PAGE,
  oldest: ['string', 'Only messages after this Slack timestamp, exclusive'],
  latest: ['string', 'Only messages before this Slack timestamp, exclusive'],
};
const SLACK_NOTES =
  'Your own inbox, independent of agent sessions and project permissions: only the workspaces you connected, whatever your role (`read` to read, `manage` to send). Objects are returned as Slack shapes them. 404 for an unknown workspace or another user’s, 502 for Slack errors (including missing scopes), 429 with Retry-After for rate limits.';
const slackInbox = (id, method, suffix, summary, extra = {}) =>
  personal(method === 'GET' ? 'read' : 'manage', 'any')(
    id,
    method,
    `${SLACK_AT}${suffix}`,
    `/api/slack/inbox/:id${suffix}`,
    summary,
    {
      notes: SLACK_NOTES,
      ...extra,
    },
  );
// Manage even to read: an Envoyer project can carry its deploy hook, a URL
// that deploys it to anyone holding it, which a read-only token must not see.
const ENVOYER_NOTES =
  'Runs as the account, which must be available to `repo`; 404 when it is not. 502 when Envoyer refuses the account’s token, 429 when it is rate limiting it. Envoyer’s objects come back as Envoyer shapes them.';
const envoyer = (id, method, path, summary, extra = {}) =>
  route(id, method, path, `/api${path}`, 'manage', 'repo', summary, {
    ...(method === 'GET' ? { query: ['repo'] } : {}),
    required: ['repo'],
    notes: ENVOYER_NOTES,
    ...extra,
  });

export const API_V1_ROUTES = [
  // ---- the token itself ----
  route(
    'client.get',
    'GET',
    '/',
    null,
    'read',
    'any',
    'The token’s own record, the user it belongs to, the API version and what this server can do',
    {
      returns: { version: 'integer', client: 'Client', user: 'User', transcribe: 'boolean' },
    },
  ),
  route(
    'me.github.get',
    'GET',
    '/me/github',
    '/api/me/github',
    'read',
    'any',
    'Whether you connected your own GitHub account',
    {
      returns: 'GithubIdentity',
    },
  ),
  route(
    'me.github.set',
    'PUT',
    '/me/github',
    '/api/me/github',
    'manage',
    'any',
    'Connect your own GitHub account with a token',
    {
      body: ['token'],
      required: ['token'],
      fields: { token: ['string', 'A GitHub personal access token; stored encrypted and never shown again'] },
      returns: 'GithubIdentity',
      notes:
        'Changes you then make through the API (comments, merges, labels, finding verdicts) are made as you, and your sessions commit, push and run `gh` as you. Reads keep the server’s token. Needs CREDENTIALS_KEY on the server.',
    },
  ),
  route(
    'me.github.delete',
    'DELETE',
    '/me/github',
    '/api/me/github',
    'manage',
    'any',
    'Disconnect your GitHub account',
    {
      returns: 'GithubIdentity',
      notes: 'Your changes and sessions go back to the server’s GitHub account.',
    },
  ),
  route(
    'me.homeAssistant.get',
    'GET',
    '/me/home-assistant',
    '/api/me/home-assistant',
    'read',
    'any',
    'Whether you connected your own Home Assistant',
    { returns: 'HomeAssistantConnection' },
  ),
  route(
    'me.homeAssistant.set',
    'PUT',
    '/me/home-assistant',
    '/api/me/home-assistant',
    'manage',
    'any',
    'Connect your own Home Assistant',
    {
      body: ['url', 'token'],
      required: ['url', 'token'],
      fields: {
        url: ['string', 'Its address, such as http://homeassistant.local:8123'],
        token: ['string', 'A long-lived access token; stored encrypted and never shown again'],
      },
      returns: 'HomeAssistantConnection',
      notes:
        'Saved only once Home Assistant answers with that token; 502 when it cannot be reached or refuses it. Needs CREDENTIALS_KEY on the server.',
    },
  ),
  route(
    'me.homeAssistant.delete',
    'DELETE',
    '/me/home-assistant',
    '/api/me/home-assistant',
    'manage',
    'any',
    'Disconnect your Home Assistant',
    { returns: 'HomeAssistantConnection' },
  ),
  route('users.list', 'GET', '/users', null, 'admin', 'any', 'List the people who share this server', {
    returns: { users: 'User[]' },
    notes:
      'Users are added, changed and disabled on the server with `npm run users`, as tokens are issued with `npm run create-token`.',
  }),
  route('openapi.get', 'GET', '/openapi.json', null, 'read', 'any', 'This API as an OpenAPI 3.1 document', {
    returns: 'object',
  }),
  route('token.revoke', 'DELETE', '/token', null, 'read', 'any', 'Revoke the token used for this request', {
    returns: OK,
  }),
  route(
    'events.stream',
    'GET',
    '/events',
    null,
    'read',
    'any',
    'Follow every session of this token’s projects on one connection: `session` on each record change, `session.deleted`, and `transcript` lines when asked',
    { query: ['transcripts'], stream: true },
  ),

  // ---- projects, as a session picker sees them ----
  route(
    'projects.list',
    'GET',
    '/projects',
    '/api/dev/projects',
    'read',
    'any',
    'List the enabled projects this token can use',
    {
      returns: { projects: 'ProjectSummary[]' },
    },
  ),
  route(
    'branches.list',
    'GET',
    '/branches',
    '/api/dev/branches',
    'read',
    'repo',
    'List a project’s branches, the default one first',
    {
      query: ['repo'],
      required: ['repo'],
      returns: { defaultBranch: 'string?', branches: 'string[]' },
    },
  ),
  route(
    'branches.serve',
    'POST',
    '/branches/serve',
    '/api/dev/branches/serve',
    'manage',
    'repo',
    'Prepare a workspace on a branch with no pull request, the default one unless named, and serve it with the project’s run commands, without an agent turn',
    {
      body: ['repo', 'branch', ...RUNTIME],
      required: ['repo'],
      fields: { branch: ['string', 'An existing branch to serve; the default branch when absent'] },
      runtime: true,
      returns: { session: 'Session', url: 'string', profile: 'string?' },
      status: 201,
      notes:
        'Another call for the same branch replaces the session the last one left, as long as nobody has chatted in it. An untouched session closes and deletes itself ten minutes after the last call, as a pull request’s does.',
    },
  ),
  route(
    'runtimes.list',
    'GET',
    '/runtimes',
    '/api/dev/runtimes',
    'read',
    'repo',
    'List the providers, models and efforts a session can start on, and the project’s default',
    {
      query: ['repo'],
      required: ['repo'],
      returns: { default: 'object?', providers: 'object[]' },
      notes:
        '`default` is `{ providerId, model, effort }`. A provider is `{ id, label, available, models, defaultModel }` and a model `{ id, label, efforts, defaultEffort }`. No account data.',
    },
  ),
  route(
    'usage.project',
    'GET',
    '/usage',
    '/api/dev/usage',
    'read',
    'repo',
    'Read what a project spent this calendar month',
    {
      query: ['repo'],
      required: ['repo'],
      returns: 'object',
      notes:
        'Totals (`turns`, `sessions`, `inputTokens`, `outputTokens`, `totalTokens`, `durationMs`, `costUsd`), `daily` buckets, and breakdowns by `providers`, `models`, `activities` and `users`.',
    },
  ),
  route(
    'actions.list',
    'GET',
    '/actions',
    '/api/dev/actions',
    'read',
    'any',
    'List the errands that can be run on a pull request',
    {
      returns: { actions: 'object[]' },
      notes:
        'An errand is `{ id, label, icon, hint, input, binary? }`; `input` is null or `{ label, required }` when it asks the user something, and `binary` restricts the supported CLI when present.',
    },
  ),
  route(
    'actions.start',
    'POST',
    '/actions',
    '/api/dev/actions',
    'manage',
    'repo',
    'Start an errand on a pull request; starts a paid session',
    {
      body: ['repo', 'action', 'prNumber', 'input', ...RUNTIME],
      required: ['repo', 'action', 'prNumber'],
      runtime: true,
      returns: SESSION,
      status: 201,
      notes:
        'The `review` action requires a Codex provider: it prepares the PR head branch, checks it matches the current PR head, fetches the actual PR base (including stacked branches), and runs the native review engine through `codex exec review --json --base <PR-base-ref>` with the selected account, model and effort. Native output is saved as `review-summary.md` outside the checkout; a second turn on the same runtime verifies findings and fix value, publishes the verified findings as inline comments with Not fixed notes for rejected or optional ones, following the project’s publishing instructions, or a short note when nothing is worth posting. The final output is a Markdown summary with links to the published review. When the review finishes, its session is automatically deleted and its workspace and database are released; the stored review and the PR comments remain. Failed or canceled discovery does not publish; interrupted publication resumes its own stage.',
    },
  ),

  // ---- pull requests ----
  route(
    'pulls.list',
    'GET',
    '/pulls',
    '/api/dev/pulls',
    'read',
    'repo',
    'Read a project’s board: its open pull requests and open issues',
    {
      query: ['repo', 'fresh'],
      required: ['repo'],
      returns: {
        repo: 'string',
        pulls: 'object[]',
        issues: 'object[]',
        stacks: 'object',
        syncedAt: 'string',
      },
      notes:
        'A pull request row carries `number`, `title`, `url`, `draft`, `author`, `assignees`, `reviewers`, `issues`, `branch`, `baseBranch`, `crossRepository`, `updatedAt`, `labels`, `mergeable`, `checks`, `headSha`, `reviewDecision`, `recommended` and `stack`. An issue row carries `number`, `title`, `url`, `author`, `assignees`, `labels`, `comments`, `milestone`, `createdAt`, `updatedAt` and the `pulls` that close it. Lists read a durable normalized MySQL mirror, refreshed at startup, hourly and by GitHub webhooks; `syncedAt` is its last board refresh. A missing mirror is populated on first read. An additional in-memory cache lasts two minutes; `fresh=1` requests a GitHub refresh but reuses a board under 15 seconds old. When a refresh exhausts GitHub’s allowance the answer is 429 with `retryAt` (ISO 8601) and a `Retry-After` header; any other GitHub or persistence failure is 502.',
    },
  ),
  route(
    'pulls.get',
    'GET',
    '/pulls/:number',
    '/api/dev/pull',
    'read',
    'repo',
    'Read a pull request’s standing: state, size, commit headlines, linked issues, review verdicts and a checks summary',
    {
      params: { number: 'pr' },
      query: ['repo'],
      required: ['repo'],
      returns: { pr: 'PullOverview' },
    },
  ),
  pullList('description', 'Read a pull request’s body, mergeability and allowed merge methods', {}, []),
  pullList('files', 'Read one page of a pull request’s changed files with their patches', {
    files: 'File[]',
    nextPage: 'integer?',
    truncated: 'boolean',
  }),
  pullList('commits', 'Read one page of a pull request’s commits', {
    commits: 'Commit[]',
    nextPage: 'integer?',
  }),
  pullList(
    'checks',
    'Read every check run and commit status on a pull request’s head',
    { checks: 'Check[]', warnings: 'string[]' },
    [],
  ),
  pullList('comments', 'Read one page of a pull request’s conversation comments', {
    comments: 'Comment[]',
    nextPage: 'integer?',
  }),
  pullList('reviews', 'Read one page of a pull request’s reviews', {
    reviews: 'Review[]',
    nextPage: 'integer?',
  }),
  pullList('review-comments', 'Read one page of a pull request’s inline review comments', {
    reviewComments: 'ReviewComment[]',
    nextPage: 'integer?',
  }),
  route(
    'pulls.codeReviews',
    'GET',
    '/pulls/:number/code-reviews',
    '/api/pr/code-reviews',
    'read',
    'repo',
    'Read the code reviews Briareus sessions ran on a pull request, with their findings and verdicts',
    {
      params: { number: 'pr' },
      query: ['repo'],
      required: ['repo'],
      returns: { codeReviews: 'CodeReview[]' },
      notes:
        'Reads Briareus’s own records, not GitHub: the latest 20 reviews, newest first, each with every finding it registered and the verification step’s `shouldFix` verdict on it. A rerun of a review in the same session replaces that review’s findings. A pull request with none answers an empty list; an unreadable database is 503.',
    },
  ),
  route(
    'pulls.updateCodeReview',
    'PATCH',
    '/pulls/:number/code-reviews/:reviewId',
    '/api/pr/code-reviews/:reviewId',
    'manage',
    'repo',
    'Mark a stored code review’s findings handled or reopen it as pending',
    {
      params: { number: 'pr' },
      body: ['repo', 'handlingStatus'],
      required: ['repo', 'handlingStatus'],
      fields: { handlingStatus: OBJECTS.CodeReview.fields.handlingStatus },
      returns: { review: 'CodeReview' },
      notes:
        'Use a review id from GET /pulls/{number}/code-reviews. Set handlingStatus to handled after addressing the findings or deciding not to fix them, or pending to reopen it. This is an explicit client decision, independent of the execution status (running/completed/failed) and of individual shouldFix verdicts; it does not verify fixes or start an agent. New and existing reviews default to pending; rerunning discovery in the same session resets it to pending. The review must belong to the named repository and pull request, otherwise 404; invalid values, missing handlingStatus and unknown fields get 400. Database failures get 503.',
    },
  ),
  route(
    'pulls.updateCodeReviewFinding',
    'PATCH',
    '/pulls/:number/code-reviews/:reviewId/findings/:findingId',
    '/api/pr/code-reviews/:reviewId/findings/:findingId',
    'manage',
    'repo',
    'Update a stored code review finding, including its verdict and the reason for not fixing it',
    {
      params: { number: 'pr' },
      body: ['repo', ...REVIEW_FINDING_FIELDS],
      required: ['repo'],
      fields: Object.fromEntries(
        REVIEW_FINDING_FIELDS.map((name) => [name, OBJECTS.CodeReviewFinding.fields[name]]),
      ),
      returns: { finding: 'CodeReviewFinding' },
      notes:
        'Use the review and finding ids from GET /pulls/{number}/code-reviews. Supply at least one finding field; omitted fields stay unchanged and unknown fields get 400. Set shouldFix to optional for a real issue you are choosing not to fix, or dismiss for a refuted finding, with comments explaining why; fix requires a fix and null clears the verdict. Nullable fields accept null to clear them. The review must belong to the named repository and pull request, and the finding to that review; a mismatch gets 404. Older reviews remain editable after their sessions are deleted. This updates the stored record without starting an agent or publishing to GitHub. Database failures get 503.',
    },
  ),
  ...['pulls', 'issues'].map((resource) => {
    const isIssue = resource === 'issues';
    return route(
      `${resource}.update`,
      'PATCH',
      `/${resource}/:number`,
      `/api/${isIssue ? 'issues' : 'pr'}/update`,
      'manage',
      'repo',
      `Update ${isIssue ? 'an issue' : 'a pull request'} on GitHub`,
      {
        params: { number: isIssue ? 'issue' : 'pr' },
        body: ['repo', 'title', 'body', 'labels', 'assignees', ...(isIssue ? ['state', 'stateReason'] : [])],
        required: ['repo'],
        fields: {
          title: ['string', 'The new title; cannot be blank'],
          body: ['string', 'The new Markdown description; empty clears it'],
          labels: ['string[]', 'Replace all labels with these names; [] clears them'],
          assignees: ['string[]', 'Replace all assignees with these logins, at most ten; [] clears them'],
          ...(isIssue
            ? {
                state: ['open|closed', 'Reopen or close the issue'],
                stateReason: ['completed|not_planned|reopened?', 'Its state reason; null clears it'],
              }
            : {}),
        },
        returns: { [isIssue ? 'issue' : 'pr']: 'UpdatedGithubItem' },
        notes:
          'Supply at least one update field; omitted fields stay as they are. Unknown fields and invalid values get 400. A number of the other resource type gets 422 before any write. The board cache is cleared after a successful update.',
      },
    );
  }),
  route(
    'pulls.updateBranch',
    'POST',
    '/pulls/:number/update-branch',
    '/api/pr/update-branch',
    'manage',
    'repo',
    'Update a pull request branch with the latest changes from its base branch on GitHub',
    {
      params: { number: 'pr' },
      body: ['repo', 'headSha', 'baseRef'],
      required: ['repo', 'headSha', 'baseRef'],
      fields: { headSha: ['string', 'The `pr.headSha` that was read; a push since then refuses the update'] },
      returns: { status: 'string', message: 'string' },
      status: 202,
      notes:
        '`status` is `accepted`: GitHub updates the branch asynchronously; read the pull request and checks again to track completion. A changed head or base branch returns 409; GitHub refusals, including conflicts, may return 422. This updates the PR branch without merging the PR into its base.',
    },
  ),
  route(
    'pulls.merge',
    'POST',
    '/pulls/:number/merge',
    '/api/pr/merge',
    'manage',
    'repo',
    'Merge a pull request on GitHub, at the head and into the base it was read with',
    {
      params: { number: 'pr' },
      body: ['repo', 'headSha', 'baseRef', 'method'],
      required: ['repo', 'headSha', 'baseRef'],
      fields: { headSha: ['string', 'The `pr.headSha` that was read; a push since then refuses the merge'] },
      returns: { merged: 'boolean', status: 'string', sha: 'string?', message: 'string' },
      notes:
        "`status` is `merged`, `enqueued` or `pending`. A pull request in a GitHub stack merges through GitHub's asynchronous merge, which also lands every pull request below it; one GitHub has not finished within about ten seconds comes back `pending` and finishes on its own.",
    },
  ),
  route(
    'pulls.serve',
    'POST',
    '/pulls/:number/serve',
    '/api/dev/pulls/:number/serve',
    'manage',
    'repo',
    'Prepare a workspace for a pull request and serve it with the project’s run commands, without an agent turn',
    {
      body: ['repo', ...RUNTIME],
      required: ['repo'],
      runtime: true,
      returns: { session: 'Session', url: 'string', profile: 'string?' },
      status: 201,
    },
  ),
  route(
    'issues.get',
    'GET',
    '/issues/:number',
    '/api/issues/view',
    'read',
    'repo',
    'Read an issue in full: body, type, parent and sub-issues, linked pull requests and its Projects v2 fields',
    {
      params: { number: 'issue' },
      query: ['repo'],
      required: ['repo'],
      returns: { issue: 'Issue' },
      notes:
        'A pull request’s number is refused with 422, as closing one is; a number that is neither gets 404. The project fields need Projects: read on the server’s token; without it the issue is still read, with `projects` empty and `projectsError` saying why.',
    },
  ),
  route(
    'issues.timeline',
    'GET',
    '/issues/:number/timeline',
    '/api/issues/timeline',
    'read',
    'repo',
    'Read one page of an issue’s timeline: its comments and events, oldest first',
    {
      params: { number: 'issue' },
      query: ['repo', 'page'],
      required: ['repo'],
      returns: { issue: 'object', events: 'TimelineEvent[]', nextPage: 'integer?' },
      notes:
        '`issue` is `{ number, title, state, url }`. Only the kinds `TimelineEvent` lists are read, so every page but the last holds 100 of them; GitHub’s other kinds (subscriptions, mentions, pins, …) are left out. A pull request’s number gets 422, an unknown one 404. Without Projects: read on the server’s token, the project kinds come with `project` null and the answer carries `projectsError`.',
    },
  ),
  route(
    'issues.close',
    'POST',
    '/issues/:number/close',
    '/api/issues/close',
    'manage',
    'repo',
    'Close an issue on GitHub, with an optional comment posted just before',
    {
      params: { number: 'issue' },
      body: ['repo', 'reason', 'comment'],
      required: ['repo'],
      fields: {
        reason: ['completed|not_planned', 'Why it is closed; `completed` when absent'],
        comment: ['string', 'A comment to post on the issue before closing it'],
      },
      returns: { issue: 'ClosedIssue' },
      notes:
        'A pull request’s number is refused with 422: GitHub would close it through the same endpoint, and this route closes issues only. Closing one that is already closed updates its reason.',
    },
  ),
  route(
    'projectBoard.get',
    'GET',
    '/project-board',
    '/api/dev/project-board',
    'read',
    'repo',
    'Read the project’s GitHub Projects v2 board, filtered and grouped into columns the way its view is on GitHub',
    {
      query: ['repo', 'fresh'],
      required: ['repo'],
      returns: {
        project: 'object?',
        view: 'object?',
        groupBy: 'string?',
        columns: 'BoardColumn[]',
        truncated: 'boolean',
        unsupportedFilters: 'string[]',
        projectsError: 'string?',
      },
      notes:
        'The board is the one named by the project’s `projectBoard` setting; a project without one gets 404 (`hasBoard` on `GET /projects` says which do). `project` is `{ title, url }` and `view` `{ name, number, filter, url }`, null when the setting names no view. The view’s filter is applied by GitHub itself, every qualifier included (`iteration:@current`, `-status:`, `repo:` lists, …), so `unsupportedFilters` is empty. Columns follow the view’s group-by field (Status when it names none, or one that is not a single-select or an iteration), in that field’s order, with a `No <field>` column first when items lack a value; a column the filter excludes on that field (`-status:Backlog`) is left out, as GitHub’s page does. Archived items are left out. A board spans repositories, so a token held to some projects gets only the cards of their repositories (no drafts), with each column’s `count` and `sums` over those, and a parent in another repository comes back null. `truncated` says the board stopped at 2,000 items. Reading a board needs Projects: read on the server’s token (a classic token’s `read:project`); without it, or for a project or view GitHub cannot resolve, the answer has no columns and `projectsError` says why. Cached for 45 seconds; `fresh=1` reads again; `POST /project-board/move` moves a card.',
    },
  ),
  route(
    'projectBoard.move',
    'POST',
    '/project-board/move',
    '/api/dev/project-board/move',
    'manage',
    'repo',
    'Move a card of the project’s Projects v2 board to another column',
    {
      body: ['repo', 'itemId', 'columnId'],
      required: ['repo', 'itemId', 'columnId'],
      fields: {
        itemId: ['string', 'The card’s `id` from `GET /project-board`: the project item’s node id'],
        columnId: [
          'string?',
          'The `id` of the column to move it to, from `GET /project-board`; null for the `No <field>` column, which clears the field',
        ],
      },
      returns: { item: 'object' },
      notes:
        'Sets the field the board’s columns follow (the view’s group-by field, Status by default) on the item to the column’s single-select option or iteration, or clears it for null, the way dragging a card on GitHub does. `item` is `{ id, columnId, column, field }`, with the column’s and the field’s names. A card that is not on this project’s board gets 404, and so does one a token held to some projects cannot see on `GET /project-board` (a draft, or a card of another repository); a column that is not a value of that field gets 422. Moving a card needs Projects: write on the server’s token (a classic token’s `project`), more than reading the board does; without it the answer is 403 with GitHub’s reason. The board’s 45-second cache is cleared, so the next read shows the card where it now is. The card may then fall outside the view’s filter (a `status:` qualifier) and leave the board.',
    },
  ),
  route(
    'commits.get',
    'GET',
    '/commits/:sha',
    '/api/pr/commit',
    'read',
    'repo',
    'Read one commit with the files it changed and their patches',
    {
      params: { sha: 'sha' },
      query: ['repo'],
      required: ['repo'],
      returns: { commit: 'CommitDetail', files: 'File[]', truncated: 'boolean' },
    },
  ),
  route(
    'repo.tree',
    'GET',
    '/repo/tree',
    '/api/repo/tree',
    'read',
    'repo',
    'List every file and folder of a project’s repository at a branch',
    {
      query: ['repo', 'ref'],
      required: ['repo'],
      fields: { ref: ['string', 'A branch, tag or commit; the default branch when absent'] },
      returns: { ref: 'string', sha: 'string', truncated: 'boolean', entries: 'TreeEntry[]' },
      notes:
        '`sha` is the commit `ref` pointed at when it was read; read files at it (`GET /repo/file?ref=<sha>`) so they match the tree while the branch moves on. GitHub lists at most 100,000 entries; past that `truncated` is true and the list stops short. Submodules are left out.',
    },
  ),
  route(
    'repo.file',
    'GET',
    '/repo/file',
    '/api/repo/file',
    'read',
    'repo',
    'Read one file of a project’s repository as text',
    {
      query: ['repo', 'ref', 'path'],
      required: ['repo', 'path'],
      fields: {
        ref: ['string', 'A branch, tag or commit; the default branch when absent'],
        path: ['string', 'The file’s path from the repository’s root'],
      },
      returns: 'RepoFile',
      notes:
        'A file over 1 MB comes back with `tooLarge` and no `content`, and one that is not UTF-8 text with `binary`; `url` opens either on GitHub. A folder’s path gets 400, and a path the ref does not have 404.',
    },
  ),
  route(
    'repo.archive',
    'GET',
    '/repo/archive',
    '/api/repo/archive',
    'read',
    'repo',
    'Download a project’s repository at a commit as a gzipped tarball',
    {
      query: ['repo', 'ref'],
      required: ['repo', 'ref'],
      fields: {
        ref: ['string', 'A branch, tag or commit; the `sha` of `GET /repo/tree`, so the archive matches it'],
      },
      binary: true,
      notes:
        'Every file under one top folder, as GitHub builds it, for a client that indexes the code itself. Archives over 300 MiB (314,572,800 bytes) are refused: 413 before the download when GitHub declares the size; otherwise the connection is cut once the limit is exceeded, leaving a truncated archive after response headers have been sent.',
    },
  ),

  // ---- sessions ----
  route(
    'sessions.list',
    'GET',
    '/sessions',
    '/api/dev/sessions',
    'read',
    'any',
    'List the sessions of this token’s projects: pinned ones first, most recently pinned first, then the rest newest first',
    {
      returns: { sessions: 'Session[]' },
    },
  ),
  route(
    'sessions.create',
    'POST',
    '/sessions',
    '/api/dev/sessions',
    'manage',
    'repo',
    'Start a session; starts a paid agent',
    {
      body: [
        'repo',
        'prompt',
        ...RUNTIME,
        'branch',
        'prNumber',
        'attachments',
        'qa',
        'qaLoop',
        'local',
        'orchestrator',
        'workerRuntime',
        'activity',
      ],
      required: ['repo'],
      runtime: true,
      returns: SESSION,
      status: 201,
      notes: 'A plain session needs `prompt` or `attachments`; a `qa` needs `branch`.',
    },
  ),
  route(
    'session-files.publish',
    'POST',
    '/sessions/:id/files',
    '/api/dev/sessions/:id/files',
    'manage',
    'session',
    'Publish a downloadable session file from raw bytes',
    {
      raw: true,
      query: ['name'],
      returns: { name: 'string', size: 'integer', url: 'string' },
      notes:
        'Maximum 500 MiB; the URL grants download access to anyone holding it without an API token. Files are stored independently of the session workspace and uploaded to R2 when configured, with a local download fallback.',
    },
  ),
  route(
    'sessions.get',
    'GET',
    '/sessions/:id',
    '/api/dev/sessions/:id',
    'read',
    'session',
    'Read a session and its transcript',
    {
      query: ['since', 'all'],
      returns: { session: 'Session', events: 'TranscriptEvent[]' },
    },
  ),
  route(
    'sessions.events',
    'GET',
    '/sessions/:id/events',
    '/api/dev/sessions/:id/events',
    'read',
    'session',
    'Follow one session: transcript lines as unnamed events whose `id:` is their `seq`, and the record as `session` events',
    { query: ['since'], stream: true },
  ),
  route(
    'sessions.update',
    'PATCH',
    '/sessions/:id',
    '/api/dev/sessions/:id',
    'manage',
    'session',
    'Edit a session’s title, pin or compaction settings; one field per request',
    {
      body: ['title', 'autoCompact', 'compactInstructions', 'pinned'],
      returns: SESSION,
    },
  ),
  route(
    'sessions.delete',
    'DELETE',
    '/sessions/:id',
    '/api/dev/sessions/:id',
    'manage',
    'session',
    'Close a session and delete its record and transcript',
    {
      returns: OK,
    },
  ),
  personal('read', 'session')(
    'sessions.mailWake.get',
    'GET',
    '/sessions/:id/mail-wake',
    '/api/dev/sessions/:id/mail-wake',
    'Read a session’s email wake rules',
    { returns: { rules: 'object[]', perHour: 'integer', maxTurns: 'integer' } },
  ),
  personal('manage', 'session')(
    'sessions.mailWake.set',
    'PUT',
    '/sessions/:id/mail-wake',
    '/api/dev/sessions/:id/mail-wake',
    'Replace a session’s email wake rules',
    {
      body: ['rules', 'perHour', 'maxTurns'],
      required: ['rules'],
      fields: {
        rules: [
          'object[]',
          'Up to 20 { id?, account, enabled?, to?, from?, subject? } rules; account is a connected mailbox id, to matches exact To/Cc, from matches an exact sender, subject is a case-insensitive substring; [] disables wakes',
        ],
        perHour: ['integer', '1–600, default 30'],
        maxTurns: ['integer', '1–1000 automatic turns since the last operator message, default 10'],
      },
      returns: { rules: 'object[]', perHour: 'integer', maxTurns: 'integer' },
      notes:
        'Admin token required. Projects must enable mailToolsEnabled. Session agents can manage only their own rules through mail_set_wake_rules. Unchanged rule ids preserve their activation time; changed or new rules start now. New incoming inbox messages match all filters of any rule. Wakes wait behind running turns and questions, remain subject to unattended protections, and never reopen closed or failed sessions.',
    },
  ),
  route(
    'sessions.message',
    'POST',
    '/sessions/:id/messages',
    '/api/dev/sessions/:id/message',
    'manage',
    'session',
    'Send a message; it starts a turn, joins the running one or waits in the queue',
    {
      body: ['text', 'attachments'],
      returns: SESSION,
    },
  ),
  route(
    'sessions.dropQueued',
    'DELETE',
    '/sessions/:id/queue/:index',
    '/api/dev/sessions/:id/queue/:index',
    'manage',
    'session',
    'Take back a queued message, by its place in `session.queued`',
    {
      returns: { ok: 'boolean', dropped: 'object', session: 'Session' },
    },
  ),
  sessionAction('cancel', 'cancel', 'Stop the running turn'),
  sessionAction('close', 'close', 'Close a session, releasing its workspace and database server'),
  sessionAction(
    'reopen',
    'reopen',
    'Reopen a closed, failed or interrupted session without messaging the agent',
  ),
  sessionAction('serve', 'serve', 'Serve the session’s checkout with one of the project’s run profiles', {
    body: ['profile'],
    returns: { url: 'string', profile: 'string?' },
  }),
  route(
    'sessions.browser',
    'GET',
    '/sessions/:id/browser',
    '/api/dev/sessions/:id/browser',
    'read',
    'session',
    'Read the state of the session’s shared browser',
    {
      returns: { browser: 'Browser' },
    },
  ),
  route(
    'sessions.browserOpen',
    'POST',
    '/sessions/:id/browser',
    '/api/dev/sessions/:id/browser',
    'manage',
    'session',
    'Switch the shared browser on and start it; the agent drives it from its next turn',
    {
      returns: { session: 'Session', browser: 'Browser' },
      notes:
        '409 when the session is closed; reopen it first. 503 when the server has no Chromium. The profile (cookies, logins) lasts as long as the session.',
    },
  ),
  route(
    'sessions.browserClose',
    'DELETE',
    '/sessions/:id/browser',
    '/api/dev/sessions/:id/browser',
    'manage',
    'session',
    'Switch the shared browser off and stop it; its profile is kept until the session is deleted',
    { returns: SESSION },
  ),
  route(
    'sessions.browserStream',
    'GET',
    '/sessions/:id/browser/stream',
    '/api/dev/sessions/:id/browser/stream',
    'read',
    'session',
    'Watch the shared browser: `tabs` events `{ tabs, active }` on every tab change, `frame` events (a BrowserFrame) as the tab in view repaints, and `closed` when it stops, which ends the stream',
    {
      stream: true,
      notes:
        'The tabs and the latest frame are sent at once on connect. At most ten frames a second, and only while somebody watches; a reader that falls behind skips frames rather than queuing them. 409 when the browser is not running.',
    },
  ),
  route(
    'sessions.browserScreenshot',
    'GET',
    '/sessions/:id/browser/screenshot',
    '/api/dev/sessions/:id/browser/screenshot',
    'read',
    'session',
    'A PNG of the tab in view, for a client that does not hold a stream open',
    { binary: true, notes: '409 when the browser is not running.' },
  ),
  route(
    'sessions.browserInput',
    'POST',
    '/sessions/:id/browser/input',
    '/api/dev/sessions/:id/browser/input',
    'manage',
    'session',
    'Act in the shared browser: click, type, press a key, scroll, navigate or change tabs',
    {
      body: [
        'type',
        'x',
        'y',
        'button',
        'clickCount',
        'deltaX',
        'deltaY',
        'text',
        'key',
        'modifiers',
        'url',
        'tab',
      ],
      required: ['type'],
      fields: {
        type: [
          'click|down|up|move|wheel|type|key|navigate|back|forward|reload|tab|newTab|closeTab',
          'What to do. `click`, `down`, `up`, `move` and `wheel` take `x` and `y`; `type` takes `text`; `key` takes `key`; `navigate` takes `url`; `tab` and `closeTab` take `tab`',
        ],
        x: ['number', 'From the viewport’s left edge, in the CSS pixels of a frame’s `width`'],
        y: ['number', 'From the viewport’s top edge, in the CSS pixels of a frame’s `height`'],
        button: ['left|right|middle', 'The mouse button; `left` when absent'],
        clickCount: ['integer', '2 for a double click; 1 when absent'],
        deltaX: ['number', 'On `wheel`: pixels to scroll right'],
        deltaY: ['number', 'On `wheel`: pixels to scroll down'],
        text: ['string', 'On `type`: the text to insert where the focus is'],
        key: [
          'string',
          'On `key`: one character, or Enter, Tab, Backspace, Delete, Escape, ArrowLeft, ArrowUp, ArrowRight, ArrowDown, Home, End, PageUp, PageDown',
        ],
        modifiers: ['string[]', 'Keys held down: `alt`, `ctrl`, `meta`, `shift`'],
        url: ['string', 'On `navigate` and `newTab`: an http or https URL'],
        tab: [
          'string',
          'On `tab`: the tab to bring into view; on `closeTab`: the tab to close, the one in view when absent',
        ],
      },
      returns: OK,
      notes:
        '409 when the browser is not running. The agent drives the same tabs, so what it does mid-turn and what you do interleave.',
    },
  ),
  route(
    'sessions.stats',
    'GET',
    '/sessions/:id/stats',
    '/api/dev/sessions/:id/stats',
    'read',
    'session',
    'Read what a session costs the machine: CPU, memory, processes and workspace disk, with its recent history',
    {
      returns: { stats: 'SessionStats?', history: 'SessionStatsSample[]', host: 'HostStats' },
      notes:
        '`stats` is null and `history` empty while the session is not open. History keeps the last hour, oldest first, and starts over when the server restarts.',
    },
  ),
  route(
    'stats.sessions',
    'GET',
    '/stats/sessions',
    '/api/dev/stats/sessions',
    'read',
    'any',
    'Read what every open session of this token’s projects costs the machine, for a dashboard',
    {
      returns: { host: 'HostStats', sessions: 'SessionStats[]' },
      notes:
        'Only open sessions are listed. For a chart over time, read each session’s `/sessions/{id}/stats`.',
    },
  ),
  route(
    'stats.server',
    'GET',
    '/stats/server',
    '/api/dev/stats/server',
    'read',
    'any',
    'Read the machine’s and the Briareus server’s CPU, memory and disks, with their recent history',
    {
      returns: 'ServerStats',
      notes:
        'Machine-wide figures are the same for every token; the `sessions` totals count only this token’s projects.',
    },
  ),
  route(
    'stats.ci',
    'GET',
    '/stats/ci',
    '/api/dev/stats/ci',
    'read',
    'any',
    'Read durable CI/CD totals and trends across the token’s projects',
    {
      query: CI_QUERY,
      fields: CI_FIELDS,
      returns: {
        since: 'integer',
        until: 'integer',
        kind: 'check_run|status',
        currency: 'string',
        totals: 'CiMetrics',
        daily: 'CiDailyMetrics[]',
        repositories: 'CiRepositoryMetrics[]',
        checks: 'CiNamedMetrics[]',
        runnerGroups: 'CiRunnerGroupMetrics[]',
        runners: 'CiRunnerMetrics[]',
      },
      notes:
        'Observed checks only, collected by GitHub synchronization and signed webhooks; not a complete historical backfill. Daily buckets use UTC and omit empty days. Repeated observations do not increment totals. Durations exclude records without valid timestamps. Cost applies the current runner group rates (settings.ciRates) to recorded durations, so a rate change restates history; GitHub-hosted billing and idle server time are not included. All aggregates respect project access.',
    },
  ),
  route(
    'ci.runs',
    'GET',
    '/ci/runs',
    '/api/dev/ci/runs',
    'read',
    'any',
    'List persisted CI/CD checks with status, commit, duration and details URL',
    {
      query: [...CI_QUERY, 'limit', 'offset'],
      fields: CI_FIELDS,
      returns: {
        since: 'integer',
        until: 'integer',
        kind: 'check_run|status',
        currency: 'string',
        runs: 'CiRun[]',
        nextOffset: 'integer?',
        truncated: 'boolean',
      },
      notes:
        'Newest runAt first; use nextOffset until null and keep since/until fixed while paging. When more results exist beyond offset 100000, nextOffset is null and truncated is true; narrow the window or filters to retrieve them. Results can change during collection. Legacy statuses keep the latest transition per SHA/context; individual retries cannot be inferred from that API.',
    },
  ),
  sessionAction('compact', 'compact', 'Compact the session’s context now'),
  sessionAction(
    'btw',
    'btw',
    'Ask a side question (/btw) about a Claude session; the agent never sees it or its answer',
    {
      body: ['text'],
      required: ['text'],
      fields: { text: ['string', 'The question, without the `/btw`'] },
      returns: { session: 'Session', id: 'string', text: 'string', isError: 'boolean', costUsd: 'number?' },
      notes:
        'Answered from a fork of the conversation that is never saved, without tools, beside a running turn or on an idle session; waits for the answer. Both halves also land in the transcript as `btw` and `btw_answer` lines sharing an `id`. A message whose text starts with `/btw` does the same without waiting. 400 when the session is not a Claude one, has no conversation yet, is closed or is compacting; an answer that failed comes back with `isError`.',
    },
  ),
  sessionAction('clear', 'clear', 'Hide the transcript so far; the stored log keeps it', {
    returns: { session: 'Session', hidden: 'integer' },
  }),
  sessionAction('qa-loop', 'qa-loop', 'Arm or disarm automatic QA', { body: ['on'], required: ['on'] }),
  sessionAction(
    'link-pr',
    'link-pr',
    'Attach a pull request to the session after checking it is this session’s branch',
    {
      body: ['pr'],
      required: ['pr'],
    },
  ),
  route(
    'sessions.preview',
    'GET',
    '/sessions/:id/preview',
    '/api/operations/preview/:id',
    'read',
    'session',
    'Read where a session’s preview is being served',
    {
      returns: { title: 'string', links: 'object[]' },
    },
  ),
  route(
    'sessions.previewFeedback',
    'POST',
    '/sessions/:id/preview/feedback',
    '/api/operations/preview/:id',
    'manage',
    'session',
    'Send feedback on a preview page as a message with an annotated screenshot',
    {
      body: ['url', 'text', 'uploadId', 'width', 'height', 'x', 'y'],
      required: ['url', 'text', 'uploadId', 'width', 'height', 'x', 'y'],
      fields: { text: ['string', 'The feedback, up to 12,000 characters'] },
      returns: SESSION,
    },
  ),
  // The secret opens every preview hostname (as ▶ Run does for a manage token), so
  // manage access with no project scope.
  route(
    'preview.access',
    'GET',
    '/preview/access',
    null,
    'manage',
    'any',
    'The Cloudflare Access service token a client sends to ▶ Run preview hostnames',
    {
      returns: { clientId: 'string', clientSecret: 'string', hostSuffix: 'string' },
      notes:
        'Send `CF-Access-Client-Id` and `CF-Access-Client-Secret` only to hosts ending in `.` + `hostSuffix`. 404 when the server has no tunnel or no service token configured.',
    },
  ),
  // The webhook's signing keys let their holder put words in a session's
  // mouth, and recovery reaches any job by id, so both are the operator's.
  admin(
    'sessions.webhook',
    'GET',
    '/sessions/:id/webhook',
    '/api/dev/sessions/:id/webhook',
    'Read a session’s webhook: its settings, URLs and signing keys',
    {
      returns: 'Webhook',
    },
  ),
  admin(
    'sessions.setWebhook',
    'PUT',
    '/sessions/:id/webhook',
    '/api/dev/sessions/:id/webhook',
    'Change a session’s webhook settings',
    {
      body: [
        'armed',
        'perHour',
        'maxTurns',
        'sshUnattended',
        'instructions',
        'whatsappGroup',
        'whatsappAccount',
      ],
      fields: Object.fromEntries(
        [
          'armed',
          'perHour',
          'maxTurns',
          'sshUnattended',
          'instructions',
          'whatsappGroup',
          'whatsappAccount',
        ].map((name) => [name, OBJECTS.Webhook.fields[name]]),
      ),
      returns: 'Webhook',
    },
  ),
  admin(
    'sessions.rotateWebhook',
    'POST',
    '/sessions/:id/webhook/rotate',
    '/api/dev/sessions/:id/webhook/rotate',
    'Replace a session’s webhook keys; the old ones stop working',
    {
      returns: 'Webhook',
    },
  ),
  admin(
    'sessions.recovery',
    'GET',
    '/sessions/:id/recovery',
    '/api/operations/recovery/:id',
    'Inspect what an interrupted session left in its workspace',
    {
      returns: 'object',
      notes:
        '`{ id, status, expectedBranch, branch, head, changes, available, canResume, reason, phase, fingerprint }`.',
    },
  ),
  admin(
    'sessions.resume',
    'POST',
    '/sessions/:id/recovery',
    '/api/operations/recovery/:id',
    'Resume an interrupted session from the recovery report just read',
    {
      body: ['fingerprint'],
      required: ['fingerprint'],
      returns: SESSION,
    },
  ),
  personal('read', 'any')(
    'tasks.get',
    'GET',
    '/tasks/:id',
    '/api/operations/tasks/:id',
    'Read a task’s history: every session filed under it and what they cost together',
    {
      returns: { root: 'object', sessions: 'object[]', usage: 'object', prUrl: 'string?' },
      notes:
        'Kept after the sessions are deleted. A task you may not see (another user’s, or outside the token’s projects) answers 404.',
    },
  ),

  // ---- composer ----
  route(
    'prompts.list',
    'GET',
    '/prompts',
    '/api/dev/prompts',
    'read',
    'repo',
    'List the saved prompts a project offers; without `repo`, the whole library',
    {
      query: ['repo'],
      returns: { prompts: 'SavedPrompt[]' },
    },
  ),
  ...crud('prompts', '/prompts', '/api/dev/prompts', 'SavedPrompt', 'prompt', 'prompts').slice(1),
  route(
    'uploads.create',
    'POST',
    '/uploads',
    '/api/dev/uploads',
    'manage',
    'any',
    'Upload one attachment; send the returned id in a message’s `attachments`',
    {
      query: ['name'],
      required: ['name'],
      raw: true,
      returns: { file: 'object' },
      status: 201,
      notes: 'The file is `{ id, name, size }`.',
    },
  ),
  route(
    'transcribe.status',
    'GET',
    '/transcribe',
    '/api/dev/transcribe',
    'read',
    'any',
    'Whether this server can transcribe voice notes',
    {
      returns: { available: 'boolean' },
    },
  ),
  route(
    'transcribe.create',
    'POST',
    '/transcribe',
    '/api/dev/transcribe',
    'manage',
    'any',
    'Turn a recorded voice note into text; the recording is not kept',
    {
      raw: true,
      returns: { text: 'string' },
      notes:
        'Send the recording with the `Content-Type` it was recorded in, such as `audio/mp4` or `audio/webm`.',
    },
  ),
  admin(
    'providers.available',
    'GET',
    '/providers',
    '/api/dev/providers',
    'List the providers a session can start on, with every account’s login state and quota',
    {
      query: ['fresh'],
      returns: { providers: 'object[]' },
      notes:
        'An entry is `{ id, label, binary, available, models, defaultModel, efforts, modelEfforts, defaultEffort, auth, usage, accounts }`. Several logins to one service come back as one entry.',
    },
  ),

  // ---- memory ----
  route(
    'memories.list',
    'GET',
    '/memories',
    '/api/memories',
    'read',
    'repo',
    'List a project’s memories; without `repo`, every project’s',
    {
      query: ['repo'],
      returns: { memories: 'Memory[]' },
    },
  ),
  admin(
    'memories.health',
    'GET',
    '/memories/health',
    '/api/operations/memories',
    'Read the memory health report: what needs verifying and what looks duplicated',
    {
      query: ['repo'],
      returns: { memories: 'object[]', duplicates: 'object[]' },
      notes:
        'Each memory adds `archived`, `verifiedAt`, `revision` and `needsVerification`. A duplicate is `{ ids, similarity }`.',
    },
  ),
  admin(
    'memories.merge',
    'POST',
    '/memories/merge',
    '/api/operations/memories/merge/apply',
    'Merge two memories of one project: save the merged text on one and archive the other',
    {
      body: ['targetId', 'sourceId', 'body', 'revisions'],
      required: ['targetId', 'sourceId', 'body', 'revisions'],
      fields: {
        targetId: ['integer', 'The memory that keeps the merged text'],
        sourceId: ['integer', 'The memory to archive'],
        body: ['string', 'The merged text'],
        revisions: ['string[]', 'The `revision` of the target and of the source, as last read'],
      },
      returns: { memory: 'Memory' },
    },
  ),
  admin(
    'memories.policy',
    'POST',
    '/memories/:id/policy',
    '/api/operations/memories/:id',
    'Mark a memory verified, archive it or restore it',
    {
      body: ['action', 'revision'],
      required: ['action', 'revision'],
      fields: {
        action: ['verify|archive|restore', 'What to do'],
        revision: ['string', 'The memory’s `revision`, as last read; 409 if it changed'],
      },
      returns: { policy: 'object' },
    },
  ),
  ...crud('memories', '/memories', '/api/memories', 'Memory', 'memory', 'memories').slice(1),

  // ---- operations ----
  admin(
    'usage.overall',
    'GET',
    '/usage/all',
    '/api/dev/usage/all',
    'Read usage and costs across every project',
    {
      query: [
        'period',
        'from',
        'to',
        'project',
        'model',
        'provider',
        'activity',
        'account',
        'session',
        'user',
      ],
      fields: {
        user: [
          'string',
          'Only this user’s spend; a key from `options.users`, `unknown` for spend no user owns. Repeatable',
        ],
        model: ['string', 'Only this model. Repeatable'],
        provider: ['string', 'Only this provider. Repeatable'],
        activity: ['string', 'Only this kind of work. Repeatable'],
      },
      returns: 'object',
      notes:
        'Totals, `buckets` over time, breakdowns by `projects`, `providers`, `models`, `activities` and `users` (who owns the session each turn ran in), `topSessions`, a `comparison` with the window before, and the `options` each filter accepts.',
    },
  ),
  personal('read', 'any')(
    'attention.list',
    'GET',
    '/attention',
    '/api/operations/attention',
    'List what is waiting on you: questions, failures, SSH and Slack approvals',
    {
      returns: { items: 'object[]' },
      notes:
        'An admin sees every session’s items, a member their own and ownerless ones of their projects, held to the token’s projects. SSH commands are those you rule on (`GET /ssh/requests`), Slack messages those that would go out through your own workspaces. An item is `{ id, sessionId, taskId, revision, repo, title, kind, summary, href, at }`.',
    },
  ),
  admin(
    'maintenance.get',
    'GET',
    '/maintenance',
    '/api/operations/maintenance',
    'Read whether the server is draining work and what is still running',
    {
      returns: { draining: 'boolean', ready: 'boolean', active: 'object[]', sshRunning: 'integer' },
    },
  ),
  admin(
    'maintenance.set',
    'POST',
    '/maintenance',
    '/api/operations/maintenance',
    'Start or stop draining work',
    {
      body: ['draining'],
      required: ['draining'],
      returns: { draining: 'boolean', ready: 'boolean', active: 'object[]', sshRunning: 'integer' },
    },
  ),
  route(
    'ssh.requests',
    'GET',
    '/ssh/requests',
    '/api/ssh/requests',
    'manage',
    'any',
    'List the SSH commands agents are waiting for approval to run',
    {
      returns: { requests: 'object[]' },
      notes:
        'An admin sees every waiting command; a member only those of their own sessions. A project-limited token sees only its projects’.',
    },
  ),
  route(
    'ssh.decide',
    'POST',
    '/ssh/requests/:id/decision',
    '/api/ssh/requests/:id/decision',
    'manage',
    'any',
    'Approve or deny an SSH command',
    {
      body: ['decision'],
      required: ['decision'],
      fields: { decision: ['approve|deny', 'The ruling'] },
      returns: { request: 'object' },
      notes: 'A command the token may not see (see `GET /ssh/requests`) answers as one no longer waiting.',
    },
  ),
  homeAssistant('status', 'GET', '', 'Check the Home Assistant connection', {
    returns: { configured: 'boolean', connected: 'boolean' },
  }),
  homeAssistant('entities', 'GET', '/entities', 'Read current Home Assistant entities', {
    query: ['domain'],
    fields: { domain: ['string', 'Optional domain filter, such as light or vacuum'] },
    returns: { entities: 'HomeAssistantEntity[]' },
  }),
  homeAssistant('entity', 'GET', '/entities/:id', 'Read one Home Assistant entity', {
    returns: { entity: 'HomeAssistantEntity' },
  }),
  homeAssistant('services', 'GET', '/services', 'Discover available Home Assistant actions', {
    returns: { services: 'object[]' },
    notes:
      'Returns Home Assistant domain/service definitions, including service descriptions and fields, for clients to build action inputs.',
  }),
  homeAssistant('call', 'POST', '/services/:domain/:service', 'Execute a Home Assistant action', {
    bodyObject: 'HomeAssistantData',
    query: ['returnResponse'],
    fields: {
      returnResponse: [
        '0|1',
        '1 asks Home Assistant for service response data; use for services requiring a response',
      ],
    },
    returns: { entities: 'HomeAssistantEntity[]', response: 'object?' },
    notes:
      'Send service data directly as a JSON object, for example { "entity_id": "light.kitchen" } for light/turn_on. Returned entities are states changed during the call, not proof that a physical device completed the action. Services requiring response data need returnResponse=1; services that do not support it require the default 0. Do not automatically retry actions after a timeout or invalid receipt.',
  }),
  homeAssistant('event', 'POST', '/events/:type', 'Fire an event for Home Assistant automations', {
    bodyObject: 'HomeAssistantData',
    returns: OK,
    notes:
      'Send event data directly as a JSON object. Home Assistant owns event listeners and automations; an accepted event does not confirm that an automation finished.',
  }),
  whatsapp('accounts', 'GET', '', 'List linked WhatsApp accounts', {
    returns: { configured: 'boolean', accounts: 'WhatsAppAccount[]' },
    notes: `${WHATSAPP_NOTES} When disabled, returns { configured: false, accounts: [] }.`,
  }),
  whatsapp('account', 'GET', '/:id', 'Read a WhatsApp account’s connection status', {
    returns: { account: 'WhatsAppAccount' },
  }),
  whatsapp('start', 'POST', '/:id/start', 'Start or reconnect an account; create default when absent', {
    returns: { account: 'WhatsAppAccount' },
  }),
  whatsapp('qr', 'GET', '/:id/qr', 'Get the pairing QR code as a base64 PNG', {
    access: 'manage',
    returns: { mimetype: 'string', data: 'string' },
    notes: `${WHATSAPP_NOTES} Available in SCAN_QR_CODE; refresh periodically until WORKING. Scan from WhatsApp → Linked devices → Link a device. Do not store QR codes.`,
  }),
  whatsapp('logout', 'POST', '/:id/logout', 'Unlink the phone from WAHA', { returns: OK }),
  whatsapp('conversations', 'GET', '/:id/conversations', 'List WhatsApp chats, newest activity first', {
    query: ['limit', 'offset'],
    fields: WHATSAPP_PAGE,
    returns: { conversations: 'object[]', nextOffset: 'integer?' },
    notes: `${WHATSAPP_NOTES} Each chat is { id, name, unreadCount, lastMessage: WhatsAppMessage|null }; unreadCount may be null when the engine omits it.`,
  }),
  whatsapp('messages', 'GET', '/:id/conversations/:chat/messages', 'Read WhatsApp history, newest first', {
    query: ['limit', 'offset'],
    fields: WHATSAPP_PAGE,
    returns: { messages: 'WhatsAppMessage[]', nextOffset: 'integer?' },
    notes: `${WHATSAPP_NOTES} Offset pagination can overlap when new messages arrive; deduplicate by ID. nextOffset advances by the requested limit even for short or empty pages, because WAHA filters protocol records after paging. There is no reliable end-of-history indicator; null nextOffset marks the supported offset bound.`,
  }),
  whatsapp(
    'send',
    'POST',
    '/:id/conversations/:chat/messages',
    'Send a text message or quoted reply as the operator',
    {
      body: ['text', 'replyTo'],
      required: ['text'],
      fields: {
        text: ['string', 'Message text, 1–8000 characters'],
        replyTo: ['string', 'Optional quoted message ID from this chat'],
      },
      returns: { message: 'WhatsAppMessage' },
      status: 201,
    },
  ),
  whatsapp('read', 'POST', '/:id/conversations/:chat/read', 'Mark unread WhatsApp messages as read', {
    returns: OK,
  }),
  whatsapp(
    'media',
    'GET',
    '/:id/conversations/:chat/messages/:message/media',
    'Download a message attachment through the core',
    {
      binary: true,
      notes: `${WHATSAPP_NOTES} Downloads only WAHA local file storage; the API key never reaches clients. Returns the attachment’s media type and Content-Disposition: attachment. Availability depends on the WAHA edition/engine; 501 for unsupported operations.`,
    },
  ),
  personal('read', 'any')(
    'slack.workspaces',
    'GET',
    '/slack/workspaces',
    '/api/slack/inbox/workspaces',
    'List the workspaces available to the operator’s Slack inbox',
    { returns: { workspaces: 'SlackWorkspace[]' }, notes: SLACK_NOTES },
  ),
  slackInbox('slack.conversations', 'GET', '/conversations', 'List channels, DMs and group DMs', {
    query: ['cursor', 'limit', 'types'],
    fields: {
      ...SLACK_PAGE,
      types: ['string', 'Comma-separated public_channel, private_channel, im and mpim; all four by default'],
    },
    returns: { conversations: 'object[]', nextCursor: 'string' },
  }),
  slackInbox('slack.conversation', 'GET', '/conversations/:channel', 'Read a conversation’s details', {
    returns: { conversation: 'object' },
  }),
  slackInbox('slack.people', 'GET', '/people', 'Read the workspace’s directory to resolve message authors', {
    query: ['cursor', 'limit'],
    fields: SLACK_PAGE,
    returns: { people: 'object[]', nextCursor: 'string' },
  }),
  slackInbox('slack.openDm', 'POST', '/direct-messages', 'Open a direct message with a Slack user', {
    body: ['userId'],
    required: ['userId'],
    fields: { userId: ['string', 'A Slack user ID from the workspace directory'] },
    returns: { conversation: 'object' },
    status: 201,
  }),
  slackInbox(
    'slack.messages',
    'GET',
    '/conversations/:channel/messages',
    'Read a page of conversation history',
    {
      query: ['cursor', 'limit', 'oldest', 'latest'],
      fields: SLACK_HISTORY,
      returns: { messages: 'object[]', nextCursor: 'string', hasMore: 'boolean' },
    },
  ),
  slackInbox(
    'slack.thread',
    'GET',
    '/conversations/:channel/threads/:ts',
    'Read a thread’s parent and replies',
    {
      query: ['cursor', 'limit', 'oldest', 'latest'],
      fields: SLACK_HISTORY,
      returns: { messages: 'object[]', nextCursor: 'string', hasMore: 'boolean' },
    },
  ),
  slackInbox(
    'slack.send',
    'POST',
    '/conversations/:channel/messages',
    'Send a message or thread reply as the operator',
    {
      body: ['text', 'threadTs'],
      required: ['text'],
      fields: {
        text: ['string', 'The message in Slack mrkdwn, 1–8000 characters'],
        threadTs: [
          'string',
          'The parent message’s Slack timestamp for a thread reply; omit for a top-level message',
        ],
      },
      returns: { channel: 'string', ts: 'string', message: 'object' },
      status: 201,
      notes: `${SLACK_NOTES} Human-authored messages send immediately, without an agent approval. If credentials change or the workspace is removed during a confirmed send, returns 201 with only { channel, ts, workspaceChanged: true }; refresh the workspace and do not resend. Do not automatically retry an ambiguous failed send.`,
    },
  ),
  slackInbox(
    'slack.read',
    'POST',
    '/conversations/:channel/read',
    'Mark a conversation read through a message',
    {
      body: ['ts'],
      required: ['ts'],
      fields: {
        ts: ['string', 'The latest viewed message’s Slack timestamp; debounce updates per conversation'],
      },
      returns: OK,
    },
  ),
  slackInbox('slack.events', 'GET', '/events', 'Follow new Slack messages, edits and deletions live', {
    stream: true,
    notes: `${SLACK_NOTES} Requires a signing secret and Slack Event Subscriptions (409 if the secret is missing). Sends ready {workspaceId, userId, refresh:true}, then message / message.changed / message.deleted {workspaceId, eventId, event}, and conversation.read {workspaceId, channel, ts}. message.changed includes thread-parent updates (message_replied). Includes the operator’s own messages and bots. No replay: connect first, reload history on every ready, and merge by channel and ts. workspace.changed or workspace.removed ends the stream; refresh the workspace list before reconnecting. Token revocation ends the connection within 15 seconds.`,
  }),
  personal('manage', 'any')(
    'slack.requests',
    'GET',
    '/slack/requests',
    '/api/slack/requests',
    'List the Slack messages agents are waiting for approval to send',
    {
      returns: { requests: 'object[]' },
      notes:
        'Only messages that would go out through your own workspaces: whoever connected a workspace rules on what is sent in their name. A request is `{ id, workspaceLabel, sendsAs, repo, jobId, sessionTitle, to: { kind, id, label }, text, threadTs, status, createdAt, expiresAt, unattended }`. One waits a day at most.',
    },
  ),
  personal('manage', 'any')(
    'slack.decide',
    'POST',
    '/slack/requests/:id/decision',
    '/api/slack/requests/:id/decision',
    'Approve or deny a Slack message; approving sends it',
    {
      body: ['decision'],
      required: ['decision'],
      fields: { decision: ['approve|deny', 'The ruling'] },
      returns: { request: 'object' },
      notes: 'The request comes back `sent` or `failed`, with `error` saying why.',
    },
  ),
  admin(
    'deployments.get',
    'GET',
    '/deployments',
    '/api/operations/deployments',
    'Read a project’s deployments: its settings, the last attempt and recent history',
    {
      query: ['repo'],
      required: ['repo'],
      returns: {
        config: 'object?',
        attempt: 'object?',
        history: 'object[]',
        active: 'object[]',
        health: 'object',
        checkedAt: 'string',
      },
    },
  ),
  admin(
    'deployments.config',
    'GET',
    '/deployments/config',
    '/api/operations/deployments/config',
    'Read a project’s deployment settings',
    {
      query: ['repo'],
      required: ['repo'],
      returns: { config: 'object?', attempt: 'object?' },
    },
  ),
  admin(
    'deployments.configure',
    'POST',
    '/deployments/config',
    '/api/operations/deployments/config',
    'Set which workflow deploys a project',
    {
      query: ['repo'],
      required: ['repo', 'environment', 'workflow', 'workflowRef', 'sourceRef', 'revisionInput'],
      body: [
        'environment',
        'workflow',
        'workflowRef',
        'sourceRef',
        'revisionInput',
        'requireChecks',
        'healthUrl',
      ],
      fields: {
        environment: ['string', 'The GitHub environment deployed to'],
        workflow: ['string', 'The workflow file name'],
        workflowRef: ['string', 'The ref the workflow is run from'],
        sourceRef: ['string', 'The ref that gets deployed'],
        revisionInput: ['string', 'The workflow input that takes the commit'],
        requireChecks: ['boolean', 'Refuse to deploy a commit whose CI is not green; true when absent'],
        healthUrl: ['string', 'A URL to check after deploying'],
      },
      returns: 'object',
    },
  ),
  admin(
    'deployments.plan',
    'POST',
    '/deployments/plan',
    '/api/operations/deployments/plan',
    'Plan a deployment: resolve the commit and check it can go',
    {
      query: ['repo'],
      required: ['repo'],
      returns: 'object',
    },
  ),
  admin(
    'deployments.dispatch',
    'POST',
    '/deployments/dispatch',
    '/api/operations/deployments/dispatch',
    'Run a planned deployment',
    {
      query: ['repo'],
      body: ['planId'],
      required: ['repo', 'planId'],
      returns: 'object',
    },
  ),
  admin(
    'deployments.acknowledge',
    'POST',
    '/deployments/acknowledge',
    '/api/operations/deployments/acknowledge',
    'Acknowledge the last deployment so another can be requested',
    {
      query: ['repo'],
      required: ['repo'],
      returns: 'object',
    },
  ),
  // ---- Laravel Forge, proxied with a stored account's token ----
  admin(
    'forge.servers',
    'GET',
    '/forge/accounts/:account/servers',
    '/api/forge/accounts/:account/servers',
    'List a Forge account’s servers',
    {
      query: ['cursor'],
      fields: { cursor: FORGE_CURSOR },
      returns: { servers: 'ForgeServer[]', nextCursor: 'string?' },
      notes: FORGE_NOTES,
    },
  ),
  admin(
    'forge.sites',
    'GET',
    '/forge/accounts/:account/servers/:server/sites',
    '/api/forge/accounts/:account/servers/:server/sites',
    'List a Forge server’s sites',
    {
      query: ['cursor'],
      fields: { cursor: FORGE_CURSOR },
      returns: { sites: 'ForgeSite[]', nextCursor: 'string?' },
      notes: FORGE_NOTES,
    },
  ),
  admin(
    'forge.site',
    'GET',
    '/forge/accounts/:account/servers/:server/sites/:site',
    '/api/forge/accounts/:account/servers/:server/sites/:site',
    'Read one Forge site',
    {
      returns: { site: 'ForgeSite' },
    },
  ),
  admin(
    'forge.deploymentScript.get',
    'GET',
    '/forge/accounts/:account/servers/:server/sites/:site/deployment-script',
    '/api/forge/accounts/:account/servers/:server/sites/:site/deployment-script',
    'Read a Forge site’s deployment script',
    {
      returns: FORGE_SCRIPT,
    },
  ),
  admin(
    'forge.deploymentScript.set',
    'PUT',
    '/forge/accounts/:account/servers/:server/sites/:site/deployment-script',
    '/api/forge/accounts/:account/servers/:server/sites/:site/deployment-script',
    'Replace a Forge site’s deployment script',
    {
      body: ['content', 'autoSource'],
      required: ['content'],
      fields: {
        content: ['string', 'The whole script'],
        autoSource: ['boolean', 'Whether the script runs with the site’s .env loaded; unchanged when absent'],
      },
      returns: FORGE_SCRIPT,
    },
  ),
  admin(
    'forge.env.get',
    'GET',
    '/forge/accounts/:account/servers/:server/sites/:site/env',
    '/api/forge/accounts/:account/servers/:server/sites/:site/env',
    'Read a Forge site’s .env',
    {
      returns: { content: 'string' },
    },
  ),
  admin(
    'forge.env.set',
    'PUT',
    '/forge/accounts/:account/servers/:server/sites/:site/env',
    '/api/forge/accounts/:account/servers/:server/sites/:site/env',
    'Replace a Forge site’s .env',
    {
      body: ['content'],
      required: ['content'],
      fields: { content: ['string', 'The whole file'] },
      returns: OK,
      notes:
        'Forge accepts the file and writes it to the server shortly after, so `ok` means accepted. It does not clear the config cache or restart queue workers.',
    },
  ),
  // ---- Laravel Envoyer, proxied with a project's Envoyer accounts ----
  route(
    'envoyer.accounts',
    'GET',
    '/envoyer/accounts',
    '/api/envoyer/available',
    'read',
    'repo',
    'List the Envoyer accounts available to a project',
    {
      query: ['repo'],
      required: ['repo'],
      returns: { accounts: 'EnvoyerAccount[]' },
    },
  ),
  envoyer('envoyer.projects', 'GET', ENVOYER_AT, 'List the account’s Envoyer projects', {
    returns: { projects: 'object[]' },
  }),
  envoyer('envoyer.project', 'GET', `${ENVOYER_AT}/:project`, 'Read one Envoyer project', {
    returns: { project: 'object' },
  }),
  envoyer('envoyer.servers', 'GET', `${ENVOYER_AT}/:project/servers`, 'List an Envoyer project’s servers', {
    returns: { servers: 'object[]' },
  }),
  envoyer(
    'envoyer.deployments',
    'GET',
    `${ENVOYER_AT}/:project/deployments`,
    'List an Envoyer project’s deployments',
    { returns: { deployments: 'object[]' } },
  ),
  envoyer(
    'envoyer.deployment',
    'GET',
    `${ENVOYER_AT}/:project/deployments/:deployment`,
    'Read one Envoyer deployment',
    { returns: { deployment: 'object' } },
  ),
  envoyer('envoyer.deploy', 'POST', `${ENVOYER_AT}/:project/deployments`, 'Deploy an Envoyer project', {
    body: ['repo', 'branch', 'tag'],
    fields: {
      branch: [
        'string',
        'The branch to deploy; the project’s own branch when neither this nor `tag` is sent',
      ],
      tag: ['string', 'The tag to deploy, instead of a branch'],
    },
    returns: OK,
    notes: `${ENVOYER_NOTES} \`ok\` means Envoyer queued it; the deployments list shows it run. The account’s token needs the \`deployments:create\` scope.`,
  }),
  // ---- mail, synced from Gmail and Outlook ----
  personal('read', 'any')(
    'mail.messages',
    'GET',
    '/mail/messages',
    '/api/mail/messages',
    'List the synced mail, newest first, of every connected mailbox or one',
    {
      query: ['account', 'q', 'unread', 'inbox', 'starred', 'label', 'thread', 'cursor', 'limit'],
      fields: {
        account: ['integer', 'Only this `MailAccount`; every one when absent'],
        q: ['string', 'Only messages whose subject, sender or snippet contains this, case-insensitively'],
        unread: ['0|1', '`1` only unread messages, `0` only read ones'],
        inbox: ['0|1', '`1` only what is in the inbox, `0` only what is not'],
        starred: ['0|1', '`1` only starred (Gmail) or flagged (Outlook) messages'],
        label: ['string', 'Only messages carrying this label or folder name exactly, as `labels` lists it'],
        thread: ['string', 'Only this conversation, a `threadId`'],
        cursor: ['string', 'The `nextCursor` of the page before; the newest page when absent'],
        limit: ['integer', 'How many to a page, 1–100; 50 when absent'],
      },
      returns: { messages: 'MailMessageSummary[]', nextCursor: 'string?' },
      notes:
        'Read from the server’s copy, not the provider: what the last sync saw, at most `MAIL_SYNC_MINUTES` old. `nextCursor` is null on the last page. Nothing here changes the mailbox; reading a message does not mark it read.',
    },
  ),
  personal('read', 'any')(
    'mail.message',
    'GET',
    '/mail/accounts/:account/messages/:id',
    '/api/mail/accounts/:account/messages/:id',
    'Read one synced message with its body',
    {
      returns: { message: 'MailMessage' },
      notes:
        'URL-encode the message’s `id`: an Outlook id may hold `/`, `+` and `=`. 404 when the account or the message is not there, which a message deleted or moved to the trash is from the next sync on.',
    },
  ),
  personal('manage', 'any')(
    'mail.message.delete',
    'DELETE',
    '/mail/accounts/:account/messages/:id',
    '/api/mail/accounts/:account/messages/:id',
    'Move one synced message to the provider trash and remove the synced copy',
    {
      returns: OK,
      notes:
        'Moves only this message, not its thread, to Gmail Trash or Outlook Deleted Items; it does not permanently erase it. URL-encode `id`. Existing read-only connections need reconnecting with access: manage for gmail.modify or Mail.ReadWrite; otherwise 409. 404 for a missing account or cached message. Provider failures keep the synced copy; an uncertain write is not automatically retried.',
    },
  ),
  personal('manage', 'any')(
    'mail.message.reply',
    'POST',
    '/mail/accounts/:account/messages/:id/reply',
    '/api/mail/accounts/:account/messages/:id/reply',
    'Send a plain-text reply to one synced message as the mailbox owner',
    {
      body: ['text'],
      required: ['text'],
      fields: { text: ['string', 'The reply body, plain text, at most 100000 characters'] },
      returns: { status: 'string', action: 'string' },
      notes:
        'Goes to the original’s Reply-To, or its sender, threaded on its Message-ID; `status` is `accepted` once the provider took it. URL-encode `id`. Read-only connections need reconnecting with access: manage; otherwise 403. A 502 means the send may have gone out: sync and check Sent before retrying.',
    },
  ),
  admin('videos.get', 'GET', '/videos/*file', '/videos/*file', 'Download a video a test run recorded', {
    binary: true,
  }),

  // ---- settings ----
  admin(
    'settings.projects.order',
    'PUT',
    '/settings/projects/order',
    '/api/projects/order',
    'Put the projects in a new order',
    {
      body: ['ids'],
      required: ['ids'],
      returns: { projects: 'Project[]' },
    },
  ),
  ...crud('settings.projects', '/settings/projects', '/api/projects', 'Project', 'project', 'projects'),
  admin('settings.shares.list', 'GET', '/settings/shares', '/api/shares', 'List what is shared with whom', {
    query: ['kind', 'id', 'user'],
    fields: {
      kind: ['project|dbServer|sshServer|mcpServer|forgeAccount|envoyerAccount', 'Only this kind'],
      id: ['string', 'Only this resource, by its id'],
      user: ['integer', 'Only what is shared with this user'],
    },
    returns: { shares: 'Share[]' },
    notes:
      'An admin reaches every project and server whether or not it is shared; a member only what is shared with them. Shares of a resource that was removed are not listed.',
  }),
  admin(
    'settings.shares.set',
    'PUT',
    '/settings/shares',
    '/api/shares',
    'Choose the users one project or server is shared with',
    {
      body: ['kind', 'id', 'userIds'],
      required: ['kind', 'id', 'userIds'],
      fields: {
        kind: ['project|dbServer|sshServer|mcpServer|forgeAccount|envoyerAccount', 'What is shared'],
        id: ['string', 'Its id, as its own settings list gives it'],
        userIds: ['integer[]', 'Every user it is shared with; an empty list shares it with nobody'],
      },
      returns: { kind: 'string', id: 'string', userIds: 'integer[]' },
      notes:
        'Replaces the whole list. A member loses a project from every token they hold as soon as it is no longer shared with them.',
    },
  ),
  ...['GET', 'POST'].map((method) =>
    admin(
      `settings.projects.backup.${method === 'GET' ? 'get' : 'run'}`,
      method,
      '/settings/projects/:id/backup',
      '/api/projects/:id/backup',
      method === 'GET' ? 'Read the last main database backup status' : 'Back up the main database to R2 now',
      { returns: { status: 'object?' }, ...(method === 'POST' ? { status: 202 } : {}) },
    ),
  ),
  admin(
    'settings.projects.update.get',
    'GET',
    '/settings/projects/:id/update',
    '/api/projects/:id/update',
    'Read how the project’s local checkout last updated itself',
    {
      returns: { status: 'object?' },
      notes:
        '`status` is null before the first update. Otherwise `{ state, trigger, startedAt, finishedAt, branch, from, to, reason, steps, output }`, where `state` is waiting, running, updated, skipped, failed or interrupted.',
    },
  ),
  admin(
    'settings.projects.update.run',
    'POST',
    '/settings/projects/:id/update',
    '/api/projects/:id/update',
    'Pull the project’s local checkout and run its update commands now',
    {
      returns: { status: 'object?' },
      status: 202,
      notes: 'Answers once the update has started; read the status to follow it.',
    },
  ),
  admin(
    'settings.templates',
    'GET',
    '/settings/templates',
    '/api/templates',
    'Read the prompt templates: the overrides in force and the catalog of what can be overridden',
    {
      returns: { templates: 'object[]', defaults: 'object', catalog: 'object[]' },
      notes:
        '`templates` is one row, `{ id: 1, values }`. A catalog entry is `{ id, label, hint, vars, builtIn }`.',
    },
  ),
  admin(
    'settings.setTemplates',
    'PUT',
    '/settings/templates',
    '/api/templates/1',
    'Change the prompt templates',
    {
      body: ['values'],
      required: ['values'],
      returns: { templates: 'object' },
    },
  ),
  admin('settings.ciRates', 'GET', '/settings/ci-rates', '/api/dev/ci/rates', 'Read CI runner group rates', {
    returns: 'CiRates',
  }),
  admin(
    'settings.setCiRates',
    'PUT',
    '/settings/ci-rates',
    '/api/dev/ci/rates',
    'Replace the hourly cost of each CI runner group',
    {
      body: ['currency', 'groups'],
      required: ['groups'],
      fields: {
        currency: ['string', 'Three-letter currency code; USD when absent'],
        groups: ['object', 'Runner group name → cost per runner-hour (≥ 0)'],
      },
      returns: 'CiRates',
      notes:
        'Replaces every rate. A rate is per runner-hour: a server running four runners at once and costing 1/hour is 0.25 per runner. 0 prices a group as free; leave a group out to report its time as unpriced. Runner group names are those in `/stats/ci` `runnerGroups`, matched exactly. 400 on an invalid currency or rate, or more than 100 groups.',
    },
  ),
  admin(
    'settings.providers.test',
    'POST',
    '/settings/providers/test',
    '/api/providers/test',
    'Probe a provider endpoint and key as a form holds them, before saving',
    {
      body: ['binary', 'baseUrl', 'apiKey', 'defaultModel', 'models', 'id'],
      fields: {
        binary: OBJECTS.Provider.fields.binary,
        baseUrl: OBJECTS.Provider.fields.baseUrl,
        apiKey: OBJECTS.Provider.fields.apiKey,
        defaultModel: ['string', 'The model to probe with when the endpoint lists none'],
        models: ['string[]', 'The models the form lists'],
        id: ['integer', 'The saved row being edited, if any'],
      },
      returns: { models: 'string[]', probedModel: 'string' },
      notes:
        '`probedModel` is present only when the endpoint has no model list and was probed with a chat call instead.',
    },
  ),
  ...crud('settings.providers', '/settings/providers', '/api/providers', 'Provider', 'provider', 'providers'),
  admin(
    'settings.providers.status',
    'GET',
    '/settings/providers/:id/status',
    '/api/providers/:id/status',
    'Read one provider’s connection: CLI found, login state, account and quota',
    {
      query: ['fresh'],
      returns: { status: 'object' },
      notes: '`status` is `{ available, binSource, loginDir, auth, usage }`.',
    },
  ),
  admin(
    'settings.providers.login',
    'POST',
    '/settings/providers/:id/login',
    '/api/providers/:id/login',
    'Start a codex or grok device login',
    {
      returns: { url: 'string', deviceCode: 'string?' },
      notes:
        'Open `url` in a browser and approve; codex also shows `deviceCode` to type in. Answers `{ ok: true }` when the entry is already logged in.',
    },
  ),
  admin(
    'settings.providers.loginStart',
    'POST',
    '/settings/providers/:id/login/start',
    '/api/providers/:id/login/start',
    'Start a claude login',
    {
      returns: { url: 'string' },
      notes: 'Open `url`, approve, and send the code it shows to `…/login/finish`.',
    },
  ),
  admin(
    'settings.providers.loginFinish',
    'POST',
    '/settings/providers/:id/login/finish',
    '/api/providers/:id/login/finish',
    'Finish a claude login with the code the authorization page showed',
    {
      body: ['code'],
      required: ['code'],
      fields: { code: ['string', 'The code the authorization page showed'] },
      returns: { provider: 'Provider' },
    },
  ),
  admin(
    'settings.dbServers.test',
    'POST',
    '/settings/db-servers/test',
    '/api/dbservers/test',
    'Probe a database server as a form holds it, before saving',
    {
      body: ['host', 'port', 'username', 'password', 'id'],
      fields: {
        host: OBJECTS.DbServer.fields.host,
        port: OBJECTS.DbServer.fields.port,
        username: OBJECTS.DbServer.fields.username,
        password: ['string', 'That user’s password'],
        id: ['integer', 'The saved row being edited, if any'],
      },
      returns: {
        version: 'string',
        databases: 'integer',
        claimedBy: 'object?',
        capacity: 'integer',
        poolSize: 'integer',
      },
    },
  ),
  ...crud('settings.dbServers', '/settings/db-servers', '/api/dbservers', 'DbServer', 'server', 'servers'),
  admin(
    'settings.workspaces.list',
    'GET',
    '/settings/workspaces',
    '/api/workspaces',
    'List the workspace clone slots and what holds each',
    {
      returns: { workspaces: 'Workspace[]' },
    },
  ),
  admin(
    'settings.workspaces.resetSetup',
    'POST',
    '/settings/workspaces/:slot/reset-setup',
    '/api/workspaces/:slot/reset-setup',
    'Forget an idle slot’s install fingerprints, so its next session installs everything',
    {
      returns: { slot: 'string' },
    },
  ),
  admin(
    'settings.workspaces.clean',
    'POST',
    '/settings/workspaces/:slot/clean',
    '/api/workspaces/:slot/clean',
    'Remove an idle slot’s dependency trees',
    {
      returns: { slot: 'string', removed: 'string[]' },
    },
  ),
  ...crud(
    'settings.forgeAccounts',
    '/settings/forge/accounts',
    '/api/forge/accounts',
    'ForgeAccount',
    'account',
    'accounts',
  ).map((r) =>
    r.id === 'settings.forgeAccounts.list'
      ? {
          ...r,
          query: ['repo'],
          fields: { repo: ['string', 'Only the accounts available to this project, as `owner/name`'] },
        }
      : r,
  ),
  ...crud(
    'settings.sshServers',
    '/settings/ssh/servers',
    '/api/ssh/servers',
    'SshServer',
    'server',
    'servers',
  ),
  route(
    'ssh.servers',
    'GET',
    '/ssh/servers',
    '/api/ssh/monitoring',
    'read',
    'any',
    'List SSH servers with their latest resource sample and freshness',
    {
      returns: { servers: 'SshResourceServer[]', intervalSeconds: 'integer', retentionHours: 'integer' },
      notes:
        'Members see only shared SSH servers in their token’s projects. Admins also remain held to a project-limited token. Only an admin can enable monitoring in SSH settings.',
    },
  ),
  route(
    'ssh.resources',
    'GET',
    '/ssh/servers/:id/resources',
    '/api/ssh/servers/:id/resources',
    'read',
    'any',
    'Read an SSH server’s rolling 24-hour resource history',
    {
      query: ['since'],
      fields: {
        since: [
          'integer',
          'Unix milliseconds; clamped to the last 24 hours, omitted returns the whole retained window',
        ],
      },
      returns: {
        serverId: 'integer',
        intervalSeconds: 'integer',
        retentionHours: 'integer',
        from: 'integer',
        to: 'integer',
        samples: 'SshResourceSample[]',
      },
      notes:
        'Same server visibility as GET /ssh/servers; missing or unshared servers return 404. Samples are ordered oldest first, capped at 1441; gaps indicate missed collection. CPU and network rates require two samples. Connection/project changes start a separate history. Read from MySQL, with no remote command on client requests.',
    },
  ),
  admin(
    'settings.sshServers.monitorToken',
    'POST',
    '/settings/ssh/servers/:id/monitor-token',
    '/api/ssh/servers/:id/monitor-token',
    'Enable telemetry and issue or rotate the separate monitor service’s per-server credential',
    {
      returns: {
        serverId: 'integer',
        endpoint: 'string',
        token: 'string',
        intervalSeconds: 'integer',
        retentionHours: 'integer',
      },
      notes:
        'Token shown once, only its hash is stored; grants only sample ingestion for this server, never operator APIs or SSH. A new token revokes the previous one. Save the response as the service’s private config; never in Git. Install nadinyamaui/briareus-monitor once over SSH. Requires PUBLIC_BASE_URL with HTTPS.',
    },
  ),
  admin(
    'settings.sshServers.revokeMonitorToken',
    'DELETE',
    '/settings/ssh/servers/:id/monitor-token',
    '/api/ssh/servers/:id/monitor-token',
    'Revoke a monitor credential and stop accepting that server’s telemetry',
    { returns: OK },
  ),
  admin(
    'settings.sshServers.dbCredentials',
    'GET',
    '/settings/ssh/servers/:id/db-credentials',
    '/api/ssh/servers/:id/db-credentials',
    'Read the server’s database login, decrypted, to connect through an SSH tunnel to `host`:`port` on it. 404 when none is stored',
    {
      returns: { credentials: 'DbCredentials' },
    },
  ),
  ...crud(
    'settings.mcpServers',
    '/settings/mcp/servers',
    '/api/mcp/servers',
    'McpServer',
    'server',
    'servers',
  ).map((r) =>
    r.id === 'settings.mcpServers.create'
      ? {
          ...r,
          notes:
            'Checks the server at once. One that signs in with OAuth answers with `status: needs-sign-in` and a `signInUrl` to open; nothing else is needed to finish the setup.',
        }
      : r,
  ),
  admin(
    'settings.mcpServers.connect',
    'POST',
    '/settings/mcp/servers/:id/connect',
    '/api/mcp/servers/:id/connect',
    'Check a server again; for one that signs in with OAuth and is not signed in, start the sign-in',
    {
      body: ['signIn'],
      fields: { signIn: ['boolean', 'Start a fresh sign-in even when the stored one works'] },
      returns: { server: 'McpServer' },
    },
  ),
  admin(
    'settings.mcpServers.finishSignIn',
    'POST',
    '/settings/mcp/servers/:id/finish-sign-in',
    '/api/mcp/servers/:id/finish-sign-in',
    'Finish a loopback sign-in with the address the browser was sent to',
    {
      body: ['url'],
      required: ['url'],
      fields: {
        url: [
          'string',
          'The whole address the browser ended on, `http://127.0.0.1:<port>/callback?code=…&state=…`',
        ],
      },
      returns: { server: 'McpServer' },
      notes:
        '400 when the address has no code and state, is from another server’s sign-in, or the sign-in expired.',
    },
  ),
  ...crud(
    'settings.slackWorkspaces',
    '/settings/slack/workspaces',
    '/api/slack/workspaces',
    'SlackWorkspace',
    'workspace',
    'workspaces',
  ).map((r) =>
    // A workspace's token sends as whoever connected it, so each user sees and changes only
    // their own; a new one is theirs.
    r.id === 'settings.slackWorkspaces.list'
      ? {
          ...r,
          access: 'read',
          summary: 'List your Slack workspaces, with the values a new one starts from',
          query: ['repo'],
          fields: { repo: ['string', 'Only the workspace this project sends through, as `owner/name`'] },
        }
      : /** @type {Record<string, any>} */ ({ ...r, access: 'manage' }),
  ),
  personal('read', 'any')(
    'settings.mailAccounts.list',
    'GET',
    '/settings/mail/accounts',
    '/api/mail/accounts',
    'List the connected mailboxes, which providers this server can connect, and the values a new one starts from',
    {
      returns: {
        accounts: 'MailAccount[]',
        providers: 'string[]',
        callbackUrl: 'string',
        defaults: 'object',
      },
      notes:
        '`providers` holds `gmail` when the server has a Google OAuth client (`GOOGLE_OAUTH_*`) and `outlook` when it has a Microsoft one (`MICROSOFT_OAUTH_*`). `callbackUrl` is this server’s own sign-in callback (`PUBLIC_BASE_URL/oauth/mail/callback`): register it as the OAuth client’s redirect URI and set it as `*_OAUTH_REDIRECT_URI` for sign-ins the server finishes itself. `defaults` is `{ label, enabled, syncDays }`.',
    },
  ),
  personal('manage', 'any')(
    'settings.mailAccounts.connect',
    'POST',
    '/settings/mail/accounts/connect',
    '/api/mail/connect',
    'Start connecting a mailbox: where to sign in',
    {
      body: ['provider', 'accountId', 'access', 'label', 'enabled', 'syncDays'],
      required: ['provider'],
      fields: {
        provider: ['gmail|outlook', 'Where the mailbox is'],
        access: [
          'read|manage',
          'Defaults to read for a new mailbox and preserves existing access when accountId is supplied; manage requests Gmail gmail.modify or Outlook Mail.ReadWrite and Mail.Send',
        ],
        accountId: [
          'integer',
          'A connected `MailAccount` to sign in to again (one in `reauth`, say); a new mailbox when absent',
        ],
        label: ['string', 'A name to show'],
        enabled: ['boolean', 'Whether the periodic sync includes it; true when absent'],
        syncDays: ['integer', 'How many days back to keep, 1–365; 30 when absent'],
      },
      returns: {
        url: 'string',
        state: 'string',
        redirectUri: 'string',
        finishesOnServer: 'boolean',
        expiresAt: 'integer',
      },
      notes:
        'Open `url` in a browser and sign in; the provider then sends the browser to `redirectUri` with `code` and `state` in its query. With `finishesOnServer` (the redirect is this server’s `callbackUrl`) the server finishes the sign-in as the browser arrives, and the client only waits for the account to appear in the list. Otherwise the client receives the redirect itself (a loopback listener of its own on a Google Desktop client’s `http://127.0.0.1:<port>`, or a web view it embeds on Microsoft’s nativeclient page) and sends the address to `…/connect/finish` at once: a Microsoft code typically lasts about a minute, and the start itself expires at `expiresAt` (15 minutes). Google’s sign-in must open in a browser, not an embedded web view. New sign-ins default to read-only; reconnects with `accountId` preserve existing access unless `access` is supplied. `access: manage` requests sending and filing permissions. 503 when this server has no OAuth client for `provider`; 400 until `CREDENTIALS_KEY` is set, since the tokens are stored encrypted with it.',
    },
  ),
  personal('manage', 'any')(
    'settings.mailAccounts.finish',
    'POST',
    '/settings/mail/accounts/connect/finish',
    '/api/mail/connect/finish',
    'Finish connecting a mailbox with the address its sign-in ended on',
    {
      body: ['url', 'state', 'code'],
      fields: {
        url: ['string', 'The whole address the sign-in ended on'],
        state: ['string', 'Instead of `url`: its `state`'],
        code: ['string', 'Instead of `url`: its `code`'],
      },
      returns: { account: 'MailAccount' },
      status: 201,
      notes:
        'For a client that received the redirect itself; a sign-in that ends on the server’s `callbackUrl` is finished there. Each start finishes once, whether or not it succeeds. Signing in to a mailbox that is already connected connects it again (new tokens, the same messages); a start with `accountId` answers 409 when the sign-in was to another mailbox. The first sync starts at once: follow `syncing` and `lastSyncAt`. A Gmail mailbox’s first pass takes the newest 2,000 messages of its window and is paced to Gmail’s per-user quota, so it takes about eight minutes at most; an Outlook folder’s first pass takes at most 5,000 messages, Graph’s limit for a filtered delta.',
    },
  ),
  personal('manage', 'any')(
    'settings.mailAccounts.update',
    'PUT',
    '/settings/mail/accounts/:id',
    '/api/mail/accounts/:id',
    'Change a mailbox’s label, switch or window',
    {
      body: ['label', 'enabled', 'syncDays'],
      fields: { syncDays: ['integer', 'How many days back to keep, 1–365'] },
      returns: { account: 'MailAccount' },
      notes: 'A new `syncDays` starts its sync over with a first pass.',
    },
  ),
  personal('manage', 'any')(
    'settings.mailAccounts.delete',
    'DELETE',
    '/settings/mail/accounts/:id',
    '/api/mail/accounts/:id',
    'Remove a mailbox, its tokens and every message synced from it',
    {
      returns: OK,
      notes:
        'The provider lists the app as having access until it is removed there too: myaccount.google.com/permissions, or myapps.microsoft.com.',
    },
  ),
  personal('manage', 'any')(
    'settings.mailAccounts.sync',
    'POST',
    '/settings/mail/accounts/:id/sync',
    '/api/mail/accounts/:id/sync',
    'Sync a mailbox now',
    {
      returns: { account: 'MailAccount' },
      status: 202,
      notes:
        'Answers as the pass starts, with `syncing` true; read the account again for `lastSyncAt` or `lastSyncError`. A pass already running is not started twice. 409 for an account in `reauth`.',
    },
  ),
  ...crud(
    'settings.envoyerAccounts',
    '/settings/envoyer/accounts',
    '/api/envoyer/accounts',
    'EnvoyerAccount',
    'account',
    'accounts',
  ),
];

// /api handlers deliberately outside this API, with why. The parity test fails a
// handler in neither list.
export const NOT_IN_API = {
  'POST /api/v1/telemetry/ssh/:id/samples':
    'Machine ingress authenticated by a per-server monitor token, never an operator/session token; see docs/ssh-resource-monitoring.md',
};

// Endpoints removed rather than moved behind a route, and where to find them now.
export const RETIRED = {
  'GET /api/mobile-devices': 'Not in the API: `npm run create-token -- --list` on the server',
  'POST /api/mobile-devices': 'Not in the API: `npm run create-token` on the server',
  'DELETE /api/mobile-devices/:id': 'Not in the API: `npm run create-token -- --revoke <id>` on the server',
};
