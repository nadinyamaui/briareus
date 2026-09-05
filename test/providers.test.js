import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import {
  BINARIES,
  getBinary,
  newTurn,
  parserFor,
  parseContextReport,
  contextWindowFor,
  grokUsage,
  zaiUsage,
  canResume,
  opencodeServiceId,
  opencodeAuthContent,
  opencodeConfigContent,
  refreshCodexModelCache,
  splitCodexModel,
  codexWideVariants,
  testProviderEndpoint,
  probeChatEndpoint,
} from '../lib/providers.js';

// providers.js imports no project module, so nothing is mocked here: the
// parsers, the arg builders and the report reader are exercised as they are.

describe('getBinary / BINARIES', () => {
  it('knows the four binaries and nothing else', () => {
    expect(Object.keys(BINARIES)).toEqual(['claude', 'codex', 'grok', 'opencode']);
    expect(getBinary('claude').label).toBe('Claude Code');
    expect(getBinary('vim')).toBeNull();
  });

  it('every binary declares the same surface', () => {
    for (const b of Object.values(BINARIES)) {
      expect(b.efforts.length).toBeGreaterThan(0);
      expect(typeof b.buildArgs).toBe('function');
      expect(typeof b.reviewPrompt).toBe('function');
    }
  });
});

describe('the Codex model cache refresh', () => {
  function appServer() {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stdin = new PassThrough();
    child.kill = vi.fn();
    const requests = [];
    child.stdin.on('data', (chunk) => {
      for (const line of String(chunk).trim().split('\n')) {
        const request = JSON.parse(line);
        requests.push(request);
        if (request.id === 0) {
          child.stdout.write(`${JSON.stringify({ id: 0, result: { codexHome: '/tmp/codex' } })}\n`);
        } else if (request.id === 1) {
          child.stdout.write(
            `${JSON.stringify({
              id: 1,
              result: { data: [{ id: 'gpt-6-astra' }, { id: 'gpt-5.6-sol' }] },
            })}\n`,
          );
        }
      }
    });
    return { child, requests };
  }

  it('initializes app-server and asks it for the visible model catalog', async () => {
    const { child, requests } = appServer();
    const spawnProcess = vi.fn(() => child);
    const provider = { id: 7, binary: 'codex', baseUrl: '', apiKey: '', authData: {}, models: [] };

    await expect(
      refreshCodexModelCache(
        provider,
        { codexBin: process.execPath },
        {
          spawnProcess,
          ensureHome: () => '/tmp/codex-provider-7',
        },
      ),
    ).resolves.toEqual(['gpt-6-astra', 'gpt-5.6-sol']);

    expect(spawnProcess).toHaveBeenCalledWith(
      process.execPath,
      ['app-server'],
      expect.objectContaining({ env: expect.objectContaining({ CODEX_HOME: '/tmp/codex-provider-7' }) }),
    );
    expect(requests.map(({ method }) => method)).toEqual(['initialize', 'initialized', 'model/list']);
    expect(requests[2].params).toEqual({ limit: 100, includeHidden: false });
    expect(child.kill).toHaveBeenCalledOnce();
  });

  it('leaves a custom-endpoint catalog alone', async () => {
    const spawnProcess = vi.fn();
    const provider = { id: 8, binary: 'codex', baseUrl: 'https://example.test', apiKey: 'key' };

    await expect(refreshCodexModelCache(provider, {}, { spawnProcess })).resolves.toEqual([]);
    expect(spawnProcess).not.toHaveBeenCalled();
  });

  it("offers the provider's refreshed visible models instead of the machine cache", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'briareus-codex-models-'));
    const provider = { id: 9 };
    try {
      fs.mkdirSync(path.join(home, '.codex-provider-9'));
      fs.mkdirSync(path.join(home, '.codex'));
      fs.writeFileSync(
        path.join(home, '.codex-provider-9', 'models_cache.json'),
        JSON.stringify({
          models: [
            { slug: 'gpt-6-astra', visibility: 'list' },
            { slug: 'gpt-reserve', visibility: 'hide' },
            { slug: 'codex-auto-review', visibility: 'hide' },
          ],
        }),
      );
      fs.writeFileSync(
        path.join(home, '.codex', 'models_cache.json'),
        JSON.stringify({ models: [{ slug: 'stale-machine-model', visibility: 'list' }] }),
      );

      expect(BINARIES.codex.models({}, provider, home)).toEqual(['gpt-6-astra']);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('the wide-window twin of a codex model', () => {
  // A catalog covering every branch: one model sold at two sizes, one sold at
  // one, and one whose ceiling is not a whole number of thousands.
  const catalog = {
    models: [
      { slug: 'gpt-6-astra', visibility: 'list', context_window: 272000, max_context_window: 872000 },
      { slug: 'gpt-5.5', visibility: 'list', context_window: 272000, max_context_window: 272000 },
      { slug: 'gpt-odd', visibility: 'list', context_window: 200000, max_context_window: 262144 },
    ],
  };

  const withCatalog = (run) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'briareus-codex-wide-'));
    try {
      fs.mkdirSync(path.join(home, '.codex-provider-9'));
      fs.writeFileSync(path.join(home, '.codex-provider-9', 'models_cache.json'), JSON.stringify(catalog));
      run(home);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  };

  it('reads a picked label back as a slug and a window', () => {
    expect(splitCodexModel('gpt-6-astra (872k)')).toEqual({ slug: 'gpt-6-astra', contextWindow: 872000 });
    expect(splitCodexModel('gpt-6-astra')).toEqual({ slug: 'gpt-6-astra', contextWindow: null });
    expect(splitCodexModel('')).toEqual({ slug: '', contextWindow: null });
    expect(splitCodexModel(undefined)).toEqual({ slug: '', contextWindow: null });
  });

  it('offers a twin only for a model the catalog sells at two sizes', () => {
    withCatalog((home) => {
      expect(codexWideVariants(['gpt-6-astra', 'gpt-5.5'], { id: 9 }, home)).toEqual([
        'gpt-6-astra',
        'gpt-6-astra (872k)',
        'gpt-5.5',
      ]);
    });
  });

  it('skips a ceiling that would not survive the round trip through the label', () => {
    withCatalog((home) => {
      expect(codexWideVariants(['gpt-odd'], { id: 9 }, home)).toEqual(['gpt-odd']);
    });
  });

  it('never grows a twin of a twin', () => {
    withCatalog((home) => {
      expect(codexWideVariants(['gpt-6-astra (872k)'], { id: 9 }, home)).toEqual(['gpt-6-astra (872k)']);
    });
  });

  it('leaves the list alone when no catalog has been cached yet', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'briareus-codex-nocat-'));
    try {
      expect(codexWideVariants(['gpt-6-astra'], { id: 9 }, home)).toEqual(['gpt-6-astra']);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('puts the twin in the picker beside the model it widens', () => {
    withCatalog((home) => {
      expect(BINARIES.codex.models({}, { id: 9 }, home)).toEqual([
        'gpt-6-astra',
        'gpt-6-astra (872k)',
        'gpt-5.5',
        'gpt-odd',
      ]);
    });
  });
});

