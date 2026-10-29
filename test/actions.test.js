import { describe, it, expect, vi, beforeEach } from 'vitest';

// The prompt builders are lib/prtasks.js's own business, tested there; here
// they only need to prove the action handed them the right facts.
vi.mock('../lib/prtasks.js', () => ({
  testSheetPrompt: vi.fn(() => 'SHEET'),
  testRunPrompt: vi.fn(() => 'RUN'),
  solveConflictsPrompt: vi.fn(() => 'CONFLICTS'),
  deleteSelfCommentsPrompt: vi.fn(({ author }) => `DELETE:${author}`),
  fixFailingChecksPrompt: vi.fn(() => 'CHECKS'),
  prBodyPrompt: vi.fn(() => 'BODY'),
}));

import { getAction, listActions, actionSessionSpec } from '../lib/actions.js';
import * as prtasks from '../lib/prtasks.js';

beforeEach(() => {
  prtasks.testSheetPrompt.mockClear();
});

describe('test-sheet', () => {
  const action = getAction('test-sheet');

  // The errand works on the PR through gh alone, leaving the shared checkout on whatever branch
  // is out; that is only safe while the prompt names the PR, as the facts below ensure.
  it('runs in the local checkout without switching its branch', () => {
    expect(action.workspace).toBe('local');
    expect(action.checkout).toBe(false);
  });

  it('hands the prompt the pull request the board row was for, untouched', async () => {
    const project = { repo: 'acme/shop' };
    const prompt = await action.prompt({
      repo: 'acme/shop',
      prNumber: 11780,
      branch: 'patch/11734-fleet-locations-custom-field-filters',
      project,
    });
    expect(prompt).toBe('SHEET');
    expect(prtasks.testSheetPrompt).toHaveBeenCalledWith({
      repo: 'acme/shop',
      prNumber: 11780,
      branch: 'patch/11734-fleet-locations-custom-field-filters',
      project,
    });
  });

  it('titles the session after that pull request', () => {
    expect(action.title({ prNumber: 11780 })).toBe('Test sheet: #11780');
  });
});

describe('delete-self-comments', () => {
  const action = getAction('delete-self-comments');

  it('refuses to run without a configured author to match on', () => {
    expect(() => action.prompt({ repo: 'a/b', prNumber: 1, project: {} })).toThrow(/no PR author configured/);
    expect(() => action.prompt({ repo: 'a/b', prNumber: 1, project: { prAuthor: '  ' } })).toThrow(
      /no PR author configured/,
    );
  });

  it('hands the trimmed author to the prompt', () => {
    const prompt = action.prompt({ repo: 'a/b', prNumber: 1, project: { prAuthor: ' bot ' } });
    expect(prompt).toBe('DELETE:bot');
  });
});

describe('pr-body-summary', () => {
  const action = getAction('pr-body-summary');

  it('passes the target repository and PR number because the checkout may be on another branch', async () => {
    const project = { repo: 'acme/shop' };

    expect(await action.prompt({ repo: 'acme/shop', prNumber: 5, project })).toBe('BODY');
    expect(prtasks.prBodyPrompt).toHaveBeenCalledWith({ repo: 'acme/shop', prNumber: 5, project });
  });

  it('titles the session after the pull request', () => {
    expect(action.title({ prNumber: 5 })).toBe('PR body: #5');
  });
});

describe('test-run', () => {
  const action = getAction('test-run');

  it('runs in a prepared worktree: it has to start the app', () => {
    expect(action.workspace).toBe('worktree');
  });

  it('hands the prompt the pull request it is running the sheet for', async () => {
    const project = { repo: 'acme/shop' };

    expect(await action.prompt({ repo: 'acme/shop', prNumber: 7, branch: 'feat', project })).toBe('RUN');
    expect(prtasks.testRunPrompt).toHaveBeenCalledWith({
      repo: 'acme/shop',
      prNumber: 7,
      branch: 'feat',
      project,
    });
  });

  it('titles the session after that pull request', () => {
    expect(action.title({ prNumber: 7 })).toBe('Test run: #7');
  });
});

