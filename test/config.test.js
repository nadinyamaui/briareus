import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';

// config.js reads .env, probes for the claude binary and caches the result all
// at import time, so every test builds its own module instance over a mocked
// filesystem rather than sharing one.
const disk = vi.hoisted(() => ({
  env: null, // string contents of .env, or null for "no such file"
  readThrows: null,
  files: new Set(), // paths that exist and are files
  dirs: new Set(), // paths that exist but are not files
  statThrows: new Set(),
  whichOutput: null, // stdout of `which -a claude`, or null to make it fail
}));

vi.mock('fs', () => {
  const exists = (p) => (p.endsWith('.env') ? disk.env !== null : disk.files.has(p) || disk.dirs.has(p));
  return {
    default: {
      existsSync: (p) => {
        if (disk.statThrows.has(p)) throw new Error('permission denied');
        return exists(p);
      },
      readFileSync: () => {
        if (disk.readThrows) throw disk.readThrows;
        return disk.env;
      },
      statSync: (p) => ({ isFile: () => disk.files.has(p) }),
    },
  };
});

vi.mock('os', () => ({ default: { homedir: () => '/home/test' } }));

vi.mock('child_process', () => ({
  execFileSync: () => {
    if (disk.whichOutput === null) throw new Error('which: no claude');
    return disk.whichOutput;
  },
}));

// Everything .env must name for a boot to succeed.
const COMPLETE = {
  PORT: '3000',
  GITHUB_TOKEN: 'tok',
  AUTH_USERNAME: 'nadin',
  DB_HOST: 'localhost',
  DB_PORT: '3306',
  DB_DATABASE: 'reviewer',
  DB_USERNAME: 'root',
  DB_PASSWORD: '',
  CLAUDE_MODEL: 'claude-opus-5',
  CLAUDE_EFFORT: 'high',
  WORKSPACE_DIR: '../worktrees',
  TEST_VIDEOS_DIR: './videos',
  PUBLIC_BASE_URL: 'https://reviewer.test',
};

function envText(pairs) {
  return Object.entries(pairs)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
}

// A fresh config.js over the given .env body.
async function loadConfig(text) {
  disk.env = text;
  vi.resetModules();
  return import('../lib/config.js');
}

const complete = (over = {}) => envText({ ...COMPLETE, ...over });

let savedEnv;
beforeEach(() => {
  disk.env = null;
  disk.readThrows = null;
  disk.files = new Set();
  disk.dirs = new Set();
  disk.statThrows = new Set();
  disk.whichOutput = null;
  savedEnv = { ...process.env };
  for (const k of Object.keys(process.env)) if (k.startsWith('R2_')) delete process.env[k];
});

afterEach(() => {
  process.env = savedEnv;
});