describe('buildArgs', () => {
  it('claude resumes with --resume and starts with --session-id', () => {
    const resumed = BINARIES.claude.buildArgs({
      model: 'm',
      effort: 'high',
      resume: true,
      sessionId: 'sid',
    });
    expect(resumed.args).toContain('--resume');
    expect(resumed.args).not.toContain('--session-id');
    const fresh = BINARIES.claude.buildArgs({ model: 'm', effort: 'high', resume: false, sessionId: 'sid' });
    expect(fresh.args).toContain('--session-id');
    expect(fresh.args).not.toContain('--resume');
  });

  it('claude only appends a system prompt file when one exists', () => {
    const withFile = BINARIES.claude.buildArgs({
      model: 'm',
      effort: 'low',
      sessionId: 's',
      sysPromptFile: '/tmp/f',
    });
    expect(withFile.args).toContain('--append-system-prompt-file');
    const without = BINARIES.claude.buildArgs({ model: 'm', effort: 'low', sessionId: 's' });
    expect(without.args).not.toContain('--append-system-prompt-file');
    expect(without.promptVia).toBe('stdin');
    expect(without.briefingInPrompt).toBe(false);
  });

  it('codex has no system-prompt flag, so the briefing rides in the prompt', () => {
    const built = BINARIES.codex.buildArgs({ model: 'gpt', effort: 'high', resume: true, sessionId: 't1' });
    expect(built.args.slice(0, 3)).toEqual(['exec', 'resume', 't1']);
    expect(built.args).toContain('model_reasoning_effort="high"');
    expect(built.briefingInPrompt).toBe(true);
  });

  it('codex sends a wide pick as its real slug plus the window override', () => {
    for (const build of [BINARIES.codex.buildArgs, BINARIES.codex.buildReviewArgs]) {
      const wide = build({ model: 'gpt-6-astra (872k)', effort: 'high', sessionId: 't' });
      // The label never reaches argv: codex refuses a model its catalog has
      // no entry for, and "gpt-6-astra (872k)" is a picker string, not a model.
      expect(wide.args).toContain('gpt-6-astra');
      expect(wide.args).not.toContain('gpt-6-astra (872k)');
      expect(wide.args[wide.args.indexOf('-m') + 1]).toBe('gpt-6-astra');
      expect(wide.args).toContain('model_context_window=872000');
    }
  });

  it('codex leaves the window alone on a plain pick', () => {
    for (const build of [BINARIES.codex.buildArgs, BINARIES.codex.buildReviewArgs]) {
      const plain = build({ model: 'gpt-6-astra', effort: 'high', sessionId: 't' });
      expect(plain.args[plain.args.indexOf('-m') + 1]).toBe('gpt-6-astra');
      expect(plain.args.some((a) => String(a).startsWith('model_context_window='))).toBe(false);
    }
  });

  it('claude mounts the memory tool only when a config file is given', () => {
    const withMcp = BINARIES.claude.buildArgs({
      model: 'm',
      effort: 'low',
      sessionId: 's',
      mcpConfigFile: '/tmp/m',
    });
    expect(withMcp.args).toContain('--mcp-config');
    expect(withMcp.args[withMcp.args.indexOf('--mcp-config') + 1]).toBe('/tmp/m');
    const without = BINARIES.claude.buildArgs({ model: 'm', effort: 'low', sessionId: 's' });
    expect(without.args).not.toContain('--mcp-config');
  });

  it('codex takes the memory tool as TOML config overrides', () => {
    const mcp = {
      name: 'reviewer_memory',
      command: '/usr/bin/node',
      args: ['/app/lib/memory-mcp.js'],
      env: { A: '1', B: 'x"y' },
    };
    for (const build of [BINARIES.codex.buildArgs, BINARIES.codex.buildReviewArgs]) {
      const { args } = build({ model: 'gpt', effort: 'high', sessionId: 't', mcp });
      expect(args).toContain('mcp_servers.reviewer_memory.command="/usr/bin/node"');
      expect(args).toContain('mcp_servers.reviewer_memory.args=["/app/lib/memory-mcp.js"]');
      expect(args).toContain('mcp_servers.reviewer_memory.env={ A = "1", B = "x\\"y" }');
    }
    const plain = BINARIES.codex.buildArgs({ model: 'gpt', effort: 'high', sessionId: 't' });
    expect(plain.args.join(' ')).not.toContain('mcp_servers');
  });

  it('grok takes the prompt from a file: argv survives neither newlines nor long messages', () => {
    const built = BINARIES.grok.buildArgs({
      model: 'grok-4.6',
      effort: 'low',
      sessionId: 's',
      promptFile: '/tmp/p',
    });
    expect(built.args.slice(0, 2)).toEqual(['--prompt-file', '/tmp/p']);
    expect(built.promptVia).toBe('file');
  });

  it('opencode resumes only an id its own CLI issued, and takes the effort as a variant', () => {
    const fresh = BINARIES.opencode.buildArgs({
      model: 'anthropic/claude-sonnet-4-5',
      effort: 'high',
      resume: false,
      sessionId: 'ses_1',
    });
    expect(fresh.args.slice(0, 3)).toEqual(['run', '--format', 'json']);
    expect(fresh.args).toContain('--variant');
    expect(fresh.args[fresh.args.indexOf('--variant') + 1]).toBe('high');
    expect(fresh.args).toContain('--auto');
    expect(fresh.args).not.toContain('--session');
    expect(fresh.promptVia).toBe('stdin');
    expect(fresh.briefingInPrompt).toBe(true);

    const resumed = BINARIES.opencode.buildArgs({
      model: 'm',
      effort: 'low',
      resume: true,
      sessionId: 'ses_1',
    });
    expect(resumed.args.slice(-2)).toEqual(['--session', 'ses_1']);
    // The UUID a session is created with is not one of opencode's, so resuming
    // it would only make the CLI exit on "Session not found".
    const uuid = BINARIES.opencode.buildArgs({
      model: 'm',
      effort: 'low',
      resume: true,
      sessionId: '0f9d1e7a-9f3a-4a41-8f5f-0c4b8c9a1d22',
    });
    expect(uuid.args).not.toContain('--session');
  });

  it('a session id opencode never issued is not a resume, it is a fresh conversation', () => {
    // A first turn killed before the CLI printed an id of its own leaves the
    // UUID the session was created with. Resuming that would start a new
    // conversation anyway; what matters is that the caller knows, since an
    // unbriefed conversation is one that does not know where it is working.
    expect(canResume('opencode', 'ses_abc')).toBe(true);
    expect(canResume('opencode', '0f9d1e7a-9f3a-4a41-8f5f-0c4b8c9a1d22')).toBe(false);
    expect(canResume('opencode', '')).toBe(false);
    // The others pick up whatever id they were given, as they always have.
    for (const id of ['claude', 'codex', 'grok']) {
      expect(canResume(id, '0f9d1e7a-9f3a-4a41-8f5f-0c4b8c9a1d22')).toBe(true);
    }
  });

  it("opencode files its key under the service the turn's own model names", () => {
    const entry = { defaultModel: 'anthropic/claude-sonnet-4-5', models: [], apiKey: 'k' };
    // The entry's default when the caller has no turn in hand…
    expect(opencodeServiceId(entry)).toBe('anthropic');
    expect(JSON.parse(opencodeAuthContent(entry))).toEqual({ anthropic: { type: 'api', key: 'k' } });
    // …and the turn's own model when it has, since a step can move a turn onto
    // another of the entry's models, whose service the key must be filed under.
    expect(opencodeServiceId(entry, 'openai/gpt-5.1-codex')).toBe('openai');
    expect(JSON.parse(opencodeAuthContent(entry, 'openai/gpt-5.1-codex'))).toEqual({
      openai: { type: 'api', key: 'k' },
    });
  });

  it('an opencode entry that names no model still resolves: a turn there runs on the binary default', () => {
    const bare = { defaultModel: '', models: [], apiKey: 'k' };
    expect(opencodeServiceId(bare)).toBe(BINARIES.opencode.defaultModel().split('/')[0]);
    expect(opencodeAuthContent(bare)).not.toBeNull();
    // A model not named the way opencode names one has no service to file under.
    expect(opencodeServiceId({ defaultModel: 'gpt-5.1', models: [] })).toBe('');
    expect(opencodeAuthContent({ defaultModel: 'gpt-5.1', models: [], apiKey: 'k' })).toBeNull();
    // No key, no store to hand over.
    expect(opencodeAuthContent({ defaultModel: 'anthropic/x', models: [], apiKey: '' })).toBeNull();
  });

  it("opencode hangs its endpoint on the service the turn's model names, as an inline config", () => {
    const entry = {
      defaultModel: 'anthropic/claude-sonnet-4-5',
      models: [],
      apiKey: 'k',
      baseUrl: 'https://x.test/v1',
    };
    expect(JSON.parse(opencodeConfigContent(entry))).toEqual({
      provider: { anthropic: { options: { baseURL: 'https://x.test/v1' } } },
    });
    // A step that moved the turn onto another of the entry's models moves the
    // URL with it, like the key.
    expect(JSON.parse(opencodeConfigContent(entry, 'openai/gpt-5.1-codex'))).toEqual({
      provider: { openai: { options: { baseURL: 'https://x.test/v1' } } },
    });
    // No endpoint, or no service to hang it on: no config at all, so the
    // service's own URL stays in force.
    expect(opencodeConfigContent({ ...entry, baseUrl: '' })).toBeNull();
    expect(opencodeConfigContent({ ...entry, defaultModel: 'gpt-5.1' })).toBeNull();
  });

  it('an opencode entry always offers its own model, cache or no cache', () => {
    // No models.dev cache exists for a service nobody has run yet, and a
    // stale one would drop the configured model just as readily, leaving
    // providerDefaultModel to run some other model, which is the one thing
    // that could never refresh the cache.
    const entry = { defaultModel: 'google/gemini-2.5-pro', models: [], apiKey: 'k' };
    expect(BINARIES.opencode.models({}, entry)).toContain('google/gemini-2.5-pro');
    // An entry that names nothing at all falls back to the binary's own default.
    expect(BINARIES.opencode.models({}, { defaultModel: '', models: [] })).toEqual([
      BINARIES.opencode.defaultModel(),
    ]);
  });

  it('the review prompts carry the shared machine-readable findings contract', () => {
    for (const [id, opts] of [
      ['claude', { prNumber: 7, effort: 'high' }],
      ['codex', { prNumber: 7, branch: 'b', base: 'main' }],
      ['grok', { prNumber: 7 }],
      ['opencode', { prNumber: 7, branch: 'b', base: 'main' }],
    ]) {
      expect(BINARIES[id].reviewPrompt(opts)).toContain('reviewer:findings');
    }
  });
});

