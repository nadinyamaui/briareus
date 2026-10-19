// @ts-check
// The operator's WhatsApp for project sessions, behind the same per-project opt-in as mail.
// Pairing (start, QR, logout) stays with the admin API: a session reads, replies, opens
// media, marks chats read, opens groups and adds people to them, but never links or unlinks the phone.
//
// What a session sends leaves a watch on that chat (lib/whatsapp-watch.js). A turn nobody
// is watching, such as one a reply started, gets the tools for the session's watched chats
// only: it can follow up a conversation it was asked to have, not open another.
import { Router } from 'express';
import { operatorInboxSession } from './mail-agent.js';
import { speech } from './speech.js';
import { readMedia, isWhatsAppAccount, isWhatsAppChat } from './whatsapp.js';

const REFUSED = 'WhatsApp requires an interactive session in a project with WhatsApp tools enabled';
const UNWATCHED =
  'In a turn nobody is watching, WhatsApp reaches only the chats this session is watching, and never lists the accounts or the inbox, opens groups or adds people to them';
// The bytes travel base64 in one JSON answer to the stdio tool.
async function mediaPayload(upstream) {
  const { mimetype, data } = await readMedia(upstream);
  return { mimetype, size: data.length, data: data.toString('base64') };
}

export function whatsappSessionAllowed(job, project) {
  return project?.whatsappToolsEnabled === true && operatorInboxSession(job, project);
}

// Whether the session may keep and be woken by watches, whoever is watching the turn.
export function whatsappWatchAllowed(job, project) {
  return (
    !job?.closing && !job?.closePending && whatsappSessionAllowed({ ...job, unattendedTurn: false }, project)
  );
}

// A turn nobody is watching that still gets the tools, limited to the watched chats.
export function whatsappWatchedTurn(job, project, watching) {
  return (
    !whatsappSessionAllowed(job, project) &&
    !!job?.unattendedTurn &&
    whatsappWatchAllowed(job, project) &&
    watching(job.id)
  );
}

/**
 * @param {{
 *   service: ReturnType<typeof import('./whatsapp.js').createWhatsAppService>,
 *   agentSession: (req: any, res: any) => any,
 *   getProject: (repo: string) => any,
 *   watcher?: ReturnType<typeof import('./whatsapp-watch.js').createWhatsAppWatcher>,
 *   generateSpeech?: typeof speech,
 * }} deps
 */
