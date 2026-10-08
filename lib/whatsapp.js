// @ts-check
// The operator's WhatsApp inbox. WAHA owns account state and message history;
// no business messages are copied into projects or agent transcripts.
import { getConfig } from './config.js';

const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const SESSION = /^[a-zA-Z0-9_-]{1,100}$/;
const CHAT = /^\d[\d-]{0,79}@(c\.us|s\.whatsapp\.net|g\.us|lid)$/;
const MESSAGE = /^[a-zA-Z0-9_@.:-]{1,300}$/;

function sessionId(value) {
  if (typeof value !== 'string' || !SESSION.test(value)) throw fail('Invalid WhatsApp account ID');
  return encodeURIComponent(value);
}

function chatId(value) {
  if (typeof value !== 'string' || !CHAT.test(value)) throw fail('Use a WhatsApp chat ID from the inbox');
  return encodeURIComponent(value);
}

function messageId(value) {
  if (typeof value !== 'string' || !MESSAGE.test(value)) throw fail('Invalid WhatsApp message ID');
  return encodeURIComponent(value);
}

function page(query = {}, defaultLimit = 50) {
  const number = (key, fallback, min, max) => {
    const value = query[key] ?? String(fallback);
    if (typeof value !== 'string' || !/^\d{1,6}$/.test(value) || +value < min || +value > max)
      throw fail(`${key} must be an integer from ${min} to ${max}`);
    return +value;
  };
  return { limit: number('limit', defaultLimit, 1, 100), offset: number('offset', 0, 0, 100000) };
}

function account(value) {
  return {
    id: value.name,
    status: value.status,
    me: value.me ? { id: value.me.id, name: value.me.pushName || value.me.name || '' } : null,
  };
}

// Only the stable fields clients need. Raw engine data, media URLs and session
// config can contain credentials or machine-local addresses.
function message(value) {
  return {
    id: value.id,
    timestamp: value.timestamp,
    from: value.from || '',
    to: value.to || '',
    fromMe: !!value.fromMe,
    participant: value.participant || value.author || '',
    text: value.body || '',
    hasMedia: !!value.hasMedia,
    media: value.hasMedia
      ? { mimetype: value.media?.mimetype || '', filename: value.media?.filename || '' }
      : null,
    ack: value.ack ?? null,
    replyTo: value.replyTo
      ? {
          id: value.replyTo.id || null,
          participant: value.replyTo.participant || '',
          text: value.replyTo.body || '',
          hasMedia: !!value.replyTo.hasMedia,
        }
      : null,
  };
}

/**
 * @param {{
 *   config?: () => {url: string, apiKey: string} | null,
 *   fetcher?: typeof fetch,
 *   timeoutMs?: number,
 * }} [deps]
 */
