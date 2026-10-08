// @ts-check
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { execFileSync, spawn } from 'child_process';
import readline from 'readline';
import { childEnv } from './childenv.js';
import { ownClaudeCost } from './claude-session.js';

// The four coding-agent binaries, the only hardcoded part of the provider system: discovery,
// default models and efforts, headless invocation, and stdout normalization. Provider rows live
// in the `providers` table (lib/providerstore.js). Claude's discovery is in config.js.

// WSL inherits the Windows PATH, so a `which` hit can land on a mounted Windows
// drive (/mnt/c/...), which is a host executable, not one this Linux can run.
function onPath(name) {
  try {
    return execFileSyncLines('which', ['-a', name]).filter((f) => !f.startsWith('/mnt/'))[0] || null;
  } catch {
    return null;
  }
}

function execFileSyncLines(bin, args) {
  return execFileSync(bin, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
}

function findCodexBin(envOverride) {
  if (envOverride && fs.existsSync(envOverride)) return { bin: envOverride, source: 'CODEX_BIN' };
  const fromPath = onPath('codex');
  if (fromPath) return { bin: fromPath, source: 'PATH' };

  // npm's global prefix is per-user so the CLI can update itself without sudo.
  for (const candidate of [
    { bin: path.join(os.homedir(), '.npm-global', 'bin', 'codex'), source: 'npm global' },
    { bin: '/usr/local/bin/codex', source: 'npm global (system)' },
  ]) {
    if (fs.existsSync(candidate.bin)) return candidate;
  }
  return null;
}

function findGrokBin(envOverride) {
  if (envOverride && fs.existsSync(envOverride)) return { bin: envOverride, source: 'GROK_BIN' };
  const fromPath = onPath('grok');
  if (fromPath) return { bin: fromPath, source: 'PATH' };
  // x.ai's installer drops the binary in ~/.grok/bin.
  const candidate = path.join(os.homedir(), '.grok', 'bin', 'grok');
  if (fs.existsSync(candidate)) return { bin: candidate, source: '~/.grok/bin' };
  return null;
}

function findOpencodeBin(envOverride) {
  if (envOverride && fs.existsSync(envOverride)) return { bin: envOverride, source: 'OPENCODE_BIN' };
  const fromPath = onPath('opencode');
  if (fromPath) return { bin: fromPath, source: 'PATH' };
  // The installer uses ~/.opencode/bin; the npm package (opencode-ai) the global prefix.
  for (const candidate of [
    { bin: path.join(os.homedir(), '.opencode', 'bin', 'opencode'), source: '~/.opencode/bin' },
    { bin: path.join(os.homedir(), '.npm-global', 'bin', 'opencode'), source: 'npm global' },
    { bin: '/usr/local/bin/opencode', source: 'npm global (system)' },
  ]) {
    if (fs.existsSync(candidate.bin)) return candidate;
  }
  return null;
}

// In the order codex 0.159.2's bundled catalog ranks them, so the picker does
// not reshuffle once the startup model/list refresh writes a cache.
const CODEX_MODEL_FALLBACK = [
  'gpt-6.1-sol',
  'gpt-6-astra',
  'gpt-6-sol',
  'gpt-6-luna',
  'gpt-5.5',
  'gpt-5.4',
  'gpt-5.4-mini',
];

const CODEX_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const CODEX_FALLBACK_MAX_MODELS = new Set(CODEX_MODEL_FALLBACK.filter((slug) => slug.startsWith('gpt-6')));
// Newest first, so a row whose list predates the newest lands on the one before it. Frozen
// because defaultModel() shares the array; a caller sorting it would change the process default.
const CODEX_DEFAULT_MODELS = Object.freeze(['gpt-6.1-sol', 'gpt-6-sol']);

// A custom endpoint listing no models skips the newest default, which a proxy that has not caught
// up most likely lacks. An API-key-only row calls OpenAI directly and keeps the full list.
function codexDefaultModels(_cfg, provider = null) {
  if (provider && provider.baseUrl && !provider.models.length) {
    return CODEX_DEFAULT_MODELS.slice(1);
  }
  return CODEX_DEFAULT_MODELS;
}

// The stored default if offered, then the first binary default offered, then the first model.
// Every caller resolves through this so the picker, config.toml and endpoint probe agree.
export function resolveDefaultModel(binary, provider, models, cfg) {
  if (provider.defaultModel && models.includes(provider.defaultModel)) return provider.defaultModel;
  const preferred = binary.defaultModels ? binary.defaultModels(cfg, provider) : [binary.defaultModel(cfg)];
  return preferred.find((m) => models.includes(m)) || models[0];
}

// A custom-endpoint row's picker default as a codex slug, for ensureCodexHome and the probe.
export function codexEndpointDefaultModel(provider) {
  const models = provider.models.length ? provider.models : codexModels(null, provider);
  return splitCodexModel(resolveDefaultModel(codexBinary, provider, models, null)).slug;
}

// Models with a `max_context_window` above the default appear twice in the picker, plain and as a
// "gpt-6-astra (872k)" twin, so the window is chosen per session. The size rides in the label
// because the stored string is all buildArgs gets, with no catalog in reach.
const CODEX_WIDE_MODEL = /^(.+) \((\d+)k\)$/;
const GPT_56_MODEL = /^gpt-5\.6(?:-|$)/;

// The real slug for -m, and the window override (null keeps the model's default).
export function splitCodexModel(model) {
  const match = CODEX_WIDE_MODEL.exec(String(model || ''));
  if (!match) return { slug: String(model || ''), contextWindow: null };
  return { slug: match[1], contextWindow: Number(match[2]) * 1000 };
}

// Interleaves each slug's wide twin after it. A ceiling not a whole number of thousands is skipped,
// not rounded: the label is its only record, so rounding would send codex the wrong window.
export function codexWideVariants(slugs, provider = null, home = os.homedir()) {
  // Login-backed pickers omit GPT-5.6 deliberately; custom endpoints never call this.
  const hadModels = slugs.length > 0;
  slugs = slugs.filter((slug) => !GPT_56_MODEL.test(slug));
  // A row listing only GPT-5.6 falls back to the baked catalog rather than an empty -m.
  if (hadModels && !slugs.length) slugs = CODEX_MODEL_FALLBACK;
  let catalog = null;
  for (const dir of codexCacheDirs(provider, home)) {
    try {
      catalog = JSON.parse(fs.readFileSync(path.join(dir, 'models_cache.json'), 'utf8')).models || [];
      break;
    } catch {
      /* the next dir, or no widening at all */
    }
  }
  if (!catalog) return slugs;
  const out = [];
  for (const slug of slugs) {
    out.push(slug);
    // A pick that is already a wide twin must not grow one of its own.
    if (CODEX_WIDE_MODEL.test(slug)) continue;
    const entry = catalog.find((m) => m.slug === slug);
    const max = entry && entry.max_context_window;
    if (!max || !(max > entry.context_window) || max % 1000) continue;
    out.push(`${slug} (${max / 1000}k)`);
  }
  return out;
}

// Read from codex's own models cache rather than a list that goes stale. Hidden, review-only,
// watermark and GPT-5.6 variants stay out of the picker.
function codexModels(_cfg, provider = null, home = os.homedir()) {
  const models = codexCatalogModels(provider, home);
  // The catalog says nothing about what a custom endpoint serves, so its stored default (the one
  // thing the operator said) is offered too and wins.
  const stored = provider && provider.baseUrl && provider.defaultModel;
  return stored && !models.includes(stored) ? [stored, ...models] : models;
}

// The row's own CODEX_HOME (which its runs refresh), then ~/.codex. An unsaved row has no dir.
function codexCacheDirs(provider, home = os.homedir()) {
  return [...(provider?.id != null ? [codexHomeDir(provider, home)] : []), path.join(home, '.codex')];
}

function codexCatalogModels(provider, home) {
  for (const dir of codexCacheDirs(provider, home)) {
    try {
      const cached = JSON.parse(fs.readFileSync(path.join(dir, 'models_cache.json'), 'utf8'));
      const slugs = (cached.models || [])
        .filter((m) => m.visibility !== 'hide')
        .map((m) => m.slug)
        .filter((slug) => slug && !GPT_56_MODEL.test(slug) && !/auto-review|-wm$/.test(slug));
      if (slugs.length) return codexWideVariants(slugs, provider, home);
    } catch {
      /* the next cache, or the baked fallback, answers */
    }
  }
  return CODEX_MODEL_FALLBACK;
}

// The models cache decides which efforts a model accepts (GPT-5.5 must not get GPT-6's `max`).
// Without a cache, `max` is offered only to model families known to support it.
export function codexEffortsForModel(model, provider = null, home = os.homedir()) {
  const slug = splitCodexModel(model).slug;
  for (const dir of codexCacheDirs(provider, home)) {
    try {
      const models = JSON.parse(fs.readFileSync(path.join(dir, 'models_cache.json'), 'utf8')).models || [];
      const entry = models.find((m) => m.slug === slug);
      if (!entry) continue;
      const efforts = (entry.supported_reasoning_levels || []).map((level) => level.effort).filter(Boolean);
      if (efforts.length) return efforts;
    } catch {
      /* the next cache, or the conservative fallback, answers */
    }
  }
  return CODEX_FALLBACK_MAX_MODELS.has(slug) ? CODEX_EFFORTS : CODEX_EFFORTS.slice(0, -1);
}

// model/list over codex's app-server protocol refreshes models_cache.json as a side effect. A
// one-shot child, since only startup needs to force a refresh.
export function refreshCodexModelCache(provider, cfg, options = {}) {
  const spawnProcess = options.spawnProcess || spawn;
  const ensureHome = options.ensureHome || ensureCodexHome;
  const timeoutMs = options.timeoutMs || 10000;
  return new Promise((resolve, reject) => {
    if (provider.binary !== 'codex' || provider.baseUrl || provider.apiKey) return resolve([]);
    const found = findCodexBin(cfg?.codexBin);
    if (!found) return reject(new Error('codex CLI not found'));

    let child;
    try {
      child = spawnProcess(found.bin, ['app-server'], {
        env: childEnv({ CODEX_HOME: ensureHome(provider) }),
        stdio: ['pipe', 'pipe', 'ignore'],
      });
    } catch (e) {
      return reject(e);
    }

    const lines = readline.createInterface({ input: child.stdout });
    let done = false;
    const finish = (error, models = []) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      lines.close();
      child.kill();
      if (error) reject(error);
      else resolve(models);
    };
    const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
    const timer = setTimeout(() => finish(new Error(`model/list timed out after ${timeoutMs}ms`)), timeoutMs);

    child.once('error', (e) => finish(e));
    child.once('exit', (code) => {
      if (!done)
        finish(new Error(`codex app-server exited before model/list${code == null ? '' : ` (${code})`}`));
    });
    lines.on('line', (line) => {
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      if (message.id === 0) {
        if (message.error)
          return finish(new Error(message.error.message || 'codex app-server initialization failed'));
        send({ method: 'initialized', params: {} });
        send({ method: 'model/list', id: 1, params: { limit: 100, includeHidden: false } });
      } else if (message.id === 1) {
        if (message.error) return finish(new Error(message.error.message || 'codex model/list failed'));
        const models = (message.result?.data || []).map((model) => model.id || model.model).filter(Boolean);
        finish(null, models);
      }
    });

    send({
      method: 'initialize',
      id: 0,
      params: { clientInfo: { name: 'briareus', title: 'Briareus', version: '1.0.0' } },
    });
  });
}

