import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

// lib/browser.js against a stand-in Chromium (test/fixtures/fake-chromium.js)
// that speaks the DevTools Protocol over a real WebSocket: the launch, the
// tabs, the screencast, the input and the ways a browser stops, with every
// call the module makes recorded on the other side.
const FAKE = path.resolve(import.meta.dirname, 'fixtures', 'fake-chromium.js');
vi.mock('../lib/config.js', () => ({
  getConfig: () => ({ browserBin: path.resolve(import.meta.dirname, 'fixtures', 'fake-chromium.js') }),
}));

const browser = await import('../lib/browser.js');

beforeAll(() => fs.chmodSync(FAKE, 0o755));

let n = 0;
const used = [];
// A session id of its own per test, so no browser or profile is shared.
const sessionId = () => {
  const id = `cdp-${process.pid}-${++n}`;
  used.push(id);
  return id;
};
afterEach(async () => {
  delete process.env.FAKE_CHROMIUM_MODE;
  while (used.length) browser.forgetBrowser(used.pop());
});

// The test's own connection to the fake, on the endpoint the agent would use.
async function probe(id) {
  const ws = new WebSocket(`${browser.browserEndpoint(id).replace('http', 'ws')}/devtools/browser/probe`);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  let next = 0;
  const waiting = new Map();
  ws.onmessage = (e) => {
    const msg = JSON.parse(String(e.data));
    waiting.get(msg.id)?.(msg.result);
  };
  const call = (method, params = {}) =>
    new Promise((resolve) => {
      const id = ++next;
      waiting.set(id, resolve);
      ws.send(JSON.stringify({ id, method, params }));
    });
  return {
    calls: async (method) => (await call('Test.calls')).calls.filter((c) => !method || c.method === method),
    emit: (method, params, sessionId) => call('Test.emit', { message: { method, params, sessionId } }),
    call,
    close: () => ws.close(),
  };
}

const page = (targetId, url = 'about:blank', title = url) => ({
  targetInfo: { targetId, type: 'page', url, title },
});

describe('starting', () => {
  it('launches, finds the first tab and hands out a loopback endpoint', async () => {
    const id = sessionId();
    const changed = vi.fn();
    browser.onBrowserChange(changed);
    await browser.startBrowser(id);
    expect(browser.browserRunning(id)).toBe(true);
    expect(browser.browserEndpoint(id)).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(changed).toHaveBeenCalledWith(id);
    await vi.waitFor(() =>
      expect(browser.browserState(id)).toEqual({
        running: true,
        tabs: [{ id: 'T1', url: 'about:blank', title: 'about:blank' }],
        active: 'T1',
      }),
    );
    expect(fs.existsSync(browser.profileDir(id))).toBe(true);
  });

  it('hands every caller the same browser, whether starting or started', async () => {
    const id = sessionId();
    const [a, b] = await Promise.all([browser.startBrowser(id), browser.startBrowser(id)]);
    expect(a).toBe(b);
    expect(await browser.startBrowser(id)).toBe(a);
  });

  it('says why when the browser dies before it is ready', async () => {
    process.env.FAKE_CHROMIUM_MODE = 'exit';
    const id = sessionId();
    await expect(browser.startBrowser(id)).rejects.toThrow(
      /exited before it was ready \(3\): \[fake\] cannot open display/,
    );
    expect(browser.browserRunning(id)).toBe(false);
  });

  it('kills a browser an earlier server left on the profile, and nothing else', async () => {
    const id = sessionId();
    const dir = browser.profileDir(id);
    fs.mkdirSync(dir, { recursive: true });
    const env = { ...process.env, FAKE_CHROMIUM_MODE: 'idle' };
    const orphan = spawn(FAKE, [`--user-data-dir=${dir}`], { env });
    const helper = spawn(FAKE, ['--type=renderer', `--user-data-dir=${dir}`], { env });
    const other = spawn(FAKE, [`--user-data-dir=${dir}-other`], { env });
    try {
      await vi.waitFor(() => expect(fs.readFileSync(`/proc/${orphan.pid}/cmdline`, 'utf8')).toContain(dir));
      fs.writeFileSync(path.join(dir, 'SingletonLock'), 'stale');
      await browser.startBrowser(id);
      await vi.waitFor(() => expect(orphan.signalCode).toBe('SIGKILL'));
      expect(helper.exitCode).toBeNull();
      expect(helper.signalCode).toBeNull();
      expect(other.signalCode).toBeNull();
      expect(fs.existsSync(path.join(dir, 'SingletonLock'))).toBe(false);
    } finally {
      for (const p of [orphan, helper, other]) p.kill('SIGKILL');
    }
  });
});