describe('solve-conflicts', () => {
  const action = getAction('solve-conflicts');

  it('runs in a prepared worktree: the merge still has to build and pass', () => {
    expect(action.workspace).toBe('worktree');
  });

  it('hands the prompt the base branch it is merging in as well', async () => {
    const project = { repo: 'acme/shop' };

    expect(
      await action.prompt({ repo: 'acme/shop', prNumber: 9, branch: 'feat', baseBranch: 'main', project }),
    ).toBe('CONFLICTS');
    expect(prtasks.solveConflictsPrompt).toHaveBeenCalledWith({
      repo: 'acme/shop',
      prNumber: 9,
      branch: 'feat',
      baseBranch: 'main',
      project,
    });
  });

  it('titles the session after that pull request', () => {
    expect(action.title({ prNumber: 9 })).toBe('Conflicts: #9');
  });
});

describe('fix-checks', () => {
  const action = getAction('fix-checks');

  it('runs in a prepared worktree: the errand is running the jobs CI ran', () => {
    expect(action.workspace).toBe('worktree');
  });

  it('hands the prompt the branch and its base', async () => {
    const project = { repo: 'acme/shop' };

    expect(
      await action.prompt({ repo: 'acme/shop', prNumber: 3, branch: 'feat', baseBranch: 'main', project }),
    ).toBe('CHECKS');
    expect(prtasks.fixFailingChecksPrompt).toHaveBeenCalledWith({
      repo: 'acme/shop',
      prNumber: 3,
      branch: 'feat',
      baseBranch: 'main',
      project,
    });
  });

  it('titles the session after that pull request', () => {
    expect(action.title({ prNumber: 3 })).toBe('Fix checks: #3');
  });
});

describe('actionSessionSpec', () => {
  const context = {
    repo: 'a/b',
    prNumber: 4,
    branch: 'feature/x',
    baseBranch: 'main',
    title: 'T',
    project: null,
    input: '',
  };

  it('starts a Codex review on the PR head branch and deletes its session when done', async () => {
    expect(listActions().find((a) => a.id === 'review')).toMatchObject({ binary: 'codex' });
    expect(await actionSessionSpec(getAction('review'), context)).toEqual({
      repo: 'a/b',
      branch: 'feature/x',
      local: false,
      prompt: '/review',
      prNumber: 4,
      prBranch: 'feature/x',
      autoClose: true,
      title: 'Code review: #4',
      activity: 'review',
    });
  });

  it('checks out the PR branch in a worktree for an errand that pushes, and closes it when done', async () => {
    expect(await actionSessionSpec(getAction('fix-checks'), context)).toEqual({
      repo: 'a/b',
      branch: 'feature/x',
      local: false,
      prompt: 'CHECKS',
      prNumber: 4,
      prBranch: 'feature/x',
      autoClose: true,
      title: 'Fix checks: #4',
      activity: 'fix-checks',
    });
  });

  it('keeps allocated video runs with the session specification', async () => {
    prtasks.testRunPrompt.mockImplementationOnce(({ onVideoRun }) => {
      onVideoRun('a__b/pr-<pr-number>-0123456789abcdef0123456789abcdef');
      return 'RUN';
    });
    expect(await actionSessionSpec(getAction('test-run'), context)).toMatchObject({
      prompt: 'RUN',
      videoRuns: ['a__b/pr-<pr-number>-0123456789abcdef0123456789abcdef'],
    });
  });

  it.each(['pr-body-summary', 'test-sheet', 'delete-self-comments'])(
    '%s leaves the local checkout alone even when the PR branch is unavailable locally',
    async (id) => {
      const spec = await actionSessionSpec(getAction(id), {
        ...context,
        project: { prAuthor: 'morgan' },
      });
      expect(spec).toMatchObject({
        branch: undefined,
        local: true,
        prNumber: 4,
        prBranch: 'feature/x',
        autoClose: true,
      });
    },
  );
});
