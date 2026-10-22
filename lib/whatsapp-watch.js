// @ts-check
// Replies to what a session wrote on WhatsApp. Sending (or whatsapp_watch) leaves a watch
// on the chat, 24 hours from the session's last message there by default; while it lasts,
// what other people write in that chat reaches the session as a delivery (deliverToSession
// in lib/jobs.js, via 'whatsapp'), and the unattended turn it starts may read and answer
// the session's watched chats only (lib/whatsapp-agent.js). Nobody answering lets it lapse.
//
// WAHA is polled for the watched chats alone: nothing has to reach Briareus from the WAHA
// container, and nothing else of the inbox is read. Watches persist in `app_settings` with
// the message ids already delivered, so a restart neither loses nor repeats a reply.
// A group linked in the session's webhook settings never expires; the phone's own
// messages are instructions, except for core replies bearing the reserved 🤖 prefix.
//
// A voice note arrives as text, as an email arrives with its body: `voiceText` downloads
// and transcribes it before the delivery, so the session never has to.
import { loadAppSetting, saveAppSetting } from './db.js';
import { DELIVERY_MAX_CHARS, deliveryId } from './deliveries.js';
import { isWhatsAppAccount, isWhatsAppChat, WHATSAPP_BOT_PREFIX } from './whatsapp.js';

export const WATCH_HOURS = 24;
export const MAX_WATCH_HOURS = 72;
// Per session: each watched chat costs one WAHA read per poll.
export const MAX_WATCHES = 20;
const POLL_MS = 15_000;
// Newest messages read per chat and poll; a burst longer than this between polls loses its oldest.
const PAGE = 20;
const SEEN = 200;
const MESSAGE_CHARS = 4000;

/** @param {Record<string, any>} m */
export const isVoiceNote = (m) => !!m.hasMedia && /^audio\//i.test(m.media?.mimetype || '');

const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const iso = (ms) => new Date(ms).toISOString();

/** @param {Record<string, any>} w */
const view = (w) => ({
  account: w.account,
  chat: w.chat,
  group: w.chat.endsWith('@g.us'),
  since: iso(w.since * 1000),
  expiresAt: w.bound ? null : iso(w.expiresAt),
});

/** @param {Record<string, any>} w @param {Record<string, any>[]} messages */
export function replyText(w, messages) {
  const group = w.chat.endsWith('@g.us');
  const head =
    `WhatsApp ${group ? 'group' : 'chat'} ${w.chat} (account ${w.account}), ${w.bound ? 'linked to this session' : 'which this session wrote to'}: ` +
    `${messages.length === 1 ? 'a new message' : `${messages.length} new messages`}, oldest first. ` +
    `Answer in this chat with whatsapp_send if a reply is due; ` +
    (w.bound
      ? 'the group stays linked until the operator removes it from the webhook settings. Replies are prefixed with 🤖 by the core.'
      : `the watch ends ${iso(w.expiresAt)} unless this session writes there again.`);
  let body = head;
  for (const m of messages) {
    const instruction = w.bound && m.fromMe;
    const sender = m.fromMe ? 'operator (linked phone)' : (group && m.participant) || m.from || 'unknown';
    const quote = m.replyTo?.id ? `, replying to message ${m.replyTo.id}` : '';
    // `voice`: { text } transcribed, { error } not, absent when transcription is off.
    const heard = typeof m.voice?.text === 'string';
    const media = !m.hasMedia
      ? ''
      : heard
        ? `\n(the recording is message ${m.id}, for whatsapp_media)`
        : m.voice?.error
          ? `\n(voice note ${m.media?.mimetype}, not transcribed: ${m.voice.error}; open it with whatsapp_media, message ${m.id})`
          : `\n(media ${m.media?.mimetype || 'attached'}: open it with whatsapp_media, message ${m.id})`;
    const said = heard ? `(voice note, transcribed by the core) ${m.voice.text}` : '';
    const full = [String(m.text || ''), said].filter(Boolean).join('\n');
    // Said when cut, so the session knows the rest exists and where to find it.
    const cut = heard
      ? `… (transcript cut at ${MESSAGE_CHARS} characters; the rest is only in the recording)`
      : `… (cut at ${MESSAGE_CHARS} characters; whatsapp_messages has it in full)`;
    const text = !instruction && full.length > MESSAGE_CHARS ? full.slice(0, MESSAGE_CHARS) + cut : full;
    const block = `\n\n[${iso(m.timestamp * 1000)}] ${sender} (message ${m.id}${quote}):\n${text}${media}`;
    if (!instruction && body.length + block.length > DELIVERY_MAX_CHARS - 500) {
      body += '\n\n(more messages follow; read the chat with whatsapp_messages)';
      break;
    }
    body += block;
  }
  return body;
}

