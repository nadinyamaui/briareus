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
  deleteSelfCommentsPrompt,
  solveConflictsPrompt,
  fixFailingChecksPrompt,
  implementFeedbackPrompt,
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
});

describe('QA task requirements', () => {
  it.each([testSheetPrompt, testRunPrompt])(
    'preserves explicit curl instructions even with template overrides',
    (compose) => {
      const qaInstructions =
        'Use curl, save bodies/headers/status, assert response values and publish evidence.';
      const prompt = compose({
        ...base,
        qaInstructions,
        project: { promptTemplates: { testSheet: 'CUSTOM SHEET', testRun: 'CUSTOM RUN' } },
      });
      expect(prompt).toContain(qaInstructions);
      expect(prompt).toContain('CUSTOM');
      expect(prompt).toContain('every row is ✅ with execution evidence');
      expect(prompt).toContain('preserve intentionally manual/excluded procedures');
    },
  );

  it('plans API scenarios as executable and runs them with saved assertions', () => {
    expect(testSheetPrompt(base)).toContain('concrete curl requests and response assertions with status ⬜');
    const prompt = testRunPrompt(base);
    expect(prompt).toContain('save response bodies, headers and HTTP status');
    expect(prompt).toContain('assert the expected status and response values');
    expect(prompt).toContain('Publish sanitized evidence');
    expect(prompt).not.toContain('Leave 🖐 rows alone');
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
  it("includes the project's closing steps when it configured any", () => {
    const prompt = testSheetPrompt({
      ...base,
      project: { qaNotes: 'login: admin / secret', testSheetInstructions: 'Move the PR to ready-for-qa.' },
    });
    expect(prompt).toContain('closing steps');
    expect(prompt).toContain('Move the PR to ready-for-qa.');
  });

  it('says nothing about closing steps when the project configured none', () => {
    expect(testSheetPrompt({ ...base, project: { testSheetInstructions: '  ' } })).not.toContain(
      'closing steps',
    );
  });

  // 📋 Test sheet runs in the project's local checkout without switching branch
  // (lib/actions.js), so gh with no number infers the PR from whatever branch is out; a sheet
  // once landed on the wrong PR that way. Every gh call in this prompt must name both number
  // and repository.
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
    expect(prompt).toContain('https://reviewer.example.com/api/v1/videos/acme__shop/pr-<pr-number>');
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

  it('serves the run profile it is given: env as exports, its commands first, tenants on .localhost', () => {
    const prompt = testRunPrompt({
      ...base,
      portHint: 8101,
      profile: 'projects',
      database: 'demoapp',
      project: {
        runCommands: ['php -S 127.0.0.1:{port} -t public server.php'],
        runProfiles: [
          'profile: veterinary',
          'env:',
          '  VERTICAL=veterinary',
          'profile: projects',
          'env:',
          "  VERTICAL=it's projects",
          '  DB_DATABASE={database}_projects',
          'tenants: central, demo',
          'before:',
          '  php artisan tenants:register-domain demo {host:demo}',
        ].join('\n'),
      },
    });

    expect(prompt).toContain('run profile `projects`');
    expect(prompt).toContain(
      "export VERTICAL='it'\\''s projects' && export DB_DATABASE='demoapp_projects' && php artisan tenants:register-domain demo demo--preview-{port}.localhost && php -S 127.0.0.1:{port} -t public server.php",
    );
    expect(prompt).toContain('`central` at `http://central--preview-{port}.localhost:{port}`');
    expect(prompt).not.toContain('`{database}` is');
  });

  it("renders the profile's placeholders in the project's run commands too, as ▶ Run does", () => {
    const prompt = testRunPrompt({
      ...base,
      profile: 'projects',
      database: 'demoapp',
      project: {
        runCommands: ['VERTICAL={profile} DB={database} php -S {host}:{port} -t {dir}/public {host:demo}'],
        runProfiles: 'profile: projects\ntenants: demo',
      },
    });

    expect(prompt).toContain(
      'VERTICAL=projects DB=demoapp php -S 127.0.0.1:{port} -t {dir}/public demo--preview-{port}.localhost',
    );
  });

  it('falls back to the default profile, and explains {database} when the session is not known yet', () => {
    const prompt = testRunPrompt({
      ...base,
      profile: 'gone',
      project: {
        runCommands: ['npm start'],
        runProfiles: 'profile: first\nenv:\n  DB_DATABASE={database}_first',
      },
    });

    expect(prompt).toContain("export DB_DATABASE='{database}_first' && npm start");
    expect(prompt).toContain("`{database}` is this session's own database name");
  });

  it('does not hand over run commands naming a tenant the served profile does not list', () => {
    const prompt = testRunPrompt({
      ...base,
      project: {
        runCommands: ['php artisan register {host:central}', 'php -S 127.0.0.1:{port}'],
        runProfiles: 'profile: projects\ntenants: demo',
      },
    });

    expect(prompt).toContain(
      'use `{host:central}`, but its run profile `projects` does not list `central` under tenants:',
    );
    expect(prompt).not.toContain('php artisan register');
    expect(testRunPrompt({ ...base, project: { runCommands: ['x {host:central}'] } })).toContain(
      'no run profile is served, so there is no tenant to name',
    );
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
      const onVideoRun = vi.fn();
      const qaInstructions = 'Use curl and assert JSON response values.';
      const prompt = testRunPrompt({ ...base, onVideoRun, qaInstructions });
      const dir = prompt.match(/\/srv\/videos\/acme__shop\/pr-<pr-number>-([0-9a-f]{32})/);
      expect(dir).not.toBeNull();
      expect(onVideoRun).toHaveBeenCalledWith(`acme__shop/pr-<pr-number>-${dir[1]}`);
      expect(prompt).toContain(qaInstructions);
      expect(prompt).toContain('every row is ✅ with execution evidence');
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

describe('implementFeedbackPrompt', () => {
  it('works from the live review threads, including the code review verdicts', () => {
    const prompt = implementFeedbackPrompt(base);
    expect(prompt).toContain('pull request #12 in acme/shop');
    expect(prompt).toContain('repos/acme/shop/pulls/12/comments');
    expect(prompt).toContain('git push origin HEAD:feature/x');
    expect(prompt).toContain('**Fix** is open, **Dismissed** is done');
    expect(prompt).toContain('not fixed');
  });

  it('reads every thread and whether it is resolved before choosing what to change', () => {
    const prompt = implementFeedbackPrompt(base);
    const threads = prompt.indexOf('reviewThreads(first:100,after:$endCursor)');
    expect(threads).toBeGreaterThan(-1);
    expect(prompt.slice(threads)).toMatch(/^[^`]*isResolved[^`]*pageInfo\{hasNextPage endCursor\}/);
    expect(prompt).toContain('gh api graphql --paginate');
    // Read in step 1, before step 2 picks the open feedback, and only once.
    expect(threads).toBeLessThan(prompt.indexOf('2. Work out which feedback is still open'));
    expect(prompt.indexOf('reviewThreads', threads + 1)).toBe(-1);
    expect(prompt).toContain('A thread whose `isResolved` is true');
  });

  it('a project override replaces the built-in text', () => {
    expect(
      implementFeedbackPrompt({
        ...base,
        project: { promptTemplates: { implementFeedback: 'OURS {{PR_NUMBER}}' } },
      }),
    ).toBe('OURS 12');
  });
});

describe('prBodyPrompt', () => {
  it('sends the team template verbatim inside a fence', () => {
    const prompt = prBodyPrompt({ ...base, project: null });
    expect(prompt).toContain('pull request #12 in acme/shop');
    expect(prompt).toContain('```');
    expect(prompt).toContain('Risk Assessment');
  });

  it('a project override replaces the fenced template', () => {
    const prompt = prBodyPrompt({ ...base, project: { promptTemplates: { prBody: 'OUR TEMPLATE' } } });
    expect(prompt).toContain('```\nOUR TEMPLATE\n```');
    expect(prompt).not.toContain('Risk Assessment');
  });

  it('reads and edits the named PR through GitHub while leaving the local checkout alone', () => {
    const prompt = prBodyPrompt(base);
    expect(prompt).toContain('gh pr view 12 --repo acme/shop');
    expect(prompt).toContain('gh pr diff 12 --repo acme/shop');
    expect(prompt).toContain('gh pr edit 12 --repo acme/shop --body-file <file>');
    expect(prompt).toContain('unrelated branch');
    expect(prompt).toContain('never let gh infer the pull request');
    expect(prompt).toContain('never work from `git diff`, `git log` or the working tree');
    expect(prompt).toContain('Do not switch branches');
  });
});
