// @ts-check
// The prompts a session runs against a pull request: the test sheet it posts,
// the test run that executes that sheet with Playwright and records a video per
// scenario, the fix turns that address what a review or a run found, and the
// hand-started errands (feedback, conflicts, failing checks, cleanup).
//
// Each is used in two places (as a turn of the session this app starts on its
// own, and as an ⚡ Action run on a PR by hand) so they live here rather than
// in either caller.
//
// The wording itself is not here: it is a setting, with a built-in default, a
// global override and a per-project one (see lib/templates.js). What is here is
// the composing: working out what each `{{TOKEN}}` is worth for one pull
// request, and rendering the template that project resolved to. The sheet's
// shape is still part of the contract (the run turn parses the comment the
// sheet turn wrote, keyed on the same anchor), which is why the anchor is
// passed in as a token rather than typed into the template.

import crypto from 'crypto';
import { getConfig } from './config.js';
import { renderTemplate } from './templates.js';
import { TEST_SHEET_ANCHOR, FIXES_ANCHOR, FIX_COMMIT_MARKER } from './markers.js';

function prRef(prNumber, branch) {
  return prNumber ? `pull request #${prNumber}` : `the open pull request for branch ${branch}`;
}

// The tokens every prompt template may use, worked out once per errand.
function baseVars({ repo, prNumber, branch }) {
  return {
    REPO: repo,
    PR_REF: prRef(prNumber, branch),
    PR_NUMBER: prNumber || '<number>',
    BRANCH: branch || '',
    TEST_SHEET_ANCHOR,
    FIX_MARKER: FIX_COMMIT_MARKER,
    FIXES_ANCHOR,
  };
}

// The per-project QA notes ride along on the QA prompts: logins, tenants, URLs,
// whatever the settings page holds that a tester needs and the repo does not
// say.
function qaNotesBlock(qaNotes) {
  const text = String(qaNotes || '').trim();
  if (!text) return '';
  return [
    '',
    "Project QA notes (from the dashboard's settings; treat them as ground truth for logins, tenants and URLs):",
    '',
    text,
  ].join('\n');
}

// What the project wants done once an errand's own work is over: moving a
// label, pinging a channel, whatever the team's workflow asks for after the
// feedback is implemented or the test sheet is posted. It goes at the very end
// of the prompt because it is the last thing the errand does, and because a
// project that configures nothing must get exactly the prompt it got before.
function closingStepsBlock(instructions) {
  const text = String(instructions || '').trim();
  if (!text) return '';
  return ['', "Finally, this project's own closing steps for this errand:", '', text].join('\n');
}

// Where one PR's videos land on disk and on the web. The PR number is not
// always known when the prompt is composed (a manual review session learns it
// mid-run), so the paths carry a `<pr-number>` placeholder the agent fills in.
//
// With an R2 bucket configured the web side is the bucket's public hostname,
// and the link itself is the access control: anyone holding it may watch,
// nobody may guess it. So the path gets a fresh 128-bit token per composed
// run: unguessable, and never reused, which keeps an old run's links alive
// when a new run lands on the same pull request.
function videoPaths(repo) {
  const cfg = getConfig();
  const slug = repo.replace('/', '__');
  const suffix = cfg.r2 ? `-${crypto.randomBytes(16).toString('hex')}` : '';
  return {
    dir: `${cfg.testVideosDir}/${slug}/pr-<pr-number>${suffix}`,
    url: cfg.r2
      ? `${cfg.r2.publicBaseUrl}/${slug}/pr-<pr-number>${suffix}`
      : `${cfg.publicBaseUrl}/videos/${slug}/pr-<pr-number>${suffix}`,
  };
}

// The run command block, left with its {port}/{dir} placeholders. The agent
// substitutes them, since only it knows which port is actually free when the
// turn runs.
function runCommandBlock(runCommands, portHint) {
  const commands = (runCommands || []).filter(Boolean);
  if (!commands.length) {
    return 'This project has no run command configured in the dashboard. Work out how to serve the app from the repository itself (README, composer/npm scripts); if you cannot, mark the browser scenarios 🖐 with a note in Evidence, update the sheet, and stop.';
  }
  return [
    "The project's run commands are (run them chained, in the workspace root):",
    '',
    '```',
    commands.join(' && '),
    '```',
    '',
    `Replace \`{port}\` with a free port (try ${portHint} first) and \`{dir}\` with the absolute workspace root. Run the server in the background and verify the app answers over HTTP before going on.`,
  ].join('\n');
}

export function testSheetPrompt({ repo, prNumber, branch, project }) {
  return renderTemplate(
    'testSheet',
    {
      ...baseVars({ repo, prNumber, branch }),
      QA_NOTES: qaNotesBlock(project ? project.qaNotes : ''),
      TEST_SHEET_INSTRUCTIONS: closingStepsBlock(project ? project.testSheetInstructions : ''),
    },
    project,
  );
}

function findingList(findings) {
  return (findings || [])
    .map((f) => {
      const loc = f.file ? ` (\`${f.file}${f.line ? `:${f.line}` : ''}\`)` : '';
      return `- **${String(f.severity || 'medium').toUpperCase()}**: ${f.title}${loc}`;
    })
    .join('\n');
}

