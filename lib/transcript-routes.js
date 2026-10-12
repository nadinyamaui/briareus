// @ts-check

// A session's transcript for the dashboard: the initial log, the stream after it, and
// Clear. Lines hidden by Clear or a compaction stay out unless asked for (visibleEvents in
// lib/jobs.js decides).
export function sessionTranscriptRoutes({
  getJob,
  publicJob,
  jobEventsFor,
  jobEventsSince,
  visibleEvents,
  clearDevTranscript,
  currentEstimates,
  jobUsageEstimates,
  estimateEventCosts,
  bus,
  presentEvent = async (_job, event, _publication = { uploadToR2: true }) => event,
}) {
  const session = (req, res) => {
    const job = getJob(req.params.id);
    if (!job || job.kind !== 'devchat') {
      res.status(404).json({ error: 'Session not found' });
      return null;
    }
    return job;
  };

  async function read(req, res) {
    const job = session(req, res);
    if (!job) return;
    const since = Number(req.query.since || 0);
    // A session from before the last restart has its log in the database; jobEventsFor
    // reads whichever applies.
    const estimates = await currentEstimates();
    const all = await jobEventsFor(job, since);
    const events = req.query.all === '1' ? all : visibleEvents(job, all);
    const presented = [];
    const publication = { uploadToR2: true };
    for (const event of estimateEventCosts(events, estimates?.get(job.id)?.rows)) {
      presented.push(await presentEvent(job, event, publication));
    }
    res.json({
      session: publicJob(job, estimates),
      events: presented,
    });
  }

  function stream(req, res) {
    const job = session(req, res);
    if (!job) return;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    // id: lets EventSource resume via Last-Event-ID after a drop instead of replaying
    // (and duplicating) everything.
    const send = async (event) => {
      const presented = await presentEvent(job, event);
      if (!res.destroyed) res.write(`id: ${event.seq}\ndata: ${JSON.stringify(presented)}\n\n`);
    };
    const since = Number(req.headers['last-event-id'] ?? req.query.since ?? 0);
    let sendQueue = Promise.resolve();
    for (const e of visibleEvents(job, jobEventsSince(job, since))) sendQueue = sendQueue.then(() => send(e));
    const onEvent = (jobId, event) => {
      if (jobId !== job.id) return;
      // Keep numbered events in order while a just-completed result is matched
      // to the ledger row that now carries its catalog estimate.
      sendQueue = sendQueue
        .then(async () => {
          if (event.kind !== 'result' || event.costUsd != null) {
            await send(event);
            return;
          }
          try {
            const estimates = await jobUsageEstimates([job.id]);
            await send(estimateEventCosts([event], estimates.get(job.id)?.rows)[0]);
          } catch (e) {
            console.error(`live session cost unavailable for ${job.id}: ${e.message}`);
            await send(event);
          }
        })
        .catch(() => {});
    };
    bus.on('event', onEvent);
    // The session record, pushed on every server-side change (PR sync, context probe,
    // live token counters) so the right panel need not wait for the next poll. No `id:`:
    // the Last-Event-ID cursor belongs to the numbered log, and a snapshot is worthless to
    // replay.
    const onJob = (record) => {
      if (record.id !== job.id) return;
      res.write(`event: session\ndata: ${JSON.stringify(record)}\n\n`);
    };
    bus.on('job', onJob);
    const ping = setInterval(() => res.write(': ping\n\n'), 25000);
    req.on('close', () => {
      clearInterval(ping);
      bus.off('event', onEvent);
      bus.off('job', onJob);
    });
  }

  async function clear(req, res) {
    try {
      res.json(await clearDevTranscript(req.params.id));
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  }

  return { read, stream, clear };
}