describe('reading .env', () => {
  it('reads a plain key and value', async () => {
    const { getConfig } = await loadConfig(complete({ GITHUB_TOKEN: 'ghp_abc' }));

    expect(getConfig().githubToken).toBe('ghp_abc');
  });

  it('trims the space around both sides', async () => {
    const { getConfig } = await loadConfig(complete() + '\n  GITHUB_TOKEN  =  spaced  ');

    expect(getConfig().githubToken).toBe('spaced');
  });

  it('strips double quotes around a value', async () => {
    const { getConfig } = await loadConfig(complete() + '\nGITHUB_TOKEN="quoted"');

    expect(getConfig().githubToken).toBe('quoted');
  });

  it('strips single quotes around a value', async () => {
    const { getConfig } = await loadConfig(complete() + "\nGITHUB_TOKEN='quoted'");

    expect(getConfig().githubToken).toBe('quoted');
  });

  it('leaves a quote that only opens alone', async () => {
    const { getConfig } = await loadConfig(complete() + '\nGITHUB_TOKEN="half');

    expect(getConfig().githubToken).toBe('"half');
  });

  it('keeps an = that appears inside the value', async () => {
    const { getConfig } = await loadConfig(complete({ GITHUB_TOKEN: 'a=b=c' }));

    expect(getConfig().githubToken).toBe('a=b=c');
  });

  it('skips comments and blank lines', async () => {
    const { getConfig } = await loadConfig('# a comment\n\n   \n' + complete());

    expect(getConfig().githubToken).toBe('tok');
  });

  it('skips a line with no = at all', async () => {
    const { getConfig } = await loadConfig('NOTAPAIR\n' + complete());

    expect(getConfig().githubToken).toBe('tok');
  });

  it('reads a file with CRLF line endings', async () => {
    const { getConfig } = await loadConfig(complete().split('\n').join('\r\n'));

    expect(getConfig().githubToken).toBe('tok');
  });

  it('treats a missing .env as an empty one', async () => {
    const { getConfig } = await loadConfig(null);

    expect(() => getConfig()).toThrow(/is missing settings/);
  });

  it('treats an unreadable .env as an empty one', async () => {
    disk.readThrows = new Error('permission denied');
    const { getConfig } = await loadConfig('PORT=3000');

    expect(() => getConfig()).toThrow(/is missing settings/);
  });
});

describe('what a missing setting does', () => {
  it('stops the boot, naming the key', async () => {
    const rest = { ...COMPLETE };
    delete rest.GITHUB_TOKEN;
    const { getConfig } = await loadConfig(envText(rest));

    expect(() => getConfig()).toThrow(/GITHUB_TOKEN/);
  });

  it('carries a code the caller can recognise', async () => {
    const { getConfig } = await loadConfig('');

    expect(() => getConfig()).toThrow(expect.objectContaining({ code: 'CONFIG_INCOMPLETE' }));
  });

  it('names every gap at once rather than one per restart', async () => {
    const rest = { ...COMPLETE };
    delete rest.GITHUB_TOKEN;
    delete rest.DB_HOST;
    const { getConfig } = await loadConfig(envText(rest));

    expect(() => getConfig()).toThrow(/GITHUB_TOKEN, DB_HOST/);
  });

  it('says "a setting" when only one is missing', async () => {
    const rest = { ...COMPLETE };
    delete rest.GITHUB_TOKEN;
    const { getConfig } = await loadConfig(envText(rest));

    expect(() => getConfig()).toThrow(/is missing a setting:/);
  });

  it('counts a key present but blank as missing', async () => {
    const { getConfig } = await loadConfig(complete({ GITHUB_TOKEN: '   ' }));

    expect(() => getConfig()).toThrow(/GITHUB_TOKEN/);
  });

  it('accepts a password that is present and deliberately empty', async () => {
    // A MySQL user without a password is a real answer.
    const { getConfig } = await loadConfig(complete({ DB_PASSWORD: '' }));

    expect(getConfig().db.password).toBe('');
  });

  it('counts an absent password as missing all the same', async () => {
    const rest = { ...COMPLETE };
    delete rest.DB_PASSWORD;
    const { getConfig } = await loadConfig(envText(rest));

    expect(() => getConfig()).toThrow(/DB_PASSWORD/);
  });

  it('rejects a number that is not one, showing what it read', async () => {
    const { getConfig } = await loadConfig(complete({ DB_PORT: 'threethousand' }));

    expect(() => getConfig()).toThrow(/DB_PORT \(not a number: threethousand\)/);
  });

  it('names a blank number once, as a gap rather than a bad number', async () => {
    const { getConfig } = await loadConfig(complete({ PORT: '' }));

    expect(() => getConfig()).toThrow(/is missing a setting: PORT\n/);
  });
});