export function whatsappAgentRoutes({
  service,
  agentSession,
  getProject,
  watcher = undefined,
  generateSpeech = speech,
}) {
  const router = Router();
  const watching = (id, account, chat) => !!watcher?.watching(id, account, chat);
  const refused = (message) => Object.assign(new Error(message), { status: 403 });
  router.use('/api/agent/whatsapp', (req, res, next) => {
    const job = agentSession(req, res);
    if (!job) return;
    const full = () => whatsappSessionAllowed(job, getProject(job.repo));
    const scoped = () => whatsappWatchedTurn(job, getProject(job.repo), watching);
    if (!full() && !scoped()) return res.status(403).json({ error: REFUSED });
    res.set('Cache-Control', 'no-store');
    res.locals.job = job;
    // A send can wait behind a slow read; the opt-in is checked again just before it goes out.
    // `chat` limits a turn nobody watches to the chats this session is watching; null
    // marks what such a turn never does (list the accounts or the inbox, open a group or add to one).
    res.locals.whatsappAuthorize = (account, chat) => {
      if (full()) return;
      if (!scoped()) throw refused(REFUSED);
      if (chat === null || !watching(job.id, account, chat)) throw refused(UNWATCHED);
    };
    next();
  });
  const handle =
    (fn, status = 200) =>
    async (req, res) => {
      try {
        res.status(status).json(await fn(req, res));
      } catch (e) {
        res
          .status(e.status || 502)
          .json({ error: e.status ? e.message : 'WhatsApp returned an unexpected response' });
      }
    };
  router.get(
    '/api/agent/whatsapp/accounts',
    handle((_req, res) => {
      res.locals.whatsappAuthorize(null, null);
      return service.accounts();
    }),
  );
  router.get(
    '/api/agent/whatsapp/accounts/:id/conversations',
    handle((req, res) => {
      res.locals.whatsappAuthorize(req.params.id, null);
      return service.conversations(req.params.id, req.query);
    }),
  );
  router.get(
    '/api/agent/whatsapp/accounts/:id/conversations/:chat/messages',
    handle((req, res) => {
      res.locals.whatsappAuthorize(req.params.id, req.params.chat);
      return service.messages(req.params.id, req.params.chat, req.query);
    }),
  );
  router.get(
    '/api/agent/whatsapp/accounts/:id/conversations/:chat/messages/:message/media',
    handle(async (req, res) => {
      res.locals.whatsappAuthorize(req.params.id, req.params.chat);
      const controller = new AbortController();
      res.on('close', () => controller.abort());
      try {
        const upstream = await service.media(
          req.params.id,
          req.params.chat,
          req.params.message,
          controller.signal,
        );
        return await mediaPayload(upstream);
      } finally {
        controller.abort();
      }
    }),
  );
  // A send leaves (or renews) a watch on its chat unless `watch` is false: what is
  // answered there comes back to this session.
  router.post(
    '/api/agent/whatsapp/accounts/:id/conversations/:chat/messages',
    handle(async (req, res) => {
      const { id, chat } = req.params;
      const { watch = true, ...input } = req.body || {};
      if (typeof watch !== 'boolean')
        throw Object.assign(new Error('watch must be true or false'), { status: 400 });
      res.locals.whatsappAuthorize(id, chat);
      const sent = await service.send(id, chat, input);
      // From the sent message's own stamp: a reply WAHA stamps within the send's round-trip counts.
      return {
        ...sent,
        ...(watch ? await watchAfter(res.locals.job, id, chat, Number(sent?.message?.timestamp)) : {}),
      };
    }, 201),
  );
  router.post(
    '/api/agent/whatsapp/accounts/:id/conversations/:chat/voice',
    handle(async (req, res) => {
      const { id, chat } = req.params;
      const { text, voice, replyTo, watch = true } = req.body || {};
      if (
        typeof watch !== 'boolean' ||
        !isWhatsAppAccount(id) ||
        !isWhatsAppChat(chat) ||
        (replyTo !== undefined && (typeof replyTo !== 'string' || !/^[a-zA-Z0-9_@.:-]{1,300}$/.test(replyTo)))
      )
        throw Object.assign(new Error('Invalid voice note account, chat, replyTo or watch'), { status: 400 });
      res.locals.whatsappAuthorize(id, chat);
      const controller = new AbortController();
      res.on('close', () => controller.abort());
      const audio = await generateSpeech({ text, voice }, controller.signal);
      // Generation may take a while: revocation or an expired watch must still prevent the send.
      res.locals.whatsappAuthorize(id, chat);
      controller.signal.throwIfAborted();
      const sent = await service.sendVoice(id, chat, audio, replyTo);
      return {
        ...sent,
        ...(watch ? await watchAfter(res.locals.job, id, chat, Number(sent?.message?.timestamp)) : {}),
      };
    }, 201),
  );
  router.post(
    '/api/agent/whatsapp/accounts/:id/conversations/:chat/read',
    handle((req, res) => {
      res.locals.whatsappAuthorize(req.params.id, req.params.chat);
      return service.markRead(req.params.id, req.params.chat);
    }),
  );
  // A group with the user as admin; it is watched like a chat this session wrote to.
  router.post(
    '/api/agent/whatsapp/accounts/:id/groups',
    handle(async (req, res) => {
      const { watch = true, ...input } = req.body || {};
      if (typeof watch !== 'boolean')
        throw Object.assign(new Error('watch must be true or false'), { status: 400 });
      res.locals.whatsappAuthorize(req.params.id, null);
      const created = await service.createGroup(req.params.id, input);
      return {
        ...created,
        ...(watch ? await watchAfter(res.locals.job, req.params.id, created.group.id) : {}),
      };
    }, 201),
  );
  // Adding people to a group is opening it to them: a turn nobody watches never does it.
  router.post(
    '/api/agent/whatsapp/accounts/:id/conversations/:chat/participants',
    handle((req, res) => {
      res.locals.whatsappAuthorize(req.params.id, null);
      return service.addParticipants(req.params.id, req.params.chat, req.body || {});
    }),
  );
  router.get(
    '/api/agent/whatsapp/watches',
    handle((_req, res) => ({ watches: watcher ? watcher.list(res.locals.job.id) : [] })),
  );
  // Starting or extending a watch; a turn nobody watches can only extend one.
  router.put(
    '/api/agent/whatsapp/accounts/:id/conversations/:chat/watch',
    handle(async (req, res) => {
      const { id, chat } = req.params;
      res.locals.whatsappAuthorize(id, chat);
      if (!watcher) throw Object.assign(new Error('WhatsApp watches are not available'), { status: 503 });
      return { watch: await watcher.watch(res.locals.job.id, { account: id, chat, hours: req.body?.hours }) };
    }),
  );
  router.delete(
    '/api/agent/whatsapp/accounts/:id/conversations/:chat/watch',
    handle(async (req, res) => {
      if (!watcher) return { removed: false };
      return watcher.unwatch(res.locals.job.id, req.params.id, req.params.chat);
    }),
  );
  // What was sent stands even when its watch could not be kept; the agent is told.
  async function watchAfter(job, account, chat, since = undefined) {
    if (!watcher) return { watch: null };
    try {
      return { watch: await watcher.watch(job.id, { account, chat, since }) };
    } catch (e) {
      return { watch: null, watchError: e.message };
    }
  }
  return router;
}
