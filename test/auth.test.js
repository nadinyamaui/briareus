import { describe, it, expect, vi, beforeEach } from 'vitest';

const state = vi.hoisted(() => ({ cfg: null }));

vi.mock('../lib/config.js', () => ({
  getConfig: () => state.cfg,
}));

import { apiEnabled, agentOnly } from '../lib/auth.js';

beforeEach(() => {
  state.cfg = { auth: { secret: 'top-secret' } };
});

describe('apiEnabled', () => {
  it('is on once a signing secret is set', () => {
    expect(apiEnabled()).toBe(true);
  });

  it('is off without one: no token could be checked', () => {
    state.cfg = { auth: { secret: '' } };
    expect(apiEnabled()).toBe(false);
  });
});

describe('agentOnly', () => {
  it('opens only the agent routes, and nothing else on the handlers', () => {
    const handlers = vi.fn();
    const door = agentOnly(handlers);
    const next = vi.fn();
    door({ path: '/api/agent/memories' }, {}, next);
    expect(handlers).toHaveBeenCalledTimes(1);
    for (const path of ['/api/projects', '/api/dev/sessions', '/api/agentless', '/api/v1/api/agent/x', '/'])
      door({ path }, {}, next);
    expect(handlers).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledTimes(5);
  });
});
