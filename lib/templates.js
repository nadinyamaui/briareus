// @ts-check
// The editable text this app sends out: the pull request body it rewrites, and
// the prompts of every errand it runs against a pull request.
//
// All of it used to be string literals in lib/actions.js and lib/prtasks.js,
// which meant a team's own PR template, its deploy links and the wording of its
// QA instructions could only be changed by editing this repository. They are
// settings now, on two levels:
//
//   built-in (below)  →  global (Prompts, in /settings)  →  per project
//
// The first non-empty one wins, so an install that configures nothing behaves
// exactly as it did, a global edit applies to every repository, and a project
// that needs its own wording overrides only the templates it cares about.
//
// A template is plain text with `{{TOKEN}}` placeholders. Unknown tokens are
// left alone rather than blanked: a typo shows up in the prompt instead of
// silently disappearing, and text that legitimately contains braces (the
// deploy links' own `@{{PULL_BRANCH}}`, which belongs to the deploy system and
// not to us) survives untouched.
//
// The composing itself stays in code: lib/prtasks.js works out what each token
// is worth for one pull request and renders. What a template may say is
// therefore free; which facts it can name is the list in TEMPLATES.

import { loadAppSetting, saveAppSetting } from './db.js';

const SETTINGS_KEY = 'templates';

// ---------------------------------------------------------------------------
// the built-in text
// ---------------------------------------------------------------------------

// Deliberately generic: a template describing the shape of a good PR body,
// with none of one company's staging links or class names in it. An install
// that wants its own wording puts it in the global templates at /settings.
const PR_BODY = [
  '# Technical Issue',
  '',
  '<!-- Describe here the technical issue in the code that was causing the issue. MAX ONE SENTENCE -->',
  '',
  '## What does this PR change?',
  '',
  '<!-- Describe the approach you followed to solve the problem MAX ONE SENTENCE -->',
  '',
  '## How to QA this PR?',
  '',
  'Steps on how to test the PR in bullet points, consolidated max one sentence per bullet point and max 10 bullet points be concise',
  '',
  '## Risk Assessment',
  '',
  'Be concise and straight to the point, one sentence max',
  '',
  '<!--',
  'REQUIRED on every PR - do not delete this section.',
  '',
  'State the blast radius of this change: what breaks if it is wrong, who is affected, and how it was verified.',
  '',
  'A change carries elevated risk when it does any of the following:',
  '- adds or changes a DB migration / schema',
  '- touches auth, payments, or security',
  '- changes a consumer contract (API response, serializer, or a shape mobile/API clients depend on)',
  '- changes global / multi-tenant config or a hot path many customers hit',
  '- performs a destructive or irreversible data operation',
  '',
  'Fill in the four lines below. If none of the criteria above apply, you may use the fast path:',
  '`Risk tier: low - not warranted` plus a one-line reason (e.g. cosmetic / internal-only change).',
  '-->',
  '',
  '- **Risk tier:** low / medium / high',
  '- **What breaks if this is wrong:**',
  '- **Who is affected:**',
  '- **Verification performed / required:**',
].join('\n');

