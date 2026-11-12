// @ts-check
// How risky a pull request's change is, as the server works it out from the diff: which
// files it touches, held against the project's sensitive-path rules, and how large it is.
// The tier that results decides how many people have to approve the reviewed revision
// (lib/review-approvals.js) and which checks the review owes (the security pass), and
// nothing else: it never chooses a provider, a model or an effort.
//
// Nothing an agent says is an input. The file list is GitHub's, read by the server, and
// a list that could not be read completely is not a small change: the assessment is then
// `unknown` and stands as the highest tier.
//
// Pure, so the rules can be tested as a table: the policy a project stores
// (normalizeApprovalPolicy), the glob syntax of its rules (compileGlob, globMatches) and
// the assessment itself (assessRisk).
import { createHash } from 'node:crypto';
import { securityPolicyOf } from './review-security.js';

// Fixed, lowest first. A project decides what each asks for, not how many there are:
// "the highest tier" then means the same thing in every project, which is what an
// assessment that could not be made falls back on.
export const RISK_TIERS = ['low', 'medium', 'high'];
export const HIGHEST_TIER = 'high';
const rank = (tier) => RISK_TIERS.indexOf(tier);
/** @param {string} a @param {string} b */
export const higherTier = (a, b) => (rank(b) > rank(a) ? b : a);

export const POLICY_LIMITS = {
  // Every rule is tried against every changed path, on the event loop.
  rules: 50,
  pattern: 200,
  label: 80,
  approvals: 10,
  size: 1_000_000_000,
};
// What an approval requirement asks of each tier when the project does not say: nothing
// of an ordinary change, one person on a sensitive one, two on the most sensitive.
const TIER_DEFAULTS = { low: 0, medium: 1, high: 2 };
// As many paths as a reason lists per rule; the count beside them is of all that matched.
const LISTED_PATHS = 20;
const PATH_SHOWN = 300;

const invalid = (message) => Object.assign(new Error(message), { status: 400 });
const isObject = (value) => !!value && typeof value === 'object' && !Array.isArray(value);
const onlyKeys = (value, allowed, what) => {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length) throw invalid(`${what} has unknown fields: ${unknown.join(', ')}`);
};
const count = (value, what, max = POLICY_LIMITS.approvals) => {
  if (!Number.isInteger(value) || value < 0 || value > max)
    throw invalid(`${what} must be a whole number from 0 to ${max}`);
  return value;
};

// ---- the glob syntax of a sensitive-path rule ----
//
// A pattern is matched against a changed file's path as GitHub reports it: relative to
// the repository root, `/` between segments, no leading slash, case-sensitive.
//
// - `?` is exactly one character of a segment and `*` any run of them, none included;
//   neither crosses a `/`.
// - `**` is a segment of its own and stands for any number of whole segments, none
//   included (`a/**/b` matches `a/b`); as the last segment it stands for at least one, so
//   `a/**` is everything under `a` and not a file called `a`.
// - A leading `/` anchors the pattern at the repository root. So does a `/` anywhere
//   inside it. A pattern with no `/` inside (`*.pem`, `secrets/`) matches at any depth.
// - A pattern matches the path it names and everything beneath it: `/config` covers
//   `config/app.yml`. A trailing `/` says the name is a directory, so only what is
//   beneath it matches.
//
// Everything else is refused when the policy is saved rather than matched as something
// it is not: negation (`!`), character classes (`[a-z]`), braces (`{a,b}`), escapes
// (`\`), a `**` glued to other characters (`**.js`, `a**`), and `.` or `..` segments.

/**
 * @typedef {{ source: string, dirOnly: boolean, segments: Array<{ any: boolean, text: string, wild: boolean }> }} Glob
 */

/**
 * Check a pattern and return it in the form globMatches reads. Throws, with why, on
 * anything outside the syntax above.
 * @param {unknown} pattern @returns {Glob}
 */
