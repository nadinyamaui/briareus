// @ts-check
// The operator's Slack inbox, independent of projects and agent sessions.
// Slack owns the history: clients read it on opening/reconnecting and merge
// live Events API updates by (channel, ts). No business messages are saved in
// session transcripts or passed to an agent by this service.
import { open } from './secretbox.js';

const CHANNEL = /^[CDG][A-Z0-9]+$/;
const USER = /^[UW][A-Z0-9]+$/;
const TS = /^\d{1,12}\.\d{1,9}$/;
const TYPES = ['public_channel', 'private_channel', 'im', 'mpim'];
const fail = (message, status = 400) => Object.assign(new Error(message), { status });

function string(value, name, max = 2000) {
  if (value === undefined) return '';
  if (typeof value !== 'string' || value.length > max || value.includes('\0')) throw fail(`Invalid ${name}`);
  return value;
}

function timestamp(value, name) {
  const ts = string(value, name);
  if (!TS.test(ts)) throw fail(`${name} must be a Slack timestamp, like 1712345678.123456`);
  return ts;
}

function channelId(value) {
  if (typeof value !== 'string' || !CHANNEL.test(value)) throw fail('Use a Slack conversation ID');
  return value;
}

function page(query, defaultLimit) {
  const value = query.limit ?? String(defaultLimit);
  if (typeof value !== 'string' || !/^\d{1,3}$/.test(value) || +value < 1 || +value > 200)
    throw fail('limit must be an integer from 1 to 200');
  return { limit: +value, cursor: string(query.cursor, 'cursor') };
}

function messagesPage(res) {
  return {
    messages: res.messages || [],
    nextCursor: res.response_metadata?.next_cursor || '',
    hasMore: !!res.has_more || !!res.response_metadata?.next_cursor,
  };
}

/**
 * @param {{
 *   getWorkspace: (id: string | number) => Record<string, any> | undefined,
 *   api: (token: string, method: string, params?: Record<string, unknown>) => Promise<Record<string, any>>,
 *   log?: (message: string) => void,
 * }} deps
 */
export function createSlackInbox({ getWorkspace, api, log = () => {} }) {
  /** @type {Map<number, Set<(name: string, data: Record<string, any>) => void>>} */
  const listeners = new Map();

  function workspace(id) {
    const w = getWorkspace(id);
    if (!w) throw fail('Slack workspace not found', 404);
    return w;
  }

  // Rotation/removal while a Slack request was in flight cannot hand back
  // information obtained with an account that is no longer connected.
  async function call(id, method, params = {}) {
    const w = workspace(id);
    const result = await api(open(w.token), method, params);
    if (getWorkspace(id)?.token !== w.token) throw fail('Slack workspace changed; reload it', 409);
    return result;
  }

  function publish(id, name, data) {
    for (const listener of listeners.get(id) || []) {
      try {
        listener(name, { workspaceId: id, ...data });
      } catch (e) {
        log(`an inbox listener failed: ${e.message}`);
      }
    }
  }

  return {
    async conversations(id, query = {}) {
      const types = string(query.types, 'types') || TYPES.join(',');
      if (types.split(',').some((type) => !TYPES.includes(type))) throw fail('Invalid conversation types');
      const res = await call(id, 'conversations.list', {
        ...page(query, 100),
        types,
        exclude_archived: true,
      });
      return { conversations: res.channels || [], nextCursor: res.response_metadata?.next_cursor || '' };
    },

    async conversation(id, channel) {
      const res = await call(id, 'conversations.info', { channel: channelId(channel) });
      return { conversation: res.channel };
    },

    async people(id, query = {}) {
      const res = await call(id, 'users.list', page(query, 100));
      return { people: res.members || [], nextCursor: res.response_metadata?.next_cursor || '' };
    },

    async openDirectMessage(id, input = {}) {
      if (typeof input.userId !== 'string' || !USER.test(input.userId)) throw fail('Use a Slack user ID');
      const res = await call(id, 'conversations.open', { users: input.userId, return_im: true });
      return { conversation: res.channel };
    },

    async messages(id, channel, query = {}, threadTs = '') {
      /** @type {Record<string, unknown>} */
      const params = { channel: channelId(channel), ...page(query, 15) };
      for (const key of ['oldest', 'latest'])
        if (query[key] !== undefined) params[key] = timestamp(query[key], key);
      if (threadTs) params.ts = timestamp(threadTs, 'thread timestamp');
      return messagesPage(
        await call(id, threadTs ? 'conversations.replies' : 'conversations.history', params),
      );
    },

    async send(id, channel, input = {}) {
      const text = string(input.text, 'text', 8000).trim();
      if (!text) throw fail('Write a message of 1–8000 characters');
      const params = { channel: channelId(channel), text, unfurl_links: false, unfurl_media: false };
      if (input.threadTs !== undefined) params.thread_ts = timestamp(input.threadTs, 'threadTs');
      const res = await call(id, 'chat.postMessage', params);
      return { channel: res.channel || channel, ts: res.ts, message: res.message };
    },

    async markRead(id, channel, input = {}) {
      channel = channelId(channel);
      const ts = timestamp(input.ts, 'ts');
      await call(id, 'conversations.mark', { channel, ts });
      publish(workspace(id).id, 'conversation.read', { channel, ts });
      return { ok: true };
    },

    // A listener receives only verified, team-matched events; verification
    // and retry deduplication remain in lib/slack.js, shared with agent replies.
    receive(id, event, eventId) {
      if (event.type !== 'message' || !CHANNEL.test(event.channel || '')) return;
      const name =
        event.subtype === 'message_changed' || event.subtype === 'message_replied'
          ? 'message.changed'
          : event.subtype === 'message_deleted'
            ? 'message.deleted'
            : 'message';
      publish(id, name, { eventId, event });
    },

    subscribe(id, listener) {
      const w = workspace(id);
      if (!w.signingSecret)
        throw fail('Set the Slack signing secret and enable Event Subscriptions first', 409);
      const set = listeners.get(w.id) || new Set();
      set.add(listener);
      listeners.set(w.id, set);
      return {
        ready: { workspaceId: w.id, userId: w.userId, refresh: true },
        close: () => {
          set.delete(listener);
          if (!set.size && listeners.get(w.id) === set) listeners.delete(w.id);
        },
      };
    },

    disconnect(id, reason) {
      publish(id, reason, {});
      listeners.delete(id);
    },
  };
}