const TEST_SHEET = [
  'Create or update the manual test sheet for {{PR_REF}} in {{REPO}}.',
  '',
  // The 📋 action runs in the project's local checkout without switching its
  // branch, so the tree this session stands in is usually on someone else's
  // work. A bare `gh pr diff` there resolves the pull request from the checked
  // out branch and quietly writes the sheet of a different PR, hence the
  // number and the repository on every single gh call.
  'Every gh call must name the pull request and the repository: `--repo {{REPO}}` plus the number, or the full `repos/{{REPO}}/...` path. The checkout you are standing in may be on an unrelated branch, so never let gh infer the pull request from the current branch, and never work from `git diff`, `git log` or the working tree.',
  '',
  // QA sessions are the app's most repetitive readers: every run rediscovers
  // where the app logs in and which seeded account has which role. The
  // briefing already carries this project's memories, so this only points the
  // session at them and asks it to write back what it had to dig up.
  'Before digging through the repository for how the app is used, read the project memory (`memory_list`, then `memory_read` on anything that sounds like a login, a seeded account or a QA obstacle): a previous QA session on {{REPO}} may already have written down what you are about to work out.',
  '',
  '1. Read the pull request: its description (`gh pr view {{PR_NUMBER}} --repo {{REPO}}`), its diff (`gh pr diff {{PR_NUMBER}} --repo {{REPO}}`) and any linked issue. If `{{PR_NUMBER}}` is not a number, find it first with `gh pr list --repo {{REPO}} --head {{BRANCH}} --state open` and use that number everywhere below. Confirm the pull request you read is the one on branch `{{BRANCH}}`; if it is not, or you cannot find it, say so and stop.',
  '2. Derive the manual test scenarios a QA person would run to verify this change: the changed behavior itself, the edge cases the diff introduces, and the closest existing behavior it could plausibly regress. Derive them only from what the diff actually touches, with no generic smoke tests. 4 to 10 scenarios; fewer real ones beat a padded list.',
  "3. Each scenario must be executable by someone who has never seen this code: the role or user to log in as, the exact page or URL to open, the concrete data to enter, and the expected result. Look up seeded credentials and app-specific details in the repository (docs, seeders, .env.example) when you need them. A scenario that cannot be exercised through the app's UI (queue workers, scheduled jobs, API-only behavior) gets status 🖐 instead of ⬜.",
  '4. Post the sheet as ONE comment on that pull request (`gh pr comment {{PR_NUMBER}} --repo {{REPO}} --body-file <file>`), shaped exactly like this:',
  '',
  '{{TEST_SHEET_ANCHOR}}',
  '## Test sheet',
  '',
  '| # | Scenario | Steps | Expected | Status | Evidence |',
  '|---|----------|-------|----------|--------|----------|',
  '| 1 | Short scenario name | Numbered steps, separated by `<br>` | The expected result | ⬜ | |',
  '',
  'Status legend (include it under the table): ⬜ not run · ✅ passed · ❌ failed · 🖐 manual only.',
  '',
  '5. If the pull request already carries a comment containing `{{TEST_SHEET_ANCHOR}}` (`gh api --paginate repos/{{REPO}}/issues/{{PR_NUMBER}}/comments`), update that comment in place (gh api repos/{{REPO}}/issues/comments/<id> -X PATCH -F body=@<file>) instead of posting a second one. Keep the Status and Evidence of rows whose scenario still matches the current diff; reset rows whose behavior changed; add rows for new behavior; drop rows the diff no longer touches.',
  '6. Always write the comment body to a file and pass it with `--body-file <file>` when commenting or `-F body=@<file>` through the api. Never inline a multi-line body in the command, and never pass `@<file>` to `--body`.',
  '7. Save to the project memory whatever you had to work out that is true of {{REPO}} rather than of this diff: the login URL and flow, the seeded accounts and the role each one has, where the app-specific details live, which behavior is not reachable through the UI at all. One memory per fact, type `project`, named for the fact (`login-and-seeded-accounts`, not `pr-12-notes`); if a memory already covers it, replace it instead of adding a near-duplicate. Save nothing about this pull request itself: the scenarios belong on the sheet.',
  '8. Say in your final message which pull request number you wrote the sheet to.',
  '{{QA_NOTES}}',
  '{{TEST_SHEET_INSTRUCTIONS}}',
].join('\n');

