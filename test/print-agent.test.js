import express from 'express';
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { printAgentRoutes, printSessionAllowed } from '../lib/print-agent.js';

const ROUTES = [
  ['/printers', 'GET'],
  ['/jobs', 'GET'],
  ['/jobs', 'POST'],
  ['/jobs/Office-1', 'DELETE'],
];

let server, base, job, project, service, readFile, jobCounter;
beforeEach(async () => {
  job = { id: 'chat', kind: 'devchat', repo: 'owner/repo', status: 'running' };
  project = { repo: job.repo, enabled: true, printToolsEnabled: true };
  jobCounter = 0;
  service = {
    printers: vi.fn(async () => ({
      printers: [{ name: 'Office', state: 'idle', default: true }],
      default: 'Office',
    })),
    print: vi.fn(async (_bytes, options) => ({
      jobId: `Office-${++jobCounter}`,
      printer: options.printer || 'Office',
      copies: 1,
    })),
    jobs: vi.fn(async (ids) => ids.map((id) => ({ jobId: id, state: 'pending' }))),
    cancel: vi.fn(async (id) => ({ jobId: id, canceled: true })),
  };
  readFile = vi.fn(async () => Buffer.from('%PDF-1.4'));
  const app = express();
  app.use(express.json());
  app.use(
    printAgentRoutes({
      service,
      readFile,
      getProject: (repo) => (project?.repo === repo ? project : null),
      agentSession: (req, res) => {
        const token = req.headers.authorization;
        if (token === 'Bearer other-token') return { ...job, id: 'other' };
        if (token !== 'Bearer session-token') {
          res.status(401).json({ error: 'Unknown session token' });
          return null;
        }
        return job;
      },
    }),
  );
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
afterEach(async () => {
  await new Promise((resolve) => server.close(resolve));
});

const request = (path, method = 'GET', body = undefined, token = 'session-token') =>
  fetch(`${base}/api/agent/print${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

describe('session print authorization', () => {
  it.each([
    null,
    {},
    { printToolsEnabled: false },
    { printToolsEnabled: 'true' },
    { mailToolsEnabled: true, whatsappToolsEnabled: true },
    { printToolsEnabled: true, enabled: false },
  ])('refuses projects without their own explicit opt-in: %j', async (settings) => {
    project = settings == null ? null : { repo: job.repo, ...settings };
    for (const [path, method] of ROUTES)
      expect((await request(path, method, method === 'POST' ? { path: '/w/a.pdf' } : undefined)).status).toBe(
        403,
      );
    for (const fn of Object.values(service)) expect(fn).not.toHaveBeenCalled();
    expect(readFile).not.toHaveBeenCalled();
  });

  it('rejects unknown tokens', async () => {
    expect((await request('/printers', 'GET', undefined, 'bad')).status).toBe(401);
  });

  it.each([
    'parentId',
    'loopParentId',
    'qaParentId',
    'loopFixParentId',
    'autoClose',
    'reviewBranch',
    'qaBranch',
    'readOnly',
    'preview',
    'unattendedTurn',
  ])('refuses %s sessions', async (key) => {
    job[key] = true;
    expect(printSessionAllowed(job, project)).toBe(false);
    for (const [path, method] of ROUTES)
      expect((await request(path, method, method === 'POST' ? {} : undefined)).status).toBe(403);
    expect(service.print).not.toHaveBeenCalled();
  });
});

describe('session printing', () => {
  it('lists the printers', async () => {
    const res = await request('/printers');
    expect(res.status).toBe(200);
    expect((await res.json()).default).toBe('Office');
  });

  it('prints a session file, naming the job after it, and lists only its own jobs', async () => {
    const res = await request('/jobs', 'POST', { path: '/w/out/report.pdf', copies: 2, color: 'monochrome' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      jobId: 'Office-1',
      printer: 'Office',
      copies: 1,
      file: '/w/out/report.pdf',
      size: 8,
    });
    expect(readFile).toHaveBeenCalledWith(job, '/w/out/report.pdf');
    expect(service.print).toHaveBeenCalledWith(Buffer.from('%PDF-1.4'), {
      copies: 2,
      color: 'monochrome',
      title: 'report.pdf',
    });
    expect(await (await request('/jobs')).json()).toEqual({
      jobs: [{ jobId: 'Office-1', state: 'pending' }],
    });
    expect(await (await request('/jobs', 'GET', undefined, 'other-token')).json()).toEqual({ jobs: [] });
  });

  it('refuses files the session may not read, and empty ones', async () => {
    readFile.mockRejectedValueOnce(new Error('Source is not a file belonging to this session'));
    const refused = await request('/jobs', 'POST', { path: '/etc/passwd' });
    expect(refused.status).toBe(400);
    expect((await refused.json()).error).toMatch(/belonging to this session/);
    readFile.mockResolvedValueOnce(Buffer.alloc(0));
    expect((await request('/jobs', 'POST', { path: '/w/empty.pdf' })).status).toBe(400);
    expect(service.print).not.toHaveBeenCalled();
  });

  it('checks the opt-in again after reading the file', async () => {
    readFile.mockImplementationOnce(async () => {
      project.printToolsEnabled = false;
      return Buffer.from('x');
    });
    expect((await request('/jobs', 'POST', { path: '/w/a.pdf' })).status).toBe(403);
    expect(service.print).not.toHaveBeenCalled();
  });

  it('cancels only jobs this session sent', async () => {
    await request('/jobs', 'POST', { path: '/w/a.pdf' });
    expect((await request('/jobs/Office-1', 'DELETE', undefined, 'other-token')).status).toBe(404);
    expect((await request('/jobs/Office-99', 'DELETE')).status).toBe(404);
    expect(service.cancel).not.toHaveBeenCalled();
    const res = await request('/jobs/Office-1', 'DELETE');
    expect(await res.json()).toEqual({ jobId: 'Office-1', canceled: true });
  });

  it('passes service errors through with their status', async () => {
    service.print.mockRejectedValueOnce(Object.assign(new Error('Unknown printer "Nope"'), { status: 404 }));
    const res = await request('/jobs', 'POST', { path: '/w/a.pdf', printer: 'Nope' });
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe('Unknown printer "Nope"');
  });
});
