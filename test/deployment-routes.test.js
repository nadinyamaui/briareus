import express from 'express';
import { expect, it, vi } from 'vitest';
import { deploymentRoutes } from '../lib/deployment-routes.js';
it('does not dispatch for unknown projects', async () => {
  const deploy = vi.fn();
  const app = express();
  app.use(express.json());
  app.use(deploymentRoutes({ service: { deploy }, getProject: () => null }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  try {
    const res = await fetch(
      `http://127.0.0.1:${server.address().port}/api/operations/deployments/dispatch?repo=a/b`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
    );
    expect(res.status).toBe(404);
    expect(deploy).not.toHaveBeenCalled();
  } finally {
    await new Promise((r) => server.close(r));
  }
});

it('requires the dashboard project to drain before a deployment dispatch', async () => {
  const deploy = vi.fn();
  const app = express();
  app.use(express.json());
  app.use(
    deploymentRoutes({
      service: { deploy },
      getProject: () => ({ isSelf: true }),
      readyForSelfDeploy: () => false,
    }),
  );
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  try {
    const res = await fetch(
      `http://127.0.0.1:${server.address().port}/api/operations/deployments/dispatch?repo=a/b`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('Drain');
    expect(deploy).not.toHaveBeenCalled();
  } finally {
    await new Promise((r) => server.close(r));
  }
});

it('keeps deployment settings readable while GitHub is unavailable', async () => {
  const app = express();
  app.use(
    deploymentRoutes({
      service: {
        settings: async () => ({ config: { workflow: 'deploy.yml' } }),
        overview: async () => {
          throw Error('GitHub unavailable');
        },
      },
      getProject: () => ({ repo: 'a/b' }),
    }),
  );
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  try {
    const res = await fetch(
      `http://127.0.0.1:${server.address().port}/api/operations/deployments/config?repo=a/b`,
    );
    expect(res.status).toBe(200);
    expect((await res.json()).config.workflow).toBe('deploy.yml');
  } finally {
    await new Promise((r) => server.close(r));
  }
});
