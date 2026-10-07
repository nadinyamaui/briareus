// @ts-check

// The session's shared browser over HTTP (lib/browser.js). Each handler answers for one
// session, already scoped to the token by the /api/v1 gateway.
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
  // A status the browser module set is the client's to read; any other failure is the
  // browser going away mid-call, a state conflict rather than a server error.
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

  // SSE: `tabs` on any tab change, `frame` for each new JPEG (base64) of the tab in view,
  // `closed` when the browser ends, after which the stream ends. A reader whose socket is
  // still full skips frames rather than buffering, since the next replaces it; tabs and
  // closed are never skipped.
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