export function compileGlob(pattern) {
  if (typeof pattern !== 'string' || !pattern) throw invalid('A path pattern must be a non-empty string');
  const shown = JSON.stringify(pattern.slice(0, 60));
  if (pattern.length > POLICY_LIMITS.pattern)
    throw invalid(`The path pattern ${shown}… is longer than ${POLICY_LIMITS.pattern} characters`);
  if (pattern !== pattern.trim()) throw invalid(`The path pattern ${shown} starts or ends with whitespace`);
  if (/[\u0000-\u001f\u007f]/.test(pattern))
    throw invalid(`The path pattern ${shown} holds a control character`);
  if (pattern.startsWith('!'))
    throw invalid(`The path pattern ${shown} is a negation, which is not supported`);
  const unsupported = pattern.match(/[\\[\]{}]/);
  if (unsupported)
    throw invalid(
      `The path pattern ${shown} uses \`${unsupported[0]}\`: character classes, braces and escapes are not supported`,
    );
  const rooted = pattern.startsWith('/');
  const dirOnly = pattern.length > 1 && pattern.endsWith('/');
  const body = pattern.slice(rooted ? 1 : 0, dirOnly ? -1 : undefined);
  if (!body) throw invalid(`The path pattern ${shown} names nothing: write \`**\` for every file`);
  const parts = body.split('/');
  /** @type {Glob['segments']} */
  const segments = [];
  for (const part of parts) {
    if (!part) throw invalid(`The path pattern ${shown} has an empty segment`);
    if (part === '.' || part === '..') throw invalid(`The path pattern ${shown} has a \`${part}\` segment`);
    if (part === '**') {
      // Two in a row say what one says.
      if (!segments.at(-1)?.any) segments.push({ any: true, text: '', wild: false });
    } else if (part.includes('**')) {
      throw invalid(
        `The path pattern ${shown} uses \`**\` inside a segment: it has to be a segment of its own`,
      );
    } else {
      segments.push({ any: false, text: part, wild: /[*?]/.test(part) });
    }
  }
  // Nothing anchors a single name: it is looked for at every depth.
  if (!rooted && parts.length === 1 && !segments[0].any)
    segments.unshift({ any: true, text: '', wild: false });
  return { source: pattern, dirOnly, segments };
}

// One segment against one name. `*` keeps a single place to come back to, so the work
// is bounded by the two lengths multiplied, whatever the pattern.
function segmentMatches(text, name) {
  let t = 0;
  let n = 0;
  let star = -1;
  let resume = 0;
  while (n < name.length) {
    if (t < text.length && text[t] === '*') {
      star = t++;
      resume = n;
    } else if (t < text.length && (text[t] === '?' || text[t] === name[n])) {
      t++;
      n++;
    } else if (star >= 0) {
      t = star + 1;
      n = ++resume;
    } else {
      return false;
    }
  }
  while (t < text.length && text[t] === '*') t++;
  return t === text.length;
}

/**
 * Whether a compiled pattern matches a path. Worked out as a table over the pattern's
 * segments and the path's, each cell once, so no pattern can make it take more than
 * their product: there is nothing to backtrack into.
 * @param {Glob} glob @param {string} path
 */
export function globMatches(glob, path) {
  if (typeof path !== 'string' || !path) return false;
  const names = path.split('/').filter(Boolean);
  const { segments, dirOnly } = glob;
  const P = segments.length;
  const S = names.length;
  // matched[s]: the pattern from segment p on matches the path from name s on. Past the
  // pattern's end, what is left of the path lies beneath what matched; a directory
  // pattern needs there to be something left.
  let matched = Array.from({ length: S + 1 }, (_, s) => (dirOnly ? s < S : true));
  for (let p = P - 1; p >= 0; p--) {
    const segment = segments[p];
    const next = matched;
    matched = new Array(S + 1).fill(false);
    for (let s = S; s >= 0; s--) {
      if (segment.any)
        // The last segment takes at least one name; elsewhere none will do.
        matched[s] =
          p === P - 1 ? s < S && (next[s + 1] || matched[s + 1]) : next[s] || (s < S && matched[s + 1]);
      else
        matched[s] =
          s < S &&
          next[s + 1] &&
          (segment.wild ? segmentMatches(segment.text, names[s]) : segment.text === names[s]);
    }
  }
  return matched[0];
}

