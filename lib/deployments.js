// @ts-check
import { randomUUID } from 'node:crypto';
import { loadAppSetting, saveAppSetting } from './db.js';
import { githubRest } from './github.js';
import { getConfig } from './config.js';
export function deploymentConfig(input) {
  const result = {};
  for (const key of ['environment', 'workflow', 'workflowRef', 'sourceRef', 'revisionInput']) {
    const value = typeof input[key] === 'string' ? input[key].trim() : '';
    if (!value || value.length > 200 || /[\x00-\x1f]/.test(value))
      throw new Error(`Set ${key} for this project`);
    result[key] = value;
  }
  if (!/^[\w.-]+$/.test(result.workflow) || !/^[a-zA-Z_][\w-]*$/.test(result.revisionInput))
    throw new Error('Invalid workflow filename or revision input');
  result.requireChecks = input.requireChecks !== false;
  result.healthUrl = '';
  if (input.healthUrl) {
    const url = new URL(input.healthUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
      throw new Error('Use an HTTP(S) health URL without credentials');
    result.healthUrl = url.href;
  }
  return result;
}
export function greenChecks(runs, statuses) {
  return (
    (runs.total_count || 0) + (statuses.total_count || 0) > 0 &&
    (runs.total_count || 0) <= runs.check_runs.length &&
    runs.check_runs.every(
      (r) => r.status === 'completed' && ['success', 'neutral', 'skipped'].includes(r.conclusion),
    ) &&
    (!(statuses.total_count > 0) || statuses.state === 'success')
  );
}
export function createDeploymentService({
  load = loadAppSetting,
  save = saveAppSetting,
  request = githubRest,
  config = getConfig,
  probe = fetch,
} = {}) {
  const locks = new Set(),
    plans = new Map(),
    cache = new Map();
  const key = (repo) => `deployments:${repo}`;
  async function github(repo, method, path, body = undefined) {
    const cfg = config();
    if (!cfg.githubToken) throw new Error('No GitHub token is configured');
    const response = await request(cfg, method, `/repos/${repo}${path}`, body);
    if (!response.ok) throw new Error(`GitHub answered ${response.status}`);
    return response.status === 204 ? {} : response.json();
  }
  const read = (repo) => load(key(repo), { config: null, attempt: null });
  async function exclusive(repo, fn) {
    if (locks.has(repo)) throw new Error('A deployment operation is already running');
    locks.add(repo);
    try {
      return await fn();
    } finally {
      locks.delete(repo);
    }
  }
  async function health(url) {
    if (!url) return { state: 'not-configured' };
    try {
      const res = await probe(url, { signal: AbortSignal.timeout(5000), redirect: 'error' });
      await res.body?.cancel();
      return {
        state: res.ok ? 'healthy' : 'unhealthy',
        status: res.status,
        checkedAt: new Date().toISOString(),
      };
    } catch {
      return { state: 'unreachable', checkedAt: new Date().toISOString() };
    }
  }
  return {
    settings: read,
    async configure(repo, input) {
      return exclusive(repo, async () => {
        const state = await read(repo);
        if (state.attempt && !state.attempt.acknowledged)
          throw new Error('Check and acknowledge the last deployment before changing its configuration');
        state.config = deploymentConfig(input);
        await save(key(repo), state);
        cache.delete(repo);
        plans.delete(repo);
        return state.config;
      });
    },
    async overview(repo) {
      const state = await read(repo);
      const hit = cache.get(repo);
      if (hit && Date.now() - hit.at < 30000 && hit.config === JSON.stringify(state.config))
        return { ...hit.value, attempt: state.attempt };
      const query = state.config ? `&environment=${encodeURIComponent(state.config.environment)}` : '';
      const deployments = await github(repo, 'GET', `/deployments?per_page=20${query}`);
      const history = [];
      // Keep GitHub secondary-rate pressure bounded rather than issuing a burst.
      for (const d of deployments) {
        const statuses = await github(repo, 'GET', `/deployments/${d.id}/statuses?per_page=1`);
        const s = statuses[0];
        history.push({
          id: d.id,
          sha: d.sha,
          environment: d.environment,
          createdAt: d.created_at,
          state: s?.state || 'pending',
          updatedAt: s?.created_at || d.created_at,
          url: s?.environment_url || null,
          logUrl: s?.log_url || null,
        });
      }
      const active = history
        .filter((d) => d.state === 'success')
        .filter((d, i, all) => all.findIndex((a) => a.environment === d.environment) === i);
      const value = {
        config: state.config,
        attempt: state.attempt,
        history,
        active,
        historyLimited: deployments.length === 20,
        health: await health(state.config?.healthUrl),
        checkedAt: new Date().toISOString(),
      };
      cache.set(repo, { at: Date.now(), config: JSON.stringify(state.config), value });
      return value;
    },
    async plan(repo) {
      const state = await read(repo);
      if (!state.config) throw new Error('Configure a deployment workflow first');
      if (state.attempt && !state.attempt.acknowledged)
        throw new Error('Check the last deployment in Actions and acknowledge it before another request');
      const c = state.config;
      const commit = await github(repo, 'GET', `/commits/${encodeURIComponent(c.sourceRef)}`);
      const workflow = await github(repo, 'GET', `/actions/workflows/${encodeURIComponent(c.workflow)}`);
      if (workflow.state !== 'active') throw new Error('The configured workflow is not active');
      const [runs, statuses] = await Promise.all([
        github(repo, 'GET', `/commits/${commit.sha}/check-runs?per_page=100`),
        github(repo, 'GET', `/commits/${commit.sha}/status`),
      ]);
      const checksPassed = greenChecks(runs, statuses);
      const plan = {
        id: randomUUID(),
        sha: commit.sha,
        config: c,
        checksPassed,
        expiresAt: Date.now() + 5 * 60000,
      };
      plans.set(repo, plan);
      return plan;
    },
    async deploy(repo, planId) {
      return exclusive(repo, async () => {
        const plan = plans.get(repo);
        plans.delete(repo);
        const state = await read(repo);
        if (
          !plan ||
          plan.id !== planId ||
          plan.expiresAt < Date.now() ||
          JSON.stringify(plan.config) !== JSON.stringify(state.config)
        )
          throw new Error('Deployment plan expired or changed; inspect it again');
        if (state.attempt && !state.attempt.acknowledged)
          throw new Error('The last deployment has not been acknowledged');
        const c = plan.config;
        if (c.requireChecks) {
          const [runs, statuses] = await Promise.all([
            github(repo, 'GET', `/commits/${plan.sha}/check-runs?per_page=100`),
            github(repo, 'GET', `/commits/${plan.sha}/status`),
          ]);
          if (!greenChecks(runs, statuses))
            throw new Error('CI is missing, incomplete or not green for this commit');
        }
        state.attempt = {
          sha: plan.sha,
          environment: c.environment,
          at: new Date().toISOString(),
          state: 'submitting',
          acknowledged: false,
          url: `https://github.com/${repo}/actions`,
        };
        await save(key(repo), state);
        try {
          const run = await github(
            repo,
            'POST',
            `/actions/workflows/${encodeURIComponent(c.workflow)}/dispatches`,
            { ref: c.workflowRef, inputs: { [c.revisionInput]: plan.sha } },
          );
          state.attempt.state = 'requested';
          if (run.html_url) state.attempt.url = run.html_url;
          await save(key(repo), state);
          cache.delete(repo);
          return state.attempt;
        } catch (e) {
          state.attempt.state = 'unknown';
          await save(key(repo), state);
          throw new Error(
            `Deployment request could not be confirmed (${e.message}); check Actions before requesting another`,
            { cause: e },
          );
        }
      });
    },
    async acknowledge(repo) {
      return exclusive(repo, async () => {
        const state = await read(repo);
        if (state.attempt) {
          state.attempt.acknowledged = true;
          await save(key(repo), state);
        }
        return state;
      });
    },
  };
}
