import { describe, it, expect, vi, afterEach } from 'vitest';
import { TEST_SHEET_ANCHOR } from '../lib/markers.js';

// r2 is mutable so the R2 tests below can switch the bucket on; null is the
// plain install every other test runs against.
const cfgState = vi.hoisted(() => ({ r2: null }));
vi.mock('../lib/config.js', () => ({
  getConfig: () => ({
    testVideosDir: '/srv/videos',
    publicBaseUrl: 'https://reviewer.example.com',
    r2: cfgState.r2,
  }),
}));

// lib/templates.js reads its overrides from the database at boot; none are
// loaded here, so every prompt renders from the built-in text.
vi.mock('../lib/db.js', () => ({
  loadAppSetting: vi.fn(async () => null),
  saveAppSetting: vi.fn(async () => {}),
}));

import {
  testSheetPrompt,
  testRunPrompt,
  implementFeedbackPrompt,
  customFeedbackPrompt,
  deleteSelfCommentsPrompt,
  solveConflictsPrompt,
  fixFailingChecksPrompt,
  prBodyPrompt,
} from '../lib/prtasks.js';

const base = { repo: 'acme/shop', prNumber: 12, branch: 'feature/x' };

describe('the common tokens', () => {
  it('names the pull request by number when it is known', () => {
    expect(testSheetPrompt(base)).toContain('pull request #12 in acme/shop');
  });

  it('falls back to the branch phrasing when the number is not known yet', () => {
    const prompt = testSheetPrompt({ repo: 'acme/shop', branch: 'feature/x' });
    expect(prompt).toContain('the open pull request for branch feature/x');
  });

  it('leaves no unfilled tokens the composer is responsible for', () => {
    for (const prompt of [
      testSheetPrompt(base),
      testRunPrompt(base),
      implementFeedbackPrompt(base),
      customFeedbackPrompt({ ...base, feedback: 'do it' }),
      deleteSelfCommentsPrompt({ ...base, author: 'bot' }),
      solveConflictsPrompt(base),
      fixFailingChecksPrompt(base),
    ]) {
      // {port} and {dir} are the agent's to fill; {{TOKEN}} is ours.
      expect(prompt).not.toMatch(/\{\{[A-Z0-9_]+\}\}/);
    }
  });
});

