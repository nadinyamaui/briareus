import express from 'express';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createPrintService, runCups } from '../lib/print.js';
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { printAgentRoutes, printSessionAllowed } from '../lib/print-agent.js';

const ROUTES = [
  ['/printers', 'GET'],
  ['/jobs', 'GET'],
  ['/jobs', 'POST'],
  ['/jobs/Office-1', 'DELETE'],
];

let server, base, job, project, service, readFile, jobCounter, sessions;
beforeEach(async () => {
  job = { id: 'chat', kind: 'devchat', repo: 'owner/repo', status: 'running' };
  project = { repo: job.repo, enabled: true, printToolsEnabled: true };
  jobCounter = 0;
  sessions = new EventEmitter();
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
      sessions,
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
    expect(service.print).toHaveBeenCalledWith(
      Buffer.from('%PDF-1.4'),
      {
        copies: 2,
        color: 'monochrome',
        title: 'report.pdf',
      },
      { authorize: expect.any(Function), submitting: expect.any(Function) },
    );
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

describe('print submission lifecycle', () => {
  it.each(['project', 'closed', 'closing', 'stopped', 'restarted'])(
    'rechecks %s authorization after stalled discovery',
    async (revocation) => {
      let release;
      const discovered = new Promise((resolve) => {
        release = resolve;
      });
      const run = vi.fn(async (command) =>
        command === 'lpstat' ? discovered : { code: 0, stdout: 'request id is Office-1', stderr: '' },
      );
      Object.assign(service, createPrintService({ run }));
      const pending = request('/jobs', 'POST', { path: '/w/a.pdf' });
      await vi.waitFor(() => expect(run).toHaveBeenCalled());
      if (revocation === 'project') project.printToolsEnabled = false;
      else if (revocation === 'closed') job.status = 'closed';
      else if (revocation === 'closing') job.closing = true;
      else {
        // Stop, as cancelDevTurn does; a restart begins a new turn before the request resumes.
        Object.assign(job, { turnCanceled: true, status: 'idle', sshCancellationVersion: 1 });
        if (revocation === 'restarted') Object.assign(job, { turnCanceled: false, status: 'running' });
      }
      release({
        code: 0,
        stdout: 'printer Office is idle.\nsystem default destination: Office\n',
        stderr: '',
      });
      expect((await pending).status).toBe(403);
      expect(run.mock.calls.some(([command]) => command === 'lp')).toBe(false);
    },
  );

  it.each(['read', 'submit'])(
    'bounds simultaneous %s operations across sessions and releases slots on failure',
    async (stage) => {
      let release;
      const stalled = new Promise((resolve) => {
        release = resolve;
      });
      if (stage === 'read')
        readFile.mockImplementation(async () => {
          await stalled;
          throw new Error('read failed');
        });
      else
        service.print.mockImplementation(async () => {
          await stalled;
          throw new Error('lp failed');
        });
      const pending = Array.from({ length: 4 }, (_, i) =>
        request('/jobs', 'POST', { path: '/w/a.pdf' }, i % 2 ? 'other-token' : 'session-token'),
      );
      await vi.waitFor(() => expect(stage === 'read' ? readFile : service.print).toHaveBeenCalledTimes(4));
      expect((await request('/jobs', 'POST', { path: '/w/a.pdf' })).status).toBe(429);
      expect(readFile).toHaveBeenCalledTimes(4);
      release();
      expect((await Promise.all(pending)).map((res) => res.status)).toEqual([400, 400, 400, 400]);
      readFile.mockResolvedValue(Buffer.from('x'));
      service.print.mockResolvedValue({ jobId: 'Office-99', printer: 'Office', copies: 1 });
      expect((await request('/jobs', 'POST', { path: '/w/a.pdf' })).status).toBe(200);
    },
  );

  it('retains pending cancellation ownership at capacity, pruning only terminal jobs', async () => {
    for (let i = 0; i < 100; i++)
      expect((await request('/jobs', 'POST', { path: '/w/a.pdf' })).status).toBe(200);
    expect((await request('/jobs', 'POST', { path: '/w/a.pdf' })).status).toBe(409);
    expect(readFile).toHaveBeenCalledTimes(100);
    expect((await (await request('/jobs')).json()).jobs).toHaveLength(100);
    expect((await request('/jobs/Office-1', 'DELETE')).status).toBe(200);
    service.jobs.mockImplementation(async (ids) =>
      ids.map((jobId) => ({
        jobId,
        state: jobId === 'Office-2' ? 'completed' : jobId === 'Office-3' ? 'ended' : 'pending',
      })),
    );
    expect((await request('/jobs', 'POST', { path: '/w/a.pdf' })).status).toBe(200);
    expect((await request('/jobs', 'POST', { path: '/w/a.pdf' })).status).toBe(200);
    const ids = (await (await request('/jobs')).json()).jobs.map((j) => j.jobId);
    expect(ids).toHaveLength(100);
    expect(ids).toContain('Office-1');
    expect(ids).toContain('Office-102');
    expect(ids).not.toContain('Office-2');
    expect(ids).not.toContain('Office-3');
  });

  it.each(['missing', 'not executable'])(
    'releases history after real spawn failures (%s), allowing printing after repair',
    async (failure) => {
      const dir = await mkdtemp(path.join(tmpdir(), 'briareus-print-test-'));
      const executable = path.join(dir, 'lp');
      try {
        if (failure === 'not executable') await writeFile(executable, '', { mode: 0o600 });
        let repaired = false;
        const run = vi.fn(async (command, args) => {
          if (command === 'lp') {
            if (!repaired) return runCups(executable, []);
            return { code: 0, stdout: 'request id is Office-1', stderr: '' };
          }
          if (args[0] === '-o') return { code: 0, stdout: 'Office-1 user 1024 date\n', stderr: '' };
          return {
            code: 0,
            stdout: 'printer Office is idle.\nsystem default destination: Office\n',
            stderr: '',
          };
        });
        Object.assign(service, createPrintService({ run }));
        const recover = vi.spyOn(service, 'recover');
        for (let i = 0; i < 101; i++) {
          const res = await request('/jobs', 'POST', { path: '/w/a.pdf' });
          expect(res.status).toBe(failure === 'missing' ? 503 : 400);
          const { error } = await res.json();
          expect(error).toMatch(failure === 'missing' ? /not installed/ : /EACCES/);
          expect(error).not.toMatch(/uncertain|resubmit/);
        }
        expect(await (await request('/jobs')).json()).toEqual({ jobs: [] });
        expect(recover).not.toHaveBeenCalled();
        repaired = true;
        expect((await request('/jobs', 'POST', { path: '/w/a.pdf' })).status).toBe(200);
        expect(await (await request('/jobs')).json()).toEqual({
          jobs: [{ jobId: 'Office-1', state: 'pending' }],
        });
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  );

  it('retains uncertainty after a real process runs and exits unsuccessfully', async () => {
    const run = vi.fn(async (command) => {
      if (command === 'lp') return runCups(process.execPath, ['-e', 'process.exit(1)']);
      return {
        code: 0,
        stdout: 'printer Office is idle.\nsystem default destination: Office\n',
        stderr: '',
      };
    });
    Object.assign(service, createPrintService({ run }));
    vi.spyOn(service, 'recover').mockResolvedValue([]);
    const res = await request('/jobs', 'POST', { path: '/w/a.pdf' });
    expect(res.status).toBe(502);
    expect((await res.json()).error).toMatch(/submission is uncertain.*Do not resubmit/);
    expect((await (await request('/jobs')).json()).jobs).toEqual([
      { jobId: expect.stringMatching(/^briareus-/), printer: 'Office', state: 'uncertain' },
    ]);
  });

  it('retains uncertain submissions and recovers cancellation ownership without another print', async () => {
    const submission = { jobId: 'briareus-token', marker: 'briareus-token', printer: 'Office', copies: 1 };
    service.print.mockImplementation(async (_bytes, _options, control) => {
      control.submitting(submission);
      throw Object.assign(new Error('lp timed out'), { status: 502 });
    });
    service.recover = vi.fn(async () => []);
    const res = await request('/jobs', 'POST', { path: '/w/a.pdf' });
    expect(res.status).toBe(502);
    expect((await res.json()).error).toBe(
      'lp timed out. The submission is uncertain: CUPS may already have accepted it. Do not resubmit; check print_jobs for briareus-token',
    );
    expect(await (await request('/jobs')).json()).toEqual({
      jobs: [{ jobId: 'briareus-token', printer: 'Office', state: 'uncertain' }],
    });
    expect((await request('/jobs/briareus-token', 'DELETE')).status).toBe(409);
    service.recover.mockResolvedValue([{ ...submission, jobId: 'Office-42' }]);
    expect(await (await request('/jobs')).json()).toEqual({
      jobs: [{ jobId: 'Office-42', state: 'pending' }],
    });
    expect((await request('/jobs/Office-42', 'DELETE', undefined, 'other-token')).status).toBe(404);
    expect((await request('/jobs/Office-42', 'DELETE')).status).toBe(200);
    expect(service.print).toHaveBeenCalledTimes(1);
    expect(service.cancel).toHaveBeenCalledWith('Office-42');
  });

  it('keeps confirmed jobs listable and cancelable when recovery fails', async () => {
    await request('/jobs', 'POST', { path: '/w/a.pdf' });
    const submission = { jobId: 'briareus-token', marker: 'briareus-token', printer: 'Office', copies: 1 };
    service.print.mockImplementationOnce(async (_bytes, _options, control) => {
      control.submitting(submission);
      throw Object.assign(new Error('lp timed out'), { status: 502 });
    });
    expect((await request('/jobs', 'POST', { path: '/w/a.pdf' })).status).toBe(502);
    service.recover = vi.fn(async () => {
      throw Object.assign(new Error('Printing is unavailable: CUPS command ipptool is not installed'), {
        status: 503,
      });
    });
    const res = await request('/jobs');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      jobs: [
        { jobId: 'Office-1', state: 'pending' },
        { jobId: 'briareus-token', printer: 'Office', state: 'uncertain' },
      ],
      recoveryError: 'Printing is unavailable: CUPS command ipptool is not installed',
    });
    service.recover.mockClear();
    expect((await request('/jobs/Office-1', 'DELETE')).status).toBe(200);
    expect(service.recover).not.toHaveBeenCalled();
    expect(service.cancel).toHaveBeenCalledWith('Office-1');
    expect((await request('/jobs/Office-9', 'DELETE')).status).toBe(503);
  });

  it.each(['project', 'closed', 'deleted', 'unattended', 'stopped'])(
    'rechecks %s authorization after recovery before canceling',
    async (revocation) => {
      const submission = { jobId: 'briareus-token', marker: 'briareus-token', printer: 'Office', copies: 1 };
      service.print.mockImplementationOnce(async (_bytes, _options, control) => {
        control.submitting(submission);
        throw Object.assign(new Error('lp timed out'), { status: 502 });
      });
      expect((await request('/jobs', 'POST', { path: '/w/a.pdf' })).status).toBe(502);
      let release;
      service.recover = vi.fn(
        () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      );
      const pending = request('/jobs/Office-42', 'DELETE');
      await vi.waitFor(() => expect(service.recover).toHaveBeenCalled());
      if (revocation === 'project') project.printToolsEnabled = false;
      else if (revocation === 'closed') {
        job.status = 'closed';
        sessions.emit('job', job);
      } else if (revocation === 'deleted') sessions.emit('deleted', job.id);
      else if (revocation === 'unattended') job.unattendedTurn = true;
      else Object.assign(job, { turnCanceled: true, status: 'idle', sshCancellationVersion: 1 });
      release([{ ...submission, jobId: 'Office-42' }]);
      expect((await pending).status).toBe(403);
      expect(service.cancel).not.toHaveBeenCalled();
    },
  );

  it('recovers a timed-out real service submission for direct cancellation and isolates the other session', async () => {
    let marker;
    const run = vi.fn(async (command, args) => {
      if (command === 'lp') {
        marker = args[args.indexOf('-t') + 1].split(' ')[0];
        return { code: null, stdout: '', stderr: '' };
      }
      if (command === 'ipptool')
        return {
          code: 0,
          stderr: '',
          stdout: `<key>ResponseAttributes</key><array><dict>
            <key>job-id</key><integer>42</integer>
            <key>job-name</key><string>${marker} a.pdf</string>
            <key>job-printer-uri</key><string>ipp://localhost/printers/Office</string>
          </dict></array>`,
        };
      if (command === 'cancel') return { code: 0, stdout: '', stderr: '' };
      if (args[0] === '-H') return { code: 0, stdout: 'localhost:631', stderr: '' };
      return { code: 0, stdout: 'printer Office is idle.\nsystem default destination: Office\n', stderr: '' };
    });
    Object.assign(service, createPrintService({ run }));
    expect((await request('/jobs', 'POST', { path: '/w/a.pdf' })).status).toBe(502);
    expect((await request('/jobs/Office-42', 'DELETE', undefined, 'other-token')).status).toBe(404);
    expect((await request('/jobs/Office-42', 'DELETE')).status).toBe(200);
    expect(run.mock.calls.filter(([command]) => command === 'lp')).toHaveLength(1);
    expect(run).toHaveBeenLastCalledWith('cancel', ['Office-42']);
  });

  it('reserves history slots before concurrent reads and keeps unknown jobs at capacity', async () => {
    for (let i = 0; i < 99; i++) await request('/jobs', 'POST', { path: '/w/a.pdf' });
    let release;
    readFile.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const pending = request('/jobs', 'POST', { path: '/w/a.pdf' });
    await vi.waitFor(() => expect(readFile).toHaveBeenCalledTimes(100));
    service.jobs.mockImplementation(async (ids) => ids.map((jobId) => ({ jobId, state: 'unknown' })));
    expect((await request('/jobs', 'POST', { path: '/w/a.pdf' })).status).toBe(409);
    expect(readFile).toHaveBeenCalledTimes(100);
    release(Buffer.from('x'));
    expect((await pending).status).toBe(200);
    expect((await (await request('/jobs')).json()).jobs).toHaveLength(100);
  });

  it.each(['closed', 'deleted'])(
    'forgets %s sessions, including an in-flight completion, while preserving other sessions',
    async (event) => {
      await request('/jobs', 'POST', { path: '/w/a.pdf' });
      await request('/jobs', 'POST', { path: '/w/a.pdf' }, 'other-token');
      let release;
      service.print.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      );
      const pending = request('/jobs', 'POST', { path: '/w/a.pdf' });
      await vi.waitFor(() => expect(service.print).toHaveBeenCalledTimes(3));
      if (event === 'closed') {
        job.status = 'closed';
        sessions.emit('job', job);
      } else sessions.emit('deleted', job.id);
      job.status = 'running'; // reopen before the old submission returns
      await request('/jobs', 'POST', { path: '/w/a.pdf' });
      release({ jobId: 'Office-late', printer: 'Office', copies: 1 });
      await pending;
      expect((await (await request('/jobs')).json()).jobs).toEqual([{ jobId: 'Office-3', state: 'pending' }]);
      expect((await (await request('/jobs', 'GET', undefined, 'other-token')).json()).jobs).toEqual([
        { jobId: 'Office-2', state: 'pending' },
      ]);
    },
  );
});
