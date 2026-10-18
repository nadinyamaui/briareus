import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createWhatsAppWatcher, MAX_WATCHES, replyText } from '../lib/whatsapp-watch.js';

const CHAT = '34600000000@c.us';
const GROUP = '120363000000000000@g.us';
const T0 = Date.UTC(2026, 9, 16, 9, 0, 0);
const sec = (ms) => Math.floor(ms / 1000);

let clock, stored, chats, jobs, delivered, notes, logs, deliver;
const make = (extra = {}) =>
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
    ...extra,
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
    const end = clock + 24 * 3600_000;
    clock = end + 10_000;
    chats[CHAT].push(msg('before', end - 5000), msg('after', end + 5000));
    expect(w.watching('s1')).toBe(false);
    // Read once more for what was written before it lapsed, then ended.
    await w.poll();
    expect(delivered).toHaveLength(2);
    expect(delivered[1].text).toContain('text before');
    expect(delivered[1].text).not.toContain('text after');
    expect(stored).toEqual([]);
    await w.poll();
    expect(delivered).toHaveLength(2);
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
      throw Object.assign(new Error('not allowed'), { status: 403 });
    };
    chats[CHAT] = [msg('a', T0 + 1000)];
    await w.poll();
    await w.poll();
    expect(notes).toEqual([
      { id: 's1', text: `WhatsApp: a reply in ${CHAT} could not reach the agent: not allowed` },
    ]);
    expect(stored[0].seen).toEqual(['a']);
  });

  it('keeps a reply waiting while the session is at a cap, noted once, and delivers it after', async () => {
    const w = make();
    await w.watch('s1', { account: 'default', chat: CHAT });
    deliver = () => {
      throw Object.assign(new Error('10 automatic turns ran'), { status: 429 });
    };
    chats[CHAT] = [msg('a', T0 + 1000)];
    await w.poll();
    chats[CHAT].push(msg('b', T0 + 2000));
    await w.poll();
    expect(delivered).toEqual([]);
    expect(stored[0].seen).toEqual([]);
    expect(notes).toEqual([
      { id: 's1', text: `WhatsApp: a reply in ${CHAT} waits for the agent: 10 automatic turns ran` },
    ]);
    deliver = (id, delivery) => {
      delivered.push({ session: id, ...delivery });
      return { status: 'running' };
    };
    await w.poll();
    expect(delivered).toHaveLength(1);
    expect(delivered[0].text).toContain('text a');
    expect(delivered[0].text).toContain('text b');
    expect(notes).toHaveLength(1);
  });

  it('keeps a lapsed watch while its replies wait at a cap, and delivers them after', async () => {
    const w = make();
    await w.watch('s1', { account: 'default', chat: CHAT, hours: 1 });
    deliver = () => {
      throw Object.assign(new Error('10 automatic turns ran'), { status: 429 });
    };
    chats[CHAT] = [msg('a', T0 + 10 * 60_000)];
    clock = T0 + 15 * 60_000;
    await w.poll();
    chats[CHAT].push(msg('b', T0 + 20 * 60_000), msg('late', T0 + 70 * 60_000));
    clock = T0 + 2 * 3600_000;
    await w.poll();
    await w.poll();
    expect(delivered).toEqual([]);
    expect(w.watching('s1')).toBe(false);
    expect(stored).toEqual([expect.objectContaining({ chat: CHAT, seen: [] })]);
    deliver = (id, delivery) => {
      delivered.push({ session: id, ...delivery });
      return { status: 'running' };
    };
    await w.poll();
    expect(delivered).toHaveLength(1);
    expect(delivered[0].text).toContain('text a');
    expect(delivered[0].text).toContain('text b');
    expect(delivered[0].text).not.toContain('text late');
    expect(stored).toEqual([]);
    expect(notes).toHaveLength(1);
  });

  it('gives a watch that lapses during another lapsed watch’s last read its own last read', async () => {
    const OTHER = '34611111111@c.us';
    const w = make();
    await w.watch('s1', { account: 'default', chat: OTHER, hours: 1 });
    await w.watch('s1', { account: 'default', chat: CHAT, hours: 2 });
    deliver = () => {
      throw Object.assign(new Error('10 automatic turns ran'), { status: 429 });
    };
    let slow = false;
    Object.defineProperty(chats, OTHER, {
      get() {
        // CHAT's watch lapses while WAHA answers for OTHER.
        if (slow) clock = T0 + 2 * 3600_000 + 1000;
        return [msg('o', T0 + 10 * 60_000, { from: OTHER })];
      },
    });
    chats[CHAT] = [msg('a', T0 + 10 * 60_000)];
    clock = T0 + 15 * 60_000;
    await w.poll();
    clock = T0 + 3600_000 + 1000;
    slow = true;
    await w.poll();
    slow = false;
    expect(stored.map((x) => x.chat).sort()).toEqual([CHAT, OTHER].sort());
    await w.poll();
    deliver = (id, delivery) => {
      delivered.push({ session: id, ...delivery });
      return { status: 'running' };
    };
    await w.poll();
    expect(delivered.map((d) => d.source).sort()).toEqual([`WhatsApp ${CHAT}`, `WhatsApp ${OTHER}`].sort());
    expect(stored).toEqual([]);
  });

  it('renews a lapsed watch whose replies wait at a cap without losing them', async () => {
    const w = make();
    await w.watch('s1', { account: 'default', chat: CHAT, hours: 1 });
    deliver = () => {
      throw Object.assign(new Error('10 automatic turns ran'), { status: 429 });
    };
    chats[CHAT] = [msg('a', T0 + 20 * 60_000)];
    clock = T0 + 25 * 60_000;
    await w.poll();
    clock = T0 + 65 * 60_000;
    await w.poll();
    expect(w.watching('s1')).toBe(false);
    clock = T0 + 90 * 60_000;
    await w.watch('s1', { account: 'default', chat: CHAT, since: sec(clock) });
    expect(stored).toEqual([expect.objectContaining({ since: sec(T0), seen: [] })]);
    deliver = (id, delivery) => {
      delivered.push({ session: id, ...delivery });
      return { status: 'running' };
    };
    await w.poll();
    expect(delivered).toHaveLength(1);
    expect(delivered[0].text).toContain('text a');
    expect(w.watching('s1', 'default', CHAT)).toBe(true);
  });

  it('retries a reply the session could not take for now (a drain, no free slot)', async () => {
    const w = make();
    await w.watch('s1', { account: 'default', chat: CHAT });
    deliver = () => {
      throw Object.assign(new Error('the server is restarting'), { status: 409 });
    };
    chats[CHAT] = [msg('a', T0 + 1000)];
    await w.poll();
    await w.poll();
    expect(delivered).toEqual([]);
    expect(stored[0].seen).toEqual([]);
    expect(logs.filter((l) => l.includes('waits: the server is restarting'))).toHaveLength(1);
    deliver = (id, delivery) => {
      delivered.push({ session: id, ...delivery });
      return { status: 'running' };
    };
    await w.poll();
    expect(delivered).toHaveLength(1);
    expect(delivered[0].text).toContain('text a');
    expect(notes).toEqual([]);
    await w.poll();
    expect(delivered).toHaveLength(1);
  });

  it('saves nothing until the stored watches are read, so a failed load never wipes them', async () => {
    stored = [
      { jobId: 's2', account: 'default', chat: GROUP, since: sec(T0), expiresAt: T0 + 3600_000, seen: [] },
    ];
    const real = stored;
    let down = true;
    const w = createWhatsAppWatcher({
      service: { messages: async () => ({ messages: [] }) },
      getJob: (id) => jobs[id] || null,
      allowed: () => true,
      deliver: () => ({ status: 'running' }),
      load: async (_key, fallback) => {
        if (down) throw new Error('database unavailable');
        return stored ?? fallback;
      },
      save: async (_key, value) => {
        stored = structuredClone(value);
      },
      now: () => clock,
      log: (line) => logs.push(line),
    });
    await expect(w.init()).rejects.toThrow(/database unavailable/);
    await expect(w.watch('s1', { account: 'default', chat: CHAT })).rejects.toMatchObject({ status: 503 });
    await expect(w.unwatch('s1', 'default', CHAT)).rejects.toMatchObject({ status: 503 });
    await w.poll();
    await w.poll();
    expect(logs.filter((l) => l.includes('could not load watches'))).toHaveLength(1);
    expect(stored).toBe(real);
    down = false;
    await w.poll();
    expect(w.watching('s2', 'default', GROUP)).toBe(true);
    await w.watch('s1', { account: 'default', chat: CHAT });
    w.stop();
    expect(stored.map((x) => x.jobId)).toEqual(['s2', 's1']);
  });

  it('keeps the watches of sessions not restored yet until the registry is complete', async () => {
    stored = [
      { jobId: 's9', account: 'default', chat: GROUP, since: sec(T0), expiresAt: T0 + 3600_000, seen: [] },
    ];
    let complete = false;
    const w = createWhatsAppWatcher({
      service: { messages: async () => ({ messages: [] }) },
      getJob: (id) => jobs[id] || null,
      allowed: () => true,
      deliver: () => ({ status: 'running' }),
      registryComplete: () => complete,
      load: async (_key, fallback) => stored ?? fallback,
      save: async (_key, value) => {
        stored = structuredClone(value);
      },
      now: () => clock,
      log: (line) => logs.push(line),
    });
    await w.init();
    await w.watch('s1', { account: 'default', chat: CHAT });
    await w.poll();
    expect(stored.map((x) => x.jobId)).toEqual(['s9', 's1']);
    complete = true;
    await w.poll();
    w.stop();
    expect(stored.map((x) => x.jobId)).toEqual(['s1']);
  });

  it('starts a watch from the sent message’s own stamp when WAHA stamped it earlier', async () => {
    const w = make();
    clock = T0 + 1400;
    const view = await w.watch('s1', { account: 'default', chat: CHAT, since: sec(T0) });
    expect(view.since).toBe(new Date(T0).toISOString());
    chats[CHAT] = [msg('quick', T0 + 500)];
    await w.poll();
    expect(delivered).toHaveLength(1);
    // A later stamp never narrows the watch past the time it began.
    const other = await w.watch('s2', { account: 'default', chat: CHAT, since: sec(T0) + 60 });
    expect(other.since).toBe(new Date(sec(clock) * 1000).toISOString());
    w.stop();
  });

  it('reports a watch as kept when only its save failed', async () => {
    const w = createWhatsAppWatcher({
      service: { messages: async () => ({ messages: [] }) },
      getJob: (id) => jobs[id] || null,
      allowed: () => true,
      deliver: () => ({ status: 'running' }),
      load: async (_key, fallback) => fallback,
      save: async () => {
        throw new Error("Table 'app_settings' is locked");
      },
      now: () => clock,
      log: (line) => logs.push(line),
    });
    await expect(w.watch('s1', { account: 'default', chat: CHAT })).resolves.toMatchObject({ chat: CHAT });
    expect(w.watching('s1', 'default', CHAT)).toBe(true);
    await vi.waitFor(() => expect(logs).toContain("could not save watches: Table 'app_settings' is locked"));
    w.stop();
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

  describe('voice notes', () => {
    const OGG = 'audio/ogg; codecs=opus';
    const voice = (id, at) => msg(id, at, { text: '', hasMedia: true, media: { mimetype: OGG } });

    it('arrive transcribed, and only audio is sent for transcription', async () => {
      const voiceText = vi.fn(async () => 'compra pan y leche');
      const w = make({ voiceText });
      await w.watch('s1', { account: 'default', chat: CHAT });
      chats[CHAT] = [
        voice('v', T0 + 1000),
        msg('i', T0 + 2000, { hasMedia: true, media: { mimetype: 'image/jpeg' } }),
      ];
      await w.poll();
      expect(voiceText).toHaveBeenCalledTimes(1);
      expect(voiceText).toHaveBeenCalledWith('default', CHAT, expect.objectContaining({ id: 'v' }));
      const text = delivered[0].text;
      expect(text).toContain(
        '(message v):\n(voice note, transcribed by the core) compra pan y leche\n(the recording is message v, for whatsapp_media)',
      );
      expect(text).toContain('(media image/jpeg: open it with whatsapp_media, message i)');
      w.stop();
    });

    it('are transcribed once while their delivery waits for the session', async () => {
      const voiceText = vi.fn(async () => 'hola');
      const w = make({ voiceText });
      await w.watch('s1', { account: 'default', chat: CHAT });
      chats[CHAT] = [voice('v', T0 + 1000)];
      deliver = () => {
        throw Object.assign(new Error('10 automatic turns ran'), { status: 429 });
      };
      await w.poll();
      await w.poll();
      expect(delivered).toHaveLength(0);
      deliver = (id, delivery) => {
        delivered.push({ session: id, ...delivery });
        return { status: 'running' };
      };
      await w.poll();
      expect(voiceText).toHaveBeenCalledTimes(1);
      expect(delivered[0].text).toContain('(voice note, transcribed by the core) hola');
      w.stop();
    });

    it('still arrive when the transcription fails or is off, pointing at the recording', async () => {
      const failing = make({
        voiceText: async () => {
          throw new Error('OpenAI answered 500 to the transcription: down');
        },
      });
      await failing.watch('s1', { account: 'default', chat: CHAT });
      chats[CHAT] = [voice('v', T0 + 1000)];
      await failing.poll();
      failing.stop();
      expect(delivered[0].text).toContain(
        `(voice note ${OGG}, not transcribed: OpenAI answered 500 to the transcription: down; open it with whatsapp_media, message v)`,
      );
      expect(logs.some((l) => l.includes('could not transcribe voice note v'))).toBe(true);

      const off = make({ voiceText: async () => null });
      await off.watch('s2', { account: 'default', chat: GROUP });
      chats[GROUP] = [voice('g', T0 + 1000)];
      await off.poll();
      off.stop();
      expect(delivered[1].text).toContain(`(media ${OGG}: open it with whatsapp_media, message g)`);
    });

    it('are not delivered by a watch that ended while they were transcribed', async () => {
      let w;
      const voiceText = vi.fn(async () => {
        await w.unwatch('s1', 'default', CHAT);
        return 'hola';
      });
      w = make({ voiceText });
      await w.watch('s1', { account: 'default', chat: CHAT });
      chats[CHAT] = [voice('v', T0 + 1000)];
      await w.poll();
      expect(voiceText).toHaveBeenCalledTimes(1);
      expect(delivered).toHaveLength(0);
      w.stop();
    });
  });
});