const IMPLEMENT_FEEDBACK = [
  'Implement the review feedback on {{PR_REF}} in {{REPO}}. The branch is checked out in this workspace and the dependencies are installed, so you can edit, run and test it here.',
  '{{DECLARED_FINDINGS}}',
  '',
  '1. Read every piece of feedback the pull request carries before changing anything: its reviews and their verdicts (`gh api repos/{{REPO}}/pulls/{{PR_NUMBER}}/reviews`), every inline comment with the code it is anchored to (`gh api repos/{{REPO}}/pulls/{{PR_NUMBER}}/comments`), and the issue comments (`gh pr view {{PR_NUMBER}} --comments`). If the pull request carries a comment containing `{{FIXES_ANCHOR}}`, its unticked items are the must-fix list.',
  '2. Work out which comments are still open. A comment a later commit already addressed, one the author answered and the reviewer accepted, and one that was withdrawn are all done, so do not redo them. Say which you judged done and why.',
  '3. Implement the smallest correct change for each open comment. Change nothing nobody asked for: no drive-by refactors, no formatting sweeps, no dependency bumps.',
  "4. A comment you judge to be wrong, already handled, or out of this pull request's scope gets no code change: record it as not implemented with one sentence of why, and move on. Never weaken a test or delete an assertion to make feedback go away.",
  '5. Run whatever the repository uses to verify the files you touched (its test suite, or the relevant subset, plus linters/static analysis). If your change breaks something, fix that too before going on.',
  '6. Commit on `{{BRANCH}}`, the branch this workspace has checked out, and push with `git push origin HEAD:{{BRANCH}}`. Write a real message describing what changed, and end it with the line `{{FIX_MARKER}}` so the dashboard knows this push came from a fix turn. Never force-push, never rebase, never amend a commit that is already on the remote, and never touch any other branch.',
  '7. Tick the items you actually fixed on the `{{FIXES_ANCHOR}}` comment if the pull request has one (`gh api repos/{{REPO}}/issues/comments/<id> -X PATCH`), changing nothing else about it. Never untick an item and never add or remove items.',
  '8. Reply on each review thread you addressed saying what you did (`gh api repos/{{REPO}}/pulls/comments/<comment-id>/replies -f body=…`).',
  "9. Mark every thread you implemented as resolved, right after your reply. REST cannot resolve a thread, so read the thread ids from GraphQL. `gh api graphql -f query='query($owner:String!,$name:String!,$pr:Int!){repository(owner:$owner,name:$name){pullRequest(number:$pr){reviewThreads(first:100){nodes{id isResolved comments(first:1){nodes{databaseId}}}}}}}' -f owner=<owner> -f name=<name> -F pr={{PR_NUMBER}}` matches a thread to the comment id you replied to, and each one is resolved with `gh api graphql -f query='mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{isResolved}}}' -f id=<thread-id>`. Leave a thread you did not implement open: the reason belongs in your reply and the reviewer decides when it is done. Never resolve a thread someone else raised and you did not act on, and never unresolve one.",
  '10. Post ONE summary comment on the pull request: a line per piece of feedback saying implemented (with the commit sha) or not implemented (with the reason), and what you ran to verify. Write that body to a file and pass it with `--body-file`. Never inline a multi-line body, and never pass `@<file>` as `--body`.',
  '',
  'If the pull request carries no open feedback at all, change nothing, push nothing, and say so in that comment. If you end up changing no code, the same.',
  '{{FEEDBACK_INSTRUCTIONS}}',
].join('\n');

// The one template with no frame at all: what the developer typed is the whole
// prompt. Everything the session needs to know that is not in those words (the
// pull request it is on, the branch to push, the workspace it is standing in)
// it already gets from the errand's own context, and a frame around the words
// only competes with them for the session's attention. The other tokens stay
// available (see TEMPLATES below) for an install that wants its frame back:
// putting one in the settings page is all it takes.
const CUSTOM_FEEDBACK = '{{FEEDBACK}}';

