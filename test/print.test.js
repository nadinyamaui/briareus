import { readFileSync } from 'node:fs';
import { describe, it, expect, vi } from 'vitest';
import { createPrintService, parseJobs, parsePrinters } from '../lib/print.js';

const LPSTAT = `printer Office is idle.  enabled since Tue Oct 27 11:30:32 2026
printer Label now printing Label-4.  enabled since Tue Oct 27 11:31:00 2026
printer Old disabled since Mon Oct 26 09:00:00 2026 -
	reason unknown
system default destination: Office
`;

function fakeCups(overrides = {}) {
  return vi.fn(async (command, args) => {
    const key = `${command} ${args.join(' ')}`;
    if (key in overrides) return overrides[key];
    if (command === 'lpstat' && key === 'lpstat -p -d') return { code: 0, stdout: LPSTAT, stderr: '' };
    if (command === 'lp') return { code: 0, stdout: 'request id is Office-12 (0 file(s))\n', stderr: '' };
    if (key === 'lpstat -o')
      return {
        code: 0,
        stdout: 'Office-12               briareus          1024   Tue Oct 27 12:00:00 2026\n',
        stderr: '',
      };
    if (key === 'lpstat -l -W completed -o')
      return {
        code: 0,
        stdout: `Office-10               briareus          1024   Tue Oct 27 11:00:00 2026
	Status:
	Alerts: job-completed-successfully
	queued for Office
Office-11               briareus          1024   Tue Oct 27 11:10:00 2026
	Status:
	Alerts: job-canceled-by-user
	queued for Office
`,
        stderr: '',
      };
    if (command === 'cancel') return { code: 0, stdout: '', stderr: '' };
    throw new Error(`unexpected ${key}`);
  });
}

describe('parsing lpstat', () => {
  it('reads printer states and the default', () => {
    expect(parsePrinters(LPSTAT)).toEqual({
      default: 'Office',
      printers: [
        { name: 'Office', state: 'idle', default: true },
        { name: 'Label', state: 'printing', default: false },
        { name: 'Old', state: 'disabled', default: false },
      ],
    });
    expect(parsePrinters('no system default destination\n')).toEqual({ printers: [], default: null });
  });

  it('lists a queue holding new jobs, which CUPS still accepts', async () => {
    const run = fakeCups({
      'lpstat -p -d': {
        code: 0,
        stdout:
          'printer Office is holding new jobs.  enabled since Tue Oct 27 11:30:32 2026\nsystem default destination: Office\n',
        stderr: '',
      },
    });
    const service = createPrintService({ run });
    expect(await service.printers()).toEqual({
      default: 'Office',
      printers: [{ name: 'Office', state: 'holding', default: true }],
    });
    expect(await service.print(Buffer.from('x'))).toMatchObject({ jobId: 'Office-12', printer: 'Office' });
  });

  it('reads job ids and their alerts from the long listing', () => {
    expect([...parseJobs('A-1  u  1  date\n\tAlerts: job-printing\nB-2  u  1  date\n')]).toEqual([
      ['A-1', 'job-printing'],
      ['B-2', ''],
    ]);
  });
});

