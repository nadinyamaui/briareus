// @ts-check
// The client API's contract, as data: every /api/v1 route, what it takes and
// what it answers. Three things are built from this file and nothing else, so
// they cannot disagree: the gateway that serves the routes (lib/api-v1.js),
// the OpenAPI document and the reference in docs/ (lib/api-v1-docs.js).
//
// Its own module, with no imports, because all three need it.

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
  review: ['boolean', 'Start a code review of `branch`'],
  qa: ['boolean', 'Start a QA run on `branch`: a test sheet, then its execution'],
  local: ['boolean', 'Work in the project’s local checkout instead of a workspace clone'],
  orchestrator: ['boolean', 'Start a supervisor that runs worker sessions instead of editing code'],
  zeus: ['boolean', 'Start a supervisor that turns the prompt into a GitHub epic through analysts'],
  workerRuntime: ['object', '`{ providerId, model, effort }` an orchestrator’s workers default to'],
  zeusRoles: ['object', 'The runtime each analyst role runs on, keyed by role'],
  attachments: ['string[]', 'Upload ids from `POST /uploads`'],
  reviewLoop: ['boolean', 'Review every push the session settles with and send the findings back'],
  qaLoop: ['boolean', 'Run QA after the review loop passes'],
  activity: ['string', 'What to file the spend under; `issue` is the only value taken'],
  action: ['string', 'An errand id from `GET /actions`'],
  input: ['string', 'The answer to what the errand asks, when it asks something'],
  // ---- sessions ----
  text: ['string', 'The text'],
  title: ['string', 'The new title'],
  autoCompact: ['boolean', 'Whether the session compacts itself when its context fills'],
  compactInstructions: ['string', 'What every compaction of this session must keep; empty clears it'],
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