const DELETE_SELF_COMMENTS = [
  'Delete everything the GitHub account `{{AUTHOR}}` has left on {{PR_REF}} in {{REPO}}: its comments and its reviews. This is a cleanup errand: you write no code, push nothing, and post no comment of your own when you are done.',
  '',
  "Only `{{AUTHOR}}`'s own content may be touched. Match every candidate on `user.login` (case-insensitively) before you delete it, and leave every comment, review and reply by anyone else exactly as it is. Never edit the pull request's title, description, labels or state.",
  '',
  '1. Conversation comments: list them with `gh api --paginate repos/{{REPO}}/issues/{{PR_NUMBER}}/comments --jq \'.[] | select(.user.login | ascii_downcase == "{{AUTHOR_LC}}") | .id\'` and delete each one with `gh api repos/{{REPO}}/issues/comments/<id> -X DELETE`.',
  "2. Inline review comments: list them with `gh api --paginate repos/{{REPO}}/pulls/{{PR_NUMBER}}/comments --jq '.[] | select(.user.login | ascii_downcase == \"{{AUTHOR_LC}}\") | .id'` and delete each one with `gh api repos/{{REPO}}/pulls/comments/<id> -X DELETE`. Deleting the first comment of a thread removes the thread; replies by other people on that thread would go with it, so check a thread's other comments (`in_reply_to_id`) first and, if anyone else replied there, delete only the ones `{{AUTHOR}}` wrote.",
  '3. Reviews: list them with `gh api --paginate repos/{{REPO}}/pulls/{{PR_NUMBER}}/reviews --jq \'.[] | select(.user.login | ascii_downcase == "{{AUTHOR_LC}}") | "\\(.id) \\(.state)"\'`. For each one:',
  '   - `PENDING`: delete it outright, `gh api repos/{{REPO}}/pulls/{{PR_NUMBER}}/reviews/<id> -X DELETE`.',
  "   - `CHANGES_REQUESTED` or `APPROVED`: the review record cannot be deleted, so clear its body and dismiss the verdict (`gh api repos/{{REPO}}/pulls/{{PR_NUMBER}}/reviews/<id>/dismissals -X PUT -f message='Removed by the author' -f event=DISMISS`).",
  '   - `COMMENTED`: it cannot be deleted or dismissed either; clear its body the same way and leave the empty record. Its inline comments are already gone from step 2.',
  "   A review body is cleared with `gh api repos/{{REPO}}/pulls/{{PR_NUMBER}}/reviews/<id> -X PUT -f body=''`. If GitHub refuses an empty body, put a single `_(removed)_` in it instead and say so.",
  '4. Re-list all three collections when you are finished and confirm nothing authored by that account is left. If a delete failed (a 403 on a comment the token may not remove, a review that refuses dismissal), say which one and why rather than retrying blindly.',
  '',
  'Report in your final message only: how many conversation comments, inline comments and reviews you removed, which reviews survived as empty records and why, and anything you deliberately left alone. If `{{AUTHOR}}` has left nothing on this pull request, delete nothing and say so.',
].join('\n');

const SOLVE_CONFLICTS = [
  '{{PR_REF}} in {{REPO}} has merge conflicts with `{{BASE_BRANCH}}` and cannot be merged. Resolve them. The branch is checked out in this workspace with its dependencies installed, so you can build and test the result here.',
  '',
  '1. Fetch and merge the base into the branch: `git fetch origin {{BASE_BRANCH}}` then `git merge origin/{{BASE_BRANCH}}`. Never rebase, never force-push, never amend a commit that is already on the remote, and never touch any other branch.',
  "2. For every conflicted file, read both sides before you resolve it. `git log --merge -p <file>` and the pull request's diff say what this branch was trying to do, and the base's history says what it collided with. Keep both intents. Never resolve a conflict by taking one whole side blindly, and never drop someone else's change to make the conflict go away.",
  '3. Conflicts in generated or lock files (composer.lock, package-lock.json, build output, compiled assets) are resolved by regenerating them from the merged sources, not by hand-editing the conflict markers.',
  '4. Search the whole worktree for leftover conflict markers (`<<<<<<<`, `=======`, `>>>>>>>`) before committing: a stray marker in a file git considered resolved is the usual way a merge like this breaks the build.',
  '5. Beyond the conflicted files, check whether the base moved something this branch depends on (a renamed method, a changed signature, a new migration) and fix the branch to match. A clean merge that no longer compiles is not resolved.',
  '6. Run whatever the repository uses to verify what the merge touched: its test suite or the relevant subset, plus linters and static analysis. Fix what the merge broke; do not fix unrelated pre-existing failures, and change nothing the merge did not force you to.',
  '7. Commit the merge and push it with `git push origin HEAD:{{BRANCH}}`. Keep the merge commit as a merge commit; do not squash it.',
  '8. Post ONE comment on the pull request: which files conflicted, how each was resolved in one line, what you ran to verify, and anything you had to change beyond the conflicts themselves. Write the body to a file and pass it with `--body-file`. Never inline a multi-line body, and never pass `@<file>` as `--body`.',
  '',
  'If the branch turns out to merge cleanly after all (GitHub was stale), push nothing and say so in that comment. If a conflict genuinely needs the author to decide which behavior wins, stop, push nothing, and say exactly which decision you need in that comment.',
].join('\n');

