import { expect, it, vi } from 'vitest';
import { createDeploymentService, deploymentConfig, greenChecks } from '../lib/deployments.js';
const config = {
  environment: 'production',
  workflow: 'deploy.yml',
  workflowRef: 'main',
  sourceRef: 'release',
  revisionInput: 'revision',
  requireChecks: true,
};
function fixture() {
  let state = { config, attempt: null };
  const request = vi.fn(async (_cfg, method, path, body) => {
    let data = path.includes('/check-runs')
      ? { total_count: 1, check_runs: [{ status: 'completed', conclusion: 'success' }] }
      : path.endsWith('/status')
        ? { total_count: 0, state: 'pending' }
        : path.includes('/commits/')
          ? { sha: 'abc123' }
          : { state: 'active' };
    if (method === 'POST') data = { html_url: 'https://github.com/a/b/actions/runs/1', body };
    return { ok: true, status: 200, json: async () => data };
  });
  const service = createDeploymentService({
    load: async () => structuredClone(state),
    save: async (_key, next) => {
      state = structuredClone(next);
    },
    config: () => ({ githubToken: 'test' }),
    request,
  });
  return { service, request, state: () => state };
}
it('dispatches the reviewed SHA as workflow input exactly once', async () => {
  const { service, request, state } = fixture();
  const plan = await service.plan('a/b');
  await service.deploy('a/b', plan.id);
  expect(request.mock.calls.find((c) => c[1] === 'POST')[3]).toEqual({
    ref: 'main',
    inputs: { revision: 'abc123' },
  });
  await expect(service.deploy('a/b', plan.id)).rejects.toThrow();
  await expect(service.plan('a/b')).rejects.toThrow('acknowledge');
  expect(state().attempt.state).toBe('requested');
  await service.acknowledge('a/b');
  expect((await service.plan('a/b')).sha).toBe('abc123');
});
it('blocks changed configurations and records an uncertain external outcome', async () => {
  const { service, request, state } = fixture();
  let plan = await service.plan('a/b');
  await service.configure('a/b', { ...config, sourceRef: 'other' });
  await expect(service.deploy('a/b', plan.id)).rejects.toThrow('changed');
  plan = await service.plan('a/b');
  request.mockImplementationOnce(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ total_count: 0, check_runs: [] }),
  }));
  await expect(service.deploy('a/b', plan.id)).rejects.toThrow('CI');
  plan = await service.plan('a/b');
  const original = request.getMockImplementation();
  request.mockImplementation(async (...args) => {
    if (args[1] === 'POST') throw Error('timeout');
    return original(...args);
  });
  await expect(service.deploy('a/b', plan.id)).rejects.toThrow('check Actions');
  expect(state().attempt.state).toBe('unknown');
});
it('requires explicit machine settings and refuses incomplete CI', () => {
  expect(() => deploymentConfig({})).toThrow();
  expect(() => deploymentConfig({ ...config, healthUrl: 'file:///etc/passwd' })).toThrow();
  expect(greenChecks({ total_count: 101, check_runs: [] }, { total_count: 0 })).toBe(false);
});

it('keeps the last successful revision distinct from a newer failed attempt', async () => {
  const request = vi.fn(async (_cfg, _method, path) => ({
    ok: true,
    status: 200,
    json: async () =>
      path.includes('/statuses')
        ? [{ state: path.includes('/2/') ? 'failure' : 'success', created_at: 'now' }]
        : [
            { id: 2, sha: 'failed', environment: 'prod' },
            { id: 1, sha: 'published', environment: 'prod' },
          ],
  }));
  const service = createDeploymentService({
    load: async () => ({ config: null, attempt: null }),
    request,
    config: () => ({ githubToken: 'test' }),
  });
  const report = await service.overview('a/b');
  expect(report.active.map((d) => d.sha)).toEqual(['published']);
  await service.overview('a/b');
  expect(request).toHaveBeenCalledTimes(3);
});