// The objects the routes hand back. Each lists the fields a client can rely
// on; the server may send more, and a client ignores what it does not know.
export const OBJECTS = {
  Client: {
    about: 'A token’s own record. The token itself is shown once, when it is created.',
    fields: {
      id: str('Its id'),
      label: str('The name it was given'),
      permission: ['read|manage|admin', 'What it may do'],
      repos: ['string[]', 'The projects it is held to; empty for an admin token, which is held to none'],
      createdAt: id('When it was issued, epoch milliseconds'),
      expiresAt: id('When it stops working, epoch milliseconds'),
    },
  },
  ProjectSummary: {
    about: 'A project as a session picker needs it.',
    fields: {
      repo: str('`owner/name`'),
      label: str('Its display name'),
      hasLocal: ['boolean', 'Whether it has a local checkout a session can work in'],
      reviewProviderId: ['integer?', 'The provider its reviews and errands run on'],
      reviewModel: str('That runtime’s model, or empty'),
      reviewEffort: str('That runtime’s effort, or empty'),
      runProfiles: ['string[]', 'The names ▶ Run offers, the default first'],
    },
  },
  Session: {
    about:
      'A conversation with an agent. The record is pushed whole on every change, so replace your copy rather than merging.',
    fields: {
      id: str('Its id'),
      title: str('Its title'),
      repo: str('The project it belongs to'),
      status: [
        'queued|preparing|running|idle|closed|failed|interrupted',
        '`idle` is waiting for a message; `closed` has released its workspace and can be reopened',
      ],
      error: ['string?', 'Why it failed'],
      activity: str(
        'What its spend is filed under: `chat`, `code-review`, `qa`, `orchestrator`, an errand id, …',
      ),
      provider: str('The provider’s label'),
      providerId: id('The provider’s id'),
      model: str('The model it runs on'),
      effort: str('The effort it runs at'),
      branch: ['string?', 'The branch its workspace is on'],
      baseBranch: ['string?', 'The branch that one was cut from'],
      startBranch: ['string?', 'The existing branch it was started on, if any'],
      local: ['boolean', 'Whether it works in the project’s local checkout'],
      createdAt: str('ISO time it was created'),
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
      queued: ['object[]', 'Messages waiting for the turn to end, each `{ text }`; absent when none'],
      liveInput: ['boolean', 'Whether a message sent now goes into the running turn rather than the queue'],
      lastText: ['string?', 'The opening of the agent’s latest message'],
      lastTool: ['string?', 'The tool the running turn is on'],
      subagents: ['object[]', 'The sub-agents working right now, each `{ id, name, summary, startedAt }`'],
      prStatus: ['object?', 'Its pull request, once it has one: number, URL, state, checks and reviews'],
      serveLinks: ['object[]?', 'Where ▶ Run is serving its checkout, each `{ url }`; null when not running'],
      browser: [
        'object?',
        'The shared browser, `{ running }`, when it is switched on; null when off. Switched on and not running, the next turn starts it',
      ],
      reviewLoop: ['object?', 'The review loop’s state when armed'],
      qaLoop: ['object?', 'The QA loop’s state when armed'],
      reviewTriage: ['object?', 'Review findings held for the user’s verdicts'],
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
        '`user` a message sent in; `text` the agent speaking; `ask` a question to answer; `tool` and `tool_error` a tool call; `result` the end of a turn; `status` a status change; `info`, `cmd`, `git`, `setup`, `stderr` and `claude` are log lines',
      ],
      text: str('The line’s text, on most kinds'),
      status: str('On `status`: the session’s new status'),
      attachments: ['object[]', 'On `user`: the files sent, each `{ name }`'],
      via: str('On `user`: `webhook` or `instruction` when it was not typed'),
      name: str('On `tool`: the tool’s name'),
      links: ['object[]', 'On `info`: links ▶ Run published'],
      hidden: ['boolean', 'On `info`: this line stands in for lines a Clear or compaction hid'],
      isError: ['boolean', 'On `result`: the turn failed'],
      costUsd: ['number?', 'On `result`: what the turn cost'],
      durationMs: ['integer', 'On `result`: how long the turn ran'],
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
  Finding: {
    about: 'Something a Briareus review declared on a pull request.',
    fields: {
      key: str('Its stable key'),
      severity: ['critical|high|medium|low', 'How bad'],
      title: str('What it is'),
      file: ['string?', 'Where'],
      line: ['integer?', 'Which line'],
      url: ['string?', 'That line on GitHub'],
      decision: ['fix|optional|dismissed?', 'The verdict recorded for it'],
      fixed: ['boolean', 'Whether a later review ticked it as fixed'],
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
      sortOrder: id('Its place in the list'),
      setupCommands: ['string[]', 'Run to prepare a checkout'],
      phpBinDir: str(''),
      localDir: str('Its local checkout, if any'),
      autoUpdate: ['boolean', 'Whether a merged pull request updates the local checkout'],
      updateCommands: ['string[]', 'Run in the local checkout after it updates'],
      dbPoolEnabled: ['boolean', 'Whether its sessions claim a database server'],
      dbPoolDatabase: str(''),
      dbRestoreSql: str(''),
      dbExtensions: ['string[]', ''],
      envTemplate: str('The `.env` written into a checkout'),
      runCommands: ['string[]', 'What ▶ Run runs'],
      runProfiles: str(''),
      reviewPublishInstructions: str(''),
      reviewTestSheet: ['boolean', ''],
      reviewTestRun: ['boolean', ''],
      qaNotes: str(''),
      feedbackInstructions: str(''),
      testSheetInstructions: str(''),
      reviewAuthor: str(''),
      reviewProviderId: ['integer?', 'The provider reviews and errands run on'],
      reviewModel: str(''),
      reviewEffort: str(''),
      workerProviderId: ['integer?', ''],
      workerModel: str(''),
      workerEffort: str(''),
      isSelf: ['boolean', 'Whether this project is Briareus itself'],
      stepRuntimes: ['object', 'A runtime per errand step'],
      promptTemplates: ['object', 'Per-project prompt overrides'],
      createdAt: str('ISO time; set by the server'),
      updatedAt: str('ISO time; set by the server'),
    },
  },
  Provider: {
    about: 'A provider row: one login or endpoint of one CLI. A body may carry any of the first nine fields.',
    fields: {
      id: id('Its id; set by the server'),
      label: str('Its display name'),
      binary: ['claude|codex|grok|opencode', 'Which CLI runs it'],
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
      permissionMode: ['ask|allow', '`ask` waits for approval of every command; `allow` runs them'],
      enabled: ['boolean', 'Whether agents may use it'],
      dbHost: str('Where its database listens, as seen from the server itself; `127.0.0.1` by default'),
      dbPort: id('Its database’s port; 3306 by default'),
      dbUsername: str(
        'The database user. Write-only: stored encrypted and read back through `GET …/db-credentials`. Empty clears the login',
      ),
      dbPassword: str('That user’s password. Write-only, stored encrypted; left out, the stored one stays'),
      hasDbCredentials: ['boolean', 'Whether a database login is stored; set by the server'],
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
      maxTurns: id('Turns deliveries may start in a row with no word from the operator'),
      sshUnattended: [
        'boolean',
        'Whether an SSH server in `allow` mode runs commands unapproved in a turn a delivery started',
      ],
      instructions: ['boolean', 'Whether the second, instructions webhook is on'],
      url: str('Where a sender posts; not in a body'),
      key: ['string?', 'The key a sender signs with; null while unarmed; not in a body'],
      instructionsUrl: str('Where instructions are posted; not in a body'),
      instructionsKey: ['string?', 'The instructions webhook’s key; not in a body'],
      held: id('Deliveries waiting; not in a body'),
      paused: ['object?', 'Why deliveries are paused; not in a body'],
    },
  },
};

// One route. `path` is what a client calls (under /api/v1); `to` is the path
// of the dashboard handler that answers it, or null for the few the gateway
// answers itself. `access` is the least permission that may call it. `scope`
// says how a token limited to some projects is held to them:
//   repo     the request names a project (`repo`, in the query of a GET or
//            DELETE and in the body otherwise), which must be one of its own
//   session  the :id is a session of one of its projects
//   any      nothing to check: the route is not about one project, or the
//            handler filters its list to the token's projects itself
// An admin token is the operator's own and is not held to a project list.
//
// The rest describes the request and the answer. `query` and `body` name the
// fields a client may send and `required` which it must (the handlers
// validate, not the gateway); `fields` gives a field a meaning of its own on
// this route; `bodyObject` says the body is one of OBJECTS; `returns` is the
// answer, a type or `{ key: type }`. For the gateway: `params` copies a path
// parameter into the query or body under the name the handler reads, `set`
// adds fixed query values, `raw` takes the body as bytes, `stream` marks a
// server-sent event stream, and `runtime` fills in the project's configured
// provider when a start names none.
/** @returns {Record<string, any>} */
function route(id, method, path, to, access, scope, summary, extra = {}) {
  return { id, method, path, to, access, scope, summary, ...extra };
}

const RUNTIME = ['provider', 'model', 'effort'];
const SESSION = { session: 'Session' };
const OK = { ok: 'boolean' };
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
const FORGE_CURSOR = ['string', 'The `nextCursor` of the page before; the first page when absent'];
const FORGE_NOTES =
  '100 to a page. 404 when the account is not there, 502 when Forge refuses its token, 429 when Forge is rate limiting it (60 calls a minute).';
const FORGE_SCRIPT = { content: 'string', autoSource: 'boolean' };
const ENVOYER_AT = '/envoyer/accounts/:id/projects';
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
    'The token’s own record, the API version and what this server can do',
    {
      returns: { version: 'integer', client: 'Client', transcribe: 'boolean' },
    },
  ),
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
        'Totals (`turns`, `sessions`, `inputTokens`, `outputTokens`, `totalTokens`, `durationMs`, `costUsd`), `daily` buckets, and breakdowns by `providers`, `models` and `activities`.',
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
        'An errand is `{ id, label, icon, hint, input }`; `input` is null or `{ label, required }` when it asks the user something.',
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
        'A pull request row carries `number`, `title`, `url`, `draft`, `author`, `assignees`, `reviewers`, `issues`, `branch`, `baseBranch`, `updatedAt`, `labels`, `mergeable`, `checks`, `reviewDecision`, `recommended` and `stack`. An issue row carries `number`, `title`, `url`, `author`, `assignees`, `labels`, `comments`, `milestone`, `createdAt`, `updatedAt` and the `pulls` that close it.',
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
    'pulls.findings',
    'GET',
    '/pulls/:number/findings',
    '/api/pr/findings',
    'read',
    'repo',
    'Read the findings Briareus’s reviews declared on a pull request, with their verdicts',
    {
      params: { number: 'pr' },
      query: ['repo'],
      required: ['repo'],
      returns: { findings: 'Finding[]', fixesUrl: 'string?' },
    },
  ),
  route(
    'pulls.decideFinding',
    'POST',
    '/pulls/:number/findings/decision',
    '/api/pr/findings/decision',
    'manage',
    'repo',
    'Record a verdict on a finding; `fix` updates the Required fixes comment on GitHub',
    {
      params: { number: 'pr' },
      body: ['repo', 'key', 'decision'],
      required: ['repo', 'key'],
      returns: { findings: 'Finding[]', fixesUrl: 'string?' },
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

  // ---- sessions ----
  route(
    'sessions.list',
    'GET',
    '/sessions',
    '/api/dev/sessions',
    'read',
    'any',
    'List the sessions of this token’s projects, newest first',
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
        'review',
        'qa',
        'reviewLoop',
        'qaLoop',
        'local',
        'orchestrator',
        'zeus',
        'workerRuntime',
        'zeusRoles',
        'activity',
      ],
      required: ['repo'],
      runtime: true,
      returns: SESSION,
      status: 201,
      notes: 'A plain session needs `prompt` or `attachments`; a `review` or `qa` needs `branch`.',
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
    'Edit a session’s title or compaction settings; one field per request',
    {
      body: ['title', 'autoCompact', 'compactInstructions'],
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
  route(
    'sessions.message',
    'POST',
    '/sessions/:id/messages',
    '/api/dev/sessions/:id/message',
    'manage',
    'session',
    'Send a message; it starts a turn, joins the running one or waits in the queue',
    {
      body: ['text', 'attachments', 'zeusRoles'],
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
  sessionAction('compact', 'compact', 'Compact the session’s context now'),
  sessionAction('clear', 'clear', 'Hide the transcript so far; the stored log keeps it', {
    returns: { session: 'Session', hidden: 'integer' },
  }),
  sessionAction('review-loop', 'loop', 'Arm or disarm automatic review rounds', {
    body: ['on'],
    required: ['on'],
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
  sessionAction(
    'findings/triage',
    'triage',
    'Complete findings triage; `fix` verdicts may start paid agents and post to GitHub',
    {
      body: ['verdicts', 'note'],
      returns: 'object',
    },
  ),
  sessionAction(
    'findings/save',
    'triage/save',
    'Save the verdicts so far and post them on the pull request; rules nothing',
    {
      body: ['verdicts', 'note'],
      required: ['verdicts'],
      returns: { drafts: 'object', url: 'string?', warning: 'string?' },
    },
  ),
  sessionAction('findings/reply', 'findings/reply', 'Reply on a finding’s thread on GitHub', {
    body: ['key', 'text'],
    required: ['key', 'text'],
    returns: { replied: 'object', url: 'string?' },
  }),
  sessionAction('findings/delete', 'findings/delete', 'Delete a finding and its comment on GitHub', {
    body: ['key'],
    required: ['key'],
    returns: { deleted: 'object', remaining: 'integer' },
  }),
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
  // The secret opens every preview hostname, the same reach a manage token
  // already has through ▶ Run, so manage and no project scope: the token is
  // one for the whole install, not for a project.
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
      body: ['armed', 'perHour', 'maxTurns', 'sshUnattended', 'instructions'],
      fields: Object.fromEntries(
        ['armed', 'perHour', 'maxTurns', 'sshUnattended', 'instructions'].map((name) => [
          name,
          OBJECTS.Webhook.fields[name],
        ]),
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
  admin(
    'tasks.get',
    'GET',
    '/tasks/:id',
    '/api/operations/tasks/:id',
    'Read a task’s history: every session filed under it and what they cost together',
    {
      returns: { root: 'object', sessions: 'object[]', usage: 'object', prUrl: 'string?' },
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
      query: ['period', 'from', 'to', 'project', 'model', 'provider', 'activity', 'account', 'session'],
      fields: {
        model: ['string', 'Only this model. Repeatable'],
        provider: ['string', 'Only this provider. Repeatable'],
        activity: ['string', 'Only this kind of work. Repeatable'],
      },
      returns: 'object',
      notes:
        'Totals, `buckets` over time, breakdowns by `projects`, `providers`, `models` and `activities`, `topSessions`, a `comparison` with the window before, and the `options` each filter accepts.',
    },
  ),
  admin(
    'attention.list',
    'GET',
    '/attention',
    '/api/operations/attention',
    'List what is waiting on the operator: questions, findings to rule on, failures, SSH approvals',
    {
      returns: { items: 'object[]' },
      notes: 'An item is `{ id, sessionId, taskId, revision, repo, title, kind, summary, href, at }`.',
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
  admin(
    'ssh.requests',
    'GET',
    '/ssh/requests',
    '/api/ssh/requests',
    'List the SSH commands agents are waiting for approval to run',
    {
      returns: { requests: 'object[]' },
    },
  ),
  admin(
    'ssh.decide',
    'POST',
    '/ssh/requests/:id/decision',
    '/api/ssh/requests/:id/decision',
    'Approve or deny an SSH command',
    {
      body: ['decision'],
      required: ['decision'],
      fields: { decision: ['approve|deny', 'The ruling'] },
      returns: { request: 'object' },
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
    'settings.envoyerAccounts',
    '/settings/envoyer/accounts',
    '/api/envoyer/accounts',
    'EnvoyerAccount',
    'account',
    'accounts',
  ),
];

// The routes the server still answers under /api that are not this API's, and
// why. The parity test reads this: a handler that is in neither
// list fails it. Empty since the cookie login went: every handler a client
// can reach has a route.
export const NOT_IN_API = {};

// What the removed built-in pages called that went away with their door rather
// than moving behind a route: where a port of a page finds the same thing now.
export const RETIRED = {
  'GET /api/mobile-devices': 'Not in the API: `npm run create-token -- --list` on the server',
  'POST /api/mobile-devices': 'Not in the API: `npm run create-token` on the server',
  'DELETE /api/mobile-devices/:id': 'Not in the API: `npm run create-token -- --revoke <id>` on the server',
};
