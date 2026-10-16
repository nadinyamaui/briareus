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
import { loadAppSetting, saveAppSetting } from './db.js';
import { DELIVERY_MAX_CHARS, deliveryId } from './deliveries.js';
import { isWhatsAppAccount, isWhatsAppChat } from './whatsapp.js';

export const WATCH_HOURS = 24;
export const MAX_WATCH_HOURS = 72;
// Per session: each watched chat costs one WAHA read per poll.
export const MAX_WATCHES = 20;
const POLL_MS = 15_000;
// Newest messages read per chat and poll; a burst longer than this between polls loses its oldest.
const PAGE = 20;
const SEEN = 200;
const MESSAGE_CHARS = 4000;

const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const iso = (ms) => new Date(ms).toISOString();

/** @param {Record<string, any>} w */
const view = (w) => ({
  account: w.account,
  chat: w.chat,
  group: w.chat.endsWith('@g.us'),
  since: iso(w.since * 1000),
  expiresAt: iso(w.expiresAt),
});

/** @param {Record<string, any>} w @param {Record<string, any>[]} messages */
export function replyText(w, messages) {
  const group = w.chat.endsWith('@g.us');
  const head =
    `WhatsApp ${group ? 'group' : 'chat'} ${w.chat} (account ${w.account}), which this session wrote to: ` +
    `${messages.length === 1 ? 'a new message' : `${messages.length} new messages`}, oldest first. ` +
    `Answer in this chat with whatsapp_send if a reply is due; the watch ends ${iso(w.expiresAt)} ` +
    `unless this session writes there again.`;
  let body = head;
  for (const m of messages) {
    const sender = (group && m.participant) || m.from || 'unknown';
    const quote = m.replyTo?.id ? `, replying to message ${m.replyTo.id}` : '';
    const media = m.hasMedia
      ? `\n(media ${m.media?.mimetype || 'attached'}: open it with whatsapp_media, message ${m.id})`
      : '';
    const text = String(m.text || '').slice(0, MESSAGE_CHARS);
    const block = `\n\n[${iso(m.timestamp * 1000)}] ${sender} (message ${m.id}${quote}):\n${text}${media}`;
    if (body.length + block.length > DELIVERY_MAX_CHARS - 500) {
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
 *   allowed: (job: any) => boolean,
 *   deliver: (id: string, delivery: { text: string, source: string, id: string }) => any,
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
  allowed,
  deliver,
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
  /** @type {ReturnType<typeof setInterval> | null} */
  let timer = null;
  /** @type {Promise<void> | null} */
  let polling = null;
  // Chats whose last read failed, so an outage is logged once and not every poll.
  const failing = new Set();
  // Chats whose replies the session could not take for now (a drain, no free slot, a cap
  // until the operator speaks), by the refusal's status so each is said once.
  const retrying = new Map();

  const live = (/** @type {any} */ w) => w.expiresAt > now();
  const same = (/** @type {any} */ w, jobId, account, chat) =>
    w.jobId === jobId && w.account === account && w.chat === chat;

  // Memory first, so a failed save neither repeats a delivered reply nor loses a watch
  // before the next save; saves run in order with the latest list.
  /** @param {(rows: Record<string, any>[]) => Record<string, any>[]} fn */
  function persist(fn) {
    watches = fn(watches);
    const rows = watches;
    const task = writes.then(() => save('whatsapp_watches', rows));
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
    if (timer || (loaded && !watches.length)) return;
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
    let page;
    try {
      page = await service.messages(w.account, w.chat, { limit: String(PAGE) });
      failing.delete(`${w.account}:${w.chat}`);
    } catch (e) {
      const key = `${w.account}:${w.chat}`;
      if (!failing.has(key)) log(`could not read watched chat ${w.chat}: ${e.message}`);
      failing.add(key);
      return;
    }
    // A watch replaced or ended while WAHA answered keeps its own state.
    const current = watches.find((x) => same(x, w.jobId, w.account, w.chat) && x.since === w.since);
    if (!current || (!last && !live(current))) return;
    const fresh = (page.messages || [])
      .filter(
        (m) =>
          m.id &&
          !m.fromMe &&
          Number(m.timestamp) >= current.since &&
          (!last || Number(m.timestamp) * 1000 < current.expiresAt) &&
          (m.text || m.hasMedia) &&
          !current.seen.includes(m.id),
      )
      .sort((a, b) => a.timestamp - b.timestamp);
    if (!fresh.length) return;
    const job = getJob(current.jobId);
    if (!job || !allowed(job)) return;
    const key = `${current.jobId}:${current.account}:${current.chat}`;
    try {
      const outcome = deliver(current.jobId, {
        text: replyText(current, fresh),
        source: `WhatsApp ${current.chat}`,
        id: deliveryId(`whatsapp:${current.account}:${current.chat}:${fresh.at(-1).id}`),
      });
      retrying.delete(key);
      log(`session ${current.jobId} ← ${fresh.length} from ${current.chat} (${outcome?.status || 'taken'})`);
    } catch (e) {
      // A session that cannot be woken just now (409) or is at a cap (429) gets the same
      // replies on the next poll.
      if (e.status === 409 || e.status === 429) {
        if (retrying.get(key) !== e.status) {
          log(`a reply in ${current.chat} for session ${current.jobId} waits: ${e.message}`);
          if (e.status === 429)
            note(current.jobId, `WhatsApp: a reply in ${current.chat} waits for the agent: ${e.message}`);
        }
        retrying.set(key, e.status);
        return true;
      }
      retrying.delete(key);
      log(`a reply in ${current.chat} for session ${current.jobId} was not taken: ${e.message}`);
      note(current.jobId, `WhatsApp: a reply in ${current.chat} could not reach the agent: ${e.message}`);
    }
    await persist((rows) =>
      rows.map((x) =>
        x === current ? { ...x, seen: [...x.seen, ...fresh.map((m) => m.id)].slice(-SEEN) } : x,
      ),
    ).catch(() => {});
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
      const usable = (/** @type {any} */ w) => {
        const job = getJob(w.jobId);
        return !!job && allowed(job);
      };
      // A session missing from an incomplete registry keeps its watch for a later poll.
      const late = (/** @type {any} */ w) => !getJob(w.jobId) && !registryComplete();
      const ref = (/** @type {any} */ w) => `${w.jobId}:${w.account}:${w.chat}:${w.since}`;
      const waiting = new Set();
      for (const w of watches.filter((x) => !live(x) && usable(x)))
        if (await check(w, true)) waiting.add(ref(w));
      const keep = watches.filter((w) => (live(w) && usable(w)) || late(w) || waiting.has(ref(w)));
      if (keep.length !== watches.length) await persist(() => keep).catch(() => {});
      for (const w of keep) await check(w);
      if (loaded && !watches.length) stop();
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
    // `since` (WAHA seconds, the sent message's own stamp) starts a new watch no later than it.
    /** @param {string} jobId @param {{ account: string, chat: string, hours?: number, since?: number }} input */
    async watch(jobId, { account, chat, hours = WATCH_HOURS, since = undefined }) {
      if (!isWhatsAppAccount(account)) throw fail('Invalid WhatsApp account ID');
      if (!isWhatsAppChat(chat)) throw fail('Use a WhatsApp chat ID from the inbox');
      if (typeof hours !== 'number' || !(hours > 0) || hours > MAX_WATCH_HOURS)
        throw fail(`hours must be more than 0 and at most ${MAX_WATCH_HOURS}`);
      await ready().catch(() => {
        throw fail('WhatsApp watches could not be loaded; try again shortly', 503);
      });
      const at = now();
      const old = watches.find((w) => same(w, jobId, account, chat) && live(w));
      if (!old && watches.filter((w) => w.jobId === jobId && live(w)).length >= MAX_WATCHES)
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
      await ready().catch(() => {
        throw fail('WhatsApp watches could not be loaded; try again shortly', 503);
      });
      const had = watches.some((w) => same(w, jobId, account, chat) && live(w));
      await persist((rows) => rows.filter((w) => !same(w, jobId, account, chat)));
      return { removed: had };
    },
    /** @param {string} jobId */
    list(jobId) {
      return watches.filter((w) => w.jobId === jobId && live(w)).map(view);
    },
    // Whether the session watches anything, or the given chat.
    /** @param {string} jobId @param {string} [account] @param {string} [chat] */
    watching(jobId, account, chat) {
      return watches.some(
        (w) =>
          w.jobId === jobId &&
          live(w) &&
          (account === undefined || (w.account === account && w.chat === chat)),
      );
    },
  };
}
