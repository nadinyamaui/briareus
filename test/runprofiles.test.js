import { describe, it, expect, vi } from 'vitest';
import {
  parseRunProfiles,
  pickRunProfile,
  projectRunProfiles,
  runProfilesError,
  runVars,
  profileRun,
  render,
  unknownHostTenant,
} from '../lib/runprofiles.js';

const HEEDLY = `
# the issue's example
profile: projects
env:
  VERTICAL=projects
  TENANT_SIGNUP_STATUS=active
  DB_DATABASE={database}_projects
tenants: central, demo
before:
  php artisan migrate --force
  php artisan tenants:register-domain central {host:central}

profile: veterinary
env:
  VERTICAL="veterinary clinic"
`;

describe('parseRunProfiles', () => {
  it('reads profiles, their env, tenants and commands, in order', () => {
    expect(parseRunProfiles(HEEDLY)).toEqual([
      {
        name: 'projects',
        env: [
          ['VERTICAL', 'projects'],
          ['TENANT_SIGNUP_STATUS', 'active'],
          ['DB_DATABASE', '{database}_projects'],
        ],
        tenants: ['central', 'demo'],
        before: ['php artisan migrate --force', 'php artisan tenants:register-domain central {host:central}'],
      },
      { name: 'veterinary', env: [['VERTICAL', 'veterinary clinic']], tenants: [], before: [] },
    ]);
  });

  it('reads nothing as no profiles', () => {
    expect(parseRunProfiles('')).toEqual([]);
    expect(parseRunProfiles(null)).toEqual([]);
    expect(parseRunProfiles('\n# nothing yet\n')).toEqual([]);
  });

  it('takes an unindented entry, and a command that looks like a header when indented', () => {
    const [p] = parseRunProfiles('profile: a\nbefore:\necho one\n  env: not a header');
    expect(p.before).toEqual(['echo one', 'env: not a header']);
  });

  it('takes a {host:<tenant>} listed on a tenants: line below it', () => {
    const [p] = parseRunProfiles('profile: a\nbefore:\n  register {host:demo}\ntenants: demo');
    expect(p.tenants).toEqual(['demo']);
  });

  it('takes a mixed-case {host:<tenant>} for the tenant its lowercased key names', () => {
    const [p] = parseRunProfiles('profile: a\ntenants: Central\nbefore:\n  register {host:Central}');
    expect(p.tenants).toEqual(['central']);
  });

  it("cuts a trailing ' # comment' off an env value, as the checkout's .env is read", () => {
    const [p] = parseRunProfiles(
      'profile: a\nenv:\n  A=projects # main vertical\n  B=\'x # y\' # z\n  C=a#b\n  D="quoted"',
    );
    expect(p.env).toEqual([
      ['A', 'projects'],
      ['B', 'x # y'],
      ['C', 'a#b'],
      ['D', 'quoted'],
    ]);
  });

  it('checks the {host:<tenant>} tokens of an env value, not of its cut comment', () => {
    const [p] = parseRunProfiles('profile: a\nenv:\n  APP_URL=http://{host} # was {host:old}');
    expect(p.env).toEqual([['APP_URL', 'http://{host}']]);
  });

  it('takes a DB_DATABASE that renders to a plain identifier', () => {
    const [p] = parseRunProfiles(
      'profile: a\nenv:\n  DB_DATABASE={database}_{profile}\nprofile: b\nenv:\n  DB_DATABASE=app$2',
    );
    expect(p.env).toEqual([['DB_DATABASE', '{database}_{profile}']]);
  });

  it('takes {profile} in DB_DATABASE under a name without a hyphen', () => {
    const [p] = parseRunProfiles('profile: vertical_a\nenv:\n  DB_DATABASE={database}_{profile}');
    expect(p.env).toEqual([['DB_DATABASE', '{database}_{profile}']]);
  });

  it('keeps the last value of a key set twice', () => {
    const [p] = parseRunProfiles('profile: a\nenv:\n  A=1\n  B=2\n  A=3');
    expect(p.env).toEqual([
      ['B', '2'],
      ['A', '3'],
    ]);
  });

  it.each([
    ['env:\n  A=1', /line 1: "env:" comes before any "profile:"/],
    ['profile: Bad Name', /line 1: "Bad Name" is not a profile name/],
    ['profile: a\nprofile: a', /line 2: "a" is defined twice/],
    ['profile: a\nenv:\n  not an assignment', /line 3: .* is not a KEY=value line/],
    ['profile: a\nenv:\n  1A=x', /is not a KEY=value line/],
    ['profile: a\ntenants: demo--x', /"demo--x" is not a tenant key/],
    ['profile: a\ntenants: -demo', /is not a tenant key/],
    ['profile: a\nenv: A=1', /takes its entries on the lines below it/],
    ['profile: a\n  php artisan', /line 2: .* is not under/],
    ['profile: a\n  before:\n    echo one\n  env:\n    A=1', /line 2: "before:" is indented/],
    ['profile: a\nbefore:\n  echo one\n  env:\n  A=1', /line 4: "env:" is indented/],
    ['profile: a\nbefore:\n  echo one\n  tenants: demo', /line 4: "tenants: demo" is indented/],
    ['profile: a\ntenants: central\nbefore:\n  register {host:demo}', /line 4: \{host:demo\} names a tenant/],
    ['profile: a\nenv:\n  APP_URL=https://{host:demo}', /line 3: \{host:demo\} names a tenant profile "a"/],
    ['profile: a\nbefore:\n  x {host:demo}\nprofile: b\ntenants: demo', /line 3: \{host:demo\}/],
    [
      'profile: vertical-a\nenv:\n  DB_DATABASE={database}_{profile}',
      /line 3: \{profile\} renders "vertical-a"/,
    ],
    ['profile: a\nenv:\n  DB_DATABASE={database}-x', /line 3: DB_DATABASE renders to a name like "db-x"/],
    [
      'profile: a\nenv:\n  DB_DATABASE=app-projects',
      /line 3: DB_DATABASE renders to a name like "app-projects"/,
    ],
    ['profile: a\nenv:\n  DB_DATABASE={dir}_x', /line 3: DB_DATABASE renders to a name like "\{dir\}_x"/],
    // The claim-time drop has no port to render it with.
    [
      'profile: a\nenv:\n  DB_DATABASE={database}_{port}',
      /line 3: DB_DATABASE renders to a name like "db_\{port\}"/,
    ],
    ['profile: a\nenv:\n  APP_URL=http://{host:old} # a comment', /line 3: \{host:old\} names a tenant/],
  ])('refuses %j', (text, error) => {
    expect(() => parseRunProfiles(text)).toThrow(error);
  });
});

