// @ts-check
// The prompts a session runs against a PR (test sheet, Playwright test run, fix turns,
// hand-started errands), shared by automatic turns and ⚡ Actions.
//
// Wording lives in templates (lib/templates.js); this module fills each `{{TOKEN}}`.
// The anchor is passed as a token because the run turn parses the sheet comment by it.

import crypto from 'crypto';
import { getConfig } from './config.js';
import { renderTemplate } from './templates.js';
import { TEST_SHEET_ANCHOR } from './markers.js';
import { pickRunProfile, profileRun, render, runVars, unknownHostTenant } from './runprofiles.js';
import { localHostname } from './tunnel.js';

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
  };
}

// Per-project QA notes (logins, tenants, URLs) for the QA prompts.
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

// The project's own closing steps (move a label, ping a channel), appended last; empty
// when unconfigured so the prompt is unchanged.
function closingStepsBlock(instructions) {
  const text = String(instructions || '').trim();
  if (!text) return '';
  return ['', "Finally, this project's own closing steps for this errand:", '', text].join('\n');
}

// A PR's video dir and URL, with a `<pr-number>` placeholder since the number may only
// be learned mid-run. Public R2 links are the access control, so each run gets a fresh
// 128-bit token (also keeping older runs' links alive); without R2 the API needs a token.
function videoPaths(repo) {
  const cfg = getConfig();
  const slug = repo.replace('/', '__');
  const suffix = cfg.r2 ? `-${crypto.randomBytes(16).toString('hex')}` : '';
  return {
    run: `${slug}/pr-<pr-number>${suffix}`,
    dir: `${cfg.testVideosDir}/${slug}/pr-<pr-number>${suffix}`,
    url: cfg.r2
      ? `${cfg.r2.publicBaseUrl}/${slug}/pr-<pr-number>${suffix}`
      : `${cfg.publicBaseUrl}/api/v1/videos/${slug}/pr-<pr-number>${suffix}`,
  };
}

// The run command block, leaving {port}/{dir} for the agent, which alone knows which
// port is free.
//
// The served run profile adds env exports and pre-commands. Tenants use .localhost
// hostnames, since the agent's browser cannot pass the tunnel's Access login and
// Chromium resolves *.localhost itself. {database} is filled when the session is
// known; otherwise the agent is told what it means.
/**
 * @param {any} project
 * @param {number} portHint
 * @param {{ profile?: string|null, database?: string|null }} [opts]
 */
function runCommandBlock(project, portHint, { profile: wanted = null, database = null } = {}) {
  const commands = ((project && project.runCommands) || []).filter(Boolean);
  if (!commands.length) {
    return 'This project has no run command configured in the dashboard. Work out how to serve the app from the repository itself (README, composer/npm scripts); if you cannot, mark the browser scenarios 🖐 with a note in Evidence, update the sheet, and stop.';
  }
  const profile = pickRunProfile(project, null, wanted);
  const vars = runVars({
    port: '{port}',
    dir: '{dir}',
    database: database || '{database}',
    profile,
    hostFor: (tenant) => localHostname('{port}', tenant),
  });
  // Refused like ▶ Run does (devServeRecipe), never passing a literal {host:<tenant>}.
  const missing = unknownHostTenant(commands, vars);
  if (missing) {
    return `The project's run commands use \`{host:${missing}}\`, but ${profile ? `its run profile \`${profile.name}\` does not list \`${missing}\` under tenants:` : 'no run profile is served, so there is no tenant to name'}, so the app cannot be served as configured. Mark the browser scenarios 🖐 with a note in Evidence saying so, update the sheet, and stop.`;
  }
  const run = profileRun(profile, vars);
  const quote = (v) => `'${String(v).replace(/'/g, `'\\''`)}'`;
  const chain = [
    ...Object.entries(run.env).map(([k, v]) => `export ${k}=${quote(v)}`),
    ...run.before,
    ...commands.map((c) => render(c, vars)),
  ];
  const lines = [
    profile
      ? `The project's run commands, with its run profile \`${profile.name}\` (the configuration the user serves with ▶ Run), are (run them chained, in the workspace root):`
      : "The project's run commands are (run them chained, in the workspace root):",
    '',
    '```',
    chain.join(' && '),
    '```',
    '',
    `Replace \`{port}\` with a free port (try ${portHint} first) and \`{dir}\` with the absolute workspace root. Run the server in the background and verify the app answers over HTTP before going on.`,
  ];
  if (chain.some((c) => c.includes('{database}'))) {
    lines.push(
      '',
      "`{database}` is this session's own database name: the `DB_DATABASE` in your environment, or in the checkout's `.env` when the environment has none. A database the profile names off it may not exist yet; create it on the same server first.",
    );
  }
  if (profile && profile.tenants.length) {
    lines.push(
      '',
      `The app picks its tenant from the Host header. Open each tenant on its own hostname, with the port you chose: ${profile.tenants
        .map((t) => `\`${t}\` at \`http://${localHostname('{port}', t)}:{port}\``)
        .join(', ')}. Chromium resolves every \`*.localhost\` name to 127.0.0.1 by itself.`,
    );
  }
  return lines.join('\n');
}