// An entry's key is for one service, so its list is that service's `<service>/<model>` entries
// from the CLI's cached models.dev catalog. The fallback is for an entry naming no service.
function opencodeModels(cfg, provider = null) {
  const fallback = ['anthropic/claude-sonnet-4-5', 'openai/gpt-5.1-codex', 'opencode/grok-code'];
  const service = provider ? opencodeServiceId(provider) : '';
  if (!service) return fallback;
  const catalog = opencodeCatalog(provider ? [opencodeHomeDir(provider)] : []);
  const models = new Set(Object.keys(catalog[service]?.models || {}).map((id) => `${service}/${id}`));
  // Always offered: a stale or missing cache would otherwise drop it and the turn would quietly
  // run on another model, which could never refresh the cache.
  models.add(opencodeModelRef(provider));
  return [...models].sort();
}

function opencodeModelRef(provider) {
  return provider.defaultModel || (provider.models || [])[0] || BINARIES.opencode.defaultModel();
}

// The entry's own cache dir first (its runs fill it), then the machine's.
function opencodeCatalog(roots = []) {
  for (const dir of [...roots.map((r) => path.join(r, 'cache')), xdgDir('XDG_CACHE_HOME', '.cache')]) {
    try {
      return JSON.parse(fs.readFileSync(path.join(dir, 'opencode', 'models.json'), 'utf8'));
    } catch {
      /* no cache here: the next dir, or an empty catalog */
    }
  }
  return {};
}

// Shared by every binary's review turn: no repeated feedback, and the summary comment's shape.
// The verify step exists because a review told to find problems finds some whether real or not;
// it must run before posting. Never infer verification from effort: review commands can skip it.
function reviewInstructions(prNumber) {
  return [
    REVIEW_VERIFY_STEP,
    '',
    `Before reviewing, read the feedback the ${prNumber ? `pull request #${prNumber}` : 'pull request for this branch'} already carries: its description, its issue comments, and every existing review with its inline comments (gh pr view and the /repos/:owner/:repo/pulls/:number/comments and /reviews endpoints via gh api). Take it into account: do not repeat a finding that has already been raised, even in different words, and do not re-raise one that a later commit already fixed or that a maintainer answered or declined. Only report findings that are new. If a prior finding is still unfixed and worth restating, say so explicitly as a follow-up on that thread rather than as a fresh finding. If nothing new remains, post the summary comment saying so and post no inline comments. That feedback decides what you report, not what you review: every review covers the whole base-to-head diff, including code an earlier round already reviewed, not just the commits since the last review.`,
    '',
    'If the pull request carries a comment containing `<!-- reviewer:required-fixes -->`, check every unchecked item in it against the current code: when the branch now genuinely fixes an item, edit that comment (gh api repos/:owner/:repo/issues/comments/:id -X PATCH) to tick its checkbox from `- [ ]` to `- [x]`, changing nothing else. Never untick an item and never add or remove items; the dashboard owns that list.',
    '',
    'Use this format to post a main comment before posting the inline comments:',
    '',
    '## Code Review',
    '',
    'Summary of what the PR does, less than 2 short concise sentences.',
    '',
    '1 critical, 1 high, 1 medium, 1 low findings.',
    '',
    '<details>',
    '<summary>🔵 Low findings</summary>',
    '',
    '* Low finding 1',
    '* Low finding 2',
    '',
    '</details>',
    '',
    'Give every finding, inline comments included, an explicit severity: critical, high, medium or low.',
    '',
    'When feedback should not be fixed, add a visible `### Not fixed` section to this PR summary before the findings block. Cover confirmed optional findings and existing PR feedback assessed in this review that should not be acted on; for each, link the original comment when available (otherwise identify the finding and file/line), state the decision, and give the concrete verification or cost/risk reason. A private verifier response or the hidden findings JSON is not a PR note. If an earlier PR note already records the same decision and reason, link it instead of repeating it. Omit the section when nothing qualifies.',
    'Keep rejected or unverified feedback in these explanatory notes only, clearly identified as such, outside the finding counts, inline findings and reviewer:findings block; do not present it as a confirmed defect. Confirmed optional findings still belong in the findings block with worthFixing: false. A Not fixed note must not request changes, trigger a fix loop, or tick an unchecked required-fixes item as completed.',
    '',
    'End the summary comment with this machine-readable block (an HTML comment, invisible on GitHub) listing every finding this review reports, the low ones included:',
    '',
    '<!-- reviewer:findings',
    '[',
    '  {"severity": "critical", "title": "One-line finding title, max 120 chars", "file": "path/to/file.php", "line": 123, "assessment": {"verified": true, "evidence": "Concrete reachable failure with source references or reproduction", "worthFixing": true, "reason": "Benefit outweighs implementation effort and regression risk"}}',
    ']',
    '-->',
    '',
    'The block must be valid JSON: severity is one of critical/high/medium/low, file and line may be empty/null when a finding has no single location, and the title must match the finding as posted: the dashboard keys on it. Use an empty array when there are no new findings.',
    "Every published finding must include the independent verifier's assessment: verified must be true, evidence and reason must be non-empty strings, and worthFixing must be a boolean. Include confirmed optional findings with worthFixing: false and clearly label them optional in the summary and inline comments; they must not block approval or start a fix loop. Do not publish unverified findings in the findings block. If verification cannot run, post a summary comment containing `<!-- reviewer:incomplete -->` and the reason, without a findings block; do not declare it clean.",
    '',
    'Post that comment with `gh pr comment <number> --body-file <file>` (or `--body` with the text inline). Never pass `@<file>` as the body: gh has no @file expansion, so the path lands on the PR verbatim instead of the review.',
  ].join('\n');
}

const REVIEW_VERIFY_STEP = [
  'Before posting anything (the summary comment, inline comments or the findings block), verify your findings and assess whether each fix is worth doing. Discovery agents must return candidates privately and must not post to GitHub. There is no minimum finding count; a clean review is a valid outcome.',
  "Spawn a fresh independent verification sub-agent using the session's configured model and effort, without model overrides. Give it the candidate claims, the PR number and exact reviewed commit, and access to the code and prior PR discussions, not your reasoning. For each candidate, one at a time, it must:",
  '- Confirm a reachable defect on that exact commit by tracing concrete inputs or state to an incorrect result, or by reproduction; cite source locations and evidence. Discard unproven claims, preferences, duplicates, already addressed or declined feedback, and defects not introduced or exposed by this PR.',
  '- Correct the severity independently. Assess user impact, likelihood, scope, implementation effort, regression risk and whether the proposed remedy addresses the root cause. Mark worthFixing true only when the benefit outweighs the cost and risk within this PR; mark marginal cleanup, speculative hardening and disproportionate refactors optional. Low severity alone does not make a demonstrated defect optional.',
  '- Return discard with a concrete reason and the original PR comment reference when available, or an assessment with verified: true, concrete evidence, worthFixing: true/false and a concise reason. When applicability is uncertain, discard; when value is uncertain, mark optional. Retain these reasons so the reviewer can explain existing PR feedback that should not be fixed in the visible Not fixed notes.',
  'Wait for the verifier before publishing. Post only confirmed findings with their assessments. If an independent verifier cannot run, post only a verification incomplete report with `<!-- reviewer:incomplete -->`, then stop; do not substitute your own first-pass judgment, approve, or declare the review clean.',
].join('\n');

// Recall for plain-prompt review turns. A reviewer that has read prior rounds reviews only the
// delta and calls the rest settled, so discovery runs in a fresh agent over the whole diff, angle
// by angle, passing on every nameable failure; precision is the verifier's job.
const REVIEW_DISCOVERY_STEP = [
  "Find candidates first. Spawn a fresh discovery sub-agent using the session's configured model and effort, without model overrides. Give it the PR number, the base branch and the exact head commit, not the prior PR discussion or your own reasoning. Its scope is the whole base-to-head diff, plus the unchanged lines of every function the diff touches. It must work through each angle in turn:",
  '- Line by line: every hunk and its enclosing function; for each line, what input, state, timing or failure makes it wrong.',
  '- Removed behavior: for every deleted or replaced line, the invariant it enforced and where the new code re-establishes it.',
  '- Callers and callees: every call site of a changed function, for new or swallowed exceptions, changed return values, retries, ordering and concurrent runs.',
  '- Failure paths: what happens when each external call, query or job fails, times out or partly succeeds, and whether a retry repeats a side effect.',
  "- Conventions: rules in the repository's CLAUDE.md or AGENTS.md files that a changed line clearly breaks, quoting the rule.",
  '- Altitude: whether the change fixes the root cause or patches one symptom of a shared mechanism.',
  'It returns every candidate it can name a concrete failure for (file, line, summary, the inputs or state and the wrong result) privately: it does not weigh them against earlier feedback, drop half-believed ones, or post anything. Add any candidates of your own, then send them all through the verification below.',
].join('\n');

const claudeBinary = {
  id: 'claude',
  label: 'Claude Code',
  efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
  defaultEffort: (cfg) => cfg.claudeEffort,
  models: () => [
    'claude-fable-5-1',
    'claude-opus-5-5',
    'claude-opus-5',
    'claude-sonnet-5',
    'claude-haiku-4-5',
  ],
  defaultModel: (cfg) => cfg.claudeModel,
  bin: (cfg) => (cfg.claudeBin ? { bin: cfg.claudeBin, source: cfg.claudeBinSource } : null),
  // Own the workflow: the built-in /code-review high command forbids a verify
  // pass and can publish candidates before our instructions are applied.
  reviewPrompt: ({ prNumber, effort }) =>
    [
      `Review ${prNumber ? `pull request #${prNumber}` : 'the pull request for this branch'} at ${effort} effort. Read its actual base-to-head diff and enclosing code, trace callers and removed behavior, and check correctness, security, tests and performance. Do not invoke /code-review or another review command that skips verification or publishes candidates automatically.`,
      '',
      REVIEW_DISCOVERY_STEP,
      '',
      reviewInstructions(prNumber),
    ].join('\n'),
  // The system prompt travels on a proper flag; the prompt itself over stdin.
  buildArgs: ({ model, effort, resume, sessionId, sysPromptFile, mcpConfigFile }) => ({
    args: [
      '-p',
      '--model',
      model,
      '--effort',
      effort,
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      // Echoes let runDevTurn tell a read message from one still waiting.
      '--replay-user-messages',
      '--verbose',
      // Not auto: its remote Bash classifier stalls every turn during an outage. The checkout is
      // disposable and headless has nobody to answer a prompt.
      '--permission-mode',
      'bypassPermissions',
      ...(sysPromptFile ? ['--append-system-prompt-file', sysPromptFile] : []),
      // A per-turn MCP config, since the token in it is per turn.
      ...(mcpConfigFile ? ['--mcp-config', mcpConfigFile] : []),
      ...(resume ? ['--resume', sessionId] : ['--session-id', sessionId]),
    ],
    // stdin stays open so the next message can reach a process still running sub-agents or a
    // Monitor (see runDevTurn).
    promptVia: 'stream-json',
    briefingInPrompt: false,
  }),
};

