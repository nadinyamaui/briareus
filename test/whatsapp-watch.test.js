import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createWhatsAppWatcher, MAX_WATCHES, replyText } from '../lib/whatsapp-watch.js';

const CHAT = '34600000000@c.us';
const GROUP = '120363000000000000@g.us';
const T0 = Date.UTC(2026, 9, 16, 9, 0, 0);
const sec = (ms) => Math.floor(ms / 1000);

let clock, stored, chats, jobs, delivered, notes, logs, deliver;
const make = () =>
  createWhatsAppWatcher({
    service: {
      messages: vi.fn(async (_account, chat) => {
        if (chats[chat] instanceof Error) throw chats[chat];
        // Newest first, as WAHA answers.
        return { messages: [...(chats[chat] || [])].reverse() };
      }),
    },
    getJob: (id) => jobs[id] || null,
    allowed: (job) => job.status !== 'closed',
    deliver: (...args) => deliver(...args),
    note: (id, text) => notes.push({ id, text }),
    load: async (_key, fallback) => stored ?? fallback,
    save: async (_key, value) => {
      stored = structuredClone(value);
    },
    now: () => clock,
    log: (line) => logs.push(line),
  });
const msg = (id, at, fields = {}) => ({
  id,
  timestamp: sec(at),
  from: CHAT,
  fromMe: false,
  text: `text ${id}`,
  hasMedia: false,
  ...fields,
});

beforeEach(() => {
  clock = T0;
  stored = undefined;
  chats = {};
  jobs = { s1: { id: 's1', status: 'idle' }, s2: { id: 's2', status: 'idle' } };
  delivered = [];
  notes = [];
  logs = [];
  deliver = (id, delivery) => {
    delivered.push({ session: id, ...delivery });
    return { status: 'running' };
  };
});

