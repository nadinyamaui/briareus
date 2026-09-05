// @ts-check
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { execFileSync, spawn } from 'child_process';
import readline from 'readline';

// The four coding-agent binaries a provider can run: the ONLY hardcoded
// part of the provider system. Each binary knows how to find its executable,
// its default models and efforts, how to build a headless streaming
// invocation, and how to turn its stdout lines into the app's normalized
// events. The providers themselves (label, isolated login dir, custom
// endpoint + key, model overrides) are rows in the `providers` table, edited
// at /settings and resolved against a binary here; see lib/providerstore.js.
// Claude's binary discovery lives in config.js (the review side uses it too);
// codex, grok and opencode are discovered here.

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

  // There is no desktop app here: the CLI comes from npm, whose global prefix is
  // per-user so it can update itself without sudo.
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
  // opencode's own installer drops a single binary in ~/.opencode/bin; the npm
  // package (opencode-ai) lands wherever the global prefix points.
  for (const candidate of [
    { bin: path.join(os.homedir(), '.opencode', 'bin', 'opencode'), source: '~/.opencode/bin' },
    { bin: path.join(os.homedir(), '.npm-global', 'bin', 'opencode'), source: 'npm global' },
    { bin: '/usr/local/bin/opencode', source: 'npm global (system)' },
  ]) {
    if (fs.existsSync(candidate.bin)) return candidate;
  }
  return null;
}

const CODEX_MODEL_FALLBACK = [
  'gpt-6-astra',
  'gpt-5.6-sol',
  'gpt-5.6-terra',
  'gpt-5.6-luna',
  'gpt-5.5',
  'gpt-5.4',
  'gpt-5.4-mini',
];

// Several codex models are sold at two sizes: the catalog's `context_window`
// is what a turn gets by default, `max_context_window` a ceiling the CLI only
// asks for when told to (`-c model_context_window=`). Rather than a global
// switch, each such model appears in the picker twice — the plain slug at the
// default window and a "gpt-6-astra (872k)" twin at the ceiling — so the size
// is chosen per session, next to the model it belongs to.
//
// The size rides in the label because that label is all the turn gets: the
// picker's string is what the session stores and what buildArgs is handed,
// with no catalog in reach to look a ceiling up in.
const CODEX_WIDE_MODEL = /^(.+) \((\d+)k\)$/;

// The picked string split back into what codex is actually asked for: the real
// slug for -m, and the window to override with (null on a plain pick, which
// leaves codex on the model's default).
export function splitCodexModel(model) {
  const match = CODEX_WIDE_MODEL.exec(String(model || ''));
  if (!match) return { slug: String(model || ''), contextWindow: null };
  return { slug: match[1], contextWindow: Number(match[2]) * 1000 };
}

