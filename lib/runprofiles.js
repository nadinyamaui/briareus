// @ts-check
// Run profiles: named configurations of a project's app (a vertical, the tenants of a
// multi-tenant app) for ▶ Run, like `configurations` in .claude/launch.json. Written as
// plain text in project settings and stored as typed, so comments survive a save:
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
// Headers start at column 0; other lines belong to the last `env:` or `before:`. An
// indented header is refused, except `env:`/`before:` with text after the colon, which
// is a command. The first profile is the default.

/**
 * @typedef {{ name: string, env: [string, string][], tenants: string[], before: string[] }} RunProfile
 */

const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/;
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
// A tenant goes into a DNS label (`demo--preview-8101`), so it must be a short label
// itself, without `--`, which separates it from the port's name.
const TENANT_RE = /^[a-z0-9](?:[a-z0-9-]{0,28}[a-z0-9])?$/;

const HEADER_RE = /^(profile|env|tenants|before)\s*:(.*)$/;

/**
 * Throws on the first unreadable line, naming it, so settings can refuse the save.
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
  // {host:<tenant>} tokens, checked at the end since `tenants:` may come after them.
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
    const profile = current;
    const collectHostTokens = (/** @type {string} */ text) => {
      for (const [, tenant] of text.matchAll(/\{host:([\w-]+)\}/g))
        hostTokens.push({ profile, tenant: tenant.toLowerCase(), where });
    };
    if (section === 'before') {
      collectHostTokens(line);
      current.before.push(line);
      return;
    }
    const eq = line.indexOf('=');
    const key = eq === -1 ? '' : line.slice(0, eq).trim();
    if (!ENV_KEY_RE.test(key)) throw new Error(`${where}: "${line}" is not a KEY=value line`);
    let value = line.slice(eq + 1).trim();
    // Read like a checkout's .env (parseEnvFile with inlineComments): trailing comment
    // cut and quotes removed, since no shell will unquote it.
    const quoted = value.match(/^(['"])(.*?)\1(?:\s+#.*)?$/);
    value = quoted ? quoted[2] : value.replace(/\s+#.*$/, '');
    // Only what reaches the app is checked: a token in the cut comment is not.
    collectHostTokens(value);
    // Must render to a plain identifier (ensureDatabase requires it). Only {database}
    // and {profile} are allowed; {port} etc. stay unrendered and are refused, since
    // not every path that renders the name has a port (the claim-time drop).
    if (key === 'DB_DATABASE' && value) {
      const sample = render(value, { database: 'db', profile: current.name });
      if (!/^[A-Za-z0-9_$]+$/.test(sample)) {
        // {profile} renders the name as typed, hyphen included.
        throw new Error(
          value.includes('{profile}') && current.name.includes('-')
            ? `${where}: {profile} renders "${current.name}" into the database name, which cannot hold a hyphen; name the profile with _ instead, or spell the database out`
            : `${where}: DB_DATABASE renders to a name like "${sample}", which is not a plain database identifier (letters, digits, _ and $)`,
        );
      }
    }
    current.env = current.env.filter(([k]) => k !== key);
    current.env.push([key, value]);
  });
  // render leaves unknown tokens as typed, so an unlisted tenant would reach the shell
  // as a literal {host:demo}.
  for (const { profile, tenant, where } of hostTokens) {
    if (!profile.tenants.includes(tenant)) {
      throw new Error(
        `${where}: {host:${tenant}} names a tenant profile "${profile.name}" does not list under "tenants:"`,
      );
    }
  }
  return profiles;
}

// Saved text may no longer parse (a newer rule, another writer): treat it as no
// profiles rather than failing every caller, warning once per text. ▶ Run checks
// runProfilesError instead of silently serving the plain run commands.
const warnedUnreadable = new Set();

/** @returns {RunProfile[]} */
export function projectRunProfiles(project) {
  try {
    return parseRunProfiles(project ? project.runProfiles : '');
  } catch (e) {
    const key = `${project.repo}\n${project.runProfiles}`;
    if (!warnedUnreadable.has(key)) {
      warnedUnreadable.add(key);
      console.warn(
        `[runprofiles] ${project.repo}: the saved run profiles no longer read, so none are offered: ${e.message}`,
      );
    }
    return [];
  }
}

/**
 * Why a project's saved run profiles no longer read, or null when they do.
 *
 * @returns {string|null}
 */
export function runProfilesError(project) {
  try {
    parseRunProfiles(project ? project.runProfiles : '');
    return null;
  } catch (e) {
    return e.message;
  }
}

/**
 * The profile to serve. An unknown `wanted` throws; an unknown `fallback` (the
 * session's remembered one, maybe since renamed) quietly gives way to the default.
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
 * The placeholders commands and env values may use. `hostFor` gives a tenant's
 * hostname (null for the port's own), which differs between ▶ Run and QA runs.
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

// {token} substitution. Unknown tokens are left as typed so a typo stays visible.
// {host:<tenant>} is looked up whole, with the tenant lowercased.
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
 * The first {host:<tenant>} in `templates` that `vars` cannot fill. Run commands are
 * shared across profiles, so they can only be checked against the one being served.
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
 * A profile's rendered pre-run commands and env overrides.
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