const FIX_FAILING_CHECKS = [
  'The CI checks on {{PR_REF}} in {{REPO}} are failing. Fix what makes them fail. The branch is checked out in this workspace with its dependencies installed and its own database, so you can run and test it here.',
  '',
  "1. List the checks and find the failing ones: `gh pr checks {{PR_NUMBER}}`. For each failure, read the log of what actually broke: `gh run view <run-id> --log-failed` for an Actions run, or open the check's details URL for anything else. Work from the real error, never from the job's name.",
  '2. Reproduce each failure in this workspace by running the same command the job runs (read the workflow file under `.github/workflows` to find it). A failure you cannot reproduce locally gets diagnosed from the log instead, so say so rather than guessing at a fix.',
  '3. Decide what each failure actually is before you touch anything, and say which it was:',
  '   - this branch broke it: fix the code.',
  "   - it is already broken on `{{BASE_BRANCH}}`: not this pull request's job. Leave it alone and report it.",
  '   - it is flaky or infrastructure (a timeout, a network blip, a runner problem): re-run that job with `gh run rerun <run-id> --failed` instead of changing code, and say you did.',
  '4. Implement the smallest correct fix for the failures this branch caused. Never make a check pass by weakening it: no deleted assertions, no skipped or commented-out tests, no lowered coverage thresholds, no lint rules switched off, and no `continue-on-error` added to a job. If a test is genuinely asserting the wrong thing, fix the test and explain why in your comment.',
  '5. Re-run the failing commands locally until they pass, plus whatever else covers the files you touched. A fix that turns one job green and another red is not done.',
  '6. Commit on `{{BRANCH}}`, the branch this workspace has checked out, and push with `git push origin HEAD:{{BRANCH}}`. End the commit message with the line `{{FIX_MARKER}}` so the dashboard knows this push came from a fix turn. Never force-push, never rebase, never amend a commit that is already on the remote, and never touch any other branch.',
  "7. Post ONE comment on the pull request: a line per failing check saying what broke it and how you fixed it (with the commit sha), or why it was not this branch's to fix. Write the body to a file and pass it with `--body-file`. Never inline a multi-line body, and never pass `@<file>` as `--body`.",
  '8. Before writing your final message, kill every background process you started. A process left running holds the session open for minutes after the work is done.',
  '',
  'If every check turns out to be green after all (GitHub was stale), change nothing, push nothing, and say so in that comment.',
].join('\n');

const TEST_RUN = [
  'Execute the manual test sheet on {{PR_REF}} in {{REPO}} and record a video of every scenario you run.',
  '',
  "The workspace is prepared: dependencies are installed and the session's own database is restored/migrated, so the app runs against data that is yours alone. Nothing you do here may be committed or pushed.",
  '',
  // Driving the app is where a QA run burns its turn: booting the server,
  // getting through the login, finding the selector that actually works. All
  // of it is true of the project rather than of the pull request, so a run
  // that writes it down saves every run after it.
  'Read the project memory first (`memory_list`, then `memory_read` on anything about serving the app, logging in, or an obstacle a past run hit) and follow what it says instead of working it out again. Nothing there is binding: if a memory turns out to be wrong or stale, correct it once you know better.',
  '',
  '1. Fetch the test sheet: the PR comment containing `{{TEST_SHEET_ANCHOR}}` (gh api repos/{{REPO}}/issues/<pr-number>/comments, noting the comment id, you will edit it in place). If there is none, post a short PR comment saying the test sheet is missing, and stop.',
  '2. {{RUN_COMMANDS}}',
  '3. Set up Playwright in a scratch directory OUTSIDE the workspace (under the OS temp dir): `npm init -y`, `npm i playwright`, `npx playwright install chromium`. The browser download is cached machine-wide, so this is only slow the first time ever; never reinstall what is already there.',
  '4. For every scenario whose Status is ⬜, drive it with a Playwright script against the running app: chromium, one browser context per scenario with `recordVideo: { dir: <scratch>/videos, size: { width: 1280, height: 720 } }` and a 1280×720 viewport. Perform the steps, verify the Expected column, and close the context so the video is flushed to disk. Judge pass/fail on what the page actually shows against Expected: a script that merely ran to the end is not a pass. Leave 🖐 rows alone.',
  "5. Save each scenario's video as `<scenario #>-<kebab-case-name>.webm` under this directory (create it as needed), where `<pr-number>` is the pull request number:",
  '',
  '```',
  '{{VIDEO_DIR}}',
  '```',
  '',
  '   The dashboard publishes that directory, so the file is then reachable at `{{VIDEO_URL}}/<file>.webm`, and that URL is what goes on the PR, never a file path.',
  "6. Update the test sheet comment in place (gh api repos/{{REPO}}/issues/comments/<id> -X PATCH -F body=@<file>): set each executed row's Status to ✅ or ❌ and put a markdown link to its video in Evidence, `[▶ video](<url>)`, plus, on a failure, one short line of what actually happened. Change nothing else about the comment.",
  '7. If any scenario failed, post ONE additional PR comment summarizing the failures (scenario #, expected, what happened, video link). If everything passed, post no extra comment: the sheet says it all.',
  '8. Save to the project memory what the next run on {{REPO}} would otherwise solve again: the command sequence that actually served the app and the URL it came up on, the login flow step by step (page, selectors, the account and where its credentials come from), and every obstacle you hit with the fix that worked — a redirect or interstitial after login, a wait the app needs before it is usable, a Playwright setup detail specific to this app. One memory per fact, type `project`, named for the fact (`playwright-login-flow`, not `qa-run-notes`), and each obstacle memory says what the symptom looked like so a future run recognises it. Replace a memory that already covers the ground instead of adding a near-duplicate, and save nothing about this pull request or its scenarios: those live on the sheet.',
  '9. Before writing your final message, kill every background process you started, the app server especially. A process left running holds the session open for minutes after the work is done.',
  '{{QA_NOTES}}',
].join('\n');

