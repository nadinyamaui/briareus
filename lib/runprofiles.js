// @ts-check
// Run profiles: named configurations of one project's app, so ▶ Run can serve
// a given vertical and a given tenant of a multi-tenant app instead of the one
// fixed setup the run commands describe. The same idea as `configurations` in
// .claude/launch.json.
//
// They are written in the project's settings as plain text, one block per
// profile, and stored as typed so comments and layout survive a save:
//
//   profile: projects
//   env:
//     VERTICAL=projects
//     DB_DATABASE={database}_projects
//   tenants: central, demo
//   before:
//     php artisan migrate --force
//     php artisan tenants:register-domain central {host:central}
//
// A header is one of the four words at the start of a line; every other line
// belongs to the section the last `env:` or `before:` opened, indented or not.
// An indented line that would be a header unindented is refused rather than
// read as one of those lines (`env:` and `before:` take nothing after the
// colon, so `  env: x` is still a command).
// The first profile is the default one: what ▶ Run serves on a plain click.

/**
 * @typedef {{ name: string, env: [string, string][], tenants: string[], before: string[] }} RunProfile
 */

const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/;
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
// A tenant becomes part of a DNS label (`demo--preview-8101`), so it has to
// be one itself, short enough to leave room for the rest. No double hyphen:
// that is the separator between the tenant and the port's own name.
const TENANT_RE = /^[a-z0-9](?:[a-z0-9-]{0,28}[a-z0-9])?$/;

const HEADER_RE = /^(profile|env|tenants|before)\s*:(.*)$/;

/**
 * Throws on the first line that cannot be read, naming it, so the settings
 * form can refuse the save with something to go on.
 *
 * @param {unknown} text
 * @returns {RunProfile[]}
 */