// One user message on the CLI's stream-json input.
export function claudeInputMessage(text) {
  return JSON.stringify({ type: 'user', message: { role: 'user', content: text } }) + '\n';
}

// MCP servers as -c TOML overrides (inline table for env, JSON array for args), per turn rather
// than in config.toml because the env token is the turn's own. A bare object is a list of one.
function codexMcpArgs(servers) {
  const list = Array.isArray(servers) ? servers : servers ? [servers] : [];
  const table = (obj) =>
    Object.entries(obj || {})
      .map(([k, v]) => `${JSON.stringify(k)} = ${JSON.stringify(v)}`)
      .join(', ');
  return list.flatMap((mcp) => {
    const key = `mcp_servers.${mcp.name}`;
    // A remote server (the proxy for one of the operator's) by its URL.
    if (mcp.url) {
      const headers = table(mcp.headers);
      return [
        '-c',
        `${key}.url=${JSON.stringify(mcp.url)}`,
        ...(headers ? ['-c', `${key}.http_headers={ ${headers} }`] : []),
      ];
    }
    const env = Object.entries(mcp.env || {})
      .map(([k, v]) => `${k} = ${JSON.stringify(v)}`)
      .join(', ');
    return [
      '-c',
      `${key}.command=${JSON.stringify(mcp.command)}`,
      '-c',
      `${key}.args=${JSON.stringify(mcp.args || [])}`,
      ...(env ? ['-c', `${key}.env={ ${env} }`] : []),
    ];
  });
}

// Codex keeps 5% as headroom, so a turn asked for 872000 reports and compacts at 828400.
function codexWindowArgs(contextWindow) {
  return contextWindow ? ['-c', `model_context_window=${contextWindow}`] : [];
}

const codexBinary = {
  id: 'codex',
  label: 'Codex',
  efforts: CODEX_EFFORTS,
  effortsForModel: codexEffortsForModel,
  defaultEffort: () => 'high',
  models: codexModels,
  defaultModel: () => CODEX_DEFAULT_MODELS[0],
  defaultModels: codexDefaultModels,
  bin: (cfg) => findCodexBin(cfg.codexBin),
  // Reviews run as ordinary exec turns so they can delegate discovery and verification.
  // The prompt supplies the diff scope and publication contract.
  reviewPrompt: ({ branch, base, prNumber }) =>
    [
      `Review the changes branch ${branch} introduces relative to ${base || "the repository's default branch"}.`,
      '',
      REVIEW_DISCOVERY_STEP,
      '',
      reviewInstructions(prNumber),
    ].join('\n'),
  // Native `exec review` disables multi-agent tools (observed in 0.160.0), so it cannot run the
  // verifier; a fresh exec thread with delegation enabled is used instead.
  buildReviewArgs: (opts) => {
    const built = codexBinary.buildArgs({ ...opts, resume: opts.resumeReview && opts.resume });
    return {
      ...built,
      args: [...built.args.slice(0, -1), '--enable', 'multi_agent', '-'],
    };
  },
  // No append-system-prompt flag, so the briefing rides in the first message.
  buildArgs: ({ model, effort, resume, sessionId, mcp }) => {
    const { slug, contextWindow } = splitCodexModel(model);
    return {
      args: [
        'exec',
        ...(resume ? ['resume', sessionId] : []),
        '--json',
        '-m',
        slug,
        '-c',
        `model_reasoning_effort="${effort}"`,
        ...codexWindowArgs(contextWindow),
        ...codexMcpArgs(mcp),
        '--dangerously-bypass-approvals-and-sandbox',
        '-',
      ],
      promptVia: 'stdin',
      briefingInPrompt: true,
    };
  },
};

export const BINARIES = {
  claude: claudeBinary,
  codex: codexBinary,
  grok: {
    id: 'grok',
    label: 'Grok',
    efforts: ['low', 'medium', 'high'],
    defaultEffort: () => 'high',
    models: () => ['grok-4.6', 'grok-4.5'],
    defaultModel: () => 'grok-4.6',
    bin: (cfg) => findGrokBin(cfg.grokBin),
    // /review as a chat turn rather than `grok -p`, so it carries the shared instructions and
    // leaves a thread the publish turn resumes.
    reviewPrompt: ({ prNumber }) => ['/review --local', '', reviewInstructions(prNumber)].join('\n'),
    // Prompt from a file: argv survives neither newlines nor long messages.
    buildArgs: ({ model, effort, resume, sessionId, promptFile }) => ({
      args: [
        '--prompt-file',
        promptFile,
        '--output-format',
        'streaming-messages-json',
        '--permission-mode',
        'bypassPermissions',
        '--always-approve',
        '--model',
        model,
        '--reasoning-effort',
        effort,
        ...(resume ? ['--resume', sessionId] : ['--session-id', sessionId]),
      ],
      promptVia: 'file',
      briefingInPrompt: true,
    }),
  },
  opencode: {
    id: 'opencode',
    label: 'opencode',
    // opencode "variants", derived per model; a model lacking one runs on its default reasoning.
    efforts: ['low', 'medium', 'high', 'max'],
    defaultEffort: () => 'high',
    models: opencodeModels,
    defaultModel: () => 'anthropic/claude-sonnet-4-5',
    bin: (cfg) => findOpencodeBin(cfg.opencodeBin),
    resumable: opencodeResumable,
    // No review command, so an ordinary turn shaped like codex's.
    reviewPrompt: ({ branch, base, prNumber }) =>
      [
        `Review the changes branch ${branch} introduces relative to ${base || "the repository's default branch"}.`,
        '',
        REVIEW_DISCOVERY_STEP,
        '',
        reviewInstructions(prNumber),
      ].join('\n'),
    // Prompt over stdin (argv survives neither newlines nor long messages) with the briefing in
    // it, as there is no system-prompt flag. Only an id opencode issued (`ses_…`) can resume.
    buildArgs: ({ model, effort, resume, sessionId }) => ({
      args: [
        'run',
        '--format',
        'json',
        '--model',
        model,
        '--variant',
        effort,
        // Without it, headless runs reject every permission prompt.
        '--auto',
        ...(resume && opencodeResumable(sessionId) ? ['--session', sessionId] : []),
      ],
      promptVia: 'stdin',
      briefingInPrompt: true,
    }),
  },
};

export function getBinary(id) {
  return BINARIES[id] || null;
}

// Only opencode's own ids name its conversations; the creation UUID never does.
function opencodeResumable(sessionId) {
  return String(sessionId || '').startsWith('ses_');
}

// Also decides the workspace briefing: a turn that cannot resume starts a fresh conversation.
export function canResume(binaryId, sessionId) {
  const binary = getBinary(binaryId);
  return binary && binary.resumable ? binary.resumable(sessionId) : !!sessionId;
}

// Metadata for models codex's cache lacks; GLM entries mirror docs.z.ai/devpack/tool/codex.
const KNOWN_CODEX_MODELS = {
  'glm-5.3': { description: "Z.ai's latest flagship model", context_window: 1048576 },
  'glm-5-turbo': { description: 'Agent-optimized model', context_window: 204800, efforts: [] },
};

const EFFORT_DESCRIPTIONS = {
  low: 'Light reasoning',
  medium: 'Standard reasoning',
  high: 'Enhanced reasoning',
  xhigh: 'Extended reasoning',
  max: 'Deep reasoning',
};

// codex only offers models its catalog declares, so a provider on a custom
// endpoint has to have its model list written where the CLI will look.
function codexCatalogEntry(slug, priority, efforts) {
  const known = KNOWN_CODEX_MODELS[slug] || {};
  const levels = known.efforts ?? efforts;
  return {
    slug,
    display_name: slug,
    description: known.description || slug,
    default_reasoning_level: 'max',
    supported_reasoning_levels: levels.map((effort) => ({
      effort,
      description: EFFORT_DESCRIPTIONS[effort] || effort,
    })),
    shell_type: 'shell_command',
    visibility: 'list',
    supported_in_api: true,
    priority,
    base_instructions: '',
    supports_reasoning_summaries: true,
    default_reasoning_summary: 'none',
    support_verbosity: false,
    apply_patch_tool_type: 'freeform',
    truncation_policy: { mode: 'bytes', limit: 10000 },
    context_window: known.context_window || 262144,
    max_context_window: known.context_window || 262144,
    effective_context_window_percent: 95,
    supports_parallel_tool_calls: true,
    experimental_supported_tools: [],
    input_modalities: ['text'],
  };
}

// Each claude entry gets its own CLAUDE_CONFIG_DIR, never ~/.claude. The login is mirrored into
// the row (readClaudeAuth → auth_data): the database carries the account, the dir is a cache.
export function claudeHomeDir(provider) {
  const home = os.homedir();
  return path.join(home, `.claude-provider-${provider.id}`);
}

export function ensureClaudeHome(provider) {
  const dir = claudeHomeDir(provider);
  fs.mkdirSync(dir, { recursive: true });
  const auth = provider.authData;
  if (auth && auth.credentials) {
    const credFile = path.join(dir, '.credentials.json');
    if (!fs.existsSync(credFile)) {
      fs.writeFileSync(credFile, JSON.stringify(auth.credentials, null, 2), 'utf8');
    }
  }
  if (auth && auth.settings) {
    const settingsFile = path.join(dir, '.claude.json');
    if (!fs.existsSync(settingsFile)) {
      fs.writeFileSync(settingsFile, JSON.stringify(auth.settings, null, 2), 'utf8');
    }
  }
  return dir;
}

// OAuth credentials plus the .claude.json bits that identify the login and skip re-onboarding.
// Null while the dir holds no login.
export function readClaudeAuth(dir) {
  try {
    const credentials = JSON.parse(fs.readFileSync(path.join(dir, '.credentials.json'), 'utf8'));
    let settings = null;
    try {
      const j = JSON.parse(fs.readFileSync(path.join(dir, '.claude.json'), 'utf8'));
      settings = {
        ...(j.oauthAccount ? { oauthAccount: j.oauthAccount } : {}),
        ...(j.userID ? { userID: j.userID } : {}),
        hasCompletedOnboarding: j.hasCompletedOnboarding ?? true,
      };
    } catch {
      /* the credentials alone still log the CLI in */
    }
    return { credentials, settings };
  } catch {
    return null;
  }
}