describe('parseContextReport', () => {
  const report = [
    'some preamble',
    '**Tokens:** 24.3k / 200k (12%)',
    '',
    '### Estimated usage by category',
    '',
    '| Category | Tokens | Share |',
    '| System prompt | 6.3k | 3.2% |',
    '| Messages | 18k | 9.0% |',
    '',
    '### Something else',
    '| Not a category | 1k | 1.0% |',
  ].join('\n');

  it('reads the totals and the category rows, stopping at the next section', () => {
    const parsed = parseContextReport(report);
    expect(parsed.tokens).toBe(24300);
    expect(parsed.window).toBe(200000);
    expect(parsed.categories).toEqual([
      { name: 'System prompt', tokens: 6300, pct: 3.2 },
      { name: 'Messages', tokens: 18000, pct: 9.0 },
    ]);
  });

  it('reads a 1M window the CLI prints lowercased', () => {
    expect(parseContextReport('**Tokens:** 900k / 1m (90%)').window).toBe(1000000);
  });

  it('answers null for text with neither a head line nor categories', () => {
    expect(parseContextReport('nothing to see')).toBeNull();
    expect(parseContextReport('')).toBeNull();
    expect(parseContextReport(null)).toBeNull();
  });
});

describe('contextWindowFor', () => {
  it("grok's whole catalog ships 500k windows", () => {
    expect(contextWindowFor('grok', 'grok-4.6')).toBe(500000);
  });

  it('claude states its window in the stream, so no fallback exists', () => {
    expect(contextWindowFor('claude', 'claude-fable-5-1')).toBeNull();
  });

  it('codex falls back to the catalog metadata, then the generic window', () => {
    expect(contextWindowFor('codex', 'glm-5.3')).toBe(1048576);
    expect(contextWindowFor('codex', 'model-nobody-knows')).toBe(262144);
  });

  it('takes a wide pick at its word rather than the model default', () => {
    expect(contextWindowFor('codex', 'glm-5.3 (872k)')).toBe(872000);
    // The slug underneath is still what an unwidened pick resolves against.
    expect(contextWindowFor('codex', 'glm-5-turbo')).toBe(204800);
  });
});