// ---- the project's policy ----

/**
 * The approval policy a project stores, checked and filled in; null for none. Throws
 * with why on anything it does not understand: a misspelt field that was silently
 * dropped would be a requirement nobody is held to.
 *
 * ```
 * {
 *   enabled,                    // only `true` switches the policy on
 *   tiers: { low|medium|high: { approvals, requireSecurity } },
 *   rules: [{ pattern, tier, label, approvals }],   // sensitive paths, in the order shown
 *   thresholds: { medium|high: { files, lines } },  // size alone raises the tier
 *   acceptGithubApprovals,      // whether an approval on GitHub can count at all
 *   allowSelfApproval,          // whether who wrote the change may approve it
 *   securitySignalTier,         // the least tier of a change whose security result is not clean
 * }
 * ```
 *
 * A higher tier never asks for less than a lower one, in approvals or in checks, so
 * that raising a tier can only add to what is required.
 * @param {unknown} input
 */
export function normalizeApprovalPolicy(input) {
  if (input == null || input === '') return null;
  if (!isObject(input)) throw invalid('approvalPolicy must be an object, or null for none');
  const policy = /** @type {Record<string, any>} */ (input);
  onlyKeys(
    policy,
    [
      'enabled',
      'tiers',
      'rules',
      'thresholds',
      'acceptGithubApprovals',
      'allowSelfApproval',
      'securitySignalTier',
    ],
    'approvalPolicy',
  );
  // Real booleans only: each of these decides whether a merge is held back.
  const flag = (key, fallback) => {
    if (policy[key] === undefined) return fallback;
    if (typeof policy[key] !== 'boolean') throw invalid(`approvalPolicy.${key} must be true or false`);
    return policy[key];
  };
  if (typeof policy.enabled !== 'boolean') throw invalid('approvalPolicy.enabled must be true or false');

  if (policy.tiers !== undefined && !isObject(policy.tiers))
    throw invalid('approvalPolicy.tiers must be an object');
  if (policy.tiers) onlyKeys(policy.tiers, RISK_TIERS, 'approvalPolicy.tiers');
  /** @type {Record<string, { approvals: number, requireSecurity: boolean }>} */
  const tiers = {};
  for (const tier of RISK_TIERS) {
    const given = policy.tiers?.[tier];
    if (given !== undefined && !isObject(given))
      throw invalid(`approvalPolicy.tiers.${tier} must be an object`);
    if (given) onlyKeys(given, ['approvals', 'requireSecurity'], `approvalPolicy.tiers.${tier}`);
    if (given?.requireSecurity !== undefined && typeof given.requireSecurity !== 'boolean')
      throw invalid(`approvalPolicy.tiers.${tier}.requireSecurity must be true or false`);
    tiers[tier] = {
      approvals:
        given?.approvals === undefined
          ? TIER_DEFAULTS[tier]
          : count(given.approvals, `approvalPolicy.tiers.${tier}.approvals`),
      requireSecurity: given?.requireSecurity === true,
    };
  }
  for (let i = 1; i < RISK_TIERS.length; i++) {
    const [lower, upper] = [RISK_TIERS[i - 1], RISK_TIERS[i]];
    if (tiers[upper].approvals < tiers[lower].approvals)
      throw invalid(
        `approvalPolicy.tiers.${upper}.approvals (${tiers[upper].approvals}) is less than ${lower}’s (${tiers[lower].approvals}): a higher tier cannot ask for fewer approvals`,
      );
    if (tiers[lower].requireSecurity && !tiers[upper].requireSecurity)
      throw invalid(
        `approvalPolicy.tiers.${lower} requires the security pass and ${upper} does not: a higher tier cannot require less`,
      );
  }

  const tierName = (value, what) => {
    if (!RISK_TIERS.includes(value)) throw invalid(`${what} must be one of ${RISK_TIERS.join(', ')}`);
    return value;
  };
  if (policy.rules !== undefined && !Array.isArray(policy.rules))
    throw invalid('approvalPolicy.rules must be a list');
  if ((policy.rules || []).length > POLICY_LIMITS.rules)
    throw invalid(`approvalPolicy.rules holds more than ${POLICY_LIMITS.rules} rules`);
  const rules = (policy.rules || []).map((rule, i) => {
    const what = `approvalPolicy.rules[${i}]`;
    if (!isObject(rule)) throw invalid(`${what} must be an object`);
    onlyKeys(rule, ['pattern', 'tier', 'label', 'approvals'], what);
    let pattern;
    try {
      pattern = compileGlob(rule.pattern).source;
    } catch (e) {
      throw invalid(`${what}: ${e.message}`);
    }
    const tier = tierName(rule.tier, `${what}.tier`);
    if (rule.label != null && typeof rule.label !== 'string') throw invalid(`${what}.label must be text`);
    const label = String(rule.label ?? '').trim();
    if (label.length > POLICY_LIMITS.label)
      throw invalid(`${what}.label is longer than ${POLICY_LIMITS.label} characters`);
    const approvals = rule.approvals == null ? null : count(rule.approvals, `${what}.approvals`);
    // A rule's own count adds to its tier's; one below it would be a requirement that
    // reads as set and is never applied.
    if (approvals != null && approvals < tiers[tier].approvals)
      throw invalid(
        `${what}.approvals (${approvals}) is less than its tier’s (${tiers[tier].approvals}): a rule can only raise the count`,
      );
    return { pattern, tier, label, approvals };
  });

  if (policy.thresholds !== undefined && !isObject(policy.thresholds))
    throw invalid('approvalPolicy.thresholds must be an object');
  // Not for the lowest tier: every change is at least that.
  const raised = RISK_TIERS.slice(1);
  if (policy.thresholds) onlyKeys(policy.thresholds, raised, 'approvalPolicy.thresholds');
  /** @type {Record<string, { files: number | null, lines: number | null }>} */
  const thresholds = {};
  for (const tier of raised) {
    const given = policy.thresholds?.[tier];
    if (given == null) continue;
    const what = `approvalPolicy.thresholds.${tier}`;
    if (!isObject(given)) throw invalid(`${what} must be an object`);
    onlyKeys(given, ['files', 'lines'], what);
    const size = (key) => {
      if (given[key] == null) return null;
      if (!Number.isInteger(given[key]) || given[key] < 1 || given[key] > POLICY_LIMITS.size)
        throw invalid(`${what}.${key} must be a whole number of at least 1`);
      return given[key];
    };
    const entry = { files: size('files'), lines: size('lines') };
    if (entry.files != null || entry.lines != null) thresholds[tier] = entry;
  }
  for (const key of /** @type {const} */ (['files', 'lines'])) {
    const [medium, high] = [thresholds.medium?.[key], thresholds.high?.[key]];
    if (medium != null && high != null && high < medium)
      throw invalid(
        `approvalPolicy.thresholds.high.${key} (${high}) is below medium’s (${medium}): the higher tier starts later, not earlier`,
      );
  }

  const securitySignalTier =
    policy.securitySignalTier == null || policy.securitySignalTier === ''
      ? null
      : tierName(policy.securitySignalTier, 'approvalPolicy.securitySignalTier');
  return {
    enabled: policy.enabled,
    tiers,
    rules,
    thresholds,
    acceptGithubApprovals: flag('acceptGithubApprovals', false),
    allowSelfApproval: flag('allowSelfApproval', false),
    securitySignalTier,
  };
}