// ---------------------------------------------------------------------------
// the registry
// ---------------------------------------------------------------------------

// Tokens every prompt template may use. They name the pull request the errand
// was started for, so they are worth something in all of them.
const COMMON_VARS = [
  ['REPO', 'owner/name of the repository'],
  ['PR_REF', '"pull request #12", or "the open pull request for branch x" when the number is not known yet'],
  ['PR_NUMBER', 'the pull request number, or <number> when it is not known yet'],
  ['BRANCH', "the pull request's own branch, checked out in this workspace"],
];

const QA_NOTES_VAR = ['QA_NOTES', "the project's QA notes as a block, or nothing when it has none"];
const TEST_SHEET_INSTRUCTIONS_VAR = [
  'TEST_SHEET_INSTRUCTIONS',
  "the project's closing steps for the test sheet errand as a block, or nothing when it has none",
];
const FEEDBACK_INSTRUCTIONS_VAR = [
  'FEEDBACK_INSTRUCTIONS',
  "the project's closing steps for the feedback errand as a block, or nothing when it has none",
];
const FIX_MARKER_VAR = [
  'FIX_MARKER',
  'the line every fix commit ends with, so the dashboard knows the push came from a fix turn',
];
const ANCHOR_VAR = [
  'TEST_SHEET_ANCHOR',
  'the HTML comment that marks the test sheet, so a re-run edits it instead of stacking a second one',
];
const FIXES_ANCHOR_VAR = ['FIXES_ANCHOR', 'the HTML comment that marks the required-fixes checklist'];

// What the operator wants every orchestrator session to know about working on
// their project: standards, priorities, what to delegate and what to escalate.
// Deliberately empty built-in: unlike the errand prompts, there is no generic
// text worth sending — an install that writes nothing appends nothing.
const ORCHESTRATOR = '';