describe('parserFor', () => {
  it('throws on a binary nobody wrote a parser for', () => {
    expect(() => parserFor('vim', newTurn())).toThrow(/Unknown binary: vim/);
  });
});

describe('the claude parser', () => {
  function feedAll(messages) {
    const turn = newTurn();
    const parser = parserFor('claude', turn);
    const events = messages.flatMap((m) => parser.feed(m));
    return { turn, parser, events };
  }

  it('reads the session id off init and announces the model', () => {
    const { turn, events } = feedAll([
      { type: 'system', subtype: 'init', session_id: 'sid-1', model: 'fable' },
    ]);
    expect(turn.sessionId).toBe('sid-1');
    expect(events[0]).toEqual({ kind: 'info', text: 'Claude session started: model fable' });
  });

  it('turns assistant blocks into text and tool events, tracking live context', () => {
    const { turn, events } = feedAll([
      {
        type: 'assistant',
        message: {
          usage: { input_tokens: 10, cache_read_input_tokens: 90, output_tokens: 5 },
          content: [
            { type: 'text', text: 'thinking out loud' },
            { type: 'text', text: '   ' }, // whitespace-only never reaches the log
            { type: 'tool_use', name: 'Bash', input: { command: 'ls -la', description: 'ignored' } },
          ],
        },
      },
    ]);
    expect(turn.contextTokens).toBe(105);
    expect(events).toEqual([
      { kind: 'text', text: 'thinking out loud' },
      { kind: 'tool', name: 'Bash', summary: 'ls -la' },
    ]);
  });

  it('summarizes tool input by precedence: command, then prompt, then file_path', () => {
    const tool = (input, name = 'X') =>
      feedAll([{ type: 'assistant', message: { content: [{ type: 'tool_use', name, input }] } }]).events[0];
    expect(tool({ prompt: 'p', file_path: '/f' }).summary).toBe('p');
    expect(tool({ file_path: '/f', pattern: 'x' }).summary).toBe('/f');
    expect(tool({ pattern: 'TODO' }).summary).toBe('TODO');
    expect(tool({ other: 1 }).summary).toBe('{"other":1}');
    // description only summarizes the agent tools
    expect(tool({ description: 'd' }, 'Agent').summary).toBe('d');
    expect(tool({ description: 'd' }, 'Bash').summary).toBe('{"description":"d"}');
    expect(tool({ command: 'x'.repeat(300) }).summary).toHaveLength(201); // 200 + ellipsis
  });

  it('lifts AskUserQuestion out as ask events, or logs a malformed call as the tool step it was', () => {
    const asked = feedAll([
      {
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              name: 'AskUserQuestion',
              input: {
                questions: [
                  {
                    question: 'Which?',
                    header: 'Pick',
                    multiSelect: false,
                    options: [{ label: 'A', description: 'first' }, { description: 'no label, dropped' }],
                  },
                ],
              },
            },
          ],
        },
      },
    ]);
    expect(asked.events).toEqual([
      {
        kind: 'ask',
        question: 'Which?',
        header: 'Pick',
        multiSelect: false,
        options: [{ label: 'A', description: 'first' }],
      },
    ]);

    const malformed = feedAll([
      {
        type: 'assistant',
        message: { content: [{ type: 'tool_use', name: 'AskUserQuestion', input: { nope: true } }] },
      },
    ]);
    expect(malformed.events[0].kind).toBe('tool');
  });

  it('tracks a sub-agent from its Agent call to its tool_result', () => {
    const { events } = feedAll([
      {
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'call-1',
              name: 'Agent',
              input: { subagent_type: 'Explore', description: 'map the code' },
            },
          ],
        },
      },
      {
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 'call-1', content: 'done' }] },
      },
    ]);
    expect(events).toContainEqual({
      kind: 'agent',
      state: 'start',
      id: 'call-1',
      name: 'Explore',
      summary: 'map the code',
    });
    expect(events).toContainEqual({ kind: 'agent', state: 'end', id: 'call-1' });
  });

  it('a backgrounded agent stays live until its task-notification arrives', () => {
    const turn = newTurn();
    const parser = parserFor('claude', turn);
    parser.feed({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: 'bg-1', name: 'Agent', input: { prompt: 'go' } }] },
    });
    // The launch acknowledgment is not the end of the work.
    const onLaunch = parser.feed({
      type: 'user',
      message: {
        content: [
          { type: 'tool_result', tool_use_id: 'bg-1', content: 'Async agent launched successfully.' },
        ],
      },
    });
    expect(onLaunch.find((e) => e.kind === 'agent' && e.state === 'end')).toBeUndefined();
    // The notification names the tool call, and that is what ends it.
    const onNotify = parser.feed({
      type: 'user',
      message: {
        content: '<task-notification><tool-use-id>bg-1</tool-use-id></task-notification>',
      },
    });
    expect(onNotify).toContainEqual({ kind: 'agent', state: 'end', id: 'bg-1' });
  });

  it('flush ends whatever a dead stream left running', () => {
    const turn = newTurn();
    const parser = parserFor('claude', turn);
    parser.feed({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: 'zombie', name: 'Task', input: {} }] },
    });
    expect(parser.flush()).toEqual([{ kind: 'agent', state: 'end', id: 'zombie' }]);
    expect(parser.flush()).toEqual([]); // ended once, not every flush
  });

  it('surfaces tool_result errors, truncated', () => {
    const { events } = feedAll([
      {
        type: 'user',
        message: {
          content: [{ type: 'tool_result', tool_use_id: 'x', is_error: true, content: 'e'.repeat(600) }],
        },
      },
    ]);
    expect(events[0].kind).toBe('tool_error');
    expect(events[0].text).toHaveLength(501);
  });

  it('the result message settles cost, duration and turn-wide usage', () => {
    const { turn, events } = feedAll([
      {
        type: 'result',
        subtype: 'success',
        session_id: 'sid-9',
        total_cost_usd: 0.42,
        duration_ms: 12000,
        num_turns: 3,
        result: 'all done',
        usage: { input_tokens: 100, cache_read_input_tokens: 900, output_tokens: 50 },
        modelUsage: { a: { contextWindow: 200000 }, b: { contextWindow: 1000000 } },
      },
    ]);
    expect(turn).toMatchObject({
      sessionId: 'sid-9',
      costUsd: 0.42,
      durationMs: 12000,
      inputTokens: 1000,
      outputTokens: 50,
      contextWindow: 1000000, // the max across models, not the last one
    });
    expect(events[0]).toMatchObject({ kind: 'result', subtype: 'success', isError: false, numTurns: 3 });
  });
});