export function parseRunProfiles(text) {
  /** @type {RunProfile[]} */
  const profiles = [];
  /** @type {RunProfile|null} */
  let current = null;
  /** @type {'env'|'before'|null} */
  let section = null;
  // The {host:<tenant>} tokens seen, checked once every profile's `tenants:`
  // is known, since that line may come after the commands using them.
  /** @type {{ profile: RunProfile, tenant: string, where: string }[]} */
  const hostTokens = [];
  const lines = String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .split('\n');
  lines.forEach((raw, i) => {
    const where = `Run profiles, line ${i + 1}`;
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    const indented = /^\s/.test(raw) ? line.match(HEADER_RE) : null;
    if (indented && (!['env', 'before'].includes(indented[1]) || !indented[2].trim())) {
      throw new Error(`${where}: "${line}" is indented; a header starts at the beginning of its line`);
    }
    const header = /^\s/.test(raw) ? null : raw.match(HEADER_RE);
    if (header) {
      const [, key, rest] = header;
      const value = rest.trim();
      if (key === 'profile') {
        if (!NAME_RE.test(value)) {
          throw new Error(`${where}: "${value}" is not a profile name (lowercase letters, digits, - and _)`);
        }
        if (profiles.some((p) => p.name === value)) throw new Error(`${where}: "${value}" is defined twice`);
        current = { name: value, env: [], tenants: [], before: [] };
        profiles.push(current);
        section = null;
        return;
      }
      if (!current) throw new Error(`${where}: "${key}:" comes before any "profile:" line`);
      if (key === 'tenants') {
        const tenants = value
          .split(/[\s,]+/)
          .map((t) => t.trim().toLowerCase())
          .filter(Boolean);
        for (const t of tenants) {
          if (!TENANT_RE.test(t) || t.includes('--')) {
            throw new Error(
              `${where}: "${t}" is not a tenant key (lowercase letters, digits and single hyphens)`,
            );
          }
          if (!current.tenants.includes(t)) current.tenants.push(t);
        }
        section = null;
        return;
      }
      if (value) throw new Error(`${where}: "${key}:" takes its entries on the lines below it`);
      section = /** @type {'env'|'before'} */ (key);
      return;
    }
    if (!current || !section) {
      throw new Error(`${where}: "${line}" is not under a "profile:" with an "env:" or "before:" section`);
    }
    // Lowercased like the `tenants:` keys, and looked up that way by render.
    for (const [, tenant] of line.matchAll(/\{host:([\w-]+)\}/g))
      hostTokens.push({ profile: current, tenant: tenant.toLowerCase(), where });
    if (section === 'before') {
      current.before.push(line);
      return;
    }
    const eq = line.indexOf('=');
    const key = eq === -1 ? '' : line.slice(0, eq).trim();
    if (!ENV_KEY_RE.test(key)) throw new Error(`${where}: "${line}" is not a KEY=value line`);
    let value = line.slice(eq + 1).trim();
    // Read as the checkout's .env is (parseEnvFile with inlineComments): a
    // ` # comment` after the value is cut, and quotes, how a .env writes a
    // value with spaces or a #, are taken off rather than passed through,
    // since the shell never sees this one.
    const quoted = value.match(/^(['"])(.*?)\1(?:\s+#.*)?$/);
    value = quoted ? quoted[2] : value.replace(/\s+#.*$/, '');
    // A database name is a plain identifier (ensureDatabase refuses anything
    // else), and {profile} renders the name as typed, hyphen included.
    if (key === 'DB_DATABASE' && value.includes('{profile}') && current.name.includes('-')) {
      throw new Error(
        `${where}: {profile} renders "${current.name}" into the database name, which cannot hold a hyphen; name the profile with _ instead, or spell the database out`,
      );
    }
    current.env = current.env.filter(([k]) => k !== key);
    current.env.push([key, value]);
  });
  // An unknown token is left as typed by render, so a tenant missing from
  // `tenants:` would reach the shell as a literal {host:demo}.
  for (const { profile, tenant, where } of hostTokens) {
    if (!profile.tenants.includes(tenant)) {
      throw new Error(
        `${where}: {host:${tenant}} names a tenant profile "${profile.name}" does not list under "tenants:"`,
      );
    }
  }
  return profiles;
}

// What a project's text reads as at run time. The text was checked when it
// was saved, so a failure here means a row written some other way: treated as
// no profiles at all rather than taking ▶ Run down with it.
/** @returns {RunProfile[]} */
export function projectRunProfiles(project) {
  try {
    return parseRunProfiles(project ? project.runProfiles : '');
  } catch {
    return [];
  }
}

/**
 * The profile to serve. A name nobody defines is an error when it was asked
 * for; `fallback` is the one the session remembers, which may have been
 * renamed or deleted in Settings since, so that one quietly gives way to the
 * default.
 *
 * @param {any} project
 * @param {string|null|undefined} wanted
 * @param {string|null|undefined} [fallback]
 * @returns {RunProfile|null} null when the project has no profiles
 */
export function pickRunProfile(project, wanted, fallback = null) {
  const profiles = projectRunProfiles(project);
  if (wanted) {
    const found = profiles.find((p) => p.name === wanted);
    if (!found) throw new Error(`${project ? project.repo : 'This project'} has no run profile "${wanted}"`);
    return found;
  }
  return profiles.find((p) => p.name === fallback) || profiles[0] || null;
}

/**
 * The placeholders a profile's commands and env values may use, next to the
 * run commands' own {port} and {dir}. `hostFor` names the hostname a tenant is
 * served on (null for the port's own), which differs between ▶ Run and the
 * QA agent's run.
 *
 * @param {{ port: number|string, dir: string, database: string, profile: RunProfile|null,
 *   hostFor: (tenant: string|null) => string }} opts
 * @returns {Record<string, string>}
 */
export function runVars({ port, dir, database, profile, hostFor }) {
  /** @type {Record<string, string>} */
  const vars = {
    port: String(port),
    dir: String(dir ?? ''),
    profile: profile ? profile.name : '',
    database: database || '',
    host: hostFor(null),
  };
  for (const tenant of profile ? profile.tenants : []) vars[`host:${tenant}`] = hostFor(tenant);
  return vars;
}

// {token} substitution, used for the run commands and the profiles' commands
// and env values. Unknown tokens are left alone rather than blanked, so a typo
// shows up in the output instead of silently disappearing.
//
// A token may carry one argument after a colon ({host:demo}), looked up whole.
// A tenant is a lowercase key however it was typed, so {host:Demo} is demo's.
/**
 * @param {unknown} template
 * @param {Record<string, unknown>} vars
 */
export function render(template, vars) {
  return String(template ?? '').replace(/\{(\w+(?::[\w-]+)?)\}/g, (whole, token) => {
    const key = token.startsWith('host:') ? token.toLowerCase() : token;
    return Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : whole;
  });
}

/**
 * The first tenant a {host:<tenant>} in `templates` names that `vars` has no
 * hostname for. A profile's own lines are checked against its tenants when it
 * is saved; the run commands are shared by every profile (and by none), so
 * theirs can only be checked against the one being served. render leaves an
 * unknown token as typed, and the shell would get a literal {host:demo}.
 *
 * @param {string[]} templates
 * @param {Record<string, unknown>} vars
 * @returns {string|null}
 */
export function unknownHostTenant(templates, vars) {
  return (
    templates
      .flatMap((c) => [...String(c).matchAll(/\{host:([\w-]+)\}/g)].map(([, t]) => t.toLowerCase()))
      .find((t) => !Object.prototype.hasOwnProperty.call(vars, `host:${t}`)) || null
  );
}

/**
 * What a profile adds to a run, its placeholders filled: the commands that go
 * ahead of the run commands, and the env set over the session's own.
 *
 * @param {RunProfile|null} profile
 * @param {Record<string, string>} vars
 * @returns {{ before: string[], env: Record<string, string> }}
 */
export function profileRun(profile, vars) {
  return {
    before: (profile ? profile.before : []).map((c) => render(c, vars)),
    env: Object.fromEntries((profile ? profile.env : []).map(([k, v]) => [k, render(v, vars)])),
  };
}