describe('stopping', () => {
  it('counts as stopped at once, closes cleanly, and tells the watchers when it is gone', async () => {
    const id = sessionId();
    await browser.startBrowser(id);
    const p = await probe(id);
    const events = [];
    browser.watchBrowser(id, (e) => events.push(e.type));
    browser.stopBrowser(id);
    expect(browser.browserRunning(id)).toBe(false);
    expect(browser.browserEndpoint(id)).toBeNull();
    await vi.waitFor(() => expect(events).toContain('closed'));
    p.close();
  });

  it('starts a fresh browser when one is opened while the last is still closing', async () => {
    const id = sessionId();
    const first = await browser.startBrowser(id);
    browser.stopBrowser(id);
    const second = await browser.startBrowser(id);
    expect(second).not.toBe(first);
    await new Promise((r) => setTimeout(r, 300));
    expect(browser.browserRunning(id)).toBe(true);
    expect(browser.browserEndpoint(id)).toBe(second.endpoint);
  });

  it('shuts down a browser a stop arrived for while it was starting', async () => {
    const id = sessionId();
    const launching = browser.startBrowser(id);
    browser.stopBrowser(id);
    await expect(launching).rejects.toMatchObject({ status: 409 });
    expect(browser.browserRunning(id)).toBe(false);
    expect(fs.existsSync(browser.profileDir(id))).toBe(true);
  });

  it('drops the profile of a session forgotten while its browser was starting', async () => {
    const id = sessionId();
    const launching = browser.startBrowser(id);
    browser.forgetBrowser(id);
    await expect(launching).rejects.toThrow(/stopped while it was starting/);
    expect(browser.browserRunning(id)).toBe(false);
    expect(fs.existsSync(browser.profileDir(id))).toBe(false);
  });

  it('notices a browser that dies on its own, and fails the calls still waiting on it', async () => {
    const id = sessionId();
    await browser.startBrowser(id);
    const p = await probe(id);
    await p.call('Test.hang', { method: 'Page.reload' });
    const waiting = browser.browserInput(id, { type: 'reload' });
    await vi.waitFor(async () => expect(await p.calls('Page.reload')).toHaveLength(1));
    const events = [];
    browser.watchBrowser(id, (e) => events.push(e.type));
    p.call('Browser.close');
    await expect(waiting).rejects.toThrow(/went away/);
    await vi.waitFor(() => expect(events).toContain('closed'));
    expect(browser.browserRunning(id)).toBe(false);
  });

  it('stops every browser on shutdown, those closing included', async () => {
    const a = sessionId();
    const b = sessionId();
    const first = await browser.startBrowser(a);
    await browser.startBrowser(b);
    browser.stopBrowser(a);
    browser.stopAllBrowsers();
    expect(browser.browserRunning(b)).toBe(false);
    await vi.waitFor(() => expect(first.proc.exitCode !== null || first.proc.signalCode !== null).toBe(true));
  });
});