describe('WhatsApp watches', () => {
  it('delivers what others write after the watch began, oldest first, exactly once', async () => {
    const w = make();
    chats[CHAT] = [msg('old', T0 - 60_000)];
    expect(await w.watch('s1', { account: 'default', chat: CHAT })).toEqual({
      account: 'default',
      chat: CHAT,
      group: false,
      since: new Date(T0).toISOString(),
      expiresAt: new Date(T0 + 24 * 3600_000).toISOString(),
    });
    clock += 60_000;
    chats[CHAT].push(
      msg('mine', T0 + 1000, { fromMe: true }),
      msg('a', T0 + 5000),
      msg('blank', T0 + 6000, { text: '' }),
      msg('b', T0 + 9000, { hasMedia: true, media: { mimetype: 'image/jpeg' } }),
    );
    await w.poll();
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatchObject({ session: 's1', source: `WhatsApp ${CHAT}` });
    expect(delivered[0].id).toMatch(/^[0-9a-f]{32}$/);
    const text = delivered[0].text;
    expect(text).toContain(
      `WhatsApp chat ${CHAT} (account default), which this session wrote to: 2 new messages`,
    );
    expect(text.indexOf('text a')).toBeLessThan(text.indexOf('text b'));
    expect(text).toContain('open it with whatsapp_media, message b');
    expect(text).not.toMatch(/text (old|mine|blank)/);
    await w.poll();
    expect(delivered).toHaveLength(1);
    chats[CHAT].push(msg('c', T0 + 70_000));
    await w.poll();
    expect(delivered).toHaveLength(2);
    expect(delivered[1].text).toContain('text c');
    expect(delivered[1].text).not.toContain('text a');
  });

  it('names the participant in a group and the message it quotes', () => {
    const text = replyText({ account: 'default', chat: GROUP, expiresAt: T0 }, [
      msg('g1', T0, { from: GROUP, participant: '34611111111@c.us', replyTo: { id: 'q1' } }),
    ]);
    expect(text).toMatch(/^WhatsApp group 120363000000000000@g\.us /);
    expect(text).toContain('34611111111@c.us (message g1, replying to message q1):\ntext g1');
  });

  it('survives a restart without losing or repeating a reply', async () => {
    const first = make();
    await first.watch('s1', { account: 'default', chat: CHAT });
    chats[CHAT] = [msg('a', T0 + 1000)];
    await first.poll();
    first.stop();
    chats[CHAT].push(msg('b', T0 + 2000));
    const second = make();
    await second.init();
    second.stop();
    expect(second.watching('s1', 'default', CHAT)).toBe(true);
    await second.poll();
    expect(delivered.map((d) => d.text.match(/text \w/g))).toEqual([['text a'], ['text b']]);
  });

  it('renews on a later send without forgetting what is undelivered, and lapses after its window', async () => {
    const w = make();
    await w.watch('s1', { account: 'default', chat: CHAT });
    chats[CHAT] = [msg('a', T0 + 1000)];
    clock = T0 + 20 * 3600_000;
    const renewed = await w.watch('s1', { account: 'default', chat: CHAT });
    expect(renewed.since).toBe(new Date(T0).toISOString());
    expect(renewed.expiresAt).toBe(new Date(clock + 24 * 3600_000).toISOString());
    await w.poll();
    expect(delivered).toHaveLength(1);
    clock += 24 * 3600_000 + 1;
    chats[CHAT].push(msg('late', clock - 1000));
    expect(w.watching('s1')).toBe(false);
    await w.poll();
    expect(delivered).toHaveLength(1);
    expect(stored).toEqual([]);
  });

  it('keeps sessions apart and ends the watches of sessions that can no longer take them', async () => {
    const w = make();
    await w.watch('s1', { account: 'default', chat: CHAT });
    await w.watch('s2', { account: 'default', chat: GROUP, hours: 2 });
    expect(w.list('s1').map((x) => x.chat)).toEqual([CHAT]);
    expect(w.list('s2')).toEqual([expect.objectContaining({ chat: GROUP, group: true })]);
    expect(w.watching('s1', 'default', GROUP)).toBe(false);
    jobs.s2.status = 'closed';
    chats[GROUP] = [msg('g', T0 + 1000)];
    await w.poll();
    expect(delivered).toEqual([]);
    expect(w.watching('s2')).toBe(false);
    expect(stored.map((x) => x.jobId)).toEqual(['s1']);
    expect(await w.unwatch('s1', 'default', CHAT)).toEqual({ removed: true });
    expect(w.watching('s1')).toBe(false);
  });

  it('notes a reply the session refused and does not retry it', async () => {
    const w = make();
    await w.watch('s1', { account: 'default', chat: CHAT });
    deliver = () => {
      throw Object.assign(new Error('caps reached'), { status: 429 });
    };
    chats[CHAT] = [msg('a', T0 + 1000)];
    await w.poll();
    await w.poll();
    expect(notes).toEqual([
      { id: 's1', text: `WhatsApp: a reply in ${CHAT} could not reach the agent: caps reached` },
    ]);
  });

  it('logs an unreadable chat once and keeps the watch', async () => {
    const w = make();
    await w.watch('s1', { account: 'default', chat: CHAT });
    chats[CHAT] = Object.assign(new Error('WAHA could not be reached'), { status: 502 });
    await w.poll();
    await w.poll();
    expect(logs.filter((l) => l.includes('could not read'))).toHaveLength(1);
    expect(w.watching('s1', 'default', CHAT)).toBe(true);
  });

  it('validates its input and caps the chats one session watches', async () => {
    const w = make();
    await expect(w.watch('s1', { account: 'bad id', chat: CHAT })).rejects.toThrow(/account/);
    await expect(w.watch('s1', { account: 'default', chat: 'nobody' })).rejects.toThrow(/chat ID/);
    for (const hours of [0, -1, 73, '24', NaN])
      await expect(w.watch('s1', { account: 'default', chat: CHAT, hours })).rejects.toThrow(/hours/);
    for (let i = 0; i < MAX_WATCHES; i++)
      await w.watch('s1', { account: 'default', chat: `3461000${String(i).padStart(4, '0')}@c.us` });
    await expect(w.watch('s1', { account: 'default', chat: CHAT })).rejects.toMatchObject({ status: 409 });
    await expect(w.watch('s2', { account: 'default', chat: CHAT })).resolves.toBeTruthy();
    w.stop();
  });
});
