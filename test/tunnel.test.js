import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const cfgState = vi.hoisted(() => ({ previewTunnel: null }));
vi.mock('../lib/config.js', () => ({
  getConfig: () => ({ previewTunnel: cfgState.previewTunnel }),
}));

import {
  publicAppUrl,
  previewHostname,
  localHostname,
  serveHostname,
  _resetForTests,
} from '../lib/tunnel.js';

const TUNNEL = {
  apiToken: 'cf-token',
  accountId: 'acct',
  zoneId: 'zone',
  tunnelId: 'tun',
  hostname: 'preview-{port}.example.com',
  accessEmails: ['a@example.com', 'b@example.com'],
};

// A stand-in for the three Cloudflare resources, answering the v4 API's
// envelope. `calls` keeps the order, which is the property that matters most.
let cf;
let calls;

function envelope(result, ok = true) {
  return { ok, status: ok ? 200 : 400, json: async () => ({ success: ok, result, errors: [] }) };
}

function fakeCloudflare(url, opts = {}) {
  const u = new URL(url);
  const method = opts.method || 'GET';
  const body = opts.body ? JSON.parse(opts.body) : undefined;
  calls.push({ method, path: u.pathname, body, auth: opts.headers?.Authorization });
  if (cf.fail && u.pathname.includes(cf.fail)) {
    return {
      ok: false,
      status: 403,
      json: async () => ({ success: false, errors: [{ message: 'denied' }] }),
    };
  }
  if (u.pathname === '/client/v4/accounts/acct/access/apps') {
    if (method === 'GET') return envelope(cf.apps);
    cf.apps.push(body);
    return envelope(body);
  }
  if (u.pathname === '/client/v4/zones/zone/dns_records') {
    if (method === 'GET') return envelope(cf.dns.filter((r) => r.name === u.searchParams.get('name')));
    cf.dns.push(body);
    return envelope(body);
  }
  if (u.pathname === '/client/v4/accounts/acct/cfd_tunnel/tun/configurations') {
    if (method === 'GET') return envelope({ config: cf.config });
    cf.config = body.config;
    return envelope(body);
  }
  throw new Error(`unexpected ${method} ${u.pathname}`);
}