// auth.json is the login; null while the dir holds none.
export function readCodexAuth(dir) {
  try {
    return { auth: JSON.parse(fs.readFileSync(path.join(dir, 'auth.json'), 'utf8')) };
  } catch {
    return null;
  }
}

// The CLI's own claude.ai OAuth client, driven without a terminal: start() returns a PKCE URL,
// finish() exchanges the pasted code and writes tokens as `claude /login` would.
const CLAUDE_OAUTH = {
  clientId: '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
  authorizeUrl: 'https://claude.ai/oauth/authorize',
  tokenUrl: 'https://console.anthropic.com/v1/oauth/token',
  redirectUri: 'https://console.anthropic.com/oauth/code/callback',
  scopes: 'org:create_api_key user:profile user:inference',
};

export function claudeLoginStart() {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const url = new URL(CLAUDE_OAUTH.authorizeUrl);
  url.searchParams.set('code', 'true');
  url.searchParams.set('client_id', CLAUDE_OAUTH.clientId);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', CLAUDE_OAUTH.redirectUri);
  url.searchParams.set('scope', CLAUDE_OAUTH.scopes);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('state', verifier);
  return { url: url.toString(), verifier };
}

export async function claudeLoginFinish(provider, pasted, verifier) {
  // The callback page shows the code as code#state.
  const [code, state] = String(pasted).trim().split('#');
  if (!code) throw new Error('That is not a login code; copy the whole code claude.ai shows after approving');
  const res = await fetch(CLAUDE_OAUTH.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      code,
      state: state || verifier,
      client_id: CLAUDE_OAUTH.clientId,
      redirect_uri: CLAUDE_OAUTH.redirectUri,
      code_verifier: verifier,
    }),
  });
  if (!res.ok) {
    throw new Error(`claude.ai did not accept the code (${res.status}): ${truncate(await res.text(), 200)}`);
  }
  const t = await res.json();
  const dir = ensureClaudeHome(provider);
  const credentials = {
    claudeAiOauth: {
      accessToken: t.access_token,
      refreshToken: t.refresh_token,
      expiresAt: Date.now() + (Number(t.expires_in) || 0) * 1000,
      scopes: t.scope ? String(t.scope).split(' ') : CLAUDE_OAUTH.scopes.split(' '),
      subscriptionType: t.subscription_type ?? null,
    },
  };
  fs.writeFileSync(path.join(dir, '.credentials.json'), JSON.stringify(credentials, null, 2), 'utf8');
  // Enough of .claude.json for the CLI to know the account and skip onboarding.
  const settingsFile = path.join(dir, '.claude.json');
  let j = {};
  try {
    j = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  } catch {
    /* fresh dir */
  }
  if (t.account) {
    j.oauthAccount = {
      accountUuid: t.account.uuid ?? '',
      emailAddress: t.account.email_address ?? '',
      organizationUuid: t.organization?.uuid ?? '',
      organizationName: t.organization?.name ?? '',
    };
  }
  j.hasCompletedOnboarding = true;
  fs.writeFileSync(settingsFile, JSON.stringify(j, null, 2), 'utf8');
}

// A CODEX_HOME per entry, so the developer's ~/.codex login is never touched.
export function codexHomeDir(provider, home = os.homedir()) {
  return path.join(home, `.codex-provider-${provider.id}`);
}

// A login entry restores auth.json from the row (the database is the source, the dir a cache). A
// custom-endpoint entry gets a config.toml rewritten every turn, so the key never rides on argv.
// `turnModel` matters because the review flow reads `review_model` from config, not `-m`;
// callers without a turn get the entry's default.
export function ensureCodexHome(provider, turnModel = '') {
  const home = codexHomeDir(provider);
  fs.mkdirSync(home, { recursive: true });
  if (!provider.baseUrl && !provider.apiKey) {
    const authFile = path.join(home, 'auth.json');
    if (provider.authData && provider.authData.auth && !fs.existsSync(authFile)) {
      fs.writeFileSync(authFile, JSON.stringify(provider.authData.auth, null, 2), 'utf8');
    }
    // A leftover endpoint config.toml would override the login with a dead endpoint.
    for (const f of ['config.toml', 'models.json']) fs.rmSync(path.join(home, f), { force: true });
    return home;
  }
  // Catalog and `review_model` want the real slug (the window travels as buildArgs' `-c`), so a
  // hand-typed wide twin cannot write a slug codex would refuse.
  const models = [...new Set(provider.models.map((m) => splitCodexModel(m).slug))];
  const efforts = provider.efforts.length ? provider.efforts : codexBinary.efforts;
  // Codex refuses models outside the catalog, so a stale pick falls back to the default.
  const turnSlug = splitCodexModel(turnModel).slug;
  const picked = turnSlug && (!models.length || models.includes(turnSlug)) ? turnSlug : '';
  const model = picked || codexEndpointDefaultModel(provider);
  const lines = [
    'model_provider = "custom"',
    // JSON.stringify doubles as a TOML basic-string encoder (quotes + escapes).
    `model = ${JSON.stringify(model)}`,
    `review_model = ${JSON.stringify(model)}`,
  ];
  if (models.length) {
    const catalogFile = path.join(home, 'models.json');
    const catalog = { models: models.map((slug, i) => codexCatalogEntry(slug, i, efforts)) };
    fs.writeFileSync(catalogFile, JSON.stringify(catalog, null, 2), 'utf8');
    lines.push(`model_catalog_json = ${JSON.stringify(catalogFile.replace(/\\/g, '/'))}`);
  }
  lines.push(
    '',
    '[model_providers.custom]',
    `name = ${JSON.stringify(provider.label)}`,
    `base_url = ${JSON.stringify(provider.baseUrl)}`,
    `experimental_bearer_token = ${JSON.stringify(provider.apiKey)}`,
    'wire_api = "responses"',
    '',
  );
  fs.writeFileSync(path.join(home, 'config.toml'), lines.join('\n'), 'utf8');
  return home;
}

// A GROK_HOME per entry, mirrored into the row like codex's (readGrokAuth → auth_data).
export function grokHomeDir(provider) {
  const home = os.homedir();
  return path.join(home, `.grok-provider-${provider.id}`);
}

export function ensureGrokHome(provider) {
  const dir = grokHomeDir(provider);
  fs.mkdirSync(dir, { recursive: true });
  const authFile = path.join(dir, 'auth.json');
  if (provider.authData && provider.authData.auth && !fs.existsSync(authFile)) {
    fs.writeFileSync(authFile, JSON.stringify(provider.authData.auth, null, 2), 'utf8');
  }
  return dir;
}

// auth.json is the login; null while the dir holds none.
export function readGrokAuth(dir) {
  try {
    return { auth: JSON.parse(fs.readFileSync(path.join(dir, 'auth.json'), 'utf8')) };
  } catch {
    return null;
  }
}

// opencode has no home variable, so each entry gets its own XDG root, keeping entries from
// sharing a session store or touching the developer's ~/.local/share/opencode.
export function opencodeHomeDir(provider) {
  return path.join(os.homedir(), `.opencode-provider-${provider.id}`);
}

export function opencodeXdgEnv(dir) {
  return {
    XDG_DATA_HOME: path.join(dir, 'data'),
    XDG_CONFIG_HOME: path.join(dir, 'config'),
    XDG_STATE_HOME: path.join(dir, 'state'),
    XDG_CACHE_HOME: path.join(dir, 'cache'),
  };
}

function xdgDir(variable, fallback) {
  return process.env[variable] || path.join(os.homedir(), ...fallback.split('/'));
}

// Directories only: key and endpoint travel in the environment each turn.
export function ensureOpencodeHome(provider) {
  const dir = opencodeHomeDir(provider);
  fs.mkdirSync(path.join(dir, 'data', 'opencode'), { recursive: true });
  return dir;
}

// Credentials are keyed by the `<service>` of `<service>/<model>`. The turn's model decides, not
// the entry's default, since a step can switch models and a misfiled key authenticates nothing.
export function opencodeServiceId(provider, model = '') {
  const ref = model || opencodeModelRef(provider);
  return ref.includes('/') ? ref.split('/')[0] : '';
}

// OPENCODE_AUTH_CONTENT replaces the credential file, so the API key never lands on disk. Null
// without a key or a service to file it under.
export function opencodeAuthContent(provider, model = '') {
  const service = opencodeServiceId(provider, model);
  if (!service || !provider.apiKey) return null;
  return JSON.stringify({ [service]: { type: 'api', key: provider.apiKey } });
}

// The endpoint as a layered OPENCODE_CONFIG_CONTENT, filed under the turn's service like the key.
// Null without an endpoint or a service.
export function opencodeConfigContent(provider, model = '') {
  const service = opencodeServiceId(provider, model);
  if (!service || !provider.baseUrl) return null;
  return JSON.stringify({ provider: { [service]: { options: { baseURL: provider.baseUrl } } } });
}

// ---------- stream parsing ----------
// Stateful per-turn parsers: feed(line) returns normalized events ({kind, ...}) plus optional
// side-channel fields for the caller (sessionId, costUsd...).

function truncate(s, n) {
  const str = String(s ?? '');
  return str.length > n ? str.slice(0, n) + '…' : str;
}

function summarizeToolInput(name, input) {
  if (!input) return '';
  if (typeof input.command === 'string') return truncate(input.command, 200);
  if (typeof input.description === 'string' && SUBAGENT_TOOLS.has(name))
    return truncate(input.description, 200);
  if (typeof input.prompt === 'string') return truncate(input.prompt, 200);
  if (typeof input.file_path === 'string') return input.file_path;
  if (typeof input.pattern === 'string') return input.pattern;
  const s = JSON.stringify(input);
  return truncate(s, 200);
}

// Turn-wide usage from a result message (claude, and grok when it emits it), cache traffic
// included, plus the context window from modelUsage.
function readResultUsage(turn, msg) {
  const u = msg.usage;
  if (
    u &&
    (u.input_tokens || u.cache_read_input_tokens || u.cache_creation_input_tokens || u.output_tokens)
  ) {
    turn.inputTokens =
      (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
    turn.outputTokens = u.output_tokens || 0;
  }
  for (const m of Object.values(msg.modelUsage || {})) {
    if (m && m.contextWindow) turn.contextWindow = Math.max(turn.contextWindow || 0, m.contextWindow);
  }
}

// Headless, nobody can answer AskUserQuestion in the CLI, so it becomes the same `ask` event the
// <ask-user> block produces, asked in the dashboard.
function askEvents(input) {
  const questions = input && Array.isArray(input.questions) ? input.questions : [];
  return questions
    .filter((q) => q && q.question)
    .map((q) => ({
      kind: 'ask',
      question: String(q.question),
      header: q.header ? String(q.header) : '',
      multiSelect: !!q.multiSelect,
      options: (Array.isArray(q.options) ? q.options : [])
        .filter((o) => o && o.label)
        .map((o) => ({ label: String(o.label), description: o.description ? String(o.description) : '' })),
    }));
}

// The agent tool (`Agent` in current Claude Code, `Task` in older CLIs and grok). Its call and
// tool_result become `agent` start/end events so the dashboard can show live sub-agents.
const SUBAGENT_TOOLS = new Set(['Agent', 'Task']);

// A backgrounded agent's tool_result only says it launched; it stays live until its
// <task-notification> arrives.
const LAUNCHED_IN_BACKGROUND = /async agent launched|working in the background/i;

function subagentStart(live, block) {
  if (!SUBAGENT_TOOLS.has(block.name) || !block.id) return null;
  const input = block.input || {};
  live.add(block.id);
  return {
    kind: 'agent',
    state: 'start',
    id: block.id,
    name: String(input.subagent_type || 'agent'),
    summary: truncate(input.description || input.prompt || '', 120),
  };
}

function blockText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((c) => c.text || '').join(' ');
  return '';
}