// The wide twin for every slug whose catalog entry offers one, interleaved
// after the model it belongs to. A ceiling that is not a whole number of
// thousands is skipped rather than rounded: the label is the only record of
// the number, so one that does not survive the round trip would send codex a
// window nobody asked for.
export function codexWideVariants(slugs, provider = null, home = os.homedir()) {
  const dirs = provider ? [codexHomeDir(provider, home)] : [];
  dirs.push(path.join(home, '.codex'));
  let catalog = null;
  for (const dir of dirs) {
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

// Codex keeps a models cache next to its config; reading it beats hardcoding a
// list that goes stale. A provider's isolated home is the cache its sessions
// actually refresh, with the developer's machine-wide cache as a legacy
// fallback. Hidden, review-only and watermark variants stay out of the picker.
function codexModels(_cfg, provider = null, home = os.homedir()) {
  const dirs = provider ? [codexHomeDir(provider, home)] : [];
  dirs.push(path.join(home, '.codex'));
  for (const dir of dirs) {
    try {
      const cached = JSON.parse(fs.readFileSync(path.join(dir, 'models_cache.json'), 'utf8'));
      const slugs = (cached.models || [])
        .filter((m) => m.visibility !== 'hide')
        .map((m) => m.slug)
        .filter((slug) => slug && !/auto-review|-wm$/.test(slug));
      if (slugs.length) return codexWideVariants(slugs, provider, home);
    } catch {
      /* the next cache, or the baked fallback, answers */
    }
  }
  return CODEX_MODEL_FALLBACK;
}

// Ask Codex's supported app-server protocol for the picker-visible catalog.
// The CLI refreshes models_cache.json as part of model/list, leaving the same
// cache its future sessions and codexModels above consume. Kept as a short,
// one-shot child rather than a resident daemon because startup is the only
// time Briareus needs to force a refresh.
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
        env: { ...process.env, CODEX_HOME: ensureHome(provider) },
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

// opencode reaches every service models.dev knows about and names a model
// `<service>/<model>`, so the whole catalog is far too much for a picker: an
// entry's key is for one service, so its list is that service's models, read
// from the models.dev catalog the CLI itself caches. The cross-service
// fallback is for an entry that names no service at all.
function opencodeModels(cfg, provider = null) {
  const fallback = ['anthropic/claude-sonnet-4-5', 'openai/gpt-5.1-codex', 'opencode/grok-code'];
  const service = provider ? opencodeServiceId(provider) : '';
  if (!service) return fallback;
  const catalog = opencodeCatalog(provider ? [opencodeHomeDir(provider)] : []);
  const models = new Set(Object.keys(catalog[service]?.models || {}).map((id) => `${service}/${id}`));
  // The entry's own model is always offered, whatever the catalog says: a
  // cache that is stale (or not written yet) would otherwise drop it, and
  // providerDefaultModel would quietly run the turn on some other model, which
  // is the one thing that could never refresh the cache.
  models.add(opencodeModelRef(provider));
  return [...models].sort();
}

// The model an entry runs on when nothing else names one: its own default,
// then whatever its list starts with, then the binary's.
function opencodeModelRef(provider) {
  return provider.defaultModel || (provider.models || [])[0] || BINARIES.opencode.defaultModel();
}

// The models.dev catalog as the CLI caches it: one entry's own cache dir
// first (that is the one its runs fill), then the machine's.
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

// What rides along under a review slash command: the rule that a PR reviewed
// more than once must not repeat feedback it already carries, plus the shape
// of the summary comment that has to land before the inline ones. Shared by
// every binary's review turn: claude's /code-review, grok's /review and the
// prompt codex's own `exec review` takes.
function reviewInstructions(prNumber) {
  return [
    `Before reviewing, read the feedback the ${prNumber ? `pull request #${prNumber}` : 'pull request for this branch'} already carries: its description, its issue comments, and every existing review with its inline comments (gh pr view and the /repos/:owner/:repo/pulls/:number/comments and /reviews endpoints via gh api). Take it into account: do not repeat a finding that has already been raised, even in different words, and do not re-raise one that a later commit already fixed or that a maintainer answered or declined. Only report findings that are new. If a prior finding is still unfixed and worth restating, say so explicitly as a follow-up on that thread rather than as a fresh finding. If nothing new remains, post the summary comment saying so and post no inline comments.`,
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
    'End the summary comment with this machine-readable block (an HTML comment, invisible on GitHub) listing every finding this review reports, the low ones included:',
    '',
    '<!-- reviewer:findings',
    '[',
    '  {"severity": "critical", "title": "One-line finding title, max 120 chars", "file": "path/to/file.php", "line": 123}',
    ']',
    '-->',
    '',
    'The block must be valid JSON: severity is one of critical/high/medium/low, file and line may be empty/null when a finding has no single location, and the title must match the finding as posted: the dashboard keys on it. Use an empty array when there are no new findings.',
    '',
    'Post that comment with `gh pr comment <number> --body-file <file>` (or `--body` with the text inline). Never pass `@<file>` as the body: gh has no @file expansion, so the path lands on the PR verbatim instead of the review.',
  ].join('\n');
}

const claudeBinary = {
  id: 'claude',
  label: 'Claude Code',
  efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
  defaultEffort: (cfg) => cfg.claudeEffort,
  models: () => ['claude-fable-5-1', 'claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5'],
  defaultModel: (cfg) => cfg.claudeModel,
  bin: (cfg) => (cfg.claudeBin ? { bin: cfg.claudeBin, source: cfg.claudeBinSource } : null),
  // Claude's own review command: the branch is already checked out, so the
  // slash command needs no scope of its own, only the session's effort as
  // its level, plus the shared instructions.
  reviewPrompt: ({ prNumber, effort }) =>
    [`/code-review ${effort} --comment`, '', reviewInstructions(prNumber)].join('\n'),
  // The system prompt travels on a proper flag; the prompt itself over stdin.
  buildArgs: ({ model, effort, resume, sessionId, sysPromptFile, mcpConfigFile }) => ({
    args: [
      '-p',
      '--model',
      model,
      '--effort',
      effort,
      '--output-format',
      'stream-json',
      '--verbose',
      // bypassPermissions, not auto: auto mode gates Bash behind a remote
      // safety classifier, and a classifier outage stalls every turn with
      // "cannot determine the safety of Bash right now". The checkout is
      // disposable and headless has nobody to answer a prompt anyway.
      '--permission-mode',
      'bypassPermissions',
      ...(sysPromptFile ? ['--append-system-prompt-file', sysPromptFile] : []),
      // The memory tool rides in as an MCP server of this turn's own: the
      // session's config dir carries none, and the token in it is per turn.
      ...(mcpConfigFile ? ['--mcp-config', mcpConfigFile] : []),
      ...(resume ? ['--resume', sessionId] : ['--session-id', sessionId]),
    ],
    promptVia: 'stdin',
    briefingInPrompt: false,
  }),
};

// codex learns its MCP servers from config, and -c overrides accept a TOML
// value: an inline table for the env, a JSON array (valid TOML) for the args.
// Per turn rather than in the entry's config.toml, because the token in the
// env is the turn's own. Takes the turn's whole list of servers (the memory
// tool, plus the worker tools on an orchestrator session); a bare object still
// reads as a list of one.
function codexMcpArgs(servers) {
  const list = Array.isArray(servers) ? servers : servers ? [servers] : [];
  return list.flatMap((mcp) => {
    const key = `mcp_servers.${mcp.name}`;
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

// The window override, as the config flag codex reads it. Codex keeps 5% of
// whatever it is given as headroom, so a turn asked for 872000 reports 828400
// as its window and compacts there.
function codexWindowArgs(contextWindow) {
  return contextWindow ? ['-c', `model_context_window=${contextWindow}`] : [];
}

const codexBinary = {
  id: 'codex',
  label: 'Codex',
  efforts: ['low', 'medium', 'high', 'xhigh'],
  defaultEffort: () => 'high',
  models: codexModels,
  defaultModel: () => 'gpt-5.6-sol',
  bin: (cfg) => findCodexBin(cfg.codexBin),
  // codex's own review command, carrying the shared instructions the same way
  // grok's does. The scope rides in the text rather than on --base: the flag
  // and a custom PROMPT are mutually exclusive (verified against codex
  // 0.148), and the instructions matter more than the flag: the branch is
  // checked out, so the review agent can work out the diff itself.
  reviewPrompt: ({ branch, base, prNumber }) =>
    [
      `Review the changes branch ${branch} introduces relative to ${base || "the repository's default branch"}.`,
      '',
      reviewInstructions(prNumber),
    ].join('\n'),
  // `codex exec review`, the review command in exec's clothing: the same
  // thread/turn/item JSON stream as a normal exec turn, so the turn reports
  // its tools and usage, and the thread it opens is the one follow-up
  // messages resume. The picker's model and effort apply through the normal
  // flags instead of being left to the review flow's own model.
  buildReviewArgs: ({ model, effort, mcp }) => {
    const { slug, contextWindow } = splitCodexModel(model);
    return {
      args: [
        'exec',
        'review',
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
  // codex has no append-system-prompt flag, so the workspace briefing rides
  // inside the first user message instead (briefingInPrompt).
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
    // grok's built-in /review, but as a chat turn rather than the headless
    // `grok -p "/review --local"` form: a chat turn can carry the shared
    // instructions along and leaves a thread the publish turn resumes. The
    // picker's model and effort apply through the normal turn flags.
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
    // opencode calls these variants and derives them per model from what the
    // service offers (an effort scale, a thinking budget, a plain toggle), so
    // a model that has no variant by this name simply runs on its default
    // reasoning rather than failing.
    efforts: ['low', 'medium', 'high', 'max'],
    defaultEffort: () => 'high',
    models: opencodeModels,
    defaultModel: () => 'anthropic/claude-sonnet-4-5',
    bin: (cfg) => findOpencodeBin(cfg.opencodeBin),
    resumable: opencodeResumable,
    // opencode has no review command of its own, so the review is an ordinary
    // turn whose message names the scope and carries the shared instructions,
    // the same shape codex's takes.
    reviewPrompt: ({ branch, base, prNumber }) =>
      [
        `Review the changes branch ${branch} introduces relative to ${base || "the repository's default branch"}.`,
        '',
        reviewInstructions(prNumber),
      ].join('\n'),
    // `opencode run --format json` streams the session's events as JSON lines.
    // The prompt goes over stdin (argv survives neither newlines nor long
    // messages, and a message left empty makes the CLI read all of stdin), and
    // there is no system-prompt flag, so the briefing rides in the message.
    // The session id is opencode's own (`ses_…`), captured from the stream:
    // the UUID a session is created with is not one of its, so a resume only
    // names an id the CLI itself issued (opencodeResumable, which is also what
    // the caller asks before treating a turn as a resume at all).
    buildArgs: ({ model, effort, resume, sessionId }) => ({
      args: [
        'run',
        '--format',
        'json',
        '--model',
        model,
        '--variant',
        effort,
        // Headless has nobody to answer a permission prompt, and the CLI's
        // default without this is to reject every one of them.
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

// opencode issues its own session ids and nothing else names one of its
// conversations, so the UUID a session is created with never does, and
// neither does what a first turn left behind when it died before the CLI
// printed an id of its own.
function opencodeResumable(sessionId) {
  return String(sessionId || '').startsWith('ses_');
}

// Whether a stored conversation id is one this binary can actually pick up.
// It decides more than the resume flag on argv: a turn that cannot resume is
// starting a fresh conversation, which has to be told where it is working, so
// the workspace briefing hangs on this answer too.
export function canResume(binaryId, sessionId) {
  const binary = getBinary(binaryId);
  return binary && binary.resumable ? binary.resumable(sessionId) : !!sessionId;
}

// Catalog metadata for models codex's own cache does not know about. The GLM
// entries mirror the catalog Z.AI publishes for codex
// (docs.z.ai/devpack/tool/codex); anything else gets the generic template.
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

// Every claude provider entry runs as a login of its own: a dedicated
// CLAUDE_CONFIG_DIR derived from the row id, never the developer's ~/.claude.
// The login made in that dir is mirrored into the provider's database row
// (readClaudeAuth → auth_data) and written back to disk whenever the dir is
// missing: the database carries the account, the dir is just a cache.
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

// The slice of a claude config dir that goes into the database: the OAuth
// credentials plus the bits of .claude.json that identify the login and keep
// the CLI from re-onboarding. Returns null while the dir holds no login.
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

// The slice of a codex config dir that goes into the database: auth.json,
// which is the login. Returns null while the dir holds no login.
export function readCodexAuth(dir) {
  try {
    return { auth: JSON.parse(fs.readFileSync(path.join(dir, 'auth.json'), 'utf8')) };
  } catch {
    return null;
  }
}

// The claude CLI's login without the CLI: the same claude.ai OAuth client
// the CLI drives from a terminal, driven from the settings page instead.
// start() hands the browser an authorization URL (PKCE); the page claude.ai
// lands on after approval shows a code, finish() exchanges it for tokens and
// writes them into the entry's config dir exactly as `claude /login` would;
// the CLI then uses (and refreshes) them on its own.
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

// Like claude, every codex entry runs in a CODEX_HOME of its own, derived
// from the row id, so the developer's own ~/.codex login is never touched.
export function codexHomeDir(provider, home = os.homedir()) {
  return path.join(home, `.codex-provider-${provider.id}`);
}

// A login entry keeps its account in the dir with the login mirrored into the
// row (readCodexAuth → auth_data), written back whenever the dir is missing:
// the database carries the account, the dir is just a cache. A custom-endpoint
// entry instead gets a config.toml (rewritten on every turn, it's two small
// files) pointing codex at the provider's endpoint with its key, so
// `codex exec review` picks up the endpoint without any argv override carrying
// the key.
//
// `turnModel` is the model the turn about to run picked. It matters for
// `review_model`: the review flow reads that from the config rather than the
// `-m` on argv, so writing the entry's default there would review on a model
// the picker did not choose. The caller with a turn in hand passes it; the
// callers that only materialize the dir (settings, the auth banner) do not, and
// get the entry's default.
export function ensureCodexHome(provider, turnModel = '') {
  const home = codexHomeDir(provider);
  fs.mkdirSync(home, { recursive: true });
  if (!provider.baseUrl && !provider.apiKey) {
    const authFile = path.join(home, 'auth.json');
    if (provider.authData && provider.authData.auth && !fs.existsSync(authFile)) {
      fs.writeFileSync(authFile, JSON.stringify(provider.authData.auth, null, 2), 'utf8');
    }
    // A config.toml left over from a custom-endpoint past would override the
    // login with a dead endpoint.
    for (const f of ['config.toml', 'models.json']) fs.rmSync(path.join(home, f), { force: true });
    return home;
  }
  // A wide pick is a window on top of a real model, not a model of its own:
  // the catalog and `review_model` want the slug underneath, and the window
  // reaches this turn as the `-c` override buildArgs adds. Normalizing both
  // sides here keeps a hand-typed twin in an entry's model list from writing a
  // slug codex would refuse.
  const models = [...new Set(provider.models.map((m) => splitCodexModel(m).slug))];
  const efforts = provider.efforts.length ? provider.efforts : codexBinary.efforts;
  // A turn's model only counts when the entry's catalog declares it: codex
  // refuses a model that is not in the catalog, and a stale pick from a session
  // started before the entry's model list changed must not take the dir down
  // with it.
  const turnSlug = splitCodexModel(turnModel).slug;
  const picked = turnSlug && (!models.length || models.includes(turnSlug)) ? turnSlug : '';
  const model = picked || splitCodexModel(provider.defaultModel).slug || models[0] || 'gpt-5.6-sol';
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

// grok too: every grok entry runs in a GROK_HOME of its own, derived from the
// row id, so the developer's own ~/.grok login is never touched. The login is
// mirrored into the row (readGrokAuth → auth_data) and written back whenever
// the dir is missing: the database carries the account, the dir is a cache.
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

// The slice of a grok home that goes into the database: auth.json, which is
// the login. Returns null while the dir holds no login.
export function readGrokAuth(dir) {
  try {
    return { auth: JSON.parse(fs.readFileSync(path.join(dir, 'auth.json'), 'utf8')) };
  } catch {
    return null;
  }
}

// opencode has no home variable of its own: it lays its credentials, its
// config and its caches out under the XDG base directories. So an entry's
// "home" here is an XDG root of its own, with the four bases inside it, and a
// run gets them pointed at it: the developer's own ~/.local/share/opencode is
// never touched, and two entries never share a session store.
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

// Nothing but the directories: an opencode entry keeps no credential and no
// endpoint on disk, since both travel in the environment with every turn.
export function ensureOpencodeHome(provider) {
  const dir = opencodeHomeDir(provider);
  fs.mkdirSync(path.join(dir, 'data', 'opencode'), { recursive: true });
  return dir;
}

// opencode keys every credential by the service it is for, and names a model
// `<service>/<model>`, so the model a turn runs on says which service its key
// belongs to. It is the turn's model that decides, not the entry's default: a
// project step can move a turn onto another of the entry's models, and a key
// filed under the wrong service authenticates nothing. Callers with no turn in
// hand (the settings status panel) pass none and get the entry's own default,
// and an entry that names no model at all still resolves, since a turn there
// runs on the binary's default, which is a service too.
export function opencodeServiceId(provider, model = '') {
  const ref = model || opencodeModelRef(provider);
  return ref.includes('/') ? ref.split('/')[0] : '';
}

// An opencode entry authenticates with its API key and nothing else: the CLI
// has no login flow to drive from here. OPENCODE_AUTH_CONTENT is the whole
// credential store as JSON, which the CLI reads instead of the file, so the
// key never lands on disk. Null when the entry has no key, or when its model
// names no service to file the key under.
export function opencodeAuthContent(provider, model = '') {
  const service = opencodeServiceId(provider, model);
  if (!service || !provider.apiKey) return null;
  return JSON.stringify({ [service]: { type: 'api', key: provider.apiKey } });
}

// A custom endpoint travels the same way. opencode takes a base URL per
// service in its config (`provider.<service>.options.baseURL`), and
// OPENCODE_CONFIG_CONTENT is a config layered over whatever the files say, so
// the URL never lands in the entry's XDG root either. It is filed under the
// same service as the key, for the same reason: it is the service the turn's
// model names that opencode routes to that URL, and a URL hung on another
// service redirects nothing. Null when the entry has no endpoint, or when its
// model names no service to hang it on.
export function opencodeConfigContent(provider, model = '') {
  const service = opencodeServiceId(provider, model);
  if (!service || !provider.baseUrl) return null;
  return JSON.stringify({ provider: { [service]: { options: { baseURL: provider.baseUrl } } } });
}

// ---------- stream parsing ----------
// Each parser is a stateful per-turn object: feed(line) returns an array of
// normalized events ({kind, ...}) matching what the UI already renders, plus
// optional side-channel fields picked up by the caller (sessionId, costUsd...).

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

// The result message's turn-wide usage (claude, and grok when its fork emits
// it): every token the turn sent and got back, cache traffic included, plus
// the model's context window from modelUsage.
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

// claude's own way of asking the user something. Headless there is nobody in
// the CLI to answer it, so the question is lifted out of the tool call and
// asked in the dashboard instead: the same `ask` event the <ask-user> block
// every provider is briefed on produces, rendered with its answers as buttons.
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

// A sub-agent is a call to the agent tool: `Agent` in current Claude Code,
// `Task` in the older CLIs (and grok). It starts when the call goes out and
// ends when its tool_result comes back. Both halves are lifted out as `agent`
// events so the dashboard can show which sub-agents are working right now;
// the tool step itself still goes to the log the usual way.
const SUBAGENT_TOOLS = new Set(['Agent', 'Task']);

// A backgrounded agent is the normal case now, and its tool_result says only
// that the agent was launched; the work is still going. Such a call stays
// live until the <task-notification> for it arrives, further down the stream.
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

// The end of a backgrounded sub-agent: the CLI feeds the turn a plain-text
// user message naming the tool call that launched it.
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

// A turn that dies mid-Task leaves its sub-agents "running" forever, so
// whatever is still live when the stream ends is ended here.
function subagentFlush(live) {
  const out = [...live].map((id) => ({ kind: 'agent', state: 'end', id }));
  live.clear();
  return out;
}

function claudeParser(turn) {
  const live = new Set(); // tool_use ids of agent calls still running
  return {
    feed(msg) {
      const out = [];
      // A notification can also arrive as a bare queued line rather than a
      // user message, with the same text, so the same ids come out of it.
      if (typeof msg.content === 'string') out.push(...subagentNotified(live, msg.content));
      if (msg.type === 'system' && msg.subtype === 'init') {
        if (msg.session_id) turn.sessionId = msg.session_id;
        out.push({ kind: 'info', text: `Claude session started: model ${msg.model}` });
      } else if (msg.type === 'assistant' && msg.message && Array.isArray(msg.message.content)) {
        // Each assistant message reports the tokens of the request that made
        // it, cache reads included, so the sum is the live context size.
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
            const started = subagentStart(live, block);
            if (started) out.push(started);
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
      }
      return out;
    },
    flush() {
      return subagentFlush(live);
    },
  };
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
          // This usage is the SUM over every model call the turn made (a
          // 400-step turn reports millions of input tokens, cache reads
          // recounted on each call), so it is consumption, never the live
          // context size. That comes from the CLI's own token_count
          // accounting, read back from the thread's rollout file after the
          // turn (codexContextFromRollout in jobs.js); the exec --json stream
          // itself carries nothing finer (verified against codex 0.148).
          turn.inputTokens = (turn.inputTokens || 0) + (u.input_tokens || 0);
          turn.outputTokens = (turn.outputTokens || 0) + (u.output_tokens || 0);
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

// grok --output-format streaming-messages-json emits claude-code style
// stream-json: whole `system/init`, `assistant`, `user` and `result` messages
// (verified against grok 1.0: a turn is a handful of complete messages, one
// per line). The Anthropic Messages delta events the format name suggests are
// kept as a fallback in case a future grok streams real deltas.
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

// opencode's tool vocabulary, in the words the rest of the dashboard already
// uses for the same steps. Anything else goes to the log under its own name.
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

// `opencode run --format json` prints one JSON object per line, each
// {type, timestamp, sessionID, …}: `text` and `reasoning` (a finished block),
// `tool_use` (a tool part, and only once it has completed or failed, since the
// CLI mirrors no start, so a sub-agent has no live half to track), `step_start`,
// `step_finish` (the step's own tokens and cost) and `error`. There is no
// result message either: the stream ends when the session goes idle, so the
// turn's result is emitted from flush(), which is where the outcome (the CLI's
// exit code, or a cancellation) is finally known.
function opencodeParser(turn) {
  let steps = 0;
  let errored = false;
  // Every line is stamped, and the CLI states no duration of its own, so the
  // span the stream covers is what the turn took. It starts at the first line
  // rather than at the spawn, so the CLI's own startup is not counted as
  // agent time.
  let firstAt = null;
  let lastAt = null;
  return {
    feed(msg) {
      const out = [];
      if (typeof msg.timestamp === 'number') {
        if (firstAt == null) firstAt = msg.timestamp;
        lastAt = msg.timestamp;
      }
      // Every line carries the session it belongs to, which is how an id the
      // CLI assigned to a fresh session gets back here.
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
          // Per step, so the turn's consumption is their sum, while the
          // newest step's own request (its input, its cache traffic and what
          // it produced) is the live context size.
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
    // A turn that produced no step and reported no error has nothing to say:
    // the CLI's exit code is what ends it then. One whose stream did report an
    // error has to say so whether or not it got that far, since the CLI can
    // still exit 0 (a rejected model, a refused key) and a silent verdict
    // there reads as success. And one that produced steps and still failed
    // reports what it spent, but as the failure it was: the stream says
    // nothing about how the turn ended, so the caller's own verdict (a nonzero
    // exit, a cancellation) decides.
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

// A turn accumulator the parsers write side-channel data into. inputTokens /
// outputTokens are the turn's total consumption (cache reads included);
// contextTokens is the live context size; contextWindow the model's limit.
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

// Best-effort context window for binaries that never state one in their
// stream. claude does (result.modelUsage carries contextWindow live) so it
// needs no fallback; grok's model catalog is baked into its binary with 500k
// windows across the board; codex windows come from its own models cache,
// with the custom-endpoint catalog metadata as the fallback; opencode's come
// from the models.dev catalog its CLI caches.
export function contextWindowFor(binaryId, model, provider = null) {
  if (binaryId === 'grok') return 500000;
  if (binaryId === 'opencode') {
    const [service, ...rest] = String(model || '').split('/');
    const catalog = opencodeCatalog(provider ? [opencodeHomeDir(provider)] : []);
    return catalog[service]?.models?.[rest.join('/')]?.limit?.context || 200000;
  }
  if (binaryId === 'codex') {
    // A wide pick states its own window, and it is the one the turn asked for.
    const { slug, contextWindow } = splitCodexModel(model);
    if (contextWindow) return contextWindow;
    // The entry's own CODEX_HOME first (that is the cache the runs actually
    // fill), with the machine's ~/.codex as the fallback.
    const dirs = provider ? [codexHomeDir(provider)] : [];
    dirs.push(path.join(os.homedir(), '.codex'));
    for (const dir of dirs) {
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

// The markdown `claude -p "/context"` prints, parsed back into numbers: the
// total on a "**Tokens:** 24.3k / 200k (12%)" line, then one
// "| System prompt | 6.3k | 3.2% |" row per category under
// "### Estimated usage by category". The CLI prints rounded counts ("6.3k",
// "< 20"), so the numbers are estimates, which is what the command itself
// calls them.
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

// The settings page's Test button: probe an endpoint + token by asking it for
// its model list, the one call every gateway answers cheaply. Claude entries
// speak the Anthropic wire (x-api-key, /v1/models), codex entries the OpenAI
// wire (Bearer, /models); both put the ids in data[].id. Values come straight
// from the form, unsaved edits included, so a typo fails here instead of on
// a session's first turn. A gateway may not serve a model list at all: those
// failures carry routeMissing so callers can fall back to a chat probe.

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
    // Anthropic-compatible gateways are split on how they read the key: the
    // Anthropic API wants x-api-key, vLLM (and most OpenAI-shaped proxies)
    // only ever look at Authorization. Send both to a custom endpoint: the
    // real API ignores the extra header, a proxy ignores the one it doesn't use.
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
    // Which wire the endpoint speaks depends on the service the entry's models
    // name, which the model list route does not care about: every service
    // opencode knows publishes one at /models. The key goes out on both
    // headers, as for a claude gateway, since which one the endpoint reads is
    // the service's call too.
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
    // A missing route (404/405, or an HTML page) is not a verdict on the
    // token: the gateway may simply not publish a model list.
    err.routeMissing = body === null || res.status === 404 || res.status === 405;
    throw err;
  }
  const list = Array.isArray(body?.data) ? body.data : Array.isArray(body?.models) ? body.models : [];
  const models = list.map((m) => m.id || m.slug || m.name).filter(Boolean);
  // Some gateways (Z.AI among them) put auth errors in a 200 body.
  if (!models.length) throw new Error(`${url} answered 200 but no model list came back: ${detail()}`);
  return models;
}

// The fallback for gateways with no model list: the smallest possible chat
// call as the entry's own model: POST /responses on the codex wire, POST
// /v1/messages on the claude wire. An opencode entry speaks whichever wire
// the service its model names does: the anthropic one is the claude wire
// (with the URL already carrying /v1, the way opencode wants it), and every
// other service is taken for OpenAI-shaped, on /chat/completions since that
// is the route the gateways it points at all serve. Success is a response
// object in the body, not an HTTP status: Z.AI answers a bad key with 200
// and {"code":401,...}.
export async function probeChatEndpoint({ binary, baseUrl, apiKey, model }) {
  const base = (baseUrl || (binary === 'claude' ? 'https://api.anthropic.com' : '')).replace(/\/+$/, '');
  if (!base) throw new Error('There is no endpoint to probe');
  // opencode names a model <service>/<model>; the endpoint only knows the
  // second half.
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

// The automatic form of the Test button, run by the status banner: an entry
// on an API key only counts as connected once its endpoint has answered a
// live call: /models first, the chat probe when the gateway has no list.
// Cached for a minute: the settings page re-polls the status route, and the
// chat probe is a (tiny) paid call.
const endpointVerifyCache = new Map(); // binary|baseUrl|model|apiKey -> { at, value }
export async function verifyCustomEndpoint({ binary, baseUrl, apiKey, model }) {
  const key = [binary, baseUrl, model, apiKey].join('|');
  const hit = endpointVerifyCache.get(key);
  if (hit && Date.now() - hit.at < 60_000) return hit.value;
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

// Best-effort read of the logged-in account (email, display name, org, plan)
// from the binary's local credential store: the provider's own config dir
// when it has one, the developer's default store otherwise. Never throws;
// returns nulls when unknown.
export function providerAuthAccount(binaryId, provider = null) {
  const home = os.homedir();
  try {
    if (binaryId === 'claude') {
      // Every claude entry keeps its login in its own derived dir, where
      // .claude.json moves when CLAUDE_CONFIG_DIR is set.
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
      // Like claude, every codex entry keeps its login in its own derived dir.
      const dir = provider ? codexHomeDir(provider) : path.join(home, '.codex');
      const j = JSON.parse(fs.readFileSync(path.join(dir, 'auth.json'), 'utf8'));
      const idToken = j.tokens?.id_token;
      if (!idToken) return { email: null, name: null };
      const payload = JSON.parse(Buffer.from(idToken.split('.')[1], 'base64url').toString('utf8'));
      const oa = payload['https://api.openai.com/auth'] || {};
      return { email: payload.email || null, name: payload.name || null, plan: oa.chatgpt_plan_type || null };
    }
    if (binaryId === 'grok') {
      // Like the others, every grok entry keeps its login in its own dir.
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
// Every provider that meters its plan reports the same thing in its own
// shape: a set of rolling windows, each with how much of it is spent. They
// are normalized to one list, {label, short, usedPct, resetsAt}, because
// the windows themselves differ per plan (claude and codex bill 5 hours and
// 7 days; Z.AI's coding plan bills 5 hours and a day; grok bills credits over
// a billing month), and a bar labeled "week" over a day's quota would be a lie.
function usageWindows(windows) {
  const list = windows.filter((w) => w && w.usedPct != null);
  return list.length ? { windows: list } : null;
}

// Number.isFinite, not just typeof: a percentage derived from a division
// (grok's fallback) is NaN when the endpoint omits one of its terms, and NaN
// passes `!= null` into a bar reading "NaN% used".
function usedPct(n) {
  return Number.isFinite(n) ? Math.min(100, Math.max(0, Math.round(n))) : null;
}

// Best-effort read of a claude.ai login's subscription usage: the same
// numbers the CLI's /usage screen shows. The OAuth token is read from the
// account's credential store (default ~/.claude, or a provider's config dir);
// any failure (no token, expired, endpoint changed) just means no usage shown.
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
    if (!res.ok) return null;
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

// Best-effort read of a codex ChatGPT login's subscription usage: the same
// numbers the CLI's /status screen shows, from the backend's wham/usage
// endpoint. The access token and account id are read from the entry's
// auth.json; any failure (no login, custom endpoint, endpoint changed) just
// means no usage shown.
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
    // Which window is which varies by plan, so sort by length instead: anything
    // up to six hours reads as the session window, longer as the week.
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

// Best-effort read of an x.ai login's credit usage: the numbers the grok
// CLI's /usage modal shows, from the same cli-chat-proxy billing route it
// calls. grok meters credits over a billing month rather than rolling
// windows, so this is one bar, not two.
//
// The access token is whatever `grok login` last wrote into the entry's
// auth.json. Those live six hours and are refreshed by the CLI itself, never
// here: a refresh rotates the stored refresh token, and losing that rotation
// would log the entry out. So a login idle longer than that simply shows no
// bar until its next session, the same best-effort contract claude and codex
// keep with an expired token.
export async function grokUsage(configDir) {
  const home = os.homedir();
  try {
    const dir = configDir || path.join(home, '.grok');
    const store = JSON.parse(fs.readFileSync(path.join(dir, 'auth.json'), 'utf8'));
    // auth.json is keyed by "<issuer>::<client id>"; one login per dir, so the
    // first entry carrying a token is it.
    const entry = Object.values(store).find((e) => e && typeof e === 'object' && e.key);
    if (!entry || typeof fetch !== 'function') return null;
    if (entry.expires_at && Date.parse(entry.expires_at) <= Date.now()) return null;
    const res = await fetch('https://cli-chat-proxy.grok.com/v1/billing?format=credits', {
      headers: { Authorization: `Bearer ${entry.key}`, 'x-grok-client-mode': 'cli' },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    const b = await res.json();
    // creditUsagePercent is what the modal's bar shows; the period's own
    // totals are the fallback when the endpoint omits it.
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

// Z.AI's coding plan meters the API key itself, so its usage lives behind the
// key rather than behind a login: GET /api/monitor/usage/quota/limit on the
// endpoint's own host, with the key sent raw: a `Bearer` prefix is answered
// with "Authentication Failed". Undocumented but stable enough that the
// editor plugins around the plan all read it; any change here just means no
// bars, never a broken status panel.
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

// A limit names its window as a count plus a unit code. Only two codes have
// been seen on a live plan (3 with number 5 for the 5-hour window, 6 with
// number 1 for the daily one) and the enum is not published, so anything
// else is shown as a bar without claiming a period for it.
const ZAI_UNITS = { 3: ['hour', 'h'], 6: ['day', 'd'] };
function zaiWindowLabel(limit) {
  const unit = ZAI_UNITS[limit.unit];
  const n = limit.number;
  if (!unit || !n) return { label: 'Plan quota', short: 'plan' };
  return { label: `Quota (${n}-${unit[0]} window)`, short: `${n}${unit[1]}` };
}

// Best-effort auth probe for one provider row. Claude-binary providers are
// probed by the server itself (`claude auth status` per config dir), so they
// resolve to null here.
export function probeProviderAuth(provider, _cfg) {
  return new Promise((resolve) => {
    if (provider.binary === 'claude') {
      return resolve(null);
    }
    if (provider.binary === 'codex') {
      // A custom endpoint has no login flow: the codex CLI authenticates with
      // the provider's stored API key, verified with a live call to the
      // endpoint rather than assumed from the key's presence.
      if (provider.baseUrl) {
        return resolve(
          verifyCustomEndpoint({
            binary: 'codex',
            baseUrl: provider.baseUrl,
            apiKey: provider.apiKey,
            model: provider.defaultModel || provider.models[0] || null,
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
      // Like codex: materialize the entry's dir from the database, then look
      // for the login.
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
      // There is no login to look for: an opencode entry is its API key, and
      // the key needs a model to say which service it is for, since opencode
      // keys every credential by service.
      if (!provider.apiKey) {
        return resolve({ loggedIn: false, detail: 'no API key yet: add one on the settings page' });
      }
      // Empty only when the entry's model is not named the way opencode names
      // one, since an entry that names none at all falls back to the binary's
      // default, which carries a service of its own.
      const service = opencodeServiceId(provider);
      if (!service) {
        return resolve({
          loggedIn: false,
          detail:
            "the API key has no service: name this entry's model the way opencode does, <service>/<model>, so the key can be filed under it",
        });
      }
      // A custom endpoint is verified with a live call, as on codex: the key
      // being there says nothing about whether the URL answers to it.
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
