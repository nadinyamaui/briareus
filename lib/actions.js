// @ts-check
// Actions: one-shot errands a session runs against an existing pull request, picked
// from the ⚡ Actions menu. The session is otherwise ordinary, so the user can follow
// up in the same thread. Prompts are composed in lib/prtasks.js from templates
// (lib/templates.js); this file owns the list of errands and where each runs.

import {
  testSheetPrompt,
  testRunPrompt,
  solveConflictsPrompt,
  implementFeedbackPrompt,
  deleteSelfCommentsPrompt,
  fixFailingChecksPrompt,
  customFeedbackPrompt,
  prBodyPrompt,
} from './prtasks.js';
import { latestReviewFindings, getFindings } from './findings.js';

// Every action, in menu order. `workspace` is 'local' (the project's checkout, for
// gh-only errands) or 'worktree' (a prepared clone with a pooled database, for
// errands that run the app); `checkout: false` keeps a local action off the
// checkout's branch so a dirty tree cannot fail it. `autoClose` frees the session
// once the turn ends unless it stopped to ask something. `reviewLoop` arms the 🔁
// loop and excludes autoClose, since the loop reports back to this session.
// `prompt` may be async to start with live PR data.
export const ACTIONS = [
  {
    id: 'pr-body-summary',
    label: 'PR Body Summary',
    icon: '✎',
    hint: 'Rewrite a pull request’s description from its own diff, following the team template',
    workspace: 'local',
    // The result lives on the pull request, so nothing is left to read here.
    autoClose: true,
    title: ({ prNumber }) => `PR body: #${prNumber}`,
    prompt: ({ project }) => prBodyPrompt({ project }),
  },
  {
    id: 'test-sheet',
    label: 'Test sheet',
    icon: '📋',
    hint: 'Derive a manual QA checklist from the pull request’s diff and post it as one editable comment',
    workspace: 'local',
    checkout: false,
    // The checklist lives as a PR comment, so nothing is left to read here.
    autoClose: true,
    title: ({ prNumber }) => `Test sheet: #${prNumber}`,
    prompt: ({ repo, prNumber, branch, project }) =>
      testSheetPrompt({
        repo,
        prNumber,
        branch,
        project,
      }),
  },
  {
    id: 'test-run',
    label: 'Run test sheet',
    icon: '🎬',
    hint: 'Execute the PR’s test sheet in a fresh workspace with Playwright and record a video of every scenario',
    workspace: 'worktree',
    title: ({ prNumber }) => `Test run: #${prNumber}`,
    prompt: ({ repo, prNumber, branch, project }) =>
      testRunPrompt({
        repo,
        prNumber,
        branch,
        project,
      }),
  },
  {
    id: 'solve-conflicts',
    label: 'Solve conflicts',
    icon: '🔀',
    hint: 'Merge the base branch into a conflicting pull request, resolve the conflicts and push the result',
    // A worktree because the merged branch must still build and pass its tests.
    workspace: 'worktree',
    // Left open it would hold a clone and a pooled database nobody uses.
    autoClose: true,
    title: ({ prNumber }) => `Conflicts: #${prNumber}`,
    prompt: ({ repo, prNumber, branch, baseBranch, project }) =>
      solveConflictsPrompt({
        repo,
        prNumber,
        branch,
        baseBranch,
        project,
      }),
  },
  {
    id: 'fix-checks',
    label: 'Fix failing checks',
    icon: '🧪',
    hint: 'Read the pull request’s failing CI checks, fix what this branch broke and push the fixes',
    // A worktree because re-running CI's jobs needs dependencies and a database.
    workspace: 'worktree',
    // CI on the pushed fixes reports the outcome; an open session would hold a
    // clone and a pooled database nobody uses.
    autoClose: true,
    title: ({ prNumber }) => `Fix checks: #${prNumber}`,
    prompt: ({ repo, prNumber, branch, baseBranch, project }) =>
      fixFailingChecksPrompt({
        repo,
        prNumber,
        branch,
        baseBranch,
        project,
      }),
  },
  {
    id: 'implement-feedback',
    label: 'Implement feedback',
    icon: '🛠',
    hint: 'Address the review findings a pull request carries, push the fixes, and have those changes reviewed automatically',
    workspace: 'worktree',
    // Stays open with the review loop armed, since the loop reports back to it.
    reviewLoop: true,
    title: ({ prNumber }) => `Implement feedback: #${prNumber}`,
    // The hand-started twin of the loop's fix session (startLoopFixSession in
    // lib/jobs.js). Findings (newest review's, else all undecided) are only a head
    // start: most PRs have none, and the prompt reads the review threads anyway.
    prompt: async ({ repo, prNumber, branch, project }) => {
      let findings = [];
      try {
        findings = await latestReviewFindings(repo, prNumber);
        if (!findings.length) {
          const all = await getFindings(repo, prNumber);
          findings = all.findings.filter((f) => f.decision !== 'dismissed' && !f.fixed);
        }
      } catch {
        /* the prompt reads the pull request itself either way */
      }
      return implementFeedbackPrompt({ repo, prNumber, branch, findings, project });
    },
  },
  {
    id: 'custom-feedback',
    label: 'Give feedback',
    icon: '✍',
    hint: 'Say in your own words what to change on this pull request, and have it implemented and pushed',
    workspace: 'worktree',
    title: ({ prNumber }) => `Feedback: #${prNumber}`,
    // The errand is what the user typed; `input` makes the dashboard ask for it.
    input: {
      label: 'Your feedback',
      placeholder:
        'e.g. the new endpoint should 404 instead of 422 when the invoice belongs to another tenant, and add a test for it',
      required: true,
    },
    prompt: ({ repo, prNumber, branch, input, project }) =>
      customFeedbackPrompt({
        repo,
        prNumber,
        branch,
        feedback: input,
        project,
      }),
  },
  {
    id: 'delete-self-comments',
    label: 'Delete my comments',
    icon: '🧹',
    hint: 'Remove every comment and review the configured GitHub account left on a pull request',
    // gh only: the checkout stays where the developer left it.
    workspace: 'local',
    checkout: false,
    autoClose: true,
    title: ({ prNumber }) => `Delete comments: #${prNumber}`,
    // Refuses without a configured PR author rather than guess whose comments to
    // delete.
    prompt: ({ repo, prNumber, branch, project }) => {
      const author = String((project && project.reviewAuthor) || '').trim();
      if (!author) {
        throw new Error(
          `${repo} has no PR author configured in Settings, so there is no account whose comments to delete`,
        );
      }
      return deleteSelfCommentsPrompt({ repo, prNumber, branch, author, project });
    },
  },
];

export function getAction(id) {
  return ACTIONS.find((a) => a.id === id) || null;
}

// What the ⚡ Actions menu lists; `input` is included because the client asks it.
export function listActions() {
  return ACTIONS.map(({ id, label, icon, hint, input }) => ({ id, label, icon, hint, input: input || null }));
}