function subagentEnd(live, block) {
  const id = block.tool_use_id;
  if (!id || !live.has(id)) return null;
  if (LAUNCHED_IN_BACKGROUND.test(blockText(block.content))) return null;
  live.delete(id);
  return { kind: 'agent', state: 'end', id };
}

// A backgrounded sub-agent ends with a plain-text user message naming its tool call.
function subagentNotified(live, content) {
  const text = typeof content === 'string' ? content : '';
  if (!text.includes('<task-notification')) return [];
  const out = [];
  for (const m of text.matchAll(/<tool-use-id>([^<]+)<\/tool-use-id>/g)) {
    const id = m[1].trim();
    if (live.delete(id)) out.push({ kind: 'agent', state: 'end', id });
  }
  return out;
}

// Background work a claude process waits for before exiting. Background Bash is excluded: print
// mode kills it after the last answer, and a dev server must not hold the turn open for good.
const KEEPALIVE_TOOLS = new Set(['Agent', 'Task', 'Monitor']);

// A turn that dies mid-Task would leave its sub-agents "running" forever.
function subagentFlush(live) {
  const out = [...live].map((id) => ({ kind: 'agent', state: 'end', id }));
  live.clear();
  return out;
}

function claudeParser(turn) {
  const live = new Set(); // tool_use ids of agent calls still running
  // Kept only until the CLI says whether it backgrounded: a process can make thousands.
  const calls = new Map(); // tool_use id -> what a keep-alive call is doing
  const background = new Map(); // task id -> the same, while it works
  // Every answer opens with an init. A message's answer has its echo before the first main-thread
  // word; a wake-up (finished task, Monitor event) or local command (/context) has none.
  let started = false;
  let answer = null; // { echoed, spoke, local } for the answer the latest init opened
  // A process can answer several times. Results report per-answer tokens and time but a running
  // cost total; the turn keeps process totals, and each answer's footer shows its own share.
  const spent = { input: 0, output: 0, ms: 0, cost: 0 };
  // That running total is the conversation's, not the process's: a resumed
  // one starts from what the conversation had spent before (the caller reads
  // it into turn.costBaseline), and that part is no answer's here. Whether
  // the CLI restored it is decided on the first price, which is below it when
  // nothing was: a later total must not cross it and be cut back again.
  let baseline = turn.costBaseline || 0;
  // `ended` names the tasks that just left the list.
  const backgroundEvent = (ended = []) => ({ kind: 'background', tasks: [...background.values()], ended });
  return {
    feed(msg) {
      const out = [];
      if (msg.type === 'system' && msg.task_id) {
        const had = background.size;
        // Only backgrounded tasks: counting a foreground call would hold stdin open after the
        // last answer.
        if (msg.subtype === 'task_started' && calls.has(msg.tool_use_id)) {
          if (msg.is_backgrounded === true) background.set(msg.task_id, calls.get(msg.tool_use_id));
          calls.delete(msg.tool_use_id);
        } else if (msg.subtype === 'task_notification') {
          background.delete(msg.task_id);
          if (msg.tool_use_id && live.delete(msg.tool_use_id)) {
            out.push({ kind: 'agent', state: 'end', id: msg.tool_use_id });
          }
        }
        if (background.size !== had) out.push(backgroundEvent(background.size < had ? [msg.task_id] : []));
        // A TaskStop'd task wakes nobody (CLI 2.1.281 reports "stopped" and starts no answer).
        // Emitted after the drop that took it off the list.
        if (msg.subtype === 'task_notification' && msg.status === 'stopped') {
          out.push({ kind: 'task_settled', id: msg.task_id });
        }
        return out;
      }
      // The CLI's own list of what is still working is the last word.
      if (msg.type === 'system' && msg.subtype === 'background_tasks_changed' && Array.isArray(msg.tasks)) {
        const ids = new Set(msg.tasks.map((t) => t && t.task_id));
        const ended = [...background.keys()].filter((id) => !ids.has(id));
        for (const id of ended) background.delete(id);
        if (ended.length) out.push(backgroundEvent(ended));
        return out;
      }
      // A stdin message's echo: read into the answer under way or opening the next; several read
      // at once share one. A task notification read mid-tool is echoed too, but is no message's
      // echo and no wake-up follows it.
      if (msg.type === 'user' && msg.isReplay) {
        const content = msg.message && msg.message.content;
        let text = typeof content === 'string' ? content : null;
        if (text && text.includes('<task-notification>')) {
          const notesRe = /<task-notification>[\s\S]*?<\/task-notification>/g;
          for (const note of text.match(notesRe) || []) {
            const id = note.match(/<task-id>([^<]+)<\/task-id>/);
            if (id) out.push({ kind: 'task_settled', id: id[1].trim() });
          }
          text = text.replace(notesRe, '').trim();
          if (!text) return out;
        }
        const opens = !answer || !answer.spoke;
        if (answer && opens) answer.echoed = true;
        out.push({ kind: 'ack', text, opens });
        return out;
      }
      // A notification can also arrive as a bare queued line.
      if (typeof msg.content === 'string') out.push(...subagentNotified(live, msg.content));
      if (msg.type === 'system' && msg.subtype === 'init') {
        if (msg.session_id) turn.sessionId = msg.session_id;
        // A live process sends one for every answer, not only at its start.
        if (!started) out.push({ kind: 'info', text: `Claude session started: model ${msg.model}` });
        started = true;
        answer = { echoed: false, spoke: false, local: false };
        out.push({ kind: 'init' });
      } else if (msg.type === 'assistant' && msg.message && Array.isArray(msg.message.content)) {
        if (answer && !answer.spoke && !msg.parent_tool_use_id) {
          answer.spoke = true;
          answer.local = msg.message.model === '<synthetic>';
        }
        // Per-request tokens, cache reads included, sum to the live context size.
        const u = msg.message.usage;
        if (u) {
          turn.contextTokens =
            (u.input_tokens || 0) +
            (u.cache_read_input_tokens || 0) +
            (u.cache_creation_input_tokens || 0) +
            (u.output_tokens || 0);
        }
        for (const block of msg.message.content) {
          if (block.type === 'text' && block.text && block.text.trim()) {
            out.push({ kind: 'text', text: block.text });
          } else if (block.type === 'tool_use' && block.name === 'AskUserQuestion') {
            const asks = askEvents(block.input);
            // A malformed call still belongs in the log as the step it was.
            if (asks.length) out.push(...asks);
            else
              out.push({
                kind: 'tool',
                name: block.name,
                summary: summarizeToolInput(block.name, block.input),
              });
          } else if (block.type === 'tool_use') {
            out.push({
              kind: 'tool',
              name: block.name,
              summary: summarizeToolInput(block.name, block.input),
            });
            if (KEEPALIVE_TOOLS.has(block.name) && block.id) {
              const input = block.input || {};
              calls.set(block.id, {
                name: block.name === 'Monitor' ? 'Monitor' : String(input.subagent_type || 'agent'),
                summary: truncate(input.description || input.prompt || input.command || '', 120),
              });
            }
            const agentStart = subagentStart(live, block);
            if (agentStart) out.push(agentStart);
          }
        }
      } else if (msg.type === 'user' && msg.message && typeof msg.message.content === 'string') {
        out.push(...subagentNotified(live, msg.message.content));
      } else if (msg.type === 'user' && msg.message && Array.isArray(msg.message.content)) {
        for (const block of msg.message.content) {
          if (block.type === 'text') {
            out.push(...subagentNotified(live, block.text));
            continue;
          }
          if (block.type !== 'tool_result') continue;
          calls.delete(block.tool_use_id);
          const ended = subagentEnd(live, block);
          if (ended) out.push(ended);
          if (block.is_error) {
            const text =
              typeof block.content === 'string'
                ? block.content
                : Array.isArray(block.content)
                  ? block.content.map((c) => c.text || '').join(' ')
                  : '';
            if (text.trim()) out.push({ kind: 'tool_error', text: truncate(text, 500) });
          }
        }
      } else if (msg.type === 'result') {
        if (msg.session_id) turn.sessionId = msg.session_id;
        // A result with no price (a local command, some error results) says
        // nothing about the answers before it: the running total stands.
        if (msg.total_cost_usd != null) {
          if (turn.costUsd == null && msg.total_cost_usd < baseline) baseline = 0;
          turn.costUsd = ownClaudeCost(msg.total_cost_usd, baseline);
        }
        const part = newTurn();
        readResultUsage(part, msg);
        if (part.inputTokens != null) {
          turn.inputTokens = spent.input += part.inputTokens;
          turn.outputTokens = spent.output += part.outputTokens;
        }
        if (part.contextWindow) turn.contextWindow = Math.max(turn.contextWindow || 0, part.contextWindow);
        if (msg.duration_ms != null) turn.durationMs = spent.ms += msg.duration_ms;
        const costUsd = msg.total_cost_usd != null ? turn.costUsd - spent.cost : null;
        if (turn.costUsd != null) spent.cost = turn.costUsd;
        // An answer no message opened is a wake-up's: it answers none of them.
        if (answer && answer.spoke && !answer.echoed && !answer.local) out.push({ kind: 'wake' });
        answer = null;
        out.push({
          kind: 'result',
          subtype: msg.subtype,
          isError: !!msg.is_error,
          costUsd,
          durationMs: msg.duration_ms ?? null,
          numTurns: msg.num_turns ?? null,
          tokens: turn.contextTokens ?? null,
          inputTokens: part.inputTokens,
          outputTokens: part.outputTokens,
          text: truncate(typeof msg.result === 'string' ? msg.result : '', 4000),
        });
      }
      return out;
    },
    flush() {
      return subagentFlush(live);
    },
  };
}

// A turn's own usage from Codex's lifetime thread counters, minus the pre-turn baseline. A reset
// (counter below baseline) is decided once, from input or else output, so all counters agree. An
// `unknown` baseline books nothing, since the counters would be the thread's whole lifetime.
export function codexTurnUsage(totals, baseline) {
  const own = { inputTokens: null, outputTokens: null, cachedInputTokens: null };
  if (baseline?.unknown) return own;
  const by = totals.inputTokens != null && baseline?.inputTokens != null ? 'inputTokens' : 'outputTokens';
  const reset = baseline?.[by] == null || totals[by] == null || totals[by] < baseline[by];
  for (const field of Object.keys(own)) {
    const value = totals[field];
    own[field] =
      value == null ? null : reset || baseline[field] == null ? value : Math.max(0, value - baseline[field]);
  }
  return own;
}