export function createWhatsAppService({
  config = () => getConfig().whatsapp,
  fetcher = fetch,
  timeoutMs = 30000,
} = {}) {
  const starts = new Map();

  function settings() {
    const cfg = config();
    if (!cfg) throw fail('WhatsApp is not configured; install WAHA and set WAHA_CONFIG_FILE', 503);
    return cfg;
  }

  async function request(
    path,
    { method = 'GET', body = undefined, binary = false, signal = undefined } = {},
  ) {
    const cfg = settings();
    const download = binary ? new AbortController() : null;
    const deadline = download ? setTimeout(() => download.abort(), timeoutMs) : null;
    const timeout = download?.signal || AbortSignal.timeout(timeoutMs);
    let res;
    try {
      res = await fetcher(`${cfg.url}${path}`, {
        method,
        headers: {
          'X-Api-Key': cfg.apiKey,
          Accept: binary ? '*/*' : 'application/json',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        redirect: 'error',
      });
    } catch {
      throw fail(
        method === 'GET'
          ? 'WAHA could not be reached; check that its container is running'
          : 'WAHA did not confirm the operation; check the account or conversation before retrying',
        502,
      );
    } finally {
      clearTimeout(deadline);
    }
    if (!res.ok) {
      await res.body?.cancel();
      const status = res.status;
      if (status === 404) throw fail('WhatsApp account, chat or message not found', 404);
      if (status === 401 || status === 403)
        throw fail('WAHA refused its API key; check the server configuration', 502);
      if (status === 429) throw fail('WAHA is rate limiting requests; try again later', 429);
      if ([400, 409, 422].includes(status))
        throw fail('WAHA refused the operation; check the account connection and chat', 409);
      if (status === 501)
        throw fail('This operation is not supported by the installed WAHA edition or engine', 501);
      throw fail('WAHA could not complete the operation', 502);
    }
    if (binary && res.body) {
      const reader = res.body.getReader();
      // Bound headers and each pending upstream read, not the total transfer
      // or time the client spends paused by backpressure.
      const body = new ReadableStream(
        {
          async pull(stream) {
            const stall = setTimeout(() => download.abort(), timeoutMs);
            try {
              const { done, value } = await reader.read();
              if (done) stream.close();
              else stream.enqueue(value);
            } catch (e) {
              stream.error(e);
            } finally {
              clearTimeout(stall);
            }
          },
          cancel(reason) {
            download.abort();
            return reader.cancel(reason);
          },
        },
        { highWaterMark: 0 },
      );
      return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
    }
    if (binary) return res;
    try {
      return res.status === 204 ? {} : await res.json();
    } catch {
      throw fail(
        method === 'GET'
          ? 'WAHA returned an invalid response'
          : 'WAHA accepted the operation but returned an invalid receipt; check before retrying',
        502,
      );
    }
  }

  return {
    async accounts() {
      if (!config()) return { configured: false, accounts: [] };
      const values = await request('/api/sessions?all=true');
      return { configured: true, accounts: values.map(account) };
    },
    async account(id) {
      return { account: account(await request(`/api/sessions/${sessionId(id)}`)) };
    },
    async start(id) {
      const name = sessionId(id);
      if (starts.has(name)) return starts.get(name);
      const run = (async () => {
        let current;
        try {
          current = await request(`/api/sessions/${name}`);
        } catch (e) {
          if (e.status !== 404) throw e;
          // WAHA Core supports one account, named default. Existing Plus
          // accounts are usable too, but creation does not require a paid tier.
          if (id !== 'default')
            throw fail('Create the default account first; multiple accounts require WAHA Plus');
          return {
            account: account(
              await request('/api/sessions', {
                method: 'POST',
                body: {
                  name: id,
                  start: true,
                  config: { noweb: { store: { enabled: true, fullSync: true } } },
                },
              }),
            ),
          };
        }
        if (['STOPPED', 'FAILED'].includes(current.status)) {
          await request(`/api/sessions/${name}/${current.status === 'FAILED' ? 'restart' : 'start'}`, {
            method: 'POST',
          });
          current = await request(`/api/sessions/${name}`);
        }
        return { account: account(current) };
      })();
      starts.set(name, run);
      try {
        return await run;
      } finally {
        starts.delete(name);
      }
    },
    async qr(id) {
      const value = await request(`/api/${sessionId(id)}/auth/qr?format=image`);
      if (value.mimetype !== 'image/png' || typeof value.data !== 'string')
        throw fail('WAHA returned an invalid pairing QR code', 502);
      return { mimetype: value.mimetype, data: value.data };
    },
    async logout(id) {
      await request(`/api/sessions/${sessionId(id)}/logout`, { method: 'POST' });
      return { ok: true };
    },
    async conversations(id, query = {}) {
      const { limit, offset } = page(query);
      const values = await request(`/api/${sessionId(id)}/chats/overview?limit=${limit}&offset=${offset}`);
      return {
        conversations: values
          .filter((c) => CHAT.test(c.id))
          .map((c) => ({
            id: c.id,
            name: c.name || c.id,
            unreadCount: c._chat?.unreadCount ?? null,
            lastMessage: c.lastMessage ? message(c.lastMessage) : null,
          })),
        nextOffset: values.length === limit ? offset + limit : null,
      };
    },
    async messages(id, chat, query = {}) {
      const { limit, offset } = page(query);
      const values = await request(
        `/api/${sessionId(id)}/chats/${chatId(chat)}/messages?limit=${limit}&offset=${offset}&sortBy=timestamp&sortOrder=desc&downloadMedia=false`,
      );
      // WAHA filters protocol records after paging; even an empty window can
      // have older messages. Only the supported offset bound ends navigation.
      return { messages: values.map(message), nextOffset: offset + limit <= 100000 ? offset + limit : null };
    },
    async send(id, chat, input = {}) {
      sessionId(id);
      chatId(chat);
      if (
        typeof input.text !== 'string' ||
        !input.text.trim() ||
        input.text.length > 8000 ||
        input.text.includes('\0')
      )
        throw fail('Write a message of 1–8000 characters');
      const body = { session: id, chatId: chat, text: input.text.trim(), linkPreview: false };
      if (input.replyTo !== undefined) {
        messageId(input.replyTo);
        body['reply_to'] = input.replyTo;
      }
      return { message: message(await request('/api/sendText', { method: 'POST', body })) };
    },
    async markRead(id, chat) {
      await request(`/api/${sessionId(id)}/chats/${chatId(chat)}/messages/read`, { method: 'POST' });
      return { ok: true };
    },
    async media(id, chat, mid, signal) {
      const value = await request(
        `/api/${sessionId(id)}/chats/${chatId(chat)}/messages/${messageId(mid)}?downloadMedia=true`,
        { signal },
      );
      const url = value.media?.url || value.mediaUrl;
      if (!value.hasMedia || !url) throw fail('Media is not available for this message', 404);
      let pathname;
      try {
        const base = new URL(settings().url);
        pathname = new URL(url, base).pathname;
        const prefix = base.pathname.replace(/\/+$/, '');
        if (prefix && pathname.startsWith(`${prefix}/api/files/`)) pathname = pathname.slice(prefix.length);
      } catch {
        throw fail('WAHA returned an invalid media location', 502);
      }
      // Rebase onto the configured WAHA server. Never fetch an arbitrary URL
      // or forward the API key to storage/CDN origins supplied by a message.
      if (!pathname.startsWith('/api/files/') || /%2f|%5c|%2e/i.test(pathname))
        throw fail('WAHA media must use its local file storage', 502);
      return request(pathname, { binary: true, signal });
    },
  };
}