/**
 * The project's approval policy while it is switched on, else null: a project without
 * one, or with one it keeps switched off, asks for nothing.
 * @param {any} project @returns {NonNullable<ReturnType<typeof normalizeApprovalPolicy>> | null}
 */
export function approvalPolicyOf(project) {
  const policy = project?.approvalPolicy;
  // In the shape normalizeApprovalPolicy stores, or not at all: a row somebody wrote by
  // hand is no policy rather than one the rules would trip over.
  const whole =
    isObject(policy) &&
    isObject(policy.tiers) &&
    RISK_TIERS.every((tier) => Number.isInteger(policy.tiers[tier]?.approvals)) &&
    Array.isArray(policy.rules) &&
    isObject(policy.thresholds);
  return whole && policy.enabled === true ? policy : null;
}

/**
 * Names the rules an assessment was made under, so one made under other rules is
 * recognised as such. Only what the assessment reads: who may approve changes nothing
 * about how risky a diff is.
 * @param {NonNullable<ReturnType<typeof normalizeApprovalPolicy>>} policy
 */
export function policyFingerprint(policy) {
  return createHash('sha256')
    .update(JSON.stringify([policy.tiers, policy.rules, policy.thresholds]))
    .digest('hex')
    .slice(0, 32);
}

// ---- the assessment ----

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const shownPath = (path) => {
  const whole = String(path).toWellFormed();
  return whole.length > PATH_SHOWN ? `${whole.slice(0, PATH_SHOWN - 1)}…` : whole;
};
const UNKNOWN_WORDS = {
  not_assessed: 'Briareus has not read the changed files of this revision yet',
  policy_changed: 'the changed files were assessed under an earlier version of the policy',
  github_error: 'GitHub could not be read',
  head_moved: 'the pull request moved on while its files were being read',
  too_many_files: 'the pull request changes more files than GitHub lists',
  list_incomplete: 'GitHub listed fewer files than the pull request changes',
};