// codex exec --json emits thread/turn/item events; items carry the substance.
function codexParser(turn) {
  const itemEvent = (item, done) => {
    switch (item.item_type || item.type) {
      case 'agent_message':
        return done && item.text ? { kind: 'text', text: item.text } : null;
      case 'command_execution':
        return done
          ? item.exit_code
            ? {
                kind: 'tool_error',
                text: truncate(`exit ${item.exit_code}: ${item.aggregated_output || item.command}`, 500),
              }
            : null
          : { kind: 'tool', name: 'Shell', summary: truncate(item.command || '', 200) };
      case 'file_change': {
        const files = (item.changes || []).map((c) => c.path).join(', ');
        return done ? { kind: 'tool', name: 'Edit', summary: truncate(files, 200) } : null;
      }
      case 'mcp_tool_call':
        return done
          ? null
          : { kind: 'tool', name: item.tool || 'MCP', summary: truncate(item.server || '', 200) };
      case 'web_search':
        return done ? null : { kind: 'tool', name: 'WebSearch', summary: truncate(item.query || '', 200) };
      case 'error':
        return { kind: 'tool_error', text: truncate(item.message || 'error', 500) };
      default:
        return null;
    }
  };
  return {
    feed(msg) {
      const out = [];
      const item = msg.item || {};
      switch (msg.type) {
        case 'thread.started':
          if (msg.thread_id) turn.sessionId = msg.thread_id;
          // A failed resume opens a new thread from zero; the old baseline no longer applies.
          if (msg.thread_id && turn.codexBaseline && msg.thread_id !== turn.codexBaseline.sessionId)
            turn.codexBaseline = null;
          out.push({ kind: 'info', text: `Codex session started: thread ${msg.thread_id || '?'}` });
          break;
        case 'item.started': {
          const e = itemEvent(item, false);
          if (e) out.push(e);
          break;
        }
        case 'item.completed': {
          const e = itemEvent(item, true);
          if (e) out.push(e);
          break;
        }
        case 'turn.completed': {
          const u = msg.usage || {};
          // Codex reports lifetime thread totals here, including cache reads.
          const own = codexTurnUsage(
            {
              inputTokens: u.input_tokens,
              outputTokens: u.output_tokens,
              cachedInputTokens: u.cached_input_tokens,
            },
            turn.codexBaseline,
          );
          for (const [field, value] of Object.entries(own)) if (value != null) turn[field] = value;
          out.push({
            kind: 'result',
            subtype: 'success',
            isError: false,
            tokens: null,
            inputTokens: turn.inputTokens,
            outputTokens: turn.outputTokens,
          });
          break;
        }
        case 'turn.failed':
          out.push({
            kind: 'result',
            subtype: 'error',
            isError: true,
            text: truncate((msg.error && msg.error.message) || 'turn failed', 1000),
          });
          break;
        case 'error':
          out.push({ kind: 'tool_error', text: truncate(msg.message || 'error', 500) });
          break;
        default:
          break;
      }
      return out;
    },
    flush() {
      return [];
    },
  };
}

// grok's streaming-messages-json emits whole claude-style messages (verified on grok 1.0). The
// Messages delta events are handled as a fallback in case a future grok streams real deltas.
function grokParser(turn) {
  const blocks = new Map(); // index -> {type, name, text}
  const live = new Set(); // tool_use ids of agent calls still running
  return {
    feed(msg) {
      const out = [];
      switch (msg.type) {
        case 'system':
          if (msg.subtype === 'init') {
            if (msg.session_id) turn.sessionId = msg.session_id;
            out.push({ kind: 'info', text: `Grok session started: model ${msg.model}` });
          }
          break;
        case 'assistant': {
          const u = msg.message && msg.message.usage;
          if (u) {
            turn.contextTokens =
              (u.input_tokens || 0) +
              (u.cache_read_input_tokens || 0) +
              (u.cache_creation_input_tokens || 0) +
              (u.output_tokens || 0);
          }
          for (const block of (msg.message && msg.message.content) || []) {
            if (block.type === 'text' && block.text && block.text.trim()) {
              out.push({ kind: 'text', text: block.text });
            } else if (block.type === 'tool_use') {
              out.push({
                kind: 'tool',
                name: block.name,
                summary: summarizeToolInput(block.name, block.input),
              });
              const started = subagentStart(live, block);
              if (started) out.push(started);
            }
          }
          break;
        }
        case 'user': {
          const content = (msg.message && msg.message.content) || [];
          if (!Array.isArray(content)) {
            out.push(...subagentNotified(live, content));
            break;
          }
          for (const block of content) {
            if (block.type === 'text') {
              out.push(...subagentNotified(live, block.text));
              continue;
            }
            if (block.type !== 'tool_result') continue;
            const ended = subagentEnd(live, block);
            if (ended) out.push(ended);
            if (block.is_error) {
              const text = blockText(block.content);
              if (text.trim()) out.push({ kind: 'tool_error', text: truncate(text, 500) });
            }
          }
          break;
        }
        case 'result':
          if (msg.session_id) turn.sessionId = msg.session_id;
          turn.costUsd = msg.total_cost_usd ?? null;
          turn.durationMs = msg.duration_ms ?? null;
          readResultUsage(turn, msg);
          out.push({
            kind: 'result',
            subtype: msg.subtype,
            isError: !!msg.is_error,
            costUsd: turn.costUsd,
            durationMs: turn.durationMs,
            numTurns: msg.num_turns ?? null,
            tokens: turn.contextTokens ?? null,
            inputTokens: turn.inputTokens,
            outputTokens: turn.outputTokens,
            text: truncate(typeof msg.result === 'string' ? msg.result : '', 4000),
          });
          break;
        case 'message_start':
          if (msg.message && msg.message.session_id) turn.sessionId = msg.message.session_id;
          break;
        case 'content_block_start': {
          const cb = msg.content_block || {};
          blocks.set(msg.index, { type: cb.type, name: cb.name || null, text: cb.text || '' });
          if (cb.type === 'tool_use') {
            out.push({ kind: 'tool', name: cb.name || 'tool', summary: '' });
          }
          break;
        }
        case 'content_block_delta': {
          const b = blocks.get(msg.index);
          const d = msg.delta || {};
          if (b && d.type === 'text_delta') b.text += d.text || '';
          break;
        }
        case 'content_block_stop': {
          const b = blocks.get(msg.index);
          blocks.delete(msg.index);
          if (b && b.type === 'text' && b.text.trim()) out.push({ kind: 'text', text: b.text });
          break;
        }
        case 'message_delta':
          if (msg.delta && msg.delta.stop_reason === 'refusal') {
            out.push({ kind: 'tool_error', text: 'The model refused to continue.' });
          }
          break;
        case 'error':
          out.push({ kind: 'tool_error', text: truncate((msg.error && msg.error.message) || 'error', 500) });
          break;
        default:
          break;
      }
      return out;
    },
    flush() {
      const out = [];
      for (const b of blocks.values()) {
        if (b.type === 'text' && b.text.trim()) out.push({ kind: 'text', text: b.text });
      }
      blocks.clear();
      return [...out, ...subagentFlush(live)];
    },
  };
}

// opencode tools mapped to the dashboard's names; others keep their own.
const OPENCODE_TOOL_NAMES = {
  bash: 'Shell',
  edit: 'Edit',
  write: 'Write',
  patch: 'Edit',
  read: 'Read',
  grep: 'Grep',
  glob: 'Glob',
  list: 'List',
  webfetch: 'WebFetch',
  websearch: 'WebSearch',
  task: 'Agent',
};

// JSON lines of {type, timestamp, sessionID, …}. `tool_use` arrives only once finished, so
// sub-agents have no live half. There is no result message, so flush() emits the result once
// the exit code or cancellation is known.
function opencodeParser(turn) {
  let steps = 0;
  let errored = false;
  // No stated duration, so the span of line timestamps is used, excluding CLI startup.
  let firstAt = null;
  let lastAt = null;
  return {
    feed(msg) {
      const out = [];
      if (typeof msg.timestamp === 'number') {
        if (firstAt == null) firstAt = msg.timestamp;
        lastAt = msg.timestamp;
      }
      // How a fresh session's CLI-assigned id gets back here.
      if (msg.sessionID && !turn.sessionId) {
        turn.sessionId = msg.sessionID;
        out.push({ kind: 'info', text: `opencode session started: ${msg.sessionID}` });
      }
      const part = msg.part || {};
      switch (msg.type) {
        case 'text':
          if (part.text && part.text.trim()) out.push({ kind: 'text', text: part.text });
          break;
        case 'tool_use': {
          const state = part.state || {};
          const name = OPENCODE_TOOL_NAMES[part.tool] || part.tool || 'tool';
          out.push({ kind: 'tool', name, summary: summarizeToolInput(name, state.input) });
          if (state.status === 'error' && state.error) {
            out.push({ kind: 'tool_error', text: truncate(state.error, 500) });
          }
          break;
        }
        case 'step_finish': {
          // Consumption sums the steps; the newest step alone is the live context size.
          const t = part.tokens || {};
          const cache = t.cache || {};
          const input = (t.input || 0) + (cache.read || 0) + (cache.write || 0);
          const output = (t.output || 0) + (t.reasoning || 0);
          turn.inputTokens = (turn.inputTokens || 0) + input;
          turn.outputTokens = (turn.outputTokens || 0) + output;
          turn.contextTokens = input + output;
          if (typeof part.cost === 'number') turn.costUsd = (turn.costUsd || 0) + part.cost;
          steps++;
          break;
        }
        case 'error': {
          const e = msg.error || {};
          errored = true;
          out.push({
            kind: 'tool_error',
            text: truncate(e.data?.message || e.message || e.name || 'error', 500),
          });
          break;
        }
        default:
          break;
      }
      return out;
    },
    // No steps and no error: the exit code speaks. A streamed error must surface, since the CLI
    // can exit 0 on a rejected model or key. Otherwise the caller's exit/cancel decides success.
    flush({ canceled = false, code = 0 } = {}) {
      if (!steps && !errored) return [];
      const failed = errored || canceled || code !== 0;
      if (firstAt != null && lastAt > firstAt) turn.durationMs = lastAt - firstAt;
      return [
        {
          kind: 'result',
          subtype: failed ? 'error' : 'success',
          isError: failed,
          costUsd: turn.costUsd,
          durationMs: turn.durationMs,
          tokens: turn.contextTokens ?? null,
          inputTokens: turn.inputTokens,
          outputTokens: turn.outputTokens,
        },
      ];
    },
  };
}

