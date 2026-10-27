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
      'report .pdf',
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

  it('cancels a job by its id and refuses anything else', async () => {
    const run = fakeCups();
    const service = createPrintService({ run });
    expect(await service.cancel('Office-12')).toEqual({ jobId: 'Office-12', canceled: true });
    expect(run).toHaveBeenCalledWith('cancel', ['Office-12']);
    await expect(service.cancel('-a')).rejects.toThrow('Not a print job id');
  });
});