// What of a path is held against the rules. Matching costs the pattern's length times
// the path's, per rule, so a path past these is not matched at all, and a file that
// cannot be matched is not a file that matched nothing: it stands as the highest tier.
export const PATH_LIMITS = { length: 1024, segments: 64 };
// How long an assessment keeps the event loop before it lets other work through.
const YIELD_AFTER_MS = 12;

const unassessable = (path) => {
  if (path.length > PATH_LIMITS.length) return true;
  let segments = 1;
  for (let i = path.indexOf('/'); i !== -1; i = path.indexOf('/', i + 1))
    if (++segments > PATH_LIMITS.segments) return true;
  return false;
};

// One assessment under way: files are added one at a time, so that a caller with many
// of them can let the event loop turn in between (assessRiskInBatches).
function assessor(policy) {
  const rules = policy.rules.map((rule, i) => ({
    rule,
    place: i + 1,
    glob: compileGlob(rule.pattern),
    paths: [],
    renamedFrom: [],
    matched: 0,
  }));
  const beyond = { count: 0, paths: [] };
  let files = 0;
  let lines = 0;
  return {
    /** @param {{ path: string, previousPath?: string | null, additions?: number, deletions?: number }} file */
    add(file) {
      files++;
      lines += (file.additions || 0) + (file.deletions || 0);
      const path = String(file.path || '');
      const previous = file.previousPath ? String(file.previousPath) : null;
      if (unassessable(path) || (previous && unassessable(previous))) {
        beyond.count++;
        if (beyond.paths.length < LISTED_PATHS) beyond.paths.push(shownPath(path));
        return;
      }
      for (const entry of rules) {
        const now = globMatches(entry.glob, path);
        const before = !!previous && globMatches(entry.glob, previous);
        if (!now && !before) continue;
        entry.matched++;
        if (now && entry.paths.length < LISTED_PATHS) entry.paths.push(shownPath(path));
        // Listed apart: the file is no longer where the rule looks.
        if (!now && entry.renamedFrom.length < LISTED_PATHS)
          entry.renamedFrom.push({ from: shownPath(previous), to: shownPath(path) });
      }
    },
    /** @param {{ complete?: boolean, incomplete?: string | null, detail?: string | null }} [read] */
    finish({ complete = true, incomplete = null, detail = null } = {}) {
      /** @type {any[]} */
      const reasons = [];
      let tier = RISK_TIERS[0];
      let approvals = 0;
      for (const { rule, place, paths, renamedFrom, matched } of rules) {
        if (!matched) continue;
        tier = higherTier(tier, rule.tier);
        if (rule.approvals != null) approvals = Math.max(approvals, rule.approvals);
        const named = rule.label ? `${rule.label} (\`${rule.pattern}\`)` : `\`${rule.pattern}\``;
        reasons.push({
          code: 'sensitive_path',
          tier: rule.tier,
          rule: place,
          pattern: rule.pattern,
          label: rule.label || null,
          approvals: rule.approvals,
          matched,
          paths,
          renamedFrom,
          message: `${plural(matched, 'changed file matches', 'changed files match')} ${named}, a ${rule.tier}-risk path${rule.approvals != null ? ` that asks for ${plural(rule.approvals, 'approval', 'approvals')}` : ''}: ${[...paths, ...renamedFrom.map((r) => `${r.from} (moved to ${r.to})`)].slice(0, 5).join(', ')}${matched > 5 ? ', …' : ''}.`,
        });
      }
      for (const name of RISK_TIERS) {
        const threshold = policy.thresholds[name];
        if (!threshold) continue;
        for (const [key, value, what] of /** @type {const} */ ([
          ['files', files, 'files'],
          ['lines', lines, 'changed lines'],
        ])) {
          if (threshold[key] == null || value < threshold[key]) continue;
          tier = higherTier(tier, name);
          reasons.push({
            code: key === 'files' ? 'size_files' : 'size_lines',
            tier: name,
            threshold: threshold[key],
            value,
            message: `The change has ${value} ${what}, at or over the ${name}-risk threshold of ${threshold[key]}.`,
          });
        }
      }
      if (beyond.count) {
        tier = HIGHEST_TIER;
        reasons.unshift({
          code: 'path_unassessable',
          tier: HIGHEST_TIER,
          matched: beyond.count,
          paths: beyond.paths,
          message: `${plural(beyond.count, 'changed file has', 'changed files have')} a path too long to hold against the rules (over ${PATH_LIMITS.length} characters or ${PATH_LIMITS.segments} segments), so the change is treated as ${HIGHEST_TIER} risk.`,
        });
      }
      const unknown = !complete;
      if (unknown) {
        tier = HIGHEST_TIER;
        const why = UNKNOWN_WORDS[incomplete || ''] || 'the changed files could not be read completely';
        reasons.unshift({
          code: 'file_list_unknown',
          tier: HIGHEST_TIER,
          why: incomplete || 'list_incomplete',
          message: `The risk of this change could not be assessed (${why}${detail ? `: ${detail}` : ''}), so it is treated as ${HIGHEST_TIER} risk.`,
        });
      } else if (!reasons.length) {
        reasons.push({
          code: 'no_rule_matched',
          tier,
          message: `No sensitive-path rule or size threshold applies to the ${plural(files, 'changed file', 'changed files')}.`,
        });
      }
      return {
        tier,
        unknown,
        // What the tier asks for, and whatever a matched rule asks for beyond it.
        approvals: Math.max(approvals, policy.tiers[tier].approvals),
        requireSecurity: policy.tiers[tier].requireSecurity,
        reasons,
        files,
        lines,
      };
    },
  };
}