// Side-channel accumulator: input/outputTokens are total consumption (cache reads included),
// contextTokens the live context size, contextWindow the model's limit.
export function newTurn() {
  return {
    sessionId: null,
    costUsd: null,
    durationMs: null,
    inputTokens: null,
    outputTokens: null,
    contextWindow: null,
  };
}

// For binaries whose stream never states a window (claude's does). grok bakes in 500k everywhere;
// codex reads its models cache; opencode its cached models.dev catalog.
export function contextWindowFor(binaryId, model, provider = null) {
  if (binaryId === 'grok') return 500000;
  if (binaryId === 'opencode') {
    const [service, ...rest] = String(model || '').split('/');
    const catalog = opencodeCatalog(provider ? [opencodeHomeDir(provider)] : []);
    return catalog[service]?.models?.[rest.join('/')]?.limit?.context || 200000;
  }
  if (binaryId === 'codex') {
    // A wide pick states its own window.
    const { slug, contextWindow } = splitCodexModel(model);
    if (contextWindow) return contextWindow;
    for (const dir of codexCacheDirs(provider)) {
      try {
        const file = path.join(dir, 'models_cache.json');
        const hit = (JSON.parse(fs.readFileSync(file, 'utf8')).models || []).find((m) => m.slug === slug);
        if (hit && hit.context_window) return hit.context_window;
      } catch {
        /* no cache here: the next dir or the catalog metadata answers */
      }
    }
    const known = KNOWN_CODEX_MODELS[slug];
    return (known && known.context_window) || 262144;
  }
  return null;
}

// Parses `claude -p "/context"` markdown: the "**Tokens:** 24.3k / 200k" total and the
// "| System prompt | 6.3k | 3.2% |" category rows. Counts are rounded, so estimates.
export function parseContextReport(md) {
  // The CLI lowercases its compact numbers, so a 1M window prints as "1m".
  const toTokens = (s) => {
    const m = String(s).match(/([\d.]+)\s*([km]?)/i);
    const unit = ((m && m[2]) || '').toLowerCase();
    return m ? Math.round(parseFloat(m[1]) * (unit === 'm' ? 1e6 : unit === 'k' ? 1e3 : 1)) : null;
  };
  const text = String(md || '');
  const head = text.match(/\*\*Tokens:\*\*\s*([\d.]+\s*[km]?)\s*\/\s*([\d.]+\s*[km]?)/i);
  const section = (text.split(/### Estimated usage by category/)[1] || '').split('###')[0];
  const categories = [];
  for (const line of section.split('\n')) {
    const m = line.match(/^\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([\d.]+)%\s*\|/);
    if (m) categories.push({ name: m[1], tokens: toTokens(m[2]), pct: parseFloat(m[3]) });
  }
  if (!head && !categories.length) return null;
  return {
    tokens: head ? toTokens(head[1]) : null,
    window: head ? toTokens(head[2]) : null,
    categories,
  };
}

export function parserFor(binaryId, turn) {
  if (binaryId === 'claude') return claudeParser(turn);
  if (binaryId === 'codex') return codexParser(turn);
  if (binaryId === 'grok') return grokParser(turn);
  if (binaryId === 'opencode') return opencodeParser(turn);
  throw new Error(`Unknown binary: ${binaryId}`);
}

// The Test button probes endpoint + key with a model list request, the cheapest call every
// gateway answers (Anthropic wire for claude, OpenAI wire for codex). Values come unsaved from the
// form. Gateways without a list fail with routeMissing so callers can fall back to a chat probe.

async function endpointFetch(url, opts = {}) {
  let res;
  try {
    res = await fetch(url, { ...opts, signal: AbortSignal.timeout(20000) });
  } catch (e) {
    throw new Error(`Could not reach ${url}: ${e.cause?.message || e.message}`, { cause: e });
  }
  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    /* non-JSON answer, reported by callers */
  }
  return { res, body, text };
}

function endpointDetail(body, text) {
  // An HTML error page reads as noise in a status line, so flatten it to text.
  const flat = String(text ?? '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return body?.error?.message || body?.msg || body?.message || truncate(flat, 200) || '(empty body)';
}

export async function testProviderEndpoint({ binary, baseUrl, apiKey }) {
  let url;
  const headers = {};
  if (binary === 'claude') {
    const base = (baseUrl || 'https://api.anthropic.com').replace(/\/+$/, '');
    url = `${base}/v1/models?limit=1000`;
    headers['x-api-key'] = apiKey || '';
    headers['anthropic-version'] = '2023-06-01';
    // Anthropic wants x-api-key while vLLM and most proxies read only Authorization, so a custom
    // endpoint gets both; each ignores the one it does not use.
    if (baseUrl) headers.Authorization = `Bearer ${apiKey || ''}`;
  } else if (binary === 'codex') {
    if (!baseUrl)
      throw new Error(
        "There is no endpoint to test: a codex entry without a base URL runs on the CLI's own login",
      );
    url = `${baseUrl.replace(/\/+$/, '')}/models`;
    headers.Authorization = `Bearer ${apiKey || ''}`;
  } else if (binary === 'opencode') {
    if (!baseUrl)
      throw new Error(
        "There is no endpoint to test: an opencode entry without a base URL runs on its service's own",
      );
    // Every opencode service publishes /models whatever its wire; the key goes on both headers.
    url = `${baseUrl.replace(/\/+$/, '')}/models`;
    headers.Authorization = `Bearer ${apiKey || ''}`;
    headers['x-api-key'] = apiKey || '';
    headers['anthropic-version'] = '2023-06-01';
  } else {
    throw new Error(`The ${binary} binary has no endpoint override to test`);
  }
  const { res, body, text } = await endpointFetch(url, { headers });
  const detail = () => endpointDetail(body, text);
  if (!res.ok || body === null) {
    const err = /** @type {Error & { routeMissing?: boolean }} */ (
      new Error(
        !res.ok ? `${url} answered ${res.status}: ${detail()}` : `${url} did not answer JSON: ${detail()}`,
      )
    );
    // A missing route (404/405, HTML) says nothing about the key.
    err.routeMissing = body === null || res.status === 404 || res.status === 405;
    throw err;
  }
  const list = Array.isArray(body?.data) ? body.data : Array.isArray(body?.models) ? body.models : [];
  const models = list.map((m) => m.id || m.slug || m.name).filter(Boolean);
  // Some gateways (Z.AI among them) put auth errors in a 200 body.
  if (!models.length) throw new Error(`${url} answered 200 but no model list came back: ${detail()}`);
  return models;
}

// The smallest chat call as the entry's model, for gateways without a model list. opencode's
// anthropic service uses the claude wire (URL already ends in /v1), others /chat/completions.
// Success is a response object, not a status: Z.AI answers a bad key with 200 {"code":401}.
export async function probeChatEndpoint({ binary, baseUrl, apiKey, model }) {
  const base = (baseUrl || (binary === 'claude' ? 'https://api.anthropic.com' : '')).replace(/\/+$/, '');
  if (!base) throw new Error('There is no endpoint to probe');
  // The endpoint only knows the <model> half of opencode's <service>/<model>.
  const [service, ...rest] = binary === 'opencode' ? String(model || '').split('/') : ['', model];
  const modelId = binary === 'opencode' ? rest.join('/') : model;
  let url;
  let opts;
  if (binary === 'claude' || (binary === 'opencode' && service === 'anthropic')) {
    url = binary === 'claude' ? `${base}/v1/messages` : `${base}/messages`;
    opts = {
      method: 'POST',
      headers: {
        'x-api-key': apiKey || '',
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
        ...(baseUrl ? { Authorization: `Bearer ${apiKey || ''}` } : {}),
      },
      body: JSON.stringify({ model: modelId, max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }),
    };
  } else if (binary === 'opencode') {
    url = `${base}/chat/completions`;
    opts = {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey || ''}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: modelId, max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }),
    };
  } else {
    url = `${base}/responses`;
    opts = {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey || ''}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, input: 'hi', stream: false, max_output_tokens: 16 }),
    };
  }
  const { res, body, text } = await endpointFetch(url, opts);
  const detail = endpointDetail(body, text);
  if (!res.ok) throw new Error(`${url} answered ${res.status}: ${detail}`);
  if (
    !body ||
    body.error ||
    body.success === false ||
    body.type === 'error' ||
    !(body.id || body.object || body.type)
  ) {
    throw new Error(`${url} answered 200 but not with a response: ${detail}`);
  }
}

// The Test button run automatically: an API-key entry is connected only once a live call answers.
// Cached a minute since the page re-polls and the chat probe is paid. A lazy `model` function is
// called only on a miss and requires `modelKey` to key the cache.
const endpointVerifyCache = new Map(); // binary|baseUrl|model|apiKey -> { at, value }
export async function verifyCustomEndpoint({ binary, baseUrl, apiKey, model, modelKey = model }) {
  if (typeof modelKey === 'function') throw new Error('verifyCustomEndpoint: a lazy model needs a modelKey');
  const key = [binary, baseUrl, modelKey, apiKey].join('|');
  const hit = endpointVerifyCache.get(key);
  if (hit && Date.now() - hit.at < 60_000) return hit.value;
  if (typeof model === 'function') model = model();
  const checkedAt = new Date().toISOString();
  let value;
  try {
    const models = await testProviderEndpoint({ binary, baseUrl, apiKey });
    value = {
      loggedIn: true,
      detail: `API key OK: the endpoint lists ${models.length} model${models.length === 1 ? '' : 's'}`,
      checkedAt,
    };
  } catch (e) {
    if (e.routeMissing && model) {
      try {
        await probeChatEndpoint({ binary, baseUrl, apiKey, model });
        value = {
          loggedIn: true,
          detail: `API key OK: no model list, but a chat call as ${model} answered`,
          checkedAt,
        };
      } catch (e2) {
        value = { loggedIn: false, detail: e2.message, checkedAt };
      }
    } else {
      value = { loggedIn: false, detail: e.message, checkedAt };
    }
  }
  endpointVerifyCache.set(key, { at: Date.now(), value });
  return value;
}

// ---------- auth probes (best effort, for the UI banner) ----------

