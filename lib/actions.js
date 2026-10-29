// @ts-check
// Actions: one-shot errands a session runs against an existing pull request, picked
// from the ⚡ Actions menu. The session is otherwise ordinary, so the user can follow
// up in the same thread. Prompts are composed in lib/prtasks.js from templates
// (lib/templates.js); this file owns the list of errands and where each runs.

import {
  testSheetPrompt,
  testRunPrompt,
  solveConflictsPrompt,
  deleteSelfCommentsPrompt,
  fixFailingChecksPrompt,
  prBodyPrompt,
} from './prtasks.js';

export const ACTIONS = [
  {
    id: 'review',
    label: 'Code review',
    icon: '🔎',
    hint: 'Prepare the branch workspace and run Claude’s /code-review command with the selected effort and model',
    binary: 'claude',
    workspace: 'worktree',
    // Review comments live on the PR; release resources and delete the session when done.
    autoClose: true,
    title: ({ prNumber, branch }) => `Code review: ${prNumber ? `#${prNumber}` : branch}`,
    // createDevSession adds the resolved effort after applying provider defaults.
    prompt: () => '/code-review',
  },
  {
    id: 'pr-body-summary',
    label: 'PR Body Summary',
    icon: '✎',
    hint: 'Rewrite a pull request’s description from its own diff, following the team template',
    workspace: 'local',
    checkout: false,
    // The result lives on the pull request, so nothing is left to read here.
    autoClose: true,
    title: ({ prNumber }) => `PR body: #${prNumber}`,
    prompt: ({ repo, prNumber, project }) => prBodyPrompt({ repo, prNumber, project }),
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
    prompt: ({ repo, prNumber, branch, project, onVideoRun }) =>
      testRunPrompt({
        onVideoRun,
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
      const author = String((project && project.prAuthor) || '').trim();
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
  return ACTIONS.map(({ id, label, icon, hint, input, binary }) => ({
    id,
    label,
    icon,
    hint,
    input: input || null,
    ...(binary ? { binary } : {}),
  }));
}

// The createDevSession options an action starts with, minus the runtime: shared by
// the ⚡ Actions route and the PR babysitter (lib/babysitter.js). Awaited because a
// prompt may read the PR first.
export async function actionSessionSpec(action, context) {
  const videoRuns = [];
  const prompt = await action.prompt({ ...context, onVideoRun: (run) => videoRuns.push(run) });
  return {
    ...(videoRuns.length ? { videoRuns } : {}),
    repo: context.repo,
    // checkout: false leaves the local tree on the developer's branch (gh-only errand).
    branch: action.checkout === false ? undefined : context.branch,
    local: (action.workspace || 'local') === 'local',
    prompt,
    // Attached to the PR now rather than waiting to spot its URL.
    prNumber: context.prNumber,
    // Filed under the PR's branch, whatever branch the borrowed checkout is on.
    prBranch: context.branch,
    // One-shot errands close when done, freeing clone and database.
    autoClose: action.autoClose === true,
    title: action.title(context),
    // Files the session's spend under the errand in the usage ledger.
    activity: action.id,
  };
}