/**
 * The risk of a change under a policy.
 *
 * Every rule is tried against every changed file, and against the path a renamed file
 * had before: moving a file out of a sensitive directory touches that directory as much
 * as moving one in. The tier is the highest any matched rule or size threshold names,
 * and never lower than `low`. A rule's own approval count adds to its tier's.
 *
 * A path too long to match (PATH_LIMITS) is not skipped: the file counts as the highest
 * tier, and is listed.
 *
 * `complete` false says the file list is not the whole change (`incomplete` says why):
 * the assessment is then `unknown` and its tier the highest, whatever the files that
 * were read would have given. They are still listed, as far as they go.
 *
 * @param {{
 *   policy: NonNullable<ReturnType<typeof normalizeApprovalPolicy>>,
 *   files?: Array<{ path: string, previousPath?: string | null, status?: string, additions?: number, deletions?: number }>,
 *   complete?: boolean, incomplete?: string | null, detail?: string | null,
 * }} input
 */
export function assessRisk({ policy, files = [], complete = true, incomplete = null, detail = null }) {
  const assessment = assessor(policy);
  for (const file of files) assessment.add(file);
  return assessment.finish({ complete, incomplete, detail });
}

/**
 * The same assessment for a list read from GitHub, which may be thousands of files
 * against dozens of rules: the event loop is let through whenever the work has held it
 * for a few milliseconds, so a large pull request cannot stall the server.
 * @param {Parameters<typeof assessRisk>[0]} input
 * @returns {Promise<ReturnType<typeof assessRisk>>}
 */