/**
 * @param {{
 *   service: { messages: (account: string, chat: string, query: any) => Promise<{ messages: any[] }> },
 *   getJob: (id: string) => any,
 *   listJobs?: () => any[],
 *   allowed: (job: any) => boolean,
 *   mayUse?: (job: any, account: string) => boolean,
 *   deliver: (id: string, delivery: { text: string, source: string, id: string }, group?: { whatsappGroup: string, whatsappAccount: string, whatsappSince: number }) => any,
 *   instruct?: (id: string, instruction: { text: string, source: string, id: string }, group: { account: string, chat: string }) => any,
 *   voiceText?: (account: string, chat: string, message: Record<string, any>) => Promise<string | null>,
 *   note?: (id: string, text: string) => void,
 *   registryComplete?: () => boolean,
 *   load?: typeof loadAppSetting,
 *   save?: typeof saveAppSetting,
 *   now?: () => number,
 *   pollMs?: number,
 *   log?: (message: string) => void,
 * }} deps
 */
export function createWhatsAppWatcher({
  service,
  getJob,
  listJobs = () => [],
  allowed,
  // Whether the session may read this account: one its inbox owner owns
  // (lib/whatsapp-owners.js). A watch or bound group on someone else's is never polled.
  mayUse = (/** @type {any} */ _job, /** @type {string} */ _account) => true,
  deliver,
  instruct = undefined,
  // The transcript of a voice note, null when transcription is off; a throw is reported.
  voiceText = async () => null,
  note = () => {},
  // False while the stored sessions are not all loaded: a missing one may only be late.
  registryComplete = () => true,
  load = loadAppSetting,
  save = saveAppSetting,
  now = Date.now,
  pollMs = POLL_MS,
  log = (message) => console.log(`whatsapp: ${message}`),
}) {
  /** @type {Record<string, any>[]} */
  let watches = [];
  // Nothing is saved until the stored list is read: a save would overwrite every session's watches.
  let loaded = false;
  /** @type {Promise<void> | null} */
  let loading = null;
  let writes = Promise.resolve();
  let dirty = false;
  /** @type {ReturnType<typeof setInterval> | null} */
  let timer = null;
  /** @type {Promise<void> | null} */
  let polling = null;
  // Chats whose last read failed, so an outage is logged once and not every poll.
  const failing = new Set();
  // Chats whose replies the session could not take for now (a drain, no free slot, a cap
  // until the operator speaks), by the refusal's status so each is said once.
  const retrying = new Map();
  // Transcripts by account:chat:message, shared by the sessions watching the chat, so a
  // voice note is downloaded and transcribed (billed) once, however many sessions watch it
  // and however long a reply is held for one (409/429). Each poll keeps only those of
  // replies still held, or of chats it could not read, so nothing caps them but those.
  /** @type {Map<string, { text?: string, error?: string } | null>} */
  const voices = new Map();
  /** @type {Set<string>} */
  let held = new Set();
  const voiceKey = (/** @type {any} */ w, /** @type {any} */ m) => `${w.account}:${w.chat}:${m.id}`;

  /** @param {Record<string, any>} w @param {Record<string, any>} m */
  async function hear(w, m) {
    let voice;
    try {
      const text = await voiceText(w.account, w.chat, m);
      voice = typeof text === 'string' ? { text: text || '(no speech recognised)' } : null;
    } catch (e) {
      voice = { error: e.message };
      log(`could not transcribe voice note ${m.id} in ${w.chat}: ${e.message}`);
    }
    voices.set(voiceKey(w, m), voice);
  }

  const live = (/** @type {any} */ w) => w.bound || w.expiresAt > now();
  const same = (/** @type {any} */ w, jobId, account, chat) =>
    w.jobId === jobId && w.account === account && w.chat === chat;
  const groups = (includeUnavailable = false) =>
    listJobs()
      .filter(
        (job) =>
          (includeUnavailable || (allowed(job) && mayUse(job, job.webhook?.whatsappAccount || 'default'))) &&
          job.webhook?.armed &&
          job.webhook.whatsappGroup,
      )
      .map((job) => ({
        jobId: job.id,
        account: job.webhook.whatsappAccount || 'default',
        chat: job.webhook.whatsappGroup,
        since: job.webhook.whatsappSince,
        expiresAt: null,
        seen: [],
        bound: true,
      }));
  const bound = (account, chat) => groups(true).find((w) => w.account === account && w.chat === chat);
  const usable = (w) => {
    const job = getJob(w.jobId);
    if (!job || !allowed(job) || !mayUse(job, w.account)) return false;
    const group = bound(w.account, w.chat);
    return w.bound ? group?.jobId === w.jobId && group.since === w.since : !group;
  };

  // Memory first, so a failed save neither repeats a delivered reply nor loses a watch
  // before the next save; quiet polls retry failures too. Saves run in order.
  /** @param {(rows: Record<string, any>[]) => Record<string, any>[]} fn */
  function persist(fn) {
    watches = fn(watches);
    dirty = true;
    const rows = watches;
    const task = writes.then(async () => {
      await save('whatsapp_watches', rows);
      if (watches === rows) dirty = false;
    });
    writes = task.catch((e) => log(`could not save watches: ${e.message}`));
    return task;
  }

  // Reads the stored watches once; a failed read is tried again by the next poll or watch.
  function ready() {
    if (loaded) return Promise.resolve();
    loading ||= (async () => {
      const stored = await load('whatsapp_watches', []);
      watches = Array.isArray(stored) ? stored : [];
      loaded = true;
    })().finally(() => {
      loading = null;
    });
    return loading;
  }

  function start() {
    if (timer) return;
    timer = setInterval(() => {
      poll().catch((e) => log(`poll failed: ${e.message}`));
    }, pollMs);
    timer.unref?.();
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  // `last` reads a lapsed watch one final time, for what was written before it ended.
  // True when the replies wait for the session (409/429), to be read again next poll.
  /** @param {Record<string, any>} w @param {boolean} [last] */
  async function check(w, last = false) {
    if (!usable(w)) return;
    let page;
    try {
      page = await service.messages(w.account, w.chat, { limit: String(PAGE) });
      failing.delete(`${w.account}:${w.chat}`);
    } catch (e) {
      const key = `${w.account}:${w.chat}`;
      if (!failing.has(key)) log(`could not read watched chat ${w.chat}: ${e.message}`);
      failing.add(key);
      for (const k of voices.keys()) if (k.startsWith(`${key}:`)) held.add(k);
      return;
    }
    // A watch replaced or ended while WAHA (or the transcription) answered keeps its own state.
    const find = () => watches.find((x) => same(x, w.jobId, w.account, w.chat) && x.since === w.since);
    let current = find();
    if (!current || !usable(current) || (!last && !live(current))) return;
    const unseen = (/** @type {any} */ c) =>
      (page.messages || [])
        .filter(
          (m) =>
            m.id &&
            (!m.fromMe || (c.bound && !String(m.text || '').startsWith(WHATSAPP_BOT_PREFIX))) &&
            Number(m.timestamp) >= c.since &&
            (!last || Number(m.timestamp) * 1000 < c.expiresAt) &&
            (m.text || m.hasMedia) &&
            !c.seen.includes(m.id),
        )
        .sort((a, b) => a.timestamp - b.timestamp);
    let fresh = unseen(current);
    if (!fresh.length) return;
    if (!usable(current)) return;
    const unheard = fresh.filter((m) => isVoiceNote(m) && !voices.has(voiceKey(current, m)));
    if (unheard.length) {
      for (const m of unheard) await hear(current, m);
      current = find();
      if (!current || (!last && !live(current)) || !usable(current)) return;
      fresh = unseen(current);
      if (!fresh.length) return;
    }
    fresh = fresh.map((m) => {
      const voice = voices.get(voiceKey(current, m));
      return voice ? { ...m, voice } : m;
    });
    // Keep operator instructions separate from participant deliveries.
    const batches = [];
    for (const m of fresh) {
      if (!batches.length || m.fromMe || batches.at(-1)[0].fromMe !== m.fromMe) batches.push([]);
      batches.at(-1).push(m);
    }
    const key = `${current.jobId}:${current.account}:${current.chat}`;
    let waiting = false;
    for (const batch of batches) {
      if (!usable(current)) return;
      try {
        const delivery = {
          text: replyText(current, batch),
          source: `WhatsApp ${current.chat}`,
          id: deliveryId(`whatsapp:${current.account}:${current.chat}:${batch.at(-1).id}`),
        };
        if (batch[0].fromMe && !instruct) throw fail('WhatsApp instructions are not available', 503);
        const outcome = batch[0].fromMe
          ? await instruct(current.jobId, delivery, { account: current.account, chat: current.chat })
          : deliver(
              current.jobId,
              delivery,
              current.bound
                ? {
                    whatsappGroup: current.chat,
                    whatsappAccount: current.account,
                    whatsappSince: current.since,
                  }
                : undefined,
            );
        retrying.delete(key);
        log(
          `session ${current.jobId} ← ${batch.length} from ${current.chat} (${outcome?.status || 'taken'})`,
        );
      } catch (e) {
        // Unpersisted owner instructions and temporarily refused replies retry next poll.
        if (batch[0].fromMe || e.status === 409 || e.status === 429) {
          if (retrying.get(key) !== e.status) {
            log(`a reply in ${current.chat} for session ${current.jobId} waits: ${e.message}`);
            if (e.status === 429)
              note(current.jobId, `WhatsApp: a reply in ${current.chat} waits for the agent: ${e.message}`);
          }
          retrying.set(key, e.status);
          // Owners can bypass refused participants, but no message can overtake a refused owner.
          for (const m of fresh) held.add(voiceKey(current, m));
          waiting = true;
          if (batch[0].fromMe) break;
          continue;
        }
        retrying.delete(key);
        log(`a reply in ${current.chat} for session ${current.jobId} was not taken: ${e.message}`);
        note(current.jobId, `WhatsApp: a reply in ${current.chat} could not reach the agent: ${e.message}`);
      }
      await persist((rows) =>
        rows.map((x) =>
          same(x, current.jobId, current.account, current.chat) && x.since === current.since
            ? { ...x, seen: [...x.seen, ...batch.map((m) => m.id)].slice(-SEEN) }
            : x,
        ),
      ).catch(() => {});
    }
    return waiting;
  }

  // Reads lapsed watches a last time, ends them and those of sessions that can no longer
  // take them, then reads what is left. A lapsed watch whose replies wait for the session
  // stays for another last read. One poll at a time: a slow WAHA never stacks them.
  function poll() {
    if (polling) return polling;
    polling = (async () => {
      try {
        await ready();
      } catch (e) {
        if (!failing.has('load')) log(`could not load watches: ${e.message}`);
        failing.add('load');
        return;
      }
      if (dirty) await persist((rows) => rows).catch(() => {});
      const configured = groups(true);
      const added = configured.filter(
        (g) => !watches.some((w) => w.bound && same(w, g.jobId, g.account, g.chat) && w.since === g.since),
      );
      if (added.length) await persist((rows) => [...rows, ...added]).catch(() => {});
      // A session missing from an incomplete registry keeps its watch for a later poll.
      const late = (/** @type {any} */ w) => !getJob(w.jobId) && !registryComplete();
      const ref = (/** @type {any} */ w) => `${w.jobId}:${w.account}:${w.chat}:${w.since}`;
      const waiting = new Set();
      held = new Set();
      const lapsed = watches.filter((x) => !live(x) && usable(x));
      for (const w of lapsed) if (await check(w, true)) waiting.add(ref(w));
      // One that lapsed during those reads has had no last read yet: it gets it next poll.
      const read = new Set(lapsed.map(ref));
      const keep = watches.filter(
        (w) =>
          (w.bound
            ? configured.some((g) => same(w, g.jobId, g.account, g.chat) && w.since === g.since)
            : usable(w) && (live(w) || !read.has(ref(w)))) ||
          late(w) ||
          waiting.has(ref(w)),
      );
      if (keep.length !== watches.length) await persist(() => keep).catch(() => {});
      for (const w of keep) await check(w);
      for (const k of voices.keys()) if (!held.has(k)) voices.delete(k);
    })().finally(() => {
      polling = null;
    });
    return polling;
  }

  return {
    // A failed read leaves the poll running to try again, and is thrown for the caller to log.
    async init() {
      try {
        await ready();
      } finally {
        start();
      }
    },
    stop,
    poll,
    bound: (account, chat) => !!bound(account, chat),
    // `since` (WAHA seconds, the sent message's own stamp) starts a new watch no later than it.
    /** @param {string} jobId @param {{ account: string, chat: string, hours?: number, since?: number }} input */
    async watch(jobId, { account, chat, hours = WATCH_HOURS, since = undefined }) {
      if (!isWhatsAppAccount(account)) throw fail('Invalid WhatsApp account ID');
      if (!isWhatsAppChat(chat)) throw fail('Use a WhatsApp chat ID from the inbox');
      if (typeof hours !== 'number' || !(hours > 0) || hours > MAX_WATCH_HOURS)
        throw fail(`hours must be more than 0 and at most ${MAX_WATCH_HOURS}`);
      const group = bound(account, chat);
      if (group) {
        if (group.jobId !== jobId) throw fail('This group is linked to another session', 409);
        return view(group);
      }
      await ready().catch(() => {
        throw fail('WhatsApp watches could not be loaded; try again shortly', 503);
      });
      const at = now();
      // A lapsed watch still here has replies waiting for its last read; renewing inherits them.
      const old = watches.find((w) => same(w, jobId, account, chat));
      if (!(old && live(old)) && watches.filter((w) => w.jobId === jobId && live(w)).length >= MAX_WATCHES)
        throw fail(`A session watches at most ${MAX_WATCHES} chats; end one with whatsapp_unwatch`, 409);
      const next = {
        jobId,
        account,
        chat,
        // WAHA timestamps are whole seconds; a renewal keeps what was not delivered yet.
        since:
          old?.since ??
          Math.min(Math.floor(at / 1000), Number.isFinite(since) && since > 0 ? Math.floor(since) : Infinity),
        expiresAt: Math.max(old?.expiresAt ?? 0, at + hours * 3600_000),
        seen: old?.seen || [],
      };
      // Live in memory either way; a failed save is logged and the next one carries it.
      await persist((rows) => [...rows.filter((w) => !same(w, jobId, account, chat)), next]).catch(() => {});
      start();
      return view(next);
    },
    /** @param {string} jobId @param {string} account @param {string} chat */
    async unwatch(jobId, account, chat) {
      if (bound(account, chat)?.jobId === jobId)
        throw fail('Remove the linked group from the session webhook settings', 409);
      await ready().catch(() => {
        throw fail('WhatsApp watches could not be loaded; try again shortly', 503);
      });
      const had = watches.some((w) => same(w, jobId, account, chat) && live(w));
      await persist((rows) => rows.filter((w) => !same(w, jobId, account, chat)));
      return { removed: had };
    },
    /** @param {string} jobId */
    list(jobId) {
      return [
        ...watches.filter((w) => w.jobId === jobId && !w.bound && !bound(w.account, w.chat) && live(w)),
        ...groups().filter((w) => w.jobId === jobId),
      ].map(view);
    },
    // Whether the session watches anything, or the given chat.
    /** @param {string} jobId @param {string} [account] @param {string} [chat] */
    watching(jobId, account, chat) {
      return [...watches.filter((w) => !w.bound && !bound(w.account, w.chat)), ...groups()].some(
        (w) =>
          w.jobId === jobId &&
          live(w) &&
          (account === undefined || (w.account === account && w.chat === chat)),
      );
    },
  };
}