describe('the values it builds', () => {
  it('reads the numbers as numbers', async () => {
    const { getConfig } = await loadConfig(complete({ PORT: '4000', DB_PORT: '3307' }));

    expect(getConfig()).toMatchObject({ port: 4000, db: expect.objectContaining({ port: 3307 }) });
  });

  it('binds loopback unless told otherwise', async () => {
    const { getConfig } = await loadConfig(complete());

    expect(getConfig().bindHost).toBe('127.0.0.1');
  });

  it('binds what BIND_HOST says when a container needs every interface', async () => {
    const { getConfig } = await loadConfig(complete({ BIND_HOST: '0.0.0.0' }));

    expect(getConfig().bindHost).toBe('0.0.0.0');
  });

  it('strips trailing slashes off the public URL', async () => {
    const { getConfig } = await loadConfig(complete({ PUBLIC_BASE_URL: 'https://reviewer.test///' }));

    expect(getConfig().publicBaseUrl).toBe('https://reviewer.test');
  });

  it('resolves a relative workspace dir against the app root', async () => {
    const { getConfig, ROOT } = await loadConfig(complete({ WORKSPACE_DIR: '../worktrees' }));

    // Resolved with the same path arithmetic config.js uses, not by splicing
    // the string: the assertion must not depend on what this checkout is called.
    expect(getConfig().workspaceDir).toBe(path.resolve(ROOT, '../worktrees'));
  });

  it('keeps an absolute workspace dir as given', async () => {
    const { getConfig } = await loadConfig(complete({ WORKSPACE_DIR: '/srv/worktrees' }));

    expect(getConfig().workspaceDir).toBe('/srv/worktrees');
  });

  it('answers the same object on every call', async () => {
    const { getConfig } = await loadConfig(complete());

    expect(getConfig()).toBe(getConfig());
  });
});

describe('the login', () => {
  it('is off when neither half is set', async () => {
    const { getConfig } = await loadConfig(complete());

    expect(getConfig().auth).toMatchObject({ passwordHash: '', secret: '' });
  });

  it('carries both halves when they are set', async () => {
    const { getConfig } = await loadConfig(
      complete({ AUTH_PASSWORD_HASH: 'scrypt$x', AUTH_SECRET: 's3cret' }),
    );

    expect(getConfig().auth).toMatchObject({ passwordHash: 'scrypt$x', secret: 's3cret' });
  });

  it('requires the username to be named rather than assumed', async () => {
    const rest = { ...COMPLETE };
    delete rest.AUTH_USERNAME;
    const { getConfig } = await loadConfig(envText(rest));

    expect(() => getConfig()).toThrow(/AUTH_USERNAME/);
  });

  it('keeps a signed-in browser for thirty days by default', async () => {
    const { getConfig } = await loadConfig(complete());

    expect(getConfig().auth.sessionDays).toBe(30);
  });

  it('takes a session length that was given', async () => {
    const { getConfig } = await loadConfig(complete({ AUTH_SESSION_DAYS: '7' }));

    expect(getConfig().auth.sessionDays).toBe(7);
  });

  it('never lets a session be shorter than a day', async () => {
    const { getConfig } = await loadConfig(complete({ AUTH_SESSION_DAYS: '0' }));

    expect(getConfig().auth.sessionDays).toBe(1);
  });
});

describe('the database pool', () => {
  it('is on unless switched off', async () => {
    const { getConfig } = await loadConfig(complete());

    expect(getConfig().dbPool).toMatchObject({ enabled: true, waitTimeoutMin: 30, pollSeconds: 10 });
  });

  it('switches off on DB_POOL_ENABLED=false, whatever its case', async () => {
    const { getConfig } = await loadConfig(complete({ DB_POOL_ENABLED: 'FALSE' }));

    expect(getConfig().dbPool.enabled).toBe(false);
  });

  it('stays on for any other value', async () => {
    const { getConfig } = await loadConfig(complete({ DB_POOL_ENABLED: 'yes' }));

    expect(getConfig().dbPool.enabled).toBe(true);
  });

  it('never polls faster than once a second', async () => {
    const { getConfig } = await loadConfig(complete({ DB_POOL_POLL_SECONDS: '0' }));

    expect(getConfig().dbPool.pollSeconds).toBe(1);
  });

  it('takes the wait timeout that was given', async () => {
    const { getConfig } = await loadConfig(complete({ DB_POOL_WAIT_TIMEOUT_MIN: '5' }));

    expect(getConfig().dbPool.waitTimeoutMin).toBe(5);
  });
});

