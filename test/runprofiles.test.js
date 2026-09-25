import { describe, it, expect } from 'vitest';
import {
  parseRunProfiles,
  pickRunProfile,
  projectRunProfiles,
  runVars,
  profileRun,
  render,
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
    expect(projectRunProfiles({ runProfiles: 'env:\n  A=1' })).toEqual([]);
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

  it('leaves a tenant the profile does not name as typed', () => {
    expect(render('{host:nobody} {host} {port}', vars)).toBe('{host:nobody} preview-8101.example.com 8101');
  });
});