describe('the codex parser', () => {
  function feedAll(messages) {
    const turn = newTurn();
    const parser = parserFor('codex', turn);
    const events = messages.flatMap((m) => parser.feed(m));
    return { turn, events };
  }

  it('reads the thread id as the session', () => {
    const { turn } = feedAll([{ type: 'thread.started', thread_id: 't-1' }]);
    expect(turn.sessionId).toBe('t-1');
  });

  it('a command is a tool when it starts and an error only when it exits non-zero', () => {
    const { events } = feedAll([
      { type: 'item.started', item: { item_type: 'command_execution', command: 'npm test' } },
      { type: 'item.completed', item: { item_type: 'command_execution', command: 'npm test', exit_code: 0 } },
      {
        type: 'item.completed',
        item: { item_type: 'command_execution', command: 'bad', exit_code: 2, aggregated_output: 'boom' },
      },
    ]);
    expect(events).toEqual([
      { kind: 'tool', name: 'Shell', summary: 'npm test' },
      { kind: 'tool_error', text: 'exit 2: boom' },
    ]);
  });

  it('accumulates usage across model calls: consumption, never context size', () => {
    const { turn, events } = feedAll([
      { type: 'turn.completed', usage: { input_tokens: 100, output_tokens: 10 } },
      { type: 'turn.completed', usage: { input_tokens: 200, output_tokens: 20 } },
    ]);
    expect(turn.inputTokens).toBe(300);
    expect(turn.outputTokens).toBe(30);
    expect(events.every((e) => e.kind === 'result' && e.tokens === null)).toBe(true);
  });

  it('a failed turn is an error result with the message', () => {
    const { events } = feedAll([{ type: 'turn.failed', error: { message: 'quota' } }]);
    expect(events[0]).toMatchObject({ kind: 'result', isError: true, text: 'quota' });
  });
});