describe('developer sessions', () => {
  it('caps at three sessions and an hour by default', async () => {
    const { getConfig } = await loadConfig(complete());

    expect(getConfig().dev).toEqual({ maxSessions: 3, timeoutMin: 60 });
  });

  it('takes the caps that were given', async () => {
    const { getConfig } = await loadConfig(complete({ DEV_MAX_SESSIONS: '8', DEV_TIMEOUT_MIN: '15' }));

    expect(getConfig().dev).toEqual({ maxSessions: 8, timeoutMin: 15 });
  });

  it('leaves the other two CLIs to be looked up the usual way', async () => {
    const { getConfig } = await loadConfig(complete());

    expect(getConfig()).toMatchObject({ codexBin: '', grokBin: '' });
  });

  it('takes an explicit path for them', async () => {
    const { getConfig } = await loadConfig(complete({ CODEX_BIN: '/opt/codex', GROK_BIN: '/opt/grok' }));

    expect(getConfig()).toMatchObject({ codexBin: '/opt/codex', grokBin: '/opt/grok' });
  });
});

describe('finding the claude binary', () => {
  it('answers null when there is none anywhere', async () => {
    const { getConfig } = await loadConfig(complete());

    expect(getConfig()).toMatchObject({ claudeBin: null, claudeBinSource: null });
  });

  it('prefers what CLAUDE_BIN names', async () => {
    disk.files.add('/opt/claude');
    disk.whichOutput = '/usr/bin/claude\n';
    disk.files.add('/usr/bin/claude');
    const { getConfig } = await loadConfig(complete({ CLAUDE_BIN: '/opt/claude' }));

    expect(getConfig()).toMatchObject({ claudeBin: '/opt/claude', claudeBinSource: 'CLAUDE_BIN' });
  });

  it('takes the one on PATH next', async () => {
    disk.whichOutput = '/usr/bin/claude\n';
    disk.files.add('/usr/bin/claude');
    const { getConfig } = await loadConfig(complete());

    expect(getConfig()).toMatchObject({ claudeBin: '/usr/bin/claude', claudeBinSource: 'PATH' });
  });

  it('never runs a binary on a mounted Windows drive', async () => {
    // WSL inherits the Windows PATH, whose npm shim points at JS under a drive
    // letter no Linux node can load.
    disk.whichOutput = '/mnt/c/Users/nadin/AppData/npm/claude\n/usr/bin/claude\n';
    disk.files.add('/mnt/c/Users/nadin/AppData/npm/claude');
    disk.files.add('/usr/bin/claude');
    const { getConfig } = await loadConfig(complete());

    expect(getConfig().claudeBin).toBe('/usr/bin/claude');
  });

  it('finds nothing on PATH when every hit is on a Windows drive', async () => {
    disk.whichOutput = '/mnt/c/npm/claude\n';
    disk.files.add('/mnt/c/npm/claude');
    const { getConfig } = await loadConfig(complete());

    expect(getConfig().claudeBin).toBeNull();
  });

  it('survives a machine with no which at all', async () => {
    disk.whichOutput = null;
    disk.files.add('/home/test/.npm-global/bin/claude');
    const { getConfig } = await loadConfig(complete());

    expect(getConfig().claudeBinSource).toBe('npm global');
  });

  it('falls back to the per-user npm global prefix', async () => {
    disk.files.add('/home/test/.npm-global/bin/claude');
    const { getConfig } = await loadConfig(complete());

    expect(getConfig()).toMatchObject({
      claudeBin: '/home/test/.npm-global/bin/claude',
      claudeBinSource: 'npm global',
    });
  });

  it('falls back to a system-wide install', async () => {
    disk.files.add('/usr/local/bin/claude');
    const { getConfig } = await loadConfig(complete());

    expect(getConfig().claudeBinSource).toBe('npm global (system)');
  });

  it('falls back to the native installer', async () => {
    disk.files.add('/home/test/.local/bin/claude');
    const { getConfig } = await loadConfig(complete());

    expect(getConfig().claudeBinSource).toBe('native installer');
  });

  it('skips a candidate that exists but is a directory', async () => {
    disk.dirs.add('/usr/local/bin/claude');
    disk.files.add('/home/test/.local/bin/claude');
    const { getConfig } = await loadConfig(complete());

    expect(getConfig().claudeBinSource).toBe('native installer');
  });

  it('keeps looking past a candidate it cannot stat', async () => {
    disk.statThrows.add('/home/test/.npm-global/bin/claude');
    disk.files.add('/usr/local/bin/claude');
    const { getConfig } = await loadConfig(complete());

    expect(getConfig().claudeBinSource).toBe('npm global (system)');
  });
});