beforeEach(() => {
  _resetForTests();
  cfgState.previewTunnel = { ...TUNNEL };
  calls = [];
  cf = {
    apps: [],
    dns: [],
    config: {
      ingress: [
        { hostname: 'dev.example.com', service: 'http://127.0.0.1:4300' },
        { service: 'http_status:404' },
      ],
      'warp-routing': { enabled: false },
    },
    fail: null,
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url, opts) => fakeCloudflare(url, opts)),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('publicAppUrl', () => {
  it('is null without a tunnel configured, and calls nothing', async () => {
    cfgState.previewTunnel = null;

    expect(await publicAppUrl(8100)).toBeNull();
    expect(calls).toEqual([]);
  });

  it('fills the port into the hostname template', () => {
    expect(previewHostname(8103)).toBe('preview-8103.example.com');
  });

  it('publishes Access first, then DNS, then the ingress route', async () => {
    expect(await publicAppUrl(8100)).toBe('https://preview-8100.example.com');

    const writes = calls.filter((c) => c.method !== 'GET').map((c) => c.path.split('/').pop());
    expect(writes).toEqual(['apps', 'dns_records', 'configurations']);
    expect(calls.every((c) => c.auth === 'Bearer cf-token')).toBe(true);
  });

  it('guards the hostname with every configured email', async () => {
    await publicAppUrl(8100);

    expect(cf.apps[0].domain).toBe('preview-8100.example.com');
    expect(cf.apps[0].policies[0].include).toEqual([
      { email: { email: 'a@example.com' } },
      { email: { email: 'b@example.com' } },
    ]);
  });

  it('points a proxied CNAME at the tunnel', async () => {
    await publicAppUrl(8100);

    expect(cf.dns[0]).toMatchObject({
      type: 'CNAME',
      name: 'preview-8100.example.com',
      content: 'tun.cfargotunnel.com',
      proxied: true,
    });
  });

  it('keeps the other routes and the catch-all last, and the rest of the config', async () => {
    await publicAppUrl(8100);

    expect(cf.config.ingress).toEqual([
      { hostname: 'dev.example.com', service: 'http://127.0.0.1:4300' },
      { hostname: 'preview-8100.example.com', service: 'http://127.0.0.1:8100' },
      { service: 'http_status:404' },
    ]);
    expect(cf.config['warp-routing']).toEqual({ enabled: false });
  });

  it('adds a catch-all when the tunnel has none', async () => {
    cf.config = { ingress: [{ hostname: 'dev.example.com', service: 'http://127.0.0.1:4300' }] };

    await publicAppUrl(8100);

    expect(cf.config.ingress.at(-1)).toEqual({ service: 'http_status:404' });
  });

  it('leaves an existing Access application and DNS record alone', async () => {
    cf.apps.push({ domain: 'preview-8100.example.com', policies: ['hand-edited'] });
    cf.dns.push({ type: 'CNAME', name: 'preview-8100.example.com', content: 'tun.cfargotunnel.com' });

    await publicAppUrl(8100);

    expect(cf.apps).toHaveLength(1);
    expect(cf.dns).toHaveLength(1);
    expect(cf.config.ingress).toHaveLength(3);
  });

  it('refuses a DNS record at the name that points somewhere else, before routing', async () => {
    cf.dns.push({ type: 'A', name: 'preview-8100.example.com', content: '1.2.3.4' });

    await expect(publicAppUrl(8100)).rejects.toThrow(/does not point at the tunnel/);
    expect(calls.some((c) => c.path.endsWith('configurations'))).toBe(false);
  });

  it('never routes the hostname when Access could not be set up', async () => {
    cf.fail = '/access/apps';

    await expect(publicAppUrl(8100)).rejects.toThrow(/denied/);
    expect(calls.some((c) => c.path.endsWith('dns_records') || c.path.endsWith('configurations'))).toBe(
      false,
    );
  });

  it('publishes a port once per process', async () => {
    await publicAppUrl(8100);
    const after = calls.length;

    expect(await publicAppUrl(8100)).toBe('https://preview-8100.example.com');
    expect(calls.length).toBe(after);
  });

  it('tries again after a failure', async () => {
    cf.fail = '/access/apps';
    await expect(publicAppUrl(8100)).rejects.toThrow();
    cf.fail = null;

    expect(await publicAppUrl(8100)).toBe('https://preview-8100.example.com');
  });

  it('serializes two ports so neither ingress write drops the other', async () => {
    await Promise.all([publicAppUrl(8100), publicAppUrl(8101)]);

    expect(cf.config.ingress.map((r) => r.hostname)).toEqual([
      'dev.example.com',
      'preview-8100.example.com',
      'preview-8101.example.com',
      undefined,
    ]);
  });
});

describe('tenant hostnames', () => {
  it('puts the tenant in front of the port label, keeping it one label', () => {
    expect(previewHostname(8101, 'demo')).toBe('demo--preview-8101.example.com');
  });

  it('places the tenant where the template says, and drops it for the port itself', () => {
    cfgState.previewTunnel = { ...TUNNEL, hostname: '{tenant}--preview-{port}.example.com' };
    expect(previewHostname(8101, 'demo')).toBe('demo--preview-8101.example.com');
    expect(previewHostname(8101)).toBe('preview-8101.example.com');

    cfgState.previewTunnel = { ...TUNNEL, hostname: 'preview-{port}-{tenant}.example.com' };
    expect(previewHostname(8101, 'demo')).toBe('preview-8101-demo.example.com');
    expect(previewHostname(8101)).toBe('preview-8101.example.com');
  });

  it('falls back to .localhost names without a tunnel', () => {
    cfgState.previewTunnel = null;
    expect(localHostname(8101, 'demo')).toBe('demo--preview-8101.localhost');
    expect(serveHostname(8101, 'demo')).toBe('demo--preview-8101.localhost');
    expect(serveHostname(8101)).toBe('127.0.0.1');
    expect(previewHostname(8101, 'demo')).toBeNull();
  });

  it('publishes each tenant with an Access app, a CNAME and a route of its own, on the port', async () => {
    const urls = await Promise.all([publicAppUrl(8101, 'central'), publicAppUrl(8101, 'demo')]);

    expect(urls).toEqual([
      'https://central--preview-8101.example.com',
      'https://demo--preview-8101.example.com',
    ]);
    expect(cf.apps.map((a) => a.domain)).toEqual([
      'central--preview-8101.example.com',
      'demo--preview-8101.example.com',
    ]);
    expect(cf.apps[1].policies[0].include).toEqual(cf.apps[0].policies[0].include);
    expect(cf.dns.map((r) => r.name)).toEqual([
      'central--preview-8101.example.com',
      'demo--preview-8101.example.com',
    ]);
    expect(cf.config.ingress.slice(1, 3)).toEqual([
      { hostname: 'central--preview-8101.example.com', service: 'http://127.0.0.1:8101' },
      { hostname: 'demo--preview-8101.example.com', service: 'http://127.0.0.1:8101' },
    ]);
  });

  it('publishes a tenant once per process, apart from its port', async () => {
    await publicAppUrl(8101);
    await publicAppUrl(8101, 'demo');
    const after = calls.length;

    await publicAppUrl(8101, 'demo');
    expect(calls.length).toBe(after);
    expect(cf.apps).toHaveLength(2);
  });
});
