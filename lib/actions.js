// @ts-check
// Actions: one-shot errands a session runs against an existing pull request.
//
// An action is not a conversation the user opens with a message of their own;
// it is a prompt this app owns, sent to a session started on the pull request
// the user picked in the ⚡ Actions menu. That session is otherwise an ordinary
// one: the same workspace clone (checked out on the pull request's own head
// branch, which is how the agent knows which pull request it is looking at),
// the same providers, the same log, so the user can read what it did and
// follow up on it in the same thread.
//
// What the session is sent is composed in lib/prtasks.js from a template the
// project resolved: built-in, global or its own (lib/templates.js). This file
// owns the list: what each errand is called, where it runs, and which facts its
// prompt is composed from. A second action is a row below rather than a second
// copy of the plumbing.

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

// Every action, in the order the ⚡ Actions menu shows them. `title` is what the
// session is called in the sidebar.
//
// `workspace` says where the session runs: 'local' (the project's own checkout
// right for gh-only errands) or 'worktree' (a fresh clone with setup steps
// and a pooled database, for actions that have to run the app). A local
// action with `checkout: false` does not even switch the checkout's branch:
// it works on the PR entirely through gh, so a dirty local tree cannot fail it.
//
// `autoClose` hands the clone back once the turn ends. `reviewLoop` arms the
// same 🔁 loop a from-scratch session gets, mutually exclusive with
// autoClose, because the loop reports back to this session after it pushes.
//
// `prompt` may be async: an action whose prompt depends on what the pull
// request currently carries (the findings ⚙ Implement feedback works from)
// reads that here, so the session starts with the real list rather than with an
// instruction to go and find it.
export const ACTIONS = [
  {
    id: 'pr-body-summary',
    label: 'PR Body Summary',
    icon: '✎',
    hint: 'Rewrite a pull request’s description from its own diff, following the team template',
    workspace: 'local',
    // Nothing to read afterwards: the rewritten description is on the pull
    // request itself, which is where anyone judging it looks. So the session
    // closes once the turn ends, unless it stopped to ask something, which is
    // the one case where the thread is still live.
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
    // Nothing to read afterwards: the checklist is posted as a comment on the
    // pull request, which is where it gets edited and run from. So the session
    // closes once the turn ends, unless it stopped to ask something, which is
    // the one case where the thread is still live.
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
    // A worktree, not the local checkout: resolving a conflict is only half the
    // job: the merged branch has to still build and pass its tests, which
    // needs the dependencies and the database a prepared workspace gives it.
    workspace: 'worktree',
    // Nothing to read afterwards: the turn resolves the conflicts, pushes the
    // merge and says what it did on the pull request itself. Left open it would
    // hold a clone and a pooled database server for a conversation nobody
    // continues, so it closes itself once the turn ends, unless it stopped to
    // ask something, which is the one case where the thread is still live.
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
    // A worktree, not the local checkout: the whole errand is running the jobs
    // CI ran (the test suite, the linters) which needs the dependencies and
    // the database a prepared workspace gives it.
    workspace: 'worktree',
    // Nothing to read afterwards: the fixes are pushed and CI re-runs on them,
    // so the pull request itself says whether the errand worked. Left open it
    // would hold a clone and a pooled database server for a conversation nobody
    // continues, so it closes itself once the turn ends, unless it stopped to
    // ask something, which is the one case where the thread is still live.
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
    // Stays open with the review loop armed: the first turn pushes the
    // fixes, then every settle with new commits gets an automatic review
    // whose findings go to a fix session of their own: the same loop a
    // from-scratch session gets from the composer's 🔁 chip. Closing after
    // the first turn would drop the parent the loop reports back to.
    reviewLoop: true,
    title: ({ prNumber }) => `Implement feedback: #${prNumber}`,
    // The hand-started twin of the fix session the review loop hands a
    // round's findings to (startLoopFixSession in lib/jobs.js).
    //
    // The declared findings are looked up here so the session starts with them
    // in hand: the newest review's first, the pull request's whole undecided
    // set as the fallback. Most pull requests carrying `feedback-given` have
    // none of either (the machine-readable block only exists on reviews this
    // app published), which is not a dead end: the prompt reads the review
    // threads themselves, and the list is only ever a head start.
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
    // The one action whose errand is not written here: what the session does is
    // what the user typed. `input` is what makes the dashboard ask for it
    // before starting; an action without it is never asked about.
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
    // gh only, and destructive: no clone and no branch switch, so a dirty local
    // tree cannot fail it and the checkout stays where the developer left it.
    workspace: 'local',
    checkout: false,
    // Nothing to read afterwards: the errand says what it deleted in its final
    // message and leaves nothing on the pull request to follow up on.
    autoClose: true,
    title: ({ prNumber }) => `Delete comments: #${prNumber}`,
    // Whose comments: the PR author the project already carries, the account
    // this app posts as. Without one there is nothing to match on, and deleting
    // by guess on someone else's comments is the one mistake this errand must
    // never make, so it refuses instead.
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

// What the ⚡ Actions menu lists. The prompt builders stay on the server, but
// `input` comes along: it is the client that has to ask the question before it
// can start the action at all.
export function listActions() {
  return ACTIONS.map(({ id, label, icon, hint, input }) => ({ id, label, icon, hint, input: input || null }));
}
