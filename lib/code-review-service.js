// @ts-check
import { codeReviewCommand, reviewExportPrompt } from './code-review-prompts.js';
import { nativeReviewOutput, parseReviewExport } from './code-review-output.js';
import { assertReviewHead, publishCodeReview } from './code-review-publish.js';

const busy = new Set(['queued', 'preparing', 'running']);
const fail = (status, message) => Object.assign(new Error(message), { status });

export function createCodeReviewService({
  store,
  request,
  runtime,
  createSession,
  getJob,
  listJobs,
  eventsFor,
  sendMessage,
  closeSession,
  allowed,
  ready = () => true,
}) {
  const inflight = new Set();
  let timer = null;
  let polling = false;

  async function start({ repo, prNumber, provider, model, effort, ownerId }) {
    if (!Number.isInteger(prNumber) || prNumber < 1) throw fail(400, 'Name a positive PR number');
    if (!allowed({ repo, ownerId })) throw fail(403, 'Project not available');
    const selected = runtime({ repo, provider, model, effort });
    if (!selected || selected.provider.binary !== 'claude')
      throw fail(400, 'Code review requires a configured Claude Code provider for /code-review');
    const pr = await request({ repo, ownerId }, 'GET', `/repos/${repo}/pulls/${prNumber}`);
    if (
      pr.state !== 'open' ||
      !/^[a-f0-9]{40,64}$/.test(pr.head?.sha) ||
      !/^[a-f0-9]{40,64}$/.test(pr.base?.sha) ||
      !pr.head?.ref
    )
      throw fail(400, 'Code review requires an open pull request with valid head and base commits');
    const review = await store.create({
      repo,
      prNumber,
      ownerId,
      branch: pr.head.ref,
      headSha: pr.head.sha,
      baseSha: pr.base.sha,
      providerId: selected.provider.id,
      model: selected.model,
      effort: selected.effort,
    });
    await advance(review.id);
    return store.get(review.id);
  }

  async function advance(id) {
    if (inflight.has(id) || !ready()) return;
    inflight.add(id);
    let review;
    try {
      review = await store.get(id);
      if (!review || !['queued', 'reviewing', 'exporting', 'publishing'].includes(review.status)) return;
      if (!allowed(review)) throw fail(403, 'Project access was revoked for the review owner');
      if (review.status === 'queued') {
        const pr = await assertReviewHead(review, request);
        // The session carries the review id before it starts, so a restart between
        // creation and attachment can find it without paying for a second run.
        const session =
          listJobs().find((j) => j.codeReviewContext?.reviewId === id && !j.codeReviewContext.findingId) ||
          createSession({
            repo: review.repo,
            prNumber: review.prNumber,
            branch: pr.head.repo?.full_name?.toLowerCase() === review.repo ? review.branch : pr.base.ref,
            provider: review.providerId,
            model: review.model,
            effort: review.effort,
            prompt: codeReviewCommand(review),
            title: `Code review: #${review.prNumber}`,
            activity: 'code-review',
            ownerId: review.ownerId,
            codeReviewContext: {
              reviewId: id,
              prNumber: review.prNumber,
              headSha: review.headSha,
              baseSha: review.baseSha,
            },
          });
        await store.update(id, 'queued', {
          status: 'reviewing',
          sessionId: session.id,
          providerId: session.providerId,
          model: session.model,
          effort: session.effort,
        });
        return;
      }
      if (['reviewing', 'exporting'].includes(review.status)) {
        const job = getJob(review.sessionId);
        if (!job) throw new Error('Review session was deleted before its result was stored');
        if (busy.has(job.status) || job.restartPending || job.awaitingAnswer) return;
        if (job.status !== 'idle' || job.turnCanceled)
          throw new Error(job.error || 'Review session was interrupted');
        const turn = job.turns;
        await assertReviewHead(review, request);
        const events = await eventsFor(job, 0);
        if (job.status !== 'idle' || job.turns !== turn) return;
        if (review.status === 'reviewing') {
          const texts = events.filter((e) => e.kind === 'text').map((e) => e.text);
          const report = events.filter((e) => e.kind === 'code-review-result').at(-1)?.report;
          const rawOutput = [...texts, ...(report ? [JSON.stringify(report)] : [])].join('\n\n');
          if (rawOutput.length > 1000000) throw new Error('Review output exceeds the storage limit');
          await store.update(id, 'reviewing', { status: 'exporting', rawOutput });
          review.status = 'exporting';
          if (report) {
            await store.importOutput(
              id,
              rawOutput,
              nativeReviewOutput(report, texts.at(-1)?.length <= 15000 ? texts.at(-1) : ''),
            );
            return;
          }
        }
        const prompt = reviewExportPrompt(review);
        // A completed export is identified by its own user message, never by a
        // JSON-shaped example the reviewer or a tool printed during discovery.
        const after = events.findLastIndex((e) => e.kind === 'user' && e.text === prompt);
        if (after < 0) {
          sendMessage(job.id, prompt);
          return;
        }
        const final = events
          .slice(after + 1)
          .filter((e) => e.kind === 'text')
          .at(-1)?.text;
        if (!final) throw new Error('Review command did not provide a complete export');
        await store.importOutput(
          id,
          review.rawOutput ?? (await store.get(id)).rawOutput,
          parseReviewExport(final, review.headSha),
        );
        return;
      }
      await publishCodeReview(review, { store, request });
      const job = getJob(review.sessionId);
      if (job && job.status !== 'closed') await closeSession(job.id);
      await store.update(id, 'publishing', { status: 'completed', error: null });
    } catch (e) {
      if (review) {
        // Read back the phase because ingestion may have committed before a
        // later operation failed. A DB outage leaves work eligible for recovery.
        const current = await store.get(id);
        if (current && ['queued', 'reviewing', 'exporting', 'publishing'].includes(current.status))
          await store.update(id, current.status, { status: e.stale ? 'stale' : 'failed', error: e.message });
        const job = getJob(current?.sessionId);
        if (job && job.status !== 'closed') await closeSession(job.id);
      }
    } finally {
      inflight.delete(id);
    }
  }

  async function retryPublication(id) {
    const review = await store.get(id);
    if (!review || review.status !== 'failed' || !review.summary)
      throw fail(409, 'Only a stored review with failed publication can be retried');
    if (!allowed(review)) throw fail(403, 'Project not available');
    await assertReviewHead(review, request);
    await store.update(id, 'failed', { status: 'publishing', error: null });
    await advance(id);
    return store.get(id);
  }
  async function tick() {
    if (polling || !ready()) return;
    polling = true;
    try {
      for (const id of await store.active()) await advance(id);
    } finally {
      polling = false;
    }
  }
  return {
    start,
    advance,
    retryPublication,
    tick,
    startTimer() {
      if (!timer)
        timer = setInterval(
          () => tick().catch((e) => console.error('Code reviews:', e.message)),
          5000,
        ).unref();
    },
    stop() {
      clearInterval(timer);
      timer = null;
    },
  };
}