describe('the opencode parser', () => {
  function fresh() {
    const turn = newTurn();
    const parser = parserFor('opencode', turn);
    // Every line names the session, so the first one of a turn (whichever it
    // is) also announces it; the tests below are about what follows.
    const feed = (msg) => parser.feed(msg).filter((e) => e.kind !== 'info');
    return { turn, parser, feed };
  }

  const step = (input, output, reasoning, read, cost, timestamp = undefined) => ({
    type: 'step_finish',
    sessionID: 'ses_1',
    timestamp,
    part: { type: 'step-finish', cost, tokens: { input, output, reasoning, cache: { read, write: 0 } } },
  });

  it('reads the session id off the first line, whichever line that is', () => {
    const { turn, parser } = fresh();
    const events = parser.feed({ type: 'text', sessionID: 'ses_abc', part: { text: 'hi' } });
    expect(turn.sessionId).toBe('ses_abc');
    expect(events).toEqual([
      { kind: 'info', text: 'opencode session started: ses_abc' },
      { kind: 'text', text: 'hi' },
    ]);
    // Only announced once, however many lines carry the id.
    expect(parser.feed({ type: 'text', sessionID: 'ses_abc', part: { text: 'more' } })).toEqual([
      { kind: 'text', text: 'more' },
    ]);
  });

  it('logs a completed tool under the name the rest of the dashboard uses', () => {
    const { feed } = fresh();
    expect(
      feed({
        type: 'tool_use',
        sessionID: 'ses_1',
        part: { type: 'tool', tool: 'bash', state: { status: 'completed', input: { command: 'npm test' } } },
      }),
    ).toEqual([{ kind: 'tool', name: 'Shell', summary: 'npm test' }]);
  });

  it('a failed tool is both the step it was and the error it ended in', () => {
    const { feed } = fresh();
    const events = feed({
      type: 'tool_use',
      sessionID: 'ses_1',
      part: {
        type: 'tool',
        tool: 'read',
        state: { status: 'error', input: { file_path: '/x' }, error: 'no such file' },
      },
    });
    expect(events).toEqual([
      { kind: 'tool', name: 'Read', summary: '/x' },
      { kind: 'tool_error', text: 'no such file' },
    ]);
  });

  it('sums the steps as consumption and takes the newest one as the live context', () => {
    const { turn, parser } = fresh();
    parser.feed(step(100, 10, 5, 900, 0.01));
    parser.feed(step(200, 20, 0, 1800, 0.02));
    // input + cache read, and output + reasoning, across both steps
    expect(turn.inputTokens).toBe(3000);
    expect(turn.outputTokens).toBe(35);
    // the second step's own request, which is what the context now holds
    expect(turn.contextTokens).toBe(2020);
    expect(turn.costUsd).toBeCloseTo(0.03);
  });

  it('closes the turn from flush, since the stream carries no result message', () => {
    const { parser } = fresh();
    parser.feed(step(100, 10, 0, 0, 0.5));
    expect(parser.flush({ canceled: false, code: 0 })).toEqual([
      {
        kind: 'result',
        subtype: 'success',
        isError: false,
        costUsd: 0.5,
        // A single unstamped line spans nothing, so the turn reports no time.
        durationMs: null,
        tokens: 110,
        inputTokens: 100,
        outputTokens: 10,
      },
    ]);
  });

  it('times the turn by the span its own stream covers, since the CLI states no duration', () => {
    const { turn, parser, feed } = fresh();
    feed(step(10, 1, 0, 0, 0, 1_000_000));
    feed(step(20, 2, 0, 0, 0, 1_012_500));
    expect(parser.flush({ code: 0 })[0].durationMs).toBe(12500);
    expect(turn.durationMs).toBe(12500);
  });

  it('a turn that spent tokens and still failed reports the spend as the failure it was', () => {
    // The stream says nothing about how the turn ended, so the caller's
    // verdict decides: a nonzero exit, a cancellation, or an error mid-stream.
    for (const outcome of [{ code: 1 }, { canceled: true }]) {
      const { parser } = fresh();
      parser.feed(step(100, 10, 0, 0, 0.5));
      expect(parser.flush(outcome)[0]).toMatchObject({ subtype: 'error', isError: true, costUsd: 0.5 });
    }
    const { parser, feed } = fresh();
    feed(step(100, 10, 0, 0, 0.5));
    feed({ type: 'error', sessionID: 'ses_1', error: { name: 'ProviderAuthError' } });
    expect(parser.flush({ code: 0 })[0]).toMatchObject({ subtype: 'error', isError: true });
  });

  it("an error before the first step is still the turn's verdict, whatever the CLI exits", () => {
    const { parser, feed } = fresh();
    const events = feed({
      type: 'error',
      sessionID: 'ses_1',
      error: { name: 'ProviderAuthError', data: { message: 'bad key' } },
    });
    expect(events).toEqual([{ kind: 'tool_error', text: 'bad key' }]);
    // A rejected model or a refused key can still exit 0, and a silent verdict
    // there would read as a successful turn.
    expect(parser.flush({ code: 0 })[0]).toMatchObject({ kind: 'result', isError: true });
  });

  it('a turn that neither stepped nor errored says nothing; its exit code speaks for it', () => {
    const { parser } = fresh();
    expect(parser.flush({ code: 1 })).toEqual([]);
  });
});