describe('pickRunProfile', () => {
  const project = { repo: 'acme/heedly', runProfiles: HEEDLY };

  it('picks the one asked for, and refuses one nobody defines', () => {
    expect(pickRunProfile(project, 'veterinary').name).toBe('veterinary');
    expect(() => pickRunProfile(project, 'commerce')).toThrow('acme/heedly has no run profile "commerce"');
  });

  it('falls back to the remembered one, then the first, when none is asked for', () => {
    expect(pickRunProfile(project, null, 'veterinary').name).toBe('veterinary');
    expect(pickRunProfile(project, null, 'renamed-since').name).toBe('projects');
    expect(pickRunProfile(project, null).name).toBe('projects');
  });

  it('is null for a project without profiles', () => {
    expect(pickRunProfile({ repo: 'a/b', runProfiles: '' }, null)).toBeNull();
    expect(pickRunProfile(null, null)).toBeNull();
  });

  it('reads a row that does not parse as no profiles, rather than failing the run', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const project = { repo: 'acme/stale', runProfiles: 'env:\n  A=1' };

    expect(projectRunProfiles(project)).toEqual([]);
    expect(projectRunProfiles(project)).toEqual([]);
    // Logged once per text, not on every read.
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/acme\/stale: the saved run profiles no longer read.*line 1/);
    warn.mockRestore();
  });

  it('says why a row does not parse, and nothing for one that does', () => {
    expect(runProfilesError({ runProfiles: 'env:\n  A=1' })).toMatch(
      /line 1: "env:" comes before any "profile:"/,
    );
    expect(runProfilesError({ runProfiles: HEEDLY })).toBeNull();
    expect(runProfilesError(null)).toBeNull();
  });
});

describe('filling a profile in', () => {
  const [profile] = parseRunProfiles(HEEDLY);
  const vars = runVars({
    port: 8101,
    dir: '/w/heedly',
    database: 'heedly',
    profile,
    hostFor: (tenant) => (tenant ? `${tenant}--preview-8101.example.com` : 'preview-8101.example.com'),
  });

  it('offers the port, the checkout, the profile, the database and one host per tenant', () => {
    expect(vars).toEqual({
      port: '8101',
      dir: '/w/heedly',
      profile: 'projects',
      database: 'heedly',
      host: 'preview-8101.example.com',
      'host:central': 'central--preview-8101.example.com',
      'host:demo': 'demo--preview-8101.example.com',
    });
  });

  it('renders the commands and the env values', () => {
    expect(profileRun(profile, vars)).toEqual({
      before: [
        'php artisan migrate --force',
        'php artisan tenants:register-domain central central--preview-8101.example.com',
      ],
      env: { VERTICAL: 'projects', TENANT_SIGNUP_STATUS: 'active', DB_DATABASE: 'heedly_projects' },
    });
  });

  it('adds nothing without a profile', () => {
    expect(profileRun(null, vars)).toEqual({ before: [], env: {} });
  });

  it('renders a mixed-case {host:<tenant>} as its lowercased tenant', () => {
    expect(render('{host:Central}', vars)).toBe('central--preview-8101.example.com');
  });

  it('leaves a tenant the profile does not name as typed', () => {
    expect(render('{host:nobody} {host} {port}', vars)).toBe('{host:nobody} preview-8101.example.com 8101');
  });
});

describe('unknownHostTenant', () => {
  it('names the first {host:<tenant>} the vars have no hostname for', () => {
    const vars = { 'host:central': 'c.example.com' };
    expect(unknownHostTenant(['a {host:Central}', 'b {host:demo}'], vars)).toBe('demo');
    expect(unknownHostTenant(['a {host:central} {host}'], vars)).toBeNull();
  });
});