describe('the R2 video bucket', () => {
  const R2 = {
    R2_ENDPOINT: 'https://acct.r2.cloudflarestorage.com',
    R2_ACCESS_KEY_ID: 'akid',
    R2_SECRET_ACCESS_KEY: 'secret',
    R2_BUCKET: 'videos',
    R2_PUBLIC_BASE_URL: 'https://videos.test',
  };

  it('is absent when no key mentions it', async () => {
    const { getConfig } = await loadConfig(complete());

    expect(getConfig().r2).toBeNull();
  });

  it('is configured the moment every key is there', async () => {
    const { getConfig } = await loadConfig(complete(R2));

    expect(getConfig().r2).toEqual({
      endpoint: 'https://acct.r2.cloudflarestorage.com',
      accessKeyId: 'akid',
      secretAccessKey: 'secret',
      bucket: 'videos',
      publicBaseUrl: 'https://videos.test',
    });
  });

  it('demands the rest once any one key appears', async () => {
    // A bucket it can sign uploads for but no public hostname would mean links
    // on pull requests pointing at videos that never arrive, quietly.
    const { getConfig } = await loadConfig(complete({ R2_BUCKET: 'videos' }));

    expect(() => getConfig()).toThrow(/R2_ENDPOINT.*R2_PUBLIC_BASE_URL/s);
  });

  it('strips trailing slashes off both URLs', async () => {
    const { getConfig } = await loadConfig(
      complete({
        ...R2,
        R2_ENDPOINT: `${R2.R2_ENDPOINT}//`,
        R2_PUBLIC_BASE_URL: `${R2.R2_PUBLIC_BASE_URL}/`,
      }),
    );

    expect(getConfig().r2).toMatchObject({
      endpoint: 'https://acct.r2.cloudflarestorage.com',
      publicBaseUrl: 'https://videos.test',
    });
  });

  it('reads the keys from the process environment', async () => {
    // The recommended home: .env is readable by every shell command a session
    // runs, the environment is stripped before it reaches a job child.
    Object.assign(process.env, R2);
    const { getConfig } = await loadConfig(complete());

    expect(getConfig().r2).toMatchObject({ bucket: 'videos' });
  });

  it('lets the environment win over a stale entry left in the file', async () => {
    process.env.R2_BUCKET = 'current';
    const { getConfig } = await loadConfig(complete({ ...R2, R2_BUCKET: 'stale' }));

    expect(getConfig().r2.bucket).toBe('current');
  });

  it('falls back to the file when the environment says nothing', async () => {
    process.env.R2_BUCKET = '   ';
    const { getConfig } = await loadConfig(complete(R2));

    expect(getConfig().r2.bucket).toBe('videos');
  });
});