describe('testSheetPrompt', () => {
  it('carries the anchor the run turn finds the sheet by', () => {
    expect(testSheetPrompt(base)).toContain(TEST_SHEET_ANCHOR);
  });

  it('appends the project QA notes when there are any', () => {
    const prompt = testSheetPrompt({ ...base, project: { qaNotes: 'login: admin / secret' } });
    expect(prompt).toContain('login: admin / secret');
    expect(prompt).toContain('Project QA notes');
  });

  it('says nothing about QA notes when the project has none', () => {
    expect(testSheetPrompt({ ...base, project: { qaNotes: '  ' } })).not.toContain('Project QA notes');
  });

  // The project's own closing steps go last, after the QA notes; they are what
  // happens once the sheet itself is on the pull request.
  it("ends with the project's closing steps when it configured any", () => {
    const prompt = testSheetPrompt({
      ...base,
      project: { qaNotes: 'login: admin / secret', testSheetInstructions: 'Move the PR to ready-for-qa.' },
    });
    expect(prompt).toContain('closing steps');
    expect(prompt.endsWith('Move the PR to ready-for-qa.')).toBe(true);
  });

  it('says nothing about closing steps when the project configured none', () => {
    expect(testSheetPrompt({ ...base, project: { testSheetInstructions: '  ' } })).not.toContain(
      'closing steps',
    );
  });

  // 📋 Test sheet is a `checkout: false` action (lib/actions.js): it runs in the
  // project's local checkout without switching its branch, so the tree it stands
  // in is usually on someone else's work. A gh command with no number resolves
  // the pull request from that branch, which is how a sheet derived from one
  // PR's diff once landed on another PR entirely. Every gh call in this prompt
  // must therefore name both the number and the repository.
  describe('pins the pull request rather than letting gh infer it', () => {
    // `gh pr <cmd>` followed by anything but the number: a digit when the caller
    // knew it, `<number>` when it is the placeholder step 1 resolves first.
    const inferred = /gh pr (view|diff|comment|checks)(?! [\d<])[^\n`]*/g;

    it('names the number and the repo on every gh pr call', () => {
      const prompt = testSheetPrompt(base);
      expect(prompt).toContain('gh pr view 12 --repo acme/shop');
      expect(prompt).toContain('gh pr diff 12 --repo acme/shop');
      expect(prompt).toContain('gh pr comment 12 --repo acme/shop');
      expect(prompt.match(inferred)).toBeNull();
    });

    it('reads and patches the comments through the repo-and-number api path', () => {
      const prompt = testSheetPrompt(base);
      expect(prompt).toContain('repos/acme/shop/issues/12/comments');
    });

    it('tells the session the checkout may be on an unrelated branch', () => {
      const prompt = testSheetPrompt(base);
      expect(prompt).toContain('never let gh infer the pull request from the current branch');
      expect(prompt).toContain('branch `feature/x`');
    });

    it('has the number looked up from the branch when the caller did not know it', () => {
      // The QA session composes this prompt before the PR number is known.
      const prompt = testSheetPrompt({ repo: 'acme/shop', branch: 'feature/x' });
      expect(prompt).toContain('gh pr list --repo acme/shop --head feature/x');
      expect(prompt.match(inferred)).toBeNull();
    });
  });
});

describe('testRunPrompt', () => {
  it('composes the video paths from the config, slugging the repo', () => {
    const prompt = testRunPrompt(base);
    expect(prompt).toContain('/srv/videos/acme__shop/pr-<pr-number>');
    expect(prompt).toContain('https://reviewer.example.com/videos/acme__shop/pr-<pr-number>');
  });

  it('chains the project run commands and keeps their placeholders', () => {
    const prompt = testRunPrompt({
      ...base,
      portHint: 8104,
      project: { runCommands: ['npm ci', '', 'npm start -- --port {port}'] },
    });
    expect(prompt).toContain('npm ci && npm start -- --port {port}');
    expect(prompt).toContain('try 8104 first');
  });

  it('tells the agent to work the run command out when none is configured', () => {
    const prompt = testRunPrompt({ ...base, project: { runCommands: [] } });
    expect(prompt).toContain('no run command configured');
  });

  describe('with an R2 bucket configured', () => {
    afterEach(() => {
      cfgState.r2 = null;
    });

    // The link is the access control, so the disk path and the bucket URL must
    // carry the same unguessable token; the sync mirrors relative paths.
    it('points the links at the bucket, one 128-bit token on both paths', () => {
      cfgState.r2 = { publicBaseUrl: 'https://videos.example.com' };
      const prompt = testRunPrompt(base);
      const dir = prompt.match(/\/srv\/videos\/acme__shop\/pr-<pr-number>-([0-9a-f]{32})/);
      expect(dir).not.toBeNull();
      expect(prompt).toContain(`https://videos.example.com/acme__shop/pr-<pr-number>-${dir[1]}`);
      expect(prompt).not.toContain('reviewer.example.com/videos');
    });

    it('composes a fresh token per run, so old links survive a re-run', () => {
      cfgState.r2 = { publicBaseUrl: 'https://videos.example.com' };
      const token = (p) => p.match(/pr-<pr-number>-([0-9a-f]{32})/)[1];
      expect(token(testRunPrompt(base))).not.toBe(token(testRunPrompt(base)));
    });
  });
});