// Appended outside editable templates so an override cannot drop the task or pass gate.
function qaRequirements(instructions) {
  return [
    '',
    'QA coverage requirements: API scenarios are executable via curl; do not mark them manual merely because they have no UI. Save response bodies, headers and HTTP status, assert the expected values, and publish sanitized evidence with the row. Use browser videos for UI scenarios. Reassess legacy 🖐 API rows for execution; preserve intentionally manual/excluded procedures and explain why in Evidence.',
    'Only report full QA passed or apply qa-test-passed when the sheet has at least one scenario and every row is ✅ with execution evidence. Any ❌ means failed; any 🖐, ⬜, unknown status or missing evidence means incomplete coverage, not a fabricated failure or readiness to merge. Remove qa-test-passed for failed or incomplete coverage. These requirements take precedence over project publishing instructions.',
    ...(String(instructions || '').trim()
      ? [
          '',
          'Original task brief: follow its QA method, coverage and evidence instructions; implementation work remains outside this QA errand.',
          '',
          String(instructions).trim(),
        ]
      : []),
  ].join('\n');
}

export function testSheetPrompt({ repo, prNumber, branch, project, qaInstructions = '' }) {
  return (
    renderTemplate(
      'testSheet',
      {
        ...baseVars({ repo, prNumber, branch }),
        QA_NOTES: qaNotesBlock(project ? project.qaNotes : ''),
        TEST_SHEET_INSTRUCTIONS: closingStepsBlock(project ? project.testSheetInstructions : ''),
      },
      project,
    ) + qaRequirements(qaInstructions)
  );
}

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

// Fixes failing CI checks on the PR branch, with the [reviewer-fix] marker like other
// fix turns. The failing checks are not baked in: they may have changed by run time,
// so the turn reads the live list.
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

// `profile` is the run profile the session last served, if any; a name the
// project no longer defines gives way to its default profile.
export function testRunPrompt({
  onVideoRun = /** @type {((run: string) => void)|null} */ (null),
  repo,
  prNumber,
  branch,
  portHint = 8100,
  qaInstructions = '',
  project,
  profile = /** @type {string|null} */ (null),
  database = /** @type {string|null} */ (null),
}) {
  const videos = videoPaths(repo);
  onVideoRun?.(videos.run);
  return (
    renderTemplate(
      'testRun',
      {
        ...baseVars({ repo, prNumber, branch }),
        RUN_COMMANDS: runCommandBlock(project, portHint, { profile, database }),
        VIDEO_DIR: videos.dir,
        VIDEO_URL: videos.url,
        QA_NOTES: qaNotesBlock(project ? project.qaNotes : ''),
      },
      project,
    ) + qaRequirements(qaInstructions)
  );
}

// ✎ PR Body Summary runs in the local checkout without switching its branch.
export function prBodyPrompt({ repo, prNumber, project }) {
  return [
    `Update the body of pull request #${prNumber} in ${repo} from its own diff, following the template below.`,
    '',
    `Read the pull request with \`gh pr view ${prNumber} --repo ${repo}\` and its diff with \`gh pr diff ${prNumber} --repo ${repo}\`, then write the completed description to a file and update it with \`gh pr edit ${prNumber} --repo ${repo} --body-file <file>\`.`,
    '',
    'Every gh call must name the pull request and repository: the checkout may be on an unrelated branch, so never let gh infer the pull request, and never work from `git diff`, `git log` or the working tree. Do not switch branches or modify repository files.',
    '',
    '```',
    renderTemplate('prBody', {}, project),
    '```',
  ].join('\n');
}
