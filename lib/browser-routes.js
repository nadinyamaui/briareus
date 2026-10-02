// @ts-check

// The session's shared browser over HTTP (lib/browser.js): switching it on and
// off, what it shows, and what a client does in it. Each handler answers for
// one session, which the /api/v1 gateway has already scoped to the token.
export function sessionBrowserRoutes({
  getJob,
  openSessionBrowser,
  closeSessionBrowser,
  browserState,
  watchBrowser,
  browserInput,
  browserScreenshot,
}) {
  const session = (req, res) => {
    const job = getJob(req.params.id);
    if (!job || job.kind !== 'devchat') {
      res.status(404).json({ error: 'Session not found' });
      return null;
    }
    return job;
  };
  // A status the browser module gave its error is the client's to read; any
  // other failure is the browser going away mid-call, which is a conflict with
  // its state rather than a broken server.
  const failed = (res, e) => res.status(e.status || 409).json({ error: e.message });

  function state(req, res) {
    const job = session(req, res);
    if (!job) return;
    res.json({ browser: { on: !!job.browser, ...browserState(job.id) } });
  }

  async function open(req, res) {
    const job = session(req, res);
    if (!job) return;
    try {
      const record = await openSessionBrowser(job.id);
      res.json({ session: record, browser: { on: true, ...browserState(job.id) } });
    } catch (e) {
      failed(res, e);
    }
  }

  function close(req, res) {
    const job = session(req, res);
    if (!job) return;
    try {
      res.json({ session: closeSessionBrowser(job.id) });
    } catch (e) {
      failed(res, e);
    }
  }

  // Server-sent events: `tabs` whenever a tab opens, closes, moves or the view
  // switches, `frame` for every new picture of the tab in view (a JPEG,
  // base64), and `closed` when the browser ends, after which the stream ends
  // too. Frames are what a slow reader falls behind on, so a reader whose
  // socket is still full skips them instead of buffering: the next one
  // replaces it anyway. Tabs and closed are never skipped.
  function stream(req, res) {
    const job = session(req, res);
    if (!job) return;
    if (!browserState(job.id).running)
      return res.status(409).json({ error: 'The session’s browser is not running' });
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    let unwatch;
    try {
      unwatch = watchBrowser(job.id, (event) => {
        if (event.type === 'frame') {
          if (res.writableNeedDrain) return;
          res.write(`event: frame\ndata: ${JSON.stringify(event.frame)}\n\n`);
        } else if (event.type === 'tabs') {
          res.write(`event: tabs\ndata: ${JSON.stringify({ tabs: event.tabs, active: event.active })}\n\n`);
        } else {
          res.write('event: closed\ndata: {}\n\n');
          res.end();
        }
      });
    } catch {
      // It went down between the check above and here.
      res.write('event: closed\ndata: {}\n\n');
      return res.end();
    }
    const ping = setInterval(() => res.write(': ping\n\n'), 25000);
    req.on('close', () => {
      clearInterval(ping);
      unwatch();
    });
  }

  async function screenshot(req, res) {
    const job = session(req, res);
    if (!job) return;
    try {
      const png = await browserScreenshot(job.id);
      res.type('image/png').send(png);
    } catch (e) {
      failed(res, e);
    }
  }

  async function input(req, res) {
    const job = session(req, res);
    if (!job) return;
    try {
      await browserInput(job.id, req.body || {});
      res.json({ ok: true });
    } catch (e) {
      failed(res, e);
    }
  }

  return { state, open, close, stream, screenshot, input };
}