// The logged-in account from the local credential store (the provider's dir, else the default).
// Never throws; nulls when unknown.
export function providerAuthAccount(binaryId, provider = null) {
  const home = os.homedir();
  try {
    if (binaryId === 'claude') {
      // .claude.json moves into CLAUDE_CONFIG_DIR when that is set.
      const dir = provider ? claudeHomeDir(provider) : home;
      const j = JSON.parse(fs.readFileSync(path.join(dir, '.claude.json'), 'utf8'));
      let plan = null;
      try {
        const c = JSON.parse(
          fs.readFileSync(
            path.join(provider ? dir : path.join(home, '.claude'), '.credentials.json'),
            'utf8',
          ),
        );
        plan = c.claudeAiOauth?.subscriptionType || null;
      } catch {
        /* a login can exist without stored credentials, so no plan then */
      }
      return {
        email: j.oauthAccount?.emailAddress || null,
        name: j.oauthAccount?.displayName || null,
        organization: j.oauthAccount?.organizationName || null,
        plan,
      };
    }
    if (binaryId === 'codex') {
      const dir = provider ? codexHomeDir(provider) : path.join(home, '.codex');
      const j = JSON.parse(fs.readFileSync(path.join(dir, 'auth.json'), 'utf8'));
      const idToken = j.tokens?.id_token;
      if (!idToken) return { email: null, name: null };
      const payload = JSON.parse(Buffer.from(idToken.split('.')[1], 'base64url').toString('utf8'));
      const oa = payload['https://api.openai.com/auth'] || {};
      return { email: payload.email || null, name: payload.name || null, plan: oa.chatgpt_plan_type || null };
    }
    if (binaryId === 'grok') {
      const dir = provider ? grokHomeDir(provider) : path.join(home, '.grok');
      const j = JSON.parse(fs.readFileSync(path.join(dir, 'auth.json'), 'utf8'));
      for (const entry of Object.values(j)) {
        if (entry && typeof entry === 'object' && entry.email) {
          return { email: entry.email, name: entry.first_name || null };
        }
      }
    }
  } catch {
    /* missing or malformed store: just omit the account info */
  }
  return { email: null, name: null };
}

// ---------- subscription usage ----------
// Metered plans normalize to a list of {label, short, usedPct, resetsAt} windows, since windows
// differ per plan (5h/7d, 5h/1d, a billing month) and a fixed "week" bar would mislabel them.
function usageWindows(windows) {
  const list = windows.filter((w) => w && w.usedPct != null);
  return list.length ? { windows: list } : null;
}

// Number.isFinite: a derived percentage can be NaN, which passes `!= null` into "NaN% used".
function usedPct(n) {
  return Number.isFinite(n) ? Math.min(100, Math.max(0, Math.round(n))) : null;
}

// A 429's Retry-After (seconds or HTTP date) as an ISO time. A missing one still holds off for a
// while, since retrying a minute later keeps the usage endpoint locked out.
const RETRY_AFTER_DEFAULT_MS = 15 * 60_000;
export function retryAfterAt(header, now = Date.now()) {
  const text = String(header ?? '').trim();
  let ms = /^\d+$/.test(text) ? Number(text) * 1000 : Date.parse(text) - now;
  if (!Number.isFinite(ms) || ms <= 0) ms = RETRY_AFTER_DEFAULT_MS;
  return new Date(now + ms).toISOString();
}

// A claude.ai login's subscription usage, as the CLI's /usage shows it. Any failure means no usage.
export async function claudeUsage(configDir) {
  const home = os.homedir();
  try {
    const dir = configDir || path.join(home, '.claude');
    const creds = JSON.parse(fs.readFileSync(path.join(dir, '.credentials.json'), 'utf8'));
    const token = creds.claudeAiOauth?.accessToken;
    if (!token || typeof fetch !== 'function') return null;
    const res = await fetch('https://api.anthropic.com/api/oauth/usage', {
      headers: { Authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20' },
      signal: AbortSignal.timeout(10000),
    });
    if (res.status === 429) {
      const retryAt = retryAfterAt(res.headers?.get?.('retry-after'));
      return {
        windows: [],
        error: `Claude rate limited the usage check. It can be checked again at ${new Date(retryAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.`,
        retryAt,
      };
    }
    if (!res.ok) return { windows: [], error: `Claude usage check failed (HTTP ${res.status}).` };
    const j = await res.json();
    return usageWindows([
      {
        label: 'Session (5h window)',
        short: '5h',
        usedPct: usedPct(j.five_hour?.utilization),
        resetsAt: j.five_hour?.resets_at || null,
      },
      {
        label: 'Week (7-day window)',
        short: 'wk',
        usedPct: usedPct(j.seven_day?.utilization),
        resetsAt: j.seven_day?.resets_at || null,
      },
    ]);
  } catch {
    return null;
  }
}

// A codex ChatGPT login's usage as the CLI's /status shows it (wham/usage). Any failure means
// no usage.
export async function codexUsage(configDir) {
  const home = os.homedir();
  try {
    const dir = configDir || path.join(home, '.codex');
    const j = JSON.parse(fs.readFileSync(path.join(dir, 'auth.json'), 'utf8'));
    const token = j.tokens?.access_token;
    if (!token || typeof fetch !== 'function') return null;
    const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    const account = claims['https://api.openai.com/auth']?.chatgpt_account_id;
    const res = await fetch('https://chatgpt.com/backend-api/wham/usage', {
      headers: { Authorization: `Bearer ${token}`, ...(account ? { 'chatgpt-account-id': account } : {}) },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    const b = await res.json();
    const windows = [];
    // Window order varies by plan, so classify by length: up to six hours is the session.
    for (const w of [b.rate_limit?.primary_window, b.rate_limit?.secondary_window]) {
      if (!w || typeof w.used_percent !== 'number') continue;
      const session = (w.limit_window_seconds || 0) <= 6 * 3600;
      windows.push({
        label: session ? 'Session (5h window)' : 'Week (7-day window)',
        short: session ? '5h' : 'wk',
        usedPct: usedPct(w.used_percent),
        resetsAt: w.reset_at ? new Date(w.reset_at * 1000).toISOString() : null,
      });
    }
    return usageWindows(windows);
  } catch {
    return null;
  }
}

// An x.ai login's monthly credit usage, from the billing route grok's /usage calls. The six-hour
// token is never refreshed here: refreshing rotates the refresh token, and losing that rotation
// would log the entry out, so an idle login just shows no bar.
export async function grokUsage(configDir) {
  const home = os.homedir();
  try {
    const dir = configDir || path.join(home, '.grok');
    const store = JSON.parse(fs.readFileSync(path.join(dir, 'auth.json'), 'utf8'));
    // Keyed by "<issuer>::<client id>"; one login per dir, so the first with a token.
    const entry = Object.values(store).find((e) => e && typeof e === 'object' && e.key);
    if (!entry || typeof fetch !== 'function') return null;
    if (entry.expires_at && Date.parse(entry.expires_at) <= Date.now()) return null;
    const res = await fetch('https://cli-chat-proxy.grok.com/v1/billing?format=credits', {
      headers: { Authorization: `Bearer ${entry.key}`, 'x-grok-client-mode': 'cli' },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    const b = await res.json();
    // creditUsagePercent, else the period's own totals.
    const period = b.currentPeriod || {};
    const pct =
      usedPct(b.creditUsagePercent) ??
      (period.monthlyLimit > 0 ? usedPct((period.totalUsed / period.monthlyLimit) * 100) : null);
    return usageWindows([
      {
        label: 'Credits (billing period)',
        short: 'mo',
        usedPct: pct,
        resetsAt: period.billingPeriodEnd || null,
      },
    ]);
  } catch {
    return null;
  }
}

// Z.AI meters the API key itself, on the endpoint's host. The key goes raw: a `Bearer` prefix
// fails authentication. Undocumented, so any change just means no bars.
export async function zaiUsage(baseUrl, apiKey) {
  try {
    if (!apiKey || typeof fetch !== 'function') return null;
    const origin = new URL(baseUrl).origin;
    const res = await fetch(`${origin}/api/monitor/usage/quota/limit`, {
      headers: { Authorization: apiKey, 'Accept-Language': 'en-US,en' },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    const b = await res.json();
    // Like every Z.AI route, a rejected key comes back 200 with success:false.
    if (b?.success === false) return null;
    return usageWindows(
      (b?.data?.limits || []).map((l) => ({
        ...zaiWindowLabel(l),
        usedPct: usedPct(l.percentage),
        resetsAt: l.nextResetTime ? new Date(l.nextResetTime).toISOString() : null,
      })),
    );
  } catch {
    return null;
  }
}

// Only unit codes 3 (hours) and 6 (days) have been observed and the enum is unpublished, so
// others get a bar without a claimed period.
const ZAI_UNITS = { 3: ['hour', 'h'], 6: ['day', 'd'] };
function zaiWindowLabel(limit) {
  const unit = ZAI_UNITS[limit.unit];
  const n = limit.number;
  if (!unit || !n) return { label: 'Plan quota', short: 'plan' };
  return { label: `Quota (${n}-${unit[0]} window)`, short: `${n}${unit[1]}` };
}

// Best-effort auth probe; claude rows resolve null (server.js runs `claude auth status`).
export function probeProviderAuth(provider, _cfg) {
  return new Promise((resolve) => {
    if (provider.binary === 'claude') {
      return resolve(null);
    }
    if (provider.binary === 'codex') {
      // A custom endpoint's key is verified live, not assumed from its presence.
      if (provider.baseUrl) {
        return resolve(
          verifyCustomEndpoint({
            binary: 'codex',
            baseUrl: provider.baseUrl,
            apiKey: provider.apiKey,
            model: () => codexEndpointDefaultModel(provider),
            modelKey: JSON.stringify([provider.defaultModel, provider.models]),
          }),
        );
      }
      if (provider.apiKey) return resolve({ loggedIn: true, detail: 'API key (settings)' });
      // Materialize the entry's dir from the database, then look for the login.
      let dir;
      try {
        dir = ensureCodexHome(provider);
      } catch {
        dir = codexHomeDir(provider);
      }
      return resolve(
        fs.existsSync(path.join(dir, 'auth.json'))
          ? { loggedIn: true, detail: 'auth.json present', ...providerAuthAccount('codex', provider) }
          : { loggedIn: false, detail: 'no login yet: use Log in on the settings page' },
      );
    }
    if (provider.binary === 'grok') {
      // Materialize the entry's dir from the database, then look for the login.
      let dir;
      try {
        dir = ensureGrokHome(provider);
      } catch {
        dir = grokHomeDir(provider);
      }
      return resolve(
        fs.existsSync(path.join(dir, 'auth.json'))
          ? { loggedIn: true, detail: 'auth.json present', ...providerAuthAccount('grok', provider) }
          : { loggedIn: false, detail: 'no login yet: use Log in on the settings page' },
      );
    }
    if (provider.binary === 'opencode') {
      // No login: the entry is its API key, filed under its model's service.
      if (!provider.apiKey) {
        return resolve({ loggedIn: false, detail: 'no API key yet: add one on the settings page' });
      }
      // Empty only when the model is not named <service>/<model>.
      const service = opencodeServiceId(provider);
      if (!service) {
        return resolve({
          loggedIn: false,
          detail:
            "the API key has no service: name this entry's model the way opencode does, <service>/<model>, so the key can be filed under it",
        });
      }
      // As on codex, a custom endpoint is verified live.
      if (provider.baseUrl) {
        return resolve(
          verifyCustomEndpoint({
            binary: 'opencode',
            baseUrl: provider.baseUrl,
            apiKey: provider.apiKey,
            model: opencodeModelRef(provider),
          }),
        );
      }
      return resolve({ loggedIn: true, detail: `API key for ${service} (settings)` });
    }
    return resolve(null);
  });
}
