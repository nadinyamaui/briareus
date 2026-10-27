// @ts-check
// The host's printers, through CUPS's own command-line clients (lp, lpstat, cancel) rather
// than an IPP library: they are on any machine that has a printer set up, and the app keeps
// no runtime dependencies beyond express and mysql2. Commands run without a shell, under
// the C locale so lpstat's English output is what gets parsed.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const TIMEOUT = 30_000;
// CUPS refuses spaces, slashes, '#' and quotes in a queue name; a leading dash would read as an option.
const PRINTER = /^(?!-)[^\s/#\\'"\x00-\x1f\x7f]{1,127}$/;
const destination = (name) => name.split('/').length <= 2 && name.split('/').every((p) => PRINTER.test(p));
const JOB = /^(?!-)[^\s/#\\'"\x00-\x1f\x7f]{1,127}-\d+$/;
const PAGES = /^\d{1,5}(-\d{1,5})?(,\d{1,5}(-\d{1,5})?){0,31}$/;
const MEDIA = /^[A-Za-z0-9._-]{1,64}$/;
const SIDES = ['one-sided', 'two-sided-long-edge', 'two-sided-short-edge'];
const COLOR = ['color', 'monochrome'];
export const MAX_PRINT_COPIES = 20;

/** @param {string} message @param {number} [status] */
function printError(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

/**
 * @param {string} command @param {string[]} args @param {Buffer} [input]
 * @returns {Promise<{ code: number | null, stdout: string, stderr: string }>}
 */
export function runCups(command, args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: { ...process.env, LC_ALL: 'C', LANG: 'C' },
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: TIMEOUT,
    });
    let stdout = '';
    let stderr = '';
    let started = false;
    child.once('spawn', () => (started = true));
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (e) =>
      reject(
        Object.assign(
          /** @type {any} */ (e).code === 'ENOENT'
            ? printError(
                `Printing is unavailable: CUPS command ${command} is not installed on this server`,
                503,
              )
            : e,
          { cupsNotStarted: !started },
        ),
      ),
    );
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    // lp exits without reading when it refuses the options; that is its answer, not a crash.
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

/** @param {string} out */
export function parsePrinters(out) {
  const printers = [];
  let defaultPrinter = null;
  for (const line of out.split('\n')) {
    // A queue holding new jobs still accepts them; they wait for release instead of printing.
    const printer = /^printer (\S+) (?:is (idle)|is (holding) new jobs|now (printing)|(disabled))/.exec(line);
    if (printer)
      printers.push({ name: printer[1], state: printer[2] || printer[3] || printer[4] || printer[5] });
    const fallback = /^system default destination: (\S+)/.exec(line);
    if (fallback) defaultPrinter = fallback[1];
  }
  return {
    printers: printers.map((p) => ({ ...p, default: p.name === defaultPrinter })),
    default: defaultPrinter,
  };
}

/** @param {string} out @returns {Map<string, string>} job id -> its alerts line */
export function parseJobs(out) {
  const jobs = new Map();
  let current = null;
  for (const line of out.split('\n')) {
    if (/^\S/.test(line)) {
      // lpstat prints the queue as its printer URI does: lp's Café-2 is Caf%C3%A9-2 here.
      current = line.split(/\s+/)[0];
      try {
        current = decodeURIComponent(current);
      } catch {
        // Not an escaped queue name; keep it as printed.
      }
      jobs.set(current, '');
    } else if (current) {
      const alerts = /^\s+Alerts:\s*(.*)$/.exec(line);
      if (alerts) jobs.set(current, alerts[1].trim());
    }
  }
  return jobs;
}

// IPP job-state values of a job that has ended (RFC 8011 section 5.3.7).
const ENDED = { 7: 'canceled', 8: 'aborted', 9: 'completed' };

/** @param {{ run?: typeof runCups }} [deps] */
export function createPrintService({ run = runCups } = {}) {
  async function printers() {
    const { code, stdout, stderr } = await run('lpstat', ['-p', '-d']);
    // With no queue at all lpstat says so on stderr and fails; that is an empty list, not an error.
    if (code !== 0 && !/No destinations/i.test(stderr))
      throw printError(stderr.trim() || 'lpstat failed', 502);
    return parsePrinters(stdout);
  }

  /**
   * @param {Buffer} bytes
   * @param {{ printer?: string, title?: string, copies?: number, pages?: string, sides?: string,
   *   color?: string, media?: string, landscape?: boolean, fitToPage?: boolean }} [options]
   * @param {{ authorize?: () => void, submitting?: (submission: any) => void }} [control]
   */
  async function print(bytes, options = {}, control = {}) {
    const known = await printers();
    const printer = options.printer ?? known.default;
    if (!printer) throw printError('No printer named and this server has no default printer');
    // lpstat lists a default instance (Office/photo) only once it has saved options; CUPS
    // still prints to it, so the reported default counts when its base queue is listed.
    const listed = (name) => known.printers.some((p) => p.name === name);
    if (
      typeof printer !== 'string' ||
      !destination(printer) ||
      !(listed(printer) || (printer === known.default && listed(printer.split('/')[0])))
    )
      throw printError(`Unknown printer ${JSON.stringify(printer)}`, 404);
    const args = ['-d', printer];
    const copies = options.copies ?? 1;
    if (!Number.isInteger(copies) || copies < 1 || copies > MAX_PRINT_COPIES)
      throw printError(`copies must be a whole number from 1 to ${MAX_PRINT_COPIES}`);
    args.push('-n', String(copies));
    const marker = `briareus-${randomUUID()}`;
    // IPP names allow 255 UTF-8 bytes, including the recovery marker and separator.
    let remaining = 255 - Buffer.byteLength(`${marker} `);
    let title = '';
    for (const character of String(options.title || 'Briareus').replace(/[\x00-\x1f\x7f]/g, ' ')) {
      const size = Buffer.byteLength(character);
      if (size > remaining) break;
      title += character;
      remaining -= size;
    }
    args.push('-t', `${marker} ${title}`);
    if (options.pages != null) {
      if (typeof options.pages !== 'string' || !PAGES.test(options.pages))
        throw printError('pages must be a page list such as 1-3,5');
      args.push('-P', options.pages);
    }
    if (options.sides != null) {
      if (!SIDES.includes(/** @type {string} */ (options.sides)))
        throw printError(`sides must be one of ${SIDES.join(', ')}`);
      args.push('-o', `sides=${options.sides}`);
    }
    if (options.color != null) {
      if (!COLOR.includes(/** @type {string} */ (options.color)))
        throw printError(`color must be one of ${COLOR.join(', ')}`);
      args.push('-o', `print-color-mode=${options.color}`);
    }
    if (options.media != null) {
      if (typeof options.media !== 'string' || !MEDIA.test(options.media))
        throw printError('media must be a paper size name such as A4 or Letter');
      args.push('-o', `media=${options.media}`);
    }
    // An explicit false overrides a true the destination saved; omitted inherits its default.
    if (options.landscape === true) args.push('-o', 'landscape');
    if (options.landscape === false) args.push('-o', 'landscape=false');
    if (options.fitToPage === true) args.push('-o', 'fit-to-page');
    if (options.fitToPage === false) args.push('-o', 'fit-to-page=false');
    // Discovery can block; permission must still hold at the physical side effect.
    control.authorize?.();
    control.submitting?.({ jobId: marker, marker, printer, copies });
    // The bytes go on stdin, so lp never opens a path the session named.
    const { code, stdout, stderr } = await run('lp', args, bytes);
    const id = /request id is (\S+)/.exec(stdout)?.[1];
    if (code !== 0 || !id) throw printError(stderr.trim() || stdout.trim() || 'lp failed', 502);
    return { jobId: id, printer, copies };
  }

  /** @param {string[]} ids */
  async function jobs(ids) {
    if (!ids.length) return [];
    // Snapshot pending first, then completed: a completion between snapshots appears in either.
    const pending = await run('lpstat', ['-o']);
    if (pending.code !== 0) throw printError(pending.stderr.trim() || 'lpstat failed', 502);
    const finished = await run('lpstat', ['-l', '-W', 'completed', '-o']);
    if (finished.code !== 0) throw printError(finished.stderr.trim() || 'lpstat failed', 502);
    const queued = parseJobs(pending.stdout);
    const done = parseJobs(finished.stdout);
    // lpstat's alerts need not say how a job ended (a cancel can show none), so ask CUPS for the
    // job-state of the ones that ended. Without it they are still over, just not known how.
    const ended = ids.filter((id) => !queued.has(id) && done.has(id));
    let states = new Map();
    let stateError;
    if (ended.length)
      try {
        states = new Map((await ippJobs()).map((job) => [job.jobId, ENDED[job.state]]));
      } catch (e) {
        stateError = e.message;
      }
    return ids.map((id) => {
      if (queued.has(id)) return { jobId: id, state: 'pending' };
      if (!done.has(id)) return { jobId: id, state: 'unknown' };
      const state = states.get(id);
      return state ? { jobId: id, state } : { jobId: id, state: 'ended', ...(stateError && { stateError }) };
    });
  }

  // Every job CUPS retains, through its IPP tool: lpstat omits job names and job states.
  async function ippJobs() {
    const server = await run('lpstat', ['-H']);
    if (server.code !== 0) throw printError(server.stderr.trim() || 'lpstat failed', 502);
    const host = server.stdout.trim();
    const uri = host.startsWith('/') ? 'ipp://localhost/' : `ipp://${host}/`;
    const result = await run('ipptool', [
      '-X',
      '-T',
      '30',
      uri,
      fileURLToPath(new URL('../scripts/print-recovery.ipp', import.meta.url)),
    ]);
    if (result.code !== 0) throw printError(result.stderr.trim() || 'Print recovery failed', 502);
    const response = /<key>ResponseAttributes<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(result.stdout);
    if (!response) throw printError('Invalid print recovery response', 502);
    const found = [];
    for (const [, dict] of response[1].matchAll(/<dict>([\s\S]*?)<\/dict>/g)) {
      const name = /<key>job-name<\/key>\s*<string>([^<]*)<\/string>/.exec(dict)?.[1];
      const id = /<key>job-id<\/key>\s*<integer>(\d+)<\/integer>/.exec(dict)?.[1];
      const state = /<key>job-state<\/key>\s*<integer>(\d+)<\/integer>/.exec(dict)?.[1];
      const printerUri = /<key>job-printer-uri<\/key>\s*<string>([^<]*)<\/string>/.exec(dict)?.[1];
      if (!id || !printerUri) continue;
      const queue = decodeURIComponent(
        new URL(printerUri.replaceAll('&amp;', '&')).pathname.split('/').pop(),
      );
      found.push({ jobId: `${queue}-${id}`, queue, name, state: Number(state) });
    }
    return found;
  }

  // Reconcile lost acknowledgements by our random marker AND queue, never a timestamp or the
  // next job number.
  async function recover(submissions) {
    if (!submissions.length) return [];
    const found = await ippJobs();
    const recovered = [];
    for (const submission of submissions) {
      const matches = found
        .filter((job) => job.name?.startsWith(`${submission.marker} `))
        .filter((job) => job.queue === submission.printer.split('/')[0])
        .map((job) => job.jobId);
      if (matches.length === 1) recovered.push({ ...submission, jobId: matches[0] });
    }
    return recovered;
  }

  /** @param {string} id */
  async function cancel(id) {
    if (!JOB.test(id)) throw printError('Not a print job id');
    const { code, stderr } = await run('cancel', [id]);
    if (code !== 0) throw printError(stderr.trim() || 'cancel failed', 409);
    return { jobId: id, canceled: true };
  }

  return { printers, print, jobs, cancel, recover };
}