describe('implementFeedbackPrompt', () => {
  it('rides the declared findings along when there are any', () => {
    const prompt = implementFeedbackPrompt({
      ...base,
      findings: [
        { severity: 'high', title: 'Injection', file: 'lib/db.js', line: 42 },
        { title: 'No severity given' },
      ],
    });
    expect(prompt).toContain('- **HIGH**: Injection (`lib/db.js:42`)');
    expect(prompt).toContain('- **MEDIUM**: No severity given');
    expect(prompt).toContain('Decide which open findings require a fix');
    expect(prompt).toContain('candidates to assess, not an instruction to implement');
  });

  it('a triaged round is a decided list, with the orchestrator’s note behind it', () => {
    const prompt = implementFeedbackPrompt({
      ...base,
      findings: [{ severity: 'high', title: 'Injection' }],
      triaged: true,
      note: 'Keep the public signature.',
    });
    expect(prompt).toContain('Implement these and only these');
    expect(prompt).not.toContain('starting point');
    expect(prompt).toContain('- **HIGH**: Injection\n\nThe orchestrator adds: Keep the public signature.');
    // An untriaged round says nothing about an orchestrator.
    expect(implementFeedbackPrompt({ ...base, findings: [{ title: 'x' }] })).not.toContain('orchestrator');
  });

  it('collapses cleanly when the pull request declared none', () => {
    const prompt = implementFeedbackPrompt(base);
    expect(prompt).not.toContain('starting point');
    expect(prompt).not.toContain('\n\n\n');
  });

  // The project's own closing steps go last, after the errand's own final
  // paragraph; they are what happens once the feedback is implemented.
  it("ends with the project's closing steps when it configured any", () => {
    const prompt = implementFeedbackPrompt({
      ...base,
      project: { feedbackInstructions: 'Move the PR to ready-for-qa.' },
    });
    expect(prompt).toContain('closing steps');
    expect(prompt.endsWith('Move the PR to ready-for-qa.')).toBe(true);
  });

  it('says nothing about closing steps when the project configured none', () => {
    expect(implementFeedbackPrompt({ ...base, project: { feedbackInstructions: '  ' } })).not.toContain(
      'closing steps',
    );
  });
});

describe('customFeedbackPrompt', () => {
  // The feedback is the whole prompt: no frame, no instructions of ours around
  // it, only the surrounding whitespace trimmed. Equality is the point of the
  // test: `toContain` would pass with a frame back around the words.
  it('sends the feedback and nothing else', () => {
    const prompt = customFeedbackPrompt({ ...base, feedback: '  404 not 422, please\nand add a test  ' });
    expect(prompt).toBe('404 not 422, please\nand add a test');
  });
});

describe('deleteSelfCommentsPrompt', () => {
  it('names the author and lowercases it for the jq comparisons', () => {
    const prompt = deleteSelfCommentsPrompt({ ...base, author: 'ReviewBot' });
    expect(prompt).toContain('`ReviewBot`');
    expect(prompt).toContain('ascii_downcase == "reviewbot"');
  });
});

describe('solveConflicts / fixFailingChecks', () => {
  it('names the base branch, with a fallback when it is unknown', () => {
    expect(solveConflictsPrompt({ ...base, baseBranch: 'main' })).toContain('`main`');
    expect(solveConflictsPrompt(base)).toContain('the base branch');
    expect(fixFailingChecksPrompt({ ...base, baseBranch: 'develop' })).toContain('`develop`');
  });
});

describe('prBodyPrompt', () => {
  it('sends the team template verbatim inside a fence', () => {
    const prompt = prBodyPrompt({ project: null });
    expect(prompt).toMatch(/^Update the PR body with the following/);
    expect(prompt).toContain('```');
    expect(prompt).toContain('Risk Assessment');
  });

  it('a project override replaces the fenced template', () => {
    const prompt = prBodyPrompt({ project: { promptTemplates: { prBody: 'OUR TEMPLATE' } } });
    expect(prompt).toContain('OUR TEMPLATE');
    expect(prompt).not.toContain('Risk Assessment');
  });
});