describe('watching', () => {
  it('casts the tab in view only while somebody watches, at most ten frames a second', async () => {
    const id = sessionId();
    await browser.startBrowser(id);
    const p = await probe(id);
    await vi.waitFor(() => expect(browser.browserState(id).active).toBe('T1'));
    expect(await p.calls('Page.startScreencast')).toHaveLength(0);

    const seen = [];
    const unwatch = browser.watchBrowser(id, (e) => seen.push(e));
    expect(seen[0]).toEqual({
      type: 'tabs',
      tabs: [{ id: 'T1', url: 'about:blank', title: 'about:blank' }],
      active: 'T1',
    });
    await vi.waitFor(() => expect(seen.some((e) => e.type === 'frame')).toBe(true));
    const frame = seen.find((e) => e.type === 'frame').frame;
    expect(frame).toEqual({
      data: Buffer.from('frame of S-T1').toString('base64'),
      width: 1280,
      height: 657,
      tab: 'T1',
    });
    const [cast] = await p.calls('Page.startScreencast');
    expect(cast).toMatchObject({ sessionId: 'S-T1', params: { format: 'jpeg' } });
    expect(await p.calls('Page.enable')).toEqual([expect.objectContaining({ sessionId: 'S-T1' })]);
    await vi.waitFor(async () =>
      expect(await p.calls('Page.screencastFrameAck')).toEqual([
        { method: 'Page.screencastFrameAck', params: { sessionId: 7 }, sessionId: 'S-T1' },
      ]),
    );

    // A second viewer gets the last frame at once, from the same cast.
    const late = [];
    const unwatchLate = browser.watchBrowser(id, (e) => late.push(e));
    expect(late.map((e) => e.type)).toEqual(['tabs', 'frame']);
    expect(await p.calls('Page.startScreencast')).toHaveLength(1);

    unwatch();
    unwatchLate();
    await vi.waitFor(async () => expect(await p.calls('Page.stopScreencast')).toHaveLength(1));
    p.close();
  });

  it('follows a tab the agent opens, and falls back when it closes', async () => {
    const id = sessionId();
    await browser.startBrowser(id);
    const p = await probe(id);
    await vi.waitFor(() => expect(browser.browserState(id).active).toBe('T1'));
    const tabs = [];
    browser.watchBrowser(id, (e) => e.type === 'tabs' && tabs.push(e));
    // The agent's Playwright opens it on a connection of its own.
    const { targetId } = await p.call('Target.createTarget', { url: 'http://localhost:8100/' });
    await vi.waitFor(() => expect(browser.browserState(id).active).toBe(targetId));
    expect(tabs.at(-1).tabs.map((t) => t.id)).toEqual(['T1', targetId]);
    await vi.waitFor(async () =>
      expect((await p.calls('Page.startScreencast')).map((c) => c.sessionId)).toContain(`S-${targetId}`),
    );

    // Not a page: a worker or the browser's own UI is not a tab.
    await p.emit('Target.targetCreated', {
      targetInfo: { targetId: 'W1', type: 'service_worker', url: 'x', title: 'x' },
    });
    await p.emit('Target.targetDestroyed', { targetId: 'W1' });
    await p.call('Target.closeTarget', { targetId });
    await vi.waitFor(() => expect(browser.browserState(id)).toMatchObject({ active: 'T1' }));
    expect(browser.browserState(id).tabs.map((t) => t.id)).toEqual(['T1']);
    p.close();
  });

  it('reads the titles again once a page has loaded', async () => {
    const id = sessionId();
    await browser.startBrowser(id);
    const p = await probe(id);
    await vi.waitFor(() => expect(browser.browserState(id).active).toBe('T1'));
    await p.call('Test.setTitle', { targetId: 'T1', title: 'Log in — Shop' });
    await p.emit('Page.loadEventFired', {}, 'S-T1');
    await vi.waitFor(() => expect(browser.browserState(id).tabs[0].title).toBe('Log in — Shop'), {
      timeout: 3000,
    });
    p.close();
  });

  it('takes a screenshot of the tab in view', async () => {
    const id = sessionId();
    await browser.startBrowser(id);
    await vi.waitFor(() => expect(browser.browserState(id).active).toBe('T1'));
    expect((await browser.browserScreenshot(id)).toString()).toBe('PNGDATA');
  });
});

