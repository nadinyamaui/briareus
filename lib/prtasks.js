// @ts-check
// The prompts a session runs against a PR (test sheet, Playwright test run, fix turns,
// hand-started errands), shared by automatic turns and ⚡ Actions.
//
// Wording lives in templates (lib/templates.js); this module fills each `{{TOKEN}}`.
// The anchor is passed as a token because the run turn parses the sheet comment by it.

import crypto from 'crypto';
import { getConfig } from './config.js';
import { renderTemplate } from './templates.js';
import { TEST_SHEET_ANCHOR, FIXES_ANCHOR, FIX_COMMIT_MARKER } from './markers.js';
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
    FIX_MARKER: FIX_COMMIT_MARKER,
    FIXES_ANCHOR,
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

// ⚙ Implement feedback, started by hand. The PR's review threads are the source, since
// human reviews carry no machine-readable findings; declared findings come along as a
// checklist when present.
export function implementFeedbackPrompt({
  repo,
  prNumber,
  branch,
  findings = [],
  triaged = false,
  note = null,
  by = null,
  project,
}) {
  // A triaged list is final: other threads were excluded on purpose, and the template's
  // "judge which findings need a fix" steps are overridden. `by` is a lowercase noun
  // phrase ("the user"), capitalised only at a sentence start.
  const who = String(by || 'the orchestrator').trim();
  const declared = findings.length
    ? [
        '',
        triaged
          ? `The findings to implement, as ${who} triaged them. Implement these and only these: every other finding of this round was dismissed or left optional on purpose (the "Review triage" comment on the pull request says why), so leave their threads alone. The decision which findings need a fix has already been made; do not reassess this list, and treat the steps below that speak of judging which findings require a fix as settled by it.`
          : 'The findings a review declared machine-readably, as a starting point; the threads on the pull request are still what you work from:',
        '',
        findingList(findings),
        ...(note ? ['', `${who[0].toUpperCase()}${who.slice(1)} adds: ${String(note).trim()}`] : []),
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

// ✍ Give feedback: the user's typed feedback is the errand, quoted verbatim and never
// paraphrased, since their wording is the only statement of what they want.
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

// 🧹 Delete own comments: removes everything the configured account left on a PR, and
// nobody else's. Submitted reviews cannot be deleted, only emptied and dismissed; the
// prompt says so up front.
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

// Resolves conflicts with the base by merging, never rebasing: other turns push to the
// branch, and rewriting its history would strand them. No [reviewer-fix] marker needed,
// since no push triggers a review.
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
  repo,
  prNumber,
  branch,
  portHint = 8100,
  project,
  profile = /** @type {string|null} */ (null),
  database = /** @type {string|null} */ (null),
}) {
  const videos = videoPaths(repo);
  return renderTemplate(
    'testRun',
    {
      ...baseVars({ repo, prNumber, branch }),
      RUN_COMMANDS: runCommandBlock(project, portHint, { profile, database }),
      VIDEO_DIR: videos.dir,
      VIDEO_URL: videos.url,
      QA_NOTES: qaNotesBlock(project ? project.qaNotes : ''),
    },
    project,
  );
}

// ✎ PR Body Summary: the team's PR description template, sent verbatim.
export function prBodyPrompt({ project }) {
  return [
    'Update the PR body with the following',
    '',
    '```',
    renderTemplate('prBody', {}, project),
    '```',
  ].join('\n');
}