describe('the print service', () => {
  it('lists no printers when CUPS has none, and fails on other lpstat errors', async () => {
    const empty = createPrintService({
      run: fakeCups({ 'lpstat -p -d': { code: 1, stdout: '', stderr: 'lpstat: No destinations added.' } }),
    });
    expect(await empty.printers()).toEqual({ printers: [], default: null });
    const broken = createPrintService({
      run: fakeCups({ 'lpstat -p -d': { code: 1, stdout: '', stderr: 'lpstat: Bad file descriptor' } }),
    });
    await expect(broken.printers()).rejects.toMatchObject({ status: 502 });
  });

  it('prints the bytes on stdin to the default printer with only validated options', async () => {
    const run = fakeCups();
    const bytes = Buffer.from('%PDF-1.4');
    const result = await createPrintService({ run }).print(bytes, {
      title: 'report\n.pdf',
      copies: 2,
      pages: '1-3,5',
      sides: 'two-sided-long-edge',
      color: 'monochrome',
      media: 'A4',
      landscape: true,
      fitToPage: true,
    });
    expect(result).toEqual({ jobId: 'Office-12', printer: 'Office', copies: 2 });
    const lp = run.mock.calls.find(([command]) => command === 'lp');
    expect(lp[1]).toEqual([
      '-d',
      'Office',
      '-n',
      '2',
      '-t',
      expect.stringMatching(/^briareus-[0-9a-f-]{36} report \.pdf$/),
      '-P',
      '1-3,5',
      '-o',
      'sides=two-sided-long-edge',
      '-o',
      'print-color-mode=monochrome',
      '-o',
      'media=A4',
      '-o',
      'landscape',
      '-o',
      'fit-to-page',
    ]);
    expect(lp[2]).toBe(bytes);
  });

  it.each([
    ['界'.repeat(80), '界'.repeat(69)],
    ['😀'.repeat(80), '😀'.repeat(52)],
    ['a'.repeat(208) + '😀', 'a'.repeat(208)],
    ['a'.repeat(208) + '\nmore', 'a'.repeat(208) + ' '],
    ['a'.repeat(250), 'a'.repeat(209)],
  ])('bounds the marked UTF-8 title without splitting characters: %s', async (title, expected) => {
    const run = fakeCups();
    const submitting = vi.fn();
    await createPrintService({ run }).print(Buffer.from('x'), { title }, { submitting });
    const args = run.mock.calls.find(([command]) => command === 'lp')[1];
    const markedTitle = args[args.indexOf('-t') + 1];
    expect(markedTitle).toBe(`${submitting.mock.calls[0][0].marker} ${expected}`);
    expect(Buffer.byteLength(markedTitle)).toBeLessThanOrEqual(255);
    expect(Buffer.from(markedTitle).toString()).toBe(markedTitle);
  });

  it.each([
    [{ printer: 'Nowhere' }, 404],
    [{ printer: '-o' }, 404],
    [{ copies: 0 }, 400],
    [{ copies: 21 }, 400],
    [{ copies: 1.5 }, 400],
    [{ pages: '1;rm' }, 400],
    [{ sides: 'both' }, 400],
    [{ color: 'red' }, 400],
    [{ media: 'A4 -o x' }, 400],
  ])('refuses %j before anything reaches lp', async (options, status) => {
    const run = fakeCups();
    await expect(createPrintService({ run }).print(Buffer.from('x'), options)).rejects.toMatchObject({
      status,
    });
    expect(run.mock.calls.some(([command]) => command === 'lp')).toBe(false);
  });

  it('refuses when nothing is named and there is no default printer', async () => {
    const run = fakeCups({ 'lpstat -p -d': { code: 0, stdout: 'printer Office is idle.\n', stderr: '' } });
    await expect(createPrintService({ run }).print(Buffer.from('x'))).rejects.toThrow(/no default printer/);
  });

  it('reports a refused job as an error rather than a job id', async () => {
    const run = fakeCups();
    run.mockImplementation(async (command) =>
      command === 'lp'
        ? { code: 1, stdout: '', stderr: 'lp: Unsupported document-format' }
        : { code: 0, stdout: LPSTAT, stderr: '' },
    );
    await expect(createPrintService({ run }).print(Buffer.from('x'))).rejects.toMatchObject({
      status: 502,
      message: 'lp: Unsupported document-format',
    });
  });

  it('reports the state of the jobs it is asked about', async () => {
    const service = createPrintService({ run: fakeCups() });
    expect(await service.jobs(['Office-12', 'Office-10', 'Office-11', 'Office-9'])).toEqual([
      { jobId: 'Office-12', state: 'pending' },
      { jobId: 'Office-10', state: 'completed' },
      { jobId: 'Office-11', state: 'canceled' },
      { jobId: 'Office-9', state: 'unknown' },
    ]);
    expect(await service.jobs([])).toEqual([]);
  });

  it.each([{}, { printer: 'Office/photo' }])('accepts a listed printer instance: %j', async (options) => {
    const run = fakeCups({
      'lpstat -p -d': {
        code: 0,
        stdout: 'printer Office/photo is idle.\nsystem default destination: Office/photo\n',
        stderr: '',
      },
    });
    expect(await createPrintService({ run }).print(Buffer.from('x'), options)).toMatchObject({
      printer: 'Office/photo',
    });
    expect(run.mock.calls.find(([command]) => command === 'lp')[1].slice(0, 2)).toEqual([
      '-d',
      'Office/photo',
    ]);
  });

  it.each([{}, { printer: 'Office/photo' }])(
    'accepts a default instance lpstat lists only by its base queue: %j',
    async (options) => {
      const run = fakeCups({
        'lpstat -p -d': {
          code: 0,
          stdout: 'printer Office is idle.\nsystem default destination: Office/photo\n',
          stderr: '',
        },
      });
      expect(await createPrintService({ run }).print(Buffer.from('x'), options)).toMatchObject({
        printer: 'Office/photo',
      });
      expect(run.mock.calls.find(([command]) => command === 'lp')[1].slice(0, 2)).toEqual([
        '-d',
        'Office/photo',
      ]);
    },
  );

  it.each([
    ['Office/draft', 'printer Office is idle.\nsystem default destination: Office/photo\n'],
    ['Office/photo', 'printer Label is idle.\nsystem default destination: Office/photo\n'],
    ['Office/-bad', 'printer Office is idle.\nsystem default destination: Office/-bad\n'],
  ])('refuses %s when it is not the default of a listed queue', async (printer, stdout) => {
    const run = fakeCups({ 'lpstat -p -d': { code: 0, stdout, stderr: '' } });
    await expect(createPrintService({ run }).print(Buffer.from('x'), { printer })).rejects.toMatchObject({
      status: 404,
    });
    expect(run.mock.calls.some(([command]) => command === 'lp')).toBe(false);
  });

  it.each(['Office/', '/photo', 'Office/photo/extra', 'Office/-bad', 'Office/missing'])(
    'refuses malformed or unlisted instances: %s',
    async (printer) => {
      const run = fakeCups({
        'lpstat -p -d': {
          code: 0,
          stdout: `printer ${printer === 'Office/missing' ? 'Office' : printer} is idle.\n`,
          stderr: '',
        },
      });
      await expect(createPrintService({ run }).print(Buffer.from('x'), { printer })).rejects.toMatchObject({
        status: 404,
      });
      expect(run.mock.calls.some(([command]) => command === 'lp')).toBe(false);
    },
  );

  it('calls authorization after discovery and never submits if revoked', async () => {
    const run = fakeCups();
    const authorize = vi.fn(() => {
      throw Object.assign(new Error('Revoked'), { status: 403 });
    });
    await expect(
      createPrintService({ run }).print(Buffer.from('x'), {}, { authorize }),
    ).rejects.toMatchObject({ status: 403 });
    expect(run.mock.calls.map(([command]) => command)).toEqual(['lpstat']);
  });

  it.each(
    ['lpstat -o', 'lpstat -l -W completed -o'].flatMap((command) =>
      [0, 1].map((n) => [command, n ? null : 1]),
    ),
  )('propagates status failure from %s (exit %s)', async (command, code) => {
    const run = fakeCups({
      [command]: { code, stdout: 'Office-12 user 1024 date\n', stderr: 'Scheduler is not running' },
    });
    await expect(createPrintService({ run }).jobs(['Office-12'])).rejects.toMatchObject({
      status: 502,
      message: 'Scheduler is not running',
    });
  });

  it('takes the completed snapshot only after pending, retaining a job that finishes between them', async () => {
    const run = fakeCups();
    let release;
    run.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const result = createPrintService({ run }).jobs(['Office-10']);
    expect(run.mock.calls).toHaveLength(1);
    release({ code: 0, stdout: '', stderr: '' });
    expect(await result).toEqual([{ jobId: 'Office-10', state: 'completed' }]);
    expect(run.mock.calls[1][1]).toEqual(['-l', '-W', 'completed', '-o']);
  });

  it('records a unique marker before lp, retaining it when acknowledgement times out', async () => {
    const run = fakeCups({ 'lp -unused': {} });
    const fallback = run.getMockImplementation();
    run.mockImplementation((command, args) =>
      command === 'lp' ? { code: null, stdout: '', stderr: '' } : fallback(command, args),
    );
    const submitting = vi.fn();
    await expect(
      createPrintService({ run }).print(Buffer.from('x'), {}, { submitting }),
    ).rejects.toMatchObject({ status: 502 });
    const submission = submitting.mock.calls[0][0];
    expect(submission).toMatchObject({ jobId: submission.marker, printer: 'Office', copies: 1 });
    expect(run.mock.calls.find(([command]) => command === 'lp')[1]).toContain(
      `${submission.marker} Briareus`,
    );
  });

  it('recovers pending or completed jobs only by the unique marker and destination', async () => {
    const dict = (id, title, queue = 'Office') =>
      `<dict><key>job-id</key><integer>${id}</integer><key>job-name</key><string>${title}</string><key>job-printer-uri</key><string>ipp://localhost/printers/${queue}</string></dict>`;
    const submission = {
      jobId: 'briareus-token',
      marker: 'briareus-token',
      printer: 'Office/photo',
      copies: 2,
    };
    const run = fakeCups({
      'lpstat -H': { code: 0, stdout: '/run/cups/cups.sock\n', stderr: '' },
    });
    const fallback = run.getMockImplementation();
    run.mockImplementation((command, args) =>
      command === 'ipptool'
        ? {
            code: 0,
            stderr: '',
            stdout: `<key>ResponseAttributes</key><array>${dict(9, 'unrelated')}${dict(10, 'briareus-token report', 'Other')}${dict(42, 'briareus-token report')}</array>`,
          }
        : fallback(command, args),
    );
    const service = createPrintService({ run });
    expect(await service.recover([submission])).toEqual([{ ...submission, jobId: 'Office-42' }]);
    expect(run.mock.calls.find(([command]) => command === 'ipptool')[1]).toEqual([
      '-X',
      '-T',
      '30',
      'ipp://localhost/',
      expect.stringMatching(/print-recovery\.ipp$/),
    ]);
    expect(await service.recover([{ ...submission, marker: 'another-session' }])).toEqual([]);
    expect(await service.recover([])).toEqual([]);
  });

  it('queries as the submitting user, whom default CUPS privacy shows job names', () => {
    const script = readFileSync(new URL('../scripts/print-recovery.ipp', import.meta.url), 'utf8');
    expect(script).toMatch(/^\s*ATTR name requesting-user-name \$user$/m);
  });

  it('rejects failed or malformed recovery queries', async () => {
    const run = vi.fn(async (command) =>
      command === 'lpstat'
        ? { code: 0, stdout: 'localhost:631', stderr: '' }
        : { code: null, stdout: '', stderr: 'Timed out' },
    );
    await expect(createPrintService({ run }).recover([{}])).rejects.toMatchObject({
      status: 502,
      message: 'Timed out',
    });
    run.mockResolvedValue({ code: 0, stdout: 'invalid', stderr: '' });
    await expect(createPrintService({ run }).recover([{}])).rejects.toMatchObject({ status: 502 });
  });

  it('cancels a job by its id and refuses anything else', async () => {
    const run = fakeCups();
    const service = createPrintService({ run });
    expect(await service.cancel('Office-12')).toEqual({ jobId: 'Office-12', canceled: true });
    expect(run).toHaveBeenCalledWith('cancel', ['Office-12']);
    await expect(service.cancel('-a')).rejects.toThrow('Not a print job id');
  });
});