export async function assessRiskInBatches({
  policy,
  files = [],
  complete = true,
  incomplete = null,
  detail = null,
}) {
  const assessment = assessor(policy);
  let since = performance.now();
  for (const file of files) {
    assessment.add(file);
    if (performance.now() - since < YIELD_AFTER_MS) continue;
    await new Promise((resolve) => setImmediate(resolve));
    since = performance.now();
  }
  return assessment.finish({ complete, incomplete, detail });
}

/**
 * The assessment that stands for a revision: the stored one when it was made for this
 * head and base branch under the policy as it is now, else an unknown one, which is the
 * highest tier. A stored assessment is never carried over to another revision.
 * @param {NonNullable<ReturnType<typeof normalizeApprovalPolicy>> | null} policy
 * @param {any} stored the pull request's risk record (lib/db.js), or null
 * @param {{ headSha?: string | null, baseRef?: string | null }} revision
 */
export function riskOf(policy, stored, revision) {
  if (!policy) return null;
  const current =
    !!stored?.assessment &&
    !!revision.headSha &&
    stored.headSha === revision.headSha &&
    !!stored.baseRef &&
    (!revision.baseRef || stored.baseRef === revision.baseRef);
  if (current && stored.policyHash === policyFingerprint(policy))
    return { ...stored.assessment, assessedAt: stored.observedAt ?? null };
  return {
    ...assessRisk({ policy, complete: false, incomplete: current ? 'policy_changed' : 'not_assessed' }),
    assessedAt: null,
  };
}

/**
 * Whether any tier of the policy makes the security pass required: only then does a
 * review need the tier before it chooses its steps.
 * @param {NonNullable<ReturnType<typeof normalizeApprovalPolicy>> | null} policy
 */
export function riskRaisesSecurity(policy) {
  return !!policy && RISK_TIERS.some((tier) => policy.tiers[tier].requireSecurity);
}

/**
 * The security policy a pull request's review is held to: the project's, raised to
 * `required` when the change's tier requires the pass. Risk only ever adds a required
 * check; the pass it adds runs on the review's own provider, model and effort.
 * @param {any} project
 * @param {{ tier: string, requireSecurity?: boolean } | null} risk the assessment that stands (riskOf)
 * @returns {{ policy: 'off' | 'advisory' | 'required', raisedBy: string | null }}
 */
export function effectiveSecurityPolicy(project, risk) {
  const policy = securityPolicyOf(project);
  if (policy === 'required' || !risk?.requireSecurity) return { policy, raisedBy: null };
  return { policy: 'required', raisedBy: risk.tier };
}