describe('the grok parser', () => {
  function fresh() {
    const turn = newTurn();
    return { turn, parser: parserFor('grok', turn) };
  }

  it('reassembles streamed text deltas per block index', () => {
    const { parser } = fresh();
    parser.feed({ type: 'content_block_start', index: 0, content_block: { type: 'text' } });
    parser.feed({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hola ' } });
    parser.feed({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'mundo' } });
    const events = parser.feed({ type: 'content_block_stop', index: 0 });
    expect(events).toEqual([{ kind: 'text', text: 'Hola mundo' }]);
  });

  it('a refusal surfaces instead of ending silently', () => {
    const { parser } = fresh();
    const events = parser.feed({ type: 'message_delta', delta: { stop_reason: 'refusal' } });
    expect(events).toEqual([{ kind: 'tool_error', text: 'The model refused to continue.' }]);
  });

  it('flush emits the text a dead stream never closed', () => {
    const { parser } = fresh();
    parser.feed({ type: 'content_block_start', index: 2, content_block: { type: 'text' } });
    parser.feed({ type: 'content_block_delta', index: 2, delta: { type: 'text_delta', text: 'tail' } });
    expect(parser.flush()).toEqual([{ kind: 'text', text: 'tail' }]);
  });
});

describe('grokUsage', () => {
  // The login file and the billing call are the only two things the reader
  // touches; both are stubbed so the test never leaves the process.
  function stub(entry, body, ok = true) {
    const calls = [];
    vi.spyOn(fs, 'readFileSync').mockReturnValue(
      JSON.stringify({
        'https://auth.x.ai::client-id': {
          key: 'access-token',
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
          ...entry,
        },
      }),
    );
    vi.stubGlobal('fetch', async (url, opts) => {
      calls.push({ url, opts });
      return { ok, json: async () => body };
    });
    return calls;
  }

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('reads the billing period as one bar, bearing the stored token', async () => {
    const calls = stub(
      {},
      {
        creditUsagePercent: 41.6,
        currentPeriod: { billingPeriodEnd: '2026-09-01T00:00:00Z', totalUsed: 4, monthlyLimit: 10 },
      },
    );
    expect(await grokUsage('/tmp/grok-home')).toEqual({
      windows: [
        { label: 'Credits (billing period)', short: 'mo', usedPct: 42, resetsAt: '2026-09-01T00:00:00Z' },
      ],
    });
    expect(calls[0].url).toBe('https://cli-chat-proxy.grok.com/v1/billing?format=credits');
    expect(calls[0].opts.headers.Authorization).toBe('Bearer access-token');
  });

  it('falls back to the period totals when no percent comes back', async () => {
    stub({}, { currentPeriod: { totalUsed: 3, monthlyLimit: 4 } });
    expect((await grokUsage('/tmp/grok-home')).windows[0].usedPct).toBe(75);
  });

  it('an expired token shows no bar rather than a failed call', async () => {
    const calls = stub({ expires_at: '2020-01-01T00:00:00Z' }, {});
    expect(await grokUsage('/tmp/grok-home')).toBeNull();
    expect(calls).toEqual([]);
  });

  it('an unpriced or erroring account shows no bar', async () => {
    stub({}, { currentPeriod: {} });
    expect(await grokUsage('/tmp/grok-home')).toBeNull();
    stub({}, {}, false);
    expect(await grokUsage('/tmp/grok-home')).toBeNull();
  });
});

describe('zaiUsage', () => {
  // The quota route is stubbed with the body a live coding-plan key answers:
  // one 5-hour window and one daily one, the key sent without a Bearer prefix.
  function stubFetch(body, ok = true) {
    const calls = [];
    vi.stubGlobal('fetch', async (url, opts) => {
      calls.push({ url, opts });
      return { ok, json: async () => body };
    });
    return calls;
  }

  afterEach(() => vi.unstubAllGlobals());

  const live = {
    code: 200,
    success: true,
    data: {
      limits: [
        { type: 'CREDIT_LIMIT', unit: 3, number: 5, usage: 2000, currentValue: 500, percentage: 25 },
        {
          type: 'CREDIT_LIMIT',
          unit: 6,
          number: 1,
          usage: 10000,
          currentValue: 1000,
          percentage: 10.4,
          nextResetTime: 1788005555992,
        },
      ],
      level: 'lite',
    },
  };

  it('reads both windows off the endpoint host, with the raw key', async () => {
    const calls = stubFetch(live);
    const usage = await zaiUsage('https://api.z.ai/api/v1', 'k-1');
    expect(calls[0].url).toBe('https://api.z.ai/api/monitor/usage/quota/limit');
    expect(calls[0].opts.headers.Authorization).toBe('k-1');
    expect(usage).toEqual({
      windows: [
        { label: 'Quota (5-hour window)', short: '5h', usedPct: 25, resetsAt: null },
        {
          label: 'Quota (1-day window)',
          short: '1d',
          usedPct: 10,
          resetsAt: new Date(1788005555992).toISOString(),
        },
      ],
    });
  });

  it('a window whose unit code is unknown keeps its bar but claims no period', async () => {
    stubFetch({ data: { limits: [{ type: 'TOKENS_LIMIT', unit: 9, number: 3, percentage: 45.5 }] } });
    const usage = await zaiUsage('https://api.z.ai/api/v1', 'k-1');
    expect(usage.windows).toEqual([{ label: 'Plan quota', short: 'plan', usedPct: 46, resetsAt: null }]);
  });

  it('is null on a rejected key, which Z.AI answers 200', async () => {
    stubFetch({ code: 1000, msg: 'Authentication Failed', success: false });
    expect(await zaiUsage('https://api.z.ai/api/v1', 'k-1')).toBeNull();
  });

  it('is null without a key, or when nothing is metered', async () => {
    stubFetch(live);
    expect(await zaiUsage('https://api.z.ai/api/v1', '')).toBeNull();
    stubFetch({ data: { limits: [] } });
    expect(await zaiUsage('https://api.z.ai/api/v1', 'k-1')).toBeNull();
  });
});

describe('an opencode endpoint under Test', () => {
  // Only the wire is stubbed: what the probe sends is the point of the tests.
  function stubFetch(body, status = 200) {
    const calls = [];
    vi.stubGlobal('fetch', async (url, opts) => {
      calls.push({ url, opts });
      return { ok: status < 400, status, text: async () => JSON.stringify(body) };
    });
    return calls;
  }

  afterEach(() => vi.unstubAllGlobals());

  it('lists the models at /models with the key on both headers', async () => {
    const calls = stubFetch({ data: [{ id: 'claude-sonnet-4-5' }] });
    const models = await testProviderEndpoint({
      binary: 'opencode',
      baseUrl: 'https://x.test/v1/',
      apiKey: 'k',
    });
    expect(models).toEqual(['claude-sonnet-4-5']);
    expect(calls[0].url).toBe('https://x.test/v1/models');
    expect(calls[0].opts.headers.Authorization).toBe('Bearer k');
    expect(calls[0].opts.headers['x-api-key']).toBe('k');
  });

  it('has nothing to test without a base URL', async () => {
    const calls = stubFetch({});
    await expect(testProviderEndpoint({ binary: 'opencode', baseUrl: '', apiKey: 'k' })).rejects.toThrow(
      /There is no endpoint to test/,
    );
    expect(calls).toEqual([]);
  });

  it("the chat probe speaks the wire of the model's service, with the service stripped off the model", async () => {
    let calls = stubFetch({ id: 'msg_1', type: 'message' });
    await probeChatEndpoint({
      binary: 'opencode',
      baseUrl: 'https://x.test/v1',
      apiKey: 'k',
      model: 'anthropic/claude-sonnet-4-5',
    });
    expect(calls[0].url).toBe('https://x.test/v1/messages');
    expect(calls[0].opts.headers['x-api-key']).toBe('k');
    expect(JSON.parse(calls[0].opts.body).model).toBe('claude-sonnet-4-5');

    calls = stubFetch({ id: 'chatcmpl-1', object: 'chat.completion' });
    await probeChatEndpoint({
      binary: 'opencode',
      baseUrl: 'https://x.test/v1',
      apiKey: 'k',
      model: 'openrouter/anthropic/claude-sonnet-4-5',
    });
    expect(calls[0].url).toBe('https://x.test/v1/chat/completions');
    expect(calls[0].opts.headers.Authorization).toBe('Bearer k');
    expect(JSON.parse(calls[0].opts.body).model).toBe('anthropic/claude-sonnet-4-5');
  });
});