// ⚙ Implement feedback, started by hand from the project dashboard: the errand
// that fixes what a review asked for, whenever somebody decides it should be
// fixed.
//
// It does not work from a findings list alone. That list comes from the
// machine-readable block this app's own reviews post, and a pull request
// carrying `feedback-given` from a human reviewer (or from a review published
// before that block existed) has none. So the pull request's review threads
// are the source, and the declared findings (when there are any) ride along as
// the checklist they are.
export function implementFeedbackPrompt({
  repo,
  prNumber,
  branch,
  findings = [],
  triaged = false,
  note = null,
  project,
}) {
  // A triaged round is a decided list, not a starting point: what the
  // orchestrator left out of it was left out on purpose, and its threads on
  // the pull request are not this session's to act on however open they look.
  const declared = findings.length
    ? [
        '',
        triaged
          ? 'The findings to implement, as the orchestrator triaged them. Implement these and only these: every other finding of this round was dismissed or left optional on purpose (the "Review triage" comment on the pull request says why), so leave their threads alone.'
          : 'The findings a review declared machine-readably, as a starting point; the threads on the pull request are still what you work from:',
        '',
        findingList(findings),
        ...(note ? ['', `The orchestrator adds: ${String(note).trim()}`] : []),
      ].join('\n')
    : '';
  return renderTemplate(
    'implementFeedback',
    {
      ...baseVars({ repo, prNumber, branch }),
      DECLARED_FINDINGS: declared,
      FEEDBACK_INSTRUCTIONS: closingStepsBlock(project ? project.feedbackInstructions : ''),
    },
    project,
  );
}

// ✍ Give feedback, started by hand from the project dashboard: the feedback is
// the user's own, typed into the dashboard rather than left on the pull request,
// so there is nothing to go and read: what they wrote IS the errand.
//
// It is quoted verbatim and fenced, never paraphrased into instructions: the
// user's wording is the only statement of what they want, and a prompt that
// rewrote it would hand the session someone else's version of the request.
export function customFeedbackPrompt({ repo, prNumber, branch, feedback, project }) {
  return renderTemplate(
    'customFeedback',
    {
      ...baseVars({ repo, prNumber, branch }),
      FEEDBACK: String(feedback).trim(),
    },
    project,
  );
}

// 🧹 Delete own comments, started by hand from the project dashboard: everything
// the configured GitHub account itself left on a pull request goes away, so a PR
// that collected review passes, test sheets and fix summaries can be handed over
// clean. Nobody else's comments are ever touched.
//
// GitHub only lets a review be deleted while it is still pending, so a submitted
// review's record survives: its inline comments and its body go, and a verdict
// that can be dismissed is dismissed. That asymmetry is spelled out in the
// prompt rather than left for the session to discover mid-errand.
export function deleteSelfCommentsPrompt({ repo, prNumber, branch, author, project }) {
  return renderTemplate(
    'deleteSelfComments',
    {
      ...baseVars({ repo, prNumber, branch }),
      AUTHOR: author,
      AUTHOR_LC: String(author).toLowerCase(),
    },
    project,
  );
}

// The turn that brings a pull request's branch back up to date with its base
// when GitHub says the two conflict. It is a merge, never a rebase: the branch
// is already on the remote and other turns (review, fix, QA) push to it, so
// rewriting its history would strand every one of them.
//
// The merge commit it pushes needs no [reviewer-fix] marker: nothing reacts
// to a push any more, so this push does not trigger a
// review the way a fix push does.
export function solveConflictsPrompt({ repo, prNumber, branch, baseBranch, project }) {
  return renderTemplate(
    'solveConflicts',
    {
      ...baseVars({ repo, prNumber, branch }),
      BASE_BRANCH: baseBranch || 'the base branch',
    },
    project,
  );
}

// The turn that answers a red CI run: the checks GitHub reports as failing on
// the pull request's head are what this fixes, on the pull request's own branch,
// exactly like review findings are.
//
// It carries the same [reviewer-fix] marker as the other fix turns: the push it
// makes is still worth reviewing, but the review session started for it must not
// fix again.
//
// Which checks failed is deliberately not baked into the prompt: the board's
// rollup is a single state, and by the time the session runs the run may have
// been re-run or moved on. The turn reads the live list itself.
export function fixFailingChecksPrompt({ repo, prNumber, branch, baseBranch, project }) {
  return renderTemplate(
    'fixFailingChecks',
    {
      ...baseVars({ repo, prNumber, branch }),
      BASE_BRANCH: baseBranch || 'the base branch',
    },
    project,
  );
}

export function testRunPrompt({ repo, prNumber, branch, portHint = 8100, project }) {
  const videos = videoPaths(repo);
  return renderTemplate(
    'testRun',
    {
      ...baseVars({ repo, prNumber, branch }),
      RUN_COMMANDS: runCommandBlock(project ? project.runCommands : [], portHint),
      VIDEO_DIR: videos.dir,
      VIDEO_URL: videos.url,
      QA_NOTES: qaNotesBlock(project ? project.qaNotes : ''),
    },
    project,
  );
}

// ✎ PR Body Summary: the team's own pull request description template, sent to
// the session verbatim inside the instruction to rewrite the body with it.
// The template is the setting; this sentence around it is the errand.
export function prBodyPrompt({ project }) {
  return [
    'Update the PR body with the following',
    '',
    '```',
    renderTemplate('prBody', {}, project),
    '```',
  ].join('\n');
}