// The shape of the epic a ⚡ Zeus session writes: the four sections its brief,
// its analysts and its validator all work to, and the fields every requirement
// carries so the merge keeps its trail from each line back to the brief or to
// the code. Generic on purpose; a team's own issue template, labels or
// ticket conventions go in the global or project override.
const ZEUS_EPIC = [
  '# Context',
  '',
  'Problem, goal, current behaviour (with the files and components it lives in), scope, exclusions,',
  'assumptions and pending decisions. A pending decision is written as a question with the options',
  'considered, never answered on the user’s behalf.',
  '',
  '# Requirements',
  '',
  'User stories, each exactly "As a <actor>, I want <capability>, so that <outcome>".',
  '',
  'Functional requirements FR-1, FR-2, … and technical requirements TR-1, TR-2, …, each with:',
  '- Description: one concrete, testable behaviour.',
  '- Origin: brief / repository evidence / inferred.',
  '- Evidence: the files, symbols, tables, endpoints or tests that back it, as they exist in {{REPO}}.',
  '- Acceptance criteria: how to check it is met.',
  '- Dependencies: other requirements or pending decisions it waits on.',
  '- State: confirmed / assumption / pending decision.',
  '',
  '# Implementation Plan',
  '',
  'Phases in execution order, each naming the requirements it delivers, its dependencies and its risks.',
  'A phase is the size of one pull request one worker could land.',
  '',
  '# Definition of Done',
  '',
  'Checkable conditions, each tied to the requirement ids it closes.',
].join('\n');

// Order is the order /settings lists them in.
export const TEMPLATES = [
  {
    id: 'prBody',
    label: 'PR body',
    hint: "The team's own pull request description, deploy links and all. Every session is told to write a PR it opens to this template, and ✎ PR Body Summary rewrites an existing description with it. Sent verbatim inside the prompt.",
    text: PR_BODY,
    vars: [],
  },
  {
    id: 'testSheet',
    label: 'Test sheet',
    hint: "Derives the manual QA checklist from the diff and posts it as one editable comment. Both the 📋 action and the QA session's opening turn.",
    text: TEST_SHEET,
    vars: [...COMMON_VARS, ANCHOR_VAR, QA_NOTES_VAR, TEST_SHEET_INSTRUCTIONS_VAR],
  },
  {
    id: 'testRun',
    label: 'Test run',
    hint: 'Executes the sheet with Playwright and records a video per scenario.',
    text: TEST_RUN,
    vars: [
      ...COMMON_VARS,
      ANCHOR_VAR,
      QA_NOTES_VAR,
      [
        'RUN_COMMANDS',
        "the project's run commands as a block, or the instruction to work out how to serve the app",
      ],
      ['VIDEO_DIR', "where this PR's videos go on disk"],
      ['VIDEO_URL', 'where the dashboard serves them from'],
    ],
  },
  {
    id: 'implementFeedback',
    label: 'Implement feedback',
    hint: "⚙ Implement feedback: works from the pull request's own review threads rather than from a findings list.",
    text: IMPLEMENT_FEEDBACK,
    vars: [
      ...COMMON_VARS,
      FIX_MARKER_VAR,
      FIXES_ANCHOR_VAR,
      ['DECLARED_FINDINGS', 'the machine-readable findings as a block, or nothing when the PR carries none'],
      FEEDBACK_INSTRUCTIONS_VAR,
    ],
  },
  {
    id: 'customFeedback',
    label: 'Give feedback',
    hint: '✍ Give feedback: sends what the user typed into the dashboard as the whole prompt, verbatim and unframed. Write text here to put instructions around it.',
    text: CUSTOM_FEEDBACK,
    vars: [...COMMON_VARS, FIX_MARKER_VAR, ['FEEDBACK', 'what the user typed, verbatim']],
  },
  {
    id: 'solveConflicts',
    label: 'Solve conflicts',
    hint: '🔀 Solve conflicts: merges the base branch in, resolves and pushes.',
    text: SOLVE_CONFLICTS,
    vars: [...COMMON_VARS, ['BASE_BRANCH', 'the branch the pull request merges into']],
  },
  {
    id: 'fixFailingChecks',
    label: 'Fix failing checks',
    hint: '🧪 Fix failing checks: reads the red CI run and fixes what this branch broke.',
    text: FIX_FAILING_CHECKS,
    vars: [...COMMON_VARS, FIX_MARKER_VAR, ['BASE_BRANCH', 'the branch the pull request merges into']],
  },
  {
    id: 'orchestrator',
    label: 'Orchestrator instructions',
    hint: 'Appended to every 🧭 orchestrator session’s briefing: your standards for the work its workers deliver, what to verify before calling a task done, and which decisions to escalate. Empty means nothing is appended.',
    text: ORCHESTRATOR,
    vars: [['REPO', 'owner/name of the repository']],
  },
  {
    id: 'zeusEpic',
    label: 'Zeus epic',
    hint: 'The document a ⚡ Zeus session writes from a brief: the epic body its analysts propose, it merges and it publishes as a GitHub issue with sub-issues. Add your own conventions (labels, ticket links, wording) here.',
    text: ZEUS_EPIC,
    vars: [['REPO', 'owner/name of the repository']],
  },
  {
    id: 'deleteSelfComments',
    label: 'Delete own comments',
    hint: '🧹 Delete my comments: removes everything the configured GitHub account left on a pull request.',
    text: DELETE_SELF_COMMENTS,
    vars: [
      ...COMMON_VARS,
      ['AUTHOR', "the project's GitHub login, the account this app posts as"],
      ['AUTHOR_LC', 'the same login, lowercased, for jq comparisons'],
    ],
  },
];

