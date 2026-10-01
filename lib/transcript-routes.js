// @ts-check

// A session's transcript as the dashboard reads it: the log a page opens
// with, the stream that follows it, and ✕ Clear.
// Lines hidden with Clear or after a compaction stay out of the first two
// unless asked for; lib/jobs.js decides which lines those are (visibleEvents).
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
    // A session from before the last restart has its log in the database, not in
    // memory; jobEventsFor reads back whichever applies.
    const estimates = await currentEstimates();
    const all = await jobEventsFor(job, since);
    const events = req.query.all === '1' ? all : visibleEvents(job, all);
    res.json({
      session: publicJob(job, estimates),
      events: estimateEventCosts(events, estimates?.get(job.id)?.rows),
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
    // id: lets EventSource resume via Last-Event-ID after a dropped connection
    // instead of replaying (and duplicating) everything since page load.
    const send = (event) => res.write(`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`);
    const since = Number(req.headers['last-event-id'] ?? req.query.since ?? 0);
    for (const e of visibleEvents(job, jobEventsSince(job, since))) send(e);
    let sendQueue = Promise.resolve();
    const onEvent = (jobId, event) => {
      if (jobId !== job.id) return;
      // Keep numbered events in order while a just-completed result is matched
      // to the ledger row that now carries its catalog estimate.
      sendQueue = sendQueue
        .then(async () => {
          if (event.kind !== 'result' || event.costUsd != null) {
            send(event);
            return;
          }
          try {
            const estimates = await jobUsageEstimates([job.id]);
            send(estimateEventCosts([event], estimates.get(job.id)?.rows)[0]);
          } catch (e) {
            console.error(`live session cost unavailable for ${job.id}: ${e.message}`);
            send(event);
          }
        })
        .catch(() => {});
    };
    bus.on('event', onEvent);
    // The session record itself, pushed on every change the server makes to it:
    // a PR sync, a context probe, the live token counters during a turn. No `id:`
    // on these: the Last-Event-ID cursor belongs to the numbered event log, and a
    // record push is a snapshot, worthless to replay. The right panel redraws
    // from them instead of waiting for the next sessions poll.
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