describe('input', () => {
  let id, p;
  const input = (action) => browser.browserInput(id, action);
  const sent = async (method) =>
    (await p.calls(method)).map(({ params, sessionId }) => ({ ...params, sessionId }));

  beforeAll(async () => {
    id = `cdp-input-${process.pid}`;
    await browser.startBrowser(id);
    p = await probe(id);
    await vi.waitFor(() => expect(browser.browserState(id).active).toBe('T1'));
    return () => {
      p.close();
      browser.forgetBrowser(id);
    };
  });

  it('clicks as a move, a press and a release, on the tab in view', async () => {
    await input({ type: 'click', x: 100, y: 30, clickCount: 2, modifiers: ['shift'] });
    const mouse = (await sent('Input.dispatchMouseEvent')).slice(-3);
    expect(mouse).toEqual([
      { type: 'mouseMoved', x: 100, y: 30, modifiers: 8, sessionId: 'S-T1' },
      { type: 'mousePressed', x: 100, y: 30, modifiers: 8, button: 'left', clickCount: 2, sessionId: 'S-T1' },
      {
        type: 'mouseReleased',
        x: 100,
        y: 30,
        modifiers: 8,
        button: 'left',
        clickCount: 2,
        sessionId: 'S-T1',
      },
    ]);
  });

  it('drags as separate down, move and up', async () => {
    await input({ type: 'down', x: 1, y: 2, button: 'right' });
    await input({ type: 'move', x: 5, y: 6, button: 'right' });
    await input({ type: 'move', x: 7, y: 8 });
    await input({ type: 'up', x: 5, y: 6, button: 'right' });
    const mouse = (await sent('Input.dispatchMouseEvent'))
      .slice(-4)
      .map(({ type, button }) => [type, button]);
    expect(mouse).toEqual([
      ['mousePressed', 'right'],
      ['mouseMoved', 'right'],
      ['mouseMoved', 'none'],
      ['mouseReleased', 'right'],
    ]);
  });

  it('scrolls, types and presses keys', async () => {
    await input({ type: 'wheel', x: 10, y: 20, deltaY: 300 });
    expect((await sent('Input.dispatchMouseEvent')).at(-1)).toMatchObject({
      type: 'mouseWheel',
      deltaX: 0,
      deltaY: 300,
    });

    await input({ type: 'type', text: 'hola' });
    expect((await sent('Input.insertText')).at(-1)).toEqual({ text: 'hola', sessionId: 'S-T1' });

    await input({ type: 'key', key: 'Enter' });
    expect((await sent('Input.dispatchKeyEvent')).slice(-2)).toEqual([
      expect.objectContaining({ type: 'keyDown', key: 'Enter', text: '\r', windowsVirtualKeyCode: 13 }),
      expect.objectContaining({ type: 'keyUp', key: 'Enter' }),
    ]);

    // A shortcut, not typing: no text, or the letter would be typed too.
    await input({ type: 'key', key: 'a', modifiers: ['ctrl'] });
    const [down] = (await sent('Input.dispatchKeyEvent')).slice(-2);
    expect(down).toMatchObject({ type: 'rawKeyDown', key: 'a', code: 'KeyA', modifiers: 2 });
    expect(down).not.toHaveProperty('text');
  });

  it('navigates, goes back and forward through the history, and reloads', async () => {
    await input({ type: 'navigate', url: 'http://localhost:8100/login' });
    expect((await sent('Page.navigate')).at(-1)).toEqual({
      url: 'http://localhost:8100/login',
      sessionId: 'S-T1',
    });
    await vi.waitFor(() => expect(browser.browserState(id).tabs[0].url).toBe('http://localhost:8100/login'));

    await input({ type: 'back' });
    await input({ type: 'forward' });
    expect((await sent('Page.navigateToHistoryEntry')).slice(-2).map((c) => c.entryId)).toEqual([10, 12]);
    await input({ type: 'reload' });
    expect(await p.calls('Page.reload')).not.toHaveLength(0);
  });

  it('opens, switches to and closes tabs', async () => {
    await input({ type: 'newTab', url: 'https://example.com' });
    expect((await sent('Target.createTarget')).at(-1)).toMatchObject({ url: 'https://example.com/' });
    await vi.waitFor(() => expect(browser.browserState(id).tabs).toHaveLength(2));
    const opened = browser.browserState(id).active;
    expect(opened).not.toBe('T1');

    await input({ type: 'tab', tab: 'T1' });
    expect(browser.browserState(id).active).toBe('T1');
    expect((await sent('Target.activateTarget')).at(-1)).toMatchObject({ targetId: 'T1' });

    await input({ type: 'closeTab', tab: opened });
    await vi.waitFor(() => expect(browser.browserState(id).tabs.map((t) => t.id)).toEqual(['T1']));
    await input({ type: 'newTab' });
    expect((await sent('Target.createTarget')).at(-1)).toMatchObject({ url: 'about:blank' });
    await vi.waitFor(() => expect(browser.browserState(id).tabs).toHaveLength(2));
    await input({ type: 'closeTab' });
    await vi.waitFor(() => expect(browser.browserState(id).tabs.map((t) => t.id)).toEqual(['T1']));
  });

  it('refuses what it cannot do, with the status a client should see', async () => {
    const refused = async (action, status, message) => {
      await expect(input(action)).rejects.toMatchObject({ status, message: expect.stringMatching(message) });
    };
    await refused({ type: 'warp' }, 400, /`type` must be one of/);
    await refused({ type: 'click', y: 1 }, 400, /`x` must be a number/);
    await refused({ type: 'click', x: 'left', y: 1 }, 400, /`x` must be a number/);
    await refused({ type: 'click', x: 1, y: 1, button: 'back' }, 400, /`button`/);
    await refused({ type: 'click', x: 1, y: 1, modifiers: ['hyper'] }, 400, /Unknown modifier/);
    await refused({ type: 'type', text: '' }, 400, /`text`/);
    await refused({ type: 'type', text: 'x'.repeat(10_001) }, 400, /10,000/);
    await refused({ type: 'key', key: 'F13' }, 400, /Unknown key/);
    await refused({ type: 'navigate', url: 'file:///etc/passwd' }, 400, /http or https/);
    await refused({ type: 'newTab', url: 'chrome://settings' }, 400, /http or https/);
    await refused({ type: 'tab', tab: 'T404' }, 404, /No such tab/);
    await refused({ type: 'closeTab', tab: 'T404' }, 404, /No such tab/);
  });
});