const BY_ID = new Map(TEMPLATES.map((t) => [t.id, t]));

export const TEMPLATE_IDS = TEMPLATES.map((t) => t.id);

// What /settings needs to draw the editors: the label, the hint, the tokens and
// the built-in text a left-empty field falls back on.
export function templateCatalog() {
  return TEMPLATES.map((t) => ({
    id: t.id,
    label: t.label,
    hint: t.hint,
    vars: t.vars.map(([name, note]) => ({ name, hint: note })),
    builtIn: t.text,
  }));
}

// ---------------------------------------------------------------------------
// the global level
// ---------------------------------------------------------------------------

// Read at boot and kept in memory: composing a prompt is synchronous at every
// call site, and this row changes far more rarely than it is read.
let globals = {};

export async function initTemplates() {
  try {
    // No row yet means an install that has overridden nothing: normalize turns
    // that into an empty set of globals and every template falls back to its
    // built-in text.
    globals = normalize(await loadAppSetting(SETTINGS_KEY, null));
  } catch (e) {
    // The built-in text is a complete, working set on its own, so a database
    // that is down costs the overrides and nothing else.
    console.error('Could not load the prompt templates:', e.message);
    globals = {};
  }
  return globals;
}

export function globalTemplates() {
  return globals;
}

export async function saveGlobalTemplates(input) {
  const next = normalize(input);
  await saveAppSetting(SETTINGS_KEY, next);
  globals = next;
  return globals;
}

// Only the templates that exist, only the ones actually overridden. An empty
// field means "fall back", so it is stored as no entry at all rather than as an
// empty string; otherwise clearing a field would send an empty prompt.
export function normalize(input) {
  const out = {};
  if (!input || typeof input !== 'object') return out;
  for (const id of TEMPLATE_IDS) {
    const text = String(input[id] ?? '')
      .replace(/\r\n/g, '\n')
      .trim();
    if (text) out[id] = text;
  }
  return out;
}

// ---------------------------------------------------------------------------
// resolving and rendering
// ---------------------------------------------------------------------------

// project → global → built-in. `project` may be null: an errand on a repository
// with no project row still gets the global text.
export function templateText(id, project = null) {
  const builtIn = BY_ID.get(id);
  if (!builtIn) throw new Error(`No such template: ${id}`);
  const own = project && project.promptTemplates ? project.promptTemplates[id] : '';
  return own || globals[id] || builtIn.text;
}

// Where a template's text comes from, for the dashboard to say so.
export function templateSource(id, project = null) {
  const own = project && project.promptTemplates ? project.promptTemplates[id] : '';
  if (own) return 'project';
  if (globals[id]) return 'global';
  return 'built-in';
}

// `{{TOKEN}}` substitution. Unknown tokens are left alone; see the note at the
// top of this file.
export function fill(text, vars) {
  return String(text ?? '').replace(/\{\{([A-Z0-9_]+)\}\}/g, (whole, key) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key] ?? '') : whole,
  );
}

// A template resolved for one project and filled in. A token that rendered to
// nothing (no QA notes, no declared findings) leaves the blank line it sat
// on behind, so runs of them are collapsed and the ends trimmed; the prompt
// reads the same whether the optional blocks were there or not.
export function renderTemplate(id, vars = {}, project = null) {
  return fill(templateText(id, project), vars)
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
